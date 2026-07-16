# DeepSeek Harness Architecture

The **DeepSeek Harness SDK** builds agent harnesses on Cordis. The principle is simple: **everything is a plugin**. The shipped loop is one plugin, not a privileged kernel.

## Overview

A harness is one [Cordis](cordis-primer.md) context whose plugins contribute services, typed events, and disposable registrations.

`packages/core/` groups the default agent flow; surrounding capabilities are equally first-class Cordis plugins.

### Default Services

| ctx key | Package | Role |
|---|---|---|
| — | [`dsh-scope`](../packages/core/scope/README.md) | scoped-context registration primitive (library) |
| `ctx.sessions` | `dsh-session` | in-memory event-sourced sessions |
| `ctx.systemPrompt` | `dsh-system-prompt` | ordered prompt sections, tool schemas, and prompt variables |
| `ctx.tools` | `dsh-tools` | tool registry and [execution pipeline](tool-execution-pipeline.md) |
| `ctx.agents` | `dsh-agent` | live agent registry, public `Agent` handle, `agent/*` events |
| `ctx.agentExecution` | `dsh-agent-execution` | process-local ambient Agent identity for asynchronous driver work |
| `ctx.agentLoop` | `dsh-agent-loop` | shipped `ReactLoopAgent` driver |

### Capability Services

| ctx key | Package family | Role |
|---|---|---|
| `ctx.llm` | [`llm/`](../packages/llm/README.md) | adapter registry and streaming model calls |
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
| `ctx.sessionQuery` | [`session-query/`](../packages/session-query/README.md) | live-preferred logical-corpus and exact-event reads |

## Event

Events form the service extension API; see the exhaustive [events catalog](cordis-catalog/events.md) and [producer/consumer map](event-producer-consumer.md).

### Event Domains

- **Session events** are durable facts: turn/step boundaries, model input/output, tool activity, steering, compaction, and tool-owned records append to the log and flow through `session/event`.
- **Agent events** carry the live `Agent` handle through request and lifecycle policy.
- **Capability events** belong to the owning seam; policy and adapters attach without importing the loop.

### Interception Semantics

Waterfall events behave like around-middleware: a listener delegates by calling `next()`; returning without it vetoes or takes over. Full rule: [Cordis waterfall semantics](cordis-primer.md#cordis-waterfall-semantics).

## Default Loop Lifecycle

The shipped loop drains work, assembles and streams requests, executes tools, applies continuation policy, and checkpoints through plugin-visible services and events.

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
      'assistant/message'
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

The loop renders one prompt assembly per step. Plugins contribute ordered sections, tool schemas, and `{{name}}` variables; unknown or valueless references fail the turn instead of shipping a hole. `dsh-system-prompt` owns the harness identity and default deployment persona; an agent-scoped persona may shadow the default. The loop supplies `model` and `cwd`. See the [prompt-ownership RFC](rfc/implemented/architecture/2026-07-05-prompt-variables-and-tool-guidance-ownership.md).

Post-tool context follows all results, preserving call/result adjacency. Steering drains between steps and otherwise requeues after a turn. A terminal `agent/turn-stop` remains authoritative through turn close and flush, discarding later steering but preserving queued prompts.

### Failure Boundaries

The turn contains listener, adapter, and step failures: it records an error reason and emits `agent/error` without killing the driver. One explicit `AbortSignal` spans prompt submission, prompt assembly, all steps, continuation, turn close, and flush; `cancel()` clears pending work and carries a typed `user` or `parent` runtime cause, while the durable turn records only `aborted` and disposal remains a distinct higher-priority terminal state. Cooperative work must settle before the loop reports quiescence. See the [explicit turn cancellation decision](rfc/implemented/architecture/2026-07-16-explicit-turn-cancellation.md).

Every session event is turn-enclosed. Reload closes an interrupted tail with a synthetic `interrupted` end; failures after durable turn close only emit `agent/error`. A turn has one `TurnEndReason`; [TurnEndReasonMap](core-data-structures/session.md#why-a-turn-ended-turnendreasonmap) defines each variant.

### Agent Handles

`ctx.agents` owns live agents and returns `AgentHandle { agent, dispose() }`. Plugins drive `Agent` through `send()`, `steer()`, `inject()`, `cancel()`, and `whenIdle()`. The caller fiber and factory provider structurally co-own programmatic lifecycles; the consumer handle is the only other teardown capability, and all owners await one disposer.

### Agent Scope

Every live agent owns a scoped `agent.ctx`; its registrations shadow globals, receive only that agent's dispatches, and unwind with awaited cleanup. `CreateAgentOptions.setup(agentCtx)` composes the scope before publication. See the [scope](rfc/implemented/architecture/2026-07-08-agent-scope-contexts.md), [typed carrier checks](rfc/implemented/process/2026-07-14-typescript-program-backed-semantic-gates.md), and [subagent composition](rfc/implemented/feature/2026-07-12-subagent-persona-tool-filter-and-depth.md) decisions.

### Agent Execution Context

`AgentLoop` wraps each concrete driver in process-local `ctx.agentExecution`; its ALS frame contains only `{ agent }`. Child creation and setup stay outside the boundary, and turn, step, signal, cwd, and authority remain explicit. See the [package contract](../packages/core/agent-execution/README.md) and [decision](rfc/implemented/architecture/2026-07-15-agent-execution-context.md).

## State

### Session Log

The session log is the source of truth. `deriveMessages()` projects session events into the `Message[]` sent to the model; raw `assistant/chunk` events stay in the log for replay and UI fidelity. Replay, fork, resume, transcript rendering, telemetry, and persistence all derive from the same event stream.

**Model-visible ⟺ logged**: the log reconstructs every request — messages at `step/start` fronted by the header's session prefix, headers by folding `request/header` — and dev invariants assert this ([reconstructability RFC](rfc/implemented/architecture/2026-07-05-reconstructable-requests.md)).

Durability is a plugin concern. Persistence backends buffer synchronous `session/event` notifications and the loop awaits a turn-end checkpoint before moving on. The `SessionPersistence` seam stores `SessionEvent` directly, with metadata in `SessionHeader`; JSONL and SQLite share one contract suite.

### Model Content

Messages are arrays of typed content blocks (`text`, `reasoning`, `tool-call`, `tool-result`). The union derives from the merge-extensible `ContentBlockMap`; the same pattern types `MessageSource`, `FinishReason`, `TurnTrigger`, and `TurnEndReason`. New block types are coordinated across adapters, UI bridges, compaction pricing, and persistence, so block types remain a repo-wide contract.

Streaming is a raw chunk protocol (`block-start` through `finish`) with `BlockAssembler` as the shared chunk-to-block assembler. The loop logs raw chunks while assembling them for dispatch. `LlmAdapter` is the provider seam: subclass, implement `stream()`, and register with `ctx.llm.registerAdapter(models, adapter)`. StreamChunk conventions live in [llm-streaming.md](core-data-structures/llm-streaming.md).

## Extension And Composition

### Capability Pattern

A swappable capability usually splits into **interface / implementation / consumer**: the interface owns its `ctx` key and events, an implementation registers a backend, and a consumer exposes model behavior through tools or prompts. Bash is the reference; the [capability graph](capability-seams.md) shows every family.

Some seams bend the template deliberately. LLM keeps interface and consumer vocabulary together because adapters are the implementations. Filesystem adds policy gates around provider primitives. Web is one service with search and fetch provider registries, so provider swaps do not rename model tools. Skills and subagents use named provider registries; local skills scan project/user roots, and other providers can add embedded or remote catalogs without registry/tool changes. Subagents spawn fresh, fork from the parent's completed-turn prefix, or use ACP children ([subagent.md](core-data-structures/subagent.md)).

### Bundles And Apps

`dsh-agent-spine-demo` is the default composition bundle: one plugin loading the shared spine ([README](../packages/examples/agent-spine-demo/README.md)). App packages compose it with a front door and boot `bin`: `dsh-stdio-demo` for terminal REPL, and `dsh-acp-demo` for ACP over JSON-RPC stdio with no stdout logger ([ui/](../packages/ui/README.md)). `dsh-jsonrpc-agent` instead boots an external `cordis.yml`; the Python SDK injects the package default only when no explicit config channel is set and drives `dsh-jsonrpc` over line-delimited stdio JSON-RPC ([Python SDK](../python/README.md)). A deployment is a thin `cordis.yml` leaf: swappable backends, one app entry, and optional product tools ([examples/](../examples/AGENTS.md), [runnable wirings](cookbook/extension-cookbook.md#runnable-wirings), [graph atlas](graph-atlas.md)).

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
