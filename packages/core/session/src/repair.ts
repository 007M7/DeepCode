/**
 * Crash-recovery repair for an interrupted session log.
 *
 * A persistence backend flushes only at `turn/end`, so a crash can leave a
 * durable log whose final turn never closed: real, fully-written events sit
 * after the last `turn/end` with no closing boundary. A single turn can be huge
 * in a long-horizon task (many steps, large tool output), so those events MUST
 * be preserved — truncating the turn would silently destroy real work. Instead,
 * on reload the backend CLOSES the orphaned turn by appending the minimal
 * synthetic boundary events:
 *
 *   1. an error `tool/result` for every `tool-call` in the interrupted turn that
 *      never got its matching `tool/result` (so the rehydrated history is a
 *      VALID provider transcript — see below),
 *   2. a `step/end` if a step was still open, then
 *   3. a `turn/end` carrying the merge-extensible `{ kind: 'interrupted' }` reason.
 *
 * The marker records that the turn was cut short by a crash, not completed by
 * the model. See the session-persistence RFC.
 *
 * Why the synthetic tool results matter: `deriveMessages()` renders the
 * `tool-call` blocks inside a durable `assistant/message` but only emits a
 * matching tool-result when a `tool/result` EVENT exists. A crash between the
 * assistant message and its tool results (the loop runs the tools AFTER logging
 * the assistant message, so a process killed mid-tool leaves the calls without
 * results) would otherwise reload a history with a dangling assistant tool-call
 * — which every provider rejects as an invalid transcript on the next request.
 * Synthesizing an error result per orphaned call keeps resume safe.
 *
 * This module computes those synthetic closers from an event list; backends
 * return them inline from `load` (so the reconstructed session is balanced and
 * immediately usable) and persist them during that mutating load before any
 * later append continues the log.
 *
 * @module @deepseek-ai/dsh-session/repair
 */

import type { CallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from './types.ts'

/**
 * Scan `events` for an open turn/step at the tail and return the synthetic
 * boundary events that close them, with `seq` continuing the log and `time`
 * copied from the last real event (the closers stand in for the crash moment;
 * reusing the last timestamp keeps them deterministic and never invents a
 * "future" time). Returns an empty array when the log is already balanced
 * (ends on a `turn/end`, or is empty) — the common, non-crash case.
 *
 * The closers, in order: an error `tool/result` for each unmatched `tool-call`
 * in the interrupted turn, then a `step/end` if a step is open, then the
 * `turn/end {interrupted}`. The tool-results come first so a step that issued
 * tool calls is balanced (every call has a result) before its `step/end`.
 *
 * Only the LAST turn can be open: the invariants plugin guarantees a `turn/end`
 * before any later `turn/start`, so an interior open turn is impossible in a
 * valid committed log. Likewise at most one step is open within that turn.
 * @param events - the loaded durable log to scan (a valid committed prefix, possibly with a crash tail).
 * @returns the synthetic closer events to append after `events`, in order; empty when the log is already balanced.
 */
export function interruptedTurnClosers(events: readonly SessionEvent[]): SessionEvent[] {
  let openTurn: number | null = null
  let openStep: number | null = null
  // Track tool calls vs. their results WITHIN the currently-open turn only: a
  // call is "pending" until its matching tool/result arrives. Reset at every
  // turn boundary so a committed earlier turn (already balanced) never leaks a
  // phantom pending call into the interrupted-turn repair.
  // Track pending tool calls with their callSeq (the seq of the `tool/call`
  // event, captured for surface sourceEventSeqs provenance on the synthetic
  // result). CallSeq is set from `tool/call` events; the assistant/message
  // block scan may register a call first (it appears earlier in the log), and
  // the later `tool/call` event fills in the seq.
  const pendingCalls = new Map<CallId, { step: number; callSeq?: number }>()
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        openTurn = event.data.turn
        openStep = null
        pendingCalls.clear()
        break
      case 'turn/end':
        openTurn = null
        openStep = null
        pendingCalls.clear()
        break
      case 'step/start':
        openStep = event.data.step
        break
      case 'step/end':
        pendingCalls.clear()
        openStep = null
        break
      case 'assistant/message':
        // The assistant message carries the tool-call blocks; each is pending
        // until a tool/result event with the same callId is logged.
        for (const block of event.data.content) {
          if (block.type === 'tool-call') pendingCalls.set(block.id, { step: event.data.step })
        }
        break
      case 'tool/call':
        // Capture the tool/call event seq for surface provenance on the
        // synthesized tool/result. The entry may already exist (registered by
        // the assistant/message above) or may be new (if the assistant/message
        // came from a prior step that was already closed).
        {
          const entry = pendingCalls.get(event.data.callId)
          if (entry) {
            entry.callSeq = event.seq
          }
        }
        break
      case 'tool/result':
        pendingCalls.delete(event.data.callId)
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

  // Synthesize an error tool/result for each tool-call left unanswered by the
  // crash, so deriveMessages() yields a valid provider transcript on resume (a
  // dangling assistant tool-call is rejected by every provider). Insertion
  // order follows the Map (insertion = log order of the assistant messages).
  for (const [callId, { step, callSeq }] of pendingCalls) {
    closers.push({
      type: 'tool/result',
      seq: seq++,
      time,
      data: {
        turn: openTurn,
        step,
        callId,
        content: [{ type: 'text', text: 'Tool call interrupted by a crash; no result was recorded.' }],
        isError: true,
        error: { name: 'InterruptedError', code: 'interrupted' },
      },
      surfaceOp: 'append',
      ...callSeq !== undefined ? { sourceEventSeqs: [callSeq] } : {},
    })
  }

  // Close an open step next — a turn/end while a step is open is an invariant
  // violation, so the step's boundary must be synthesized before the turn's.
  if (openStep !== null) {
    closers.push({ type: 'step/end', seq: seq++, time, data: { turn: openTurn, step: openStep } })
  }
  closers.push({ type: 'turn/end', seq: seq++, time, data: { turn: openTurn, reason: { kind: 'interrupted' } } })
  return closers
}
