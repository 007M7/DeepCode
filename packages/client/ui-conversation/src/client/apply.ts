/**
 * Client plugin body: provide the conversation service and toolview registry,
 * register the conversation/details slot occupants and the no-session empty
 * state, and mount the chat view with its samples. Assembly only — components
 * receive everything through props: the framework standard kit and store
 * faces arrive automatically from the declarations below; the inject
 * factories contribute the plain-data-and-callbacks business face (design §5).
 */
import type { Context } from 'cordis'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId, SessionsService, SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import type { LayoutService } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { I18nService } from '@deepseek-ai/dsh-client-i18n/client'
import type { SelectionTarget } from './contract/views.ts'
import type { ConversationInjected, DetailsInjected, EmptyStateInjected } from './contract/slots.ts'
import { createChatStore } from './stores.ts'
import { ConversationService } from './service.ts'
import { ToolViewRegistry } from './toolviews/registry.ts'
import { childSessionScope, registerChat } from './chat/register.ts'
import { registerBashSamples } from './toolviews/bash-sample.tsx'
import { ConversationRoot } from './skeleton/ConversationRoot.tsx'
import { DetailsPanel } from './skeleton/DetailsPanel.tsx'
import { EmptyState } from './skeleton/EmptyState.tsx'

/** Required services (cordis fiber inject — the loader passes the whole export surface as an object plugin). */
export const inject = ['slots', 'layout', 'sessions', 'i18n']

/** Resolve a service via ctx.get, failing loud. Property access is reserved
 *  for contexts whose fiber declares the inject (scope fibers do not). */
// T is the caller-named cast target; inlining `as T` per call site would scatter the budgeted cast.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function need<T>(ctx: Context, name: string): T {
  const value = ctx.get(name) as T | undefined
  if (value === undefined) throw new Error(`ui-conversation: ${name} service unavailable`)
  return value
}

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
  const sessions = need<SessionsService>(ctx, 'sessions')
  const layout = need<LayoutService>(ctx, 'layout')
  const i18n = need<I18nService>(ctx, 'i18n')
  const slots = need<SlotsService>(ctx, 'slots')

  const conversation = new ConversationService(ctx)
  const toolviews = new ToolViewRegistry()
  ctx.provide('toolviews', toolviews)

  const t = i18n.bind('conversation')
  // Chat view + StatsLine footer; bash samples assembled here (apply is the
  // only cross-domain point — chat consumes the resolver face, samples come
  // from the toolviews domain). registerView inside registerChat is already
  // effect-scoped; the raw sample registrations need the effect wrapper to
  // ride the fiber cascade.
  ctx.effect(
    () => registerChat({ conversation, toolviews, t }),
    'ui-conversation: chat view')
  ctx.effect(
    () => registerBashSamples(toolviews, childSessionScope(sessions.list)),
    'ui-conversation: bash toolview samples')

  // Shared store handle, constructed here so its identity lives and dies with
  // this fiber (a module-level handle would be a de-facto singleton). Both
  // session-slot registrations declare it; same scope key = same instance, so
  // conversation writes and details reads meet in one store.
  const chat = createChatStore()

  slots.register({
    name: 'conversation',
    store: chat,
    inject: (sessionId: SessionId, actions: BoundActions<typeof chat>): ConversationInjected => {
      const session = sessions.manager.get(sessionId)
      const scoped = scopedConversation(sessions, sessionId)
      // Watch-driven history pull: assembling the surface IS the watch signal
      // (once per entry x session; open() is idempotent and self-recovers).
      void session.open()
      return {
        views: {
          list: () => conversation.views(),
          subscribe: fn => conversation.subscribeViews(fn),
          version: () => conversation.viewsVersion(),
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
        openDetails: (target: SelectionTarget) => {
          actions.select(target)
          layout.openDetails()
        },
        loadOlder: () => { void session.loadOlder() },
        open: (target: SessionId) => { sessions.open(target) },
      }
    },
  }, ConversationRoot)

  slots.register({
    name: 'details',
    store: chat,
    inject: (): DetailsInjected => ({
      closeDetails: () => { layout.closeDetails() },
    }),
  }, DetailsPanel)

  slots.register({
    name: 'conversation.empty',
    inject: (): EmptyStateInjected => ({
      startSession: opts => conversation.startSession(opts),
    }),
  }, EmptyState)
}
