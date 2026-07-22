# dsh-sandbox-policy — the sandbox policy home (`ctx.sandboxPolicy`)

The single owner of sandbox-policy resolution: the deployment's default [`SandboxMode`](../sandbox/README.md) and fallback root, plus each session's durable mode override and immutable workspace root. Every enforcing capability family receives one resolved mode-and-root policy per call.

## Why a shared home

Two families enforce the same mode vocabulary: the sandboxed bash executor (`@deepseek-ai/dsh-bash-sandbox`) and the sandboxed filesystem provider (`@deepseek-ai/dsh-fs-sandbox`). If each resolved its own `mode` + `workspaceRoot`, the two could drift into a split world — bash confined to one root while fs fences another, exactly what [the sandbox RFC](../../../.agents/notes/implemented/feature/2026-07-06-sandbox.md) warns against. Both tool layers resolve policy through `ctx.sandboxPolicy`, and both enforcing backends consume that complete per-call result. The [cross-family fs sandbox RFC](../../../.agents/notes/implemented/feature/2026-07-14-cross-family-fs-sandbox.md) records the shared-policy decision.

## Config

- `mode` — the deployment default `SandboxMode` (`read-only` / `workspace-write` / `danger-full-access`), validated at load. Default `read-only` (fail-safe).
- `workspaceRoot` — the fallback directory `workspace-write` may write under for agentless calls or sessions without a cwd. Default `process.cwd()`, resolved to its absolute filesystem identity either way. A normal agent call uses its session header's immutable `cwd` instead.

## Surface

- `ctx.sandboxPolicy.resolve({ session?, mode? })` — resolves one complete per-call policy. An explicit approved mode outranks the session's last `sandbox/mode` event, which outranks `defaultMode`; the session's immutable `cwd` is canonicalized with filesystem semantics before becoming `workspaceRoot`, otherwise the configured fallback applies. Canonicalization precedes lexical normalization so `symlink/..` agrees with process working-directory resolution.
- `ctx.sandboxPolicy.defaultMode` / `ctx.sandboxPolicy.workspaceRoot` — the deployment default and fallback root used by `resolve()`.
- `effectiveSandboxMode(events)` — the pure fold of a session's `sandbox/mode` events (the last switch wins, or `undefined`), used inside `resolve()`.
- `setSandboxMode(session, mode)` — THE write path for a per-session override: appends exactly one `sandbox/mode` event. The switch IS its event; nothing mutates the mode out of band.
- `SANDBOX_MODES` — every mode, for option advertisement and runtime validation.

The optional `./invariant` companion rejects a forged durable `sandbox/mode` event whose value falls outside that closed vocabulary; Session and its companion own the surrounding storage and turn-enclosure rules.

## The per-session store

A runtime switch (an ACP `session/set_config_option`, a test scenario) is one log-only `sandbox/mode` event on the session it applies to. `effective = explicit grant ?? fold(events) ?? deployment default`, so an override survives restart by replay and two sessions never see each other's state. Workspace identity does not need another event: the immutable `SessionHeader.cwd` recorded at creation is the root for every call in that session. The event is log-only (the `approval/*` precedent): the model learns the mode from the enforcing tools' denial markers, never from the event.

## Model Experience

Indirectly, through `dsh-tool-bash` and `dsh-tool-fs`, which render the effective mode this service holds in their `[sandbox: …]` denial markers and escalation prompts; the `sandbox/mode` event itself never reaches the model.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes, and the mode is deliberately absent from the prompt.

## Known Limitations and Deferred Work

- **One primary workspace root per session** — policy resolves `SessionHeader.cwd`; extra writable roots are not part of `SandboxExecutionPolicy`.
- **File-effect modes only** — `SandboxMode` governs file effects; network and process policy are outside its vocabulary, so no knob here restricts them.
