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
 *    this module's revoke instead).
 * @module @deepseek-ai/dsh-sandbox-windows-acl
 */

import { randomInt } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

import { grantWrite, revokeWrite } from './acl.ts'
import { Win32Error } from './errors.ts'
import { allocPtrSlot, decodePtr, isNullPtr, throwLastError, win32 } from './ffi.ts'
import type { NativePtr, Win32Bindings } from './ffi.ts'
import { drainPipe, spawnSandboxed, spawnSandboxedInherited, waitForExit } from './spawn.ts'
import { createRestrictedToken, findLogonSid, makeWellKnownSid, openCurrentProcessToken } from './token.ts'
import * as abi from './win32-abi.ts'

export { quoteArg } from './spawn.ts'
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

function randomWriteSid(): string {
  return `S-1-4-${randomInt(1, 2 ** 30)}-${randomInt(1, 2 ** 30)}`
}

function getTempPath(api: Win32Bindings): string {
  const buffer = Buffer.alloc((abi.MAX_PATH + 1) * 2)
  const length = api.getTempPathW(buffer.length / 2, buffer)
  if (length === 0) throwLastError(api, 'GetTempPathW')
  return buffer.subarray(0, length * 2).toString('utf16le')
}

/**
 * One write-restricted sandbox instance: token + orphan-SID grants + spawn.
 * `init()` is fail-closed — any Win32 failure revokes whatever was granted
 * and throws; `dispose()` revokes all grants and reports every cleanup
 * failure.
 */
export class AclSandbox {
  /** Absolute writable directories (constructor-validated). */
  readonly writableDirs: string[]
  /** The orphan SID string whose ACEs form the write allowlist. */
  readonly writeSid: string
  private readonly tempDirOption: string | null | undefined
  private tempDirResolved: string | null | undefined
  private api: Win32Bindings | undefined
  private token: NativePtr | undefined
  private writeSidPtr: NativePtr | undefined
  private grantedPaths: string[] = []

  constructor(options: AclSandboxOptions) {
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

      for (const path of tempDir !== null ? [...this.writableDirs, tempDir] : this.writableDirs) {
        grantWrite(api, path, writeSidPtr)
        this.grantedPaths.push(path)
      }
      const logonSid = findLogonSid(api, currentToken)
      const restricted = createRestrictedToken(
        api, currentToken, logonSid, writeSidPtr,
        {
          world: makeWellKnownSid(api, abi.WinWorldSid),
          authUser: makeWellKnownSid(api, abi.WinAuthenticatedUserSid),
          interactive: makeWellKnownSid(api, abi.WinInteractiveSid),
          local: makeWellKnownSid(api, abi.WinLocalSid),
        },
      )
      this.token = restricted
      if (api.closeHandle(currentToken) === 0) throwLastError(api, 'CloseHandle', 'current process token')
      this.api = api
    } catch (error) {
      // Best-effort close on the failure path (last error already captured in `error`).
      api.closeHandle(currentToken)
      // Fail-closed cleanup: never leave standing grants behind a failed init.
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
      for (const path of this.grantedPaths) {
        try {
          revokeWrite(api, path, writeSidPtr)
        } catch (error) {
          failures.push(error)
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
    this.api = undefined
    this.token = undefined
    this.writeSidPtr = undefined
    this.grantedPaths = []
    if (failures.length > 0) {
      throw new AggregateError(failures, `AclSandbox dispose completed with ${failures.length} cleanup failure(s)`)
    }
  }
}
