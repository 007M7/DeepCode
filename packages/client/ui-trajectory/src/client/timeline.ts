/** Operation-sequence and recorded-time projections for the trajectory overview. */

import type { TrajectoryTurnModel } from './layout.ts'
import type { TrajectoryCellKind, TrajectoryCellProps } from './trajectory-record.ts'

/** Horizontal projection used by the trajectory timeline. */
export type TrajectoryTimelineMode = 'sequence' | 'duration' | 'time' | 'actual'

/** Inclusive selection in the active timeline projection's domain. */
export interface TrajectoryTimeRange {
  start: number
  end: number
}

/** One ledger record projected into the active timeline domain. */
export interface TrajectoryTimelineSpan extends TrajectoryTimeRange {
  index: number
  isError: boolean
  kind: TrajectoryCellKind
  label: string
  lane: number
}

/** One turn boundary in the active timeline domain. */
export interface TrajectoryTimelineTurnBoundary {
  turn: number
  time: number
}

/** Full-domain model used by the overview. */
export interface TrajectoryTimelineModel extends TrajectoryTimeRange {
  spans: readonly TrajectoryTimelineSpan[]
  turnBoundaries: readonly TrajectoryTimelineTurnBoundary[]
}

/**
 * Format a timeline duration with a compact unit.
 * @param milliseconds - Non-negative duration in milliseconds.
 * @returns Millisecond or second label.
 */
export function formatTimelineOffset(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`
  const seconds = milliseconds / 1_000
  return seconds >= 10 ? `${Math.round(seconds)} s` : `${seconds.toFixed(1)} s`
}

function laneFor(kind: TrajectoryCellKind): number {
  if (kind === 'tool' || kind === 'subtool') return 2
  if (kind === 'message' || kind === 'compacted') return 1
  return 0
}

function finite(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value)
}

function cellRange(cell: TrajectoryCellProps): TrajectoryTimeRange | null {
  if (!finite(cell.startedAt)) return null
  const durationMs = finite(cell.timeSeconds)
    ? Math.max(0, cell.timeSeconds * 1_000)
    : 0
  return { start: cell.startedAt, end: cell.startedAt + durationMs }
}

/**
 * Project every visible record into a stable three-lane timeline.
 * @param turns - Unfiltered trajectory layout.
 * @param mode - Independent equal/recorded duration and compressed/complete time projection.
 * @returns Timeline model, or `null` when no record is visible.
 */
export function deriveTrajectoryTimeline(
  turns: readonly TrajectoryTurnModel[],
  mode: TrajectoryTimelineMode = 'sequence',
): TrajectoryTimelineModel | null {
  if (mode !== 'sequence') {
    return deriveTimedTimeline(
      turns,
      mode === 'duration' || mode === 'actual',
      mode === 'duration',
    )
  }
  const spans: TrajectoryTimelineSpan[] = []
  const turnBoundaries: TrajectoryTimelineTurnBoundary[] = []

  for (const turn of turns) {
    const cells = turn.groups.flatMap(group =>
      group.cells.filter(cell => cell.requestOnly !== true),
    )
    if (cells.length === 0) continue
    if (turn.turn !== null) {
      turnBoundaries.push({
        turn: turn.turn,
        time: spans.length,
      })
    }
    spans.push(...cells.map((cell, offset): TrajectoryTimelineSpan => ({
      start: spans.length + offset,
      end: spans.length + offset + 1,
      index: cell.index,
      isError: cell.isError === true,
      kind: cell.kind,
      label: cell.text,
      lane: laneFor(cell.kind),
    })))
  }

  if (spans.length === 0) return null
  return {
    start: 0,
    end: spans.length,
    spans,
    turnBoundaries,
  }
}

function deriveTimedTimeline(
  turns: readonly TrajectoryTurnModel[],
  actualDuration: boolean,
  removeUserIdle: boolean,
): TrajectoryTimelineModel | null {
  const spans: TrajectoryTimelineSpan[] = []
  const turnBoundaries: TrajectoryTimelineTurnBoundary[] = []
  let removedUserIdle = 0
  let previousTurnEnd: number | null = null

  for (const turn of turns) {
    const rawSpans = turn.groups.flatMap(group =>
      group.cells.flatMap((cell): TrajectoryTimelineSpan[] => {
        if (cell.requestOnly === true) return []
        const range = cellRange(cell)
        return range === null
          ? []
          : [{
            ...range,
            index: cell.index,
            isError: cell.isError === true,
            kind: cell.kind,
            label: cell.text,
            lane: laneFor(cell.kind),
          }]
      }),
    )
    if (rawSpans.length === 0) continue

    const turnStart = Math.min(...rawSpans.map(span => span.start))
    const turnEnd = Math.max(...rawSpans.map(span => span.end))
    if (removeUserIdle && previousTurnEnd !== null) {
      removedUserIdle += Math.max(0, turnStart - previousTurnEnd)
    }
    spans.push(...rawSpans.map(span => ({
      ...span,
      start: span.start - removedUserIdle,
      end: (actualDuration ? span.end : span.start) - removedUserIdle,
    })))
    if (turn.turn !== null) {
      turnBoundaries.push({
        turn: turn.turn,
        time: turnStart - removedUserIdle,
      })
    }
    previousTurnEnd = previousTurnEnd === null
      ? turnEnd
      : Math.max(previousTurnEnd, turnEnd)
  }

  if (spans.length === 0) return null
  return {
    start: Math.min(...spans.map(span => span.start)),
    end: Math.max(...spans.map(span => span.end)),
    spans,
    turnBoundaries,
  }
}

/**
 * Identify records active at any point inside an inclusive selected interval.
 * @param turns - Unfiltered trajectory layout.
 * @param range - Selected interval in the active projection.
 * @param mode - Independent equal/recorded duration and compressed/complete time projection.
 * @returns Record indexes inside the focus interval.
 */
export function trajectoryTimelineFocusIndexes(
  turns: readonly TrajectoryTurnModel[],
  range: TrajectoryTimeRange,
  mode: TrajectoryTimelineMode = 'sequence',
): ReadonlySet<number> {
  const model = deriveTrajectoryTimeline(turns, mode)
  return new Set(
    model?.spans
      .filter(span => span.start <= range.end && span.end >= range.start)
      .map(span => span.index),
  )
}
