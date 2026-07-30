/**
 * Web question plugin, browser half: QuestionComposer registered as a
 * selector-routed entry of the conversation-declared composer chain, plus the
 * `question` dictionaries. The selector narrows the owner's currency to the
 * question carrier (matched prop), and the whole behavior surface rides the
 * carrier (domain encoding in contract/slots.ts PendingQuestion); copy rides
 * the standard locale seat. Export discipline: packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { QuestionWait } from './contract/slots.ts'
import { QuestionComposer } from './QuestionComposer.tsx'
import { en, zh, type QuestionKey } from './locales.ts'

export { PendingQuestion } from './contract/slots.ts'
export type { QuestionAnswer, QuestionComposerProps, QuestionWait } from './contract/slots.ts'
export type { QuestionKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The question composer's copy. */
    question: QuestionKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'question'

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
 * Client plugin body: register the `question` dictionaries and the question
 * composer into the composer chain. Zero business face — data and verbs live
 * on the matched carrier; t rides the standard locale seat.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-question: dictionaries')

  ctx.effect(
    () => ctx.slots.register(
      { name: 'conversation.composer', select: selectQuestion, locale: NS },
      QuestionComposer,
    ),
    'ui-question: composer chain registration',
  )
}
