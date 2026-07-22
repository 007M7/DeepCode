/**
 * Browser half: the whole runtime contract surface (api-contracts v3 §4) —
 * SlotsService, SessionsService (list store + scope tree + object layer),
 * the ClientLoader interface, and the cordis Context/Events merges. apply
 * mounts ctx.slots + ctx.sessions and wires the connection stream loop into
 * the object layer. The loader machinery implementation is NOT in the plugin
 * bundle — it ships via the package's `./loader` subpath, statically held by
 * the web shell (a loader cannot load itself).
 */
import type { Context } from 'cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionBinding as GenericSessionBinding } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore, UseSession } from '@deepseek-ai/dsh-client-web-react'
import { SlotsService } from './slots.ts'
import { SessionsService } from './sessions/service.ts'
import type { ConversationSnapshot, RunningToolCall, ToolResultNode } from './sessions/conversation.ts'

export { SlotsService } from './slots.ts'
export { SessionsService, scopeOf } from './sessions/service.ts'
export type { SessionBinding, SessionListState, SessionSummary } from './sessions/service.ts'
export { SessionManager } from './sessions/manager.ts'
export type { SessionListSnapshot } from './sessions/manager.ts'
export { Session, PAGE_MESSAGES } from './sessions/session.ts'
export type { SessionListEntry } from './sessions/lineage.ts'
export type {
  AssistantBlock, AssistantMessageNode, ContextMessageNode, ConversationNode, ConversationSnapshot,
  OpenState, PartialAssistant, PendingInteraction, PromptError, RunningToolCall, SteeringMessageNode,
  ToolResultNode, UnknownSurfaceNode, UserMessageNode,
} from './sessions/conversation.ts'
export type { SessionId } from '@deepseek-ai/dsh-client-connection/client'

// ---- Narrowed aliases (the single narrowing point of the slot type chain:
// ui-slots/web-react stay generic and dependency-inverted; the client-tree
// concrete types live here, where their subjects live) ----

/**
 * The client cordis context face: the base Context plus the service keys
 * this package's declaration merge contributes (slots/sessions/loader) and
 * every later plugin's merge. A plain alias — the merges land on Context
 * itself inside the client program; the name marks intent at consumer seams.
 */
export type ClientContext = Context

/** SessionBinding narrowed to the client context (inject factories dot services directly). */
export type ClientSessionBinding = GenericSessionBinding<ClientContext>

/** The conversation-snapshot selector hook (ConvViewProps/ToolViewProps take this). */
export type UseConversationSession = UseSession<ConversationSnapshot>

/**
 * One tool call as the chat flow renders it: still-running (spinner card) or
 * settled (result node). The fold produces both shapes; toolview components
 * narrow on the discriminant fields.
 */
export type ToolCallBlock = RunningToolCall | ToolResultNode

declare module 'cordis' {
  interface Events {
    /**
     * A slot's definition or registration set changed.
     * @mode emit
     * @param key - the mutated SlotMap key.
     */
    'slots/changed'(key: string): void
  }
  interface Context {
    slots: import('./slots.ts').SlotsService
    sessions: import('./sessions/service.ts').SessionsService
    loader: ClientLoader
  }
}

/** One __DSH_BOOT__ manifest row. */
export interface BootPluginEntry { id: string; url: string; inject: string[]; immediately?: boolean }

/** Per-plugin load status store shape. */
export type LoaderStatus = Record<string, 'loading' | 'active' | 'failed'>

/**
 * Client bundle loader. The immediately group loads first (parallel fetch,
 * apply in inject topology order); remaining plugins follow in inject
 * topology. Loaded bundle export surfaces are registered back into the
 * require module table. Implementation lives in the `./loader` subpath
 * (shell-held machinery).
 */
export interface ClientLoader {
  /** Start loading from window.__DSH_BOOT__ (non-blocking). */
  start(): void
  /**
   * Load one plugin bundle (script inject, factory handoff, ctx.plugin, style registration).
   * @param id - plugin id (package name).
   */
  load(id: string): Promise<void>
  /**
   * Unload a plugin. P-I: not implemented (full chain lands with HMR).
   * @param id - plugin id.
   */
  unload(id: string): Promise<void>
  /** Resolves when every manifest plugin reached active (AppRoot gates the real UI on this). */
  settled(): Promise<void>
  /**
   * Read a loaded module's export surface from the module table (same
   * implementation the bundle-facing require uses; unknown spec throws).
   * @param spec - module specifier (package name or seeded library id).
   */
  requireModule(spec: string): unknown
  /** Per-plugin status store. */
  readonly status: SnapshotStore<LoaderStatus>
}

/** Required services: the wire handle mounted by the connection plugin. */
export const inject = ['connection']

/**
 * Client plugin body: mount slots + sessions, start the stream loop.
 * @param ctx - client cordis context.
 */
export function apply(ctx: Context): void {
  ctx.plugin(SlotsService)
  const connection = ctx.get('connection') as ConnectionHandle
  const sessions = new SessionsService(ctx, connection.api)
  const loop = connection.start({
    onMuxEnvelope: (envelope) => { sessions.manager.handleMuxEnvelope(envelope) },
    onHostEnvelope: (envelope) => { sessions.manager.handleHostEnvelope(envelope) },
    onConnected: () => { sessions.manager.handleConnected() },
  })
  ctx.effect(() => () => { loop.stop() }, 'runtime: connection stream loop')
}
