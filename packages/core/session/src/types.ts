import type { Branded } from '@deepseek-ai/dsh-brand'
import type { CallId, ContentBlock, LlmCallConfig, Message, MessageSource, StreamChunk, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm'

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
  /** Unix epoch milliseconds when the session was created. */
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
}

/**
 * Options for creating a {@link Session} via the store. `seed` replays/forks
 * an existing event log; `meta` carries the caller-supplied storage fields the
 * store folds into a {@link SessionHeader}.
 */
export interface CreateSessionOptions {
  /** Events to seed the new session with (replay/fork). */
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
  }
}

/**
 * What started a turn.
 * Merge-extensible sum type (same pattern as MessageSourceMap).
 */
export interface TurnTriggerMap {
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

/** The union over {@link TurnTriggerMap} — what started a turn; plugins extend it by merging variants into the map. */
export type TurnTrigger = TurnTriggerMap[keyof TurnTriggerMap]

/**
 * Why a turn ended. Merge-extensible sum type.
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

/** The union over {@link TurnEndReasonMap} — why a turn ended; plugins extend it by merging variants into the map. */
export type TurnEndReason = TurnEndReasonMap[keyof TurnEndReasonMap]

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
export interface TodoItem {
  /** What this task is — a short imperative line shown in the UI. */
  content: string
  /** Lifecycle state. `in_progress` marks the single task being worked now. */
  status: 'pending' | 'in_progress' | 'completed'
}

/**
 * Logged request state outside derived history: call config, system prompt,
 * tools, and session prefix. Header snapshots and deltas reconstruct it;
 * canonical empty optional fields are absent.
 */
export interface EpochHeader {
  /** The conversation's call configuration (model + sampling scalars). */
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

/**
 * Why a `request/header` snapshot was appended: `'initial'` — the log's first
 * header (a new conversation); `'resume'` — a loop instance's first request
 * over a log that already has header events (process restart, fork seed);
 * `'fallback'` — a mid-run change the delta encoding could not round-trip
 * (e.g. a pure tool reordering), recorded whole instead.
 */
export type RequestHeaderReason = 'initial' | 'resume' | 'fallback'

/**
 * Line-level edit of the system prompt: keep the first `keepStart` and last
 * `keepEnd` lines of the previous text, with `insert` replacing everything
 * between. Computed as a common-prefix/common-suffix trim — deterministic,
 * library-free, degenerating to a full replacement when nothing is shared.
 * Absence is encoded as zero lines (the canonical form has no empty-string
 * system), so a transition to or from "no system prompt" round-trips.
 */
export interface SystemDelta {
  /** Lines kept from the start of the previous system prompt. */
  keepStart: number
  /** Lines kept from the end of the previous system prompt. */
  keepEnd: number
  /** Lines replacing everything between the kept edges. */
  insert: string[]
}

/**
 * Tool-set edit keyed by tool name (names are unique — the registry rejects
 * duplicates): `removed` names drop, `changed` schemas replace their
 * predecessor in place, `added` schemas append at the end. A change this
 * encoding cannot express (a pure reordering) fails the writer's round-trip
 * guard and is recorded as a `'fallback'` snapshot instead.
 */
export interface ToolsDelta {
  /** Schemas appended to the end of the tool list. */
  added: ToolSchema[]
  /** Names of schemas dropped from the tool list. */
  removed: string[]
  /** Schemas replacing the same-named predecessor in place. */
  changed: ToolSchema[]
}

/**
 * The merge-extensible, append-only source of truth for an agent interaction.
 * Message history is derived from this log. Every event is lossless JSON and
 * sequence numbers stay contiguous, including raw chunks, so persistence can
 * store the canonical log verbatim.
 */
export interface SessionEventMap {
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
  /**
   * Whole-list snapshot; the latest write wins on replay. It is log-only UI
   * state and never enters derived model history.
   */
  'todo/write': { todos: TodoItem[] }
  /**
   * Full {@link EpochHeader} for the next request, appended inside its step
   * before dispatch. It is log-only and anchors subsequent deltas.
   */
  'request/header': { header: EpochHeader; reason: RequestHeaderReason }
  /**
   * Log-only amendment to the folded {@link EpochHeader}. System and tools use
   * their delta codecs; config and prefix replace whole, with an empty prefix
   * encoding removal. Writers verify round-trip equality or log a fallback snapshot.
   */
  'request/header-delta': { system?: SystemDelta; tools?: ToolsDelta; config?: LlmCallConfig; messagePrefix?: Message[] }
}

/** The appendable event-type keys of {@link SessionEventMap}, plugin-merged extensions included. */
export type SessionEventType = keyof SessionEventMap

/**
 * The subset of {@link SessionEventType} values whose events produce LLM
 * messages and are eligible to appear on the surface linked list. Only these
 * event types may carry {@link SurfaceOp} and {@link SessionEvent.sourceEventSeqs}.
 */
export type SurfaceEventType =
  | 'user/message'
  | 'assistant/message'
  | 'tool/result'
  | 'context/message'
  | 'steering/message'

/**
 * A {@link SessionEvent} that is **on** the surface linked list — its
 * `surfaceOp` is guaranteed present (mandatory), narrowed from a
 * surface-eligible {@link SessionEvent} by checking both `type` and
 * `surfaceOp` at runtime.
 *
 * Use the `isSurfaceEvent` type guard (in `surface.ts`) to narrow a
 * `SessionEvent` to this type.
 */
export type SurfaceEvent = SessionEvent<SurfaceEventType> & { surfaceOp: SurfaceOp }

/**
 * How a session event entered the surface linked list. Only valid on
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
export type SurfaceOp =
  | 'append'
  | { op: 'replace'; start: number; end: number }

/**
 * Surface placement and provenance for {@link Session.append}. Required on
 * message-producing events and forbidden on log-only events.
 */
export interface SurfaceIntent {
  surfaceOp: SurfaceOp
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
 * `assistant/message`, `tool/result`, `context/message`, `steering/message`).
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
     * or the surface nodes shadowed by a compaction replace node).
     */
    sourceEventSeqs?: number[]
    /** How this event entered the surface; absent for non-surface events. */
    surfaceOp?: SurfaceOp
  } : object)
}[T]
