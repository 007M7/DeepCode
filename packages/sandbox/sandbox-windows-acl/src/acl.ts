/**
 * ACL editing helpers: grant/revoke the orphan write SID on a directory via
 * SetEntriesInAclW + SetNamedSecurityInfoW (the same calls the POC uses, with
 * the failure handling the POC lacks). Every API call is checked and every
 * failure is reported with the API name, the exact Win32 code, the formatted
 * system text, and the affected path.
 *
 * Concurrency: grants are read-merge-write against the directory's CURRENT
 * DACL, and the whole get-merge-set sequence runs under a per-path exclusive
 * LockFileEx lock (see {@link withPathLock}) so concurrent sandbox instances
 * cannot clobber each other's ACEs.
 * @module @deepseek-ai/dsh-sandbox-windows-acl/acl
 */

import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { allocOverlapped, allocPtrSlot, decodePtr, getTempPath, isInvalidHandle, isNullPtr, ptrAddress, throwLastError, throwWin32 } from './ffi.ts'
import type { NativePtr, Win32Bindings } from './ffi.ts'
import * as abi from './win32-abi.ts'

/**
 * Pack one EXPLICIT_ACCESS_W (48 bytes, layout verified by abi-probe.cpp):
 * perms@0, mode@4, inheritance@8, Trustee@16 { pMultipleTrustee@16,
 * MultipleTrusteeOperation@24, TrusteeForm@28, TrusteeType@32, ptstrName@40 }.
 * `permissions` is the access mask; the POC passes 0 for REVOKE_ACCESS, which
 * removes every ACE for the trustee.
 */
export function buildExplicitAccess(sidPtr: NativePtr, mode: number, permissions: number): Buffer {
  const entry = Buffer.alloc(abi.EXPLICIT_ACCESS_W_SIZE)
  entry.writeUInt32LE(permissions, 0) // grfAccessPermissions
  entry.writeUInt32LE(mode, 4) // grfAccessMode
  entry.writeUInt32LE(abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT, 8) // grfInheritance: OI|CI
  entry.writeUInt32LE(abi.NO_MULTIPLE_TRUSTEE, 24) // Trustee.MultipleTrusteeOperation
  entry.writeUInt32LE(abi.TRUSTEE_IS_SID, 28) // Trustee.TrusteeForm
  entry.writeUInt32LE(abi.TRUSTEE_IS_UNKNOWN, 32) // Trustee.TrusteeType
  entry.writeBigUInt64LE(ptrAddress(sidPtr), 40) // Trustee.ptstrName = the orphan SID
  return entry
}

/**
 * One lock file per protected path: `<GetTempPathW()>\dsh-acl-locks\<first 16
 * hex of sha256(lowercased path)>.lock`. The lock root derives from
 * GetTempPathW (never from runner argv or DSH_HOME), and the lowercasing
 * maps Windows's case-insensitive path spellings onto one lock.
 * @param api - the binding table.
 * @param path - the protected directory (absolute).
 * @returns the lock file path for that directory.
 */
export function lockFilePath(api: Win32Bindings, path: string): string {
  const digest = createHash('sha256').update(path.toLowerCase()).digest('hex').slice(0, 16)
  return join(getTempPath(api), 'dsh-acl-locks', `${digest}.lock`)
}

/**
 * Run `action` holding the per-path exclusive lock: CreateFileW
 * (OPEN_ALWAYS, shared read/write but NOT delete — a deletable lock file
 * could be removed and recreated under the holder, letting two processes
 * hold "the same" lock), then a one-byte LockFileEx
 * (LOCKFILE_EXCLUSIVE_LOCK, zeroed OVERLAPPED = lock from offset 0 on the
 * synchronous handle — see allocOverlapped for why not NULL), then
 * UnlockFileEx + CloseHandle. Fail-closed: open/lock/unlock/close failures
 * throw like every other Win32 call in this package; an `action` failure
 * still unlocks (best-effort) and rethrows the original error.
 * @param api - the binding table.
 * @param path - the protected directory (absolute).
 * @param action - the get-merge-set sequence to serialize.
 * @returns the action's result.
 */
export function withPathLock<T>(api: Win32Bindings, path: string, action: () => T): T {
  const lockPath = lockFilePath(api, path)
  mkdirSync(dirname(lockPath), { recursive: true })
  const handle = api.createFileW(
    lockPath,
    abi.GENERIC_READ | abi.GENERIC_WRITE,
    abi.FILE_SHARE_READ | abi.FILE_SHARE_WRITE,
    null, abi.OPEN_ALWAYS, 0, null,
  )
  if (isInvalidHandle(handle)) throwLastError(api, 'CreateFileW', lockPath)
  const overlapped = allocOverlapped() // stays zeroed: offset 0, hEvent NULL
  if (api.lockFileEx(handle, abi.LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, overlapped) === 0) {
    const win32Code = api.getLastError()
    api.closeHandle(handle) // best-effort on the lock-failure path
    throwWin32(api, 'LockFileEx', win32Code, lockPath)
  }

  let result: T
  try {
    result = action()
  } catch (error) {
    // Best-effort release on the action-failure path: cleanup failures must
    // not mask the action's error.
    api.unlockFileEx(handle, 0, 1, 0, overlapped)
    api.closeHandle(handle)
    throw error
  }
  if (api.unlockFileEx(handle, 0, 1, 0, overlapped) === 0) {
    const win32Code = api.getLastError()
    api.closeHandle(handle) // best-effort on the unlock-failure path
    throwWin32(api, 'UnlockFileEx', win32Code, lockPath)
  }
  if (api.closeHandle(handle) === 0) throwLastError(api, 'CloseHandle', `lock file ${lockPath}`)
  return result
}

/**
 * Read the directory's current explicit DACL via GetNamedSecurityInfoW.
 * Allocation contract (the POC's RevokeAccess, minus its missing checks): the
 * returned ACL pointer sits INSIDE the security descriptor allocation — only
 * the descriptor may be LocalFree'd, and it must not be freed before
 * SetEntriesInAclW has consumed the ACL. Freeing the ACL pointer itself
 * corrupts the heap (verified the hard way).
 * @param api - the binding table.
 * @param path - the directory whose DACL is read.
 * @returns the current explicit DACL (null when the directory carries none) and its owning descriptor.
 */
function readCurrentDacl(api: Win32Bindings, path: string): { oldAcl: NativePtr | null; descriptor: NativePtr | null } {
  const ownerSlot = allocPtrSlot()
  const groupSlot = allocPtrSlot()
  const daclSlot = allocPtrSlot()
  const saclSlot = allocPtrSlot()
  const descriptorSlot = allocPtrSlot()
  const readResult = api.getNamedSecurityInfoW(
    path, abi.SE_FILE_OBJECT, abi.DACL_SECURITY_INFORMATION,
    ownerSlot, groupSlot, daclSlot, saclSlot, descriptorSlot,
  )
  if (readResult !== abi.ERROR_SUCCESS) throwWin32(api, 'GetNamedSecurityInfoW', readResult, path)
  return { oldAcl: decodePtr(daclSlot), descriptor: decodePtr(descriptorSlot) }
}

/**
 * Shared tail of grantWrite and revokeWrite: merge `entry` into `oldAcl`
 * (null = no explicit DACL yet; SetEntriesInAclW builds one from scratch),
 * free the descriptor before applying the merged ACL, apply it, then free the
 * merged ACL — checking every call and reporting with the caller's label.
 * @param api - the binding table.
 * @param path - the directory the DACL edit applies to.
 * @param entry - the EXPLICIT_ACCESS_W to merge (grant or revoke).
 * @param oldAcl - the current explicit DACL (from {@link readCurrentDacl}).
 * @param descriptor - the descriptor allocation owning `oldAcl`.
 * @param label - the caller's name for error details.
 */
function mergeAndApply(
  api: Win32Bindings,
  path: string,
  entry: Buffer,
  oldAcl: NativePtr | null,
  descriptor: NativePtr | null,
  label: string,
): void {
  const newAclSlot = allocPtrSlot()
  const mergeResult = api.setEntriesInAclW(1, entry, oldAcl, newAclSlot)
  if (mergeResult !== abi.ERROR_SUCCESS) {
    if (descriptor !== null) api.localFree(descriptor) // frees the ACL block too
    throwWin32(api, 'SetEntriesInAclW', mergeResult, `${label}(${path})`)
  }
  const newAcl = decodePtr(newAclSlot)
  if (newAcl === null) {
    if (descriptor !== null) api.localFree(descriptor)
    throwWin32(api, 'SetEntriesInAclW', api.getLastError(), `${label}(${path}): null new ACL`)
  }

  // The descriptor block (oldAcl included) is dead after the merge — free it
  // before applying, exactly like the POC.
  const freedDescriptor = descriptor !== null ? api.localFree(descriptor) : null
  const applyResult = api.setNamedSecurityInfoW(
    path, abi.SE_FILE_OBJECT, abi.DACL_SECURITY_INFORMATION,
    null, null, newAcl, null,
  )
  const freedNew = api.localFree(newAcl)
  if (applyResult !== abi.ERROR_SUCCESS) throwWin32(api, 'SetNamedSecurityInfoW', applyResult, `${label}(${path})`)
  if (freedDescriptor !== null && !isNullPtr(freedDescriptor)) throwLastError(api, 'LocalFree', `${label}(${path}) descriptor`)
  if (!isNullPtr(freedNew)) throwLastError(api, 'LocalFree', `${label}(${path}) new ACL`)
}

/**
 * Grant `GRANT_MASK` (Write+Delete, displays as "Modify") to the orphan SID
 * on `path`, inheriting to subcontainers and objects. Read-merge-write: the
 * new ACE merges into the directory's CURRENT explicit DACL (same shape as
 * {@link revokeWrite}), so pre-existing explicit ACEs survive. Runs under the
 * per-path lock. The directory must be owned by the caller (owner implicit
 * WRITE_DAC) — same precondition as the POC.
 * @param api - the binding table.
 * @param path - the directory whose DACL gains the grant (the workspace or temp root).
 * @param sidPtr - the orphan write SID the ACE names.
 */
export function grantWrite(api: Win32Bindings, path: string, sidPtr: NativePtr): void {
  withPathLock(api, path, () => {
    const { oldAcl, descriptor } = readCurrentDacl(api, path)
    mergeAndApply(api, path, buildExplicitAccess(sidPtr, abi.GRANT_ACCESS, abi.GRANT_MASK), oldAcl, descriptor, 'grantWrite')
  })
}

/**
 * Remove every ACE for the orphan SID from the directory DACL (REVOKE_ACCESS
 * merge — other entries are preserved). Returns whether an ACE removal was
 * attempted (false when the directory carries no DACL at all).
 *
 * Runs under the per-path lock (the whole get-merge-set sequence); the
 * descriptor/ACL allocation contract lives on {@link readCurrentDacl}.
 * @param api - the binding table.
 * @param path - the directory whose DACL loses the orphan-SID ACEs.
 * @param sidPtr - the orphan write SID whose ACEs are removed.
 * @returns whether an ACE removal was attempted (false when the directory carries no DACL at all).
 */
export function revokeWrite(api: Win32Bindings, path: string, sidPtr: NativePtr): boolean {
  return withPathLock(api, path, () => {
    const { oldAcl, descriptor } = readCurrentDacl(api, path)
    if (oldAcl === null) {
      if (descriptor !== null) {
        const freed = api.localFree(descriptor)
        if (!isNullPtr(freed)) throwLastError(api, 'LocalFree', `revokeWrite(${path}) descriptor`)
      }
      return false
    }
    mergeAndApply(api, path, buildExplicitAccess(sidPtr, abi.REVOKE_ACCESS, 0), oldAcl, descriptor, 'revokeWrite')
    return true
  })
}
