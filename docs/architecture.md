# DeepSeek Harness Architecture

English | [中文](architecture.zh.md)

**DeepSeek Harness SDK** uses Cordis: **everything is a plugin**, including the loop.

## Overview

Harnesses are [Cordis](cordis-primer.md) contexts; packages contribute services, typed events, and disposable registrations.

`packages/core/` groups the default agent flow; capabilities remain plugins.

### Default Services

| ctx key | Package | Role |
|---|---|---|
| — | [`dsh-scope`](../packages/core/scope/README.md) | scoped-context registrations and shared layer storage (library) |
| `ctx.sessions` | `dsh-session` | in-memory event-sourced sessions |
| `ctx.systemPrompt` | `dsh-system-prompt` | ordered prompt sections, tool schemas, and variables |
| `ctx.tools` | `dsh-tools` | tool registry and [execution pipeline](tool-execution-pipeline.md) |
| `ctx.agents` | `dsh-agent` | live agents, delegated creation, `agent/*` events, process-local initiator scope |
| `ctx.agentLoop` | `dsh-agent-loop` | concrete `Agent` driver |

### Capability Services

| ctx key | Package family | Role |
|---|---|---|
| `ctx.llm` | [`llm/`](../packages/llm/README.md) | adapter registry and streaming model calls |
| `ctx.tokenMeter` | [`llm/token-meter`](../packages/llm/token-meter/README.md) | singleton replay-aware request and surface pressure |
| `ctx.bash` | [`bash/`](../packages/bash/README.md) | foreground/background command execution |
| `ctx.subprocess` | [`subprocess/`](../packages/subprocess/README.md) | managed child-process trees for the bash executors, the LSP host, and the ACP subagent backend |
| `ctx.pty` | [`pty/`](../packages/pty/README.md) | owner-scoped persistent terminal sessions |
| `ctx.sandbox` | [`sandbox/`](../packages/sandbox/README.md) | same-world process confinement through argv wrapping and per-call policy |
| `ctx.sandboxPolicy` | [`sandbox/`](../packages/sandbox/README.md) | shared sandbox policy home |
| `ctx.codeRuntime` | [`code-runtime/`](../packages/code-runtime/README.md) | model-written program execution |
| `ctx.fs` | [`fs/`](../packages/fs/README.md) | filesystem provider primitives and policy events |
| `ctx.lsp` | [`lsp/`](../packages/lsp/README.md) | semantic navigation registry |
| `ctx.skills` | [`skill/`](../packages/skill/README.md) | skill provider registry and progressive disclosure |
| `ctx.web` | [`web/`](../packages/web/README.md) | search/fetch provider registries |
| `ctx.compact`, `ctx.toolResultPrune` | [`compact/`](../packages/compact/README.md)/[`compact-tool-result-prune`](../packages/compact/compact-tool-result-prune/README.md) | summary compaction and optional model-free result pruning |
| `ctx.subagents` | [`subagent/`](../packages/subagent/README.md) | named delegation providers |
| `ctx.planMode` | [`plan/`](../packages/plan/README.md) | logged plan collaboration state |
| `ctx.tasks` | [`tasks/`](../packages/tasks/README.md) | background task registry and generic `task_*` controls |
| `ctx.workflows` | [`workflow/`](../packages/workflow/README.md) | script-driven multi-agent orchestration |
| `ctx.goals` | [`goal/`](../packages/goal/README.md) | persisted same-session goals |
| `ctx.sessionPersistence` | [`session-persistence/`](../packages/session-persistence/README.md) | durable session-log storage |
| `ctx.sessionQuery` | [`session-query/`](../packages/session-query/README.md) | live-preferred exact/filter/trace interface, SQLite FTS backend, workspace-authorized model tools |
| `ctx.sessionTitle` | [`session-title/`](../packages/session-title/README.md) | log-backed fallbacks and one optional asynchronous provider |
| `ctx.invariants` | [`support/invariants`](../packages/support/invariants/README.md) | package-name-selected registry of package-owned runtime checks |

## Event

Events are the service extension API ([catalog](cordis-catalog/events.md), [producer/consumer map](event-producer-consumer.md)).

### Event Domains

- **Session events** are durable log facts emitted through `session/event`.
- **Agent events** carry live `Agent` for status, prompt admission, request shaping, validation, and continuation.
- **Capability events** let owning seams attach policy and adapters without a loop import.

### Interception Semantics

Waterfalls are around-middleware: listeners delegate with `next()`; returning without it vetoes or takes over ([semantics](cordis-primer.md#cordis-waterfall-semantics)).

## Default Loop Lifecycle

A **session** is append-only. An ordinary **turn** claims one queued `send()` item; injection claims none. A successor awaits its predecessor's checkpoint but may share its `running` interval ([decision](../.agents/notes/implemented/simplification/2026-07-17-one-send-one-turn.md)). A turn ends when model or plugins stop it; a **step** is one model request plus tools. Quotes in the [sequence below](agent-lifecycle.md) mark durable events.

Creation without an id mints `<config-id>-session-<uuid>`; `sessionId` resumes or creates, while `resumeSessionId` requires history. Resume restores lineage and delegation depth before publication. Setup failures emit `agent-loop/config-start-failed`; teardown is silent.

### Turn Flow

```text
choose declarative identity and fresh/resume path
  -> prepare private session + agent.ctx -> await unpublished setup
  -> enter session + agent -> session/created -> agent/created
  -> enable driving -> agent/session-start(source) -> start driver
forever:
  wait for a queued message
  claim message -> emit agent/status(running) if starting an interval
  open the next-step acceptance window
  -> agent/prompt-submit
    blocked or failed prompt -> close the window without opening a turn
      append a context-only caller batch immediately
      keep steering and context staged beside it pending for a later admitted turn
    allowed prompt:
      'turn/start'
      append prompt + additional contexts as separate 'user/message' events
    STEP loop:
      agent/step
      drain injected context and steering (steering bypasses prompt-submit)
      assemble system prompt and tool schemas
      snapshot the derived messages (the reconstruction boundary)
      'step/start'
      agent/request (config only) -> prepare reasoning/default under turn signal -> log request/header -> llm/stream (frozen, registration-bound)
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
      otherwise agent/turn-stopping -> drain -> continue only for steering
    close the next-step acceptance window
    'turn/end' -> agent/settled
  start the next waking queued message, or emit agent/status(idle)

idle inject:
  append 'user/message'
  do not open a turn or run the model
```

Each step assembles ordered prompt sections, tool schemas, and variables; unknown references fail the turn. `dsh-system-prompt` owns identity and persona; the loop supplies `provider`, `model`, and `cwd` ([prompt ownership](../.agents/notes/implemented/architecture/2026-07-05-prompt-variables-and-tool-guidance-ownership.md)).

Admission-time and active-turn `inject()` stage for the next step; post-tool `additionalContexts` settles after results. Steering shares that staging boundary and requests another step. Idle `inject()` appends immediately without changing turn numbers; persistence drains eagerly.

Pruning precedes summaries; overflow retries require durable progress. `agent/request-error` may authorize one retry turn between failed-step and turn close; cancellation wins. Adapter-owned `retryPolicy` makes normal mode bounded; always mode delegates specialized recovery before retrying until success or cancellation ([compaction](../.agents/notes/implemented/architecture/2026-07-10-after-call-compaction-pressure-and-overflow-recovery.md), [retry foundation](../.agents/notes/implemented/architecture/2026-06-21-bounded-llm-request-recovery.md), [provider policy](../.agents/notes/implemented/feature/2026-07-24-provider-retry-policies.md)).

### Failure Boundaries

Adapter failures close their step before `agent/request-error` receives the exact `Error`, normalized `LlmFailure`, and signal. A handled failure closes its turn and opens a retry turn from durable history without an idle notification; exhaustion leaves terminal `turn/end`. Failed chunks commit neither messages nor tool calls.

Other failures use `agent/error`. Cancellation and disposal beat recovery. Before request-header commit, the turn signal cancels asynchronous model-capability preparation; undispatched tools get synthetic `tool/call`/`ABORTED_BEFORE_DISPATCH` pairs. Effective `cancel(cause)` emits its cause before queue clearing and abort; observers cannot veto; idle calls emit nothing. Durability records user or parent cancellation as `aborted`, teardown as `disposed`; teardown awaits quiescence. The cause affects reporting, not late result-context handling ([decision](../.agents/notes/implemented/architecture/2026-07-16-explicit-turn-cancellation.md)).

Turn and step events are turn-enclosed; idle injected `user/message` events may sit between turns. Reload closes an interrupted tail with a synthetic turn end. After close, only `agent/error` reports failures. Each turn has one [TurnEndReason](core-data-structures/session.md#why-a-turn-ended-turnendreasonmap).

### Agent Handles

`ctx.agents` owns live agents and returns `AgentHandle { agent, dispose() }`. Plugins use full `send()` options or `followup()`, `steer()`, and `inject()` presets; `cancel()` and `whenIdle()` control lifecycle. One awaited disposer coordinates teardown ownership.

### Agent Scope

Each agent owns scoped `agent.ctx`; shared storage overlays its tool, prompt, and command entries on globals while preserving domain views ([decision](../.agents/notes/implemented/architecture/2026-07-12-scoped-layers-store.md)). Scoped listeners filter dispatch; contributions unwind with awaited cleanup. `CreateAgentOptions.setup(agentCtx)` composes before publication. Typed resolvers derive carrier checks from merged `Events` and `scopeTarget` ([semantic gates](../.agents/notes/implemented/process/2026-07-14-typescript-program-backed-semantic-gates.md)). Details: [agent scope](../.agents/notes/implemented/architecture/2026-07-08-agent-scope-contexts.md), [subagent composition](../.agents/notes/implemented/feature/2026-07-12-subagent-persona-tool-filter-and-depth.md). `AgentLoop` runs under `ctx.agents.withInitiator()`; private orchestration derives `agent.session`, but turn, step, signal, cwd, and authority stay explicit ([decision](../.agents/notes/implemented/architecture/2026-07-15-agent-initiator-scope.md)).

## State

### Session Log

The session log is authoritative. `deriveMessages()` projects model history; raw `assistant/chunk` events preserve replay and UI fidelity. Fork, resume, transcript rendering, telemetry, and persistence derive from this stream.

**Model-visible ⟺ logged**: messages at `step/start` plus the folded `request/header` reconstruct every request; package-owned `dsh-agent-loop/invariant` can assert this through `ctx.invariants` ([reconstructability](../.agents/notes/implemented/architecture/2026-07-05-reconstructable-requests.md)).

Durability is a plugin concern. Backends eagerly drain synchronous `session/event` notifications. `session/flush` barriers precede each request and top-level tool dispatch, then follow `turn/end` before another queued turn or idle observation. `SessionPersistence` stores `SessionEvent` directly and metadata in `SessionHeader`; JSONL defaults to checksummed Zstandard, while SQLite shares the contract ([decision](../.agents/notes/implemented/bug-fix/2026-07-21-semantic-session-checkpoints.md)).

`ctx.sessions.appendOutOfBand()` adds plugin-owned log-only events to an open turn or creates a balanced, flushed zero-step turn. `session/title` folds latest-wins with source seqs and provenance; its immediate fallback and sole optional async provider never delay response. Forks inherit titles ([decision](../.agents/notes/implemented/feature/2026-07-21-log-backed-session-titles.md)).

### Model Content

Messages use typed blocks from merge-extensible `ContentBlockMap`; the pattern also types `MessageSource`, `FinishReason`, `TurnTrigger`, and `TurnEndReason`. New blocks coordinate adapters, UI, compaction, token metering, and persistence; replay measurements live in [token-meter.md](core-data-structures/token-meter.md).

Streaming uses raw chunks and `BlockAssembler`. Each `LlmAdapter.stream()` is one provider attempt; adapters report normalized failure facts, and a handling `agent/request-error` plugin returns a retry action. The loop logs chunks, successful provenance, and replay state. Remote adapters use per-read idle watchdogs. Replay crosses routes only through a shared adapter instance ([contract](core-data-structures/llm-streaming.md)).

## Extension And Composition

### Capability Pattern

A swappable capability usually has **interface / implementation / consumer** layers: service/events, backend, and model-facing tools/prompts. Bash is the reference; the [capability graph](capability-seams.md) maps each family.

Exceptions combine LLM interface/consumer, filesystem policy, web registries, and named skill/subagent providers. Subagents spawn fresh, fork a completed-turn prefix, or use ACP children ([subagent.md](core-data-structures/subagent.md)).

`dsh-workspace-context` injects baseline at the first `agent/step` and appends `ctx.fs`-discovered changes through `tools/post-execute`; its [decision](../.agents/notes/implemented/feature/2026-06-24-workspace-context.md) records isolation. `dsh-paths` owns shared paths.

### Bundles And Apps

`dsh-agent-spine-demo` bundles a spine and optional goals. App packages own TUI, CLI, ACP automation, and JSON-RPC front doors ([README](../packages/examples/agent-spine-demo/README.md), [acp/](../packages/acp/README.md), [ui/](../packages/ui/README.md)). `dsh-jsonrpc-agent` boots external `cordis.yml`; the Python SDK defaults when config is absent ([Python SDK](../python/README.md)). Thin deployments use swappable backends and optional tools ([examples/](../examples/AGENTS.md), [runnable wirings](cookbook/extension-cookbook.md#runnable-wirings), [graph atlas](graph-atlas.md)).

### Where New Behavior Goes

New behavior attaches to a documented extension point; a loop change updates this map.

| Goal | Mechanism |
|---|---|
| Add a model provider | register its adapter on `ctx.llm` |
| Add a model-facing capability | register on `ctx.tools`; schemas join prompt assembly |
| Add shell execution | implement and register a `ctx.bash` backend; the local backend spawns through `ctx.subprocess` |
| Add persistent terminal execution | register a `ctx.pty` backend plus `dsh-tool-pty` |
| Add a human command | register on `ctx.commands`; adapters discover and dispatch without a model turn |
| Add background work | register on `ctx.tasks`; generic `task_*` tools collect or stop it |
| Add filesystem access or policy | implement a `ctx.fs` provider or listen to `fs/*` policy events |
| Confine spawned processes | use a `ctx.sandbox` backend; consumers wrap argv before spawning |
| Intercept a request, tool, or turn | use its `agent/*` or `tools/*` event; `agent/turn-stopping` is the stop boundary |
| Add model-facing context | call `agent.inject()` to append a sourced `user/message` without a turn |
| Add UI or editor integration | drive `ctx.agents`, render from `session/event`; terminal-only overlays use `ctx.tui` |
| Add durable session state | extend `SessionEventMap`; render and replay from the log |
| Add asynchronous session-title generation | register the sole `ctx.sessionTitle` provider |
| Manage a same-session objective | use `ctx.goals`; continue through `Agent` and `agent/*` |
| Fork a live session | call `ctx.sessions.fork(source, boundary?, childSessionId?)` |
| Scope a registration to one agent | use its `agent.ctx` (see Agent Scope) |

The [extension cookbook](cookbook/extension-cookbook.md) has plugin skeletons and the feature-to-seam map; guides cover [packages](cookbook/adding-a-package.md), [tools](cookbook/adding-a-tool.md), [LLM adapters](cookbook/adding-an-llm-adapter.md), and [vendored packages](cookbook/adding-a-vendored-package.md).
