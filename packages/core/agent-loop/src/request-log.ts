/**
 * Per-loop-instance transmission bookkeeping for the reconstructability
 * contract: which header event to append before a request so the session log
 * always explains the request (the reconstructability RFC). The loop is
 * otherwise transmission-stateless — the comparison baseline is the log's own
 * folded header (`Session.requestHeader()`), so resume and fork need no
 * special path: a fresh loop instance simply logs a `'resume'` snapshot on
 * its first request and deltas from there.
 *
 * @module dsh-agent-loop/request-log
 */

import { diffHeader, headerEquals, applyHeaderDelta } from '@deepseek-ai/dsh-session'
import type { EpochHeader, Session } from '@deepseek-ai/dsh-session'

/** Per-loop-instance bookkeeping: whether THIS instance has logged a header yet. */
export interface TransmissionLog {
  /** True once this loop instance appended its anchoring `request/header` snapshot. */
  loggedHeader: boolean
}

/** Fresh bookkeeping for a newly-started loop instance. */
export function createTransmissionLog(): TransmissionLog {
  return { loggedHeader: false }
}

/**
 * Append whatever header event this request owes the log, so folding the log
 * reproduces the header the request was built under. Exactly one of four
 * things happens:
 *
 * 1. This loop instance has not logged a header yet → a full `request/header`
 *    snapshot anchors the fold: reason `'initial'` when the log has no header
 *    events at all (a new conversation), `'resume'` when it does (process
 *    restart, fork seed — the boundary itself is a recorded fact, so the
 *    snapshot is appended even when nothing changed).
 * 2. The header equals the folded baseline → nothing; the log already
 *    explains this request.
 * 3. It differs and the delta round-trips (`applyHeaderDelta` on the baseline
 *    reproduces the header exactly) → a `request/header-delta`.
 * 4. It differs and the delta encoding cannot express the change (a pure tool
 *    reordering) → a full snapshot with reason `'fallback'`; deltas are an
 *    encoding optimization, never a correctness dependency.
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
  const delta = diffHeader(baseline, header)
  /* v8 ignore next -- headerEquals false ⟹ diffHeader defined: both compare the same three parts */
  if (delta === undefined) return
  if (headerEquals(applyHeaderDelta(baseline, delta), header)) {
    session.append('request/header-delta', delta)
  } else {
    session.append('request/header', { header, reason: 'fallback' })
  }
}
