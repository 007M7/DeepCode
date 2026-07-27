/** Browser runtime services for slots, sessions, workspaces, and connection-stream delivery. */
import type { Context } from 'cordis'
import type { ConnectionHandle, SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { MaybeSnapshotSelectorHook, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotsService } from './slots.ts'
import { SessionsService } from './sessions/service.ts'
import type { SessionListState } from './sessions/service.ts'
import { WorkspacesService } from './workspaces/service.ts'
import type { ConversationSnapshot, RunningToolCall, ToolResultNode } from './sessions/conversation.ts'

export { SlotsService } from './slots.ts'
export type { RootOwnerProps } from './slots.ts'
export { SessionCreateError, SessionsService, scopeOf, workspaceTitleOf } from './sessions/service.ts'
export { createScope } from './agents/scope.ts'
export type { AgentScopeHandle } from './agents/scope.ts'
export { WorkspaceCreateError, WorkspacesService } from './workspaces/service.ts'
export type { Session } from './sessions/session.ts'
export type {
  SessionBinding, SessionListState, SessionProvideContribution, SessionProvideDescriptor, SessionSummary,
} from './sessions/service.ts'
export type { SessionListPhase } from './sessions/manager.ts'
export type { WorkspaceListPhase } from './workspaces/manager.ts'
export type { WorkspaceListState } from './workspaces/service.ts'
export type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-client-connection/client'
// Runtime owns the snapshot store; web-react only binds it to React.
export { createSnapshotStore, defineStore, shallowEqual } from './contract/store.ts'
export type {
  EngineStoreHandle, EngineStoreInstance, ObservableSnapshot, SnapshotStore,
} from './contract/store.ts'
export type {
  AssistantBlock, AssistantMessageNode, CodeSubCall, ComposerPhase, ContextMessageNode, ConversationNode,
  ConversationSnapshot, QueuedMessage, RunningToolCall,
  SteeringMessageNode, TodoItem, ToolResultNode, UnknownSurfaceNode, UserMessageNode,
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
  /** Standard kit for slots that remain mounted while current session changes. */
  interface SessionMaybeStandardProps {
    useSession: MaybeSnapshotSelectorHook<ConversationSnapshot>
    /** Current session id; absent in the no-session state. */
    sessionId: SessionId | undefined
  }
  /** Props injected into every global slot component. */
  interface GlobalStandardProps {
    useSessions: SnapshotSelectorHook<SessionListState>
    /** Selector hook over real Workspaces and their independent baseline lifecycle. */
    useWorkspaces: SnapshotSelectorHook<import('./workspaces/service.ts').WorkspaceListState>
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
    /**
     * The host command registry changed (host/commands-changed passthrough).
     * Pure invalidation signal: subscribers refetch `command.list` in the
     * background rather than diffing.
     * @mode emit
     */
    'commands/changed'(): void
    /**
     * A connection generation was (re-)established. Wire-derived caches must
     * treat their state as stale and repull (commands directory; the queue
     * mirrors reset themselves through the session resync path).
     * @mode emit
     */
    'connection/reset'(): void
  }
  interface Context {
    slots: import('./slots.ts').SlotsService
    sessions: import('./sessions/service.ts').SessionsService
    workspaces: import('./workspaces/service.ts').WorkspacesService
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
  const workspaces = new WorkspacesService(ctx, connection.api, sessions)
  ctx.effect(
    () => workspaces.startInitialSelection(),
    'runtime: initial Workspace selection',
  )
  const loop = connection.start({
    onMuxEnvelope: (envelope) => { sessions.handleMuxEnvelope(envelope) },
    onHostEnvelope: (envelope) => {
      sessions.handleHostEnvelope(envelope)
      workspaces.handleHostEnvelope(envelope)
      // Typed-event bridge: the session layer ignores registry frames (no
      // session routing); consumers (command directory caches) subscribe on ctx.
      if (envelope.payload.type === 'host/commands-changed') ctx.emit('commands/changed')
    },
    onConnected: () => {
      sessions.handleConnected()
      workspaces.handleConnected()
      ctx.emit('connection/reset')
    },
  })
  ctx.effect(() => () => { loop.stop() }, 'runtime: connection stream loop')
}
