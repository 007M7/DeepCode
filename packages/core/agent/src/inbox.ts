/**
 * Incremental projection of durable agent inbox events.
 *
 * @module @deepseek-ai/dsh-agent/inbox
 */

import type { Session, SessionEventMap, UserMessage } from '@deepseek-ai/dsh-session'

/** One of the two ordered pending-message lists owned by an agent. */
export type InboxTarget = 'next-turn' | 'next-step'

/** Mutable state privately owned by an {@link Inbox}. */
type InboxState = Record<InboxTarget, UserMessage[]>

/** A replay-once projection that incrementally consumes later inbox splices. */
export class Inbox {
  private readonly state: InboxState = { 'next-turn': [], 'next-step': [] }

  constructor(private readonly session: Session) {
    for (const event of session.events.slice(session.header.seedLength ?? 0)) {
      if (event.type !== 'agent/inbox/spliced') continue
      try {
        this.apply(event.data)
      } catch (error: unknown) {
        throw new Error(`invalid persisted inbox splice at session seq ${event.seq}`, { cause: error })
      }
    }
  }

  /** Prompts awaiting individual turns. */
  get nextTurn(): readonly UserMessage[] {
    return this.state['next-turn']
  }

  /** Input awaiting admission at a step boundary. */
  get nextStep(): readonly UserMessage[] {
    return this.state['next-step']
  }

  /** Whether either pending-message list contains work. */
  get hasPending(): boolean {
    return this.nextTurn.length > 0 || this.nextStep.length > 0
  }

  /**
   * Apply standard splice semantics and durably record the normalized result.
   * @param target - pending list to mutate.
   * @param start - splice position.
   * @param deleteCount - maximum number of messages to remove.
   * @param inserted - messages to insert at the resolved position.
   * @param outcome - terminal disposition of removed messages.
   * @returns messages removed by the splice.
   */
  splice(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
    outcome?: 'admitted' | 'canceled',
  ): UserMessage[] {
    const inbox = this.state[target]
    const offset = Math.trunc(start) || 0
    const actualStart = offset < 0
      ? Math.max(inbox.length + offset, 0)
      : Math.min(offset, inbox.length)
    const actualDeleteCount = Math.min(
      Math.max(Math.trunc(deleteCount) || 0, 0),
      inbox.length - actualStart,
    )
    if (actualDeleteCount === 0 && inserted.length === 0) return []
    const resolvedOutcome = outcome ?? (actualDeleteCount > 0 ? 'canceled' : undefined)
    const splice = {
      target,
      start: actualStart,
      ...(actualDeleteCount === 0 ? {} : { removedCount: actualDeleteCount }),
      inserted,
      ...(resolvedOutcome === undefined ? {} : { outcome: resolvedOutcome }),
    }
    this.validate(splice)
    const event = this.session.append('agent/inbox/spliced', splice)
    return inbox.splice(actualStart, actualDeleteCount, ...event.data.inserted)
  }

  /** Apply one normalized durable splice to the projection. */
  private apply(splice: SessionEventMap['agent/inbox/spliced']): UserMessage[] {
    this.validate(splice)
    const inbox = this.state[splice.target]
    return inbox.splice(splice.start, splice.removedCount ?? 0, ...splice.inserted)
  }

  /** Validate one normalized splice against the current projection. */
  private validate(splice: SessionEventMap['agent/inbox/spliced']): void {
    const inbox = this.state[splice.target]
    const removedCount = splice.removedCount ?? 0
    if (!Number.isSafeInteger(splice.start) || splice.start < 0 || splice.start > inbox.length
      || !Number.isSafeInteger(removedCount) || removedCount < 0
      || splice.start + removedCount > inbox.length) {
      throw new Error('invalid inbox splice')
    }
    const candidate = inbox.toSpliced(splice.start, removedCount, ...splice.inserted)
    const ids = new Set<string>()
    for (const message of splice.target === 'next-turn'
      ? [...candidate, ...this.nextStep]
      : [...this.nextTurn, ...candidate]) {
      if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`)
      ids.add(message.id)
    }
  }
}
