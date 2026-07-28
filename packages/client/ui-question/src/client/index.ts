/**
 * Web question plugin, browser half: QuestionComposer registered as a
 * selector-routed entry of the conversation-declared composer chain. Pure
 * consumer — the selector narrows the owner's currency to the question
 * carrier (matched prop), and the whole behavior surface rides the carrier
 * (domain encoding in contract/slots.ts PendingQuestion); no inject face, no
 * service dependency beyond slots. Export discipline: packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { QuestionWait } from './contract/slots.ts'
import { QuestionComposer } from './QuestionComposer.tsx'

export { PendingQuestion } from './contract/slots.ts'
export type { QuestionAnswer, QuestionComposerProps, QuestionWait } from './contract/slots.ts'

/**
 * Required services (cordis fiber inject). 'conversation' is an ordering
 * edge, not a call dependency: the 'conversation.composer' chain slot is
 * declared by ui-conversation's apply, and register() into an undeclared
 * slot throws — service waiting orders this apply after the declaring one.
 */
export const inject = ['slots', 'conversation']

/** Chain routing: claim the composer while a question wait is pending (pure — owner props only). */
function selectQuestion({ interactions }: ComposerChainProps): QuestionWait | null {
  return interactions.find((i): i is QuestionWait => i.kind === 'question') ?? null
}

/**
 * Client plugin body: register the question composer into the composer chain.
 * Zero business face — data and verbs both live on the matched carrier.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const slots = ctx.slots
  ctx.effect(
    () => slots.register({ name: 'conversation.composer', select: selectQuestion }, QuestionComposer),
    'ui-question: composer chain registration',
  )
}
