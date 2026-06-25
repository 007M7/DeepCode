/**
 * Step-boundary predicates over a session log: is a given surface node a SAFE
 * place to start or end a region that will be collapsed (e.g. by compaction)?
 *
 * The invariant a consumer needs: a collapsed region must NOT partially overlap
 * a step. A step's surface nodes form a contiguous run, and a region must
 * contain either ALL of a step's nodes or NONE of them — otherwise it can split
 * an `assistant/message`'s `tool-call` blocks from their `tool/result`s, leaving
 * the rehydrated transcript with a dangling tool-call or an orphaned tool-result
 * (which every provider rejects). This is the compaction-time mirror of the
 * crash-recovery imbalance that {@link interruptedTurnClosers} repairs on load.
 *
 * Nodes that belong to NO step — a pre-step `user/message` (drained before the
 * first `step/start`), inter-step `steering/message`, or an injection
 * `context/message` (wrapped in a bare `turn/start → context/message → turn/end`
 * with no step) — carry no tool pairing and are free boundaries on both sides.
 *
 * The scans classify each neighbor event into three buckets: a turn/step
 * BOUNDARY marker (the region edge is clean), a SURFACE node (the region edge
 * is mid-step), or NOISE to skip (`assistant/chunk`, the log-only `compact/*`
 * records, and any future non-surface event). "Surface node" is decided by the
 * shared {@link isSurfaceEvent} guard so the two notions can't drift.
 *
 * @module @deepseek-ai/dsh-session/step-boundary
 */

import type { SessionEvent } from './types.ts'
import { isSurfaceEvent } from './surface.ts'

/** Turn/step boundary marker types — the walls the scans stop on. */
const BOUNDARY_TYPES = new Set<string>(['turn/start', 'turn/end', 'step/start', 'step/end'])

/**
 * Whether the surface node at `seq` is a SAFE START for a collapsed region —
 * i.e. it is the first surface node of its step, or it belongs to no step at
 * all (a free inter-step / pre-step / injection node).
 *
 * Scans BACKWARD from `seq`, skipping noise, and stops at the first significant
 * event: a turn/step boundary marker ⇒ aligned (nothing of `seq`'s step lies
 * before it), a surface node ⇒ NOT aligned (a predecessor surface node sits in
 * the same step, so starting here would orphan it), start-of-log ⇒ aligned.
 *
 * No open-step check is needed on the start side: an open (unclosed) step can
 * only ever be the LAST turn's last step, never before a valid region start.
 */
export function isStepAlignedStart(events: readonly SessionEvent[], seq: number): boolean {
  for (let i = seq - 1; i >= 0; i--) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const event = events[i]!
    if (BOUNDARY_TYPES.has(event.type)) return true
    if (isSurfaceEvent(event)) return false
  }
  return true
}

/**
 * Whether the surface node at `seq` is a SAFE END for a collapsed region —
 * i.e. it is the last surface node of a CLOSED step, or it belongs to no step
 * at all.
 *
 * Scans FORWARD from `seq`, skipping noise, and stops at the first significant
 * event: a turn/step boundary marker ⇒ aligned (the step/turn closes after
 * `seq`, or a new one begins because `seq` was inter-step), a surface node ⇒
 * NOT aligned (a later surface node sits in the same step). Reaching
 * end-of-log is aligned ONLY when `seq` is not inside an OPEN step — an open
 * trailing step's `tool-call`s have no `tool/result`s yet, so collapsing it
 * would defer the orphan to when those results land later. {@link isInOpenStep}
 * decides that via a backward scan.
 */
export function isStepAlignedEnd(events: readonly SessionEvent[], seq: number): boolean {
  for (let i = seq + 1; i < events.length; i++) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const event = events[i]!
    if (BOUNDARY_TYPES.has(event.type)) return true
    if (isSurfaceEvent(event)) return false
  }
  // End of log: aligned only if `seq` is not inside a still-open step.
  return !isInOpenStep(events, seq)
}

/**
 * Whether `seq` sits inside an OPEN step — a `step/start` with no later
 * `step/end`. Only meaningful at the tail (the EOL branch of
 * {@link isStepAlignedEnd}): scans BACKWARD for the nearest turn/step boundary.
 * The nearest one being `step/start` means a step opened before `seq` and never
 * closed (no `step/end` lies after `seq`, or the forward scan would not have
 * reached EOL) — so `seq` is mid-open-step. Any other nearest boundary (or none)
 * means `seq` is inter-step / pre-step.
 */
function isInOpenStep(events: readonly SessionEvent[], seq: number): boolean {
  for (let i = seq - 1; i >= 0; i--) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const type = events[i]!.type
    if (BOUNDARY_TYPES.has(type)) return type === 'step/start'
  }
  return false
}
