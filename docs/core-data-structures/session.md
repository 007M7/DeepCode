# Sessions

The in-memory, event-sourced model of [dsh-session](../../packages/core/session). A `Session` is an **append-only log** of typed `SessionEvent`s — the single source of truth for an agent's whole interaction history. The LLM message history is *derived* from the log, never stored separately; replay is re-derivation from the same events. How the log is made **durable** (the persistence seam, backends, crash recovery) is the sibling concern on [persistence.md](persistence.md).

Source: [`packages/core/session/src/types.ts`](../../packages/core/session/src/types.ts)

## `SessionEventMap` — the event vocabulary

The append-only event types. Merge-extensible: a plugin declares extra event types via declaration merging — e.g. the [compaction seam](compaction.md) adds `compact/start` / `compact/summary` / `compact/end`, and `@deepseek-ai/dsh-hook-protocol` adds log-only `hook/invoked` / `hook/result` provenance for a hook bridge. Like `compact/*`, these are NOT `SurfaceEventType`s (no `surfaceOp`). The generated [persistence log event catalog](../persistence-catalog/log-events.md) enumerates every member — core and merged — with its payload, surface badge, and declaration site.

```ts type-equiv
interface SessionEventMap {
  'turn/start': { turn: number; trigger: TurnTrigger }
  'turn/end': { turn: number; reason: TurnEndReason }
  'step/start': { turn: number; step: number }
  'step/end': { turn: number; step: number }
  /** A user-visible prompt (queued message drained at turn start). */
  'user/message': { content: ContentBlock[]; source: MessageSource }
  /**
   * A queued prompt an `agent/prompt-submit` listener VETOED — the durable
   * record of a blocked prompt and why. Appended in place of the `user/message`
   * the prompt would have become, so the block survives replay even in a MIXED
   * batch where another queued prompt is allowed (there the turn does not end
   * `rejected`, so the boundary reason alone would not preserve it). `content`
   * is the original prompt the listener rejected; `reason` is the veto text
   * ({@link PromptDecision} `block.reason`). NOT a {@link SurfaceEventType}: a
   * blocked prompt produces no LLM message and never reaches `deriveMessages()`.
   */
  'prompt/blocked': { content: ContentBlock[]; source: MessageSource; reason: string }
  /**
   * In-session context injection (file-change notices, subdir AGENTS.md,
   * skill content, cron notifications, …). Rendered into the derived history
   * as tagged synthetic context — NOT a user prompt.
   */
  'context/message': { content: ContentBlock[]; source: MessageSource }
  /** Raw stream chunk — token-level replay fidelity. */
  'assistant/chunk': { turn: number; step: number; chunk: StreamChunk }
  /**
   * Assembled assistant message for one step (derived history uses this).
   * Carries the step's `usage` when the adapter reported token accounting, so
   * the model output and its accounting travel together (there is no separate
   * usage record). `usage` is absent when the adapter reported none.
   */
  'assistant/message': { turn: number; step: number; content: ContentBlock[]; usage?: TokenUsage }
  'tool/call': { turn: number; step: number; callId: CallId; name: string; arguments: string }
  'tool/result': { turn: number; step: number; callId: CallId; content: ContentBlock[]; isError: boolean; error?: { name: string; code: string }; meta?: unknown }
  /** Steering content injected between steps of a running turn. */
  'steering/message': { turn: number; content: ContentBlock[]; source: MessageSource }
  /**
   * The agent's whole todo list, carried as a full snapshot and replaced
   * wholesale on each write — the current list is the most recent `todo/write`
   * (last-write-wins on replay, no fold). Appended by an owning agent via
   * `session.append('todo/write', { todos })`.
   *
   * NOT a {@link SurfaceEventType}: it produces no LLM message and never reaches
   * `deriveMessages()`, so it carries no `surfaceOp` and stays off the surface —
   * it is durable, replayable UI state, distinct from the conversation history.
   * It is a `SessionEventMap` member riding the existing `session/event` emit,
   * not a first-class Cordis `interface Events` notification, so it has no
   * cordis-catalog row.
   */
  'todo/write': { todos: TodoItem[] }
  /**
   * Full snapshot of the {@link EpochHeader} the NEXT request is built under,
   * with the {@link RequestHeaderReason} it was recorded whole. Appended by
   * the loop inside the step, before dispatch, on a loop instance's first
   * request-building step (`'initial'`/`'resume'`) or when a delta failed its
   * round-trip guard (`'fallback'`); always records what the request actually
   * used, post-`agent/request`. Anchors the header fold: reconstruction reads
   * the latest snapshot and applies the deltas after it. NOT a
   * {@link SurfaceEventType}: it produces no LLM message — it is the request
   * envelope, logged so every request is a pure function of the session log
   * (the reconstructability RFC).
   */
  'request/header': { header: EpochHeader; reason: RequestHeaderReason }
  /**
   * Amendment to the folded {@link EpochHeader}: at least one of a
   * {@link SystemDelta}, a {@link ToolsDelta}, or a whole replacement
   * {@link LlmCallConfig} (four scalars — not worth diffing). Appended by the
   * loop inside the step, before dispatch, when the header for this request
   * differs from the fold of the log so far; the writer verifies
   * `applyHeaderDelta(previous, delta)` reproduces the new header exactly and
   * falls back to a `'fallback'` `request/header` snapshot when it cannot, so
   * a logged delta ALWAYS round-trips. NOT a {@link SurfaceEventType}.
   */
  'request/header-delta': { system?: SystemDelta; tools?: ToolsDelta; config?: LlmCallConfig }
}
```

### `TodoItem` — one todo-list entry

The unit of the `todo/write` event's whole-list snapshot. Deliberately minimal — a `content` line and a three-state `status` (no id, priority, or `activeForm`): the list is replaced wholesale on every write, so entries need no stable identity, and the status triple is exactly the ACP `PlanEntryStatus`, so a UI bridge can map a todo list onto an ACP `plan` 1:1 (synthesizing the priority ACP additionally requires). See the [todo_write RFC](../rfc/implemented/feature/2026-06-29-todo-write-tool.md).

```ts type-equiv
export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}
```

### The request header events: `request/header` and `request/header-delta`

The request envelope — the `EpochHeader` (call config + rendered system prompt + assembled tool schemas) — is logged session state, so every conversation request is a pure function of the log (the reconstructability RFC). A `request/header` snapshot (reason `'initial' | 'resume' | 'fallback'`) anchors the fold at conversation birth, process boundaries, and delta-encoding fallbacks; `request/header-delta` events amend it mid-run. `foldRequestHeader(events)` reconstructs the header any request was built under; the writer round-trip-verifies every delta before logging it, so a well-formed log always folds. Neither is a `SurfaceEventType` — they produce no LLM message.

```ts type-equiv
export interface EpochHeader {
  /** The conversation's call configuration (model + sampling scalars). */
  config: LlmCallConfig
  /** Rendered system prompt text; absent for a system-less request. */
  system?: string
  /** Assembled tool schemas; absent for a tool-less request. */
  tools?: ToolSchema[]
}
```

Canonical form: an empty system prompt and an empty tool list are ABSENT fields, matching how requests are built. The delta payloads (`SystemDelta` — a common-prefix/suffix line trim; `ToolsDelta` — name-keyed added/removed/changed) live beside the events in [`packages/core/session/src/types.ts`](../../packages/core/session/src/types.ts).

## `SessionEvent<T>` — one log entry

A proper discriminated union over `type` (not independent `type`/`data` unions), so `switch (event.type)` narrows `event.data` without casts. `seq` is the monotonic position in the log (`seq = log.length`); `time` is epoch ms.

```ts type-equiv
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
     * or the surface nodes shadowed by a compaction replace node).
     */
    sourceEventSeqs?: number[]
    /** How this event entered the surface; absent for non-surface events. */
    surfaceOp?: SurfaceOp
  } : object)
}[T]
```

`SessionEventType = keyof SessionEventMap`. Because `SessionEventMap` is merge-extensible, switches over `SessionEvent` must NOT use `assertNever` — a plugin-added variant is a valid unknown value; handle the known cases and fall through `default`.

## Surface types

The five message-producing types (`SurfaceEventType` — `user/message`, `assistant/message`, `tool/result`, `context/message`, `steering/message`) carry surface metadata declaring how they join the derived surface linked list. See the [session surface RFC](../rfc/implemented/architecture/2026-06-18-session-surface.md).

### `SurfaceEventType` — the message-producing subset of event types

```ts type-equiv
export type SurfaceEventType =
  | 'user/message'
  | 'assistant/message'
  | 'tool/result'
  | 'context/message'
  | 'steering/message'
```

### `SurfaceOp` — how an event entered the surface

```ts type-equiv
export type SurfaceOp =
  | 'append'
  | { op: 'replace'; start: number; end: number }
```

`'append'` is the normal tail-append path. `replace` shadows surface nodes from `start` through `end` inclusive (both must be valid surface node seqs; `start === end` replaces a single node) and inserts the new node in their place.

### `SurfaceIntent` — the parameter to `session.append()`

```ts type-equiv
export interface SurfaceIntent {
  surfaceOp: SurfaceOp
  sourceEventSeqs?: number[]
}
```

Required for `SurfaceEventType` events — every message-producing event must declare how it joins the surface, the sole source of derived history. Non-surface types reject it at compile time.

### `SurfaceNode` — a node in the surface linked list

```ts type-equiv
export interface SurfaceNode {
  seq: number
  prev: number | null
  next: number | null
}
```

## Derived history: `deriveMessages()` and `deriveEventMessage()`

`Session.deriveMessages()` projects the event log into the `Message[]` the model sees — cached (each surface node projected once, when first seen; a surface rewrite rebuilds) and frozen (a fresh array per call over shared, deep-frozen messages, so mutating logged history through a projection is unrepresentable). `deriveEventMessage(event)` is the per-node pure function the fold applies — public so external reconstructors and the dev invariant project a log prefix with exactly the same rules and cannot disagree with the cache. The projection rules:

- `user/message` → a user message.
- `assistant/message` → an assistant message. Raw `assistant/chunk` events are replay/UI data and are **skipped** in derivation (the assembled message is authoritative). An **empty-content** `assistant/message` is also skipped — a max-tokens step cut off with no content still records an `assistant/message` to host its `usage`, but a content-less assistant turn must not enter the provider transcript.
- `tool/result` → a user message carrying a `tool-result` block.
- `context/message`, `steering/message` → user-role messages wrapped in a tagged envelope (`<context source="…">…</context>`) at their chronological position — the "system-reminder" pattern; the model distinguishes them from real prompts by the envelope.

Everything else (`turn/*`, `step/*`) is structural and does not project into a message. Token usage is observed on `assistant/message.usage` (the step that produced it); an operational error's step number is on `turn/end.reason` for `kind: 'error'`.

## What started a turn: `TurnTriggerMap`

```ts type-equiv
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
  'max-tokens': { kind: 'max-tokens' }
  /**
   * The turn's entire prompt batch was BLOCKED before any step ran — every
   * drained queued message was vetoed by an `agent/prompt-submit` listener (a
   * hook). The turn still opened (so the boundary stays balanced and the block
   * is a durable in-turn fact), but ran zero steps. `reason` carries the block
   * message from the vetoing decision. Distinct from `aborted` (a user-driven
   * cancel) and `error` (a failure): the prompt was rejected by policy, not
   * interrupted or broken. A UI renders it as "prompt blocked by hook".
   */
  rejected: { kind: 'rejected'; reason: string }
  /**
   * The turn never ended on its own: the process crashed mid-turn and a
   * persistence backend later closed the orphaned (open) turn on reload so the
   * log stays balanced. SYNTHESIZED by the backend's crash-recovery repair — no
   * loop ever emits this. Its events are real (they were durably appended before
   * the crash) and are PRESERVED, not discarded: a single turn can be huge in a
   * long-horizon task (many steps, large tool output), so truncating it would
   * lose real work. The marker records that the turn was cut short, not that the
   * model completed it. See the session-persistence RFC.
   */
  interrupted: { kind: 'interrupted' }
}
```

`max-tokens` mirrors the model-call `FinishReason` of the same name: any `max-tokens` step in a turn makes the whole turn end `max-tokens` rather than `completed` (the cut-short fact wins over a later continuation), so a consumer can tell a clean stop from a truncated one — but only over `completed`: the `disposed`/`aborted`/`error` outcomes take precedence. `rejected` is a zero-step turn whose whole prompt batch an `agent/prompt-submit` hook blocked (the ACP bridge maps it to `cancelled`). `interrupted` is the one reason no loop emits — it is synthesized by crash recovery (see [persistence.md](persistence.md)). Both maps are merge-extensible.

## The turn-enclosure invariant

Every session event lives **inside** a turn (between a `turn/start` and its `turn/end`). The loop appends queued `user/message` events *after* `turn/start`, and an idle `agent.inject()` wraps its `context/message` in a one-shot `injection` turn. This makes the turn the single durability/replay boundary: a backend can treat anything after the last `turn/end` as an interrupted-crash tail without risking the loss of legitimately-recorded between-turn context. The `dsh-invariants` plugin enforces it in dev (a message event outside an open turn throws). See [the turn-enclosure invariant RFC](../rfc/implemented/architecture/2026-06-15-turn-enclosure-invariant.md).

## Plugin-contributed log-only events

A plugin may declaration-merge extra `SessionEventMap` types. These are **log-only**: NOT `SurfaceEventType`s (they carry no `surfaceOp` and contribute nothing to derived history), but, like every event, they must sit inside an open turn. The full per-event enumeration — core and plugin-contributed alike, with payloads and provenance — is the generated [persistence log event catalog](../persistence-catalog/log-events.md); the compaction seam's `compact/*` semantics are discussed on [compaction.md](compaction.md).

The hook bridges' `hook/invoked` / `hook/result` provenance pairs (from `@deepseek-ai/dsh-hook-protocol`) correlate by `handlerId`. The mid-turn hook points (`PreToolUse`/`PostToolUse`/`UserPromptSubmit`/`Stop`) fire inside the loop's open turn, so their `hook/*` records are turn-enclosed by construction. `SessionStart` gets no `hook/*` record — its injected `context/message` is the durable evidence — because it has no open turn to enclose one (see [the hook-bridges RFC](../rfc/implemented/feature/2026-06-30-hook-bridges.md)).

## Durability contract

What a persistence backend relies on: the durable log persists every event verbatim, **including** `assistant/chunk` — `seq` must stay contiguous, so chunks cannot be filtered out of the canonical log. All `event.data` must be JSON-serializable; `Session.append` enforces this at the source (throwing on non-serializable data), so a bad event never enters the log and `session.events` always equals what a backend can persist. Adding an event type that carries non-serializable data, or that breaks the turn/step nesting the invariants plugin checks, is a breaking change to the on-disk format.

The backends that consume this contract are on [persistence.md](persistence.md).
