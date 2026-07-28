/** Time-domain projection and filtering for the trajectory overview. */

import type { TrajectoryCellKind, TrajectoryCellProps } from './trajectory-record.ts'
import type { TrajectoryTurnModel } from './layout.ts'

/** Inclusive absolute-time selection in Unix epoch milliseconds. */
export interface TrajectoryTimeRange {
  start: number
  end: number
}

/** One timed ledger record projected into the overview. */
export interface TrajectoryTimelineSpan extends TrajectoryTimeRange {
  index: number
  kind: TrajectoryCellKind
  label: string
  lane: number
}

/** Full-domain model used by the overview. */
export interface TrajectoryTimelineModel extends TrajectoryTimeRange {
  spans: readonly TrajectoryTimelineSpan[]
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

function laneFor(kind: TrajectoryCellKind): number {
  if (kind === 'tool' || kind === 'subtool') return 2
  if (kind === 'message' || kind === 'compacted') return 1
  return 0
}

/**
 * Project every visible timed record into a stable three-lane overview.
 * @param turns - Unfiltered trajectory layout.
 * @returns Timeline model, or `null` when no record carries a start time.
 */
export function deriveTrajectoryTimeline(
  turns: readonly TrajectoryTurnModel[],
): TrajectoryTimelineModel | null {
  const spans = turns.flatMap(turn =>
    turn.groups.flatMap(group =>
      group.cells.flatMap((cell): TrajectoryTimelineSpan[] => {
        if (cell.requestOnly === true) return []
        const range = cellRange(cell)
        return range === null
          ? []
          : [{
            ...range,
            index: cell.index,
            kind: cell.kind,
            label: cell.text,
            lane: laneFor(cell.kind),
          }]
      }),
    ),
  )
  if (spans.length === 0) return null
  return {
    start: Math.min(...spans.map(span => span.start)),
    end: Math.max(...spans.map(span => span.end)),
    spans,
  }
}

function overlaps(cell: TrajectoryCellProps, range: TrajectoryTimeRange): boolean {
  const timed = cellRange(cell)
  return timed !== null && timed.start <= range.end && timed.end >= range.start
}

/**
 * Keep records active at any point inside an inclusive selected interval.
 * @param turns - Unfiltered trajectory layout.
 * @param range - Absolute selected interval, or `null` for the full ledger.
 * @returns A layout retaining original turn, group, and record identities.
 */
export function filterTrajectoryTimelineRange(
  turns: readonly TrajectoryTurnModel[],
  range: TrajectoryTimeRange | null,
): readonly TrajectoryTurnModel[] {
  if (range === null) return turns
  return turns.flatMap((turn): TrajectoryTurnModel[] => {
    const groups = turn.groups.flatMap((group) => {
      const cells = group.cells.filter(cell => overlaps(cell, range))
      return cells.length === 0 ? [] : [{ ...group, cells }]
    })
    return groups.length === 0 ? [] : [{ ...turn, groups }]
  })
}

/**
 * Format a relative timeline offset with a compact unit.
 * @param milliseconds - Non-negative relative offset.
 * @returns Millisecond or second label.
 */
export function formatTimelineOffset(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`
  const seconds = milliseconds / 1_000
  return seconds >= 10 ? `${Math.round(seconds)} s` : `${seconds.toFixed(1)} s`
}
