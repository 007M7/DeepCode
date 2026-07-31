import type { Branded } from '@deepseek-ai/dsh-brand'
import type {
  AssistantMessage,
  CallId,
  LlmCallConfig,
  LlmCallConfigAdapterDefaults,
  LlmFailure,
  MessageSource,
  StreamChunk,
  TokenUsage,
  ToolResultMessage,
  ToolSchema,
  UserMessage,
} from '@deepseek-ai/dsh-llm'
import type { JsonValue } from './json.ts'

/** Identifies one session in the store (and its persistence artifacts). */
export type SessionId = Branded<'SessionId'>

/**
 * Brand a string as a {@link SessionId}.
 * @param id - the raw session id string.
 * @returns the same string, branded (a compile-time cast — no runtime cost).
 */
export function SessionId(id: string): SessionId {
  return id as SessionId
}

/**
 * The on-disk session format version, stamped into every newly-written {@link SessionHeader}
 * and enforced by every persistence backend on load. The single source of truth for the
 * version — write sites and the load-time check all read it.
 * While the harness is unreleased it is pinned at `0`: no compatibility is
 * implied, incompatible logs are rejected, and no migration is provided. A
 * monotonic version policy starts with the first tagged release.
 */
export const SESSION_FORMAT_VERSION = 0

/**
 * Immutable validated storage metadata, kept outside the conversation event log.
 */
export interface SessionHeader {
  /**
   * On-disk format version, stamped from {@link SESSION_FORMAT_VERSION} when the
   * session is created. A persistence backend rejects any other version on load
   * (no migration — see the constant).
   */
  readonly version: number
  /** The session's id (mirrors the {@link Session}'s id). */
  readonly id: SessionId
  /** Non-negative safe-integer Unix epoch milliseconds when the session was created. */
  readonly createdAt: number
  /** Absolute working directory the session was created in (if any). */
  readonly cwd?: string
  /** The session this one was forked from (seed lineage), if any. */
  readonly parentSession?: SessionId
  /**
   * How many leading events were inherited through a seed. Persisting this
   * boundary lets resume and replay distinguish parent history from child work.
   */
  readonly seedLength?: number
  /**
   * Delegation depth: absent (zero) for a top-level session, parent depth + 1
   * for a subagent child. Persisted so a recursion budget survives restart and
   * resume — a runtime-only depth would reset a resumed child to top-level.
   */
  readonly delegationDepth?: number
}

/**
 * Options for creating a {@link Session} via the store. `seed` replays/forks
 * an existing event log; `meta` carries the caller-supplied storage fields the
 * store folds into a {@link SessionHeader}.
 */
export interface CreateSessionOptions {
  /** Initial replay or fork history supplied at construction. */
  readonly seed?: readonly SessionEvent[]
  /**
   * Storage metadata read once before publication. `seedLength` is explicit
   * because a resumed seed contains the full stored log, not only its inherited prefix.
   */
  readonly meta?: {
    readonly cwd?: string
    readonly parentSession?: SessionId
    readonly createdAt?: number
    readonly seedLength?: number
    readonly delegationDepth?: number
  }
}

/**
 * What started a turn.
 * Merge-extensible sum type (same pattern as MessageSourceMap).
 */
export interface TurnTriggerMap {
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

/** The union over {@link TurnTriggerMap} — what started a turn; plugins extend it by merging variants into the map. */
export type TurnTrigger = TurnTriggerMap[keyof TurnTriggerMap]

/**
 * Why a turn ended. Merge-extensible sum type.
 */
export interface TurnEndReasonMap {
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

/** The union over {@link TurnEndReasonMap} — why a turn ended; plugins extend it by merging variants into the map. */
export type TurnEndReason = TurnEndReasonMap[keyof TurnEndReasonMap]

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
export interface TodoItem {
  /** What this task is — a short imperative line shown in the UI. */
  content: string
  /** Lifecycle state. `in_progress` marks the single task being worked now. */
  status: 'pending' | 'in_progress' | 'completed'
}

/**
 * Logged request state outside derived history: call config, system prompt, and
 * tools. The latest full `request/header` snapshot reconstructs it; canonical
 * empty optional fields are absent.
 */
export interface EpochHeader {
  /** The conversation's call configuration (provider, model, reasoning effort, and sampling scalars). */
  config: LlmCallConfig
  /** Effective config fields materialized from the exact adapter rather than proposed by a caller. */
  adapterDefaults?: LlmCallConfigAdapterDefaults
  /** Rendered system prompt text; absent for a system-less request. */
  system?: string
  /** Assembled tool schemas; absent for a tool-less request. */
  tools?: ToolSchema[]
}

/**
 * Why a `request/header` snapshot was appended: `'initial'` — the log's first
 * header (a new conversation); `'resume'` — a loop instance's first request
 * over a log that already has header events (process restart, fork seed);
 * `'change'` — a later request used a different header.
 */
export type RequestHeaderReason = 'initial' | 'resume' | 'change'

/**
 * The merge-extensible, append-only source of truth for an agent interaction.
 * Message history is derived from this log. Every event is lossless JSON and
 * sequence numbers stay contiguous, including raw chunks, so persistence can
 * store the canonical log verbatim.
 */
export interface SessionEventMap {
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
  /**
   * Marks the end of a constructor seed. Events before it have smaller seq
   * values and came from the seed (resume, fork, or replay); this lifecycle
   * produced none of them. An explicitly supplied empty seed puts the marker
   * at seq 0, distinguishing an empty resumed session from a fresh session.
   * This log-only event is the durable projection of
   * {@link Session.firstLiveSeq}. Its payload is empty — position and `time`
   * carry the meaning.
   *
   * Locate the LAST one in stored history. A seed already ending in one is not
   * re-marked, so reopening an untouched session does not grow its log per
   * pickup and the event need not be at the current `firstLiveSeq`.
   *
   * `Session`'s constructor is the only legitimate writer. The invariant
   * companion deliberately constrains nothing here, so a plugin appending one
   * would silently classify every live bracket before it as seed history.
   *
   * An owner of a standalone open/close bracket (`compact/start` …
   * `compact/end`) reads it because seed history and live work are otherwise
   * byte-identical: an unmatched opening marker before this event belongs to
   * an ended lifecycle, whatever ended it. NOT a liveness signal about other
   * writers — a concurrently live session holds its own boundary elsewhere,
   * so tolerating concurrent writers needs a signal beyond the log.
   */
  'session/end-seed': Record<string, never>
}

/** The appendable event-type keys of {@link SessionEventMap}, plugin-merged extensions included. */
export type SessionEventType = keyof SessionEventMap

/**
 * The subset of {@link SessionEventType} values whose events produce LLM
 * messages and are eligible to appear on the ordered surface. Only these
 * event types may carry {@link SurfaceOp} and {@link SessionEvent.sourceEventSeqs}.
 */
export type SurfaceEventType =
  | 'user/message'
  | 'assistant/message'
  | 'tool/result'
  | 'steering/message'

/**
 * A {@link SessionEvent} that is **on** the ordered surface — its
 * `surfaceOp` is guaranteed present (mandatory), narrowed from a
 * surface-eligible {@link SessionEvent} by checking both `type` and
 * `surfaceOp` at runtime.
 *
 * Use the `isSurfaceEvent` type guard (in `surface.ts`) to narrow a
 * `SessionEvent` to this type.
 */
export type SurfaceEvent = SessionEvent<SurfaceEventType> & { surfaceOp: SurfaceOp }

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
export type SurfaceOp =
  | 'append'
  | { op: 'replace'; start: number; end: number }

/**
 * Surface placement and provenance for {@link Session.append}. Required on
 * message-producing events and forbidden on log-only events.
 */
export interface SurfaceIntent {
  surfaceOp: SurfaceOp
  /**
   * Complete known provenance source set. `assistant/message` may use a
   * present empty array for a known empty provider stream; omission means its
   * provenance was not recorded. Other surface events require a non-empty set
   * when this field is present.
   */
  sourceEventSeqs?: number[]
}

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
export type SessionEvent<T extends SessionEventType = SessionEventType> = {
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
