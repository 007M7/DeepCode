/**
 * Per-loop-instance request-header bookkeeping for reconstructability. The
 * comparison baseline is folded from the session log; a fresh instance anchors
 * it with an initial/resume snapshot and later logs full changed snapshots.
 *
 * @module dsh-agent-loop/request-log
 */

import { headerEquals } from '@deepseek-ai/dsh-session'
import type { EpochHeader, Session } from '@deepseek-ai/dsh-session'
import type { Message } from '@deepseek-ai/dsh-llm'

/** Per-loop-instance bookkeeping: whether THIS instance has logged a header yet. */
export interface TransmissionLog {
  /** True once this loop instance appended its anchoring `request/header` snapshot. */
  loggedHeader: boolean
  /**
   * The instance's composed session prefix (the `agent/session-prefix`
   * waterfall's deep-frozen product), cached on the instance's first
   * request-building step and reused verbatim for every request it sends —
   * the structural guarantee that the prefix never changes mid-session.
   * `undefined` until composed.
   */
  sessionPrefix?: Message[]
}

/**
 * Fresh bookkeeping for a newly-started loop instance.
 * @returns state with `loggedHeader` false, so the instance's first request appends an anchoring snapshot.
 */
export function createTransmissionLog(): TransmissionLog {
  return { loggedHeader: false }
}

/**
 * Append the full header snapshot owed by this request: initial/resume for the
 * instance's first request, nothing when unchanged, or change otherwise.
 *
 * @param session - the session whose log explains the request.
 * @param state - this loop instance's bookkeeping (mutated on first log).
 * @param header - the canonical header the request will ACTUALLY use
 *   (post-`agent/request`).
 */
export function recordRequestHeader(session: Session, state: TransmissionLog, header: EpochHeader): void {
  if (!state.loggedHeader) {
    session.append('request/header', { header, reason: session.requestHeader() === undefined ? 'initial' : 'resume' })
    state.loggedHeader = true
    return
  }
  // This instance logged a snapshot, so the fold is necessarily defined.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const baseline = session.requestHeader()!
  if (headerEquals(baseline, header)) return
  session.append('request/header', { header, reason: 'change' })
}
