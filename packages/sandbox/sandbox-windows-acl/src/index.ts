/**
 * Windows ACL write-restriction sandbox backend for the DeepSeek Harness
 * sandbox seam. Mirrors the mechanism of github.com/huoyaoyuan/
 * windows-acl-restrict-poc @ 10e4dfb (the fixed revision): a WRITE_RESTRICTED
 * token whose restricting SIDs include a write SID (`S-1-4-x-y`) that only
 * this sandbox adds to the target directories' DACLs — the intersection
 * check then allows writes exactly where that SID has a Write ACE, and
 * nowhere else the write SID is concerned (the token's write check ALSO
 * inherits the ambient write ACEs of the other restricting SIDs — the
 * keep-alive group logon SID + Everyone; Authenticated Users, INTERACTIVE,
 * and LOCAL are absent from both lists — see the seam's dual-list contract
 * in `packages/sandbox/sandbox-local` and the package README's Modes section
 * for the complete boundary). The write SID is the per-WORKSPACE identity
 * ({@link workspaceWriteSid}): deterministic from the canonical workspace
 * path, so the workspace-root ACE materializes once per workspace per
 * machine and every later provision hits the exact-ACE skip — the
 * grant-reuse story the per-session random SID paid a full tree propagation
 * per session for. Unlike the POC, every API failure throws with the API
 * name and exact Win32 code; a child is NEVER spawned unrestricted.
 *
 * Known boundaries (inherent to restricted tokens, not this port):
 *  - writes are restricted; reads, network, and process visibility are NOT
 *    (WRITE_RESTRICTED intersects only write accesses);
 *  - console isolation is unavailable — children share the host console
 *    (CREATE_NO_WINDOW / CREATE_NEW_CONSOLE children die with
 *    STATUS_DLL_INIT_FAILED under the restriction);
 *  - the temp directory and every writable directory must be owned by the
 *    caller (owner-implicit WRITE_DAC);
 *  - grants are standing ACE mutations on real directories. WORKSPACE grants
 *    are deliberately never revoked — the ACE is the cross-session reuse
 *    cache (revoking would force the next session to re-propagate the whole
 *    tree). TEMP grants are revocable: dispose() removes them so a standing
 *    inheritable ACE never outlives its session's temp directory (an
 *    inheritable ACE on the ambient temp root would otherwise widen the
 *    SID's write reach to every future temp file). With `manageDacls: false`
 *    the CALLER owns the DACLs (the sandbox seam's grant reuse):
 *    init()/dispose() skip grant/revoke entirely and the caller must not
 *    revoke under live children.
 * @module @deepseek-ai/dsh-sandbox-windows-acl
 */

import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

import { grantWrite, revokeWrite } from './acl.ts'
import { Win32Error } from './errors.ts'
import { allocPtrSlot, decodePtr, getTempPath, isNullPtr, throwLastError, win32 } from './ffi.ts'
import type { NativePtr, Win32Bindings } from './ffi.ts'
import { drainPipe, spawnSandboxed, spawnSandboxedInherited, waitForExit } from './spawn.ts'
import { createRestrictedToken, findLogonSid, makeWellKnownSid, openCurrentProcessToken, setTokenDefaultDaclGrant } from './token.ts'
import * as abi from './win32-abi.ts'

export { quoteArg } from './spawn.ts'
export { AclWriteGrant } from './grant.ts'
export { workspaceWriteSid } from './workspace-sid.ts'
export { Win32Error } from './errors.ts'

/** Construction options: the write allowlist, the optional temp grant, and the orphan SID identity. */
export interface AclSandboxOptions {
  /** Directories the confined child may write into (must exist and be caller-owned). */
  writableDirs: readonly string[]
  /**
   * Temp directory to also grant; defaults to GetTempPathW() at init time.
   * Pass null for read-only confinement: NO temp grant (strict zero grant on
   * the filesystem; the NUL device stays ambient-writable via Everyone — see
   * README).
   */
  tempDir?: string | null
  /**
   * The write SID forming the workspace-write allowlist: REQUIRED under
   * workspace-write, ignored (and must be absent) under read-only. Callers
   * derive it from the workspace via {@link workspaceWriteSid} — the identity
   * is per workspace, not per sandbox instance, so the workspace-root ACE
   * outlives every instance and later provisions hit the exact-ACE skip.
   */
  writeSid?: string
  /**
   * The file-effect mode this instance confines under — selects the
   * restricted token's restricting-SID list (I for read-only, J for
   * workspace-write) and MUST match the grant shape: read-only pairs with
   * zero grants. The runner validates the argv-borne mode string at its
   * boundary; this typed seam trusts the union.
   */
  mode: 'read-only' | 'workspace-write'
  /**
   * Whether this instance owns its DACL grants (default true). False means
   * the CALLER has already materialized the ACEs (the sandbox seam's
   * per-session grant reuse): init()/dispose() skip grant/revoke entirely —
   * the caller holds the grants for its own lifetime and revokes them.
   */
  manageDacls?: boolean
}

/** Per-spawn options: the program, its argv/cwd, and the stdio shape. */
export interface AclSandboxSpawnOptions {
  /** Program to run (resolved via PATH search when unqualified, like CreateProcess). */
  command: string
  /** Arguments, quoted per CommandLineToArgvW rules. */
  args?: readonly string[]
  /** Working directory; defaults to the caller's cwd. */
  cwd?: string
  /**
   * 'pipe' (default): capture stdout/stderr via anonymous pipes.
   * 'inherit': the child inherits the caller's stdio directly (runner usage —
   * bytes flow straight through), always wrapped in a kill-on-close job so the
   * child dies with the caller; stdout/stderr in the result are empty.
   */
  stdio?: 'pipe' | 'inherit'
}

/** A settled confined child: captured stdio and the exit code. */
export interface AclSandboxChildResult {
  stdout: Buffer
  stderr: Buffer
  exitCode: number
}

/** A running confined child: its pid and a settlement promise. */
export interface AclSandboxChild {
  /** Child process id. */
  pid: number
  /** Resolve stdout/stderr and the exit code once the child exits. */
  wait(): Promise<AclSandboxChildResult>
}

/**
 * One write-restricted sandbox instance: token + write-SID grants + spawn.
 * `init()` is fail-closed — any Win32 failure revokes the revocable (temp)
 * grants and throws; `dispose()` revokes the temp grants, leaves the
 * standing workspace ACEs in place (the cross-instance reuse cache), frees
 * every allocation, and reports every cleanup failure. With
 * `manageDacls: false` the caller owns the grants (the sandbox seam's grant
 * reuse): init() applies none and dispose() revokes none.
 */
export class AclSandbox {
  /** Absolute writable directories (constructor-validated). */
  readonly writableDirs: string[]
  /** The write SID string whose ACEs form the write allowlist (workspace-write only). */
  readonly writeSid: string | undefined
  /** The file-effect mode — the restricted token's restricting-SID list selection. */
  readonly mode: 'read-only' | 'workspace-write'
  private readonly tempDirOption: string | null | undefined
  private readonly manageDacls: boolean
  private tempDirResolved: string | null | undefined
  private api: Win32Bindings | undefined
  private token: NativePtr | undefined
  private writeSidPtr: NativePtr | undefined
  /** The well-known/logon SID allocations init() makes; freed by dispose() alongside the write SID. */
  private sidAllocations: NativePtr[] = []
  private grantedPaths: string[] = []

  constructor(options: AclSandboxOptions) {
    this.mode = options.mode
    this.manageDacls = options.manageDacls ?? true
    this.writableDirs = options.writableDirs.map((directory) => {
      const absolute = resolve(directory)
      if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
        throw new Error(`AclSandbox writable dir does not exist or is not a directory: ${absolute}`)
      }
      return absolute
    })
    this.tempDirOption = options.tempDir
    this.writeSid = options.writeSid
    if (this.mode === 'workspace-write' && this.writeSid === undefined) {
      throw new Error('AclSandbox workspace-write requires a write SID — derive it from the workspace via workspaceWriteSid()')
    }
  }

  /** Resolved temp directory (available after init; null when temp grants are disabled). */
  get tempDir(): string | null | undefined {
    return this.tempDirResolved
  }

  /** Create the restricted token and apply the orphan-SID grants. Idempotent-unsafe: once per instance. */
  async init(): Promise<void> {
    if (this.api !== undefined) throw new Error('AclSandbox is already initialized')
    const api = await win32()

    const currentToken = openCurrentProcessToken(api)
    try {
      // Read-only runs carry no write SID (its restricting list has no
      // orphan): nothing to parse, nothing to grant.
      let writeSidPtr: NativePtr | undefined
      if (this.writeSid !== undefined) {
        const sidSlot = allocPtrSlot()
        if (api.convertStringSidToSidW(this.writeSid, sidSlot) === 0) {
          throwLastError(api, 'ConvertStringSidToSidW', this.writeSid)
        }
        const parsedSid = decodePtr(sidSlot)
        if (parsedSid === null) throw new Win32Error('ConvertStringSidToSidW', api.getLastError(), this.writeSid)
        this.writeSidPtr = parsedSid
        writeSidPtr = parsedSid
      }

      const tempDir = this.tempDirOption === null
        ? null
        : this.tempDirOption !== undefined ? this.tempDirOption : getTempPath(api)
      if (tempDir !== null) {
        if (!existsSync(tempDir) || !statSync(tempDir).isDirectory()) {
          throw new Error(`AclSandbox temp dir does not exist or is not a directory: ${tempDir}`)
        }
        this.tempDirResolved = tempDir
      }

      // manageDacls: false — the caller (the sandbox seam's grant) already
      // materialized the ACEs; this instance must neither add nor remove any.
      // When this instance owns the DACLs, writableDir ACEs are STANDING (the
      // per-workspace reuse cache — dispose() never revokes them, or the next
      // provision would re-propagate the whole tree) and the temp ACE is
      // REVOCABLE (dispose() removes it — an inheritable ACE on the ambient
      // temp root must not outlive the instance, or it would widen the SID's
      // write reach to every future temp file).
      if (this.manageDacls) {
        if (writeSidPtr !== undefined) {
          for (const path of this.writableDirs) {
            grantWrite(api, path, writeSidPtr)
          }
          if (tempDir !== null) {
            // Record BEFORE granting: grantWrite can throw after a successful
            // apply (a LocalFree failure), and the fail-closed catch must still
            // revoke that path (revoking an ungranted path is a no-op merge).
            this.grantedPaths.push(tempDir)
            grantWrite(api, tempDir, writeSidPtr)
          }
        }
      }
      const logonSid = findLogonSid(api, currentToken)
      this.sidAllocations.push(logonSid)
      const worldSid = makeWellKnownSid(api, abi.WinWorldSid)
      this.sidAllocations.push(worldSid)
      const restricted = createRestrictedToken(
        api, currentToken, logonSid, writeSidPtr,
        { world: worldSid },
        this.mode,
      )
      // The restricted token's default DACL still names only the user's
      // ambient SIDs — none of the restricting SIDs. Every NEW object the
      // confined process creates (anonymous stdio pipes, sync objects) takes
      // its DACL from that default, so the write pass-2 check would deny
      // pipe creation (ERROR_ACCESS_DENIED; Node EPERM) and break every
      // piped-stdio grandchild spawn. Merge a full-access ACE for a
      // restricting SID (the write SID under workspace-write, Everyone under
      // read-only): new-object creation stays gated by the parent object's
      // DACL, while the new object's own DACL passes pass-2.
      setTokenDefaultDaclGrant(api, restricted, writeSidPtr ?? worldSid)
      this.token = restricted
      if (api.closeHandle(currentToken) === 0) throwLastError(api, 'CloseHandle', 'current process token')
      this.api = api
    } catch (error) {
      // Best-effort close on the failure path (last error already captured in `error`).
      api.closeHandle(currentToken)
      // Fail-closed cleanup: never leave a revocable (temp) grant or SID
      // allocation behind a failed init. Standing workspace ACEs are NOT
      // revoked — they are the intended end state (the reuse cache), not an
      // error artifact.
      const cleanupFailures: unknown[] = []
      const writeSidPtr = this.writeSidPtr
      if (writeSidPtr !== undefined) {
        for (const path of this.grantedPaths) {
          try {
            revokeWrite(api, path, writeSidPtr)
          } catch (cleanupError) {
            cleanupFailures.push(cleanupError)
          }
        }
      }
      for (const sidPtr of this.sidAllocations.splice(0)) {
        try {
          const freed = api.localFree(sidPtr)
          if (!isNullPtr(freed)) throwLastError(api, 'LocalFree', 'init SID allocation')
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError)
        }
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          `AclSandbox init failed and ${cleanupFailures.length} grant revocation(s) also failed`,
        )
      }
      throw error
    }
  }

  /**
   * Spawn a process under the restricted token. Fails closed: throws on every
   * Win32 failure; the child is never created unrestricted. With
   * `stdio: 'inherit'` the child shares the caller's stdio directly and is
   * placed in a kill-on-close job (dies with the caller). Call dispose() only
   * after all children have exited — revoking grants under a live child
   * removes its remaining write allowance.
   * @param options - the program, argv/cwd, and stdio shape.
   * @returns the running child.
   */
  spawn(options: AclSandboxSpawnOptions): AclSandboxChild {
    const api = this.api
    const token = this.token
    if (api === undefined || token === undefined) throw new Error('AclSandbox is not initialized: call init() first')
    const args = options.args ?? []
    const cwd = options.cwd ?? process.cwd()

    if (options.stdio === 'inherit') {
      const native = spawnSandboxedInherited(api, token, { command: options.command, args, cwd })
      let exitCodePromise: Promise<number> | undefined
      return {
        pid: native.pid,
        wait: async () => {
          exitCodePromise ??= Promise.resolve(waitForExit(api, native.process))
          const exitCode = await exitCodePromise
          if (api.closeHandle(native.job) === 0) throwLastError(api, 'CloseHandle', 'kill-on-close job')
          return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode }
        },
      }
    }

    const native = spawnSandboxed(api, token, { command: options.command, args, cwd })
    const stdout = drainPipe(api, native.stdoutRead)
    const stderr = drainPipe(api, native.stderrRead)
    // waitForExit is deliberately NOT started here: WaitForSingleObject blocks
    // the thread and would starve the drains while the child is still running
    // (pipe-buffer deadlock). The drains resolve only after the child closed
    // its pipe ends — by then the wait returns immediately.
    let exitCodePromise: Promise<number> | undefined
    return {
      pid: native.pid,
      wait: async () => {
        const stdoutBuffer = await stdout
        const stderrBuffer = await stderr
        exitCodePromise ??= Promise.resolve(waitForExit(api, native.process))
        return { stdout: stdoutBuffer, stderr: stderrBuffer, exitCode: await exitCodePromise }
      },
    }
  }

  /**
   * Revoke the revocable (temp) grants, free the SID, close the token; the
   * standing workspace ACEs stay (the reuse cache). Reports every cleanup
   * failure.
   */
  dispose(): void {
    const api = this.api
    if (api === undefined) return
    const failures: unknown[] = []
    const writeSidPtr = this.writeSidPtr
    if (writeSidPtr !== undefined) {
      if (this.manageDacls) {
        for (const path of this.grantedPaths) {
          try {
            revokeWrite(api, path, writeSidPtr)
          } catch (error) {
            failures.push(error)
          }
        }
      }
      try {
        const freed = api.localFree(writeSidPtr)
        if (!isNullPtr(freed)) throwLastError(api, 'LocalFree', 'write SID')
      } catch (error) {
        failures.push(error)
      }
    }
    const token = this.token
    if (token !== undefined) {
      try {
        if (api.closeHandle(token) === 0) throwLastError(api, 'CloseHandle', 'restricted token')
      } catch (error) {
        failures.push(error)
      }
    }
    for (const sidPtr of this.sidAllocations.splice(0)) {
      try {
        const freed = api.localFree(sidPtr)
        if (!isNullPtr(freed)) throwLastError(api, 'LocalFree', 'init SID allocation')
      } catch (error) {
        failures.push(error)
      }
    }
    this.api = undefined
    this.token = undefined
    this.writeSidPtr = undefined
    this.grantedPaths = []
    if (failures.length > 0) {
      throw new AggregateError(failures, `AclSandbox dispose completed with ${failures.length} cleanup failure(s)`)
    }
  }
}
