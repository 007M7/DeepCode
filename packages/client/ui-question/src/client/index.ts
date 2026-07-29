/**
 * Web question plugin, browser half: QuestionComposer registered as a
 * selector-routed entry of the conversation-declared composer chain. The
 * selector narrows the owner's currency to the question carrier (matched
 * prop); answer/cancel behavior rides the carrier (domain encoding in
 * contract/slots.ts PendingQuestion); the inject face carries only the
 * locale share (bound translator + snapshot source). Export discipline:
 * packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { QuestionComposerInjected, QuestionWait } from './contract/slots.ts'
import { en, QUESTION_NS, zh } from './locales.ts'
import { QuestionComposer } from './QuestionComposer.tsx'

export { PendingQuestion } from './contract/slots.ts'
export type { QuestionAnswer, QuestionComposerInjected, QuestionComposerProps, QuestionWait } from './contract/slots.ts'
export { QUESTION_NS } from './locales.ts'

/**
 * Required services (cordis fiber inject). 'conversation' is an ordering
 * edge, not a call dependency: the 'conversation.composer' chain slot is
 * declared by ui-conversation's apply, and register() into an undeclared
 * slot throws — service waiting orders this apply after the declaring one.
 */
export const inject = ['slots', 'conversation', 'locale']

/** Chain routing: claim the composer while a question wait is pending (pure — owner props only). */
function selectQuestion({ interactions }: ComposerChainProps): QuestionWait | null {
  return interactions.find((i): i is QuestionWait => i.kind === 'question') ?? null
}

/**
 * Client plugin body: register the composer's bilingual copy and the question
 * composer itself into the composer chain. The inject face hands the entry
 * its namespace-bound translator plus the locale snapshot source; data and
 * verbs live on the matched carrier.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const disposers = [
      ctx.locale.register(QUESTION_NS, 'zh', zh),
      ctx.locale.register(QUESTION_NS, 'en', en),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-question: composer dictionaries')

  const injected = (): QuestionComposerInjected => ({
    t: ctx.locale.bind(QUESTION_NS),
    hooks: {
      locale: {
        getSnapshot: () => ctx.locale.getLocale(),
        subscribe: fn => ctx.on('locale/change', fn),
      },
    },
  })
  ctx.effect(
    () => ctx.slots.register(
      { name: 'conversation.composer', select: selectQuestion, inject: injected },
      QuestionComposer,
    ),
    'ui-question: composer chain registration',
  )
}
