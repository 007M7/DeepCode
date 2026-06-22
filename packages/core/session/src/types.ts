import type { Branded } from '@deepseek-ai/dsh-brand'
import type { CallId, ContentBlock, MessageSource, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'

/** Identifies one session in the store (and its persistence artifacts). */
export type SessionId = Branded<'SessionId'>

/** Brand a string as a {@link SessionId}. */
export function SessionId(id: string): SessionId {
  return id as SessionId
}

/**
 * The on-disk session format version, stamped into every newly-written
 * {@link SessionHeader} and enforced by every persistence backend on load. The
 * single source of truth for the version — write sites and the load-time check
 * all read it.
 *
 * It is **`0`** deliberately: while the harness is unreleased the on-disk format
 * is **unstable / pre-release, with no compatibility implied**. Breaking changes
 * to the persisted {@link SessionEventMap} shape (folding fields onto an event,
 * removing a variant, …) happen freely and do NOT bump this — v0 absorbs all
 * pre-release churn, and a backend simply REJECTS any log not at v0 (there is no
 * migration; no persisted user data exists to preserve). A real, monotonically
 * bumped version policy begins at the first tagged release, when a specific
 * format boundary becomes worth distinguishing.
 */
export const SESSION_FORMAT_VERSION = 0

/**
 * Immutable session metadata — written once at creation and never rewritten.
 *
 * Kept SEPARATE from the event log deliberately: format-version, cwd, and
 * lineage are storage concerns, not conversation events, so they stay out of
 * {@link SessionEventMap} and never reach `deriveMessages()`. Every reference
 * system (pi's `version: 3` header, Codex's `SessionMeta`, Claude Code's tail
 * metadata) writes such a header.
 */
export interface SessionHeader {
  /**
   * On-disk format version, stamped from {@link SESSION_FORMAT_VERSION} when the
   * session is created. A persistence backend rejects any other version on load
   * (no migration — see the constant).
   */
  version: number
  /** The session's id (mirrors the {@link Session}'s id). */
  id: SessionId
  /** Unix epoch milliseconds when the session was created. */
  createdAt: number
  /** Absolute working directory the session was created in (if any). */
  cwd?: string
  /** The session this one was forked from (seed lineage), if any. */
  parentSession?: SessionId
  /**
   * How many leading events were INHERITED via a seed rather than produced by
   * this session — the seed boundary. Set when a fork seeds a child with a
   * prefix of the parent's log (= the seeded prefix length); absent/0 means the
   * session produced all its own events. Persisted so a reload reconstructs the
   * boundary instead of re-deriving it from the full stored log, and so a replay
   * harness can skip the inherited prefix when deriving the child's OWN script
   * (the seeded events are the parent's, not this child's model calls).
   */
  seedLength?: number
}

/**
 * Options for creating a {@link Session} via the store. `seed` replays/forks
 * an existing event log; `meta` carries the caller-supplied storage fields the
 * store folds into a {@link SessionHeader}.
 */
export interface CreateSessionOptions {
  /** Events to seed the new session with (replay/fork). */
  seed?: SessionEvent[]
  /**
   * Creation metadata. The store fills in `version`/`id` and defaults
   * `createdAt` to now; the caller supplies the storage-level fields (validated
   * absolute `cwd`, `parentSession` lineage, the seed boundary `seedLength`, and
   * — when reconstructing a persisted session — the original `createdAt` to
   * preserve it).
   *
   * `seedLength` is EXPLICIT, not inferred from `seed.length`: a reconstruction
   * (resume/load) seeds the WHOLE stored log, so its `seed.length` is the full
   * length, not the original boundary — the caller must pass the persisted
   * boundary back. A fresh fork passes its actual seeded-prefix length.
   */
  meta?: { cwd?: string; parentSession?: SessionId; createdAt?: number; seedLength?: number }
}

/**
 * What started a turn.
 * Merge-extensible sum type (same pattern as MessageSourceMap).
 */
export interface TurnTriggerMap {
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

export type TurnTrigger = TurnTriggerMap[keyof TurnTriggerMap]

/**
 * Why a turn ended.
 * Merge-extensible sum type.
 *
 * `max-tokens` mirrors the model-call `FinishReasonMap` variant (DeepSeek's
 * `length`): the turn ended because a step hit the output-token ceiling, not
 * because the model chose to stop. The agent-loop surfaces it via the rule
 * "any `max-tokens` step in the turn makes the turn end `max-tokens`" (a
 * continuation plugin can run further steps after one, but the cut-short fact
 * still wins). It is distinct from `completed` so a consumer (e.g. the ACP
 * bridge mapping to `StopReason: 'max_tokens'`) can tell a clean stop from a
 * truncated one. The next variants to add — when an adapter/loop first emits
 * them — are `refusal` and `max_turn_requests` (both named by the ACP RFC as ACP
 * stop reasons); no current adapter produces a `refusal` finish (unknown
 * DeepSeek finish reasons collapse to `error`), so it is deliberately omitted
 * until one does.
 */
export interface TurnEndReasonMap {
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

export type TurnEndReason = TurnEndReasonMap[keyof TurnEndReasonMap]

/**
 * The session event vocabulary — the append-only source of truth for an
 * agent's whole interaction history. The LLM message history is *derived*
 * from this log; nothing else is authoritative. Replay = re-derive from the
 * same events; trace/telemetry = subscribe to the log.
 *
 * Merge-extensible: plugins declare extra event types via declaration merging
 * (e.g. a compaction plugin adds `'compaction/marker'`).
 *
 * Durability contract (what a persistence backend relies on): the durable log
 * persists every event verbatim, INCLUDING `assistant/chunk` — `seq` must stay
 * contiguous (`seq = log.length`), so chunks cannot be filtered out of the
 * canonical log. All `event.data` must be JSON-serializable — `Session.append`
 * (and the seed path in the constructor) enforces this at the source (throwing
 * on non-serializable data), so a bad event never enters the log and
 * `session.events` always equals what a backend can persist. Adding a new event
 * type that carries non-serializable data, or that breaks the turn/step nesting
 * the invariants plugin checks, is a breaking change to the on-disk format.
 */
export interface SessionEventMap {
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

export type SessionEventType = keyof SessionEventMap

/**
 * One immutable entry in the session log.
 *
 * A proper discriminated union over `type` (not independent `type`/`data`
 * unions), so `switch (event.type)` narrows `event.data` without casts.
 */
export type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: {
    type: K
    /** Monotonic sequence number within the session. */
    seq: number
    /** Unix epoch milliseconds. */
    time: number
    data: SessionEventMap[K]
  }
}[T]
