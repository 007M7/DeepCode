// ConversationSnapshot / ConversationNode: the only data shape the logic layer feeds the UI.
// Immutability contract: every change swaps the top-level object; unchanged
// substructures keep their references (the React.memo premise). callId/approvalId stay plain
// string here (narrow to real brands when convenient).

import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type {
  RpcError, SessionId, ToolCallView, ToolResultView, WorkspaceId,
} from '@deepseek-ai/dsh-client-connection/client'
import type { PendingInteraction } from './pending.ts'

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

/** Workspace target of a frontend-only Session. */
export type SessionIntentTarget =
  | { kind: 'workspace'; workspaceId: WorkspaceId }
  | { kind: 'workspace-intent' }

/** Publication state owned by a frontend Session before it joins the Host. */
export interface SessionIntentSnapshot {
  target: SessionIntentTarget
  phase: 'ready' | 'connecting'
  error?: { step: 'session'; message: string }
}

/** One editable prompt retained by its Session until the Host accepts it. */
export interface PendingPrompt {
  text: string
  phase: 'editing' | 'sending' | 'failed'
  /** Failed prerequisite retried before sending, or the send itself. */
  retry: 'connect' | 'send'
  /** Workspace needed when retrying Session attachment. */
  workspaceId?: WorkspaceId
  /** Last failure diagnostic, absent while editing or sending. */
  error?: string
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
  pending: readonly PendingInteraction[]
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
  /** Frontend-only publication state; null for a Host-connected Session. */
  intent: SessionIntentSnapshot | null
  /** Session-owned editable prompt waiting for connection, attachment, or send. */
  pendingPrompt: PendingPrompt | null
  lastAgentError: string | null
}
