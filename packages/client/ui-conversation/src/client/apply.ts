/** Registers the conversation components, shared store, and service callbacks. */
import type { Context } from 'cordis'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId, SessionsService } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ViewTab } from './contract/views.ts'
import type {
  ChatViewInjected, ComposerBarInjected, ConversationInjected, ConversationSessionInjected, DetailsInjected,
} from './contract/slots.ts'
import { createChatStore } from './stores.ts'
import { ConversationService } from './service.ts'
import { InputHub } from './input/hub.ts'
import { InputBar } from './skeleton/InputBar.tsx'
import { ChatView } from './chat/ChatView.tsx'
import { bashToolviewSample } from './toolviews/bash-sample.tsx'
import { todoToolview } from './toolviews/todo-row.tsx'
import { todoDockEntry } from './skeleton/TodoPanel.tsx'
import { queueDockEntry } from './queue/QueueDock.tsx'
import { ConversationRoot } from './skeleton/ConversationRoot.tsx'
import { ConversationSession } from './skeleton/ConversationSession.tsx'
import { DetailsPanel } from './skeleton/DetailsPanel.tsx'

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

  // The per-session input machine registry (InputService face; published as
  // ctx.conversation.input by the service below sharing this one instance).
  const inputHub = new InputHub(ctx)

  // Decision 19/20: the input machine feeds every session-scope slot
  // component through the standard provide channel — the 'input' hook plus
  // the two public actions. Materialization is the shell creation trigger
  // (per-session lazy; scope disposer tears down).
  ctx.effect(() => sessions.provide({
    hooks: ['input'],
    props: ['inputActions'],
    resolve: (binding) => {
      const shell = inputHub.shellFor(binding)
      return {
        hooks: { input: shell.state },
        props: { inputActions: shell.actions },
      }
    },
  }), 'ui-conversation: input standard-kit provider')

  // Resident current-session-optional shell. It owns the stable Hero/composer
  // frame while strict session slots fill only their session-bound regions.
  slots.register({
    name: 'conversation',
    children: {
      'conversation.session': { kind: 'single', scope: 'session' },
      'conversation.composer': { kind: 'chain', scope: 'session' },
      'conversation.composer.bar': { kind: 'single', scope: 'session' },
      'conversation.input.overlay': { kind: 'list', scope: 'session' },
      'conversation.input.dock': { kind: 'list', scope: 'session' },
      'conversation.composer.dock': { kind: 'list', scope: 'session' },
      'conversation.input.left': { kind: 'list', scope: 'session' },
      'conversation.input.right': { kind: 'list', scope: 'session' },
      'conversation.hero.workspace': { kind: 'single', scope: 'root' },
    },
    inject: (sessionId: SessionId | undefined): ConversationInjected => ({
      selectWorkspace: (workspaceId) => {
        void workspaces.connectWorkspace(workspaceId).then((nextId) => {
          if (sessionId !== undefined && nextId !== sessionId) {
            const from = inputHub.shell(sessionId)
            const draft = from.snapshot.draft
            if (draft !== '') {
              inputHub.shell(nextId).setDraft(draft)
              from.setDraft('')
            }
          }
          sessions.open(nextId)
        }).catch(() => {
          // Failure leaves the current Hero state available to retry.
        })
      },
    }),
  }, ConversationRoot)

  // The strict session subtree owns only per-session store and view content;
  // the resident parent keeps Hero and composer layout identity stable.
  slots.register({
    name: 'conversation.session',
    children: { 'conversation.view': { kind: 'list', scope: 'session' } },
    store: chatStore,
    inject: (sessionId: SessionId, _actions: BoundActions<typeof chatStore>): ConversationSessionInjected => ({
      views: {
        list: viewTabs,
        subscribe: fn => slots.subscribe('conversation.view', fn),
        version: () => slots.getVersion('conversation.view'),
      },
      bindDraftMirror: write => inputHub.shell(sessionId).bindMirror(write),
      open: (id) => { sessions.open(id) },
    }),
  }, ConversationSession)

  // The default composer body: its own single slot inside the composer
  // chain's fallback (decision 20). Public machine surface arrives via the
  // provide channel above; the keyboard command face and the stop/retry
  // verbs ride this inject (package-internal — hub and bar are one plugin).
  slots.register({
    name: 'conversation.composer.bar',
    // The two named control seats in the bar's tool row (plan left, model
    // right); empty until their owning plugins register (B ruling).
    children: {
      'conversation.input.plan': { kind: 'single', scope: 'session' },
      'conversation.input.model': { kind: 'single', scope: 'session' },
    },
    inject: (sessionId: SessionId): ComposerBarInjected => {
      return {
        keyboard: inputHub.keyboard(sessionId),
        stop: () => {
          scopedConversation(sessions, sessionId).cancel().catch(() => {
            // Stop failure surfaces via snapshot.promptError; nothing to restore.
          })
        },
      }
    },
  }, InputBar)

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
      const scoped = scopedConversation(sessions, sessionId)
      return {
        openDetails: (target) => {
          actions.select(target)
          layout.openDetails()
        },
        loadOlder: () => { void scoped.loadOlder() },
      }
    },
  }, ChatView)

  // Class-plugin mount (packages/AGENTS.md service form): the service
  // registers itself as `conversation` and lives on its own child fiber.
  // Mounted AFTER the chat entry register above — construction guarantee for
  // toolview registrants using `inject: ['conversation']` as their load-order
  // seam: the service being present implies the chat entry (and with it the
  // 'conversation.chat.toolview' declaration) is on the ledger.
  ctx.plugin(ConversationService, { input: inputHub })

  // The bash sample rides that exact seam, in third-party posture.
  ctx.plugin(bashToolviewSample)

  // The todo_write row rides the same seam (a product registration, not a sample).
  ctx.plugin(todoToolview)

  // The plan strip rides the input dock above the queue rows (same posture).
  ctx.plugin(todoDockEntry)

  // The read-only queue dock entry (T9 file territory) rides the same
  // registration seam into the input dock declared above.
  ctx.plugin(queueDockEntry)

  slots.register({
    name: 'details',
    store: chatStore,
    inject: (): DetailsInjected => ({
      closeDetails: () => { layout.closeDetails() },
    }),
  }, DetailsPanel)

}
