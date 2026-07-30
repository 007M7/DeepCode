# dsh-sandbox-policy — the sandbox policy home (`ctx.sandboxPolicy`)

English | [中文](README.zh.md)

The single owner of sandbox-policy resolution: the deployment's default [`SandboxMode`](../sandbox/README.md) and fallback root, plus each session's durable mode override and immutable workspace root. Every enforcing capability family receives one resolved mode-and-root policy per call, and the model receives that same effective policy before each request.

## Why a shared home

Two families enforce the same mode vocabulary: the sandboxed bash executor (`@deepseek-ai/dsh-bash-sandbox`) and the sandboxed filesystem provider (`@deepseek-ai/dsh-fs-sandbox`). If each resolved its own `mode` + `workspaceRoot`, the two could drift into a split world — bash confined to one root while fs fences another, exactly what [the sandbox RFC](../../../.agents/notes/implemented/feature/2026-07-06-sandbox.md) warns against. Both tool layers resolve policy through `ctx.sandboxPolicy`, and both enforcing backends consume that complete per-call result. The [cross-family fs sandbox RFC](../../../.agents/notes/implemented/feature/2026-07-14-cross-family-fs-sandbox.md) records the shared-policy decision.

## Config

- `mode` — the deployment default `SandboxMode` (`read-only` / `workspace-write` / `danger-full-access`), validated at load. Default `read-only` (fail-safe).
- `workspaceRoot` — the fallback directory `workspace-write` may write under for agentless calls or sessions without a cwd. Default `process.cwd()`, resolved to its absolute filesystem identity either way. A normal agent call uses its session header's immutable `cwd` instead.

## Surface

- `ctx.sandboxPolicy.resolve({ session?, mode? })` — resolves one complete per-call policy. An explicit approved mode outranks the session's last `sandbox/mode` event, which outranks `defaultMode`; the session's immutable `cwd` is canonicalized with filesystem semantics before becoming `workspaceRoot`, otherwise the configured fallback applies. Canonicalization precedes lexical normalization so `symlink/..` agrees with process working-directory resolution.
- `ctx.sandboxPolicy.defaultMode` / `ctx.sandboxPolicy.workspaceRoot` — the deployment default and fallback root used by `resolve()`.
- `sandbox:policy` — a request-time system-prompt section derived from `resolve({ session })`. It states the current file-effect mode, its consequences, and every canonical writable root under `workspace-write`; it does not claim host permissions, sandbox-backend readiness, or network/process restrictions.
- `effectiveSandboxMode(events)` — the pure fold of a session's `sandbox/mode` events (the last switch wins, or `undefined`), used inside `resolve()`.
- `setSandboxMode(session, mode)` — THE write path for a per-session override: appends exactly one `sandbox/mode` event. The switch IS its event; nothing mutates the mode out of band.
- `SANDBOX_MODES` — every mode, for option advertisement and runtime validation.

The optional `./invariant` companion rejects a forged durable `sandbox/mode` event whose value falls outside that closed vocabulary; Session and its companion own the surrounding storage and core execution-enclosure rules. The rendered section is logged inside `request/header`, so the exact effective policy remains reconstructable without another event or an in-memory “last told” mirror.

## The per-session store

A runtime switch is one log-only `sandbox/mode` event on the session it applies to. `effective = explicit grant ?? fold(events) ?? deployment default`, so an override survives restart by replay and two sessions never see each other's state. Workspace identity does not need another event: the immutable `SessionHeader.cwd` recorded at creation is the root for every call in that session. The event stays log-only; the next request assembles the current section from the fold before any tool call.

## Model Experience

### Current file sandbox policy

#### What the model sees

One `sandbox:policy` system section on every agent request. The section states only DSH file-effect policy; tool schemas remain their owners' surfaces, approval policy remains `dsh-user-approval`'s section, and plan guidance remains `dsh-plan-mode`'s section.

##### Read-only

```markdown
Current DSH file sandbox policy: read-only. Ordinary file writes, edits, and file-mutating shell effects are denied; required sinks such as `/dev/null` may remain writable. Host OS permissions and sandbox-backend availability may restrict operations further. This policy does not govern network or process access.
```

##### Workspace-write

```markdown
Current DSH file sandbox policy: workspace-write. File writes, edits, and file-mutating shell effects are limited to these canonical writable roots: "<workspace root>", "<temporary root>". Host OS permissions and sandbox-backend availability may restrict operations further. This policy does not govern network or process access.
```

##### Danger-full-access

```markdown
Current DSH file sandbox policy: danger-full-access. The DSH file sandbox does not restrict file operations. Host OS permissions and other policies still apply. This policy does not govern network or process access.
```

#### Token effect

One concise system section per request. `workspace-write` additionally lists the canonical session workspace root plus the canonical `/tmp` and platform temporary roots, deduplicated when they identify the same directory.

#### KV Cache effect

The request prefix is byte-stable while the session mode and immutable workspace root stay unchanged. A mode switch changes the section on the next request; the resulting `request/header` records the new prefix.

## Known Limitations and Deferred Work

- **One primary workspace root per session** — policy resolves `SessionHeader.cwd`; extra writable roots are not part of `SandboxExecutionPolicy`.
- **File-effect modes only** — `SandboxMode` governs file effects; network and process policy are outside its vocabulary, so no knob here restricts them.
