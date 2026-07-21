/** Turn-scoped cancellation ownership for the concrete AgentLoop driver. @module dsh-agent-loop/cancellation */

import type { AgentCancelCause } from '@deepseek-ai/dsh-agent'

/** Stable runtime-only reason used when lifecycle teardown interrupts a turn. */
export const DISPOSED_INTERRUPT_REASON = Object.freeze({ kind: 'disposed' } as const)

/**
 * Owns the single controller shared by every asynchronous boundary of one turn.
 * The first request wins because a later caller must not rewrite the cause
 * observed by earlier listeners.
 */
export class TurnCancellation {
  readonly #controller = new AbortController()

  /** The explicit signal passed through this turn's execution boundaries. */
  get signal(): AbortSignal {
    return this.#controller.signal
  }

  /**
   * Abort the turn once.
   * @param reason - a typed caller cause or lifecycle disposal marker.
   * @returns whether this request established the signal reason.
   */
  request(reason: AgentCancelCause | typeof DISPOSED_INTERRUPT_REASON): boolean {
    if (this.signal.aborted) return false
    this.#controller.abort(Object.freeze({ kind: reason.kind }))
    return true
  }
}
