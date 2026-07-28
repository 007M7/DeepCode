// Central contract re-export point: every contract import inside
// web-runtime goes through this single file.
// Types are type-only imports from the apiproxy api/ layer (zero Node deps, browser-safe);
// the only runtime values are the RpcId constructor and the AbstractApiClient seam.
// NEVER import the package root: it drags bootHost/cordis into the browser bundle.
// The ./api and ./client subpath exports are the browser-safe channels added for this.

export type {
  ApiProxy, SessionsApi, SessionSummary, HostApi, EventsApi, MuxFrame, HostFrame,
  ApprovalResponsePayload, QuestionResponsePayload, HistoryEntry, ToolEventView,
  WorkspaceApi, WorkspaceId, WorkspaceView,
  CommandsApi, CommandDescriptor, SkillsApi, SkillEntry,
  ModelCatalogFailure, ModelCatalogModel, ModelProviderGroup, ModelReasoning,
  ModelReasoningEffort, ModelTarget, SessionModels,
  GoalsApi, GoalRef,
} from '@deepseek-ai/dsh-host-apiproxy/api'
export type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools/presentation'
export type {
  RpcRequest, RpcResponse, RpcResult, RpcError, RpcErrorCode,
  ClientRequest, ServerResponse, ServerRequest, ClientResponse, RpcMessage, RpcReceipt,
} from '@deepseek-ai/dsh-host-apiproxy/api'
// transportError moved down to the apiproxy api layer (it belongs beside
// RpcResult, its subject); re-exported here so connection consumers keep one
// contract entry point.
export { RpcId, transportError } from '@deepseek-ai/dsh-host-apiproxy/api'
export { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
export type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
export type { SessionId, SessionEvent } from '@deepseek-ai/dsh-session/types'
export type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm/types'

import type { RpcResponse, RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'

/**
 * Unwrap a unary response: RpcResponse<T> -> RpcResult<T> (business code only
 * cares about the result slot).
 * @param response - the unary response.
 * @returns its result slot.
 */
export function resultOf<T>(response: RpcResponse<T>): RpcResult<T> {
  return response.result
}
