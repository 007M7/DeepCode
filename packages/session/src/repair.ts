/**
 * Crash-recovery repair for an interrupted session log.
 *
 * A persistence backend flushes only at `turn/end`, so a crash can leave a
 * durable log whose final turn never closed: real, fully-written events sit
 * after the last `turn/end` with no closing boundary. A single turn can be huge
 * in a long-horizon task (many steps, large tool output), so those events MUST
 * be preserved — truncating the turn would silently destroy real work. Instead,
 * on reload the backend CLOSES the orphaned turn by appending the minimal
 * synthetic boundary events (a `step/end` if a step was still open, then a
 * `turn/end` carrying the merge-extensible `{ kind: 'interrupted' }` reason).
 * The marker records that the turn was cut short by a crash, not completed by
 * the model. See ADR 0018.
 *
 * This module computes those synthetic closers from an event list; the backend
 * returns them inline from `load` (so the reconstructed session is balanced and
 * immediately usable) and persists them on the first post-load `append`.
 *
 * @module @deepseek-ai/dsh-session/repair
 */

import type { SessionEvent } from './types.ts'

/**
 * Scan `events` for an open turn/step at the tail and return the synthetic
 * boundary events that close them, with `seq` continuing the log and `time`
 * copied from the last real event (the closers stand in for the crash moment;
 * reusing the last timestamp keeps them deterministic and never invents a
 * "future" time). Returns an empty array when the log is already balanced
 * (ends on a `turn/end`, or is empty) — the common, non-crash case.
 *
 * Only the LAST turn can be open: the invariants plugin guarantees a `turn/end`
 * before any later `turn/start`, so an interior open turn is impossible in a
 * valid committed log. Likewise at most one step is open within that turn.
 */
export function interruptedTurnClosers(events: readonly SessionEvent[]): SessionEvent[] {
  let openTurn: number | null = null
  let openStep: number | null = null
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        openTurn = event.data.turn
        break
      case 'turn/end':
        openTurn = null
        openStep = null
        break
      case 'step/start':
        openStep = event.data.step
        break
      case 'step/end':
        openStep = null
        break
      // Other event types do not move the turn/step boundary cursor.
      default:
        break
    }
  }

  // Balanced log (no crash mid-turn): nothing to close. An open turn implies
  // `events` is non-empty (its turn/start was logged), so `last` exists.
  const last = events.at(-1)
  if (openTurn === null || last === undefined) return []

  // The last real event supplies the seq base and the timestamp for the
  // synthetic closers (reusing the last timestamp keeps them deterministic and
  // never invents a "future" time).
  let seq = last.seq + 1
  const time = last.time
  const closers: SessionEvent[] = []

  // Close an open step first — a turn/end while a step is open is an invariant
  // violation, so the step's boundary must be synthesized before the turn's.
  if (openStep !== null) {
    closers.push({ type: 'step/end', seq: seq++, time, data: { turn: openTurn, step: openStep } })
  }
  closers.push({ type: 'turn/end', seq: seq++, time, data: { turn: openTurn, reason: { kind: 'interrupted' } } })
  return closers
}
