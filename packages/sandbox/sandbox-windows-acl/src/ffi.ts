/**
 * Lazy koffi bindings for the Win32 ACL-sandbox backend. Koffi loads lazily so
 * non-Windows processes never open Win32 libraries. Every function signature
 * below was verified against the MinGW Windows headers on this machine
 * (winnt.h / accctrl.h / aclapi.h / securitybaseapi.h / sddl.h /
 * processthreadsapi.h / fileapi.h / namedpipeapi.h / synchapi.h / winbase.h);
 * struct layouts are asserted at load time against verify/abi-probe.cpp.
 * @module @deepseek-ai/dsh-sandbox-windows-acl/ffi
 */

import koffi from 'koffi'
import { Win32Error } from './errors.ts'
import * as abi from './win32-abi.ts'

/** Branded koffi 3 native pointer. Koffi 3 pointers are BigInt values; the brand keeps them out of numeric contexts. */
declare const nativePtr: unique symbol
export type NativePtr = bigint & { readonly [nativePtr]: true }

/** True for NULL pointers, however koffi returns them (null or 0n). */
export function isNullPtr(value: NativePtr | null | undefined): value is null | undefined {
  return value === null || value === undefined || (value as bigint) === 0n
}

type Ptr = ReturnType<typeof koffi.pointer>

/** Field subset written into a zeroed STARTUPINFOW (layout verified: size 104). */
export interface StartupInfoInput {
  cb: number
  dwFlags: number
  hStdInput: NativePtr
  hStdOutput: NativePtr
  hStdError: NativePtr
}

/** Decoded PROCESS_INFORMATION (layout verified: size 24). */
export interface ProcessInfoOutput {
  hProcess: NativePtr | null
  hThread: NativePtr | null
  dwProcessId: number
  dwThreadId: number
}

export interface Win32Bindings {
  // ---- process / token handles --------------------------------------------
  openProcess(desiredAccess: number, inheritHandle: number, pid: number): NativePtr
  openProcessToken(process: NativePtr, desiredAccess: number, tokenHandle: NativePtr): number
  closeHandle(handle: NativePtr): number
  // ---- errors / diagnostics ------------------------------------------------
  getLastError(): number
  formatMessageW(flags: number, source: null, messageId: number, languageId: number, buffer: Buffer, size: number, args: null): number
  // ---- memory --------------------------------------------------------------
  localAlloc(flags: number, bytes: number): NativePtr
  localFree(memory: NativePtr): NativePtr
  // ---- SIDs ----------------------------------------------------------------
  convertStringSidToSidW(stringSid: string, sid: NativePtr): number
  convertSidToStringSidW(sid: NativePtr, stringSid: NativePtr): number
  createWellKnownSid(type: number, domainSid: null, sid: NativePtr, size: NativePtr): number
  isValidSid(sid: NativePtr): number
  getLengthSid(sid: NativePtr): number
  copySid(length: number, destination: NativePtr, source: NativePtr): number
  // ---- token information ---------------------------------------------------
  getTokenInformation(token: NativePtr, cls: number, info: Buffer | null, length: number, needed: NativePtr): number
  // ---- restricted token ----------------------------------------------------
  createRestrictedToken(
    existing: NativePtr, flags: number,
    disableCount: number, disableSids: null,
    deletePrivilegeCount: number, privilegesToDelete: null,
    restrictCount: number, restrictingSids: Buffer,
    newToken: NativePtr,
  ): number
  // ---- ACL editing ---------------------------------------------------------
  setEntriesInAclW(count: number, entries: Buffer, oldAcl: NativePtr | null, newAcl: NativePtr): number
  setNamedSecurityInfoW(
    path: string, objectType: number, information: number,
    owner: null, group: null, dacl: NativePtr | null, sacl: null,
  ): number
  getNamedSecurityInfoW(
    path: string, objectType: number, information: number,
    owner: NativePtr, group: NativePtr, dacl: NativePtr, sacl: NativePtr, descriptor: NativePtr,
  ): number
  // ---- environment / io ----------------------------------------------------
  getTempPathW(length: number, buffer: Buffer): number
  createPipe(readHandle: NativePtr, writeHandle: NativePtr, attributes: null, size: number): number
  setHandleInformation(handle: NativePtr, mask: number, flags: number): number
  createProcessAsUserW(
    token: NativePtr, applicationName: null, commandLine: string,
    processAttributes: null, threadAttributes: null,
    inheritHandles: number, creationFlags: number, environment: null,
    currentDirectory: string | null, startupInfo: NativePtr, processInfo: NativePtr,
  ): number
  readFile(file: NativePtr, buffer: Buffer, count: number, bytesRead: NativePtr, overlapped: null): number
  peekNamedPipe(
    pipe: NativePtr, buffer: null, size: number,
    bytesRead: NativePtr, totalAvail: NativePtr, leftThisMessage: NativePtr,
  ): number
  waitForSingleObject(handle: NativePtr, milliseconds: number): number
  getExitCodeProcess(process: NativePtr, exitCode: NativePtr): number
  resumeThread(thread: NativePtr): number
  // ---- job object (runner kill-on-close) -----------------------------------
  createJobObjectW(attributes: null, name: null): NativePtr
  setInformationJobObject(job: NativePtr, cls: number, information: Buffer, length: number): number
  assignProcessToJobObject(job: NativePtr, process: NativePtr): number
  // ---- console -------------------------------------------------------------
  // HandlerRoutine=null + add=1 makes this process ignore CTRL+C (wincon.h):
  // the runner survives console Ctrl+C so the child handles its own and the
  // runner can clean up grants after the child exits.
  setConsoleCtrlHandler(handler: null, add: number): number
  getStdHandle(stdHandle: number): NativePtr
}

const PVOID: Ptr = koffi.pointer('void')
const PPVOID: Ptr = koffi.pointer(PVOID)

export const STARTUPINFOW = koffi.struct('STARTUPINFOW', {
  cb: 'uint32',
  lpReserved: 'str16',
  lpDesktop: 'str16',
  lpTitle: 'str16',
  dwX: 'uint32',
  dwY: 'uint32',
  dwXSize: 'uint32',
  dwYSize: 'uint32',
  dwXCountChars: 'uint32',
  dwYCountChars: 'uint32',
  dwFillAttribute: 'uint32',
  dwFlags: 'uint32',
  wShowWindow: 'uint16',
  cbReserved2: 'uint16',
  lpReserved2: koffi.pointer('uint8'),
  hStdInput: PVOID,
  hStdOutput: PVOID,
  hStdError: PVOID,
})

export const PROCESS_INFORMATION = koffi.struct('PROCESS_INFORMATION', {
  hProcess: PVOID,
  hThread: PVOID,
  dwProcessId: 'uint32',
  dwThreadId: 'uint32',
})

if (STARTUPINFOW.size !== abi.STARTUPINFOW_SIZE) {
  throw new Error(`STARTUPINFOW layout mismatch: koffi computed ${STARTUPINFOW.size}, header probe says ${abi.STARTUPINFOW_SIZE}`)
}
if (PROCESS_INFORMATION.size !== abi.PROCESS_INFORMATION_SIZE) {
  throw new Error(`PROCESS_INFORMATION layout mismatch: koffi computed ${PROCESS_INFORMATION.size}, header probe says ${abi.PROCESS_INFORMATION_SIZE}`)
}

/** Allocate one pointer-sized slot (for `T **` out-parameters). */
export function allocPtrSlot(): NativePtr {
  const value: unknown = koffi.alloc(PVOID, 1)
  return value as NativePtr
}

/** Allocate one uint32 slot. */
export function allocUint32(): NativePtr {
  const value: unknown = koffi.alloc('uint32', 1)
  return value as NativePtr
}

/** Write a uint32 value into a slot pointer. */
export function encodeUint32(slot: NativePtr, value: number): void {
  koffi.encode(slot, 'uint32', value)
}

/** Decode the pointer stored in a pointer-sized slot (NULL becomes null). */
export function decodePtr(slot: NativePtr): NativePtr | null {
  const value: unknown = koffi.decode(slot, PVOID)
  if (isNullPtr(value as NativePtr | null | undefined)) return null
  return value as NativePtr
}

/** Decode a uint32 at a slot pointer. */
export function decodeUint32(slot: NativePtr): number {
  const value: unknown = koffi.decode(slot, 'uint32')
  return value as number
}

/** Decode a UTF-16 string at a pointer. */
export function decodeStr16(ptr: NativePtr): string {
  const value: unknown = koffi.decode(ptr, 'str16')
  return value as string
}

/** Cast a koffi pointer to its numeric address (bigint, used for raw struct packing). */
export function ptrAddress(ptr: NativePtr): bigint {
  return koffi.address(ptr)
}

/** Allocate a raw byte block (used for SID copies and variable-length arrays). */
export function allocBytes(length: number): NativePtr {
  const value: unknown = koffi.alloc('uint8', length)
  return value as NativePtr
}

/** Decode a pointer VALUE stored in memory at `buffer[offset]` (e.g. TOKEN_GROUPS entries). */
export function decodePtrAt(buffer: Buffer, offset: number): NativePtr | null {
  const value: unknown = koffi.decode(buffer, offset, PVOID)
  if (isNullPtr(value as NativePtr | null | undefined)) return null
  return value as NativePtr
}

/** Allocate a zeroed STARTUPINFOW. */
export function allocStartupInfo(): NativePtr {
  const value: unknown = koffi.alloc(STARTUPINFOW, 1)
  return value as NativePtr
}

/** Write the stdio-relevant fields into a zeroed STARTUPINFOW (others stay default-initialized). */
export function encodeStartupInfo(startupInfo: NativePtr, fields: StartupInfoInput): void {
  koffi.encode(startupInfo, STARTUPINFOW, fields)
}

/** Allocate a zeroed PROCESS_INFORMATION. */
export function allocProcessInfo(): NativePtr {
  const value: unknown = koffi.alloc(PROCESS_INFORMATION, 1)
  return value as NativePtr
}

/** Decode a PROCESS_INFORMATION after CreateProcessAsUserW. */
export function decodeProcessInfo(processInfo: NativePtr): ProcessInfoOutput {
  const value: unknown = koffi.decode(processInfo, PROCESS_INFORMATION)
  return value as ProcessInfoOutput
}

let cached: Win32Bindings | undefined

function bindings(): Win32Bindings {
  if (cached !== undefined) return cached
  const kernel32 = koffi.load('kernel32.dll')
  const advapi32 = koffi.load('advapi32.dll')

  // Each binding shape is verified by verify/abi-probe.cpp against the real
  // Windows headers and exercised end-to-end by tests/probe.spec.ts; the
  // single cast keeps the per-binding noise out of this table.
  const bind = (lib: ReturnType<typeof koffi.load>, name: string, result: Ptr | string, args: Array<Ptr | string>): unknown =>
    lib.func('__stdcall', name, result, args)

  cached = {
    openProcess: bind(kernel32, 'OpenProcess', PVOID, ['uint32', 'int', 'uint32']),
    openProcessToken: bind(advapi32, 'OpenProcessToken', 'int', [PVOID, 'uint32', PPVOID]),
    closeHandle: bind(kernel32, 'CloseHandle', 'int', [PVOID]),
    getLastError: bind(kernel32, 'GetLastError', 'uint32', []),
    formatMessageW: bind(kernel32, 'FormatMessageW', 'uint32', ['uint32', PVOID, 'uint32', 'uint32', PVOID, 'uint32', PVOID]),
    localAlloc: bind(kernel32, 'LocalAlloc', PVOID, ['uint32', 'size_t']),
    localFree: bind(kernel32, 'LocalFree', PVOID, [PVOID]),
    convertStringSidToSidW: bind(advapi32, 'ConvertStringSidToSidW', 'int', ['str16', PPVOID]),
    convertSidToStringSidW: bind(advapi32, 'ConvertSidToStringSidW', 'int', [PVOID, koffi.pointer('str16')]),
    createWellKnownSid: bind(advapi32, 'CreateWellKnownSid', 'int', ['int', PVOID, PVOID, koffi.pointer('uint32')]),
    isValidSid: bind(advapi32, 'IsValidSid', 'int', [PVOID]),
    getLengthSid: bind(advapi32, 'GetLengthSid', 'uint32', [PVOID]),
    copySid: bind(advapi32, 'CopySid', 'int', ['uint32', PVOID, PVOID]),
    getTokenInformation: bind(advapi32, 'GetTokenInformation', 'int', [PVOID, 'int', PVOID, 'uint32', koffi.pointer('uint32')]),
    createRestrictedToken: bind(advapi32, 'CreateRestrictedToken', 'int', [PVOID, 'uint32', 'uint32', PVOID, 'uint32', PVOID, 'uint32', PVOID, PPVOID]),
    setEntriesInAclW: bind(advapi32, 'SetEntriesInAclW', 'uint32', ['uint32', PVOID, PVOID, PPVOID]),
    setNamedSecurityInfoW: bind(advapi32, 'SetNamedSecurityInfoW', 'uint32', ['str16', 'int', 'uint32', PVOID, PVOID, PVOID, PVOID]),
    getNamedSecurityInfoW: bind(advapi32, 'GetNamedSecurityInfoW', 'uint32', ['str16', 'int', 'uint32', PPVOID, PPVOID, PPVOID, PPVOID, PPVOID]),
    getTempPathW: bind(kernel32, 'GetTempPathW', 'uint32', ['uint32', PVOID]),
    createPipe: bind(kernel32, 'CreatePipe', 'int', [PPVOID, PPVOID, PVOID, 'uint32']),
    setHandleInformation: bind(kernel32, 'SetHandleInformation', 'int', [PVOID, 'uint32', 'uint32']),
    createProcessAsUserW: bind(advapi32, 'CreateProcessAsUserW', 'int', [
      PVOID, 'str16', 'str16', PVOID, PVOID, 'int', 'uint32', PVOID, 'str16',
      koffi.pointer(STARTUPINFOW), koffi.pointer(PROCESS_INFORMATION),
    ]),
    readFile: bind(kernel32, 'ReadFile', 'int', [PVOID, PVOID, 'uint32', koffi.pointer('uint32'), PVOID]),
    peekNamedPipe: bind(kernel32, 'PeekNamedPipe', 'int', [PVOID, PVOID, 'uint32', koffi.pointer('uint32'), koffi.pointer('uint32'), koffi.pointer('uint32')]),
    waitForSingleObject: bind(kernel32, 'WaitForSingleObject', 'uint32', [PVOID, 'uint32']),
    getExitCodeProcess: bind(kernel32, 'GetExitCodeProcess', 'int', [PVOID, koffi.pointer('uint32')]),
    resumeThread: bind(kernel32, 'ResumeThread', 'uint32', [PVOID]),
    createJobObjectW: bind(kernel32, 'CreateJobObjectW', PVOID, [PVOID, 'str16']),
    setInformationJobObject: bind(kernel32, 'SetInformationJobObject', 'int', [PVOID, 'int', PVOID, 'uint32']),
    assignProcessToJobObject: bind(kernel32, 'AssignProcessToJobObject', 'int', [PVOID, PVOID]),
    setConsoleCtrlHandler: bind(kernel32, 'SetConsoleCtrlHandler', 'int', [PVOID, 'int']),
    getStdHandle: bind(kernel32, 'GetStdHandle', PVOID, ['int']),
  } as unknown as Win32Bindings
  return cached
}

/** Resolve the lazy Win32 bindings (throws the first binding failure, fail-closed). */
export function win32(): Promise<Win32Bindings> {
  return Promise.resolve(bindings())
}

/** Turn a Win32 error code into readable text via FormatMessageW. */
export function errorText(api: Win32Bindings, win32Code: number): string {
  const buffer = Buffer.alloc(1024)
  const length = api.formatMessageW(
    abi.FORMAT_MESSAGE_FROM_SYSTEM | abi.FORMAT_MESSAGE_IGNORE_INSERTS,
    null, win32Code, 0, buffer, buffer.length / 2, null,
  )
  if (length === 0) return ''
  return buffer.subarray(0, length * 2).toString('utf16le').trim()
}

/**
 * Throw a Win32Error for a BOOL-style API failure. MUST be called immediately
 * after the failed call so GetLastError is not clobbered by other Win32 calls.
 */
export function throwLastError(api: Win32Bindings, name: string, detail?: string): never {
  const win32Code = api.getLastError()
  throw new Win32Error(name, win32Code, detail ?? errorText(api, win32Code))
}

/** Throw a Win32Error for an HRESULT-style API return value (the value IS the error code). */
export function throwWin32(api: Win32Bindings, name: string, win32Code: number, detail?: string): never {
  throw new Win32Error(name, win32Code, detail ?? errorText(api, win32Code))
}
