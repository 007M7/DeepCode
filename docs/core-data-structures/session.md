# Sessions

The in-memory, event-sourced model of [dsh-session](../../packages/core/session). A `Session` is an **append-only log** of typed `SessionEvent`s — the single source of truth for an agent's whole interaction history. The LLM message history is *derived* from the log, never stored separately; replay is re-derivation from the same events. How the log is made **durable** (the persistence seam, backends, crash recovery) is the sibling concern on [persistence.md](persistence.md).

Source: [`packages/core/session/src/types.ts`](../../packages/core/session/src/types.ts)

## Context framing

`ContextEnvelope` selects the standard tagged projection or preserves a producer-owned complete frame. The latter changes framing only; the event remains a user-role `context/message` in chronological history.

```ts type-equiv
/** Canonical context-tag framing, or caller-owned framing rendered verbatim. */
type ContextEnvelope = 'context' | 'raw'
```

## `SessionEventMap` — the event vocabulary

The append-only event types. Merge-extensible: a plugin declares extra event types via declaration merging — e.g. the [compaction seam](compaction.md) adds `compact/start` / `compact/summary` / `compact/end`, and `@deepseek-ai/dsh-hook-protocol` adds log-only `hook/invoked` / `hook/result` provenance for a hook bridge. Like `compact/*`, these are NOT `SurfaceEventType`s (no `surfaceOp`). The generated [persistence log event catalog](../persistence-catalog.md) enumerates every member — core and merged — with its payload, surface badge, and declaration site.

```ts type-equiv
/**
 * The merge-extensible, append-only source of truth for an agent interaction.
 * Message history is derived from this log. Every event is lossless JSON and
 * sequence numbers stay contiguous, including raw chunks, so persistence can
 * store the canonical log verbatim.
 */
interface SessionEventMap {
  /**
   * Opens turn `turn`. `trigger` records what started it — a drained message
   * batch or an idle-time injection. The turn is the durability/replay
   * boundary: every event sits between a `turn/start` and its matching
   * `turn/end` (the turn-enclosure invariant).
   */
  'turn/start': { turn: number; trigger: TurnTrigger }
  /**
   * Closes turn `turn` with the {@link TurnEndReason} that ended it. The loop
   * fires the awaited `session/flush` checkpoint at every turn end, so the turn
   * boundary is also the durable-commit boundary.
   */
  'turn/end': { turn: number; reason: TurnEndReason }
  /** Opens step `step` of turn `turn` — one model call plus the tool executions it requested. */
  'step/start': { turn: number; step: number }
  /** Closes step `step` of turn `turn`. */
  'step/end': { turn: number; step: number }
  /** A user-visible prompt (queued message drained at turn start). */
  'user/message': { content: ContentBlock[]; source: MessageSource }
  /**
   * Durable record of a prompt veto and its reason. It is log-only: the blocked
   * prompt never enters the model-visible surface, including in a mixed batch.
   */
  'prompt/blocked': { content: ContentBlock[]; source: MessageSource; reason: string }
  /**
   * In-session context injection (file-change notices, subdir AGENTS.md,
   * skill content, cron notifications, …). Rendered into the derived history
   * as synthetic context — NOT a user prompt. `envelope: 'raw'` lets a caller
   * own the complete model-facing frame; `meta` is durable JSON state omitted
   * from the model projection.
   */
  'context/message': {
    content: ContentBlock[]
    source: MessageSource
    envelope?: ContextEnvelope
    meta?: JsonValue
  }
  /** Raw stream chunk — token-level replay fidelity. */
  'assistant/chunk': { turn: number; step: number; chunk: StreamChunk }
  /**
   * Assembled assistant message for one step (derived history uses this).
   * Carries the step's `usage` when the adapter reported token accounting, so
   * the model output and its accounting travel together (there is no separate
   * usage record). `usage` is absent when the adapter reported none.
   */
  'assistant/message': { turn: number; step: number; content: ContentBlock[]; provenance: AssistantProvenance; usage?: TokenUsage }
  /**
   * The model requested one tool invocation: `name` with the raw `arguments`
   * JSON string exactly as the model produced it (unparsed). `callId` pairs the
   * call with its `tool/result`.
   */
  'tool/call': { turn: number; step: number; callId: CallId; name: string; arguments: string }
  /**
   * A completed tool call's model-facing result, plus an optional tool-private
   * `meta` presentation payload. `meta` is opaque to the core (`unknown` — the
   * producing tool owns its shape and reads it back in `presentResult`) but MUST
   * be JSON-serializable: `Session.append` runtime-validates all event data with
   * `isJsonValue`, so a non-serializable `meta` is rejected at the source, and the
   * durable log reproduces the identical card on replay. Absent unless the tool
   * attaches one (e.g. `dsh-tool-fs` carries its result-time contextual diff here).
   */
  'tool/result': { turn: number; step: number; callId: CallId; content: ContentBlock[]; isError: boolean; error?: { name: string; code: string }; meta?: unknown }
  /** Steering content injected between steps of a running turn. */
  'steering/message': { turn: number; content: ContentBlock[]; source: MessageSource }
  /** Whole-list snapshot; latest write wins on replay. Log-only UI state; never derived history. */
  'todo/write': { todos: TodoItem[] }
  /**
   * Full header for the next request, appended inside its step before dispatch.
   * It is log-only; the latest snapshot reconstructs the request header.
   */
  'request/header': { header: EpochHeader; reason: RequestHeaderReason }
}
```

### `TodoItem` — one todo-list entry

The unit of the `todo/write` event's whole-list snapshot. Deliberately minimal — a `content` line and a three-state `status` (no id, priority, or `activeForm`): the list is replaced wholesale on every write, so entries need no stable identity, and the status triple is exactly the ACP `PlanEntryStatus`, so a UI bridge can map a todo list onto an ACP `plan` 1:1 (synthesizing the priority ACP additionally requires). See the [todo_write RFC](../rfc/implemented/feature/2026-06-29-todo-write-tool.md).

```ts type-equiv
/**
 * One entry in an agent's todo list — the unit of the `todo/write`
 * {@link SessionEventMap} event's whole-list snapshot.
 *
 * Deliberately minimal: a human-readable `content` line and a three-state
 * `status`. No id, priority, or `activeForm` — the list is replaced wholesale
 * on every write (last-write-wins), so entries need no stable identity, and the
 * status triple is exactly the ACP `PlanEntryStatus`, so a UI bridge can map a
 * todo list onto an ACP `plan` 1:1 (synthesizing the priority ACP additionally
 * requires).
 */
interface TodoItem {
  /** What this task is — a short imperative line shown in the UI. */
  content: string
  /** Lifecycle state. `in_progress` marks the single task being worked now. */
  status: 'pending' | 'in_progress' | 'completed'
}
```

### The request header event: `request/header`

The request envelope — the `EpochHeader` (call config + rendered system prompt + assembled tool schemas + the session prefix) — is logged session state, so every conversation request is a pure function of the log (the reconstructability RFC). A full `request/header` snapshot with reason `'initial'` or `'resume'` records each loop-instance boundary; a later changed request records another full snapshot with reason `'change'`. `foldRequestHeader(events)` reconstructs the header by selecting the latest snapshot. The event is not a `SurfaceEventType`: it produces no LLM message.

```ts type-equiv
/**
 * Logged request state outside derived history: call config, system prompt,
 * tools, and prefix. The latest full `request/header` snapshot reconstructs it;
 * canonical empty optional fields are absent.
 */
interface EpochHeader {
  /** The conversation's call configuration (provider, model, and sampling scalars). */
  config: LlmCallConfig
  /** Rendered system prompt text; absent for a system-less request. */
  system?: string
  /** Assembled tool schemas; absent for a tool-less request. */
  tools?: ToolSchema[]
  /**
   * The session prefix: request-only messages sent BEFORE the entire derived
   * history (the `agent/session-prefix` waterfall's product, composed once
   * per loop instance and reused for every request it sends). Not session
   * history — `deriveMessages()` never returns it — so the header is its
   * only durable record; absent when the instance composed none.
   */
  messagePrefix?: Message[]
}
```

Canonical form: an empty system prompt, an empty tool list, and an empty session prefix are absent fields, matching how requests are built. `messagePrefix` is the durable record of the `agent/session-prefix` waterfall's product (the request is `messagePrefix + derived history`); it is composed once per loop instance and included in every full snapshot that instance records. Legacy v0 logs containing the removed `request/header-delta` event or its full-snapshot `fallback` reason are rejected at seed, append, and persistence-load boundaries rather than replayed incompletely.

## `SessionEvent<T>` — one log entry

A proper discriminated union over `type` (not independent `type`/`data` unions), so `switch (event.type)` narrows `event.data` without casts. `seq` is the monotonic position in the log (`seq = log.length`); `time` is epoch ms.

```ts type-equiv
/**
 * One immutable entry in the session log.
 *
 * A proper discriminated union over `type` (not independent `type`/`data`
 * unions), so `switch (event.type)` narrows `event.data` without casts.
 *
 * The {@link sourceEventSeqs} and {@link surfaceOp} fields are conditional:
 * they only exist on {@link SurfaceEventType} variants (`user/message`,
 * `assistant/message`, `tool/result`, `context/message`, `steering/message`).
 * Non-surface events (boundary markers, chunks, usage, errors) never carry
 * surface metadata — the compiler enforces this at `Session.append()`
 * call sites.
 */
type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: {
    type: K
    /** Monotonic sequence number within the session. */
    seq: number
    /** Unix epoch milliseconds. */
    time: number
    data: SessionEventMap[K]
  } & (K extends SurfaceEventType ? {
    /**
     * Seq numbers of events that are provenance sources of this event
     * (e.g. the `assistant/chunk` seqs that built an `assistant/message`,
     * or the surface nodes shadowed by a compaction replace node). An
     * `assistant/message` may carry a present empty array for a known empty
     * provider stream; omission means unrecorded provenance.
     */
    sourceEventSeqs?: number[]
    /** How this event entered the surface; absent for non-surface events. */
    surfaceOp?: SurfaceOp
  } : object)
}[T]
```

`SessionEventType = keyof SessionEventMap`. Because `SessionEventMap` is merge-extensible, switches over `SessionEvent` must NOT use `assertNever` — a plugin-added variant is a valid unknown value; handle the known cases and fall through `default`.

For `assistant/message`, a present `sourceEventSeqs: []` is a complete known-empty provider stream, while an absent field means legacy or otherwise unrecorded provenance. The loop writes the field for every successful model call; every other surface event requires a non-empty list when the field is present.

## Surface types

The five message-producing types (`SurfaceEventType` — `user/message`, `assistant/message`, `tool/result`, `context/message`, `steering/message`) carry surface metadata declaring how they join the ordered derived surface. See the [session surface RFC](../rfc/implemented/architecture/2026-06-18-session-surface.md).

### `SurfaceEventType` — the message-producing subset of event types

```ts type-equiv
/**
 * The subset of {@link SessionEventType} values whose events produce LLM
 * messages and are eligible to appear on the ordered surface. Only these
 * event types may carry {@link SurfaceOp} and {@link SessionEvent.sourceEventSeqs}.
 */
type SurfaceEventType =
  | 'user/message'
  | 'assistant/message'
  | 'tool/result'
  | 'context/message'
  | 'steering/message'
```

### `SurfaceOp` — how an event entered the surface

```ts type-equiv
/**
 * How a session event entered the ordered surface. Only valid on
 * {@link SurfaceEventType} events.
 *
 * - `'append'`: added to the tail — normal path for user/assistant/tool/context
 *   messages.
 * - `{ op: 'replace', start, end }`: replaces surface nodes from `start`
 *   (inclusive) through `end` (inclusive) with this node. Both must exist as
 *   surface nodes in the current surface. `start === end` replaces a single
 *   node. The node's {@link SessionEvent.sourceEventSeqs} must include every
 *   shadowed surface node. Used by compaction and possible other manipulations.
 */
type SurfaceOp =
  | 'append'
  | { op: 'replace'; start: number; end: number }
```

`'append'` is the normal tail-append path. `replace` shadows surface entries from `start` through `end` inclusive (both must be valid surface seqs; `start === end` replaces a single entry) and inserts the new event in their place.

### `SurfaceIntent` — the parameter to `session.append()`

```ts type-equiv
/**
 * Surface placement and provenance for {@link Session.append}. Required on
 * message-producing events and forbidden on log-only events.
 */
interface SurfaceIntent {
  surfaceOp: SurfaceOp
  /**
   * Complete known provenance source set. `assistant/message` may use a
   * present empty array for a known empty provider stream; omission means its
   * provenance was not recorded. Other surface events require a non-empty set
   * when this field is present.
   */
  sourceEventSeqs?: number[]
}
```

Required for `SurfaceEventType` events — every message-producing event must declare how it joins the surface, the sole source of derived history. Non-surface types reject it at compile time.

The same provenance distinction applies here: only `assistant/message` may carry a present empty `sourceEventSeqs`; omission does not assert that its source stream was empty.

### `SessionSurface` — the live readonly surface projection

`Session.surface` returns the session's stable `SessionSurface` view. The same incremental manager validates append candidates before commit and advances this projection from committed events; callers can observe membership and replacement generation but cannot invoke validation.

```ts type-equiv
/** Readonly live projection of the message-producing session events. */
interface SessionSurface {
  /** Current surface event sequences in model-visible order. */
  readonly nodes: readonly number[]
  /** Monotonic count of committed positional replacements. */
  readonly replaceGeneration: number
}
```

### `SurfaceFoldReplacement` and `SurfaceFoldResult` — a complete surface replay

`foldSurface(events)` returns detached current event sequences together with the actual sequences shadowed by each declared replacement range. The live manager uses the same transitions without retaining replacement history. Its `replaceGeneration` increments for each committed replacement so incremental consumers can distinguish pure tail growth from a rewrite.

```ts type-equiv
/** One replacement operation observed while folding a session surface. */
interface SurfaceFoldReplacement {
  /** Seq of the event that replaced the prior surface range. */
  seq: number
  /** Declared inclusive start seq of the replaced surface range. */
  start: number
  /** Declared inclusive end seq of the replaced surface range. */
  end: number
  /** Actual surface entries removed by the operation, in surface order. */
  shadowedSeqs: number[]
}
```

```ts type-equiv
/** Complete result of replaying the surface operations in a session log. */
interface SurfaceFoldResult {
  /** Current surface event sequences in model-visible order. */
  nodes: number[]
  /** Replacement operations in event order. */
  replacements: SurfaceFoldReplacement[]
}
```

## Derived history: `deriveMessages()` and `deriveEventMessage()`

`Session.deriveMessages()` projects the event log into the `Message[]` the model sees — cached (each surface node projected once, when first seen; a surface rewrite rebuilds) and frozen (a fresh array per call over shared, deep-frozen messages, so mutating logged history through a projection is unrepresentable). `deriveEventMessage(event)` is the per-node pure function the fold applies — public so external reconstructors and the dev invariant project a log prefix with exactly the same rules and cannot disagree with the cache. The projection rules:

- `user/message` → a user message.
- `assistant/message` → an assistant message with the event's provider/model provenance and optional adapter-private replay state. Raw `assistant/chunk` events are replay/UI data and are **skipped** in derivation (the assembled message is authoritative). An **empty-content** `assistant/message` is also skipped — a max-tokens step cut off with no content still records an `assistant/message` to host its usage/provenance, but a content-less assistant turn must not enter the provider transcript.
- `tool/result` → a user message carrying a `tool-result` block.
- `context/message` → a user-role message at its chronological position. The default `envelope` is `context`, which wraps content as `<context source="…">…</context>`; `envelope: 'raw'` uses caller-owned framing verbatim. Optional JSON `meta` remains in the event log and is never rendered.
- `steering/message` → a user-role message wrapped in `<steering source="…">…</steering>` at its chronological position.

Everything else (`turn/*`, `step/*`) is structural and does not project into a message. Token usage is observed on `assistant/message.usage` (the step that produced it); an operational error's step number is on `turn/end.reason` for `kind: 'error'`. Because this unreleased format intentionally has no compatibility promise, seed/load validation rejects request headers without provider+model and assistant messages without provider/model provenance instead of guessing a route for historical data.

## Live-session fork API

`ctx.sessions.create(id, { seed, meta })` is the low-level replay/fork primitive. For ordinary live-session forks, `SessionStore` exposes one policy API:

- `fork(source, boundary?, childSessionId?)` accepts a live `Session` object or live `SessionId`, selects source events through the inclusive `boundary` seq (default: current last event), requires the boundary event to be `turn/end`, then creates a live child session with deep-cloned seed events plus child metadata (`parentSession`, `seedLength`, and inherited `cwd`).

An explicit `boundary` lets callers fork from a previous completed turn even if the source has newer events or an open current turn. The API rejects non-`turn/end` boundaries instead of clipping silently. Broader turn-enclosure sanity stays in the existing `dsh-invariants` plugin and persistence repair path rather than being duplicated in `fork()`. `dsh-subagent-fork` keeps its completed-prefix clipping because tool-time delegation usually starts while the parent turn is open; ordinary session branching should make the requested boundary explicit.

## What started a turn: `TurnTriggerMap`

```ts type-equiv
/**
 * What started a turn.
 * Merge-extensible sum type (same pattern as MessageSourceMap).
 */
interface TurnTriggerMap {
  message: { kind: 'message'; source: MessageSource }
  /**
   * An out-of-band context injection (`agent.inject()`) made while the agent
   * was idle. The loop wraps the injected `context/message` in a one-shot turn
   * (`turn/start` → `context/message` → `turn/end`) so every event in the log
   * stays turn-enclosed — the durability/replay boundary is the turn, and a
   * bare event between turns would otherwise be indistinguishable from a crash
   * tail on reload.
   */
  injection: { kind: 'injection'; source: MessageSource }
}
```

## Why a turn ended: `TurnEndReasonMap`

```ts type-equiv
/**
 * Why a turn ended. Merge-extensible sum type.
 */
interface TurnEndReasonMap {
  completed: { kind: 'completed' }
  aborted: { kind: 'aborted'; reason?: string }
  /**
   * The turn failed: a step threw or the model reported a failure. `step` is the
   * step number the failure occurred on (the operational error's location — the
   * single durable record of an in-turn failure; live diagnostics also fire via
   * `agent/error`). `code` is the error's code when one was attached.
   */
  error: { kind: 'error'; step: number; message: string; code?: string }
  disposed: { kind: 'disposed' }
  /** At least one step reached its output-token ceiling, even if a plugin continued the turn. */
  'max-tokens': { kind: 'max-tokens' }
  /**
   * Policy blocked every prompt before the first step. The zero-step turn still
   * records a balanced durable boundary and the veto reason.
   */
  rejected: { kind: 'rejected'; reason: string }
  /**
   * A persistence backend closed a crash-orphaned turn on reload. The loop never
   * emits this marker, and the events recorded before the crash remain intact.
   */
  interrupted: { kind: 'interrupted' }
}
```

`max-tokens` mirrors the model-call `FinishReason` of the same name: any `max-tokens` step in a turn makes the whole turn end `max-tokens` rather than `completed` (the cut-short fact wins over a later continuation), so a consumer can tell a clean stop from a truncated one — but only over `completed`: the `disposed`/`aborted`/`error` outcomes take precedence. `rejected` is a zero-step turn whose whole prompt batch an `agent/prompt-submit` hook blocked (the ACP bridge maps it to `cancelled`). `interrupted` is the one reason no loop emits — it is synthesized by crash recovery (see [persistence.md](persistence.md)). Both maps are merge-extensible.

## The turn-enclosure invariant

Every session event lives **inside** a turn (between a `turn/start` and its `turn/end`). The loop appends queued `user/message` events *after* `turn/start`, and an idle `agent.inject()` wraps its `context/message` in a one-shot `injection` turn. This makes the turn the single durability/replay boundary: a backend can treat anything after the last `turn/end` as an interrupted-crash tail without risking the loss of legitimately-recorded between-turn context. The `dsh-invariants` plugin enforces it in dev (a message event outside an open turn throws). See [the turn-enclosure invariant RFC](../rfc/implemented/architecture/2026-06-15-turn-enclosure-invariant.md).

## Plugin-contributed log-only events

A plugin may declaration-merge extra `SessionEventMap` types. These are **log-only**: NOT `SurfaceEventType`s (they carry no `surfaceOp` and contribute nothing to derived history), but, like every event, they must sit inside an open turn. The full per-event enumeration — core and plugin-contributed alike, with payloads and provenance — is the generated [persistence log event catalog](../persistence-catalog.md); the compaction seam's `compact/*` semantics are discussed on [compaction.md](compaction.md).

The hook bridges' `hook/invoked` / `hook/result` provenance pairs (from `@deepseek-ai/dsh-hook-protocol`) correlate by `handlerId`. The mid-turn hook points (`PreToolUse`/`PostToolUse`/`UserPromptSubmit`/`Stop`) fire inside the loop's open turn, so their `hook/*` records are turn-enclosed by construction. `SessionStart` gets no `hook/*` record — its injected `context/message` is the durable evidence — because it has no open turn to enclose one (see [the hook-bridges RFC](../rfc/implemented/feature/2026-06-30-hook-bridges.md)).

## Durability contract

What a persistence backend relies on: the durable log persists every event verbatim, **including** `assistant/chunk` — `seq` must stay contiguous, so chunks cannot be filtered out of the canonical log. All `event.data` must be JSON-serializable; `Session.append` enforces this at the source (throwing on non-serializable data), so a bad event never enters the log and `session.events` always equals what a backend can persist. Adding an event type that carries non-serializable data, or that breaks the turn/step nesting the invariants plugin checks, is a breaking change to the on-disk format.

The backends that consume this contract are on [persistence.md](persistence.md).
