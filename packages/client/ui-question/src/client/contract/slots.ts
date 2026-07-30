/**
 * Question-composer slot contract: the registrant-side props composition for
 * the conversation-owned `conversation.composer` slot, plus the question
 * domain face over the runtime's carrier object. The carrier (PendingWait)
 * owns envelope transport only; the question protocol — answer value shape,
 * cancelled error encoding, receipt checks — lives HERE, with the package
 * that consumes it.
 */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Also pulls ui-conversation's SlotMap merge (the 'conversation.composer'
// entry) into every program that sees this contract, so PropsRuntime resolves.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PendingWait } from '@deepseek-ai/dsh-client-runtime/client'
import type { QuestionResponsePayload } from '@deepseek-ai/dsh-client-connection/client'

/** The pending question carrier the owner dispatches into the composer slot. */
export type QuestionWait = PendingWait<'question'>

/** One structured answer batch covering every question of the request. */
export type QuestionAnswer = QuestionResponsePayload['answer']

/**
 * Question domain face over the carrier: render identity and questions
 * transparently forwarded; answer/cancel own the wire encoding (the ok value
 * shape and the cancelled error) and turn a rejected carrier receipt into a
 * thrown error. Components mint one per carrier via useMemo (never inside a
 * select — a per-dispatch mint would churn identity and break memoization).
 */
export class PendingQuestion {
  /**
   * @param wait - the runtime carrier for one pending question request.
   */
  constructor(private readonly wait: QuestionWait) {}

  /** Opaque render identity (React key / draft remount axis), forwarded from the carrier. */
  get key(): string {
    return this.wait.key
  }

  /** The request's question list, forwarded from the carrier payload. */
  get questions(): QuestionWait['payload']['questions'] {
    return this.wait.payload.questions
  }

  /**
   * Deliver the whole answer batch; a rejected carrier receipt throws.
   * @param answer - complete structured answer batch.
   */
  async answer(answer: QuestionAnswer): Promise<void> {
    const receipt = await this.wait.respond({
      ok: true, value: { sessionId: this.wait.sessionId, answer },
    })
    if (!receipt.accepted) {
      throw new Error(`question response rejected: ${receipt.reason}`)
    }
  }

  /** Reject the whole wait (the host resolves the tool call as cancelled); a rejected receipt throws. */
  async cancel(): Promise<void> {
    const receipt = await this.wait.respond({
      ok: false,
      error: { code: 'cancelled', message: 'the user closed this question request', details: {} },
    })
    if (!receipt.accepted) {
      throw new Error(`question cancellation rejected: ${receipt.reason}`)
    }
  }
}

/**
 * Full component props: the framework runtime share (chain currency +
 * session/global standard kit) plus the chain `matched` share — the entry's
 * selector result, already narrowed to the question carrier — plus the
 * standard locale seat; the carrier plus the domain face above carry the
 * whole behavior surface.
 */
export type QuestionComposerProps =
  PropsRuntime<'conversation.composer'> & { matched: QuestionWait } & PropsLocale<'question'>
