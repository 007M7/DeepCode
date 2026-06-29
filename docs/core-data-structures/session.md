# Sessions

The in-memory, event-sourced model of [dsh-session](../../packages/core/session). A `Session` is an **append-only log** of typed `SessionEvent`s — the single source of truth for an agent's whole interaction history. The LLM message history is *derived* from the log, never stored separately; replay is re-derivation from the same events. How the log is made **durable** (the persistence seam, backends, crash recovery) is the sibling concern on [persistence.md](persistence.md).

Source: [`packages/core/session/src/types.ts`](../../packages/core/session/src/types.ts)

## `SessionEventMap` — the event vocabulary

The append-only event types. Merge-extensible: a plugin declares extra event types via declaration merging — e.g. the [compaction seam](compaction.md) adds `compact/start` / `compact/summary` / `compact/end`.

```ts type-equiv
interface SessionEventMap {
  'turn/start': { turn: number; trigger: TurnTrigger }
  'turn/end': { turn: number; reason: TurnEndReason }
  'step/start': { turn: number; step: number }
  'step/end': { turn: number; step: number }
  /** A user-visible prompt (queued message drained at turn start). */
  'user/message': { content: ContentBlock[]; source: MessageSource }
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
  'tool/result': { turn: number; step: number; callId: CallId; content: ContentBlock[]; isError: boolean; error?: { name: string; code: string } }
  /** Steering content injected between steps of a running turn. */
  'steering/message': { turn: number; content: ContentBlock[]; source: MessageSource }
}
```

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
     * or the surface nodes shadowed by a compaction marker).
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

## Derived history: `deriveMessages()`

`Session.deriveMessages()` projects the event log into the `Message[]` the model sees. The projection rules:

- `user/message` → a user message.
- `assistant/message` → an assistant message. Raw `assistant/chunk` events are replay/UI data and are **skipped** in derivation (the assembled message is authoritative). An **empty-content** `assistant/message` is also skipped — a max-tokens step cut off with no content still records an `assistant/message` to host its `usage`, but a content-less assistant turn must not enter the provider transcript.
- `tool/result` → a user message carrying a `tool-result` block.
- `context/message`, `steering/message` → user-role messages wrapped in a tagged envelope (`<context source="…">…</context>`) at their chronological position — the "system-reminder" pattern; the model distinguishes them from real prompts by the envelope.

Everything else (`turn/*`, `step/*`) is structural and does not project into a message. Token usage is observed on `assistant/message.usage` (the step that produced it); an operational error's step number is on `turn/end.reason` for `kind: 'error'`.

## What started a turn: `TurnTriggerMap`

```ts type-equiv
interface TurnTriggerMap {
  message: { kind: 'message'; source: MessageSource }
  continuation: { kind: 'continuation' }
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

`max-tokens` mirrors the model-call `FinishReason` of the same name: any `max-tokens` step in a turn makes the whole turn end `max-tokens` (the cut-short fact wins over a later continuation), so a consumer can tell a clean stop from a truncated one. `interrupted` is the one reason no loop emits — it is synthesized by crash recovery (see [persistence.md](persistence.md)). Both maps are merge-extensible.

## The turn-enclosure invariant

Every session event lives **inside** a turn (between a `turn/start` and its `turn/end`). The loop appends queued `user/message` events *after* `turn/start`, and an idle `agent.inject()` wraps its `context/message` in a one-shot `injection` turn. This makes the turn the single durability/replay boundary: a backend can treat anything after the last `turn/end` as an interrupted-crash tail without risking the loss of legitimately-recorded between-turn context. The `dsh-invariants` plugin enforces it in dev (a message event outside an open turn throws). See [the turn-enclosure invariant RFC](../rfc/implemented/architecture/2026-06-15-turn-enclosure-invariant.md).

## Durability contract

What a persistence backend relies on: the durable log persists every event verbatim, **including** `assistant/chunk` — `seq` must stay contiguous, so chunks cannot be filtered out of the canonical log. All `event.data` must be JSON-serializable; `Session.append` enforces this at the source (throwing on non-serializable data), so a bad event never enters the log and `session.events` always equals what a backend can persist. Adding an event type that carries non-serializable data, or that breaks the turn/step nesting the invariants plugin checks, is a breaking change to the on-disk format.

The backends that consume this contract are on [persistence.md](persistence.md).
