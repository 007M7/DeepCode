# dsh-sandbox-policy — the sandbox policy home (`ctx.sandboxPolicy`)

English | [中文](README.zh.md)

The single owner of sandbox-policy resolution: the deployment's default [`SandboxMode`](../sandbox/README.md) and fallback root, plus each session's durable mode override and immutable workspace root. Every enforcing family receives one resolved mode-and-root policy per call and registers whether the current runtime fences filesystem tools, one-shot bash commands, or terminal sessions; the model receives only those current facts before each request.

## Why a shared home

Filesystem tools, one-shot bash commands, and terminal sessions may enforce the same mode vocabulary in different combinations. If each resolved its own `mode` + `workspaceRoot`, they could drift into a split world, exactly what [the sandbox Agent Note](../../../.agents/notes/implemented/feature/2026-07-06-sandbox.md) warns against. Each enforcing backend consumes the complete owner-resolved policy and contributes its model-facing family; the current section therefore does not claim that an unfenced family shares another family's restrictions. The [cross-family fs sandbox Agent Note](../../../.agents/notes/implemented/feature/2026-07-14-cross-family-fs-sandbox.md) records the shared-policy decision.

## Config

- `mode` — the deployment default `SandboxMode` (`read-only` / `workspace-write` / `danger-full-access`), validated at load. Default `read-only` (fail-safe).
- `workspaceRoot` — the fallback directory `workspace-write` may write under for agentless calls or sessions without a cwd. Default `process.cwd()`, resolved to its absolute filesystem identity either way. A normal agent call uses its session header's immutable `cwd` instead.

## Surface

- `ctx.sandboxPolicy.resolve({ session?, mode? })` — resolves one complete per-call policy. An explicit approved mode outranks the session's last `sandbox/mode` event, which outranks `defaultMode`; the session's immutable `cwd` is canonicalized with filesystem semantics before becoming `workspaceRoot`, otherwise the configured fallback applies. Canonicalization precedes lexical normalization so `symlink/..` agrees with process working-directory resolution.
- `ctx.sandboxPolicy.defaultMode` / `ctx.sandboxPolicy.workspaceRoot` — the deployment default and fallback root used by `resolve()`.
- `ctx.sandboxPolicy.registerEnforcedFamily(family)` — independently registers `filesystem`, `bash`, or `terminal` and returns the exact effect disposer. Equal families remain separate contributions; the section uses canonical family order and removes a family only after its final contribution leaves.
- `sandbox:policy` — a request-time system-prompt section derived from `resolve({ session })` and the active family contributions. It is empty without an enforcing family and states only the mode, the affected model-facing operations, and the canonical session workspace under `workspace-write`.
- `effectiveSandboxMode(events)` — the pure fold of a session's `sandbox/mode` events (the last switch wins, or `undefined`), used inside `resolve()`.
- `setSandboxMode(session, mode)` — THE write path for a per-session override: appends exactly one `sandbox/mode` event. The switch IS its event; nothing mutates the mode out of band.
- `SANDBOX_MODES` — every mode, for option advertisement and runtime validation.

The optional `./invariant` companion rejects a forged durable `sandbox/mode` event whose value falls outside that closed vocabulary; Session and its companion own the surrounding storage and core execution-enclosure rules. The rendered section is logged inside `request/header`, so the exact effective policy remains reconstructable without another event or an in-memory “last told” mirror.

## The per-session store

A runtime switch is one log-only `sandbox/mode` event on the session it applies to. `effective = explicit grant ?? fold(events) ?? deployment default`, so an override survives restart by replay and two sessions never see each other's state. Workspace identity does not need another event: the immutable `SessionHeader.cwd` recorded at creation is the root for every call in that session. The event stays log-only; the next request assembles the current section from the fold before any tool call.

## Model Experience

### Current file sandbox policy

#### What the model sees

One `sandbox:policy` system section on each agent request when at least one enforcing family is registered. The examples below show all three families; absent families are omitted. Tool plugins retain operation and escalation guidance, approval policy remains `dsh-user-approval`'s section, and plan guidance remains `dsh-plan-mode`'s section.

##### Read-only

```markdown
Current DSH file policy: read-only. The write and edit tools, one-shot bash commands, and terminal sessions cannot modify files under this policy.
```

##### Workspace-write

```markdown
Current DSH file policy: workspace-write. The write and edit tools, one-shot bash commands, and terminal sessions may modify files under the session workspace: "<workspace root>". Some platform temporary areas may also be writable.
```

##### Danger-full-access

```markdown
Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict the write and edit tools, one-shot bash commands, or terminal sessions.
```

#### Token effect

One concise system section per request. `workspace-write` carries only the canonical session workspace path; platform-specific temporary paths are summarized without adding host-dependent bytes.

#### KV Cache effect

The request prefix is byte-stable while the session mode and immutable workspace root stay unchanged. A mode switch changes the section on the next request; the resulting `request/header` records the new prefix.

## Known Limitations and Deferred Work

- **One primary workspace root per session** — policy resolves `SessionHeader.cwd`; extra writable roots are not part of `SandboxExecutionPolicy`.
- **File-effect modes only** — `SandboxMode` governs file effects; network and process policy are outside its vocabulary, so no knob here restricts them.
- **Temporary areas are deliberately summarized** — enforcing backends grant different platform temporary areas, which are selected after policy resolution and therefore cannot be enumerated truthfully in the standing section.
