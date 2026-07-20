# dsh-sandbox-policy — the sandbox policy home (`ctx.sandboxPolicy`)

The single owner of the deployment's sandbox policy: the file-effect [`SandboxMode`](../sandbox/README.md) a session starts from, the `workspace-write` boundary root, and the per-session `sandbox/mode` override every enforcing capability family reads.

## Why a shared home

Two families enforce the same mode vocabulary: the sandboxed bash executor (`@deepseek-ai/dsh-bash-sandbox`) and the sandboxed filesystem provider (`@deepseek-ai/dsh-fs-sandbox`). If each held its own `mode` + `workspaceRoot` config, the two could drift into a split world — bash confined to one root while fs fences another, exactly what [the sandbox RFC](../../../.agents/notes/implemented/feature/2026-07-06-sandbox.md) warns against. Both inject `ctx.sandboxPolicy` and read the SAME default instead. The [cross-family fs sandbox RFC](../../../.agents/notes/implemented/feature/2026-07-14-cross-family-fs-sandbox.md) records the decision.

## Config

- `mode` — the deployment default `SandboxMode` (`read-only` / `workspace-write` / `danger-full-access`), validated at load. Default `read-only` (fail-safe).
- `workspaceRoot` — the absolute directory `workspace-write` may write under. Default `process.cwd()`, resolved absolute either way.

## Surface

- `ctx.sandboxPolicy.defaultMode` / `ctx.sandboxPolicy.workspaceRoot` — the deployment default the enforcing implementations read for their resolve fallback and boundary.
- `effectiveSandboxMode(events)` — the pure fold of a session's `sandbox/mode` events (the last switch wins, or `undefined`). The tool layers apply it to stamp each call, so neither the executor nor the provider depends on session events.
- `setSandboxMode(session, mode)` — THE write path for a per-session override: appends exactly one `sandbox/mode` event. The switch IS its event; nothing mutates the mode out of band.
- `SANDBOX_MODES` — every mode, for option advertisement and runtime validation.

## The per-session store

A runtime switch (an ACP `session/set_config_option`, a test scenario) is one log-only `sandbox/mode` event on the session it applies to. `effective = fold(events) ?? the deployment default`, so an override survives restart by replay, two sessions never see each other's state, and there is no external config store. The event is log-only (the `approval/*` precedent): the model learns the mode from the enforcing tools' denial markers, never from the event. Execution honors the fold in each tool layer, weakest-precedence beneath an escalation grant.

## Model Experience

Indirectly, through `dsh-tool-bash` and `dsh-tool-fs`, which render the effective mode this service holds in their `[sandbox: …]` denial markers and escalation prompts; the `sandbox/mode` event itself never reaches the model.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes, and the mode is deliberately absent from the prompt.

## Known Limitations and Deferred Work

- **`workspaceRoot` is process-wide and fixed for the service's lifetime** — a per-session workspace root is a deferred phase of the sandbox RFC; this package centralizing the root is its groundwork, not its design.
- **File-effect modes only** — `SandboxMode` governs file effects; network and process policy are outside its vocabulary, so no knob here restricts them.
