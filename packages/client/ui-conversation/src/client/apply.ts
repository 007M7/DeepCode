/**
 * Client plugin body: register the conversation/details slot occupants and
 * the no-session empty state, contribute the chat entry into the
 * 'conversation.view' ring that the conversation registration declares, then
 * mount the conversation service (class plugin) and the bash toolview sample.
 * Assembly only — components receive everything through props: the framework
 * standard kit and store faces arrive automatically from the declarations
 * below; the inject factories contribute the plain-data-and-callbacks
 * business face (design §5). Tool rows are ordinary keyed-slot registrations
 * into 'conversation.chat.toolview' — no dedicated registry exists.
 */
import type { Context } from 'cordis'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId, SessionsService } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ViewTab } from './contract/views.ts'
import type {
  ChatViewInjected, ConversationInjected, DetailsInjected, EmptyStateInjected,
} from './contract/slots.ts'
import { createChatStore } from './stores.ts'
import { ConversationService } from './service.ts'
import { ChatView } from './chat/ChatView.tsx'
import { bashToolviewSample } from './toolviews/bash-sample.tsx'
import { ConversationRoot } from './skeleton/ConversationRoot.tsx'
import { DetailsPanel } from './skeleton/DetailsPanel.tsx'
import { EmptyState } from './skeleton/EmptyState.tsx'

/** Required services (cordis fiber inject — the loader passes the whole export surface as an object plugin). */
export const inject = ['slots', 'layout', 'sessions']

/** Resolve the session-scoped conversation service (scope-addressed send/cancel), failing loud. */
function scopedConversation(sessions: SessionsService, id: SessionId): ConversationService {
  const scoped = sessions.scope(id)
  if (scoped === undefined) throw new Error(`ui-conversation: session "${id}" resolved no scope`)
  const conversation = scoped.get('conversation')
  if (conversation === undefined) throw new Error('ui-conversation: conversation service unavailable through the session scope')
  return conversation
}

/**
 * Client plugin body.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const sessions = ctx.sessions
  const layout = ctx.layout
  const slots = ctx.slots

  // Shared store handle, constructed here so its identity lives and dies with
  // this fiber (a module-level handle would be a de-facto singleton). The
  // conversation, chat-view, and details registrations all declare it; same
  // scope key = same instance, so chat-view selection writes and details
  // reads meet in one store.
  const chatStore = createChatStore()

  // Tab projection over the view ring's ledger (list entries carry id/order/
  // label as registration options; the ledger keeps them order-sorted).
  const viewTabs = (): ViewTab[] => {
    const tabs: ViewTab[] = []
    for (const entry of slots.entries('conversation.view')) {
      /* v8 ignore next -- unreachable: list registration validates id at load. */
      if (entry.options.id === undefined) continue
      tabs.push({ id: entry.options.id, label: entry.options.label ?? entry.options.id })
    }
    return tabs
  }

  // Conversation occupant. Declaring the view ring here is claiming it:
  // ConversationRoot is the only component authorized to render the ring.
  slots.register({
    name: 'conversation',
    // The composer chain rides the same declaration table: takeover plugins
    // register selector-routed replacements of the InputBar.
    children: {
      'conversation.view': { kind: 'list', scope: 'session' },
      'conversation.composer': { kind: 'chain', scope: 'session' },
    },
    store: chatStore,
    inject: (sessionId: SessionId, actions: BoundActions<typeof chatStore>): ConversationInjected => {
      // History pull is NOT triggered here: the runtime sessions service opens
      // the event window when the watch lands on the session (cell/binding
      // resolution) — an inject factory assembles callbacks, it has no side
      // effect on session state.
      const scoped = scopedConversation(sessions, sessionId)
      return {
        views: {
          list: viewTabs,
          subscribe: fn => slots.subscribe('conversation.view', fn),
          version: () => slots.getVersion('conversation.view'),
        },
        send: (text, mode) => {
          const trimmed = text.trim()
          if (trimmed === '') return
          // Optimistic clear with failure restore (choreography lives with the
          // sender; the business failure also lands in snapshot.promptError).
          // The store write path stays inside the declared actions set:
          // restoreDraft itself no-ops once the user typed something new.
          actions.clearDraft()
          void scoped.send(trimmed, mode).catch(() => { actions.restoreDraft(trimmed) })
        },
        stop: () => {
          scoped.cancel().catch(() => {
            // Stop failure surfaces via snapshot.promptError; nothing to restore.
          })
        },
        open: (target: SessionId) => { sessions.open(target) },
      }
    },
  }, ConversationRoot)

  // The chat view: first entry of the ring this package just declared.
  // Declaring the keyed toolview hole here is claiming it: ChatView is the
  // only component authorized to render per-tool rows. Shares the chat
  // store, so its selection writes land in the same per-session instance the
  // details panel reads.
  slots.register({
    name: 'conversation.view',
    id: 'chat',
    order: 0,
    label: 'Chat',
    children: { 'conversation.chat.toolview': { kind: 'keyed', scope: 'session' } },
    store: chatStore,
    inject: (sessionId: SessionId, actions: BoundActions<typeof chatStore>): ChatViewInjected => ({
      openDetails: (target) => {
        actions.select(target)
        layout.openDetails()
      },
      loadOlder: () => { void sessions.manager.get(sessionId).loadOlder() },
    }),
  }, ChatView)

  // Class-plugin mount (packages/AGENTS.md service form): the service
  // registers itself as `conversation` and lives on its own child fiber.
  // Mounted AFTER the chat entry register above — construction guarantee for
  // toolview registrants using `inject: ['conversation']` as their load-order
  // seam: the service being present implies the chat entry (and with it the
  // 'conversation.chat.toolview' declaration) is on the ledger.
  ctx.plugin(ConversationService)

  // The bash sample rides that exact seam, in third-party posture.
  ctx.plugin(bashToolviewSample)

  slots.register({
    name: 'details',
    store: chatStore,
    inject: (): DetailsInjected => ({
      closeDetails: () => { layout.closeDetails() },
    }),
  }, DetailsPanel)

  slots.register({
    name: 'conversation.empty',
    inject: (): EmptyStateInjected => ({
      // ctx.get, not ctx.conversation: the service mounts on this plugin's
      // own child fiber, so it is not in the inject topology the property
      // proxy enforces; get reads the global store and stays loud on a torn
      // boot through the optional-chain throw below.
      startSession: (opts) => {
        const conversation = ctx.get('conversation')
        if (conversation === undefined) throw new Error('ui-conversation: conversation service unavailable')
        return conversation.startSession(opts)
      },
      createWorkspaceSession: async (name) => {
        const id = await sessions.createWorkspace(name)
        sessions.open(id)
      },
    }),
  }, EmptyState)
}
