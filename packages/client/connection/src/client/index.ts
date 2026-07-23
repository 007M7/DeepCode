/**
 * Browser half of the wire consumer layer (contract: api-contracts v3
 * section 3; export inventory = v3 §3.2). The wire is this package's client
 * half in its entirety — apply mounts ctx.connection: the shared api client
 * plus the connection controller handle. Mode selection (?fixture) happens
 * here so the rest of the client tree is mode-blind; the controller's sinks
 * are wired by the runtime plugin (object layer), which injects this service.
 */
import type { Context } from 'cordis'
import type { IApiClient } from './api.ts'
import { ConnectionController, type ConnectionConfig, type ConnectionSinks, type ConnectionState } from './connection.ts'
import { FixtureApiClient } from './fixture.ts'
import { WebApiClient } from './web-api-client.ts'

// ---- Contract re-exports (browser-safe apiproxy channels + core types) ----
export type {
  ApiProxy, SessionsApi, SessionSummary, HostApi, EventsApi, MuxFrame, HostFrame,
  ApprovalResponsePayload, QuestionResponsePayload, HistoryEntry, ToolEventView,
  ToolCallView, ToolResultView,
  RpcRequest, RpcResponse, RpcResult, RpcError, RpcErrorCode,
  ClientRequest, ServerResponse, ServerRequest, ClientResponse, RpcMessage, RpcReceipt,
  IApiClient, SessionId, SessionEvent, ContentBlock, StreamChunk,
} from './api.ts'
export { RpcId, AbstractApiClient, transportError } from './api.ts'

// ---- Connection loop types (part of the ConnectionHandle.start contract;
// the controller class itself stays package-internal — apply owns the loop,
// tests reach it via src) ----
export type { ConnectionConfig, ConnectionSinks, ConnectionState }


/** Required services (none — this is the wire root). */
export const inject: string[] = []

/**
 * The ctx.connection service surface: the api client plus a one-shot
 * controller starter (the runtime plugin supplies sinks when its object layer
 * is ready — connection stays consumer-agnostic).
 */
export interface ConnectionHandle {
  /** Shared api client (fixture or real, decided at boot from the page URL). */
  readonly api: IApiClient
  /**
   * Start the connect/pump/reconnect loop with the consumer's frame sinks.
   * One consumer owns the streams (the runtime object layer); a second call
   * throws.
   * @param sinks - frame/state callbacks.
   * @param config - reconnect/backoff tunables.
   * @returns stop handle for the loop.
   */
  start(sinks: ConnectionSinks, config?: ConnectionConfig): { stop(): void }
}

/**
 * Client plugin body: pick the api by page mode and provide ctx.connection.
 * @param ctx - client cordis context.
 */
export function apply(ctx: Context): void {
  const fixture = typeof location !== 'undefined' && new URLSearchParams(location.search).has('fixture')
  const api: IApiClient = fixture ? new FixtureApiClient() : new WebApiClient()
  let started = false
  const handle: ConnectionHandle = {
    api,
    start(sinks, config) {
      if (started) throw new Error('connection: the stream loop is already owned by another consumer')
      started = true
      const controller = new ConnectionController(api, sinks, config ?? {})
      controller.start()
      return { stop: () => { controller.stop() } }
    },
  }
  ctx.provide('connection', handle)
}
