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
| `ctx.systemPrompt` | `dsh-system-prompt` | ordered stable system sections, cache-safe dynamic contexts, tool schemas, and variables |
| `ctx.tools` | `dsh-tools` | tool registry and [execution pipeline](tool-execution-pipeline.md) |
| `ctx.agents` | `dsh-agent` | live agents, delegated creation, `agent/*` events, process-local initiator scope |
| `ctx.agentLoop` | `dsh-agent-loop` | concrete `Agent` driver |

### Capability Services

| ctx key | Package family | Role |
|---|---|---|
| `ctx.llm` | [`llm/`](../packages/llm/README.md) | adapter registry, streaming model calls |
| `ctx.tokenMeter` | [`llm/token-meter`](../packages/llm/token-meter/README.md) | replay-aware request and surface pressure |
| `ctx.bash` | [`bash/`](../packages/bash/README.md) | foreground/background command execution |
| `ctx.subprocess` | [`subprocess/`](../packages/subprocess/README.md) | managed child-process trees for bash, LSP, and ACP subagent backends |
| `ctx.pty` | [`pty/`](../packages/pty/README.md) | owner-scoped persistent terminal sessions |
| `ctx.sandbox` | [`sandbox/`](../packages/sandbox/README.md) | same-world process confinement through argv wrapping and per-call policy |
| `ctx.sandboxPolicy` | [`sandbox/`](../packages/sandbox/README.md) | shared sandbox policy home |
| `ctx.codeRuntime` | [`code-runtime/`](../packages/code-runtime/README.md) | model-written program execution |
| `ctx.fs` | [`fs/`](../packages/fs/README.md) | filesystem provider primitives and policy events |
| `ctx.lsp` | [`lsp/`](../packages/lsp/README.md) | semantic navigation registry |
| `ctx.skills` | [`skill/`](../packages/skill/README.md) | skill provider registry, progressive disclosure |
| `ctx.web` | [`web/`](../packages/web/README.md) | search/fetch provider registries |
| `ctx.compact`, `ctx.toolResultPrune` | [`compact/`](../packages/compact/README.md)/[`compact-tool-result-prune`](../packages/compact/compact-tool-result-prune/README.md) | summary compaction, optional model-free result pruning |
| `ctx.subagents` | [`subagent/`](../packages/subagent/README.md) | named delegation providers and Activation-based continuations |
| `ctx.planMode` | [`plan/`](../packages/plan/README.md) | logged plan collaboration state |
| `ctx.tasks` | [`tasks/`](../packages/tasks/README.md) | background task registry, generic `task_*` controls |
| `ctx.workflows` | [`workflow/`](../packages/workflow/README.md) | script-driven multi-agent orchestration |
| `ctx.goals` | [`goal/`](../packages/goal/README.md) | persisted same-session goals |
| `ctx.sessionPersistence` | [`session-persistence/`](../packages/session-persistence/README.md) | durable session-log storage |
| `ctx.sessionQuery` | [`session-query/`](../packages/session-query/README.md) | live-preferred exact/filter/trace queries over SQLite FTS, workspace-authorized model tools |
| `ctx.sessionTitle` | [`session-title/`](../packages/session-title/README.md) | log-backed fallbacks, one optional asynchronous provider |
| `ctx.settings` | [`settings/`](../packages/settings/README.md) | per-plugin user-settings namespaces layered over composition entries |
| `ctx.credentials` | [`credentials/`](../packages/credentials/README.md) | named secret references resolved per operation, never inlined in configuration |
| `ctx.directoryPicker` | [`host/directory-picker`](../packages/host/directory-picker/README.md) | GUI-host directory picking (`native`/`browse` interactions) |
| `ctx.typert` | [`typert/registry`](../packages/typert/registry/README.md) | runtime registry for generated package reflection and live Zod schemas |
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

A **session** is append-only. An ordinary **turn** claims one queued `send()` item; injection claims none. A turn ends when the model or plugins stop it; a **step** is one model request plus its tool calls. Agent and session publication happen only after private setup and resume state are ready. Quotes in the [sequence below](agent-lifecycle.md) mark durable events.

### Turn Flow

```text
choose declarative identity and fresh/resume path
  -> prepare private session + agent.ctx -> await unpublished setup -> invoke optional synchronous setup commit
  -> enter session + agent -> session/created -> agent/created
  -> enable driving -> agent/session-start(source) -> start driver
forever:
  wait for queued occurrence
  claim (edit/remove end) -> emit agent/status(running) if starting an interval
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
      assemble system prompt and tools
      materialize changed runtime context as sourced 'user/message'
      drain injected context and provisional steering (steering bypasses prompt-submit)
      snapshot the derived messages (the reconstruction boundary)
      'step/start'
      admit the drained steering receipts
      agent/request (config only) -> prepare adapter defaults/provenance + context capacity under turn signal -> log request/header (+ request/context on route change) -> llm/stream (frozen, registration-bound)
      'assistant/chunk'
      'assistant/message'
      schedule tool calls by ctx.tools.executionMode:
        exclusive -> barrier
        parallel -> rolling pool, <= maxParallelToolCalls; reclassify-at-start; scheduler failure -> stop starts, drain dispatches
        start -> 'tool/call' -> ordered tools/pre-execute -> concurrent tools/execute
        model-order result -> ordered tools/post-execute -> 'tool/result'
      drain accepted tool context after all results; keep steering provisional
      'step/end'
      continue for tools or steering unless a result concluded the turn and rejects pending steering
      otherwise agent/turn-stopping -> drain context -> continue only for steering
    close the next-step acceptance window
    'turn/end' -> agent/settled
  start the next waking queued message, or emit agent/status(idle)

idle inject:
  append 'user/message'
  do not open a turn or run the model
```

Each step assembles the prompt, tools, runtime context, adapter settings, and model history before recording its reconstruction boundary. Tool calls then run through the shared execution pipeline. `inject()` adds context without opening an idle turn; `steer()` targets a next-step admission window; queued input remains the source of ordinary turns. The generated [agent lifecycle](agent-lifecycle.md) owns exact event order, and the [agent-loop README](../packages/core/agent-loop/README.md) owns queue, steering, retry, and cancellation mechanics.

### Failure Boundaries

Adapter failures close their step before `agent/request-error` can authorize recovery from durable history. Other failures use `agent/error`; cancellation and disposal take precedence over recovery. Failed model attempts commit no assistant message or tool side effect. Turn closure is represented by one [TurnEndReason](core-data-structures/session.md#why-a-turn-ended-turnendreasonmap); the exact retry contract belongs to [LLM streaming](core-data-structures/llm-streaming.md).

### Agent Handles

`ctx.agents` owns agents and returns `AgentHandle { agent, dispose() }`. Plugins submit queued work, steering, or injected context through the [agent interface](../packages/core/agent/README.md#agent-interface-typests); cancellation, idleness, and teardown stay behind the same handle.

### Agent Scope

Each agent owns scoped `agent.ctx`; shared storage overlays its tools, prompts, and commands on global contributions while scoped listeners filter dispatch. Setup composes before publication and cleanup unwinds contributions. The [agent-scope decision](../.agents/notes/implemented/architecture/2026-07-08-agent-scope-contexts.md) owns the detailed lifecycle.

## State

### Session Log

The session log is authoritative. `deriveMessages()` projects model history; raw `assistant/chunk` events preserve replay and UI fidelity. Fork, resume, transcript rendering, telemetry, and persistence derive from this stream.

**Model-visible ⟺ logged**: before `step/start`, the loop appends the full current runtime-context snapshot as a sourced `user/message`, then snapshots derived messages. Those messages and the folded `request/header` reconstruct each request. The header marks adapter defaults so later proposals discard them and re-resolve the route without losing explicit settings. `dsh-agent-loop/invariant` asserts this through `ctx.invariants` ([reconstructability](../.agents/notes/implemented/architecture/2026-07-05-reconstructable-requests.md)).

Durability is a plugin concern. Backends eagerly drain synchronous `session/event` notifications. `session/flush` barriers precede each request and top-level tool dispatch, then follow `turn/end` before another queued turn or idle observation. `SessionPersistence` stores `SessionEvent` directly and metadata in `SessionHeader`; JSONL defaults to checksummed Zstandard, while SQLite shares the contract ([decision](../.agents/notes/implemented/bug-fix/2026-07-21-semantic-session-checkpoints.md)).

Between turns, owners append log-only events through `Session`, flushing only for durability. `session/title` needs eager persistence and lifecycle drains; manual compaction flushes its bracket before releasing admission. Title work never delays responses; latest wins with provenance. Title records are inherited fork boundaries ([decision](../.agents/notes/implemented/feature/2026-07-21-log-backed-session-titles.md)).

### Model Content

Messages use typed blocks from merge-extensible `ContentBlockMap`; the pattern also types `MessageSource`, `FinishReason`, `TurnTrigger`, and `TurnEndReason`. New blocks coordinate adapters, UI, compaction, token metering, and persistence; replay measurements live in [token-meter.md](core-data-structures/token-meter.md).

Streaming uses raw chunks and `BlockAssembler`. Each `LlmAdapter.stream()` is one provider attempt; adapters report normalized failure facts, and a handling `agent/request-error` plugin returns a retry action. The loop logs chunks, successful provenance, and replay state. Remote adapters use per-read idle watchdogs. Replay crosses routes only through a shared adapter instance ([contract](core-data-structures/llm-streaming.md)).

## Extension And Composition

### Capability Pattern

A swappable capability usually has **interface / implementation / consumer** layers: service/events, backend, and model-facing tools/prompts. Bash is the reference; the [capability graph](capability-seams.md) maps each family.

Exceptions combine LLM interface/consumer, filesystem policy, web registries, and named skill/subagent providers. Subagents spawn fresh, fork a completed-turn prefix, or use ACP children ([subagent.md](core-data-structures/subagent.md)).

`dsh-workspace-context` injects baseline at the first `agent/step` and appends `ctx.fs`-discovered changes through `tools/post-execute`; its [decision](../.agents/notes/implemented/feature/2026-06-24-workspace-context.md) records isolation. `dsh-paths` owns shared paths.

### Bundles And Apps

`dsh-agent-spine-demo` bundles a spine and optional goals. App packages own CLI, ACP automation, and JSON-RPC front doors ([README](../packages/examples/agent-spine-demo/README.md), [acp/](../packages/acp/README.md), [ui/](../packages/ui/README.md)). `dsh-jsonrpc-agent` boots external `cordis.yml`; the Python SDK defaults when config is absent ([Python SDK](../python/README.md)). Thin deployments use swappable backends and optional tools ([examples/](../examples/AGENTS.md), [runnable wirings](cookbook/extension-cookbook.md#runnable-wirings), [graph atlas](graph-atlas.md)).

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
| Add UI or editor integration | drive `ctx.agents` and render from `session/event` |
| Add durable session state | extend `SessionEventMap`; render and replay from the log |
| Add asynchronous session-title generation | register the sole `ctx.sessionTitle` provider |
| Manage a same-session objective | use `ctx.goals`; continue through `Agent` and `agent/*` |
| Fork a live session | call `ctx.sessions.fork(source, boundary?, childSessionId?)` |
| Scope a registration to one agent | use its `agent.ctx` (see Agent Scope) |

The [extension cookbook](cookbook/extension-cookbook.md) has plugin skeletons; guides cover [packages](cookbook/adding-a-package.md), [tools](cookbook/adding-a-tool.md), [LLM adapters](cookbook/adding-an-llm-adapter.md), and [vendored packages](cookbook/adding-a-vendored-package.md).
