/**
 * Server-side per-session write grant: the ACE materialization half of the
 * sandbox seam's per-session grant reuse. The seam (sandbox-local) holds ONE
 * {@link AclWriteGrant} per session for the server process's lifetime —
 * created lazily at the session's first confined execution, reused (never
 * re-applied) for every later call, revoked on provider dispose. The durable
 * half (the session's SID and paths surviving a restart) lives in the
 * session log, owned by the seam; this module owns only the native half: the
 * parsed SID pointer and the standing ACEs.
 *
 * Fail-closed: `add` throws on any grant failure and the caller disposes the
 * instance (revoking every path granted so far); `dispose` revokes every
 * standing grant and reports every cleanup failure.
 * @module @deepseek-ai/dsh-sandbox-windows-acl/grant
 */

import { grantWrite, revokeWrite } from './acl.ts'
import { allocPtrSlot, decodePtr, isNullPtr, throwLastError, win32Sync } from './ffi.ts'
import type { NativePtr, Win32Bindings } from './ffi.ts'

/**
 * One write SID's server-lifetime grant materialization: the parsed SID
 * pointer plus every directory whose DACL currently carries its ACE.
 * Workspace paths are added STANDING (their ACEs are the cross-session reuse
 * cache and outlive the grant — dispose() skips revoking them, or the next
 * provision would re-propagate the whole tree); temp paths are revocable
 * (dispose() revokes them — an inheritable ACE must not outlive its
 * session's temp directory). Create with {@link AclWriteGrant.create};
 * dispose revokes the revocable paths and frees the SID.
 */
export class AclWriteGrant {
  /** The write SID in SDDL string form. */
  readonly writeSid: string
  private readonly api: Win32Bindings
  private readonly sidPtr: NativePtr
  private readonly revocablePaths: string[] = []
  private readonly standingPaths: string[] = []

  private constructor(api: Win32Bindings, sidPtr: NativePtr, writeSid: string) {
    this.api = api
    this.sidPtr = sidPtr
    this.writeSid = writeSid
  }

  /**
   * Parse the SID string and open the binding table (lazily, once per
   * server). Fail-closed: any failure throws — nothing is granted yet.
   * @param writeSid - the orphan write SID string (`S-1-4-x-y`).
   * @param api - optional already-resolved bindings (tests).
   * @returns the ready grant (no ACEs yet).
   */
  static create(writeSid: string, api?: Win32Bindings): AclWriteGrant {
    const bindings = api ?? win32Sync()
    const sidSlot = allocPtrSlot()
    if (bindings.convertStringSidToSidW(writeSid, sidSlot) === 0) {
      throwLastError(bindings, 'ConvertStringSidToSidW', writeSid)
    }
    const sidPtr = decodePtr(sidSlot)
    if (sidPtr === null) throwLastError(bindings, 'ConvertStringSidToSidW', `null SID for ${writeSid}`)
    return new AclWriteGrant(bindings, sidPtr, writeSid)
  }

  /**
   * Grant the write ACE on one directory (idempotent: an already-standing
   * exact ACE skips the eager full-tree re-propagation — see
   * {@link grantWrite}) and record the path for {@link dispose} unless it is
   * standing. The path is recorded BEFORE the grant: a post-apply throw (a
   * LocalFree failure after SetNamedSecurityInfoW succeeded) must still
   * revoke it, and revoking an ungranted path is a no-op merge. Callers
   * treat a throw as a failed materialization and dispose the instance to
   * revoke the paths granted so far.
   * @param path - the directory whose DACL gains the grant.
   * @param standing - the ACE outlives this grant (the workspace reuse
   *   cache; dispose() skips revoking it). Default false (revoked on
   *   dispose — the temp-directory lifecycle).
   */
  add(path: string, standing = false): void {
    ;(standing ? this.standingPaths : this.revocablePaths).push(path)
    grantWrite(this.api, path, this.sidPtr)
  }

  /** Every directory currently carrying the grant, in grant order. */
  get paths(): readonly string[] {
    return [...this.standingPaths, ...this.revocablePaths]
  }

  /** Revoke every revocable grant (standing ACEs stay) and free the SID; reports every cleanup failure. */
  dispose(): void {
    const failures: unknown[] = []
    for (const path of this.revocablePaths) {
      try {
        revokeWrite(this.api, path, this.sidPtr)
      } catch (error) {
        failures.push(error)
      }
    }
    try {
      const freed = this.api.localFree(this.sidPtr)
      if (!isNullPtr(freed)) throwLastError(this.api, 'LocalFree', 'write SID')
    } catch (error) {
      failures.push(error)
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `AclWriteGrant dispose completed with ${failures.length} cleanup failure(s)`)
    }
  }
}
