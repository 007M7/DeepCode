// ConversationSnapshot / ConversationNode: the only data shape the logic layer feeds the UI.
// Immutability contract: every change swaps the top-level object; unchanged
// substructures keep their references (the React.memo premise). callId/approvalId stay plain
// string here (narrow to real brands when convenient).

import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { TodoItem } from '@deepseek-ai/dsh-session/types'
import type {
  RpcError, SessionId, ToolCallView, ToolResultView,
} from '@deepseek-ai/dsh-client-connection/client'
import type { PendingInteraction } from './pending.ts'

export type { TodoItem }

/** Assistant content blocks sorted by what the UI cares about
 *  (text body / collapsible reasoning / tool-call card head / other fallback). */
export type AssistantBlock =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool-call'; callId: string; name: string; argsRaw: string }
  | { kind: 'other'; block: unknown }

/**
 * core ContentBlock[] -> AssistantBlock[] (classifier shared by finalized messages and partial block-end).
 * @param content - core content blocks verbatim.
 * @returns UI-classified blocks in source order.
 */
export function toAssistantBlocks(content: readonly ContentBlock[]): AssistantBlock[] {
  return content.map(toAssistantBlock)
}

/**
 * Classify one block (ToolCallBlock fields are id/arguments, mapped to callId/argsRaw).
 * @param block - one core content block.
 * @returns the UI classification.
 */
export function toAssistantBlock(block: ContentBlock): AssistantBlock {
  switch (block.type) {
    case 'text': return { kind: 'text', text: block.text }
    case 'reasoning': return { kind: 'reasoning', text: block.text }
    case 'tool-call': return { kind: 'tool-call', callId: String(block.id), name: block.name, argsRaw: block.arguments }
    default: return { kind: 'other', block }
  }
}

/** A finalized user message. */
export interface UserMessageNode {
  kind: 'user'
  seq: number
  /** Unix epoch ms from the source session event. */
  time: number
  content: readonly ContentBlock[]
  source: unknown
}

/** A finalized (or interruption-frozen) assistant message. */
export interface AssistantMessageNode {
  kind: 'assistant'
  seq: number
  /** Unix epoch ms from the source session event (or turn/end when frozen from a partial). */
  time: number
  turn: number
  step: number
  blocks: readonly AssistantBlock[]
  usage?: unknown
  /** Frozen partial of an aborted turn (no finalize ever arrives): rendered with a 已停止 marker.
   *  Synthetic seq (fractional, derived from the turn/end seq) keeps it ordered inside the flow. */
  interrupted?: true
}

/** A steering message injected mid-turn. */
export interface SteeringMessageNode {
  kind: 'steering'
  seq: number
  /** Unix epoch ms from the source session event. */
  time: number
  turn: number
  content: readonly ContentBlock[]
  source: unknown
}

/** A context/system injection surfaced in the flow. */
export interface ContextMessageNode {
  kind: 'context'
  seq: number
  /** Unix epoch ms from the source session event. */
  time: number
  content: readonly ContentBlock[]
  source: unknown
  meta?: unknown
}

/** A tool result paired (when in-window) with its call head. */
export interface ToolResultNode {
  kind: 'tool-result'
  seq: number
  /** Unix epoch ms from the tool/result session event. */
  time: number
  callId: string
  /** Call head backfilled from the in-window tool/call; null when window truncation left the call outside (card head shows callId). */
  call: { name: string; argsRaw: string } | null
  /** Unix epoch ms of the paired tool/call when the call is still in-window; used for call-row duration. */
  callTime: number | null
  content: readonly ContentBlock[]
  isError: boolean
  error?: { name: string; code: string }
  meta?: unknown
  /** Host-computed render intent from the paired tool/call's wire view; null = generic JSON card (documented default). */
  callView: ToolCallView | null
  /** Host-computed render intent from this tool/result's wire view; null = same default. */
  resultView: ToolResultView | null
}

/** Fallback for surface events this UI version does not know. */
export interface UnknownSurfaceNode {
  kind: 'unknown'
  seq: number
  /** Unix epoch ms from the source session event when known. */
  time: number
  type: string
  data: unknown
}

/** Finalized conversation node union (kind discriminates; seq is the React key). */
export type ConversationNode =
  | UserMessageNode
  | AssistantMessageNode
  | SteeringMessageNode
  | ContextMessageNode
  | ToolResultNode
  | UnknownSurfaceNode

/**
 * One `run_code` sub-dispatch materialized in the native call-block shapes so
 * every consumer (tool rows, details panel) renders it through the exact
 * components that render a native call: a started-but-unsettled sub-call is a
 * {@link RunningToolCall} (rows derive the running state from the shape,
 * exactly as for native calls) and its `tool/code-dispatch` settlement
 * replaces it in place with the {@link ToolResultNode} form. Never part of
 * the surface `nodes` flow — sub-calls live under their parent via
 * {@link ConversationSnapshot.codeDispatches}. `callId` is the deterministic
 * sub-call id (`<parent>:code:<n>`); the call side carries the sub-tool name
 * and its JSON-stringified logged arguments; `content`/`isError` are the
 * settled sub-call's complete logged outcome.
 */
export type CodeSubCall = RunningToolCall | ToolResultNode

/** In-flight tool card material: tool/call seen, tool/result not yet. */
export interface RunningToolCall {
  callId: string
  name: string
  argsRaw: string
  turn: number
  step: number
  /** Unix epoch ms when the tool/call event was logged. */
  time: number
  /** Host-computed render intent riding the tool/call frame; null = generic JSON card. */
  callView: ToolCallView | null
}


/** One queued-message row mirrored from `session/queued` frames (key: the enqueueing prompt's rpcId when wire-sourced). */
export interface QueuedMessage {
  readonly key: string
  readonly preview: string
}

/** In-progress assistant output (chunk accumulator product). */
export interface PartialAssistant {
  turn: number
  step: number
  blocks: readonly AssistantBlock[]
}

/** History-open lifecycle of a Session window. */
export type OpenState = 'cold' | 'loading' | 'open' | 'error'

/**
 * Input-area shape of an OPEN session, derived at snapshot assembly (the one
 * place that knows the predicate — consumers switch, never re-derive):
 *
 * - `blank`: no activity ever (no nodes, no partial, not running, no pending
 *   waits, no prompt attempt) — the UI renders the blank-session guidance
 *   hero.
 * - `engaging`: the first prompt was initiated but no content landed yet —
 *   the UI holds the composer through the accept → running → first-event
 *   frames. Entered synchronously before prompt()'s first await.
 * - `active`: content exists (nodes, partial, running turn, or pending
 *   waits) — the ordinary conversation view.
 *
 * Monotone within a session object: blank → engaging → active, no returns.
 * A failed first prompt stays `engaging` (composer + error strip — retry
 * semantics; bouncing back to the hero would discard the error context).
 * Sessions whose window is not open (`loading`/`error`) are outside phase
 * jurisdiction: consumers branch on {@link ConversationSnapshot.openState}
 * first (phase still reports `active`-ish facts but must not be rendered).
 */
export type ComposerPhase = 'blank' | 'engaging' | 'active'

/** Send/stop failure surfaced in the input error strip; op picks the user-facing copy (发送失败 vs 停止失败). */
export interface PromptError {
  op: 'send' | 'stop'
  error: RpcError
}

/** The immutable snapshot contract Session hands to uSES (see the web client architecture RFC). */
export interface ConversationSnapshot {
  sessionId: SessionId
  /** Surface fold product (finalized conversation nodes in surface order). */
  nodes: readonly ConversationNode[]
  /** Fold degradation flag (cross-window replace defense): when true, nodes come from the lenient linear scan. */
  foldDegraded: boolean
  partial: PartialAssistant | null
  runningCalls: readonly RunningToolCall[]
  /**
   * `run_code` sub-dispatches grouped under their parent callId, in dispatch
   * order. Populated from in-window `tool/code-dispatch` events (live and
   * replay identically); the per-parent array reference is stable across
   * unrelated snapshot swaps (memo premise, same regime as `nodes`).
   */
  codeDispatches: ReadonlyMap<string, readonly CodeSubCall[]>
  pending: readonly PendingInteraction[]
  /** Read-only inbox mirror (session/queued frames + mux-open baseline; cleared by the leave-running flip). */
  queue: readonly QueuedMessage[]
  running: boolean
  /** Input-area shape (see {@link ComposerPhase}); derived here, switched on by consumers. */
  composerPhase: ComposerPhase
  /** Set after host/session-removed; the UI grays out and disables input. */
  removed: boolean
  openState: OpenState
  openError: RpcError | null
  hasMore: boolean
  loadingOlder: boolean
  promptError: PromptError | null
  /**
   * Whether this session still has an empty log (no user message yet).
   * Mirrors the host summary's derived blank bit: seeded from `session.list`
   * / the `host/session-added` frame, flipped false by the first ACCEPTED
   * prompt locally (on the RPC success response — acceptance proves the
   * user message is in the host log; a rejected first prompt keeps the
   * session blank and reusable) and by any `running: true` status remotely,
   * and re-aligned by every list re-pull (the summary stays authoritative).
   * Blank sessions are hidden from session lists and reused by New Session.
   */
  blank: boolean
  lastAgentError: string | null
  /** Current whole-list `todo/write` projection — the tail page's full-log value, then each live
   *  write (last write wins); empty = the log holds no plan. */
  todos: readonly TodoItem[]
}
