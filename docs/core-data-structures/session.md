# Sessions

The in-memory, event-sourced model of [dsh-session](../../packages/session). A `Session` is an **append-only log** of typed `SessionEvent`s — the single source of truth for an agent's whole interaction history. The LLM message history is *derived* from the log, never stored separately; replay is re-derivation from the same events. How the log is made **durable** (the persistence seam, backends, crash recovery) is the sibling concern on [persistence.md](persistence.md).

Source: [`packages/session/src/types.ts`](../../packages/session/src/types.ts)

## `SessionEventMap` — the event vocabulary

The append-only event types. Merge-extensible: a plugin (e.g. compaction) declares extra event types via declaration merging.

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
  /** Assembled assistant message for one step (derived history uses this). */
  'assistant/message': { turn: number; step: number; content: ContentBlock[] }
  'tool/call': { turn: number; step: number; callId: CallId; name: string; arguments: string }
  'tool/result': { turn: number; step: number; callId: CallId; content: ContentBlock[]; isError: boolean; error?: { name: string; code: string } }
  /** Steering content injected between steps of a running turn. */
  'steering/message': { turn: number; content: ContentBlock[]; source: MessageSource }
  'usage': { turn: number; step: number; usage: TokenUsage }
  'error': { turn: number; step: number; message: string; code?: string }
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
  }
}[T]
```

`SessionEventType = keyof SessionEventMap`. Because `SessionEventMap` is merge-extensible, switches over `SessionEvent` must NOT use `assertNever` — a plugin-added variant is a valid unknown value; handle the known cases and fall through `default`.

## Derived history: `deriveMessages()`

`Session.deriveMessages()` projects the event log into the `Message[]` the model sees. The projection rules:

- `user/message` → a user message.
- `assistant/message` → an assistant message. Raw `assistant/chunk` events are replay/UI data and are **skipped** in derivation (the assembled message is authoritative).
- `tool/result` → a user message carrying a `tool-result` block.
- `context/message`, `steering/message` → user-role messages wrapped in a tagged envelope (`<context source="…">…</context>`) at their chronological position — the "system-reminder" pattern; the model distinguishes them from real prompts by the envelope.

Everything else (`turn/*`, `step/*`, `usage`, `error`) is structural/telemetry and does not project into a message.

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
  error: { kind: 'error'; message: string; code?: string }
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

Every session event lives **inside** a turn (between a `turn/start` and its `turn/end`). The loop appends queued `user/message` events *after* `turn/start`, and an idle `agent.inject()` wraps its `context/message` in a one-shot `injection` turn. This makes the turn the single durability/replay boundary: a backend can treat anything after the last `turn/end` as an interrupted-crash tail without risking the loss of legitimately-recorded between-turn context. The `dsh-invariants` plugin enforces it in dev (a message event outside an open turn throws). See [the turn-enclosure invariant RFC](../rfc/implemented/2026-06-15-turn-enclosure-invariant.md).

## Durability contract

What a persistence backend relies on: the durable log persists every event verbatim, **including** `assistant/chunk` — `seq` must stay contiguous, so chunks cannot be filtered out of the canonical log. All `event.data` must be JSON-serializable; `Session.append` enforces this at the source (throwing on non-serializable data), so a bad event never enters the log and `session.events` always equals what a backend can persist. Adding an event type that carries non-serializable data, or that breaks the turn/step nesting the invariants plugin checks, is a breaking change to the on-disk format.

The backends that consume this contract are on [persistence.md](persistence.md).
