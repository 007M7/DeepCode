# @deepseek-ai/dsh-sandbox-windows-acl

English | [中文](README.zh.md)

Windows write-restriction sandbox backend for the [harness sandbox seam](../sandbox/): a Node.js/[koffi](https://koffi.dev/) port of the mechanism in [huoyaoyuan/windows-acl-restrict-poc](https://github.com/huoyaoyuan/windows-acl-restrict-poc) (`10e4dfb`, the fixed revision), built as the preparation layer for a Windows `SandboxProvider` (`workspace-write` / `read-only` modes). Linux/macOS backends live in [`@deepseek-ai/dsh-sandbox-local`](../sandbox-local/).

Mechanism in one line: the caller's token is duplicated into a `WRITE_RESTRICTED` token whose restricting SIDs include an orphan SID (`S-1-4-x-y`) that only this sandbox instance has added to the workspace and temp directories' DACLs. Windows then grants a write only where BOTH the caller's normal access AND the restricting-SID intersection allow it — the orphan SID is the write allowlist, and it grants nothing anywhere else on the system.

## Usage

```ts
import { AclSandbox } from '@deepseek-ai/dsh-sandbox-windows-acl'

const sandbox = new AclSandbox({ writableDirs: [workspaceRoot] })
await sandbox.init() // throws on ANY Win32 failure — never spawns unrestricted

const child = sandbox.spawn({ command: 'pwsh', args: ['-NoProfile', '-Command', '...'], cwd: workspaceRoot })
const { stdout, stderr, exitCode } = await child.wait()

sandbox.dispose() // revokes all standing grants; reports every cleanup failure
```

Every Win32 API call in this package is checked; failures throw `Win32Error` carrying the API name, the exact Win32 code, the `FormatMessageW` system text, and the failing path/context. This is deliberate: the POC ignored every return value and, when `CreateRestrictedToken` failed, silently ran the child with the FULL unrestricted token (fail-open). This port fails closed by construction.

## The confinement runner

The seam-facing shape is the **runner entry** (`./runner`), the argv-prefix wrapper `@deepseek-ai/dsh-sandbox-local` spawns in place of the caller's command — the same architecture as bwrap/landlock-run/sandbox-exec, so the sandbox seam's `confine()` contract needs no change. Stable argv contract:

```sh
node runner.js --workspace <dir> --temp <dir> --mode <read-only|workspace-write> -- <argv...>
```

The runner creates the restricted token, spawns the wrapped argv under it with the caller's stdio passed straight through (the caller's pipes, made inheritable around the spawn — Node clears stdio inheritability at startup, which raw spawns must compensate for), wraps the child in a `KILL_ON_JOB_CLOSE` job (a dead runner kills the child), ignores its own console Ctrl+C so the child handles its own, mirrors the child's exit code, and revokes all grants on exit. Every runner-side failure prints `windows-acl-run: <detail>` to stderr and exits 127 — the seam's `RUNNER_FAILURE_RULES` match that signature, so a runner refusal is never mistaken for a denial.

Modes:
- `workspace-write`: the workspace and temp directories carry the orphan-SID Write grant; every other write is denied by the token intersection.
- `read-only`: STRICT zero grants — nothing is writable. The NUL device is a securable object and is NOT granted (unlike Linux's `/dev/null` sink): `Set-Content NUL` and native `> NUL` writes fail with access denied, while PowerShell's `> $null` redirection keeps working (it discards without opening NUL). Documented behavior, not a prompt promise — the model-facing surface makes no sink claims for read-only mode.

The `AclSandbox` class (`tempDir: null` disables the temp grant) remains the programmatic API for direct spawns.

## Header verification

All constants, signatures, and struct layouts were verified against the Windows headers on the development machine (MinGW `winnt.h` / `accctrl.h` / `aclapi.h` / `securitybaseapi.h` / `sddl.h` / `processthreadsapi.h` / `fileapi.h` / `namedpipeapi.h` / `synchapi.h` / `winbase.h`) and are cross-checked at runtime by [`verify/abi-probe.cpp`](verify/abi-probe.cpp) (sizes, offsets, enum values, static asserts):

```sh
g++ -std=c++20 -municode -O2 -o abi-probe.exe verify/abi-probe.cpp -ladvapi32 && ./abi-probe.exe
```

The koffi struct definitions assert their sizes against the probe at module load, so a header/koffi layout drift fails loudly instead of corrupting memory.

## Verified boundaries (inherent to restricted tokens, not this port)

- **Writes are restricted; reads, network, and process visibility are not.** `WRITE_RESTRICTED` intersects write accesses only, so a confined child can read any caller-readable file and open sockets. `read-only` mode therefore cannot be expressed by this mechanism alone; pair it with a read-side policy or an AppContainer/`S-1-15-2` capability token for stronger confinement.
- **Console isolation is unavailable.** Under the restricted token, children created with `CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE` die during DLL initialization with `STATUS_DLL_INIT_FAILED` (`0xC0000142`). The POC tried to fix this by adding the console logon SID (`S-1-2-1`) to the restricting list; on Windows 11 26200 `CreateWellKnownSid(WinLocalLogonSid)` fails with `ERROR_INVALID_PARAMETER` (87), the correct `WinConsoleLogonSid` yields a valid `S-1-2-1` but the child still dies, and the POC's final revision removed both the SID and console isolation. Children therefore share the host console; stdio redirection is pipe-based and unaffected.
- **ACL grants are standing directory mutations.** They persist if the process dies mid-run; `dispose()` revokes them, and `init()` revokes already-applied grants when a later step fails. The POC's documented manual cleanup (`icacls <dir> /remove '*S-1-4-…'`) fails on this platform with `ERROR_NONE_MAPPED` (1332) — revoke through this module instead.
- **Granted directories must be caller-owned.** The owner's implicit `WRITE_DAC` is what lets the sandbox edit the DACL without elevation.
- **The temp grant follows `GetTempPathW`** — pass `tempDir` explicitly whenever possible. `GetTempPathW` reads the NATIVE environment block, which host runtimes that manage `process.env` through worker pools may not keep in sync (verified with vitest: a worker-side `process.env.TMP` change never reached the native block). A defaulted grant landing on the real temp dir inherits `(OI)(CI)` over every subdirectory of temp, silently widening the allowlist — point it at a per-sandbox directory instead.

## Known Limitations and Deferred Work

- **No `SandboxProvider` wiring yet** — this package is the primitives layer; the `ctx.sandbox.confine()` integration (spawn-side token application plus the `denialSignatures`/`runnerFailureRules` contract) is the next step and cannot reuse the argv-wrapping style of `dsh-sandbox-local` because the restricted token must be applied at `CreateProcess` time.
- **One write allowlist per instance** — the orphan SID is the unit of the allowlist; reusing one sandbox instance across two workspaces widens both grants to both roots. Create one instance per workspace root.
- **Cleanup is best-effort by design** — `dispose()` attempts every revocation and aggregates failures into an `AggregateError`; a cleanup failure leaves a standing (but orphan-SID-only) ACE that this process's next `init()`/`dispose()` cycle or `icacls` (via the ACE, not the trustee name) can still remove.
- **Read-side confinement, network policy, and job-object kill-on-close are out of scope** for this layer and belong to the future provider design.
