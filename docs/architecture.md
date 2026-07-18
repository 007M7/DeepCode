# DeepSeek Harness Architecture

The **DeepSeek Harness SDK** builds agent harnesses on Cordis. The principle is simple: **everything is a plugin**. The shipped loop is one plugin, not a privileged kernel.

## Overview

A harness is one [Cordis](cordis-primer.md) context. Packages contribute service keys, typed events, and disposable registrations: services expose stable calls (`ctx.llm`, `ctx.tools`, `ctx.sessions`), events provide interception and notifications (`agent/request`, `tools/pre-execute`, `session/event`), and registrations install prompt sections, tools, providers, adapters, or listeners.

`packages/core/` groups the default agent flow; surrounding capabilities are equally first-class Cordis plugins.

### Default Services

| ctx key | Package | Role |
|---|---|---|
| — | [`dsh-scope`](../packages/core/scope/README.md) | scoped-context registration primitive (library) |
| `ctx.sessions` | `dsh-session` | in-memory event-sourced sessions |
| `ctx.systemPrompt` | `dsh-system-prompt` | ordered prompt sections, tool schemas, and prompt variables |
| `ctx.tools` | `dsh-tools` | tool registry and [execution pipeline](tool-execution-pipeline.md) |
| `ctx.agents` | `dsh-agent` | live agent registry, public `Agent` handle, `agent/*` events |
| `ctx.agentLoop` | `dsh-agent-loop` | shipped `ReactLoopAgent` driver |

### Capability Services

| ctx key | Package family | Role |
|---|---|---|
| `ctx.llm` | [`llm/`](../packages/llm/README.md) | adapter registry and streaming model calls |
| `ctx.tokenMeter` | [`llm/token-meter`](../packages/llm/token-meter/README.md) | singleton replay-aware request/surface pressure |
| `ctx.bash` | [`bash/`](../packages/bash/README.md) | foreground/background command execution |
| `ctx.sandbox` | [`sandbox/`](../packages/sandbox/README.md) | same-world process confinement (argv wrapping, per-call policy) |
| `ctx.codeRuntime` | [`code-runtime/`](../packages/code-runtime/README.md) | model-written program execution |
| `ctx.fs` | [`fs/`](../packages/fs/README.md) | filesystem provider primitives and policy events |
| `ctx.skills` | [`skill/`](../packages/skill/README.md) | skill provider registry and progressive disclosure |
| `ctx.web` | [`web/`](../packages/web/README.md) | search/fetch provider registries |
| `ctx.compact` | [`compact/`](../packages/compact/README.md) | session-log compaction |
| `ctx.subagents` | [`subagent/`](../packages/subagent/README.md) | named delegation providers |
| `ctx.tasks` | [`tasks/`](../packages/tasks/README.md) | background task registry + generic `task_*` control tools |
| `ctx.workflows` | [`workflow/`](../packages/workflow/README.md) | script-driven multi-agent orchestration |
| `ctx.sessionPersistence` | [`session-persistence/`](../packages/session-persistence/README.md) | durable storage for session logs |
| `ctx.sessionQuery` | [`session-query/`](../packages/session-query/README.md) | live-preferred logical-corpus exact reads and relationship traces |

## Event

Events form the service extension API; see the exhaustive [events catalog](cordis-catalog/events.md) and [producer/consumer map](event-producer-consumer.md).

### Event Domains

- **Session events** are durable, replayable facts: boundaries, messages, tool activity, steering, compaction, and tool-owned records append to the log and flow through `session/event`.
- **Agent events** carry the live `Agent` handle for status, diagnostics, prompt admission, request shaping, result validation, and continuation policy.
- **Capability events** belong to their owning seam; `tools/*`, `llm/*`, `system-prompt/*`, `fs/*`, and `subagent/*` attach policy and adapters without importing the loop.

### Interception Semantics

Waterfall events behave like around-middleware: a listener delegates by calling `next()`; returning without it vetoes or takes over. Full rule: [Cordis waterfall semantics](cordis-primer.md#cordis-waterfall-semantics).

## Default Loop Lifecycle

The shipped loop drains work from prompt through checkpoint. Every pause is a service call or event available to plugins.

A **session** is one agent's append-only event log. A **turn** drains one queued batch and runs until the model stops asking for tools and no plugin requests continuation. A **step** is one model request plus the tool executions caused by that response. In the flow below ([sequence companion](agent-lifecycle.md)), quoted names are durable session events and event names are extension points.

### Turn Flow

```text
prepare private session + agent.ctx -> await unpublished setup
  -> enter session + agent -> session/created -> agent/created
  -> enable driving -> agent/session-start(source) -> start driver
forever:
  wait for queued messages
  emit agent/status(running)
  TURN:
    'turn/start'
    each queued message -> agent/prompt-submit
      allowed prompt -> 'user/message' plus injected context
    every prompt blocked -> 'turn/end'(rejected)
    STEP loop:
      drain steering
      assemble system prompt and tool schemas
      agent/session-prefix (first step)
      agent/pre-step
      'step/start'
      snapshot the derived messages (the reconstruction boundary)
      agent/request (config only) -> log request/header -> llm/stream (frozen)
        'assistant/chunk'
      agent/step-result
      'assistant/message' (transformed content or empty success anchor after step-result rejection)
      each tool call:
        'tool/call'
        tools/pre-execute -> monotonic guards -> tools/execute -> tools/post-execute -> tools/result
        'tool/result'
      append post-tool context and steering
      'step/end'
      agent/turn-continuation
      agent/turn-stop (terminal policy)
      stop unless tools or continuation policy ask for another step
    'turn/end'
    checkpoint persistence and notify idle/running status
```

Each step assembles ordered prompt sections, tool schemas, and `{{name}}` variables; unknown or valueless references fail the turn. `dsh-system-prompt` owns the harness identity and default persona, which an agent scope may shadow. The loop supplies `model` and `cwd` ([prompt-ownership RFC](rfc/implemented/architecture/2026-07-05-prompt-variables-and-tool-guidance-ownership.md)).

Context accepted during tool execution—including async `agent.inject()` notices and post-tool `additionalContext`—waits for settlement, then follows every recorded result. Successful batches preserve call/result adjacency; interrupted batches drain that context before turn closure. Steering drains between steps; ordinary leftover steering after a turn is re-queued as input. A terminal `agent/turn-stop` is the explicit exception: it runs after ordinary continuation and steering folding, then remains authoritative through turn close and flush so steering from those later listeners is discarded rather than becoming another step or turn; ordinary queued prompts are preserved.

### Failure Boundaries

The turn is the containment boundary. A throwing listener, adapter error finish, or failed step ends it with an error reason and reports `agent/error` without killing the driver. `cancel()` clears queued and steering work, aborts the active model/tool boundary when possible, and records the turn end. Disposal stops the loop, awaits quiescence, unregisters the agent, and drains service disposers.

Every session event is turn-enclosed. Reloading preserves an interrupted tail and closes it with a synthetic `interrupted` turn end. Failures after durable turn close report only through `agent/error` because no safe in-turn position remains. Each turn has one `TurnEndReason`; [TurnEndReasonMap](core-data-structures/session.md#why-a-turn-ended-turnendreasonmap) owns the variants.

### Agent Handles

`ctx.agents` owns live agents and returns `AgentHandle { agent, dispose() }`. Plugins drive `Agent` through `send()`, `steer()`, `inject()`, `cancel()`, and `whenIdle()`. The caller fiber and factory provider structurally co-own programmatic lifecycles; the consumer handle is the only other teardown capability. All owners await one disposer.

### Agent Scope

Every live agent owns a scoped `agent.ctx`. Its registrations shadow globals, receive only that agent's dispatches, and unwind with it; async effects such as background-task cleanup are awaited. `CreateAgentOptions.setup(agentCtx)` composes the scope before publication. Typed resolvers derive carrier checks from merged `Events` signatures and `scopeTarget` ([semantic-gates RFC](rfc/implemented/process/2026-07-14-typescript-program-backed-semantic-gates.md)). See the [agent-scope RFC](rfc/implemented/architecture/2026-07-08-agent-scope-contexts.md) and [subagent composition controls](rfc/implemented/feature/2026-07-12-subagent-persona-tool-filter-and-depth.md).

## State

### Session Log

The session log is the source of truth. `deriveMessages()` projects session events into the `Message[]` sent to the model; raw `assistant/chunk` events stay in the log for replay and UI fidelity. Replay, fork, resume, transcript rendering, telemetry, and persistence all derive from the same event stream.

**Model-visible ⟺ logged**: the log reconstructs every request — messages at `step/start` fronted by the header's session prefix, headers by folding `request/header` — and dev invariants assert this ([reconstructability RFC](rfc/implemented/architecture/2026-07-05-reconstructable-requests.md)).

Durability is a plugin concern. Persistence backends buffer synchronous `session/event` notifications and the loop awaits a turn-end checkpoint before moving on. The `SessionPersistence` seam stores `SessionEvent` directly, with metadata in `SessionHeader`; JSONL and SQLite share one contract suite.

### Model Content

Messages contain typed blocks (`text`, `reasoning`, `tool-call`, `tool-result`) derived from merge-extensible `ContentBlockMap`; the same pattern types `MessageSource`, `FinishReason`, `TurnTrigger`, and `TurnEndReason`. New block types coordinate adapters, UI bridges, compaction pricing, token metering, and persistence as one repo-wide contract; replay measurement types live in [token-meter.md](core-data-structures/token-meter.md).

Streaming uses raw chunks (`block-start` through `finish`) and `BlockAssembler`. The loop logs and assembles chunks, storing provider/model provenance plus replay state. An `LlmAdapter` implements `stream()`, registers provider routes, and may expose selector metadata; it resolves and validates model ids. Replay state reaches targets only when both routes map to one adapter instance, which owns validation and conversion. The contract lives in [llm-streaming.md](core-data-structures/llm-streaming.md).

## Extension And Composition

### Capability Pattern

A swappable capability usually splits into **interface / implementation / consumer**: the interface owns its `ctx` key and events, an implementation registers a backend, and a consumer exposes model behavior through tools or prompts. Bash is the reference; the [capability graph](capability-seams.md) shows every family.

Some seams bend the template deliberately: LLM combines interface and consumer because adapters implement it; filesystem wraps provider primitives with policy; web keeps search/fetch provider registries behind one service; skills and subagents use named providers. Subagents spawn fresh, fork a completed-turn prefix, or use ACP children ([subagent.md](core-data-structures/subagent.md)).

`dsh-workspace-context` composes baselines on `agent/session-prefix` and appends `ctx.fs`-discovered nested changes on `tools/post-execute`; its [RFC](rfc/implemented/feature/2026-06-24-workspace-context.md) records isolation. `dsh-paths` owns shared paths.

### Bundles And Apps

`dsh-agent-spine-demo` bundles the default spine ([README](../packages/examples/agent-spine-demo/README.md)). `dsh-stdio-demo` adds a terminal front door; `dsh-acp-demo` adds stdout-pure ACP over JSON-RPC ([ui/](../packages/ui/README.md)). `dsh-jsonrpc-agent` boots external `cordis.yml`; the Python SDK supplies its default only without an explicit config channel and drives `dsh-jsonrpc` over line-delimited JSON-RPC ([Python SDK](../python/README.md)). Deployments remain thin leaves with swappable backends and optional product tools ([examples/](../examples/AGENTS.md), [runnable wirings](cookbook/extension-cookbook.md#runnable-wirings), [graph atlas](graph-atlas.md)).

### Where New Behavior Goes

New behavior should attach to a documented extension point; changing the shipped loop requires updating this map.

| Goal | Mechanism |
|---|---|
| Add a model provider | register an adapter on `ctx.llm` |
| Add a model-facing capability | register a tool on `ctx.tools`; schemas flow into prompt assembly |
| Add command execution | implement and register a `ctx.bash` backend |
| Add a long-running/background capability | register the work on `ctx.tasks`; the generic `task_*` tools collect/stop it |
| Add filesystem access or policy | implement a `ctx.fs` provider or listen on `fs/*` policy events |
| Confine spawned processes | a `ctx.sandbox` backend; consumers wrap their argv before spawning |
| Intercept prompts, requests, tool use, or continuation | listen on the relevant `agent/*` or `tools/*` waterfall; use serial `agent/turn-stop` for a monotonic terminal stop |
| Add a session-stable request prefix outside history | compose it on `agent/session-prefix`, once per loop instance; logged on the request header |
| Add UI or editor integration | drive `ctx.agents` and render from `session/event` |
| Add durable session state | add a `SessionEventMap` member and render/replay from the log |
| Fork a live session | use `ctx.sessions.fork(source, boundary?, childSessionId?)` |
| Scope a tool, prompt section, or listener to ONE agent | register it through that agent's `agent.ctx` (see Agent Scope) |

The [extension cookbook](cookbook/extension-cookbook.md) carries plugin skeletons and the feature-to-seam map; step-by-step guides cover [packages](cookbook/adding-a-package.md), [tools](cookbook/adding-a-tool.md), [LLM adapters](cookbook/adding-an-llm-adapter.md), and [vendored packages](cookbook/adding-a-vendored-package.md).

## Quick Reference
- Domain terms in the [glossary](glossary.md)
- Type definitions in [core-data-structures/](core-data-structures/core.md)
- Exact event and service signatures in [events](cordis-catalog/events.md)
- [services](cordis-catalog/services.md) catalogs
- package contracts in the [package map](../packages/README.md)
- [RFCs](rfc/README.md)
