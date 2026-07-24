/**
 * sessions domain contract. Method signatures are the source of truth:
 * unary methods take the RpcRequest<P> narrow form and the impl echoes rpcId; everything
 * else references RequestPayload<'session.*'> / ResponseValue<'session.*'>.
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type { RpcId, RpcRequest, RpcResponse } from './rpc.ts'
import type { ToolEventView } from './events.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * The prompt's rpcId is passed through MessageSource into the `user/message` event
     * (the client uses it to reconcile the optimistically
     * echoed provisional message with the event stream). kind stays `'user'` — the model face
     * carries no transport vocabulary; rpcId is an extra durable-JSON field passed back to the client with the event.
     */
    'user-rpc': { kind: 'user'; rpcId: RpcId }
  }
}

/**
 * One history page entry: the raw event plus the optional host-computed render
 * intent (same semantics as the mux frame's `view` slot — a pagination-time
 * derivation, never persisted).
 */
export interface HistoryEntry {
  event: SessionEvent
  view?: ToolEventView
}

/** Session list entry (v1 builds no index: list does readdir+stat). */
export interface SessionSummary {
  sessionId: SessionId
  /** Persisted file mtime. */
  updatedAt: number
  /** Status of the attached agent; always false for cold (unattached) sessions. */
  running: boolean
  /** fork/spawn lineage (session.header.parentSession passthrough); absent for root sessions. */
  parentSessionId?: SessionId
  /** Session working directory (header.cwd passthrough); absent when unrecorded. */
  cwd?: string
}

/**
 * Plan collaboration state exposed to clients. `active` is the logged state
 * shaping the current request; `pending`, when present, is the user's
 * next-boundary selection and differs from `active`.
 */
export interface PlanModeState {
  active: boolean
  pending?: boolean
}

/** Session-domain unary methods (the map keys session.* of RpcMethodMap). */
export interface SessionsApi {
  /** Lists persisted sessions (updatedAt descending). v1 returns everything; cursor is a reserved seat, unimplemented. */
  list(request: RpcRequest<{ cursor?: string }>): Promise<RpcResponse<{ items: SessionSummary[] }>>

  /** Creates a new session (and its agent, idle and standing by). */
  create(request: RpcRequest<{ cwd?: string }>): Promise<RpcResponse<{ sessionId: SessionId }>>

  /**
   * Reads a window of history events; page boundaries align to message boundaries: one page =
   * all raw events owned by a whole number of messages (including their chunk / tool events),
   * never cut mid-message. The tail page (beforeSeq absent) additionally carries the in-flight
   * partial — chunk events already emitted for the last unfinalized message.
   * Each entry pairs the raw SessionEvent with the host-computed view (tool events whose
   * presenter produced one, evaluated against the registry at pagination time); the client
   * rebuilds the surface from the events with the shared fold.
   */
  history(request: RpcRequest<{ sessionId: SessionId; beforeSeq?: number; maxMessages?: number }>):
  Promise<RpcResponse<{ events: HistoryEntry[]; hasMore: boolean }>>

  /** Sends a message. content is core's ContentBlock[] verbatim; mode maps 1:1 — queue→send, steer→steer. */
  prompt(request: RpcRequest<{ sessionId: SessionId; mode: 'queue' | 'steer'; content: ContentBlock[] }>):
  Promise<RpcResponse<{ accepted: true }>>

  /** Stops: clears both FIFOs + aborts the current step (1:1 with agent.cancel). */
  cancel(request: RpcRequest<{ sessionId: SessionId }>): Promise<RpcResponse<{ accepted: true }>>

  /**
   * Reads plan collaboration state. `null` means the host did not compose the
   * optional plan-mode service; it is distinct from inactive state.
   */
  planMode(request: RpcRequest<{ sessionId: SessionId }>): Promise<RpcResponse<PlanModeState | null>>

  /**
   * Selects plan collaboration state for the next model-request boundary.
   * The returned state exposes the still-committed value and pending target;
   * `null` means plan mode is unavailable on this host.
   */
  setPlanMode(request: RpcRequest<{ sessionId: SessionId; active: boolean }>):
  Promise<RpcResponse<PlanModeState | null>>
}
