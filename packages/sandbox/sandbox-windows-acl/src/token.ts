/**
 * Restricted-token construction: open the current process token, extract its
 * logon SID, build the well-known SIDs, and call CreateRestrictedToken with
 * the POC's restricting-SID allowlist. Every API call is checked; any failure
 * throws with the API name and the exact Win32 code — the original POC ignored
 * all of these and silently ran children with the FULL, unrestricted token.
 * @module @deepseek-ai/dsh-sandbox-windows-acl/token
 */

import { allocBytes, allocPtrSlot, allocUint32, decodePtr, decodePtrAt, decodeUint32, encodeUint32, isNullPtr, ptrAddress, throwLastError, throwWin32 } from './ffi.ts'
import type { NativePtr, Win32Bindings } from './ffi.ts'
import * as abi from './win32-abi.ts'

/**
 * Open the current process's access token with the rights
 * CreateRestrictedToken requires (the POC's OpenProcessToken call; the token
 * handle is obtained through a real OpenProcess handle because the
 * GetCurrentProcess() pseudo-handle is not addressable through koffi).
 * @param api - the binding table.
 * @returns the opened token handle.
 */
export function openCurrentProcessToken(api: Win32Bindings): NativePtr {
  const processHandle = api.openProcess(abi.PROCESS_QUERY_INFORMATION, 0, process.pid)
  if (isNullPtr(processHandle)) throwLastError(api, 'OpenProcess', `pid ${process.pid}`)

  const tokenSlot = allocPtrSlot()
  const opened = api.openProcessToken(
    processHandle,
    abi.TOKEN_QUERY | abi.TOKEN_DUPLICATE | abi.TOKEN_ADJUST_DEFAULT | abi.TOKEN_ASSIGN_PRIMARY,
    tokenSlot,
  )
  if (opened === 0) {
    const win32Code = api.getLastError()
    api.closeHandle(processHandle) // best-effort on the error path
    throwWin32(api, 'OpenProcessToken', win32Code, `pid ${process.pid}`)
  }
  if (api.closeHandle(processHandle) === 0) throwLastError(api, 'CloseHandle', 'OpenProcess process handle')
  const token = decodePtr(tokenSlot)
  if (token === null) throwWin32(api, 'OpenProcessToken', api.getLastError(), 'null token handle')
  return token
}

/**
 * Find and copy the token's logon session SID (S-1-5-5-x-y, attribute
 * SE_GROUP_LOGON_ID). The restricted token needs it for WinSta0/desktop and
 * other per-logon objects; the POC extracts it the same way.
 * @param api - the binding table.
 * @param token - the token whose groups are scanned.
 * @returns a copied logon SID (thrown when the token carries none).
 */
export function findLogonSid(api: Win32Bindings, token: NativePtr): NativePtr {
  const neededSlot = allocUint32()
  api.getTokenInformation(token, abi.TokenGroups, null, 0, neededSlot) // expected to fail with ERROR_INSUFFICIENT_BUFFER
  const needed = decodeUint32(neededSlot)
  if (needed === 0) throwLastError(api, 'GetTokenInformation', 'TokenGroups size query')
  if (needed < abi.TOKEN_GROUPS_OFFSET) throwWin32(api, 'GetTokenInformation', api.getLastError(), `implausible TokenGroups size ${needed}`)

  const groups = Buffer.alloc(needed)
  if (api.getTokenInformation(token, abi.TokenGroups, groups, groups.length, neededSlot) === 0) {
    throwLastError(api, 'GetTokenInformation', 'TokenGroups')
  }
  const groupCount = groups.readUInt32LE(0)
  for (let index = 0; index < groupCount; index++) {
    const sidPtr = decodePtrAt(groups, abi.TOKEN_GROUPS_OFFSET + index * abi.SID_AND_ATTRIBUTES_SIZE)
    const attributes = groups.readUInt32LE(abi.TOKEN_GROUPS_OFFSET + index * abi.SID_AND_ATTRIBUTES_SIZE + 8)
    // >>> 0: JS bitwise & is signed 32-bit; SE_GROUP_LOGON_ID has bit 31 set.
    const isLogonId = ((attributes & abi.SE_GROUP_LOGON_ID) >>> 0) === (abi.SE_GROUP_LOGON_ID >>> 0)
    if (sidPtr === null || !isLogonId) continue
    const sidLength = api.getLengthSid(sidPtr)
    if (sidLength === 0) throwLastError(api, 'GetLengthSid', `logon SID group ${index}`)
    const copy = allocBytes(sidLength)
    if (api.copySid(sidLength, copy, sidPtr) === 0) throwLastError(api, 'CopySid', `logon SID group ${index}`)
    return copy
  }
  throw new Error(`CreateRestrictedToken prerequisite failed: no logon SID found among ${groupCount} token groups`)
}

/**
 * Create one well-known SID (68-byte buffer) and assert its validity.
 * @param api - the binding table.
 * @param type - the WELL_KNOWN_SID_TYPE to create.
 * @returns the created SID pointer.
 */
export function makeWellKnownSid(api: Win32Bindings, type: number): NativePtr {
  const sid = allocBytes(abi.SECURITY_MAX_SID_SIZE)
  const sizeSlot = allocUint32()
  encodeUint32(sizeSlot, abi.SECURITY_MAX_SID_SIZE)
  if (api.createWellKnownSid(type, null, sid, sizeSlot) === 0) {
    throwLastError(api, 'CreateWellKnownSid', `type ${type}`)
  }
  if (api.isValidSid(sid) === 0) throwLastError(api, 'IsValidSid', `CreateWellKnownSid type ${type}`)
  return sid
}

/** Pack `SID_AND_ATTRIBUTES[count]` (16-byte stride; Attributes stay 0). */
function buildRestrictingSids(sids: readonly NativePtr[]): Buffer {
  const buffer = Buffer.alloc(abi.SID_AND_ATTRIBUTES_SIZE * sids.length)
  sids.forEach((sid, index) => {
    buffer.writeBigUInt64LE(ptrAddress(sid), abi.SID_AND_ATTRIBUTES_SIZE * index)
  })
  return buffer
}

/** The well-known SID packed into every restricted token's restricting list. */
export interface RestrictingSidSet {
  world: NativePtr
}

/**
 * Create the write-restricted token with the mode-selected restricting list
 * (verified on Win11 26200, see the POC-worktree restrict-variant harness):
 *  - read-only:       [logon SID, EVERYONE]
 *  - workspace-write: [logon SID, EVERYONE, orphan]
 *
 * The logon SID + EVERYONE keep-alive group is shared by both modes: early
 * DLL init dies with 0xC0000142 and CNG (`\Device\CNG` write trustee —
 * pwsh crashes 0xE0434352) fails without them. The orphan SID joins ONLY
 * workspace-write — read-only carries no orphan, so a standing grant ACE
 * from an earlier workspace-write period (a `/permission` mode downgrade, or
 * a crash-resumed session) stays INERT under read-only: the WRITE_RESTRICTED
 * pass-2 check grants only what the restricting list carries, keeping
 * read-only strictly zero-grant even with stale ACEs standing, while the
 * unrevoked ACE keeps the re-upgrade free (the seam's grant map hits it — no
 * re-propagation). Authenticated Users is absent from BOTH lists: the WMI
 * namespace security check fails (0x80041003), so CIM is unavailable in
 * every confined mode, and the C:\-root tree-creation escape (standing
 * `AU:(AD)` + `AU:(OI)(CI)(IO)(M)` ACEs) is closed in both — documented in
 * README. INTERACTIVE/LOCAL are absent from BOTH lists too — the host's
 * Public tree grants write to INTERACTIVE, so removing it closes that
 * escape. S-1-2-1 (console logon) is intentionally absent: see win32-abi.ts
 * for the verified failure modes. FAILS CLOSED: any failure throws — never
 * spawn unrestricted.
 * @param api - the binding table.
 * @param currentToken - the process token to restrict.
 * @param logonSid - the copied logon session SID.
 * @param writeSid - the orphan SID forming the write allowlist (workspace-write only).
 * @param known - the well-known SIDs entering the restricting list.
 * @param mode - selects the restricting list (workspace-write adds the orphan).
 * @returns the restricted token handle.
 */
export function createRestrictedToken(
  api: Win32Bindings,
  currentToken: NativePtr,
  logonSid: NativePtr,
  writeSid: NativePtr,
  known: RestrictingSidSet,
  mode: 'read-only' | 'workspace-write',
): NativePtr {
  const restrictingSids = buildRestrictingSids(mode === 'read-only'
    ? [logonSid, known.world]
    : [logonSid, known.world, writeSid])
  const tokenSlot = allocPtrSlot()
  const created = api.createRestrictedToken(
    currentToken,
    abi.DISABLE_MAX_PRIVILEGE | abi.LUA_TOKEN | abi.WRITE_RESTRICTED,
    0, null, // no SIDs disabled
    0, null, // no privileges deleted
    restrictingSids.length / abi.SID_AND_ATTRIBUTES_SIZE,
    restrictingSids,
    tokenSlot,
  )
  if (created === 0) throwLastError(api, 'CreateRestrictedToken', `restricting SIDs: ${restrictingSids.length / abi.SID_AND_ATTRIBUTES_SIZE}`)
  const token = decodePtr(tokenSlot)
  if (token === null) throwWin32(api, 'CreateRestrictedToken', api.getLastError(), 'null token handle')
  return token
}
