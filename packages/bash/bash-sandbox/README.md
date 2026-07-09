# @deepseek-ai/dsh-bash-sandbox

Sandbox-consuming implementation of the [`@deepseek-ai/dsh-bash`](../bash/) executor seam. Load it **instead of** `@deepseek-ai/dsh-bash-local`, together with a [`ctx.sandbox`](../../sandbox/sandbox/) provider (e.g. [`@deepseek-ai/dsh-sandbox-local`](../../sandbox/sandbox-local/)) — the model-facing tool layer (`dsh-tool-bash`) is untouched; that swap is exactly what the seams exist for.

Every command is confined by handing the provider the exact `['bash', '-c', command]` argv this executor is about to spawn and spawning the returned (wrapped) argv instead. WHICH platform runner confines it — and whether one is usable at all (fail closed with a structured `SANDBOX_UNAVAILABLE` error, never a silent unconfined run) — is the provider's concern; this package owns the bash side only.

| Mode | File effects |
|---|---|
| `read-only` (default) | No writes anywhere (of `/dev`, only the `/dev/null` node is writable, so `>/dev/null` keeps working) |
| `workspace-write` | Writes only under `workspaceRoot` + `/tmp` (ephemeral under bwrap, the host `/tmp` under Landlock, `/private/tmp` plus the per-user temp dir under Seatbelt) |
| `danger-full-access` | No confinement; the provider is never consulted. Execution is `dsh-bash-local`'s verbatim — foreground results still carry `sandbox: { mode, denied: false }` (no `enforcement`: nothing was confined), background tasks carry no sandbox facts |

Semantics:

- **Denials are result facts.** A failed run whose stderr carries the selected backend's own denial dialect — the signatures the provider stamps on every wrap (EROFS text under bwrap, EACCES under Landlock, EPERM under Seatbelt) — is reported as `BashRunResult.sandbox.denied: true` (conservative classification, read from the collected stderr tail); every CONFINED run also carries the mode it executed under (`result.sandbox.mode`) and the provider's enforcement completeness (`result.sandbox.enforcement`: `full`, or `partial` on an older Landlock ABI).
- **Runner failures are sandbox failures, never task failures.** A failed run matching the wrap's `runnerFailureSignatures` (the runner's own error prefix — also what the shell prints for a missing runner) means the sandbox itself broke and the command NEVER RAN; the check outranks denial classification because a runner's error text can contain denial words. The foreground path re-throws it as the structured fail-closed `SANDBOX_UNAVAILABLE` error, with the runner's first stderr line as the cause; a settled background task stamps `task.sandbox.runnerFailed` instead (no error channel remains after settle), which `bash_output` renders as its own marker.
- **Config-time default, per-call policy.** The DEFAULT mode is fixed by this entry's config for the executor's lifetime; `resolve()` stamps it onto every spec, and an explicit request-level `sandboxMode` override — set by the tool layer only for a call whose wider mode a human granted through `ctx.approval` ([the sandbox RFC § Escalation](../../../docs/rfc/implemented/feature/2026-07-06-sandbox.md)) — makes THAT call run, classify, and report under its own mode while every neighbor keeps the default (background facts are stamped per task at settle). The capability fact `ctx.bash.sandboxMode` reports the configured default so the tool layer advertises escalation only when this executor is mounted. The model learns of the sandbox only through result facts — the static bash tool description explains the denial marker; there is no current-mode statement in the system prompt.
- **File effects only.** Network and process visibility are deliberately not restricted — the mode vocabulary does not pretend to cover what the backend does not enforce.
- Process mechanics (spawn, process-group kills, output collection/spill, background tasks, credential scrub) are inherited verbatim from [`dsh-bash-local`](../bash-local/); the runner ladder, probes, and the per-platform Landlock launcher packages live with [`dsh-sandbox-local`](../../sandbox/sandbox-local/).

Deny-only at the seam: a denial is a reported fact, and this executor never negotiates permissions itself — the approval question lives in the tool layer (`dsh-tool-bash`), which drives the override this package honors.

```yaml
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'
- id: bash
  name: '@deepseek-ai/dsh-bash-sandbox'
  config:
    mode: read-only
    workspaceRoot: !!js process.cwd()
```

The keyless consumer-integration proofs are `tests/bwrap.e2e.ts`, `tests/landlock.e2e.ts`, and `tests/seatbelt.e2e.ts` (the real provider + real runner driven through `ctx.bash`, world-verified, each self-skipping where its runner is absent); see [`examples/sandbox-acp-agent`](../../../examples/sandbox-acp-agent/) for the runnable demo.
