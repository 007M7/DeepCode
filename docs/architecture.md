# DeepSeek Harness Architecture

DeepSeek Harness is the plugin runtime behind **DeepSeek Code**. The governing idea is small and strict: the harness core owns the vocabulary and the turn driver, and every product capability is a Cordis plugin attached through a typed service or event seam. Model adapters, tools, persistence, filesystem access, hooks, UI bridges, compaction, and subagents all enter the system the same way.

Read this page as the system map before changing `packages/`. It describes behavior: what services exist, how a turn moves through the loop, where plugins extend it, and which invariants keep replay and hot reload sane. Literal type shapes live in [core-data-structures/](core-data-structures/core.md), exact event and service signatures live in the generated [events](cordis-catalog/events.md) and [services](cordis-catalog/services.md) catalogs, visual relationship maps live in the [documentation graph index](graph-atlas.md), and package-level contracts live in the package READMEs from the [package map](../packages/README.md).

## The Mental Model

A running harness is one Cordis context. Packages contribute three kinds of things to it:

- **Services** on `ctx.<key>`: stable call surfaces such as `ctx.llm`, `ctx.tools`, or `ctx.sessions`.
- **Events**: interception and notification seams such as `agent/request`, `tools/pre-execute`, or `session/event`.
- **Registrations**: prompt sections, tool schemas, adapters, providers, and listeners, all installed through `ctx.effect()`, `ctx.on()`, or `ctx.waterfall()` so disposal unwinds them.

The default agent loop is intentionally ordinary: drain queued work, assemble a request, stream a model answer, run tools, decide whether to continue, flush durable state. The important part is where the loop pauses. Every pause is a seam a plugin can program against without reaching into loop internals.

That rule is the design pressure behind the repo layout. Interface packages own vocabulary and `ctx` keys; implementation packages register concrete backends; consumer packages expose model-facing tools or app-facing bridges. A product feature should usually be a plugin on an existing seam, not a patch to `dsh-agent-loop`.

## Service Map

The product spine in [`packages/core/`](../packages/core/README.md) is the minimum language of an agent run:

| ctx key | Package | Role |
|---|---|---|
| `ctx.sessions` | `dsh-session` | in-memory event-sourced sessions |
| `ctx.systemPrompt` | `dsh-system-prompt` | ordered prompt sections plus tool schemas |
| `ctx.tools` | `dsh-tools` | tool registry and execution pipeline |
| `ctx.agents` | `dsh-agent` | live agent registry, public `Agent` handle, `agent/*` vocabulary |
| `ctx.agentLoop` | `dsh-agent-loop` | the concrete `ReactLoopAgent` driver |

The swappable seams sit around that spine:

| ctx key | Package family | Role |
|---|---|---|
| `ctx.llm` | [`llm/`](../packages/llm/README.md) | adapter registry and streaming model calls |
| `ctx.bash` | [`bash/`](../packages/bash/README.md) | foreground/background command execution |
| `ctx.fs` | [`fs/`](../packages/fs/README.md) | filesystem provider primitives; `fs/*` policy events |
| `ctx.web` | [`web/`](../packages/web/README.md) | search/fetch provider registries |
| `ctx.compact` | [`compact/`](../packages/compact/README.md) | session-surface compaction |
| `ctx.subagents` | [`subagent/`](../packages/subagent/README.md) | named delegation providers |
| `ctx.sessionPersistence` | [`session-persistence/`](../packages/session-persistence/README.md) | durable storage for session logs |

`dsh-agent-core` is the sanctioned composition exception to the dependency rule: it depends on the concrete loop because its job is to assemble the default providerless spine. Extension plugins depend on interfaces and event vocabulary, never on `dsh-agent-loop`; swapping the loop means shipping a different bundle, not rewiring every extension.

## Capability Seams

The default seam shape is **interface / implementation / consumer**. The interface package owns the `ctx` key, abstract service, event vocabulary, and shared types. An implementation package registers one concrete backend. A consumer package, often a `tool-*` package, depends only on the interface and registers model-facing behavior through `ctx.tools` or prompt assembly. The bash family is the reference shape: `dsh-bash`, `dsh-bash-local`, `dsh-tool-bash`.

Several seams intentionally bend that template. The LLM seam keeps interface and consumer vocabulary together because adapters are the only implementations. The filesystem family adds `dsh-fs-policy` as an event-gate plugin: `dsh-tool-fs` dispatches `fs/write-intent`, `fs/edit-intent`, and `fs/observed`, while the policy listens without becoming a method service the tool must inject. The web seam is one service with search and fetch provider registries, so provider swaps do not rename model tools. The subagent seam is a named provider registry because multiple delegation backends can coexist in one context.

## Cordis Waterfall Semantics

`ctx.waterfall` is around-middleware, not a reducer. A listener receives `(...args, next)` and chooses one of three behaviors:

- call `next()` to delegate to later listeners and the core behavior, optionally wrapping the result;
- return without calling `next()` to short-circuit with its own result;
- register with `prepend: true` when it must run before existing listeners.

Values propagate through `next()`'s return value. Cooperative listeners mutate a shared object and then delegate; replacing an object is a takeover, because earlier mutations on the old object will not be seen downstream. For single-slot decision events such as `fs/write-intent`, returning without `next()` is the point: the first decider owns the decision.

## Sessions And Messages

A `Session` is an append-only log of typed `SessionEvent`s. The log is the source of truth for replay, UI rendering, persistence, and derived model history. `deriveMessages()` projects surface events into the `Message[]` sent to the model; raw `assistant/chunk` entries stay in the log for replay and transcript fidelity but do not become prompt history. Persistence backends subscribe to `session/event`, buffer snapshots of appended events, and drain them at the awaited `session/flush` checkpoint.

Messages are arrays of typed content blocks from `dsh-llm`: `text`, `reasoning`, `tool-call`, and `tool-result`. The block union, message sources, finish reasons, turn triggers, turn-end reasons, and session event variants use the merge-extensible-map pattern documented in [core-data-structures](core-data-structures/core.md). A plugin can extend a map, but every shipping path that observes the new variant must be taught what it means.

## Loop Lifecycle

The loop uses three nested units:

- **Session**: the full append-only event log for one agent.
- **Turn**: one drained batch of queued work, running until the model stops asking for tools and no plugin requests continuation.
- **Step**: one model request plus the tool executions caused by that response.

One turn follows this shape:

```text
agent/session-start                    once per live agent
turn/start                             durable boundary
  agent/prompt-submit                  allow, rewrite, attach context, or block each queued prompt
  system-prompt/assemble               sections + tool schemas
  agent/pre-step                       surface mutation before history derivation, e.g. compaction
  step/start                           durable boundary
    agent/request                      mutate the GenerateOptions before the model call
    llm/stream                         stream raw chunks from the selected adapter
    assistant/chunk*                   replay/UI facts
    agent/step-result                  inspect or rewrite the assembled assistant message
    assistant/message                  the message used for tool dispatch and future history
    tool/call -> ctx.tools.execute -> tool/result
      tools/pre-execute                allow, deny, or ask before dispatch
      tools/post-execute               accept, block, replace output, or attach context
    context/message*                   buffered post-tool context, after all tool results
    steering/message*                  mid-turn steering for the next step
  step/end                             durable boundary
  agent/turn-continuation              continue or stop
turn/end                               durable boundary
session/flush                          awaited durability checkpoint
```

Tool calls are sequential, and the loop checks cancellation between calls. Post-tool context is appended after all tool results so the tool-call/result adjacency remains stable. Steering injected while a turn is running is drained between steps; leftover steering after a turn is re-queued so it is never stranded.

## Event Domains

`session/*` events are durable, replayable facts. Anything a UI can reconstruct after reload, including transcript surface, todo state, hook provenance, compaction records, and crash recovery markers, belongs on the session log or a merge-extensible session event.

`agent/*` events are the live runtime surface. They carry an `Agent` object and power hooks, status observers, request mutation, prompt gating, step-result validation, and continuation policy. The declarations live in `dsh-agent`, not in `dsh-agent-loop`, so plugins can depend on the public agent vocabulary without depending on the concrete loop.

Capability events belong to the seam that owns their vocabulary: `tools/*` for tool execution, `llm/*` for model streaming, `system-prompt/*` for assembly, `fs/*` for filesystem policy, `subagent/*` for delegation runs, and `session/flush` for durability. The generated [events catalog](cordis-catalog/events.md) is the exhaustive reference and is freshness-gated.

## Failure Boundaries

The turn is the loop's containment boundary. A throwing listener, adapter error finish, or failed step ends the current turn with an error reason and reports live diagnostics through `agent/error`; it does not kill the driver loop. `cancel()` clears queued and steering work, aborts the active model/tool boundary when possible, and records the appropriate turn end. Disposal stops the loop, awaits quiescence, unregisters the agent, and lets service disposers drain their work.

Every session event is turn-enclosed. A backend that reloads a crashed session preserves the interrupted tail and closes it with a synthetic `interrupted` turn end rather than truncating real work. A failure after `turn/end`, such as a rejecting `session/flush`, is reported through `agent/error` only because there is no safe in-turn position left for a durable session event.

## Extending The Harness

Start from the extension point, not the loop:

| Goal | Mechanism |
|---|---|
| Add a model provider | register an adapter on `ctx.llm` |
| Add a model-facing capability | register a tool on `ctx.tools`; schemas flow into prompt assembly |
| Add an executor or storage backend | implement the owning seam and register the service |
| Intercept prompts, requests, tool use, or continuation | listen on the relevant `agent/*` or `tools/*` waterfall |
| Add UI or editor integration | drive `ctx.agents` and render from `session/event` |
| Add durable session state | add a `SessionEventMap` member and render/replay from the log |

The [extension cookbook](cookbook/extension-cookbook.md) maps common features to seams, and the step-by-step guides cover [packages](cookbook/adding-a-package.md), [tools](cookbook/adding-a-tool.md), [LLM adapters](cookbook/adding-an-llm-adapter.md), and [vendored packages](cookbook/adding-a-vendored-package.md). When a change seems to require editing `dsh-agent-loop`, first name the missing seam; if the loop really changes, update this map in the same PR.
