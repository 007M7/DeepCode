# @deepseek-ai/dsh-pwsh-sandbox

English | [中文](README.zh.md)

Sandbox-consuming PowerShell implementation of the [`ctx.bash` executor seam](../bash/): every command runs as `pwsh -NoLogo -NoProfile -NonInteractive -Command <command>` **confined through `ctx.sandbox`**, with the selected mode, enforcement, and denial facts stamped on each settled result. The pwsh twin of [`@deepseek-ai/dsh-bash-sandbox`](../bash-sandbox/), a call-for-call mirror per the [pwsh executor and tool decision](../../../.agents/notes/implemented/feature/2026-08-01-pwsh-tool-and-executor.md) — the confinement substance is platform-neutral: on Windows the sandbox seam resolves to the ACL restricted-token runner chain ([`@deepseek-ai/dsh-sandbox-windows-acl`](../../sandbox/sandbox-windows-acl/)), on Linux/macOS to bwrap/Landlock/Seatbelt.

The executor inherits [`@deepseek-ai/dsh-pwsh-local`](../pwsh-local/)'s process mechanics and consumes its argv-level seam (`argv()` / `runArgv()` / `startArgv()` / `onProcessDone()`) to wrap the exact pwsh invocation through the provider. The sandbox policy (mode + workspace root) is NOT this package's config: it rides each call from `ctx.sandboxPolicy` (tool calls pass the calling session's resolved policy; direct calls fall back to deployment policy).

## Behavior

- `danger-full-access`: commands run through the local executor unchanged; results carry `sandbox: { mode, denied: false }`.
- Confined modes (`read-only`, `workspace-write`): the pwsh argv is wrapped by `ctx.sandbox.confine()`; runner-launch refusal fails closed with `SANDBOX_UNAVAILABLE` (foreground throw, background `runnerFailed` fact), and a denied write classifies against the selected backend's `denialSignatures` into `sandbox.denied`.

## Model Experience

### Confinement works, denial surfaces as command failure

The model sees the confined command's own stderr (e.g. `Access to the path '...' is denied.` under the Windows ACL runner); the tool layer converts classified denials into the standard permission-denied surface exactly as it does for the bash tool.

## Known Limitations

- **Reads are unrestricted** on Windows (the ACL runner restricts writes only); the read boundary is documented in `@deepseek-ai/dsh-sandbox-windows-acl`.
- **The Windows workspace-write temp area is the real temp directory** (`GetTempPathW`). This is a deliberate backend-defined choice, the same decision Landlock makes (`readWrite: ['/tmp', ...]`): the seam's "backend-defined temp area" permits it, and the escape probe in `tests/acl.e2e.ts` lives outside the temp tree for exactly that reason. A per-run private temp (bwrap's `--tmpfs /tmp` semantics) would additionally need an environment-block rewrite in the runner; it is an optional future hardening, not a correctness gap.
- **Windows read-only is strict zero-grant** — not even the NUL device is writable; `> $null` redirection still works (documented in the backend package).
