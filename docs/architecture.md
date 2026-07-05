# DeepSeek Harness Architecture

The **DeepSeek Harness SDK** is an SDK for building agent harnesses using the Cordis framework. The governing principle is simple: **everything is a plugin**. For example, the shipped agent loop is just one plugin in the default bundle, not a privileged kernel.

Read this page as the system map before changing `packages/`. It explains how the runtime is shaped, how the default loop moves work, where state lives, and where extensions attach. Type shapes live in [core-data-structures/](core-data-structures/core.md); exact event and service signatures live in the generated [events](cordis-catalog/events.md) and [services](cordis-catalog/services.md) catalogs; package contracts live in the [package map](../packages/README.md); rationale lives in the [RFCs](rfc/README.md). If Cordis itself is new to you, start with the [Cordis primer](cordis-primer.md).

## System Shape

A running harness is one Cordis context. Packages contribute service keys, typed events, and disposable registrations to that context. Services are the stable call surfaces (`ctx.llm`, `ctx.tools`, `ctx.sessions`); events are interception and notification points (`agent/request`, `tools/pre-execute`, `session/event`); registrations install prompt sections, tool schemas, providers, adapters, and listeners.

The default distribution is a composition, not a hierarchy. `packages/core/` is a repository grouping for the default agent spine; capability seams around it are equally first-class plugins from a Cordis perspective.

### Default Service Spine

| ctx key | Package | Role |
|---|---|---|
| `ctx.sessions` | `dsh-session` | in-memory event-sourced sessions |
| `ctx.systemPrompt` | `dsh-system-prompt` | ordered prompt sections, tool schemas, and prompt variables |
| `ctx.tools` | `dsh-tools` | tool registry and [execution pipeline](tool-execution-pipeline.md) |
| `ctx.agents` | `dsh-agent` | live agent registry, public `Agent` handle, `agent/*` vocabulary |
| `ctx.agentLoop` | `dsh-agent-loop` | shipped `ReactLoopAgent` driver |

### Capability Services

| ctx key | Package family | Role |
|---|---|---|
| `ctx.llm` | [`llm/`](../packages/llm/README.md) | adapter registry and streaming model calls |
| `ctx.bash` | [`bash/`](../packages/bash/README.md) | foreground/background command execution |
| `ctx.fs` | [`fs/`](../packages/fs/README.md) | filesystem provider primitives and policy events |
| `ctx.web` | [`web/`](../packages/web/README.md) | search/fetch provider registries |
| `ctx.compact` | [`compact/`](../packages/compact/README.md) | session-surface compaction |
| `ctx.subagents` | [`subagent/`](../packages/subagent/README.md) | named delegation providers |
| `ctx.sessionPersistence` | [`session-persistence/`](../packages/session-persistence/README.md) | durable storage for session logs |

## Event Surface

Events are the harness extension API. Each service owns the vocabulary for the behavior it controls, and the generated [events catalog](cordis-catalog/events.md) is the exhaustive reference. The [producer/consumer map](event-producer-consumer.md) shows which packages emit or listen to each event.

### Event Domains

Use the event domain to decide where new behavior belongs:

- **Session events** are durable, replayable facts. Turn and step boundaries, user input, assistant output, tool calls, tool results, steering, compaction records, and tool-owned durable facts append to the session log and flow through `session/event`.
- **Agent events** are live runtime surfaces. They carry the live `Agent` handle for status, diagnostics, prompt admission, call-config shaping, result validation, and continuation policy.
- **Capability events** belong to the seam that owns the action. `tools/*`, `llm/*`, `system-prompt/*`, `fs/*`, and `subagent/*` let policy and adapters attach without importing the loop.

### Interception Semantics

Waterfall events behave like around-middleware: a listener delegates by calling `next()` and vetoes or takes over by returning without it. The full rule lives in [Cordis waterfall semantics](cordis-primer.md#cordis-waterfall-semantics).

## Default Loop Lifecycle

The shipped loop drains queued work, assembles a request, streams a model answer, executes tools, decides whether to continue, and checkpoints durable state. The important architecture is where it pauses: each pause is a documented service call or event seam that another plugin can program against.

A **session** is one agent's append-only event log. A **turn** drains one queued batch and runs until the model stops asking for tools and no plugin requests continuation. A **step** is one model request plus the tool executions caused by that response. In the flow below ([sequence companion](agent-lifecycle.md)), quoted names are durable session events and event names are extension seams.

### Turn Flow

```text
create agent -> emit agent/session-start(source)
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
      agent/pre-step
      'step/start'
      snapshot the derived messages (the reconstruction boundary)
      agent/request (config only) -> log request/header -> llm/stream (frozen)
        'assistant/chunk'
      agent/step-result
      'assistant/message'
      each tool call:
        'tool/call'
        tools/pre-execute -> dispatch -> tools/post-execute
        'tool/result'
      append post-tool context and steering
      'step/end'
      agent/turn-continuation
      stop unless tools or continuation policy ask for another step
    'turn/end'
    checkpoint persistence and notify idle/running status
```

Prompt assembly is single-path: `renderPrompt(assemble({ agent }))` IS the system prompt sent to the model. Plugins contribute ordered sections (static or computed from the per-call `AssembleContext`), tool schemas, and named variables interpolated as `{{name}}` at render — strictly, so an unknown or valueless reference fails the turn instead of shipping a hole. `dsh-system-prompt` itself owns the openers — the static `harness:identity` section (order −100) and the deployment's persona (order 0, from its `persona` config, shared by every agent in the context) — while the shipped loop registers the `model`/`cwd` variables; prompt-fact ownership is pinned by the [prompt-variables RFC](rfc/implemented/architecture/2026-07-05-prompt-variables-and-tool-guidance-ownership.md).

Post-tool context lands after all tool results so tool-call/result adjacency stays stable. Steering drains between steps; leftover steering after a turn is re-queued as ordinary input.

### Failure Boundaries

The turn is the containment boundary. A throwing listener, adapter error finish, or failed step ends the current turn with an error reason and reports live diagnostics through `agent/error`; it does not kill the driver loop. `cancel()` clears queued and steering work, aborts the active model/tool boundary when possible, and records the appropriate turn end. Disposal stops the loop, awaits quiescence, unregisters the agent, and lets service disposers drain.

Every session event is turn-enclosed. Reloading a crashed session preserves the interrupted tail and closes it with a synthetic `interrupted` turn end. A failure after the durable turn has closed reports through `agent/error` only because no safe in-turn position remains. A turn ends with one `TurnEndReason` (`completed`, `aborted`, `error`, `disposed`, `max-tokens`, `rejected`, or `interrupted`); per-variant semantics are in [session.md § TurnEndReasonMap](core-data-structures/session.md#why-a-turn-ended-turnendreasonmap).

### Agent Handles

`ctx.agents` owns live agents and returns an `AgentHandle { agent, dispose() }`. `Agent` is the surface other plugins drive: `send()` queues work, `steer()` injects mid-turn content, `inject()` appends context and opens a one-shot injection turn when idle, `cancel()` is the public stop primitive, and `whenIdle()` observes quiescence. Lifecycle owners tear down with `await dispose()`.

## State And Model Surface

### Session Log

The session log is the source of truth. `deriveMessages()` projects session events into the `Message[]` sent to the model; raw `assistant/chunk` events stay in the log for replay and UI fidelity. Replay, fork, resume, transcript rendering, telemetry, and persistence all derive from the same event stream.

**Model-visible ⟺ logged**: the log reconstructs every conversation request byte-for-byte — messages by derivation at the `step/start` boundary, the header (system prompt, tools, model + sampling) by folding `request/header` events — asserted per request by the dev invariant ([reconstructability RFC](rfc/implemented/architecture/2026-07-05-reconstructable-requests.md)).

Durability is a plugin concern. Persistence backends buffer synchronous `session/event` notifications and the loop awaits a turn-end checkpoint before moving on. The `SessionPersistence` seam stores `SessionEvent` directly, with metadata in `SessionHeader`; JSONL and SQLite share one contract suite.

### Model Content

Messages are arrays of typed content blocks (`text`, `reasoning`, `tool-call`, `tool-result`). The union derives from the merge-extensible `ContentBlockMap`; the same pattern types `MessageSource`, `FinishReason`, `TurnTrigger`, and `TurnEndReason`. New block types are coordinated across adapters, UI bridges, compaction pricing, and persistence, so block vocabulary remains a repo-wide contract.

Streaming is a raw chunk protocol (`block-start` through `finish`) with `BlockAssembler` as the shared chunk-to-block assembler. The loop logs raw chunks while assembling them for dispatch. `LlmAdapter` is the provider seam: subclass, implement `stream()`, and register with `ctx.llm.registerAdapter(models, adapter)`. StreamChunk conventions live in [llm-streaming.md](core-data-structures/llm-streaming.md).

## Extension And Composition

### Capability Pattern

A swappable capability usually splits into **interface / implementation / consumer**: the interface owns the `ctx` key and vocabulary; an implementation registers a backend; a consumer exposes model-facing behavior through `ctx.tools` or prompt assembly. The bash trio is the reference shape, and the [capability seam graph](capability-seams.md) shows the current package families.

Some seams bend the template deliberately. LLM keeps interface and consumer vocabulary together because adapters are the implementations. Filesystem adds policy as event gates around provider primitives. Web is one service with search and fetch provider registries, so provider swaps do not rename model tools. Subagents use a named provider registry because multiple delegation backends can coexist; `spawn` starts fresh, `fork` seeds from the parent's completed-turn prefix, and ACP can drive an out-of-process child ([subagent.md](core-data-structures/subagent.md)).

### Bundles And Apps

`dsh-agent-core` is the default composition bundle: one plugin loading the providerless spine as code ([README](../packages/core/agent-core/README.md)). App packages compose it with a front door and own the boot `bin`: `dsh-stdio-agent` for the terminal REPL, and `dsh-acp-agent` for ACP over JSON-RPC stdio with no stdout logger ([ui/](../packages/ui/README.md)). A deployment is a thin `cordis.yml` leaf: swappable backends, one app entry, and optional product tools ([examples/](../examples/AGENTS.md), [runnable wirings](cookbook/extension-cookbook.md#runnable-wirings), [graph atlas](graph-atlas.md)).

### Where New Behavior Goes

New behavior should attach to a documented seam; changing the shipped loop requires updating this map.

| Goal | Mechanism |
|---|---|
| Add a model provider | register an adapter on `ctx.llm` |
| Add a model-facing capability | register a tool on `ctx.tools`; schemas flow into prompt assembly |
| Add command execution | implement and register a `ctx.bash` backend |
| Add filesystem access or policy | implement a `ctx.fs` provider or listen on `fs/*` policy events |
| Intercept prompts, requests, tool use, or continuation | listen on the relevant `agent/*` or `tools/*` waterfall |
| Add UI or editor integration | drive `ctx.agents` and render from `session/event` |
| Add durable session state | add a `SessionEventMap` member and render/replay from the log |

The [extension cookbook](cookbook/extension-cookbook.md) carries plugin skeletons and the feature-to-seam map; step-by-step guides cover [packages](cookbook/adding-a-package.md), [tools](cookbook/adding-a-tool.md), [LLM adapters](cookbook/adding-an-llm-adapter.md), and [vendored packages](cookbook/adding-a-vendored-package.md).
