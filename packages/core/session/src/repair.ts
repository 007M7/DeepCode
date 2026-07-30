/**
 * Crash-recovery repair for an interrupted session log. It preserves a fully
 * written final turn and supplies the missing tool, step, and turn boundaries
 * needed to resume with a provider-valid transcript, plus the inherited-history
 * boundary a plugin-owned bracket reads to tell dead history from live work.
 * @module @deepseek-ai/dsh-session/repair
 */

import { MessageId, freezeMessage, type CallId } from '@deepseek-ai/dsh-llm'
import type { ToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from './types.ts'

/**
 * Whether the event at `seq` was inherited rather than written by the lifecycle
 * that owns `events` — the stored-history reading of `Session.firstLiveSeq`.
 *
 * An owner of a standalone open/close bracket calls this on an unmatched
 * opening marker: `true` means the operation cannot still be running, because
 * the lifecycle that opened it has ended (a crashed writer, a succeeding
 * process, or a parent the events were forked out of). `false` means it belongs
 * to the current lifecycle and must be treated as live.
 *
 * Reads the log rather than a `Session`, so it serves a consumer holding only
 * loaded events; in-process, compare against `session.firstLiveSeq` instead.
 * @param events - the log to scan, contiguous from seq 0.
 * @param seq - the event seq to classify.
 * @returns true when a `session/inherited` boundary sits at or above `seq`.
 */
export function isInheritedSeq(events: readonly SessionEvent[], seq: number): boolean {
  // Tail-first: an unmarked log costs no full scan, and bracket queries are
  // usually about recent events.
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    /* v8 ignore next -- a contiguous log has no holes; the guard is for the index type */
    if (event === undefined) continue
    if (event.seq < seq) return false
    if (event.type === 'session/inherited') return true
  }
  return false
}

/**
 * The `time` of the log's last event that represents actual work, skipping the
 * `session/inherited` boundary.
 *
 * Picking a session up is not activity, and lazy resume means browsing writes a
 * boundary, so activity ordering (a resume picker, a session list) must skip it
 * or every opened session sorts as freshly worked in.
 * @param events - the log to scan, in seq order.
 * @returns the latest non-boundary event's `time`, or undefined when the log has
 *   no such event (empty, or nothing but boundaries).
 */
export function lastActivityTime(events: readonly SessionEvent[]): number | undefined {
  return events.findLast(event => event.type !== 'session/inherited')?.time
}

/** Recovery code for an assistant tool request that never reached a recorded call start. */
export const TOOL_NOT_STARTED = 'TOOL_NOT_STARTED'

/** Recovery code for a recorded tool call whose completed outcome was not durably recorded. */
export const TOOL_OUTCOME_UNKNOWN = 'TOOL_OUTCOME_UNKNOWN'

/**
 * Return deterministic synthetic events that close an open tail turn. Unmatched
 * calls receive error results first, followed by an open `step/end` and an
 * interrupted `turn/end`; sequences continue the log and timestamps reuse the
 * last real event. A balanced or empty log returns no events.
 *
 * @param events - the loaded durable log to scan (a valid committed prefix, possibly with a crash tail).
 * @returns the synthetic closer events to append after `events`, in order; empty when the log is already balanced.
 */
export function interruptedTurnClosers(events: readonly SessionEvent[]): SessionEvent[] {
  let openTurn: number | null = null
  let openStep: number | null = null
  // Reset at each turn boundary so earlier calls cannot leak into tail repair.
  // Assistant blocks register calls; later tool/call events add provenance seqs.
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
        for (const block of event.data.message.content) {
          if (block.type === 'tool-call') pendingCalls.set(block.id, { step: event.data.step })
        }
        break
      case 'tool/call':
        // Add the tool/call seq used as provenance on a synthetic result.
        {
          const entry = pendingCalls.get(event.data.callId)
          if (entry) {
            entry.callSeq = event.seq
          }
        }
        break
      case 'tool/result':
        pendingCalls.delete(event.data.message.source.callId)
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

  // Close calls before their step: providers reject dangling assistant calls,
  // and Map insertion order preserves their transcript order.
  for (const [callId, { step, callSeq }] of pendingCalls) {
    const started = callSeq !== undefined
    const message: ToolResultMessage = freezeMessage({
      id: MessageId(`interrupted-tool-result-${callId}-${seq}`),
      role: 'user',
      source: { kind: 'tool', callId },
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        isError: true,
        content: [{
          type: 'text',
          text: started
            ? 'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.'
            : 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.',
        }],
      }],
    })
    closers.push({
      type: 'tool/result',
      seq: seq++,
      time,
      data: {
        turn: openTurn,
        step,
        message,
        error: started
          ? { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN }
          : { name: 'ToolNotStartedError', code: TOOL_NOT_STARTED },
      },
      surfaceOp: 'append',
      ...started ? { sourceEventSeqs: [callSeq] } : {},
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
