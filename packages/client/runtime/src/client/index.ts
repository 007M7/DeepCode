/**
 * Browser runtime services for slots, sessions, and connection-stream
 * delivery. The web shell mounts this static client entry through the host
 * plugin graph.
 */
import type { Context } from 'cordis'
import type { ConnectionHandle, SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotsService } from './slots.ts'
import { SessionsService } from './sessions/service.ts'
import type { SessionListState } from './sessions/service.ts'
import type { ConversationSnapshot, RunningToolCall, ToolResultNode } from './sessions/conversation.ts'

export { SlotsService } from './slots.ts'
export type { RootOwnerProps } from './slots.ts'
export { SessionsService, scopeOf } from './sessions/service.ts'
export type { Session } from './sessions/session.ts'
export type { SessionBinding, SessionListState, SessionSummary } from './sessions/service.ts'
// Runtime owns the snapshot store; web-react only binds it to React.
export { createSnapshotStore, defineStore, shallowEqual } from './contract/store.ts'
export type {
  EngineStoreHandle, EngineStoreInstance, ObservableSnapshot, SnapshotStore,
} from './contract/store.ts'
export type {
  AssistantBlock, AssistantMessageNode, ContextMessageNode, ConversationNode, ConversationSnapshot,
  RunningToolCall, SteeringMessageNode,
  ToolResultNode, UnknownSurfaceNode, UserMessageNode,
} from './sessions/conversation.ts'
export { PendingWait } from './sessions/pending.ts'
export type { PendingInteraction, PendingKind, PendingPayloads } from './sessions/pending.ts'
export type { SessionId } from '@deepseek-ai/dsh-client-connection/client'

/** Client-side Cordis context after declaration merging. */
export type ClientContext = Context

/** The conversation-snapshot selector hook (ConvViewProps/ToolRowProps take this). */
export type UseConversationSession = SnapshotSelectorHook<ConversationSnapshot>

/**
 * One tool call as the chat flow renders it: still-running (spinner card) or
 * settled (result node). The fold produces both shapes; toolview components
 * narrow on the discriminant fields.
 */
export type ToolCallBlock = RunningToolCall | ToolResultNode

declare module '@deepseek-ai/dsh-client-ui-slots' {
  /**
   * Session standard kit, real members (ui-slots declares the empty seat;
   * the runtime — where the subjects live — merges the concrete types):
   * every session-scope slot component receives these from the framework.
   */
  interface SessionStandardProps {
    useSession: SnapshotSelectorHook<ConversationSnapshot>
    /** The framework-resolved session id (owners never pass it). */
    sessionId: SessionId
  }
  /** Props injected into every global slot component. */
  interface GlobalStandardProps {
    useSessions: SnapshotSelectorHook<SessionListState>
  }
}

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
  }
}

/** Required services: the wire handle mounted by the connection plugin. */
export const inject = ['connection']

/** Mounts the browser runtime services and connection stream.
 * @param ctx - Client Cordis context.
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
