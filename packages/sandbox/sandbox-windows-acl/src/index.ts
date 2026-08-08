/**
 * Windows ACL write-restriction sandbox backend for the DeepSeek Harness
 * sandbox seam. Mirrors the mechanism of github.com/huoyaoyuan/
 * windows-acl-restrict-poc @ 10e4dfb (the fixed revision): a WRITE_RESTRICTED
 * token whose restricting SIDs include an orphan SID (`S-1-4-x-y`) that only
 * this sandbox instance adds to the target directories' DACLs — the
 * intersection check then allows writes exactly where that SID has a Write
 * ACE, and nowhere else. Unlike the POC, every API failure throws with the
 * API name and exact Win32 code; a child is NEVER spawned unrestricted.
 *
 * Known boundaries (inherent to restricted tokens, not this port):
 *  - writes are restricted; reads, network, and process visibility are NOT
 *    (WRITE_RESTRICTED intersects only write accesses);
 *  - console isolation is unavailable — children share the host console
 *    (CREATE_NO_WINDOW / CREATE_NEW_CONSOLE children die with
 *    STATUS_DLL_INIT_FAILED under the restriction);
 *  - the temp directory and every writable directory must be owned by the
 *    caller (owner-implicit WRITE_DAC);
 *  - grants are standing ACE mutations on real directories — revoke them via
 *    dispose() before the process exits (the POC's documented
 *    `icacls /remove '*S-1-4-…'` cleanup fails with ERROR_NONE_MAPPED; use
 *    this module's revoke instead). With `manageDacls: false` the CALLER owns
 *    the DACLs (the sandbox seam's per-session grant reuse): init()/dispose()
 *    skip grant/revoke entirely and the caller must not revoke under live
 *    children.
 * @module @deepseek-ai/dsh-sandbox-windows-acl
 */

import { randomInt } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

import { grantWrite, revokeWrite } from './acl.ts'
import { Win32Error } from './errors.ts'
import { allocPtrSlot, decodePtr, getTempPath, isNullPtr, throwLastError, win32 } from './ffi.ts'
import type { NativePtr, Win32Bindings } from './ffi.ts'
import { drainPipe, spawnSandboxed, spawnSandboxedInherited, waitForExit } from './spawn.ts'
import { createRestrictedToken, findLogonSid, makeWellKnownSid, openCurrentProcessToken } from './token.ts'
import * as abi from './win32-abi.ts'

export { quoteArg } from './spawn.ts'
export { AclWriteGrant } from './grant.ts'
export { Win32Error } from './errors.ts'

/** Construction options: the write allowlist, the optional temp grant, and the orphan SID identity. */
export interface AclSandboxOptions {
  /** Directories the confined child may write into (must exist and be caller-owned). */
  writableDirs: readonly string[]
  /**
   * Temp directory to also grant; defaults to GetTempPathW() at init time.
   * Pass null for read-only confinement: NO temp grant (strict zero write
   * allowance — not even the NUL device is writable, see README).
   */
  tempDir?: string | null
  /** Orphan write SID; defaults to a random `S-1-4-x-y` (fresh allowlist per sandbox). */
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

/** Mint a fresh orphan write SID (`S-1-4-x-y`; the subauthorities are 30-bit).
 * @returns the SDDL string form.
 */
export function randomWriteSid(): string {
  return `S-1-4-${randomInt(1, 2 ** 30)}-${randomInt(1, 2 ** 30)}`
}

/**
 * One write-restricted sandbox instance: token + orphan-SID grants + spawn.
 * `init()` is fail-closed — any Win32 failure revokes whatever was granted
 * and throws; `dispose()` revokes all grants and reports every cleanup
 * failure. With `manageDacls: false` the caller owns the grants (per-session
 * reuse): init() applies none and dispose() revokes none.
 */
export class AclSandbox {
  /** Absolute writable directories (constructor-validated). */
  readonly writableDirs: string[]
  /** The orphan SID string whose ACEs form the write allowlist. */
  readonly writeSid: string
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
    this.writeSid = options.writeSid ?? randomWriteSid()
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
      const sidSlot = allocPtrSlot()
      if (api.convertStringSidToSidW(this.writeSid, sidSlot) === 0) {
        throwLastError(api, 'ConvertStringSidToSidW', this.writeSid)
      }
      const parsedSid = decodePtr(sidSlot)
      if (parsedSid === null) throw new Win32Error('ConvertStringSidToSidW', api.getLastError(), this.writeSid)
      this.writeSidPtr = parsedSid
      const writeSidPtr = parsedSid

      const tempDir = this.tempDirOption === null
        ? null
        : this.tempDirOption !== undefined ? this.tempDirOption : getTempPath(api)
      if (tempDir !== null) {
        if (!existsSync(tempDir) || !statSync(tempDir).isDirectory()) {
          throw new Error(`AclSandbox temp dir does not exist or is not a directory: ${tempDir}`)
        }
        this.tempDirResolved = tempDir
      }

      // manageDacls: false — the caller (the sandbox seam's per-session grant)
      // already materialized the ACEs; this instance must neither add nor
      // remove any (its dispose() must not revoke the caller's standing grant).
      if (this.manageDacls) {
        for (const path of tempDir !== null ? [...this.writableDirs, tempDir] : this.writableDirs) {
          // Record BEFORE granting: grantWrite can throw after a successful
          // apply (a LocalFree failure), and the fail-closed catch must still
          // revoke that path (revoking an ungranted path is a no-op merge).
          this.grantedPaths.push(path)
          grantWrite(api, path, writeSidPtr)
        }
      }
      const logonSid = findLogonSid(api, currentToken)
      this.sidAllocations.push(logonSid)
      const worldSid = makeWellKnownSid(api, abi.WinWorldSid)
      this.sidAllocations.push(worldSid)
      const authUserSid = makeWellKnownSid(api, abi.WinAuthenticatedUserSid)
      this.sidAllocations.push(authUserSid)
      const restricted = createRestrictedToken(
        api, currentToken, logonSid, writeSidPtr,
        {
          world: worldSid,
          authUser: authUserSid,
        },
        this.mode,
      )
      this.token = restricted
      if (api.closeHandle(currentToken) === 0) throwLastError(api, 'CloseHandle', 'current process token')
      this.api = api
    } catch (error) {
      // Best-effort close on the failure path (last error already captured in `error`).
      api.closeHandle(currentToken)
      // Fail-closed cleanup: never leave standing grants or SID allocations
      // behind a failed init.
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

  /** Revoke all standing grants, free the SID, close the token; reports every cleanup failure. */
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
