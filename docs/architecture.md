# DeepSeek Harness Architecture

English | [中文](architecture.zh.md)

**DeepSeek Harness SDK** uses Cordis: **everything is a plugin**, including the loop.

## Overview

Harnesses are [Cordis](cordis-primer.md) contexts whose packages contribute services, typed events, and disposable registrations.

`packages/core/` groups the default agent flow; capabilities remain plugins.

### Default Services

| ctx key | Package | Role |
|---|---|---|
| — | [`dsh-scope`](../packages/core/scope/README.md) | scoped-context registration and shared layer storage (library) |
| `ctx.sessions` | `dsh-session` | in-memory event-sourced sessions |
| `ctx.systemPrompt` | `dsh-system-prompt` | ordered prompt sections, tool schemas, and prompt variables |
| `ctx.tools` | `dsh-tools` | tool registry and [execution pipeline](tool-execution-pipeline.md) |
| `ctx.agents` | `dsh-agent` | live agents, delegated creation, `agent/*` events, and process-local initiator scope |
| `ctx.agentLoop` | `dsh-agent-loop` | concrete `Agent` driver |

### Capability Services

| ctx key | Package family | Role |
|---|---|---|
| `ctx.llm` | [`llm/`](../packages/llm/README.md) | adapter registry and streaming model calls |
| `ctx.tokenMeter` | [`llm/token-meter`](../packages/llm/token-meter/README.md) | singleton replay-aware request/surface pressure |
| `ctx.bash` | [`bash/`](../packages/bash/README.md) | foreground/background command execution |
| `ctx.pty` | [`pty/`](../packages/pty/README.md) | owner-scoped persistent terminal sessions |
| `ctx.sandbox` | [`sandbox/`](../packages/sandbox/README.md) | same-world process confinement (argv wrapping, per-call policy) |
| `ctx.sandboxPolicy` | [`sandbox/`](../packages/sandbox/README.md) | shared sandbox policy home |
| `ctx.codeRuntime` | [`code-runtime/`](../packages/code-runtime/README.md) | model-written program execution |
| `ctx.fs` | [`fs/`](../packages/fs/README.md) | filesystem provider primitives and policy events |
| `ctx.lsp` | [`lsp/`](../packages/lsp/README.md) | semantic navigation registry |
| `ctx.skills` | [`skill/`](../packages/skill/README.md) | skill provider registry and progressive disclosure |
| `ctx.web` | [`web/`](../packages/web/README.md) | search/fetch provider registries |
| `ctx.compact`, `ctx.toolResultPrune` | [`compact/`](../packages/compact/README.md)/[`compact-tool-result-prune`](../packages/compact/compact-tool-result-prune/README.md) | summary compaction; optional model-free result pruning |
| `ctx.subagents` | [`subagent/`](../packages/subagent/README.md) | named delegation providers |
| `ctx.planMode` | [`plan/`](../packages/plan/README.md) | logged plan collaboration state |
| `ctx.tasks` | [`tasks/`](../packages/tasks/README.md) | background task registry + generic `task_*` control tools |
| `ctx.workflows` | [`workflow/`](../packages/workflow/README.md) | script-driven multi-agent orchestration |
| `ctx.goals` | [`goal/`](../packages/goal/README.md) | persisted same-session goals |
| `ctx.sessionPersistence` | [`session-persistence/`](../packages/session-persistence/README.md) | durable session-log storage |
| `ctx.sessionQuery` | [`session-query/`](../packages/session-query/README.md) | Live-preferred exact/filter/trace interface, SQLite FTS backend, and workspace-authorized model tools |
| `ctx.sessionTitle` | [`session-title/`](../packages/session-title/README.md) | log-backed fallbacks plus one optional asynchronous provider |
| `ctx.invariants` | [`support/invariants`](../packages/support/invariants/README.md) | package-name-selected registry for package-owned runtime checks |

## Event

Events form the service extension API; see the exhaustive [events catalog](cordis-catalog/events.md) and [producer/consumer map](event-producer-consumer.md).

### Event Domains

- **Session events** are durable facts appended to the log and emitted through `session/event`.
- **Agent events** carry the live `Agent` for status, prompt admission, request shaping, validation, and continuation.
- **Capability events** let owning seams attach policy and adapters without importing the loop.

### Interception Semantics

Waterfall events behave like around-middleware: a listener delegates by calling `next()`; returning without it vetoes or takes over. Full rule: [Cordis waterfall semantics](cordis-primer.md#cordis-waterfall-semantics).

## Default Loop Lifecycle

The shipped loop runs prompt-to-checkpoint work through plugin services and events.

A **session** is append-only. Each ordinary **turn** claims one queued `send()` item; injection claims none. A successor awaits the preceding claimed turn's checkpoint but may share its `running` interval ([decision](../.agents/notes/implemented/simplification/2026-07-17-one-send-one-turn.md)). A turn ends when model and plugins stop it; a **step** is one model request plus tools. In the [sequence below](agent-lifecycle.md), quotes mark durable events.

Without an id, creation mints `<config-id>-session-<uuid>`; `sessionId` resumes or creates, while `resumeSessionId` requires history. Resume restores lineage and delegation depth before publication. Setup failures emit `agent-loop/config-start-failed`; teardown is silent.

### Turn Flow

```text
choose declarative identity and fresh/resume path
  -> prepare private session + agent.ctx -> await unpublished setup
  -> enter session + agent -> session/created -> agent/created
  -> enable driving -> agent/session-start(source) -> start driver
forever:
  wait for a queued message
  claimed message -> agent/prompt-submit
    blocked prompt -> park without opening a turn
    allowed prompt:
      emit agent/status(running)
      'turn/start'
      append prompt + additional contexts as separate 'user/message' events
    STEP loop:
      agent/step
      drain injected context and steering (steering bypasses prompt-submit)
      assemble system prompt and tool schemas
      snapshot the derived messages (the reconstruction boundary)
      'step/start'
      agent/request (config only) -> log request/header -> llm/stream (frozen)
      'assistant/chunk'
      'assistant/message'
      schedule tool calls by ctx.tools.executionMode:
        exclusive -> one-call barrier
        parallel -> rolling pool, <= maxParallelToolCalls in flight; reclassify before start
        each start -> 'tool/call' -> ordered tools/pre-execute -> concurrent tools/execute
        each model-order result -> ordered tools/post-execute -> 'tool/result'
      drain accepted tool context and steering
      'step/end'
      continue for tools or steering unless a result concluded the turn
      otherwise agent/stopping -> drain -> continue only for steering
    'turn/end' -> agent/idle
  start the next waking queued message, or emit agent/status(idle)

idle inject:
  append 'user/message'
  do not open a turn or run the model
```

Each step assembles ordered prompt sections, tool schemas, and variables; unknown references fail the turn. `dsh-system-prompt` owns identity and persona, while the loop supplies `provider`, `model`, and `cwd` ([prompt ownership](../.agents/notes/implemented/architecture/2026-07-05-prompt-variables-and-tool-guidance-ownership.md)).

Tool-time context—including active-turn `inject()` and post-tool `additionalContexts`—settles after results. Steering drains at that boundary and requests another step. Idle `inject()` appends context immediately without changing turn numbering; persistence drains it eagerly.

Pruning precedes summaries; overflow retries require durable progress. Recovery runs through `agent/request-error` between the failed step and turn closes. A handling policy calls `agent.retry()` to schedule one retry turn; cancellation wins ([compaction](../.agents/notes/implemented/architecture/2026-07-10-after-call-compaction-pressure-and-overflow-recovery.md), [retry](../.agents/notes/implemented/architecture/2026-06-21-bounded-llm-request-recovery.md)).

### Failure Boundaries

Adapter failures close the step before `agent/request-error` receives the exact `Error`, normalized `LlmFailure`, and turn signal. A handling listener calls `agent.retry()`; the loop closes the failed turn and opens another from durable history without an idle notification. Exhaustion leaves the failed `turn/end` terminal. Failed chunks commit no message or tool call.

Other failures use `agent/error`. Cancellation and disposal beat recovery; undispatched tools get synthetic `tool/call`/`ABORTED_BEFORE_DISPATCH` pairs. Effective `cancel(cause)` emits its cause before clearing queues and aborting; observers cannot veto and idle calls emit nothing. Durability records `aborted` for user or parent cancellation and `disposed` for teardown, which awaits quiescence. The cause changes reporting, not late result-context handling ([decision](../.agents/notes/implemented/architecture/2026-07-16-explicit-turn-cancellation.md)).

Turn and step events are turn-enclosed; idle injected `user/message` events may sit between turns. Reload closes an interrupted tail with a synthetic turn end. Post-close failures use only `agent/error`. Each turn has one [TurnEndReason](core-data-structures/session.md#why-a-turn-ended-turnendreasonmap).

### Agent Handles

`ctx.agents` owns live agents and returns `AgentHandle { agent, dispose() }`. Plugins use complete `send()` options or the `followup()`, `steer()`, and `inject()` presets; `cancel()` and `whenIdle()` control lifecycle. One awaited disposer coordinates teardown ownership.

### Agent Scope

Each agent owns a scoped `agent.ctx`; shared storage overlays global tool, prompt, and command entries while preserving domain views ([decision](../.agents/notes/implemented/architecture/2026-07-12-scoped-layers-store.md)). Scoped listeners filter dispatch, and every scoped contribution unwinds with awaited cleanup. `CreateAgentOptions.setup(agentCtx)` composes before publication. Typed resolvers derive carrier checks from merged `Events` and `scopeTarget` ([semantic gates](../.agents/notes/implemented/process/2026-07-14-typescript-program-backed-semantic-gates.md)). See [agent scope](../.agents/notes/implemented/architecture/2026-07-08-agent-scope-contexts.md) and [subagent composition](../.agents/notes/implemented/feature/2026-07-12-subagent-persona-tool-filter-and-depth.md). `AgentLoop` runs inside `ctx.agents.withInitiator()`; private orchestration derives `agent.session`, while turn, step, signal, cwd, and authority remain explicit ([decision](../.agents/notes/implemented/architecture/2026-07-15-agent-initiator-scope.md)).

## State

### Session Log

The session log is authoritative. `deriveMessages()` projects model history; raw `assistant/chunk` events remain for replay and UI fidelity. Fork, resume, transcript rendering, telemetry, and persistence derive from the same stream.

**Model-visible ⟺ logged**: the log reconstructs every request from the messages at `step/start` and the folded `request/header`; the package-owned `dsh-agent-loop/invariant` can assert it through `ctx.invariants` ([reconstructability](../.agents/notes/implemented/architecture/2026-07-05-reconstructable-requests.md)).

Durability is a plugin concern. Backends eagerly drain synchronous `session/event` notifications. The semantic checkpoint policy uses `session/flush` as an observation barrier before adapter dispatch, before top-level tool dispatch, and at `agent/step` before the next request. `SessionPersistence` stores `SessionEvent` directly and metadata in `SessionHeader`; JSONL defaults to checksummed Zstandard, with SQLite under one contract ([decision](../.agents/notes/implemented/bug-fix/2026-07-21-semantic-session-checkpoints.md)).

`ctx.sessions.appendOutOfBand()` joins plugin-owned log-only events to an open turn or creates a balanced, flushed zero-step turn. `session/title` folds latest-wins with source seqs and provenance; its immediate fallback and sole optional async provider never delay the agent response. Forks inherit titles ([decision](../.agents/notes/implemented/feature/2026-07-21-log-backed-session-titles.md)).

### Model Content

Messages use typed blocks from merge-extensible `ContentBlockMap`; the same pattern types `MessageSource`, `FinishReason`, `TurnTrigger`, and `TurnEndReason`. New blocks coordinate adapters, UI, compaction, token metering, and persistence; replay measurements live in [token-meter.md](core-data-structures/token-meter.md).

Streaming uses raw chunks and `BlockAssembler`. Each `LlmAdapter.stream()` is one provider attempt; adapters report normalized failure facts and a handling `agent/request-error` plugin calls `agent.retry()`. The loop logs chunks and successful provenance/replay state. Remote adapters use per-read idle watchdogs. Replay state crosses routes only when they share an adapter instance ([contract](core-data-structures/llm-streaming.md)).

## Extension And Composition

### Capability Pattern

A swappable capability usually splits into **interface / implementation / consumer**: service/events, a backend, and model-facing tools/prompts. Bash is the reference; the [capability graph](capability-seams.md) maps each family.

Exceptions combine layers: LLM interface/consumer; filesystem policy; web registries; named skill/subagent providers. Subagents spawn fresh, fork a completed-turn prefix, or use ACP children ([subagent.md](core-data-structures/subagent.md)).

`dsh-workspace-context` injects the baseline at the first `agent/step` and appends `ctx.fs`-discovered changes through `tools/post-execute`; its [decision](../.agents/notes/implemented/feature/2026-06-24-workspace-context.md) records isolation. `dsh-paths` owns shared paths.

### Bundles And Apps

`dsh-agent-spine-demo` bundles a spine and optional goals. App packages own TUI, CLI, ACP automation, and JSON-RPC front doors ([README](../packages/examples/agent-spine-demo/README.md), [acp/](../packages/acp/README.md), [ui/](../packages/ui/README.md)). `dsh-jsonrpc-agent` boots external `cordis.yml`; the Python SDK supplies a default only without explicit config ([Python SDK](../python/README.md)). Thin deployments use swappable backends and optional tools ([examples/](../examples/AGENTS.md), [runnable wirings](cookbook/extension-cookbook.md#runnable-wirings), [graph atlas](graph-atlas.md)).

### Where New Behavior Goes

New behavior attaches to a documented extension point; a loop change updates this map.

| Goal | Mechanism |
|---|---|
| Add a model provider | register an adapter on `ctx.llm` |
| Add a model-facing capability | register on `ctx.tools`; schemas enter prompt assembly |
| Add shell execution | implement and register a `ctx.bash` backend |
| Add persistent terminal execution | register a `ctx.pty` backend and `dsh-tool-pty` |
| Add a human command | register on `ctx.commands`; adapters discover and dispatch it without a model turn |
| Add background work | register on `ctx.tasks`; generic `task_*` tools collect or stop it |
| Add filesystem access or policy | implement a `ctx.fs` provider or listen on `fs/*` policy events |
| Confine spawned processes | a `ctx.sandbox` backend; consumers wrap their argv before spawning |
| Intercept a request, tool, or turn | use its `agent/*` or `tools/*` event; `agent/stopping` is the stop boundary |
| Add model-facing context | call `agent.inject()`; it appends a sourced `user/message` without creating a turn |
| Add UI or editor integration | drive `ctx.agents` and render from `session/event`; terminal-only overlays use `ctx.tui` |
| Add durable session state | add a `SessionEventMap` member and render/replay from the log |
| Add asynchronous session-title generation | register the sole provider on `ctx.sessionTitle` |
| Manage a same-session objective | use `ctx.goals`; continue through `Agent` and `agent/*` |
| Fork a live session | use `ctx.sessions.fork(source, boundary?, childSessionId?)` |
| Scope a registration to one agent | use that agent's `agent.ctx` (see Agent Scope) |

The [extension cookbook](cookbook/extension-cookbook.md) carries plugin skeletons and the feature-to-seam map; step-by-step guides cover [packages](cookbook/adding-a-package.md), [tools](cookbook/adding-a-tool.md), [LLM adapters](cookbook/adding-an-llm-adapter.md), and [vendored packages](cookbook/adding-a-vendored-package.md).

## Quick Reference
- Domain terms in the [glossary](glossary.md)
- Type definitions in [core-data-structures/](core-data-structures/core.md)
- Exact signatures in the [event](cordis-catalog/events.md) and [service](cordis-catalog/services.md) catalogs
- package contracts in the [package map](../packages/README.md)
- [Agent Notes](../.agents/notes/README.md)
