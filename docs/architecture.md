# DeepSeek Harness Architecture

The **DeepSeek Harness SDK** is an agent-runtime SDK built microkernel-style on the vendored Cordis framework. The governing principle is simple: **everything is a plugin**. The shipped loop plugin drives the default agent lifecycle, but it is still replaceable; most behavior attaches through typed service and event seams that a replacement loop would honor.

Read this page as the system map before changing `packages/`. It covers behavior: services, loop lifecycle, extension seams, and invariants. Type shapes live in [core-data-structures/](core-data-structures/core.md); exact signatures in the generated [events](cordis-catalog/events.md) and [services](cordis-catalog/services.md) catalogs; diagrams in the [documentation graph index](graph-atlas.md); package contracts in the [package map](../packages/README.md); rationale in the [RFCs](rfc/README.md).

## Mental Model

A running harness is one Cordis context. Packages contribute three things to it:

- **Services** on `ctx.<key>`: stable call surfaces such as `ctx.llm`, `ctx.tools`, or `ctx.sessions`.
- **Events**: typed interception and notification seams such as `agent/request`, `tools/pre-execute`, or `session/event`.
- **Registrations**: prompt sections, tool schemas, adapters, providers, and listeners, all installed through disposable effects so teardown and hot reload unwind them.

The default loop is intentionally ordinary: drain queued work, assemble a request, stream a model answer, run tools, decide whether to continue, flush durable state. The important part is where it pauses: each pause is a seam a plugin can program against.

## Service Map

The default agent spine is assembled from these packages under [`packages/core/`](../packages/core/README.md):

| ctx key | Package | Role |
|---|---|---|
| `ctx.sessions` | `dsh-session` | in-memory event-sourced sessions |
| `ctx.systemPrompt` | `dsh-system-prompt` | ordered prompt sections plus tool schemas |
| `ctx.tools` | `dsh-tools` | tool registry and execution pipeline |
| `ctx.agents` | `dsh-agent` | live agent registry, public `Agent` handle, `agent/*` vocabulary |
| `ctx.agentLoop` | `dsh-agent-loop` | the shipped `ReactLoopAgent` driver |

Tool schemas ride in prompt assembly, so "what the model is told it can do" stays coherent ([assembly RFC](rfc/implemented/architecture/2026-06-11-tool-schemas-in-prompt-assembly.md)). Tool execution runs through `tools/pre-execute` → dispatch → `tools/post-execute`, the gate pair for sandbox, permission, hook, and plan-mode plugins ([pipeline graph](tool-execution-pipeline.md)).

The swappable capability seams sit around that spine:

| ctx key | Package family | Role |
|---|---|---|
| `ctx.llm` | [`llm/`](../packages/llm/README.md) | adapter registry and streaming model calls |
| `ctx.bash` | [`bash/`](../packages/bash/README.md) | foreground/background command execution |
| `ctx.fs` | [`fs/`](../packages/fs/README.md) | filesystem provider primitives; `fs/*` policy events |
| `ctx.web` | [`web/`](../packages/web/README.md) | search/fetch provider registries |
| `ctx.compact` | [`compact/`](../packages/compact/README.md) | session-surface compaction |
| `ctx.subagents` | [`subagent/`](../packages/subagent/README.md) | named delegation providers |
| `ctx.sessionPersistence` | [`session-persistence/`](../packages/session-persistence/README.md) | durable storage for session logs |

Extension plugins depend on interfaces and event vocabulary, never on `dsh-agent-loop`; swapping the loop means shipping a different bundle. The sanctioned exception is `dsh-agent-core`, whose job is to compose the default spine.

## Cordis In Five Ideas

Cordis is vendored source the harness owns ([manifest + sync](../vendor/README.md)). A plugin author needs five ideas: plugins are modules with optional `inject` and `apply(ctx)`, or `Service` subclasses; services own `ctx` keys; `inject` waits for required services; events are typed by declaration merging and dispatch as emit, waterfall, parallel, or serial; registrations are disposable effects.

## Cordis Waterfall Semantics

`ctx.waterfall` is around-middleware, not a reducer. A listener receives `(...args, next)`: call `next()` to delegate, optionally wrapping the result; return without `next()` to short-circuit; use `prepend: true` only when it must run first. Values propagate through `next()`'s return value. Cooperative listeners mutate a shared object and then delegate; returning a replacement is a takeover because earlier mutations on the old object disappear downstream. For single-slot decision events such as `fs/write-intent`, returning without `next()` is the point: the first decider owns the decision.

## Event Taxonomy

Each service declares its own events; `agent/*` lives in `dsh-agent`, so extensions use the live agent vocabulary without depending on the concrete loop. Capability events belong to the seam that owns their vocabulary: `tools/*`, `llm/*`, `system-prompt/*`, `fs/*`, `subagent/*`, and `session/flush`. The generated [events catalog](cordis-catalog/events.md) is exhaustive; [event-producer-consumer.md](event-producer-consumer.md) shows topology.

Domain rule: `session/*` is durable, replayable fact; `agent/*` is live runtime surface ([event-domain RFC](rfc/implemented/architecture/2026-06-30-event-domain-semantics.md)). Reloadable UI state belongs on the session log; hooks, status observers, request mutation, prompt gating, step-result validation, and continuation policy belong on the live agent surface.

## Loop Lifecycle (Session / Turn / Step)

A **session** is one agent's append-only event log. A **turn** drains one queued batch and runs until the model stops asking for tools and no plugin requests continuation. A **step** is one model request plus the tool executions caused by that response. In the contract below ([sequence companion](agent-lifecycle.md)), every `'quoted'` line appends a durable session event and every `waterfall`/`serial` line is an extension seam.

### Turn Flow

```text
create agent -> emit agent/session-start(source)    once per live agent
forever:
  wait for queued messages (idle)
  emit agent/status(running)
  TURN:
    'turn/start'
    each queued msg: waterfall agent/prompt-submit  allow, rewrite, attach context, or block
      allow -> session('user/message'...); inject additionalContext
    every prompt blocked -> 'turn/end'(rejected)    zero-step turn, model never called
    STEP loop:
      drain steering
      assembly = ctx.systemPrompt.assemble()        waterfall system-prompt/assemble
      await ctx.serial('agent/pre-step')            surface mutation before history derivation
      session('step/start')
      req = {model, system, tools, messages: session.deriveMessages(), signal}
      req = waterfall agent/request                 hooks, model switch, tool filtering
      stream ctx.llm.stream(req)                    waterfall llm/stream
        session('assistant/chunk')
      if assembler.finish is error/aborted: throw
      msg = waterfall agent/step-result             before the log append
      session('assistant/message' {content, usage?})
      each tool-call (sequential, abort-checked between calls):
        session('tool/call'); ctx.tools.execute()
          tools/pre-execute -> dispatch -> tools/post-execute
          tools may append their own session events, e.g. todo/write
        session('tool/result')
      append buffered post-execute context -> session('context/message')*
      drain steering -> session('steering/message')
      session('step/end')
      cont = waterfall agent/turn-continuation      continue iff tool calls or steering by default
      continue reasons become next-step steering
      if action == stop: break
  session('turn/end')
  await ctx.parallel('session/flush', session)
  leftover steering re-enqueued as queued messages
  emit agent/status(idle) unless more queued
```

Post-tool context lands after all tool results so tool-call/result adjacency stays stable. Steering drains between steps; leftover steering after a turn is re-queued.

### Failure Boundaries

The turn is the containment boundary. A throwing listener, adapter error finish, or failed step ends the current turn with an error reason and reports live diagnostics through `agent/error`; it does not kill the driver loop. `cancel()` clears queued and steering work, aborts the active model/tool boundary when possible, and records the appropriate turn end. Disposal stops the loop, awaits quiescence, unregisters the agent, and lets service disposers drain.

Every session event is turn-enclosed. Reloading a crashed session preserves the interrupted tail and closes it with a synthetic `interrupted` turn end. A failure after `turn/end`, such as a rejecting `session/flush`, reports through `agent/error` only because no safe in-turn position remains. A turn ends with one `TurnEndReason` (`completed`, `aborted`, `error`, `disposed`, `max-tokens`, `rejected`, or `interrupted`); per-variant semantics are in [session.md § TurnEndReasonMap](core-data-structures/session.md#why-a-turn-ended-turnendreasonmap).

## Agents And Subagents

`Agent` is the handle every plugin programs against: `send()` queues work, `steer()` injects mid-turn content, `inject()` appends context and opens a one-shot `injection` turn when idle, `cancel()` is the single public stop primitive, and `whenIdle()` observes quiescence. The factory returns `AgentHandle { agent, dispose() }`; lifecycle owners tear down with `await dispose()`. Full semantics: [core.md](core-data-structures/core.md), [lifecycle RFC](rfc/implemented/architecture/2026-06-18-agent-lifecycle-and-ownership-seams.md).

**Subagents** are a seam, not an `Agent` method: `ctx.subagents` is a named-provider registry (`spawn` starts fresh, `fork` seeds from the parent's completed-turn prefix, ACP drives an out-of-process child); children are ordinary agents ([subagent.md](core-data-structures/subagent.md), [subagent RFC](rfc/implemented/feature/2026-06-21-subagent-capability-seam.md)).

## The Session Log Is The Truth

A `Session` is the single source of truth. `deriveMessages()` projects surface events into the `Message[]` sent to the model; raw `assistant/chunk` events stay in the log for replay/UI fidelity and are skipped. Every other consumer is a derived view too: replay/fork seeds from events, trace/telemetry listens to `session/event`, and resume goes through `ctx.agents.resume({ resumeSessionId })` ([event-sourcing RFC](rfc/implemented/architecture/2026-06-11-event-sourced-sessions.md)).

Durability is a plugin concern: `session/event` is synchronous, persistence backends buffer write-behind, and the loop awaits `session/flush` at every turn end. The `SessionPersistence` seam stores `SessionEvent` directly, with metadata in `SessionHeader`; JSONL and SQLite share one contract suite ([persistence RFC](rfc/implemented/architecture/2026-06-14-session-persistence.md), [write-coordinator RFC](rfc/implemented/architecture/2026-06-18-shared-persistence-write-coordinator.md)).

## Content Blocks And Streaming (dsh-llm)

Messages are arrays of typed content blocks (`text`, `reasoning`, `tool-call`, `tool-result`). The union derives from the merge-extensible `ContentBlockMap`; the same pattern types `MessageSource`, `FinishReason`, `TurnTrigger`, and `TurnEndReason`. The core set is limited to blocks every shipping path honors; new block types land in one coordinated change across adapters, UI bridges, and compaction pricing ([drop-image RFC](rfc/implemented/simplification/2026-07-04-drop-image-content-block.md)).

Streaming is a raw chunk protocol (`block-start` through `finish`) with `BlockAssembler` as the shared chunk-to-block assembler. The loop logs raw chunks for replay while assembling them for dispatch. `LlmAdapter` is the provider seam: subclass, implement `stream()`, register with `ctx.llm.registerAdapter(models, adapter)`; `dsh-llm-deepseek` and `dsh-llm-pi-ai` are deliberate design twins ([twin RFC](rfc/implemented/architecture/2026-06-13-twin-llm-adapters.md)). StreamChunk conventions live in [llm-streaming.md](core-data-structures/llm-streaming.md).

## Capability Seams

A swappable capability splits into **interface / implementation / consumer**: the interface owns the `ctx` key and vocabulary; an implementation registers a backend; a consumer exposes model-facing behavior through `ctx.tools` or prompt assembly. The bash trio is the reference shape, and the mechanism is plain Cordis services plus `inject` ([capability-seams RFC](rfc/implemented/architecture/2026-06-13-capability-seams.md), [seam graph](capability-seams.md)).

Some seams bend the template deliberately. LLM keeps interface and consumer vocabulary together because adapters are the implementations. Filesystem adds policy as an event gate: `dsh-tool-fs` dispatches `fs/write-intent`, `fs/edit-intent`, and `fs/observed`, while `dsh-fs-policy` listens without becoming a method service ([event-gate RFC](rfc/implemented/architecture/2026-06-26-file-context-as-event-gate.md)). Web is one service with search and fetch provider registries, so provider swaps do not rename model tools ([web-seam RFC](rfc/implemented/architecture/2026-06-24-web-capability-seam.md)). Subagents use a named provider registry because multiple delegation backends can coexist.

## Composition

`dsh-agent-core` is the composition bundle: one plugin loading the providerless spine as code ([README](../packages/core/agent-core/README.md)). App packages compose it with a front door and own the boot `bin`: `dsh-stdio-agent` for the terminal REPL, and `dsh-acp-agent` for ACP over JSON-RPC stdio with no stdout logger ([ui/](../packages/ui/README.md), [app-extraction RFC](rfc/implemented/architecture/2026-06-20-extract-example-app-packages.md)). A deployment is a thin `cordis.yml` leaf: swappable backends, one app entry, and optional product tools ([examples/](../examples/AGENTS.md), [runnable wirings](cookbook/extension-cookbook.md#runnable-wirings), [graph atlas](graph-atlas.md)).

## Extending The Harness

New behavior should attach to a documented seam; changing `dsh-agent-loop` itself requires updating this map.

| Goal | Mechanism |
|---|---|
| Add a model provider | register an adapter on `ctx.llm` |
| Add a model-facing capability | register a tool on `ctx.tools`; schemas flow into prompt assembly |
| Add an executor or storage backend | implement the owning seam and register the service |
| Intercept prompts, requests, tool use, or continuation | listen on the relevant `agent/*` or `tools/*` waterfall |
| Add UI or editor integration | drive `ctx.agents` and render from `session/event` |
| Add durable session state | add a `SessionEventMap` member and render/replay from the log |

The [extension cookbook](cookbook/extension-cookbook.md) carries plugin skeletons and the feature-to-seam map; step-by-step guides cover [packages](cookbook/adding-a-package.md), [tools](cookbook/adding-a-tool.md), [LLM adapters](cookbook/adding-an-llm-adapter.md), and [vendored packages](cookbook/adding-a-vendored-package.md).
