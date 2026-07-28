/** Chrome-Network-style overview timeline for focusing the trajectory ledger. */

import {
  memo, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent,
  type PointerEvent, type WheelEvent,
} from 'react'
import type { TrajectoryTurnModel } from './layout.ts'
import {
  deriveTrajectoryTimeline,
  formatTimelineOffset,
  type TrajectoryTimelineMode,
  type TrajectoryTimeRange,
} from './timeline.ts'
import css from './TrajectoryTimeline.module.css'

const MINIMUM_DRAG_PX = 3
const MINIMUM_ZOOM_OPERATIONS = 4

interface FractionRange {
  start: number
  end: number
}

/** Props for the fixed full-domain overview above the trajectory ledger. */
export interface TrajectoryTimelineProps {
  turns: readonly TrajectoryTurnModel[]
  mode: TrajectoryTimelineMode
  range: TrajectoryTimeRange | null
  selectedIndex?: number | null
  /** Record indexes matching the active ledger search, or null without a query. */
  searchMatchIndexes?: ReadonlySet<number> | null
  onRangeChange: (range: TrajectoryTimeRange | null) => void
  onRecordFocus?: (index: number) => void
}

function orderedRange(left: number, right: number): FractionRange {
  return left <= right ? { start: left, end: right } : { start: right, end: left }
}

function clampFraction(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function centeredRange(center: number, width: number): FractionRange {
  const clampedWidth = Math.min(1, Math.max(0, width))
  const start = Math.min(
    Math.max(center - clampedWidth / 2, 0),
    1 - clampedWidth,
  )
  return { start, end: start + clampedWidth }
}

function rangeFraction(
  range: TrajectoryTimeRange,
  start: number,
  duration: number,
): FractionRange {
  return orderedRange(
    clampFraction((range.start - start) / duration),
    clampFraction((range.end - start) / duration),
  )
}

function LaneLabels() {
  return (
    <div className={css.labels} aria-hidden="true">
      <span>Input</span>
      <span>Model</span>
      <span>Tools</span>
    </div>
  )
}

/** Overview renderer with drag ranges, click-sized focus, and Escape reset. */
export const TrajectoryTimeline = memo(function TrajectoryTimeline({
  turns,
  mode,
  range,
  selectedIndex = null,
  searchMatchIndexes = null,
  onRangeChange,
  onRecordFocus,
}: TrajectoryTimelineProps) {
  const model = useMemo(() => deriveTrajectoryTimeline(turns, mode), [mode, turns])
  const durationByIndex = useMemo(
    () => new Map(turns.flatMap(turn =>
      turn.groups.flatMap(group =>
        group.cells.flatMap(cell =>
          cell.timeSeconds === null || !Number.isFinite(cell.timeSeconds)
            ? []
            : [[cell.index, Math.max(0, cell.timeSeconds * 1_000)] as const],
        ),
      ),
    )),
    [turns],
  )
  const dragRef = useRef<{ pointerId: number; anchor: number; width: number } | null>(null)
  const [draft, setDraft] = useState<FractionRange | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [viewport, setViewport] = useState<TrajectoryTimeRange | null>(null)
  useEffect(() => {
    if (
      model !== null
      && range !== null
      && (range.end < model.start || range.start > model.end)
    ) {
      onRangeChange(null)
    }
  }, [model, onRangeChange, range])
  useEffect(() => {
    if (model === null) return
    setViewport(current =>
      current !== null && (current.end < model.start || current.start > model.end)
        ? null
        : current)
  }, [model])
  const fullDuration = Math.max(1, (model?.end ?? 0) - (model?.start ?? 0))
  const viewportDuration = Math.min(
    fullDuration,
    Math.max(1, (viewport?.end ?? 0) - (viewport?.start ?? 0)),
  )
  const viewportStart = model === null || viewport === null
    ? model?.start ?? 0
    : Math.min(
      Math.max(viewport.start, model.start),
      model.end - viewportDuration,
    )
  const domainDuration = viewport === null ? fullDuration : viewportDuration
  const domainStart = viewport === null ? model?.start ?? 0 : viewportStart
  const committed = model === null || range === null
    ? null
    : rangeFraction(range, domainStart, domainDuration)
  const visibleRange = draft ?? committed
  const activeRange = draft === null
    ? range
    : {
      start: domainStart + draft.start * domainDuration,
      end: domainStart + draft.end * domainDuration,
    }

  if (model === null) {
    return (
      <section className={css.root} aria-label="Trajectory timeline">
        <div className={css.plot}>
          <LaneLabels />
          <div className={css.track}>
            <span className={css.empty}>No timing data</span>
          </div>
        </div>
      </section>
    )
  }

  const minimumSelectionFraction = Math.min(
    1,
    fullDuration / domainDuration / model.spans.length,
  )

  const fractionAt = (event: PointerEvent<HTMLDivElement>): number => {
    const rect = event.currentTarget.getBoundingClientRect()
    return clampFraction((event.clientX - rect.left) / Math.max(1, rect.width))
  }

  const commit = (fraction: FractionRange) => {
    onRangeChange({
      start: domainStart + fraction.start * domainDuration,
      end: domainStart + fraction.end * domainDuration,
    })
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    const anchor = fractionAt(event)
    setHover(anchor)
    dragRef.current = { pointerId: event.pointerId, anchor, width: Math.max(1, rect.width) }
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    setDraft({ start: anchor, end: anchor })
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    const fraction = fractionAt(event)
    setHover(fraction)
    if (drag === null || drag.pointerId !== event.pointerId) return
    setDraft(orderedRange(drag.anchor, fraction))
  }

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    const point = fractionAt(event)
    const selected = orderedRange(drag.anchor, point)
    setHover(point)
    dragRef.current = null
    setDraft(null)
    const click = (selected.end - selected.start) * drag.width < MINIMUM_DRAG_PX
    const committedRange = selected.end - selected.start < minimumSelectionFraction
      ? centeredRange(
        click ? selected.start : (selected.start + selected.end) / 2,
        minimumSelectionFraction,
      )
      : selected
    commit(committedRange)
    if (click) {
      const timelinePoint = domainStart + selected.start * domainDuration
      const nearest = model.spans.reduce((candidate, span) => {
        const candidateDistance = timelinePoint < candidate.start
          ? candidate.start - timelinePoint
          : timelinePoint > candidate.end ? timelinePoint - candidate.end : 0
        const spanDistance = timelinePoint < span.start
          ? span.start - timelinePoint
          : timelinePoint > span.end ? timelinePoint - span.end : 0
        return spanDistance < candidateDistance ? span : candidate
      })
      onRecordFocus?.(nearest.index)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || range === null) return
    event.preventDefault()
    onRangeChange(null)
  }

  const onPointerCancel = () => {
    dragRef.current = null
    setDraft(null)
    setHover(null)
  }

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const anchorFraction =
      clampFraction((event.clientX - rect.left) / Math.max(1, rect.width))
    const nextDuration = Math.min(
      fullDuration,
      Math.max(
        Math.min(mode === 'sequence' ? MINIMUM_ZOOM_OPERATIONS : 20, fullDuration),
        domainDuration * Math.exp(event.deltaY * 0.0015),
      ),
    )
    if (nextDuration >= fullDuration * 0.999) {
      setViewport(null)
      return
    }
    const anchorTime = domainStart + anchorFraction * domainDuration
    const nextStart = Math.min(
      Math.max(anchorTime - anchorFraction * nextDuration, model.start),
      model.end - nextDuration,
    )
    setViewport({ start: nextStart, end: nextStart + nextDuration })
  }

  return (
    <section className={css.root} aria-label="Trajectory timeline">
      <div className={css.plot}>
        <LaneLabels />
        <div
          className={css.track}
          aria-label="Timeline overview; drag horizontally to focus events"
          tabIndex={0}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerCancel}
          onPointerLeave={() => {
            if (dragRef.current === null) setHover(null)
          }}
          onDoubleClick={(event) => {
            event.preventDefault()
            onRangeChange(null)
          }}
          onWheel={onWheel}
          onContextMenu={(event) => {
            event.preventDefault()
            onRangeChange(null)
            setViewport(null)
          }}
        >
          {hover !== null && draft === null && (
            <div
              className={css.hoverLine}
              aria-hidden="true"
              style={{
                '--trajectory-hover-left': `${hover * 100}%`,
              } as CSSProperties}
            />
          )}
          {visibleRange !== null && (
            <>
              <div
                className={css.selection}
                data-dragging={draft === null ? undefined : 'true'}
                aria-hidden="true"
                style={{
                  '--trajectory-selection-left': `${visibleRange.start * 100}%`,
                  '--trajectory-selection-width': `${(visibleRange.end - visibleRange.start) * 100}%`,
                } as CSSProperties}
              />
              <div
                className={css.selectionEdges}
                data-dragging={draft === null ? undefined : 'true'}
                aria-hidden="true"
                style={{
                  '--trajectory-selection-left': `${visibleRange.start * 100}%`,
                  '--trajectory-selection-width': `${(visibleRange.end - visibleRange.start) * 100}%`,
                } as CSSProperties}
              />
            </>
          )}
          <div className={css.turnBoundaries} aria-hidden="true">
            {model.turnBoundaries
              .slice(1)
              .filter(boundary =>
                boundary.time >= domainStart
                && boundary.time <= domainStart + domainDuration)
              .map(boundary => (
                <span
                  className={css.turnBoundary}
                  data-turn={boundary.turn}
                  key={boundary.turn}
                  style={{
                    '--trajectory-turn-left':
                      `${(boundary.time - domainStart) / domainDuration * 100}%`,
                  } as CSSProperties}
                />
              ))}
          </div>
          <div className={css.lanes} aria-hidden="true">
            {model.spans
              .filter(span => span.end >= domainStart && span.start <= domainStart + domainDuration)
              .map((span) => {
                const left = (span.start - domainStart) / domainDuration
                const width = (span.end - span.start) / domainDuration
                const durationMs = durationByIndex.get(span.index)
                return (
                  <span
                    className={css.span}
                    data-timeline-span={span.kind}
                    data-equal-duration={mode === 'time' || undefined}
                    data-current={span.index === selectedIndex || undefined}
                    data-search-match={searchMatchIndexes === null
                      ? undefined
                      : searchMatchIndexes.has(span.index) ? 'true' : 'false'}
                    data-selected={activeRange === null
                      ? undefined
                      : span.start <= activeRange.end && span.end >= activeRange.start
                        ? 'true'
                        : 'false'}
                    key={span.index}
                    title={durationMs === undefined
                      ? span.label
                      : `${span.label} · ${formatTimelineOffset(durationMs)}`}
                    style={{
                      '--trajectory-span-left': `${left * 100}%`,
                      '--trajectory-span-width': `${Math.max(width * 100, 0.35)}%`,
                      '--trajectory-span-lane': span.lane,
                    } as CSSProperties}
                  />
                )
              })}
          </div>
        </div>
      </div>
    </section>
  )
})
