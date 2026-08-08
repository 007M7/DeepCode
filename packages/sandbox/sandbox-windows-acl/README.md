# @deepseek-ai/dsh-sandbox-windows-acl

English | [中文](README.zh.md)

Windows write-restriction sandbox backend for the [harness sandbox seam](../sandbox/): a Node.js/[koffi](https://koffi.dev/) port of the mechanism in [huoyaoyuan/windows-acl-restrict-poc](https://github.com/huoyaoyuan/windows-acl-restrict-poc) (`10e4dfb`, the fixed revision), mounted as the win32 rung of the [`@deepseek-ai/dsh-sandbox-local`](../sandbox-local/) chain (`workspace-write` / `read-only` modes); the same package carries the Linux/macOS backends.

Mechanism in one line: the caller's token is duplicated into a `WRITE_RESTRICTED` token whose restricting SIDs include an orphan SID (`S-1-4-x-y`) whose Write ACEs exist only on the session's workspace and private temp directories (the seam provisions ONE SID per session and materializes the ACEs for the server's lifetime — see [The confinement runner](#the-confinement-runner)). Windows then grants a write only where BOTH the caller's normal access AND the restricting-SID intersection allow it — the orphan SID is the write allowlist, and it grants nothing anywhere else on the system.

Building directly on the raw ACL mechanism is the recorded design choice: it implements both confinement modes without the problems the rejected container options carry — see the [design note](../../../.agents/notes/implemented/feature/2026-08-08-windows-acl-restricted-token-sandbox.md) ([mxc](https://github.com/microsoft/mxc/blob/main/docs/process-container/os-version-support.md) needs an OS floor of Windows 11 24H2 and wholesale host DACL writes for arbitrary-path reads; AppContainer cannot do arbitrary-path reads at all).

## Usage

```ts
import { AclSandbox } from '@deepseek-ai/dsh-sandbox-windows-acl'

const workspaceRoot = process.cwd()

// mode selects the token's restricting-SID list (see Modes below) and must
// match the grant shape: read-only pairs with zero grants.
const sandbox = new AclSandbox({ writableDirs: [workspaceRoot], mode: 'workspace-write' })
await sandbox.init() // throws on ANY Win32 failure — never spawns unrestricted

const child = sandbox.spawn({ command: 'pwsh', args: ['-NoProfile', '-Command', '...'], cwd: workspaceRoot })
const { stdout, stderr, exitCode } = await child.wait()

sandbox.dispose() // revokes all standing grants; reports every cleanup failure
```

A direct `AclSandbox` grants and revokes per instance (one allowlist per spawn cycle). The server-side per-session reuse is the `AclWriteGrant` class: one instance per session, `add()` per directory, `dispose()` on provider shutdown — see the runner contract below. Every Win32 API call in this package is checked; failures throw `Win32Error` carrying the API name, the exact Win32 code, the `FormatMessageW` system text, and the failing path/context. This is deliberate: the POC ignored every return value and, when `CreateRestrictedToken` failed, silently ran the child with the FULL unrestricted token (fail-open). This port fails closed by construction.

## The confinement runner

The seam-facing shape is the **runner entry** (`./runner`), the argv-prefix wrapper `@deepseek-ai/dsh-sandbox-local` spawns in place of the caller's command — the same architecture as bwrap/landlock-run/sandbox-exec, so the sandbox seam's `confine()` contract needs no change. Stable argv contract:

```sh
node runner.js --workspace <dir> --temp <dir> --mode <read-only|workspace-write> [--write-sid <S-1-4-…>] -- <argv...>
```

The runner creates the restricted token, spawns the wrapped argv under it with the caller's stdio passed straight through (the caller's pipes, made inheritable around the spawn — Node clears stdio inheritability at startup, which raw spawns must compensate for), wraps the child in a `KILL_ON_JOB_CLOSE` job (a dead runner kills the child), ignores its own console Ctrl+C so the child handles its own, mirrors the child's exit code, and revokes all grants on exit. Every runner-side failure prints `windows-acl-run: <detail>` to stderr and exits 127 — the seam's `RUNNER_FAILURE_RULES` match that signature, so a runner refusal is never mistaken for a denial.

**Per-session grant reuse** (`--write-sid`): the seam provisions ONE orphan SID per session — stored as a log-only `sandbox/acl-session` event on the session log, so a resumed session replays the SAME SID and a fork mints a fresh one — and materializes its ACEs lazily at the session's first confined execution, holding them for the SERVER process's lifetime (revoked on provider dispose). Under `--write-sid` the runner neither grants nor revokes (`manageDacls: false`); without it (standalone use) it self-manages per-call grants as before. Re-granting after a restart is idempotent: `grantWrite` reads the current DACL and SKIPS the `SetNamedSecurityInfoW` apply when the exact ACE already stands (that apply eagerly re-propagates the identical ACE across the whole tree — minutes on large workspaces). Standing ACEs from an unclean shutdown need no garbage collection: the session's record re-grants the same SID, and the next dispose revokes them. Known cost: materializing a grant on a big workspace tree blocks for the full eager propagation once per session per server lifetime.

Modes (the token's restricting-SID list follows the mode):
- `workspace-write` (list J = logon SID, Everyone, Authenticated Users, orphan): the workspace and the session's PRIVATE temp subdirectory carry the orphan-SID Write grant; every other write is denied by the token intersection. Authenticated Users stays in the list so the CIM path keeps working (`Get-CimInstance`, `Get-ComputerInfo`); the price is the residual Authenticated-Users-writable surface — notably the C:\ drive root, where standing `AU:(AD)` + `AU:(OI)(CI)(IO)(M)` ACEs admit an AU-confined tree-creation escape — see the design note.
- `read-only` (list I = logon SID, Everyone — NO orphan): STRICT zero grants — nothing is writable, and the token also DROPS Authenticated Users for a zero ambient-write surface (the C:\-root escape above is closed). The orphan stays OUT of list I on purpose: a standing grant ACE from an earlier workspace-write period (a `/permission` downgrade, or a crash-resumed session) remains INERT under read-only because the write-restricted pass-2 check grants only what the restricting list carries — while the unrevoked ACE keeps the re-upgrade free of re-propagation. The NUL device is a securable object and is NOT granted (unlike Linux's `/dev/null` sink): `Set-Content NUL` and native `> NUL` writes fail with access denied, while PowerShell's `> $null` redirection keeps working (it discards without opening NUL). The cost is CIM unavailability: the WMI namespace security check fails (`0x80041003`), so CIM cmdlets and `Get-ComputerInfo` (which silently returns incomplete results rather than an error) are unavailable — the model-facing surface documents that contract, not a prompt promise.

The `AclSandbox` class (`tempDir: null` disables the temp grant) remains the programmatic API for direct spawns; `AclWriteGrant` is the server-side materialization half of the per-session contract.

## Header verification

All constants, signatures, and struct layouts were verified against the Windows headers on the development machine (MinGW `winnt.h` / `accctrl.h` / `aclapi.h` / `securitybaseapi.h` / `sddl.h` / `processthreadsapi.h` / `fileapi.h` / `namedpipeapi.h` / `synchapi.h` / `winbase.h`) and are cross-checked at runtime by [`verify/abi-probe.cpp`](verify/abi-probe.cpp) (sizes, offsets, enum values, static asserts):

```sh
g++ -std=c++20 -municode -O2 -o abi-probe.exe verify/abi-probe.cpp -ladvapi32 && ./abi-probe.exe
```

The koffi struct definitions assert their sizes against the probe at module load, so a header/koffi layout drift fails loudly instead of corrupting memory.

## Verified boundaries (inherent to restricted tokens, not this port)

- **Writes are restricted; reads, network, and process visibility are not.** `WRITE_RESTRICTED` intersects write accesses only, so a confined child can read any caller-readable file and open sockets. `read-only` mode therefore cannot be expressed by this mechanism alone; pair it with a read-side policy or an AppContainer/`S-1-15-2` capability token for stronger confinement.
- **Console isolation is unavailable.** Under the restricted token, children created with `CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE` die during DLL initialization with `STATUS_DLL_INIT_FAILED` (`0xC0000142`). The POC tried to fix this by adding the console logon SID (`S-1-2-1`) to the restricting list; on Windows 11 26200 `CreateWellKnownSid(WinLocalLogonSid)` fails with `ERROR_INVALID_PARAMETER` (87), the correct `WinConsoleLogonSid` yields a valid `S-1-2-1` but the child still dies, and the POC's final revision removed both the SID and console isolation. Children therefore share the host console; stdio redirection is pipe-based and unaffected.
- **ACL grants are standing directory mutations.** They persist if the process dies mid-run; `dispose()` revokes them, and `init()` revokes already-applied grants when a later step fails. The POC's documented manual cleanup (`icacls <dir> /remove '*S-1-4-…'`) fails on this platform with `ERROR_NONE_MAPPED` (1332) — revoke through this module instead. The per-session record makes an unclean shutdown self-healing: the same SID is re-granted on resume (skipping the apply when the ACE stands) and revoked at the next dispose; orphan ACEs never accumulate a new SID per restart.
- **Granted directories must be caller-owned.** The owner's implicit `WRITE_DAC` is what lets the sandbox edit the DACL without elevation.
- **The temp grant follows `GetTempPathW`** — pass `tempDir` explicitly whenever possible. `GetTempPathW` reads the NATIVE environment block, which host runtimes that manage `process.env` through worker pools may not keep in sync (verified with vitest: a worker-side `process.env.TMP` change never reached the native block). The seam passes the session's PRIVATE subdirectory (`<temp>\dsh-<hash>`); a defaulted grant landing on the real temp dir inherits `(OI)(CI)` over every subdirectory of temp, silently widening the allowlist — point it at a per-sandbox directory instead.
- **The confined child's temp root is private per session** (workspace-write + `--write-sid`): the runner rewrites TMP/TEMP via `SetEnvironmentVariableW` to the session's private subdirectory before the spawn and the child inherits the rewritten block (bwrap `--tmpfs /tmp` semantics). Read-only leaves the ambient temp entries untouched — writes there are denied anyway. The subdirectory itself is plain `%TEMP%` litter with no garbage collection: OS temp hygiene reclaims it, and the record's determinism lets a later resume reuse it.
- **`whoami` and token-inspection cmdlets fail under the restricted token.** `GetTokenInformation` on the duplicate is partially unavailable to the child, so `whoami /all` reports errors — diagnostic noise of the restriction scheme, not an operational failure; the denial surfaces that matter (file writes) are unaffected.

## Model Experience

Indirectly, through [`dsh-bash-sandbox`](../../bash/bash-sandbox/README.md), [`dsh-pwsh-sandbox`](../../bash/pwsh-sandbox/README.md), and their tools, which render this backend's enforcement and denial facts (the confined stderr the tool layer classifies through `denialSignatures`) while the [`dsh-sandbox`](../sandbox/README.md) seam owns the `SANDBOX_UNAVAILABLE` text and runner selection.

#### KV Cache effect

None directly; the denial surface belongs to the tool layer.

## Known Limitations and Deferred Work

- **One write allowlist per instance** — the orphan SID is the unit of the allowlist; reusing one sandbox instance across two workspaces widens both grants to both roots. Create one instance per workspace root (the seam's per-session record does exactly this: one SID per session, keyed to the session's immutable cwd).
- **Cleanup is best-effort by design** — `dispose()` attempts every revocation and aggregates failures into an `AggregateError`; a cleanup failure leaves a standing (but orphan-SID-only) ACE that this process's next `init()`/`dispose()` cycle or `icacls` (via the ACE, not the trustee name) can still remove.
- **Grant materialization is an eager full-tree propagation.** `SetNamedSecurityInfoW` on a directory with inheritable ACEs walks every descendant immediately (NOT lazily per access — measured at tens of seconds on large workspace trees plus the real temp root). The per-session reuse pays it once per session per server lifetime (lazily at the first confined execution, skipped entirely when the exact ACE survives a restart); the self-managed runner fallback still pays it per invocation. If a session's workspace is huge, the first pwsh call of each server lifetime is correspondingly slow.
- **Resuming one session concurrently in two server processes grants two SIDs.** The durable record lives in the session log; both processes read or provision it independently, the per-path lock keeps the DACL merges consistent, and the last-written record wins for future resumes — the losing SID's ACEs are revoked by its own process's dispose. Single-writer session usage (the normal deployment) never sees this.
- **Read-side confinement and network policy are out of scope** — `WRITE_RESTRICTED` intersects write accesses only; pair this backend with a read-side policy for stronger confinement.
- **Wide-directory and FAT-volume warnings are deferred** — the UI-side warnings for granting unusually wide directories or FAT-class (non-ACL) volumes are not yet implemented; a FAT volume simply fails the grant loudly.
- **Both confined modes run `pwsh` in ConstrainedLanguage.** The restricted token trips PowerShell's lockdown detection, so under `read-only` AND `workspace-write` the language mode is ConstrainedLanguage: `Add-Type` (C# compile, P/Invoke), non-core .NET static calls (`[System.IO.*]::`, `[math]::`, `[Environment]::`), COM objects, and reflection fail with `Cannot create type` / `Cannot invoke method` ("only core types") errors, and `$ExecutionContext.SessionState.LanguageMode = 'FullLanguage'` is refused. Core cmdlets, core types (`[string]`, `[datetime]`, `[regex]`, `[guid]`), `-f` formatting, and property access keep working. The `pwsh` tool description teaches this contract to the model; `danger-full-access` calls run unconfined at FullLanguage.
