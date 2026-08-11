/**
 * Message feedback plugin, browser half: the Like/Dislike entry in the
 * conversation.chat.assistant-actions strip. One FeedbackController per
 * Session backs every message control in that Session, so a single list read
 * seeds the whole transcript. Mutations go through the generated
 * messageFeedback Remote; the Host owns per-item compare-and-set.
 * @module @deepseek-ai/dsh-client-ui-feedback/client
 */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the generated Remote API and ctx.remote merge through the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the ui-conversation SlotMap merge (the assistant-actions entry).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { FeedbackController } from './controller.ts'
import { FeedbackActions } from './FeedbackActions.tsx'
import type { FeedbackInjected } from './slots.ts'
import { en, zh } from './locales.ts'

export type {
  FeedbackActionResult, FeedbackStatus, FeedbackView, MessageFeedbackRemote,
} from './controller.ts'
export type { FeedbackActionProps, FeedbackInjected } from './slots.ts'
export type { FeedbackKey } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'feedback'

/** Required services: the slot registry, the Remote namespace, and the copy. */
export const inject = ['slots', 'remote', 'remote.messageFeedback', 'locale']

/**
 * Client plugin body: the per-message feedback entry and its per-session
 * object layer.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-feedback: dictionaries')

  const controllers = new Map<SessionId, FeedbackController>()
  const controllerFor = (sessionId: SessionId): FeedbackController => {
    let controller = controllers.get(sessionId)
    if (controller === undefined) {
      controller = new FeedbackController(ctx.remote.messageFeedback, sessionId)
      controllers.set(sessionId, controller)
    }
    return controller
  }

  // A reconnect can only invalidate what was already read; a cold Session
  // stays cold until something asks for it.
  ctx.on('connection/reset', () => {
    for (const controller of controllers.values()) {
      if (controller.getSnapshot().status !== 'cold') void controller.resync()
    }
  })

  ctx.slots.inject('conversation.chat.assistant-actions', () => {
    const dispose = ctx.slots.register({
      name: 'conversation.chat.assistant-actions',
      id: 'feedback',
      order: 10,
      locale: NS,
      inject: (sessionId): FeedbackInjected => {
        const controller = controllerFor(sessionId)
        return {
          hooks: { feedback: controller },
          ensure: () => controller.ensure(),
          rate: (messageId, rating, note) => controller.rate(messageId, rating, note),
          toggle: (messageId, rating) => controller.toggle(messageId, rating),
          clearNote: messageId => controller.clearNote(messageId),
          clear: messageId => controller.clear(messageId),
        }
      },
    }, FeedbackActions)
    return () => {
      dispose()
      for (const controller of controllers.values()) controller.dispose()
      controllers.clear()
    }
  })
}
