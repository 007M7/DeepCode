/**
 * events domain contract: signatures and frame unions for the two SSE
 * streams. Four-quadrant: streams yield the narrow form `RpcRequest<Frame>` (server-request
 * view) — rpcId must be exposed to the business layer, because responses to answerable frames
 * (approval/question requested) echo it; for pure pushes it identifies that one push.
 * signal is a local stream-control parameter, independent of the request (never on the wire).
 */

import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-interaction/types'
import type { ApprovalOutcome, ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'
import type { CallId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools/presentation'
import type { RpcError, RpcId, RpcRequest } from './rpc.ts'
import type { WorkspaceView } from './workspace.ts'

// Client-side consumers take the render-intent vocabulary from the contract;
// dsh-tools remains its owner.
export type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools/presentation'

/**
 * Host-computed render intent accompanying a `tool/call` or `tool/result`
 * event. A pure derivation of args/result through the presenter registered at
 * emission time — never persisted (the session log carries only the event), so
 * the same event may carry a different view (or none) on a later delivery.
 * `for` names which vocabulary applies without re-inspecting the event type.
 * An absent view means the client's documented default (generic JSON card).
 */
export type ToolEventView =
  | { for: 'call'; view: ToolCallView }
  | { for: 'result'; view: ToolResultView }

/** Streaming face of the contract: the two SSE stream openers (mux + host). */
export interface EventsApi {
  /**
   * All-session aggregated mux stream. On open, emits a subscribed control frame for every
   * attached session followed by its optional latest title snapshot, then replays each
   * session's still-pending approval/question requested frames (rpcId reused verbatim — the
   * refresh-recovery baseline).
   * since: resume seam, unimplemented in v1 (ignored if passed); reconnection = reopen the
   * stream + refetch history.
   */
  mux(request: RpcRequest<{ since?: Record<SessionId, number> }>, signal: AbortSignal): AsyncIterable<RpcRequest<MuxFrame>>

  /**
   * Host-level info stream: session create/destroy, running-status flips, and
   * agent failures with no turn position. Empty payload uses `{}`.
   */
  host(request: RpcRequest<{}>, signal: AbortSignal): AsyncIterable<RpcRequest<HostFrame>>
}

/**
 * Mux stream frames: raw session-event passthrough + control frames +
 * approval/question frames (requested = answerable server-request, the rest are pure pushes).
 */
export type MuxFrame =
  | { type: 'session/event'; sessionId: SessionId; event: SessionEvent; view?: ToolEventView }
  | { type: 'session/subscribed'; sessionId: SessionId; lastSeq: number }
  | { type: 'session/title'; sessionId: SessionId; title: string; eventSeq: number; updatedAt: number }
  | { type: 'approval/requested'; sessionId: SessionId; approvalId: ApprovalRequestId; toolName: string; callId?: CallId; reason?: string }
  | { type: 'approval/resolved'; sessionId: SessionId; approvalId: ApprovalRequestId; outcome: ApprovalOutcome }
  | { type: 'question/requested'; sessionId: SessionId; questions: AskUserQuestionItem[] }
  | { type: 'question/resolved'; sessionId: SessionId; questionRpcId: RpcId; outcome: 'answered' | 'cancelled' }
  | { type: 'stream/error'; error: RpcError }

/**
 * Host stream frames. session-added carries the lineage anchor and the
 * project cwd (the list-summary fields a client cannot wait for a refresh to
 * learn); agent-error is the only outlet for live failures with no turn
 * position; workspace-changed pushes the full new snapshot after every
 * durable workspace mutation (create/attach/order change — the client
 * upserts, while `workspace.list` provides the reconnect baseline).
 */
export type HostFrame =
  | { type: 'host/session-added'; sessionId: SessionId; parentSessionId?: SessionId; cwd?: string }
  | { type: 'host/session-removed'; sessionId: SessionId }
  | { type: 'host/session-status'; sessionId: SessionId; running: boolean }
  | { type: 'host/agent-error'; sessionId: SessionId; message: string }
  | { type: 'host/workspace-changed'; workspace: WorkspaceView }
  | { type: 'stream/error'; error: RpcError }
