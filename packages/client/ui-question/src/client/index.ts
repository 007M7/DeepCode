/**
 * Web question plugin, browser half: QuestionComposer registered as the
 * `question` entry of the conversation-declared keyed `conversation.composer`
 * slot. Pure consumer — the pending interaction arrives through the owner
 * share at the dispatch site, drafts are component-local, and the inject
 * surface is plain session-scoped callbacks closed over the plugin's own ctx
 * (slot design sections 5 and 6); props composition in contract/slots.ts.
 * Export discipline: packages/client/AGENTS.md.
 */
import type { ClientContext, SessionId, SessionsService, SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import type { QuestionComposerInjected } from './contract/slots.ts'
import { QuestionComposer } from './QuestionComposer.tsx'

export type {
  QuestionAnswer, QuestionComposerInjected, QuestionComposerProps, QuestionInteraction,
} from './contract/slots.ts'

/** Required services (cordis fiber inject — the loader passes the whole export surface as an object plugin). */
export const inject = ['slots', 'sessions']

/** Resolve a service via ctx.get, failing loud. This package's program holds
 *  the node half's host-side Context merges too (tool-ask-user), so property
 *  access would resolve the colliding host `sessions` seat — same budgeted
 *  cast as ui-conversation's need(). */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- caller-named cast target
function need<T>(ctx: ClientContext, name: string): T {
  const value = ctx.get(name) as T | undefined
  if (value === undefined) throw new Error(`ui-question: ${name} service unavailable`)
  return value
}

/**
 * Client plugin body: register the question composer into the keyed composer
 * slot. The inject factory returns receipt-checked answer/cancel callbacks
 * only (no hooks, no store lines) — the framework resolves the sessionId, and
 * the question payload rides the owner share.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const slots = need<SlotsService>(ctx, 'slots')
  const sessions = need<SessionsService>(ctx, 'sessions')
  const injectProps = (sessionId: SessionId): QuestionComposerInjected => {
    const session = sessions.manager.get(sessionId)
    return {
      answer: async (interaction, answer) => {
        const receipt = await session.answerQuestion(interaction.rpcId, answer)
        if (!receipt.accepted) {
          throw new Error(`question response rejected: ${receipt.reason}`)
        }
      },
      cancel: async (interaction) => {
        const receipt = await session.cancelQuestion(interaction.rpcId)
        if (!receipt.accepted) {
          throw new Error(`question cancellation rejected: ${receipt.reason}`)
        }
      },
    }
  }
  ctx.effect(
    () => slots.register(
      { name: 'conversation.composer', key: 'question', inject: injectProps },
      QuestionComposer,
    ),
    'ui-question: composer slot registration',
  )
}
