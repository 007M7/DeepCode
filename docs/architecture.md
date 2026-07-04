# DeepSeek Harness Architecture

This document describes the architecture of the DeepSeek Harness — the foundation of **DeepSeek Code**. The governing principle, from the [microkernel design discussion][microkernel-doc]: **everything is a plugin**. The core is deliberately tiny — a handful of abstract services plus one concrete loop plugin (`dsh-agent-loop`) — and every product feature is a plugin against the extension surface described here, without modifying the loop.

This document covers **behavior**; type shapes live in [core-data-structures/](core-data-structures/core.md), the per-event/service reference in the [generated catalog](cordis-catalog/events-and-services.md), per-package contracts in the package READMEs ([map](../packages/README.md)). Requirement context: [Coding Harness MVP 需求分析][mvp-doc].

[microkernel-doc]: https://trtgsjkv6r.feishu.cn/wiki/VS9Lw1kQki6mDJk2UHocyuphnsc
[mvp-doc]: https://trtgsjkv6r.feishu.cn/wiki/ZwK6wfBE9i91V6kzMGYcgRGanxg

## Layering

```
┌────────────────────────────────────────────────────────────────┐
│  extension + implementation plugins                            │
│    dsh-agent-loop — THE concrete loop plugin                   │
│    LLM adapters · executors/backends · model-facing tools      │
│    subagent providers · hook bridges · UI bridges              │
├────────────────────────────────────────────────────────────────┤
│  interface/service packages (each owns a ctx key + vocabulary) │
│    dsh-agent · dsh-tools · dsh-system-prompt · dsh-session     │
│    dsh-llm · dsh-bash · dsh-fs · dsh-web · dsh-compact         │
│    dsh-subagent · dsh-session-persistence                      │
├────────────────────────────────────────────────────────────────┤
│  vendor/: pinned Cordis framework source (cordis, loader, …)   │
└────────────────────────────────────────────────────────────────┘
```

Dependency rule: extension plugins depend on interfaces, never on `dsh-agent-loop` (the loop is swappable); the sanctioned exception is the composition bundle `dsh-agent-core`, whose job is assembling the concrete spine ([full rule + generated graph](../packages/README.md#dependencies)).

## Service map

| ctx key | Package | Role |
|---|---|---|
| `ctx.llm` | dsh-llm | adapter registry; `stream()` |
| `ctx.sessions` | dsh-session | creates/holds event-sourced `Session`s |
| `ctx.sessionPersistence` | dsh-session-persistence | durable persistence: create/append/load/list |
| `ctx.systemPrompt` | dsh-system-prompt | ordered sections + tool schemas → `assemble()` |
| `ctx.tools` | dsh-tools | tool definitions; `execute()` through waterfall |
| `ctx.agents` | dsh-agent | live `Agent` handles + create/resume factory (returns `AgentHandle { agent, dispose() }`) |
| `ctx.agentLoop` | dsh-agent-loop | creates and drives `ReactLoopAgent`s |
| `ctx.bash` | dsh-bash | bash execution: foreground runs + background tasks |
| `ctx.fs` | dsh-fs | filesystem provider: read/stream, atomic writes/edits; owns the `fs/*` policy events |
| `ctx.compact` | dsh-compact | compaction: detect pressure, summarize an older range |
| `ctx.web` | dsh-web | search/fetch provider registries + `WebError` taxonomy |
| `ctx.subagents` | dsh-subagent | named provider registry for delegating to child agents |

All registrations go through `ctx.effect()` and return disposers, so hot-reload and fiber disposal clean up automatically (full service interfaces: the [generated catalog](cordis-catalog/events-and-services.md) `## Services` section).

## Capability seams: interface / implementation / consumer

Swappable capabilities split into three packages — **interface** (abstract service + vocabulary, owns the ctx key), **implementation** (a concrete subclass loaded as a plugin), **consumer** (what the model and plugins program against) — so each evolves independently; the bash trio is the template ([capability seams RFC](rfc/implemented/architecture/2026-06-13-capability-seams.md)). Keep interface + consumer together when they are one concern (the LLM seam: `dsh-llm` carries both, adapters implement); don't split preemptively.

Two seams bend the template deliberately:

- **Filesystem** adds a policy layer as an **event gate**, not a method service: `dsh-tool-fs` (the `read`/`write`/`edit` tools AND executor) dispatches `fs/*` intent events that `dsh-fs-policy` decides, so dropping the policy plugin degrades to the bare provider instead of breaking an injection ([event-gate RFC](rfc/implemented/architecture/2026-06-26-file-context-as-event-gate.md)). Paths resolve against the caller's session cwd, matching bash ([per-session cwd RFC](rfc/implemented/architecture/2026-07-02-fs-per-session-cwd.md)).
- **Web** folds search and fetch onto one seam: `ctx.web` is a provider REGISTRY (`registerSearchProvider`/`registerFetchProvider`, registration-order-independent selection); providers register like LLM adapters, and `dsh-tool-web` is the single consumer owning the tool schemas ([web seam RFC](rfc/implemented/architecture/2026-06-24-web-capability-seam.md)).

> The seam pattern is plain Cordis services + `inject` (a consumer's fiber stays pending until the service exists). Despite the name, `@cordisjs/plugin-capability` is unrelated — a permission-security service (a candidate for the deferred permissions work), not a mechanism for swapping implementations.

## The vocabulary (dsh-llm)

Messages are arrays of typed **content blocks** (`text`, `reasoning`, `tool-call`, `tool-result`, `image`); the union derives from the merge-extensible `ContentBlockMap`; the same pattern types `MessageSource`, `FinishReason`, `TurnTrigger`, `TurnEndReason`. Streaming is a raw chunk protocol (`block-start` … `finish`) with `BlockAssembler` as the single shared chunk→block assembler; the loop logs raw chunks (replay fidelity) while assembling them. `LlmAdapter` is the provider seam: subclass, implement `stream()`, register via `ctx.llm.registerAdapter(models, adapter)`; `dsh-llm-deepseek` and `dsh-llm-pi-ai` implement the one contract as deliberate design twins ([twin RFC](rfc/implemented/architecture/2026-06-13-twin-llm-adapters.md)). The StreamChunk conventions (usage/finish ordering, raw-string tool arguments, the two sanctioned error paths) are pinned in `dsh-llm/src/types.ts` and [llm-streaming.md](core-data-structures/llm-streaming.md).

## Event-sourced sessions (dsh-session)

A `Session` is an append-only log of typed `SessionEvent`s — the single source of truth. The LLM message history is *derived* (`deriveMessages()`): user/assistant messages, tool results, and envelope-tagged context/steering messages come from their events in chronological order (raw `assistant/chunk` events are replay/UI data, skipped; the per-event mapping is in [session.md](core-data-structures/session.md)). Replay/fork = `ctx.sessions.create(id, { seed })`; trace/telemetry = listen to `session/event` ([event-sourcing RFC](rfc/implemented/architecture/2026-06-11-event-sourced-sessions.md)).

**Durability**: `session/event` is a synchronous notification; persistence backends buffer write-behind and drain at the awaited `session/flush` checkpoint at every turn end. The abstract `SessionPersistence` seam defines create/append/load/list over `SessionEvent` (no parallel persisted type); metadata travels as `SessionHeader`; crash recovery preserves an interrupted turn by closing it with a synthetic `turn/end {interrupted}`. Two backends (JSONL, SQLite) pass one shared contract suite ([persistence RFC](rfc/implemented/architecture/2026-06-14-session-persistence.md), [write coordinator RFC](rfc/implemented/architecture/2026-06-18-shared-persistence-write-coordinator.md)). Resume = `ctx.agents.resume({ resumeSessionId })`.

## Prompt assembly (dsh-system-prompt)

Plugins contribute `PromptSection`s (named, ordered, static or computed) and tool-schema providers; `assemble()` returns `PromptAssembly { sections, tools }` through the `system-prompt/assemble` waterfall. Tool schemas are deliberately part of the assembly — "what the model is told it can do" is one coherent thing — though adapters transmit them as the wire-level `tools` field ([RFC](rfc/implemented/architecture/2026-06-11-tool-schemas-in-prompt-assembly.md)).

## Tool pipeline (dsh-tools)

`ToolRegistry.register()` takes schema + `execute()`; schemas flow into the assembly automatically. `execute()` runs through a two-waterfall pipeline — `tools/pre-execute` (a `PreToolDecision`: allow/deny/ask) → core dispatch → `tools/post-execute` (a `PostToolDecision`: accept/block, replace content, attach context) — the seams where sandbox, permission, hook, and plan-mode plugins live. A thrown tool still reaches `post-execute` as an `isError` result.

## Agents (dsh-agent) and the loop (dsh-agent-loop)

`Agent` is the handle every plugin programs against: `send()` (queued), `steer()` (mid-turn injection, drained between steps), `inject()` (in-session context; a one-shot `injection` turn when idle), `cancel()` (the single public stop primitive: clears queued + steering work, aborts the in-flight step, drops a turn about to start), `whenIdle()` (quiescence observation, not teardown), plus `session`/`status`/`options`. A lifecycle owner tears down via `await AgentHandle.dispose()` — stop, await exit, unregister. Full semantics: [core.md](core-data-structures/core.md), [lifecycle RFC](rfc/implemented/architecture/2026-06-18-agent-lifecycle-and-ownership-seams.md).

**Subagents** are a seam, not a method on `Agent`: `ctx.subagents` is a named-provider registry (`spawn` starts fresh, `fork` seeds the child with the parent's completed-turn prefix, ACP drives an out-of-process child); children are ordinary `Agent`s. See [subagent.md](core-data-structures/subagent.md), [subagent RFC](rfc/implemented/feature/2026-06-21-subagent-capability-seam.md).

### Loop lifecycle (session / turn / step)

- **Session**: the whole event log of one agent.
- **Turn**: ≥1 queued message; steps run until the model stops requesting tools and no plugin requests continuation.
- **Step**: one model request + its tool executions.

```
create agent → emit agent/session-start(source)       ⟵ once, before turn 1 (startup|resume)
forever:
  wait for queued messages (idle)
  emit agent/status(running)
  TURN (error-contained — a throwing plugin ends the turn, never the loop):
    'turn/start'                                        ⟵ durable turn boundary (no agent/* mirror)
    each queued msg: waterfall agent/prompt-submit      ⟵ allow (rewrite/+context) | block
      allow → session('user/message'…); inject additionalContext
    every prompt blocked → 'turn/end'(rejected), 0 steps ⟵ zero-step turn, model never called
    STEP loop:
      drain steering (late steering from previous step's listeners)
      assembly = ctx.systemPrompt.assemble()          ⟵ waterfall system-prompt/assemble
      await ctx.serial('agent/pre-step')              ⟵ surface mutation (compaction) OUTSIDE the step
      session('step/start')                           ⟵ durable step boundary (no agent/* mirror)
      req = {model, system, tools, messages: session.deriveMessages(), signal}
      req = waterfall agent/request                   ⟵ hooks, model switch
      stream ctx.llm.stream(req)                      ⟵ waterfall llm/stream (raw chunks)
        session('assistant/chunk')
      if assembler.finish is error/aborted: throw      ⟵ adapter's in-band error path →
                                                         step error (turn ends error/aborted,
                                                         not a normal completed message)
      msg = waterfall agent/step-result               ⟵ runs BEFORE the log append, so the
      session('assistant/message' {content, usage?})     log records what tool dispatch uses
      each tool-call (sequential, abort-checked between calls):
        session('tool/call'); ctx.tools.execute()     ⟵ waterfall tools/pre-execute (allow/
          deny/ask gate) → dispatch → tools/post-execute (accept/block, replace, +context)
          tool execution may append tool-owned session events, e.g. `todo/write`
        session('tool/result')
      append buffered post-execute additionalContext → session('context/message')(s)
                                                         ⟵ after ALL tool/results (adjacency)
      drain steering → session('steering/message'); emit agent/steering
      session('step/end')                             ⟵ durable step boundary (no agent/* mirror)
      cont = waterfall agent/turn-continuation(default = {action: hadToolCalls||steered
        ? 'continue' : 'stop'}) → ContinuationDecision
      a continue's reason is recorded as next-step steering (same turn); steering pending
        also forces continue (continuation OR step/end listeners — the /goal pattern)
      if action==stop: break
  session('turn/end')                                 ⟵ durable turn boundary (no agent/* mirror)
  await ctx.parallel('session/flush', session)        ⟵ durability checkpoint (failure
                                                         reported via agent/error, not fatal)
  leftover steering re-enqueued as queued messages    ⟵ steering is never stranded
  emit agent/status(idle) unless more queued
```

Error containment: a throwing listener or broken step ends the **turn** (`turn/end { reason: { kind: 'error', step, … } }`), never the driver loop; live diagnostics fire via `agent/error`; an adapter's in-band error/aborted finish chunk becomes a step error. `cancel()` is honored mid-stream and between tool calls; disposal mid-turn ends the turn `disposed`. A post-`turn/end` failure (a rejecting `session/flush`) is reported via `agent/error` only — the turn stays balanced, the backend keeps its buffer.

A turn ends with one `TurnEndReason` — `completed`, `aborted`, `error`, `disposed`, `max-tokens`, `rejected`, or `interrupted`; per-variant semantics (and the max-tokens-wins rule) are in [session.md § TurnEndReasonMap](core-data-structures/session.md#why-a-turn-ended-turnendreasonmap).

**Turn-enclosure invariant**: every session event lives inside a turn, making the turn the single durability/replay boundary — anything after the last `turn/end` is an interrupted-crash tail. `dsh-invariants` enforces it in dev ([invariant RFC](rfc/implemented/architecture/2026-06-15-turn-enclosure-invariant.md)).

### Event taxonomy

The `agent/*` events are declared in `dsh-agent` (so nothing depends on the loop package); each other service declares its own (`tools/*`, `llm/*`, `system-prompt/*`, `session/*`). The full catalog — signatures, dispatch modes, prose — is generated from source and freshness-gated: [cordis-catalog/events-and-services.md](cordis-catalog/events-and-services.md). Domain semantics (session = the fact log, agent = the live surface): [the event-domain RFC](rfc/implemented/architecture/2026-06-30-event-domain-semantics.md).

### Cordis waterfall semantics (important)

`ctx.waterfall` is **around-middleware**, not a value reducer. Each listener receives `(...args, next)`:

- call `next()` to delegate to later listeners (and ultimately the core behavior), possibly wrapping it;
- return a value **without** calling `next()` to short-circuit (veto);
- listeners run in registration order; `prepend: true` jumps the queue.

Composition caveat: values propagate through `next()`'s **return value** — a listener that returns a *new* object makes earlier listeners' mutations invisible downstream. Prefer mutate-then-`next()` for cooperative middleware; return a replacement only to take over the result.

## Extension guide

Plugin skeletons (tool, hook/permission gate, UI, protocol bridge) and the feature→mechanism map — which extension seam implements each product feature — live in [the extension cookbook](cookbook/extension-cookbook.md); step-by-step guides: [adding a package](cookbook/adding-a-package.md), [a tool](cookbook/adding-a-tool.md), [an LLM adapter](cookbook/adding-an-llm-adapter.md), [a vendored package](cookbook/adding-a-vendored-package.md).

## Deferred work (TODO)

Designed-for but not implemented: inter-agent channels beyond delegation (shared state, streaming output); the model-facing `/compact` consumer tool over `ctx.compact` ([compaction RFC](rfc/implemented/feature/2026-06-18-compaction-capability-seam.md)); parallel tool execution (concurrency-safety hints on `ToolDefinition`); session branching/tree if seed-based forking proves insufficient.
