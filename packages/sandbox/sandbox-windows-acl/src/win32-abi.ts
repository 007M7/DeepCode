/**
 * Windows ABI constants for the ACL-sandbox backend.
 *
 * Every value was verified against the actual MinGW Windows headers on this
 * machine (C:\Strawberry\c\x86_64-w64-mingw32\include\) and cross-checked at
 * runtime by verify/abi-probe.cpp (same numbers; static_asserts passed).
 * Regenerate the probe with:
 *   g++ -std=c++20 -municode -O2 -o abi-probe.exe abi-probe.cpp -ladvapi32 && .\abi-probe.exe
 *
 * The port intentionally excludes two pieces of the original POC
 * (github.com/huoyaoyuan/windows-acl-restrict-poc @ 10e4dfb), both verified
 * empirically on Windows 11 build 26200:
 *  - S-1-2-1 (console logon SID) in the restricting list: the POC created it
 *    via CreateWellKnownSid(WinLocalLogonSid) which fails here with
 *    ERROR_INVALID_PARAMETER (87), leaving a garbage SID that makes
 *    CreateRestrictedToken fail with ERROR_INVALID_SID (1337); using the
 *    correct WinConsoleLogonSid does produce a valid S-1-2-1, but the child
 *    then still dies with STATUS_DLL_INIT_FAILED (0xC0000142) whenever
 *    CREATE_NO_WINDOW / CREATE_NEW_CONSOLE is used.
 *  - Console isolation: under this restriction scheme a hidden console is not
 *    attainable, so children share the host console (stdio redirection is
 *    pipe-based and unaffected).
 * @module @deepseek-ai/dsh-sandbox-windows-acl/win32-abi
 */

// ---- winnt.h ---------------------------------------------------------------

// TOKEN_* access rights (winnt.h lines ~3928)
export const TOKEN_ASSIGN_PRIMARY = 0x0001
export const TOKEN_DUPLICATE = 0x0002
export const TOKEN_QUERY = 0x0008
export const TOKEN_ADJUST_DEFAULT = 0x0080

// SID_AND_ATTRIBUTES.Attributes flags (winnt.h lines ~3446)
export const SE_GROUP_LOGON_ID = 0xC0000000

// Generic file access (winnt.h lines ~5893-5913):
// FILE_GENERIC_WRITE = STANDARD_RIGHTS_WRITE | FILE_WRITE_DATA | FILE_WRITE_ATTRIBUTES
//                      | FILE_WRITE_EA | FILE_APPEND_DATA | SYNCHRONIZE
export const STANDARD_RIGHTS_WRITE = 0x00020000 // == READ_CONTROL
export const FILE_GENERIC_WRITE = 0x00120116
// What the POC grants: FILE_GENERIC_WRITE minus READ_CONTROL; displays as
// "Write" in Explorer/icacls (windows-acl-restrict-poc.cpp line 16).
export const GRANT_MASK = FILE_GENERIC_WRITE & ~STANDARD_RIGHTS_WRITE // 0x00100116

// CreateRestrictedToken flags (winnt.h lines ~4284)
export const DISABLE_MAX_PRIVILEGE = 0x1
export const LUA_TOKEN = 0x4
export const WRITE_RESTRICTED = 0x8

// WELL_KNOWN_SID_TYPE (winnt.h lines ~3369-3407)
export const WinWorldSid = 1
export const WinLocalSid = 2
export const WinInteractiveSid = 11
export const WinAuthenticatedUserSid = 17

// TOKEN_INFORMATION_CLASS (winnt.h line ~3963: TokenUser=1, TokenGroups=2)
export const TokenGroups = 2

// SECURITY_INFORMATION (winnt.h line ~4293)
export const DACL_SECURITY_INFORMATION = 0x00000004

// PROCESS access rights (winnt.h lines ~4364)
export const PROCESS_QUERY_INFORMATION = 0x0400

// ---- accctrl.h -------------------------------------------------------------

// SE_OBJECT_TYPE (accctrl.h line ~22: SE_UNKNOWN_OBJECT_TYPE=0, SE_FILE_OBJECT=1)
export const SE_FILE_OBJECT = 1

// TRUSTEE_FORM / TRUSTEE_TYPE (accctrl.h lines ~38-55): both enums start at 0
export const TRUSTEE_IS_UNKNOWN = 0
export const TRUSTEE_IS_SID = 0
export const NO_MULTIPLE_TRUSTEE = 0

// ACCESS_MODE (accctrl.h line ~127: NOT_USED_ACCESS=0, GRANT_ACCESS=1, REVOKE_ACCESS=4)
export const GRANT_ACCESS = 1
export const REVOKE_ACCESS = 4

// grfInheritance (accctrl.h lines ~137-142)
export const SUB_CONTAINERS_AND_OBJECTS_INHERIT = 0x3 // == OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE

// ---- winbase.h -------------------------------------------------------------

export const STARTF_USESTDHANDLES = 0x00000100
export const HANDLE_FLAG_INHERIT = 0x1
export const INFINITE = 0xFFFFFFFF
export const MAX_PATH = 260
// winbase.h line ~410: the confined child starts suspended so the runner can
// assign it to the kill-on-close job before any of its code runs.
export const CREATE_SUSPENDED = 0x4
// winbase.h lines ~497-499: GetStdHandle selectors.
export const STD_INPUT_HANDLE = -10
export const STD_OUTPUT_HANDLE = -11
export const STD_ERROR_HANDLE = -12

// FormatMessageW flags (winbase.h lines ~1446-1469)
export const FORMAT_MESSAGE_FROM_SYSTEM = 0x00001000
export const FORMAT_MESSAGE_IGNORE_INSERTS = 0x00000200

// ---- error codes -----------------------------------------------------------

export const ERROR_SUCCESS = 0
export const ERROR_INSUFFICIENT_BUFFER = 122
export const ERROR_BROKEN_PIPE = 109
export const ERROR_NO_DATA = 232

// ---- job object (winnt.h lines ~4859-4866, ~5138, ~5190-5199) --------------

// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: the child dies when the runner's last
// job handle closes — the orphan-child backstop for the runner design.
export const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
// JOBOBJECTINFOCLASS: JobObjectBasicAccountingInformation=1, ..., ExtendedLimit=9.
export const JobObjectExtendedLimitInformation = 9
// sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION), verified by abi-probe.
export const JOBOBJECT_EXTENDED_LIMIT_SIZE = 144
// LimitFlags offset inside JOBOBJECT_EXTENDED_LIMIT_INFORMATION
// (BasicLimitInformation@0 + PerProcessUserTimeLimit@0 + PerJobUserTimeLimit@8),
// verified by abi-probe.
export const JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET = 16

// ---- ABI layout, verified by verify/abi-probe.cpp (x64) --------------------

export const SECURITY_MAX_SID_SIZE = 68
/** SID_AND_ATTRIBUTES stride: { PSID Sid @0 (8); DWORD Attributes @8 (4) } + pad. */
export const SID_AND_ATTRIBUTES_SIZE = 16
/** TOKEN_GROUPS.Groups[] starts at offset 8 (GroupCount @0 + alignment). */
export const TOKEN_GROUPS_OFFSET = 8
/** sizeof(EXPLICIT_ACCESS_W): perms@0 mode@4 inheritance@8 Trustee@16. */
export const EXPLICIT_ACCESS_W_SIZE = 48
/** Trustee offset inside EXPLICIT_ACCESS_W. */
export const TRUSTEE_W_OFFSET = 16
/** ptstrName offset inside TRUSTEE_W (=> 40 inside EXPLICIT_ACCESS_W). */
export const TRUSTEE_W_PTSTRNAME_OFFSET = 24
export const STARTUPINFOW_SIZE = 104
export const PROCESS_INFORMATION_SIZE = 24
