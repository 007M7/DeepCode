/**
 * Browser wire client. The plugin selects fixture or HTTP transport, provides
 * the shared API client, and lets the runtime object layer start the stream
 * controller with its sinks.
 */
import type { Context } from 'cordis'
import { workspaceFileSegments, workspaceFileUrl } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { FILES_PORT_GLOBAL } from '../files-server.ts'
import type { IApiClient } from './api.ts'
import { ConnectionController, type ConnectionConfig, type ConnectionSinks, type ConnectionState } from './connection.ts'
import { FixtureApiClient } from './fixture.ts'
import { WebApiClient } from './web-api-client.ts'

// ---- Contract re-exports (browser-safe apiproxy channels + core types) ----
export type {
  ApiProxy, SessionsApi, SessionSearchItem, SessionSummary, HostApi, EventsApi, MuxFrame, HostFrame,
  ApprovalResponsePayload, QuestionResponsePayload, HistoryEntry, ToolEventView,
  DirectoryEntry, DirectoryListing,
  ToolCallView, ToolResultView, WorkspaceApi, WorkspaceId, WorkspaceView,
  CommandsApi, CommandDescriptor, SkillsApi, SkillEntry,
  ModelCatalogFailure, ModelCatalogModel, ModelProviderGroup, ModelReasoning,
  InboxItemId, ModelReasoningEffort, ModelTarget, QueueAction, QueuedInboxItem, SessionModels,
  RpcRequest, RpcResponse, RpcResult, RpcError, RpcErrorCode,
  ClientRequest, ServerResponse, ServerRequest, ClientResponse, RpcMessage, RpcReceipt,
  IApiClient, SessionId, SessionEvent, ContentBlock, StreamChunk,
  GoalsApi, GoalRef,
  SettingsApi, SettingsNamespaceView, SettingsPathOpView, SettingsSecretView,
  CredentialsApi, CredentialView, ConfigurableProviderView, LlmApi,
} from './api.ts'
export {
  RpcId,
  AbstractApiClient,
  transportError,
} from './api.ts'

// Connection loop types are public through ConnectionHandle.start; the
// controller remains package-internal.
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
  /**
   * Absolute URL serving one file out of a Session's workspace, on the
   * transport's own workspace-file origin — the same hostname the page is
   * reached by, a different port, so a served document is isolated from this
   * API without being stripped of its own capabilities.
   * @param sessionId - the Session whose cwd anchors the path.
   * @param cwd - that Session's working directory, or `undefined` when unknown.
   * @param path - the path a tool reported (absolute, or relative to `cwd`).
   * @returns the URL, or `undefined` when the path lies outside the workspace
   * (which this transport never serves) or when this page was not served by a
   * host that published a workspace-file port (the fixture carrier).
   */
  fileUrl(sessionId: SessionId, cwd: string | undefined, path: string): string | undefined
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
    fileUrl(sessionId, cwd, path) {
      // Published by the node half's index tap; absent means no host is
      // serving workspace files to this page (the keyless fixture lane).
      const port = (globalThis as unknown as Record<string, unknown>)[FILES_PORT_GLOBAL]
      if (typeof port !== 'number') return undefined
      const segments = workspaceFileSegments(cwd, path)
      if (segments === undefined) return undefined
      return `${location.protocol}//${location.hostname}:${String(port)}${workspaceFileUrl(sessionId, segments)}`
    },
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
