/**
 * Question-composer slot contract: the registrant-side props composition for
 * the conversation-owned `conversation.composer` keyed slot. The own injected
 * share is declared here (a share's type lives with whoever wires it); the
 * runtime share — the owner-dispatched `interaction` plus the framework
 * session/global standard kit — is PropsRuntime<'conversation.composer'>,
 * resolved off ui-conversation's SlotMap declaration and never re-stated.
 * Single domain — this is the package's whole contract surface.
 */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Also pulls ui-conversation's SlotMap merge (the 'conversation.composer'
// entry) into every program that sees this contract, so PropsRuntime resolves.
import type { QuestionComposerOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { QuestionResponsePayload } from '@deepseek-ai/dsh-client-connection/client'

/** The pending question interaction the owner dispatches into the keyed slot. */
export type QuestionInteraction = QuestionComposerOwnerProps['interaction']

/** One structured answer batch covering every question of the request. */
export type QuestionAnswer = QuestionResponsePayload['answer']

/**
 * Registrant-private injected share (arrives via the register inject
 * factory): plain session-scoped callbacks only — the question data rides the
 * owner share and drafts are component-local. A type alias, not an interface:
 * the alias carries an implicit index signature, so the factory's return
 * crosses the registry's `Record<string, unknown>` boundary uncast.
 */
export type QuestionComposerInjected = {
  /** Deliver the whole answer batch; a rejected receipt surfaces as a thrown error. */
  answer: (interaction: QuestionInteraction, answer: QuestionAnswer) => Promise<void>
  /** Reject the whole wait (the host resolves the tool call as cancelled). */
  cancel: (interaction: QuestionInteraction) => Promise<void>
}

/**
 * Full component props: the framework runtime share (owner `interaction` +
 * session/global standard kit) plus the own injected share. No children are
 * declared and no store is registered, so no PropsRenderSlots/PropsStore
 * term appears.
 */
export type QuestionComposerProps = PropsRuntime<'conversation.composer'> & QuestionComposerInjected
