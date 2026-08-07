/**
 * ACL editing helpers: grant/revoke the orphan write SID on a directory via
 * SetEntriesInAclW + SetNamedSecurityInfoW (the same calls the POC uses, with
 * the failure handling the POC lacks). Every API call is checked and every
 * failure is reported with the API name, the exact Win32 code, the formatted
 * system text, and the affected path.
 * @module @deepseek-ai/dsh-sandbox-windows-acl/acl
 */

import { allocPtrSlot, decodePtr, isNullPtr, ptrAddress, throwLastError, throwWin32 } from './ffi.ts'
import type { NativePtr, Win32Bindings } from './ffi.ts'
import * as abi from './win32-abi.ts'

/**
 * Pack one EXPLICIT_ACCESS_W (48 bytes, layout verified by abi-probe.cpp):
 * perms@0, mode@4, inheritance@8, Trustee@16 { pMultipleTrustee@16,
 * MultipleTrusteeOperation@24, TrusteeForm@28, TrusteeType@32, ptstrName@40 }.
 * `permissions` is the access mask; the POC passes 0 for REVOKE_ACCESS, which
 * removes every ACE for the trustee.
 */
function buildExplicitAccess(sidPtr: NativePtr, mode: number, permissions: number): Buffer {
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
 * Grant `FILE_GENERIC_WRITE & ~READ_CONTROL` (displays as "Write") to the
 * orphan SID on `path`, inheriting to subcontainers and objects. The directory
 * must be owned by the caller (owner implicit WRITE_DAC) — same precondition
 * as the POC.
 * @param api - the binding table.
 * @param path - the directory whose DACL gains the grant (the workspace or temp root).
 * @param sidPtr - the orphan write SID the ACE names.
 */
export function grantWrite(api: Win32Bindings, path: string, sidPtr: NativePtr): void {
  const newAclSlot = allocPtrSlot()
  const mergeResult = api.setEntriesInAclW(1, buildExplicitAccess(sidPtr, abi.GRANT_ACCESS, abi.GRANT_MASK), null, newAclSlot)
  if (mergeResult !== abi.ERROR_SUCCESS) throwWin32(api, 'SetEntriesInAclW', mergeResult, path)
  const newAcl = decodePtr(newAclSlot)
  if (newAcl === null) throwWin32(api, 'SetEntriesInAclW', api.getLastError(), `null ACL for ${path}`)

  const applyResult = api.setNamedSecurityInfoW(
    path, abi.SE_FILE_OBJECT, abi.DACL_SECURITY_INFORMATION,
    null, null, newAcl, null,
  )
  // Free the LocalAlloc'd ACL before any throw; capture both outcomes first.
  const freed = api.localFree(newAcl)
  if (applyResult !== abi.ERROR_SUCCESS) throwWin32(api, 'SetNamedSecurityInfoW', applyResult, path)
  if (!isNullPtr(freed)) throwLastError(api, 'LocalFree', `grantWrite(${path})`)
}

/**
 * Remove every ACE for the orphan SID from the directory DACL (REVOKE_ACCESS
 * merge — other entries are preserved). Returns whether an ACE removal was
 * attempted (false when the directory carries no DACL at all).
 *
 * Allocation contract (the POC's RevokeAccess, minus its missing checks):
 * GetNamedSecurityInfoW returns the DACL pointer INSIDE the security
 * descriptor allocation — only the descriptor may be LocalFree'd, and it must
 * not be freed before SetEntriesInAclW has consumed the ACL. Freeing the ACL
 * pointer itself corrupts the heap (verified the hard way).
 * @param api - the binding table.
 * @param path - the directory whose DACL loses the orphan-SID ACEs.
 * @param sidPtr - the orphan write SID whose ACEs are removed.
 * @returns whether an ACE removal was attempted (false when the directory carries no DACL at all).
 */
export function revokeWrite(api: Win32Bindings, path: string, sidPtr: NativePtr): boolean {
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
  const oldAcl = decodePtr(daclSlot)
  const descriptor = decodePtr(descriptorSlot)

  if (oldAcl === null) {
    if (descriptor !== null) {
      const freed = api.localFree(descriptor)
      if (!isNullPtr(freed)) throwLastError(api, 'LocalFree', `revokeWrite(${path}) descriptor`)
    }
    return false
  }

  const newAclSlot = allocPtrSlot()
  const mergeResult = api.setEntriesInAclW(1, buildExplicitAccess(sidPtr, abi.REVOKE_ACCESS, 0), oldAcl, newAclSlot)
  if (mergeResult !== abi.ERROR_SUCCESS) {
    if (descriptor !== null) api.localFree(descriptor) // frees the ACL block too
    throwWin32(api, 'SetEntriesInAclW', mergeResult, `revokeWrite(${path})`)
  }
  const newAcl = decodePtr(newAclSlot)
  if (newAcl === null) {
    if (descriptor !== null) api.localFree(descriptor)
    throwWin32(api, 'SetEntriesInAclW', api.getLastError(), `revokeWrite(${path}): null new ACL`)
  }

  // The descriptor block (oldAcl included) is dead after the merge — free it
  // before applying, exactly like the POC.
  const freedDescriptor = descriptor !== null ? api.localFree(descriptor) : null
  const applyResult = api.setNamedSecurityInfoW(
    path, abi.SE_FILE_OBJECT, abi.DACL_SECURITY_INFORMATION,
    null, null, newAcl, null,
  )
  const freedNew = api.localFree(newAcl)
  if (applyResult !== abi.ERROR_SUCCESS) throwWin32(api, 'SetNamedSecurityInfoW', applyResult, `revokeWrite(${path})`)
  if (freedDescriptor !== null && !isNullPtr(freedDescriptor)) throwLastError(api, 'LocalFree', `revokeWrite(${path}) descriptor`)
  if (!isNullPtr(freedNew)) throwLastError(api, 'LocalFree', `revokeWrite(${path}) new ACL`)
  return true
}
