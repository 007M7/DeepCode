# @deepseek-ai/dsh-bash-sandbox

Sandbox-consuming implementation of the [`@deepseek-ai/dsh-bash`](../bash/) executor seam. Load it **instead of** `@deepseek-ai/dsh-bash-local`, together with a [`ctx.sandbox`](../../sandbox/sandbox/) provider (e.g. [`@deepseek-ai/dsh-sandbox-local`](../../sandbox/sandbox-local/)) — no alternate tool plugin is needed; `dsh-tool-bash` detects the executor's `sandboxMode` capability and adds the escalation fields.

The package root exports the default and named `SandboxBashExecutor` plugin plus its `Config`; quoting and result-classification helpers stay internal.

Every command is confined by handing the provider the exact `['bash', '-c', command]` argv this executor is about to spawn and spawning the returned (wrapped) argv instead. WHICH platform runner confines it — and whether one is usable at all (fail closed with a structured `SANDBOX_UNAVAILABLE` error, never a silent unconfined run) — is the provider's concern; this package owns the bash side only.

| Mode | File effects |
|---|---|
| `read-only` (default) | No writes anywhere (of `/dev`, only the `/dev/null` node is writable, so `>/dev/null` keeps working) |
| `workspace-write` | Writes only under `workspaceRoot` + `/tmp` (ephemeral under bwrap, the host `/tmp` under Landlock, `/private/tmp` plus the per-user temp dir under Seatbelt) |
| `danger-full-access` | No confinement; the provider is never consulted. Foreground results carry `sandbox: { mode, denied: false }`; background process handles carry no sandbox facts. |

Semantics:

- **Denials are result facts.** A failed run whose stderr carries the selected backend's own denial dialect — the signatures the provider stamps on every wrap (EROFS text under bwrap, EACCES under Landlock, EPERM under Seatbelt) — is reported as `BashRunResult.sandbox.denied: true` (conservative classification, read from the collected stderr tail); every CONFINED run also carries the mode it executed under (`result.sandbox.mode`) and the provider's enforcement completeness (`result.sandbox.enforcement`: `full`, or `partial` on an older Landlock ABI).
- **Runner failures are sandbox failures, never command failures.** Foreground execution throws `SANDBOX_UNAVAILABLE`; a settled background process stamps `process.sandbox.runnerFailed`, which the bash producer renders through generic `task_output`. Spawn failures also pass through settlement, so confined background handles retain their mode/enforcement facts and release per-process accounting.
- **Config-time default, per-call policy.** The DEFAULT mode is fixed by this entry's config for the executor's lifetime; `resolve()` stamps it onto every spec, and an explicit request-level `sandboxMode` override — set by the tool layer only for a call whose wider mode a human granted through `ctx.approval` ([the sandbox Agent Note § Escalation](../../../.agents/notes/implemented/feature/2026-07-06-sandbox.md)) — makes THAT call run, classify, and report under its own mode while every neighbor keeps the default (background facts are stamped per task at settle). The capability fact `ctx.bash.sandboxMode` reports the configured default so the tool layer advertises escalation only when this executor is mounted. The model learns of the sandbox only through result facts — the static bash tool description explains the denial marker; there is no current-mode statement in the system prompt.
- **File effects only.** Network and process visibility are deliberately not restricted — the mode vocabulary does not pretend to cover what the backend does not enforce.
- Process mechanics (spawn, process-group kills, output collection/spill, background handles, credential scrub) are inherited from [`dsh-bash-local`](../bash-local/); runner selection lives in [`dsh-sandbox-local`](../../sandbox/sandbox-local/).

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

The keyless consumer-integration proofs are `tests/bwrap.e2e.ts`, `tests/landlock.e2e.ts`, and `tests/seatbelt.e2e.ts` (the real provider + real runner driven through `ctx.bash`, world-verified, each self-skipping where its runner is absent); see [the acp-agent example's default composition](../../../examples/acp-agent/) for the runnable demo.

## Model Experience

### Bash tool schema, indirectly

#### What the model sees

The generated [`dsh-tool-bash` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-bash) are the baseline. By advertising a confining `sandboxMode`, this backend augments `bash` with `sandbox_permissions` using enum `workspace-write` | `danger-full-access` and with `justification`. The backend adds no prompt prose, and the session's effective mode remains unstated.

#### Token effect

Small fixed schema increment on requests where `bash` is visible; mode switches add no context tokens.

#### KV Cache effect

Prefix-stable while the executor advertises the same sandbox capabilities. Changing those capabilities alters the `bash` schema and may invalidate reuse from that definition; per-session mode switches do not.

### Bash tool result, indirectly

#### What the model sees

After ordinary bounded output, a denied call appends exactly `[sandbox: file access denied under <mode> mode]`. When escalation is available it next appends `[sandbox: escalation available — retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]`. A settled background runner failure instead appends `[sandbox: the sandbox runner itself failed under <mode> mode — the command did not run; this is a sandbox problem, not a command failure]`.

#### Token effect

Zero additional tokens on an unremarkable allowed run beyond ordinary output. Denial or failure adds the quoted conditional marker, retained until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Bash tool error, indirectly

#### What the model sees

If no runner can enforce a confined mode, the foreground call propagates the [`SANDBOX_UNAVAILABLE` error owned by `dsh-sandbox`](../../sandbox/sandbox/README.md#confinement-error-indirectly). For an execution-time runner failure, this backend supplies the first stderr line as its detail.

#### Token effect

Conditional error text is visible for that call and retained in history until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Confinement covers file effects only** — network access and process visibility are unchanged, so the modes are not a general-purpose security sandbox.
- **Denials are inferred from failed-command stderr** — backend signatures make the inference portable, but a matching application error can be classified as a denial and a denial omitted from the retained tail can be missed.
- **A background runner failure has no immediate error channel** — it is recorded on the settled process and surfaces when the caller reads the generic task with `task_output`.
- **`danger-full-access` deliberately bypasses `ctx.sandbox`** — it is an explicit unconfined mode, not a wider sandbox profile.
