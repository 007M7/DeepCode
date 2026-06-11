import type { Branded, CallId, ContentBlock, MessageSource, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'

/** Identifies one session in the store (and its persistence artifacts). */
export type SessionId = Branded<'SessionId'>

/** Brand a string as a {@link SessionId}. */
export function SessionId(id: string): SessionId {
  return id as SessionId
}

/**
 * What started a turn.
 * Merge-extensible sum type (same pattern as MessageSourceMap).
 */
export interface TurnTriggerMap {
  message: { kind: 'message'; source: MessageSource }
  continuation: { kind: 'continuation' }
}

export type TurnTrigger = TurnTriggerMap[keyof TurnTriggerMap]

/**
 * Why a turn ended.
 * Merge-extensible sum type.
 */
export interface TurnEndReasonMap {
  completed: { kind: 'completed' }
  aborted: { kind: 'aborted'; reason?: string }
  error: { kind: 'error'; message: string; code?: string }
  disposed: { kind: 'disposed' }
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
 * TODO(review): this vocabulary needs careful review once the loop and the
 * first persistence plugin exist side by side.
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
  /** Assembled assistant message for one step (derived history uses this). */
  'assistant/message': { turn: number; step: number; content: ContentBlock[] }
  'tool/call': { turn: number; step: number; callId: CallId; name: string; arguments: string }
  'tool/result': { turn: number; step: number; callId: CallId; content: ContentBlock[]; isError: boolean }
  /** Steering content injected between steps of a running turn. */
  'steering/message': { turn: number; content: ContentBlock[]; source: MessageSource }
  'usage': { turn: number; step: number; usage: TokenUsage }
  'error': { turn: number; step: number; message: string; code?: string }
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
