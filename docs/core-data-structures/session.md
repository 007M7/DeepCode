# Sessions

English | [中文](session.zh.md)

The in-memory, event-sourced model of [dsh-session](../../packages/core/session). A `Session` is an **append-only log** of typed `SessionEvent`s — the single source of truth for an agent's whole interaction history. The LLM message history is *derived* from the log, never stored separately; replay is re-derivation from the same events. How the log is made **durable** (the persistence seam, backends, crash recovery) is the sibling concern on [persistence.md](persistence.md).

Source: [`packages/core/session/src/types.ts`](../../packages/core/session/src/types.ts)

## `SessionEventMap` — the event vocabulary

The append-only event types. Merge-extensible: a plugin declares extra event types via declaration merging — e.g. the [compaction seam](compaction.md) adds `compact/start` / `compact/summary` / `compact/end`, and `@deepseek-ai/dsh-hook-protocol` adds log-only `hook/invoked` / `hook/result` provenance for a hook bridge. Like `compact/*`, these are NOT `SurfaceEventType`s (no `surfaceOp`). The generated [persistence log event catalog](../persistence-catalog.md) enumerates every member — core and merged — with its payload, surface badge, and declaration site.

```ts type-equiv
/** A user-role specialization of the one shared message representation. */
interface UserMessage extends Message {
  readonly role: 'user'
}
```

```ts type-equiv
/**
 * The merge-extensible, append-only source of truth for an agent interaction.
 * Message history is derived from this log. Every event is lossless JSON and
 * sequence numbers stay contiguous, including raw chunks, so persistence can
 * store the canonical log verbatim.
 */
interface SessionEventMap {
  /**
   * Opens turn `turn`. `trigger` records what started the model loop.
   */
  'turn/start': { turn: number; trigger: TurnTrigger }
  /**
   * Closes turn `turn` with the {@link TurnEndReason} that ended it. The loop
   * awaits `session/flush` after an ordinary turn ends before claiming the next
   * queued item. Success commits the turn; rejection is reported live and does
   * not prevent later work.
   */
  'turn/end': { turn: number; reason: TurnEndReason }
  /** Opens step `step` of turn `turn` — one model call plus the tool executions it requested. */
  'step/start': { turn: number; step: number }
  /** Closes step `step` of turn `turn`. */
  'step/end': { turn: number; step: number }
  /**
   * A user-role message on the model-visible surface: a direct human prompt
   * (the queued message claimed for this turn), a synthetic `agent.inject()`
   * context (file-change notices, subdir AGENTS.md, skill content, cron
   * notifications, …), or an admitted goal continuation round. All three
   * project their `content` verbatim; `source` tells them apart. An idle
   * injection may append this event between turns without running the model.
   */
  'user/message': UserMessage
  /** Raw stream chunk — token-level replay fidelity. */
  'assistant/chunk': { turn: number; step: number; chunk: StreamChunk }
  /**
   * Assembled assistant message for one step (derived history uses this).
   * Carries the step's `usage` when the adapter reported token accounting, so
   * the model output and its accounting travel together (there is no separate
   * usage record). `usage` is absent when the adapter reported none.
   */
  'assistant/message': { turn: number; step: number; message: AssistantMessage; usage?: TokenUsage }
  /**
   * The model requested one tool invocation: `name` with the raw `arguments`
   * JSON string exactly as the model produced it (unparsed). `callId` pairs the
   * call with its `tool/result`.
   */
  'tool/call': { turn: number; step: number; callId: CallId; name: string; arguments: string }
  /**
   * A completed tool call's model-facing result, optional internal failure
   * identity, and optional tool-private `meta` presentation payload. `meta` is
   * opaque to the core (the producing tool owns its shape and reads it back in
   * `presentResult`) but MUST be JSON-serializable: `Session.append`
   * runtime-validates all event data with `isJsonValue`, so a non-serializable
   * `meta` is rejected at the source, and the durable log reproduces the
   * identical card on replay. Absent
   * unless the tool attaches one (e.g. `dsh-tool-fs` carries its result-time
   * contextual diff here).
   */
  'tool/result': {
    turn: number
    step: number
    message: ToolResultMessage
    error?: { name: string; code: string }
    meta?: JsonValue
  }
  /** Steering content injected between steps of a running turn. */
  'steering/message': { turn: number; message: UserMessage }
  /** Whole-list snapshot; latest write wins on replay. Log-only UI state; never derived history. */
  'todo/write': { todos: TodoItem[] }
  /**
   * Full header for the next request, appended inside its step before dispatch.
   * It is log-only; the latest snapshot reconstructs the request header.
   */
  'request/header': { header: EpochHeader; reason: RequestHeaderReason }
}
```

`UserMessage` is the identified, frozen user-role value shared by ordinary prompts, injected context, steering, and live inbox events. Event wrappers add only event-local position or outcome facts; the loop adds only driver-owned routing state while an item remains pending.

### `TodoItem` — one todo-list entry

The unit of the `todo/write` event's whole-list snapshot. Deliberately minimal — a `content` line and a three-state `status` (no id, priority, or `activeForm`): the list is replaced wholesale on every write, so entries need no stable identity. See the [todo_write Agent Note](../../.agents/notes/implemented/feature/2026-06-29-todo-write-tool.md).

```ts type-equiv
/**
 * One entry in an agent's todo list — the unit of the `todo/write`
 * {@link SessionEventMap} event's whole-list snapshot.
 *
 * Deliberately minimal: a human-readable `content` line and a three-state
 * `status`. No id, priority, or `activeForm` — the list is replaced wholesale
 * on every write (last-write-wins), so entries need no stable identity. The
 * three statuses describe the complete portable lifecycle needed by model and
 * UI consumers.
 */
interface TodoItem {
  /** What this task is — a short imperative line shown in the UI. */
  content: string
  /** Lifecycle state. `in_progress` marks the single task being worked now. */
  status: 'pending' | 'in_progress' | 'completed'
}
```

### The request header event: `request/header`

The request envelope — the `EpochHeader` (call config + rendered system prompt + assembled tool schemas) — is logged session state, so every conversation request is a pure function of the log (the reconstructability Agent Note). A full `request/header` snapshot with reason `'initial'` or `'resume'` records each loop-instance boundary; a later changed request records another full snapshot with reason `'change'`. `foldRequestHeader(events)` reconstructs the header by selecting the latest snapshot. The event is not a `SurfaceEventType`: it produces no LLM message.

```ts type-equiv
/**
 * Logged request state outside derived history: call config, system prompt, and
 * tools. The latest full `request/header` snapshot reconstructs it; canonical
 * empty optional fields are absent.
 */
interface EpochHeader {
  /** The conversation's call configuration (provider, model, reasoning effort, and sampling scalars). */
  config: LlmCallConfig
  /** Rendered system prompt text; absent for a system-less request. */
  system?: string
  /** Assembled tool schemas; absent for a tool-less request. */
  tools?: ToolSchema[]
}
```

Canonical form represents an empty system prompt or tool list as an absent field, matching how requests are built. Legacy v0 logs containing the removed `request/header-delta` event or its full-snapshot `fallback` reason are rejected at seed, append, and persistence-load boundaries rather than replayed incompletely.

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
 * `assistant/message`, `tool/result`, `steering/message`).
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

The four message-producing types (`SurfaceEventType` — `user/message`, `assistant/message`, `tool/result`, `steering/message`) carry surface metadata declaring how they join the ordered derived surface. See the [session surface Agent Note](../../.agents/notes/implemented/architecture/2026-06-18-session-surface.md).

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
  | 'steering/message'
```

### `SurfaceOp` — how an event entered the surface

```ts type-equiv
/**
 * How a session event entered the ordered surface. Only valid on
 * {@link SurfaceEventType} events.
 *
 * - `'append'`: added to the tail — normal path for user/assistant/tool/steering
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

## `Session` public API

The body-stripped declaration keeps the plain class's public constructor, state accessors, append boundary, and history projections synchronized with source. Store operations remain in the generated [`ctx.sessions` service catalog](../cordis-catalog/services.md#ctxsessions--sessionstore).

```ts public-api
/**
 * An event-sourced session: an append-only log of {@link SessionEvent}s.
 *
 * Plain class (not a Service) — create instances via `ctx.sessions.create()`.
 * Seeding with an existing event log replays/forks a session.
 * @typert object
 */
declare class Session {
  /** The ordered surface over this session's event log. */
  get surface(): SessionSurface;
  /**
   * Detached, deep-frozen creation metadata (format version, cwd, lineage,
   * seed boundary). Supplied by the store via `ctx.sessions.create()`. When a
   * `Session` is constructed bare (tests, ad-hoc replay), a minimal header is
   * synthesized (stamped with the current {@link SESSION_FORMAT_VERSION}) so
   * `session.header` is always present. Kept out of the event log — it is a
   * storage concern, not replayable conversation state.
   */
  readonly header: SessionHeader;
  /** The session identity, derived from its durable header's single copy. */
  get id(): SessionId;
  /**
   * The first seq appended IN THIS PROCESS: the length of the constructor
   * seed (0 without one). Events below it entered through construction —
   * replay, fork, or resume — and were never published on the `session/event`
   * firehose (constructor seeds do not emit), so consumers that replay the
   * log as a publication substitute (telemetry adoption) start here. Distinct
   * from `header.seedLength`, the DURABLE fork-lineage boundary: a resumed
   * session's constructor seed is its full stored log, while its header keeps
   * the original fork value — this field is the in-process construction fact
   * and is deliberately not persisted.
   */
  readonly firstLiveSeq: number;
  constructor(id: SessionId, seed?: readonly SessionEvent[], header?: SessionHeader);
  /**
   * An immutable snapshot of the append-only event log. The snapshot is reused
   * until the next append; a previously returned array does not grow later.
   * Events and their nested data are deep-frozen at acceptance, so neither a
   * cast nor ordinary JavaScript can rewrite durable history.
   */
  get events(): readonly SessionEvent[];
  /** The next event's sequence number — always the log length (the `seq = log.length` contiguity contract). */
  get seq(): number;
  /**
   * Append one typed event to the log and synchronously notify observers via
   * the store-owned, module-private publication hooks. The hot path never blocks
   * on I/O — persistence plugins buffer asynchronously. Once the event enters
   * the log, the append is committed: observer failures are logged and
   * contained per listener, so they do not change the return value or prevent
   * later listeners from observing the same accepted event.
   *
   * @param type - The event type (key of {@link SessionEventMap}).
   * @param data - The event payload; must be JSON-serializable.
   * @param opts - Surface metadata: `surfaceOp` controls how the event enters
   *   the ordered surface; `sourceEventSeqs` records provenance (the seq
   *   numbers of events this one derives from). REQUIRED for
   *   {@link SurfaceEventType} events (every message-producing event must
   *   declare how it joins the surface, the sole source of derived history) and
   *   rejected by the compiler for non-surface types like `turn/start` or
   *   `assistant/chunk`.
   * @returns the logged event — its assigned `seq`/`time` plus the SNAPSHOT of
   *   `data` that entered the log, so reading `event.data` back sees the logged
   *   value, never the caller's still-mutable input.
   * @throws if `data` or surface metadata is not losslessly JSON-serializable
   *   (BigInt, function, symbol, undefined, negative zero, non-finite number,
   *   circular reference, sparse array, or an exotic object such as
   *   Map/Set/Date/class instance), or when the candidate violates the
   *   canonical surface contract (marker shape and eligibility, unique
   *   earlier provenance, positional replacement validity, and complete
   *   shadowed-node coverage). One recursive pass reads, validates, and
   *   copies each nested value once, so a stateful getter cannot supply one value
   *   to validation and another to storage. The event log is the durable source
   *   of truth, so a bad event fails at the append site rather than later during
   *   a backend flush. A synchronous internal dispatch validation failure or an
   *   append reentered while this acceptance/publication boundary is open also
   *   rejects before the log changes.
   */
  append<T extends SessionEventType>(
    type: T,
    data: SessionEventMap[T],
    ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent] : []
  ): SessionEvent<T>;
  /**
   * The {@link EpochHeader} in force after the log's last header event — the
   * header the NEXT request will be compared against — or undefined before
   * the first `request/header` snapshot. The live, incrementally-maintained
   * form of `foldRequestHeader(session.events)`: each header event is folded
   * once, when first seen, so a per-step read costs O(new events).
   * @returns the folded header, or undefined when no header event exists yet.
   */
  requestHeader(): EpochHeader | undefined;
  /**
   * Derive the LLM message history by walking the ordered sequences of
   * message-producing events maintained by `surfaceOp` markers. The
   * surface is the single source of derived history: every message-producing
   * append records its `surfaceOp`, so a raw event with no marker (a chunk, a
   * turn boundary) is correctly absent, and a compaction `replace` deletes the
   * shadowed nodes from the derivation. The projection rules are
   * {@link deriveEventMessage}, folded per node.
   *
   * CACHED: each surface node is projected exactly once, when first seen — a
   * call costs O(new nodes), and a surface rewrite (a `replace`;
   * {@link SessionSurface.replaceGeneration}) rebuilds. The returned array is
   * a fresh snapshot per call (later appends never grow an array a caller
   * already holds); the `Message` objects in it are SHARED and **deep-frozen**.
   * Their content reuses the already frozen durable event data, so the cache
   * needs no second deep clone and consumers still cannot mutate the log.
   * @returns a fresh array of the shared, frozen derived history.
   */
  deriveMessages(): Message[];
  /**
   * Project a single event into the LLM message it derives to, or null when
   * it produces none — a non-surface event (chunk, boundary, log-only record)
   * or an empty-content assistant/message (which exists only to host usage).
   * The per-node pure function {@link deriveMessages} folds over the surface;
   * an external reconstructor (or the dev invariant) folds the same function
   * over a log prefix's surface to rebuild the exact messages any request was
   * built from (the reconstructability Agent Note). The returned message is
   * the already frozen message nested in the event wrapper and shared by
   * delivery, durable history, and model requests.
   * @param event - the event to project.
   * @returns the derived message, or null when the event produces none.
   */
  deriveEventMessage(event: SessionEvent): Message | null;
}
```

## Derived history: `deriveMessages()` and `deriveEventMessage()`

`Session.deriveMessages()` projects the event log into the `Message[]` the model sees — cached (each surface node projected once, when first seen; a surface rewrite rebuilds) and frozen (a fresh array per call over shared, deep-frozen messages, so mutating logged history through a projection is unrepresentable). `deriveEventMessage(event)` is the per-node pure function the fold applies — public so external reconstructors and the dev invariant project a log prefix with exactly the same rules and cannot disagree with the cache. The projection rules:

- `user/message` → a user message carrying exact `content`; an optional envelope remains log-only display metadata.
- `assistant/message` → an assistant message with the event's provider/model provenance and optional adapter-private replay state. Raw `assistant/chunk` events are replay/UI data and are **skipped** in derivation (the assembled message is authoritative). An **empty-content** `assistant/message` is also skipped — a max-tokens step cut off with no content still records an `assistant/message` to host its usage/provenance, but a content-less assistant turn must not enter the provider transcript.
- `tool/result` → a user message carrying a `tool-result` block.
- `user/message` (injected context, i.e. non-`user` source) → a user-role message carrying its `content` verbatim at its chronological position; provenance and domain data live in its typed source.
- `steering/message` → a user-role message carrying exact `content` at its chronological position; an optional envelope remains log-only display metadata.

Everything else (`turn/*`, `step/*`, plugin-owned `llm/retry`) is structural and does not project into a message. Token accounting reads per-step `assistant/chunk { type: 'usage' }` records and treats `assistant/message.usage` as the committed-step fallback when no usage chunk exists; failed model-request attempts have no assistant message, so their usage chunk is the durable accounting record. An operational error's step number is on `turn/end.reason` for `kind: 'error'`, with normalized `LlmFailure` facts for a final model-request failure and message/code for other live errors. Because this unreleased format intentionally has no compatibility promise, seed/load validation rejects request headers without provider+model and assistant messages without provider/model provenance instead of guessing a route for historical data.

## Live-session fork API

`ctx.sessions.create(id, { seed, meta })` is the low-level replay/fork primitive. For ordinary live-session forks, `SessionStore` exposes one policy API:

- `fork(source, boundary?, childSessionId?)` accepts a live `Session` object or live `SessionId`, selects source events through the inclusive `boundary` seq (default: current last event), requires the selected prefix to end outside an open turn, then creates a live child session with deep-cloned seed events plus child metadata (`parentSession`, `seedLength`, and inherited `cwd`).

An explicit `boundary` lets callers fork from any stable between-turn position, including a previous `turn/end` or a later standalone log-only event, even if the source has newer events or an open current turn. The API rejects a prefix that ends inside an open turn instead of clipping silently. Broader execution-relation sanity stays in the existing `dsh-invariants` plugin and persistence repair path rather than being duplicated in `fork()`. `dsh-subagent-fork` keeps its completed-prefix clipping because tool-time delegation usually starts while the parent turn is open; ordinary session branching should make the requested boundary explicit.

## What started a turn: `TurnTriggerMap`

```ts type-equiv
/**
 * What started a turn.
 * Merge-extensible sum type (same pattern as MessageSourceMap).
 */
interface TurnTriggerMap {
  message: { kind: 'message'; source: MessageSource }
  /** Recovery turn reopened over the repaired current session log. */
  retry: { kind: 'retry' }
  /**
   * An out-of-band producer explicitly enclosed injected context in a one-shot
   * turn. `Agent.inject()` appends idle context directly and does not use this
   * trigger; the source mirrors the producer of the enclosed `user/message`.
   */
  injection: { kind: 'injection'; source: MessageSource }
}
```

## Why a turn ended: `TurnEndReasonMap`

`aborted` is intentionally a coarse durable outcome: it records that cancellation interrupted the live turn, not which runtime caller requested it. The runtime-only caller vocabulary belongs to [`AgentCancelCause`](core.md#the-agent-handle); a future audit requirement would use a separate control-request event rather than overloading the terminal result.

```ts type-equiv
/**
 * Why a turn ended. Merge-extensible sum type.
 */
interface TurnEndReasonMap {
  completed: { kind: 'completed' }
  /** A cancellation request interrupted the live turn. */
  aborted: { kind: 'aborted' }
  /**
   * The turn failed: a step threw or the model reported a failure. `step` is the
   * step number the failure occurred on (the operational error's location — the
   * single durable record of an in-turn failure; live diagnostics also fire via
   * `agent/error`). Final model-request failures retain their normalized facts
   * as one `failure`; other thrown values retain their rendered message and a
   * real `HarnessError` code when present.
   */
  error: { kind: 'error'; step: number } & (
    | { failure: LlmFailure; message?: never; code?: never }
    | { message: string; code?: string; failure?: never }
  )
  disposed: { kind: 'disposed' }
  /** At least one step reached its output-token ceiling, even if a plugin continued the turn. */
  'max-tokens': { kind: 'max-tokens' }
  /**
   * A persistence backend closed a crash-orphaned turn on reload. The loop never
   * emits this marker, and the events recorded before the crash remain intact.
   */
  interrupted: { kind: 'interrupted' }
}
```

`max-tokens` mirrors the model-call `FinishReason` of the same name: any `max-tokens` step in a turn makes the whole turn end `max-tokens` rather than `completed` (the cut-short fact wins over a later continuation), so a consumer can tell a clean stop from a truncated one — but only over `completed`: the `disposed`/`aborted`/`error` outcomes take precedence. `interrupted` is the one reason no loop emits — it is synthesized by crash recovery (see [persistence.md](persistence.md)). Both maps are merge-extensible.

## Execution enclosure and standalone events

A turn encloses one model-loop execution, not the whole session log. Idle injected `user/message` events and plugin-owned log-only events may appear between `turn/end` and the next `turn/start`; they consume event seqs without incrementing turn numbers. Persistence eagerly records every contiguous accepted event, while crash repair closes only a genuinely open trailing turn. A producer that needs a durability barrier explicitly awaits `ctx.sessions.flush(session)`.

The optional `dsh-session/invariant` companion enforces the relations owned by core: turn and step numbering, execution-event enclosure, and same-step tool call/result pairing. Merge-extensible event relations belong to the plugin that declares them, so core does not reject an unknown event merely because no turn is open. See [the standalone-event decision](../../.agents/notes/implemented/simplification/2026-07-28-remove-synthetic-log-only-turns.md).

## Plugin-contributed log-only events

A plugin may declaration-merge extra `SessionEventMap` types. These are **log-only**: NOT `SurfaceEventType`s (they carry no `surfaceOp` and contribute nothing to derived history). Their owner decides whether they belong to an open execution turn or may stand between turns, and enforces any relation in its own invariant companion. The full per-event enumeration — core and plugin-contributed alike, with payloads and provenance — is the generated [persistence log event catalog](../persistence-catalog.md); the compaction seam's `compact/*` semantics are discussed on [compaction.md](compaction.md).

The hook bridges' `hook/invoked` / `hook/result` provenance pairs (from `@deepseek-ai/dsh-hook-protocol`) correlate by `handlerId`. The mid-turn hook points (`PreToolUse`/`PostToolUse`/`Stop`) fire inside the loop's open turn, so their `hook/*` records are turn-enclosed by construction. `SessionStart` and the pre-turn `UserPromptSubmit` admission seam get no `hook/*` record because neither has an open turn to enclose one; allowed context is instead evidenced by its sourced `user/message` (see [the hook-bridges Agent Note](../../.agents/notes/implemented/feature/2026-06-30-hook-bridges.md)).

## Durability contract

What a persistence backend relies on: the durable log persists every event losslessly, **including** `assistant/chunk` — `seq` must stay contiguous, so chunks cannot be filtered out of the canonical log. A backend may choose its own storage encoding for an event batch as long as `load` returns the exact appended events (the JSONL backend's default packed chunk rows are such an encoding — see [persistence.md](persistence.md)). All `event.data` must be JSON-serializable; `Session.append` enforces this at the source (throwing on non-serializable data), so a bad event never enters the log and `session.events` always equals what a backend can persist. Adding an event type that carries non-serializable data, corrupts core execution nesting, or violates its owner's declared relation is a breaking change to the on-disk format.

The backends that consume this contract are on [persistence.md](persistence.md).
