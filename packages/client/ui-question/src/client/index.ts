/**
 * Web question plugin, browser half: registers a composer replacement for
 * pending ask_user_question requests into the conversation-declared keyed
 * `conversation.composer` slot (single register API — the slot exists because
 * the conversation entry's children declaration created it).
 */
import type { Context } from 'cordis'
import type { SessionId, SessionsService, SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import { QuestionComposer, type QuestionComposerInjected } from './QuestionComposer.tsx'

export { QuestionComposer, parseRecommendedLabel } from './QuestionComposer.tsx'
export type { QuestionComposerInjected, QuestionComposerProps } from './QuestionComposer.tsx'

/** Required browser services. */
export const inject = ['slots', 'sessions']

/**
 * Register the question composer into the conversation-owned keyed slot.
 * @param ctx - Browser plugin context carrying slots and sessions.
 */
export function apply(ctx: Context): void {
  const slots = ctx.get('slots') as SlotsService | undefined
  const sessions = ctx.get('sessions') as SessionsService | undefined
  if (slots === undefined || sessions === undefined) {
    throw new Error('ui-question: slots and sessions services are required')
  }
  slots.register({
    name: 'conversation.composer',
    key: 'question',
    inject: (sessionId: SessionId): QuestionComposerInjected => {
      const session = sessions.manager.get(sessionId)
      return {
        actions: {
          async answer(interaction, answer) {
            const receipt = await session.answerQuestion(interaction.rpcId, answer)
            if (!receipt.accepted) {
              throw new Error(`question response rejected: ${receipt.reason}`)
            }
          },
          async cancel(interaction) {
            const receipt = await session.cancelQuestion(interaction.rpcId)
            if (!receipt.accepted) {
              throw new Error(`question cancellation rejected: ${receipt.reason}`)
            }
          },
        },
      }
    },
  }, QuestionComposer)
}
