# @deepseek-ai/dsh-sandbox-windows-acl

English | [中文](README.zh.md)

Windows write-restriction sandbox backend for the [harness sandbox seam](../sandbox/): a Node.js/[koffi](https://koffi.dev/) port of the mechanism in [huoyaoyuan/windows-acl-restrict-poc](https://github.com/huoyaoyuan/windows-acl-restrict-poc) (`10e4dfb`, the fixed revision), mounted as the win32 rung of the [`@deepseek-ai/dsh-sandbox-local`](../sandbox-local/) chain (`workspace-write` / `read-only` modes); the same package carries the Linux/macOS backends.

Mechanism in one line: the caller's token is duplicated into a `WRITE_RESTRICTED` token whose restricting SIDs include a write SID (`S-1-4-x-y`) whose Write ACEs exist only on the workspace and the session's private temp directory. The write SID is the per-WORKSPACE identity, derived deterministically from the canonical workspace path (`workspaceWriteSid`), so the workspace-root ACE materializes once per workspace per machine — every later session, call, or restart hits the exact-ACE skip — instead of once per session (see [The confinement runner](#the-confinement-runner)). Windows then grants a write only where BOTH the caller's normal access AND the restricting-SID intersection allow it — the write SID is the write allowlist, and it grants nothing anywhere else on the system; the token's write check also inherits the ambient write ACEs of the OTHER restricting SIDs (the keep-alive group logon SID + Everyone — the Modes section below is the complete boundary).

Building directly on the raw ACL mechanism is the recorded design choice: it implements both confinement modes without the problems the rejected container options carry — see the [design note](../../../.agents/notes/implemented/feature/2026-08-08-windows-acl-restricted-token-sandbox.md) ([mxc](https://github.com/microsoft/mxc/blob/main/docs/process-container/os-version-support.md) needs an OS floor of Windows 11 24H2 and wholesale host DACL writes for arbitrary-path reads; AppContainer cannot do arbitrary-path reads at all).

## Usage

```ts
import { AclSandbox, workspaceWriteSid } from '@deepseek-ai/dsh-sandbox-windows-acl'

const workspaceRoot = process.cwd()

// mode selects the token's restricting-SID list (see Modes below) and must
// match the grant shape: read-only pairs with zero grants. workspace-write
// REQUIRES the workspace's write SID — the per-workspace identity.
const sandbox = new AclSandbox({ writableDirs: [workspaceRoot], writeSid: workspaceWriteSid(workspaceRoot), mode: 'workspace-write' })
await sandbox.init() // throws on ANY Win32 failure — never spawns unrestricted

const child = sandbox.spawn({ command: 'pwsh', args: ['-NoProfile', '-Command', '...'], cwd: workspaceRoot })
const { stdout, stderr, exitCode } = await child.wait()

sandbox.dispose() // revokes the revocable (temp) grant, keeps the standing workspace ACE; reports every cleanup failure
```

A direct `AclSandbox` grants the workspace ACEs STANDING (dispose() leaves them — they are the cross-instance reuse cache) and the temp ACE revocably (dispose() revokes it, so an inheritable ACE never outlives the instance on the ambient temp root). The server-side reuse is the `AclWriteGrant` class: `add(path, standing)` per directory, `dispose()` revokes the revocable paths and frees the SID — see the runner contract below. Every Win32 API call in this package is checked; failures throw `Win32Error` carrying the API name, the exact Win32 code, the `FormatMessageW` system text, and the failing path/context. This is deliberate: the POC ignored every return value and, when `CreateRestrictedToken` failed, silently ran the child with the FULL unrestricted token (fail-open). This port fails closed by construction.

## The confinement runner

The seam-facing shape is the **runner entry** (`./runner`), the argv-prefix wrapper `@deepseek-ai/dsh-sandbox-local` spawns in place of the caller's command — the same architecture as bwrap/landlock-run/sandbox-exec, so the sandbox seam's `confine()` contract needs no change. Stable argv contract:

```sh
node runner.js --workspace <dir> --temp <dir> --mode <read-only|workspace-write> [--write-sid <S-1-4-…>] -- <argv...>
```

The runner creates the restricted token, spawns the wrapped argv under it with the caller's stdio passed straight through (the caller's pipes, made inheritable around the spawn — Node clears stdio inheritability at startup, which raw spawns must compensate for), wraps the child in a `KILL_ON_JOB_CLOSE` job (a dead runner kills the child), ignores its own console Ctrl+C so the child handles its own, mirrors the child's exit code, and revokes its temp grant on exit (workspace ACEs stand). Every runner-side failure prints `windows-acl-run: <detail>` to stderr and exits 127 — the seam's `RUNNER_FAILURE_RULES` match that signature, so a runner refusal is never mistaken for a denial.

**Workspace grant reuse** (`--write-sid`): the write SID is DERIVED from the workspace path — no SID is stored anywhere (the previous per-session random SID and its tamper surface are gone). The seam still provisions ONE log-only `sandbox/acl-session` event per session (bound to the owning session id, validated at the fold) carrying the session's workspace binding and PRIVATE temp subdirectory: a resumed session replays the same temp dir, a fork mints a fresh one. The seam materializes the workspace ACE STANDING (once per workspace per server lifetime, never revoked — it is the reuse cache) and the temp ACE revocably (revoked on provider dispose), both lazily at the session's first confined execution. A fresh provision kicks an IMMEDIATE persistence flush right after the append (no write-behind debounce), so the record is durable within the flush latency — a crash inside that window can strand the private temp directory unrecorded, the one documented self-healing gap (the spawn seams are synchronous, so no await barrier exists between record and ACEs). Under `--write-sid` the runner neither grants nor revokes (`manageDacls: false`) — the flag's presence marks the seam-managed contract, its value is the derived SID; without it (standalone use) the runner self-manages with the SAME derived SID (workspace ACEs standing, temp ACE revocable per call). Re-granting after a restart is idempotent: `grantWrite` reads the current DACL and SKIPS the `SetNamedSecurityInfoW` apply when the exact ACE already stands (that apply eagerly re-propagates the identical ACE across the whole tree — minutes on large workspaces). Standing ACEs from an unclean shutdown need no garbage collection — they ARE the cache; the same derived SID re-hits them forever. Known cost: materializing the grant on a big workspace tree blocks for the full eager propagation once per workspace per machine (the first confined write ever on this host).

Modes (the token's restricting-SID list follows the mode; the keep-alive group is logon SID + Everyone in BOTH modes — early DLL init dies with `0xC0000142` and CNG crashes pwsh with `0xE0434352` without them):
- `workspace-write` (logon SID, Everyone, write SID): the workspace and the session's PRIVATE temp subdirectory carry the write-SID Write grant; every other write is denied by the token intersection.
- `read-only` (logon SID, Everyone — NO write SID): STRICT zero grants — nothing is writable. The write SID stays OUT of the list on purpose: the standing workspace grant ACE from an earlier workspace-write period (a `/permission` downgrade, or a crash-resumed session) remains INERT under read-only because the write-restricted pass-2 check grants only what the restricting list carries — while the standing ACE keeps the re-upgrade free of re-propagation. The NUL device is a securable object and is NOT granted (unlike Linux's `/dev/null` sink): `Set-Content NUL` and native `> NUL` writes fail with access denied, while PowerShell's `> $null` redirection keeps working (it discards without opening NUL).

Authenticated Users is absent from BOTH lists — the WMI namespace security check fails (`0x80041003`), so CIM cmdlets and `Get-ComputerInfo` (which silently returns incomplete results rather than an error) are unavailable in EVERY confined mode, and the C:\-root tree-creation escape (standing `AU:(AD)` + `AU:(OI)(CI)(IO)(M)` ACEs) is closed in both — the model-facing surface documents that contract, not a prompt promise. INTERACTIVE/LOCAL are absent from BOTH lists too: the host's Public tree grants write to INTERACTIVE, so Public writes are denied — pinned by the runner's ambient-writable Public-probe regression (see the design note).

The `AclSandbox` class (`tempDir: null` disables the temp grant) remains the programmatic API for direct spawns; `AclWriteGrant` is the server-side materialization half of the grant lifecycle.

## Header verification

All constants, signatures, and struct layouts were verified against the Windows headers on the development machine (MinGW `winnt.h` / `accctrl.h` / `aclapi.h` / `securitybaseapi.h` / `sddl.h` / `processthreadsapi.h` / `fileapi.h` / `namedpipeapi.h` / `synchapi.h` / `winbase.h`) and are cross-checked at runtime by [`verify/abi-probe.cpp`](verify/abi-probe.cpp) (sizes, offsets, enum values, static asserts):

```sh
g++ -std=c++20 -municode -O2 -o abi-probe.exe verify/abi-probe.cpp -ladvapi32 && ./abi-probe.exe
```

The koffi struct definitions assert their sizes against the probe at module load, so a header/koffi layout drift fails loudly instead of corrupting memory.

## Verified boundaries (inherent to restricted tokens, not this port)

- **Writes are restricted; reads, network, and process visibility are not.** `WRITE_RESTRICTED` intersects write accesses only, so a confined child can read any caller-readable file and open sockets. `read-only` mode therefore cannot be expressed by this mechanism alone; pair it with a read-side policy or an AppContainer/`S-1-15-2` capability token for stronger confinement.
- **Console isolation is unavailable.** Under the restricted token, children created with `CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE` die during DLL initialization with `STATUS_DLL_INIT_FAILED` (`0xC0000142`). The POC tried to fix this by adding the console logon SID (`S-1-2-1`) to the restricting list; on Windows 11 26200 `CreateWellKnownSid(WinLocalLogonSid)` fails with `ERROR_INVALID_PARAMETER` (87), the correct `WinConsoleLogonSid` yields a valid `S-1-2-1` but the child still dies, and the POC's final revision removed both the SID and console isolation. Children therefore share the host console; stdio redirection is pipe-based and unaffected.
- **ACL grants are standing directory mutations.** They persist if the process dies mid-run; workspace ACEs are standing BY DESIGN (never revoked — the reuse cache), temp ACEs are revoked by `dispose()` (`init()` also revokes an already-applied temp grant when a later step fails). The POC's documented manual cleanup (`icacls <dir> /remove '*S-1-4-…'`) fails on this platform with `ERROR_NONE_MAPPED` (1332) — revoke through this module instead. An unclean shutdown needs no self-healing for the workspace ACE: the derived SID re-hits the standing ACE on the next provision (skipping the apply); the write-SID ACE never accumulates a second identity per restart because the identity IS the workspace.
- **Granted directories must be caller-owned.** The owner's implicit `WRITE_DAC` is what lets the sandbox edit the DACL without elevation.
- **The temp grant follows `GetTempPathW`** — pass `tempDir` explicitly whenever possible. `GetTempPathW` reads the NATIVE environment block, which host runtimes that manage `process.env` through worker pools may not keep in sync (verified with vitest: a worker-side `process.env.TMP` change never reached the native block). The seam passes the session's PRIVATE subdirectory (`<temp>\dsh-<16 random hex>`, created exclusively — a pre-existing entry or reparse point fails loudly); a defaulted grant landing on the real temp dir inherits `(OI)(CI)` over every subdirectory of temp, silently widening the allowlist — point it at a per-sandbox directory instead.
- **The confined child's temp root is private per session** (workspace-write + `--write-sid`): the runner rewrites TMP/TEMP via `SetEnvironmentVariableW` to the session's private subdirectory before the spawn and the child inherits the rewritten block (bwrap `--tmpfs /tmp` semantics). Read-only leaves the ambient temp entries untouched — writes there are denied anyway. The subdirectory itself is plain `%TEMP%` litter with no garbage collection: OS temp hygiene reclaims it, and the record's determinism lets a later resume reuse it.
- **`whoami` and token-inspection cmdlets fail under the restricted token.** `GetTokenInformation` on the duplicate is partially unavailable to the child, so `whoami /all` reports errors — diagnostic noise of the restriction scheme, not an operational failure; the denial surfaces that matter (file writes) are unaffected.

## Model Experience

Indirectly, through [`dsh-bash-sandbox`](../../bash/bash-sandbox/README.md), [`dsh-pwsh-sandbox`](../../bash/pwsh-sandbox/README.md), and their tools, which render this backend's enforcement and denial facts (the confined stderr the tool layer classifies through `denialSignatures`) while the [`dsh-sandbox`](../sandbox/README.md) seam owns the `SANDBOX_UNAVAILABLE` text and runner selection.

#### KV Cache effect

None directly; the denial surface belongs to the tool layer.

## Known Limitations and Deferred Work

- **One write allowlist per workspace** — the write SID is the unit of the allowlist and IS the workspace identity; reusing one sandbox instance across two workspaces widens both grants to both roots (the same SID would then name two roots). Create one instance per workspace root — the seam does exactly this, keyed by the workspace path.
- **Cleanup is best-effort by design** — `dispose()` attempts every temp revocation and aggregates failures into an `AggregateError`; a cleanup failure leaves a standing (but write-SID-only) temp ACE that this process's next `init()`/`dispose()` cycle or `icacls` (via the ACE, not the trustee name) can still remove.
- **Standing workspace ACEs are invisible residue.** Renaming a workspace derives a new SID; the old ACEs on the old path stay (inert, write-SID-only). A future cleanup command may reap them; nothing re-propagates because of them.
- **NULL-DACL directories are not identity-preserving under grant+revoke.** A directory with a NULL DACL (rare — Windows-created directories carry real DACLs) means "everyone full control"; `grantWrite` builds the new ACL from that null, and the revoke round-trip leaves an EMPTY (deny-all) DACL rather than the original NULL DACL. The POC shares the behavior; real workspace and temp directories carry real DACLs, so this stays a documented edge rather than a guarded path.
- **Grant materialization is an eager full-tree propagation.** `SetNamedSecurityInfoW` on a directory with inheritable ACEs walks every descendant immediately (NOT lazily per access — measured at tens of seconds on large workspace trees plus the real temp root). The per-workspace identity pays it once per workspace per machine (lazily at the first confined execution ever, skipped entirely on every later provision when the exact ACE stands). If a workspace is huge, the first confined write on this host is correspondingly slow.
- **Resuming one session concurrently in two server processes races the record.** The durable record lives in the session log; both processes read or provision it independently — the derived write SID is identical, the per-path lock keeps the DACL merges consistent, and the private temp dir race resolves by the last-written record winning for future resumes. Single-writer session usage (the normal deployment) never sees this.
- **Read-side confinement and network policy are out of scope** — `WRITE_RESTRICTED` intersects write accesses only; pair this backend with a read-side policy for stronger confinement.
- **Wide-directory and FAT-volume warnings are deferred; FAT-class targets stay writable.** The UI-side warnings for granting unusually wide directories or FAT-class (non-ACL) volumes are not yet implemented, and a FAT volume as a grant ROOT simply fails the grant loudly (no ACL support). A FAT-class target OUTSIDE the granted roots is different: it has no security descriptors, so the restricted token's write check passes (Everyone sits in both lists) and such targets are writable under BOTH confined modes. FAT is treated as a legacy residue — unsupported and not engineered around; this warn-only posture is documented here rather than mitigated.
- **Both confined modes run `pwsh` in ConstrainedLanguage.** The restricted token trips PowerShell's lockdown detection, so under `read-only` AND `workspace-write` the language mode is ConstrainedLanguage: `Add-Type` (C# compile, P/Invoke), non-core .NET static calls (`[System.IO.*]::`, `[math]::`, `[Environment]::`), COM objects, and reflection fail with `Cannot create type` / `Cannot invoke method` ("only core types") errors, and `$ExecutionContext.SessionState.LanguageMode = 'FullLanguage'` is refused. Core cmdlets, core types (`[string]`, `[datetime]`, `[regex]`, `[guid]`), `-f` formatting, and property access keep working. The `pwsh` tool description teaches this contract to the model; `danger-full-access` calls run unconfined at FullLanguage.
