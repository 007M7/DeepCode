# Agent Note: Windows sandbox rung: raw ACL restricted tokens over mxc and AppContainer

Status: implemented

English | [中文](2026-08-08-windows-acl-restricted-token-sandbox.zh.md)

## Problem

The [sandbox decision](2026-07-06-sandbox.md) leaves `PLATFORM_CHAINS.win32` empty, so shipped Windows profiles degrade to danger-full-access because no confining executor exists. The win32 rung must confine the two file-effect modes the sandbox vocabulary promises — `read-only` (zero writes) and `workspace-write` (writes under the workspace root plus a backend-defined temp area) — while leaving reads, network, and process visibility alone, because every mode permits reading.

## Decision

Implement the rung directly on the raw ACL mechanism: duplicate the caller's token into a `WRITE_RESTRICTED` token (`CreateRestrictedToken` with `WRITE_RESTRICTED` + `DISABLE_MAX_PRIVILEGE` + `LUA_TOKEN`) whose restricting SIDs include a per-instance orphan SID (`S-1-4-x-y`); the orphan SID's Write ACEs on the workspace and temp roots are the entire write allowlist, because `WRITE_RESTRICTED` intersects write accesses only and reads keep the caller's full ambient access. The mechanism is the one huoyaoyuan/windows-acl-restrict-poc (`10e4dfb`) demonstrates; this port checks every API call and fails closed (the POC fail-opened on every ignored return value). It ships as [`@deepseek-ai/dsh-sandbox-windows-acl`](../../../../packages/sandbox/sandbox-windows-acl/README.md) (backend plus the `./runner` argv-prefix entry), the `win32` chain rung of [`dsh-sandbox-local`](../../../../packages/sandbox/sandbox-local/README.md), and [`@deepseek-ai/dsh-pwsh-sandbox`](../../../../packages/bash/pwsh-sandbox/README.md) as the confining executor; the Windows platform layer re-enables the full permission surface (sandbox/sandbox-policy/permission/approval/fs-sandbox) over the confined pwsh stack.

## Alternatives considered

### Why not mxc (Microsoft xContainer)?

Two disqualifiers. First, the OS floor is too new: the [mxc OS-version policy](https://github.com/microsoft/mxc/blob/main/docs/process-container/os-version-support.md) sets the product floor at Windows 11 24H2 (build 26100), and the BaseContainer tier (T1, `Experimental_CreateProcessInSandbox`) exists only on 25H2+ (build 26600+) with the OS feature enabled — on every supported release at or below 25H2 the filesystem policy falls back to T3, AppContainer plus host-side DACL ACE augmentation. Second, supporting arbitrary-path reads under either tier means granting read access by writing ACLs over every path the child may read: a model that reads the whole workspace and arbitrary files would require wholesale host DACL mutation — a standing side effect and a cost a write-only restriction does not need.

### Why not AppContainer?

An AppContainer token carries no ambient read access: every readable path must be pre-granted through capabilities or explicit ACEs, so arbitrary-path reads — the harness's read model — are unsupported without the same wholesale grants. The restricted token needs no read grants at all: it intersects write access only.

### Why not landstrip?

The [landstrip evaluation](../../rejected/feature/2026-07-26-evaluate-landstrip-for-windows-sandbox-rung.md) was rejected before implementation (not battle-tested; the in-house launcher plan won), and its Windows backend is AppContainer-shaped, inheriting the same arbitrary-read problem.

## Consequences

Bought: write-only confinement with no new OS floor (`CreateRestrictedToken` predates the mxc releases by two decades), reads/network/process visibility untouched exactly as the mode vocabulary requires, and fail-closed errors carrying the API name and the exact Win32 code. Cost: no read-side or network isolation; console isolation unavailable (hidden-console children die with `STATUS_DLL_INIT_FAILED`; children share the host console); standing ACE mutations on the granted roots (caller-owned directories, revoked by `dispose()`); the workspace-write temp grant is the real temp directory — the same backend-defined choice the Landlock rung makes.

## Related

The [pwsh executor decision](2026-08-01-pwsh-tool-and-executor.md) owns the pwsh-sandbox/tool-pwsh dialect split this rung consumes.
