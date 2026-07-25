/**
 * apiproxy contract-layer barrel. api/ has zero Node dependencies and is
 * importable from the browser; the TS interfaces are the authoritative contract, HTTP/SSE are
 * merely physical channels (four-quadrant message model).
 */

import type { SessionsApi } from './sessions.ts'
import type { HostApi } from './host.ts'
import type { WorkspaceApi } from './workspace.ts'
import type { EventsApi } from './events.ts'
import type { ClientResponse, RpcReceipt } from './rpc.ts'

/** Root interface of the unified API surface. New client-request domain = one new file pair + one field here + one map row. */
export interface ApiProxy {
  sessions: SessionsApi
  host: HostApi
  workspace: WorkspaceApi
  events: EventsApi
  /** Response entry for server-requests (client-response, echoing their rpcId); not a domain method (four-quadrant model). */
  respond(message: ClientResponse): Promise<RpcReceipt>
}

// ---- Domain interfaces and payload entities ----
export type { HistoryEntry, SessionsApi, SessionSummary } from './sessions.ts'
export type { HostApi } from './host.ts'
export type { WorkspaceApi, WorkspaceId, WorkspaceView } from './workspace.ts'
export type { EventsApi, MuxFrame, HostFrame, ToolCallView, ToolEventView, ToolResultView } from './events.ts'
export type { ApprovalResponsePayload } from './approvals.ts'
export type { QuestionResponsePayload } from './questions.ts'

// ---- Message layer: narrow forms (domain-signature view) ----
export type { RpcRequest, RpcResponse } from './rpc.ts'

// ---- Message layer: the four wire full forms + carrier receipt ----
export type {
  ClientRequest,
  ClientResponse,
  RpcMessage,
  RpcReceipt,
  ServerRequest,
  ServerResponse,
} from './rpc.ts'

// ---- Errors and ids ----
export { RpcId, transportError } from './rpc.ts'
export type { RpcError, RpcErrorCode, RpcErrorDetailsMap, RpcResult } from './rpc.ts'

// ---- Method registry and derived generics ----
export type { RequestPayload, ResponseValue, RpcMethodMap } from './rpc-map.ts'
