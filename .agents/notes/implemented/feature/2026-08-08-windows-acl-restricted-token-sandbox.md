# Agent Note: Windows sandbox rung: raw ACL restricted tokens over mxc and AppContainer

Status: implemented

English | [中文](2026-08-08-windows-acl-restricted-token-sandbox.zh.md)

## Problem

The [sandbox decision](2026-07-06-sandbox.md) leaves `PLATFORM_CHAINS.win32` empty, so shipped Windows profiles degrade to danger-full-access because no confining executor exists. The win32 rung must confine the two file-effect modes the sandbox vocabulary promises — `read-only` (zero writes) and `workspace-write` (writes under the workspace root plus a backend-defined temp area) — while leaving reads, network, and process visibility alone, because every mode permits reading.

## Decision

Implement the rung directly on the raw ACL mechanism: duplicate the caller's token into a `WRITE_RESTRICTED` token (`CreateRestrictedToken` with `WRITE_RESTRICTED` + `DISABLE_MAX_PRIVILEGE` + `LUA_TOKEN`) whose restricting SIDs include a per-instance orphan SID (`S-1-4-x-y`); the orphan SID's Write ACEs on the workspace and temp roots are the entire write allowlist, because `WRITE_RESTRICTED` intersects write accesses only and reads keep the caller's full ambient access. The mechanism is the one huoyaoyuan/windows-acl-restrict-poc (`10e4dfb`) demonstrates; this port checks every API call and fails closed (the POC fail-opened on every ignored return value). It ships as [`@deepseek-ai/dsh-sandbox-windows-acl`](../../../../packages/sandbox/sandbox-windows-acl/README.md) (backend plus the `./runner` argv-prefix entry), the `win32` chain rung of [`dsh-sandbox-local`](../../../../packages/sandbox/sandbox-local/README.md), and [`@deepseek-ai/dsh-pwsh-sandbox`](../../../../packages/bash/pwsh-sandbox/README.md) as the confining executor; the Windows platform layer re-enables the full permission surface (sandbox/sandbox-policy/permission/approval/fs-sandbox) over the confined pwsh stack.

## How the restriction works (why no new identity)

The identity routes restrict by *who* runs the child; this rung restricts by *token derivation*. An identity route (landstrip's restricted-user, AppContainer) runs the child under a fresh account or container SID that starts with zero ACEs on the host's files — everything, reads included, defaults to denied, and every path the child may touch must then be opened back up by writing ACEs for that identity: the wholesale DACL mutation that disqualified both alternatives. The restricted token keeps the caller's own SID and logon session: [`CreateRestrictedToken`](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken) derives a token that adds the restricting SIDs and the `WRITE_RESTRICTED` flag, so Windows performs the access check twice — once against the normal SIDs, once against the restricting SIDs — and grants write-class access only where both checks pass. Reads pass on the normal check alone (the caller's SIDs already carry read access everywhere the caller can read), which is why this rung needs no read grants and no new account; writes must additionally clear the orphan-SID check, which only the workspace and temp ACEs satisfy. `DISABLE_MAX_PRIVILEGE | LUA_TOKEN` synthesize the limited-user effect of a fresh account token-side, so even an elevated caller derives a filtered token. The same primitive could restrict reads (`SidsToDisable` turning SIDs deny-only), but a read-restricted token would need per-path read grants — reintroducing exactly the cost the identity routes pay — and the sandbox vocabulary never requires read confinement.

## Alternatives considered

### Why not mxc (Microsoft xContainer)?

Two disqualifiers. First, the OS floor is too new: the [mxc OS-version policy](https://github.com/microsoft/mxc/blob/main/docs/process-container/os-version-support.md) sets the product floor at Windows 11 24H2 (build 26100), and the BaseContainer tier (T1, `Experimental_CreateProcessInSandbox`) exists only on 25H2+ (build 26600+) with the OS feature enabled — on every supported release at or below 25H2 the filesystem policy falls back to T3, AppContainer plus host-side DACL ACE augmentation. Second, supporting arbitrary-path reads under either tier means granting read access by writing ACLs over every path the child may read: a model that reads the whole workspace and arbitrary files would require wholesale host DACL mutation — a standing side effect and a cost a write-only restriction does not need.

### Why not AppContainer?

An AppContainer token carries no ambient read access: every readable path must be pre-granted through capabilities or explicit ACEs, so arbitrary-path reads — the harness's read model — are unsupported without the same wholesale grants. The restricted token needs no read grants at all: it intersects write access only.

### Why not landstrip?

The [landstrip evaluation](../../rejected/feature/2026-07-26-evaluate-landstrip-for-windows-sandbox-rung.md) was rejected before implementation (not battle-tested; the in-house launcher plan won), and its Windows backend is AppContainer-shaped, inheriting the same arbitrary-read problem.

## Consequences

Bought: write-only confinement with no new OS floor (`CreateRestrictedToken` predates the mxc releases by two decades), reads/network/process visibility untouched exactly as the mode vocabulary requires, and fail-closed errors carrying the API name and the exact Win32 code. Cost: no read-side or network isolation; console isolation unavailable (hidden-console children die with `STATUS_DLL_INIT_FAILED`; children share the host console); standing ACE mutations on the granted roots (caller-owned directories, revoked by `dispose()`); the workspace-write temp grant is the real temp directory — the same backend-defined choice the Landlock rung makes.

## Testing

The product-visible Windows roster flip is win32-only, so the keyless snapshot fixtures — which must replay on macOS/Linux — cannot cover it; the bundle composition specs ([`base.spec.ts`](../../../../packages/bundle/base/tests/base.spec.ts), [`windows-shell.spec.ts`](../../../../apps/cli/tests/windows-shell.spec.ts)) plus the win32 real-runner suites (`packages/sandbox/sandbox-windows-acl/tests/`, `packages/bash/pwsh-sandbox/tests/`) are the substitute evidence, and the CI Windows lane owns the assembled signal.

## Related

The [pwsh executor decision](2026-08-01-pwsh-tool-and-executor.md) owns the pwsh-sandbox/tool-pwsh dialect split this rung consumes.
