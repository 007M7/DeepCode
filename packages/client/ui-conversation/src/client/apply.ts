/** Registers the conversation components, shared store, and service callbacks. */
import type { Context } from 'cordis'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId, SessionsService } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ViewTab } from './contract/views.ts'
import type {
  ChatViewInjected, ComposerAttachment, ConversationInjected, DetailsInjected, EmptyStateInjected,
} from './contract/slots.ts'
import { createChatStore } from './stores.ts'
import { ConversationService } from './service.ts'
import { ChatView } from './chat/ChatView.tsx'
import { bashToolviewSample } from './toolviews/bash-sample.tsx'
import { ConversationRoot } from './skeleton/ConversationRoot.tsx'
import { DetailsPanel } from './skeleton/DetailsPanel.tsx'
import { EmptyState } from './skeleton/EmptyState.tsx'

/** Services required by the conversation plugin. */
export const inject = ['slots', 'layout', 'sessions', 'workspaces']

/** Resolve the session-scoped conversation service (scope-addressed send/cancel), failing loud. */
function scopedConversation(sessions: SessionsService, id: SessionId): ConversationService {
  const scoped = sessions.scope(id)
  if (scoped === undefined) throw new Error(`ui-conversation: session "${id}" resolved no scope`)
  const conversation = scoped.get('conversation')
  if (conversation === undefined) throw new Error('ui-conversation: conversation service unavailable through the session scope')
  return conversation
}

/** Mounts the conversation plugin.
 * @param ctx - Client root context.
 */
export function apply(ctx: Context): void {
  const sessions = ctx.sessions
  const workspaces = ctx.workspaces
  const layout = ctx.layout
  const slots = ctx.slots

  // Apply-time construction keeps store identity bound to this fiber.
  const chatStore = createChatStore()

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
      const conversation = ctx.get('conversation')
      if (conversation === undefined) throw new Error('ui-conversation: conversation service unavailable')
      return {
        views: {
          list: viewTabs,
          subscribe: fn => slots.subscribe('conversation.view', fn),
          version: () => slots.getVersion('conversation.view'),
        },
        addImages: (files, current) => {
          try {
            const images = conversation.createDraftImages(files, current)
            actions.addImages(images.map(image => image.id))
            return null
          } catch (error: unknown) {
            return error instanceof Error ? error.message : String(error)
          }
        },
        removeImage: (id) => {
          conversation.releaseDraftImage(id)
          actions.removeImage(id)
        },
        draftImages: ids => conversation.draftImages(ids),
        releaseSessionImages: (id) => { conversation.releaseSessionImages(id) },
        send: (text, images: readonly ComposerAttachment[], mode) => {
          const trimmed = text.trim()
          if (trimmed === '' && images.length === 0) return
          // Optimistic clear with failure restore (choreography lives with the
          // sender; the business failure also lands in snapshot.promptError).
          // The store write path stays inside the declared actions set:
          // restoreDraft itself no-ops once the user typed something new.
          actions.clearDraft()
          void scoped.send(trimmed, mode, images.map(image => image.file))
            .then(() => { conversation.releaseDraftImages(images) })
            .catch(() => { actions.restoreDraft(trimmed, images.map(image => image.id)) })
        },
        stop: () => {
          scoped.cancel().catch(() => {
            // Stop failure surfaces via snapshot.promptError; nothing to restore.
          })
        },
        open: (sessionId) => { sessions.open(sessionId) },
        updateSessionPrompt: (text) => { scoped.updatePendingPrompt(text) },
        retrySessionPrompt: () => { scoped.retryPendingPrompt() },
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
    inject: (sessionId: SessionId, actions: BoundActions<typeof chatStore>): ChatViewInjected => {
      const conversation = ctx.get('conversation')
      if (conversation === undefined) throw new Error('ui-conversation: conversation service unavailable')
      const scoped = scopedConversation(sessions, sessionId)
      return {
        openDetails: (target) => {
          actions.select(target)
          layout.openDetails()
        },
        loadOlder: () => { void scoped.loadOlder() },
        loadImage: attachment => conversation.resolveImage(sessionId, attachment),
      }
    },
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
    children: { 'conversation.empty.workspace': { kind: 'single', scope: 'root' } },
    inject: (): EmptyStateInjected => {
      // The service lives on this plugin's child fiber; resolve lazily from
      // the root store so an incomplete boot still fails at first use.
      const conversation = (): ConversationService => {
        const service = ctx.get('conversation')
        if (service === undefined) throw new Error('ui-conversation: conversation service unavailable')
        return service
      }
      return {
        startSession: (workspaceId, prompt) => { workspaces.startSession(workspaceId, prompt) },
        updateSessionPrompt: (text) => { sessions.updateIntent(text) },
        createDraftImages: (files, current) => conversation().createDraftImages(files, current, true),
        releaseDraftImage: (id) => { conversation().releaseDraftImage(id) },
        releaseDraftImages: (attachments) => { conversation().releaseDraftImages(attachments) },
        sendSession: async (images) => {
          await conversation().prepareIntentImages(images.map(image => image.file))
          workspaces.sendSession()
        },
      }
    },
  }, EmptyState)
}
