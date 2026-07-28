/** Chrome-Network-style overview timeline for focusing the trajectory ledger. */

import {
  memo, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent,
} from 'react'
import type { TrajectoryTurnModel } from './layout.ts'
import {
  deriveTrajectoryTimeline,
  filterTrajectoryTimelineRange,
  formatTimelineOffset,
  type TrajectoryTimeRange,
} from './timeline.ts'
import css from './TrajectoryTimeline.module.css'

const TICK_COUNT = 5
const MINIMUM_DRAG_PX = 3

interface FractionRange {
  start: number
  end: number
}

/** Props for the fixed full-domain overview above the trajectory ledger. */
export interface TrajectoryTimelineProps {
  turns: readonly TrajectoryTurnModel[]
  range: TrajectoryTimeRange | null
  onRangeChange: (range: TrajectoryTimeRange | null) => void
}

function orderedRange(left: number, right: number): FractionRange {
  return left <= right ? { start: left, end: right } : { start: right, end: left }
}

function clampFraction(value: number): number {
  return Math.min(1, Math.max(0, value))
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

/** Overview renderer with drag-to-filter and Escape/clear reset. */
export const TrajectoryTimeline = memo(function TrajectoryTimeline({
  turns,
  range,
  onRangeChange,
}: TrajectoryTimelineProps) {
  const model = useMemo(() => deriveTrajectoryTimeline(turns), [turns])
  const dragRef = useRef<{ pointerId: number; anchor: number; width: number } | null>(null)
  const [draft, setDraft] = useState<FractionRange | null>(null)
  const domainDuration = Math.max(1, (model?.end ?? 0) - (model?.start ?? 0))
  const committed = model === null || range === null
    ? null
    : rangeFraction(range, model.start, domainDuration)
  const visibleRange = draft ?? committed
  const focusedCount = useMemo(
    () => range === null
      ? model?.spans.length ?? 0
      : deriveTrajectoryTimeline(filterTrajectoryTimelineRange(turns, range))?.spans.length ?? 0,
    [model?.spans.length, range, turns],
  )

  if (model === null) {
    return (
      <section className={css.root} aria-label="Trajectory timeline">
        <div className={css.header}>
          <span className={css.title}>Overview</span>
          <span className={css.summary}>No timing data</span>
        </div>
      </section>
    )
  }

  const fractionAt = (event: PointerEvent<HTMLDivElement>): number => {
    const rect = event.currentTarget.getBoundingClientRect()
    return clampFraction((event.clientX - rect.left) / Math.max(1, rect.width))
  }

  const commit = (fraction: FractionRange) => {
    onRangeChange({
      start: model.start + fraction.start * domainDuration,
      end: model.start + fraction.end * domainDuration,
    })
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    const anchor = fractionAt(event)
    dragRef.current = { pointerId: event.pointerId, anchor, width: Math.max(1, rect.width) }
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    setDraft({ start: anchor, end: anchor })
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    setDraft(orderedRange(drag.anchor, fractionAt(event)))
  }

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    const selected = orderedRange(drag.anchor, fractionAt(event))
    dragRef.current = null
    setDraft(null)
    if ((selected.end - selected.start) * drag.width < MINIMUM_DRAG_PX) {
      onRangeChange(null)
    } else {
      commit(selected)
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
  }

  const ticks = Array.from({ length: TICK_COUNT }, (_, index) => {
    const fraction = index / (TICK_COUNT - 1)
    return {
      fraction,
      label: formatTimelineOffset(fraction * domainDuration),
    }
  })
  const summary = range === null
    ? `${model.spans.length} timed events`
    : `${focusedCount} of ${model.spans.length} events · ${formatTimelineOffset(range.start - model.start)}–${formatTimelineOffset(range.end - model.start)}`

  return (
    <section className={css.root} aria-label="Trajectory timeline">
      <div className={css.header}>
        <span className={css.title}>Overview</span>
        <span className={css.summary} aria-live="polite">{summary}</span>
        {range !== null && (
          <button
            className={css.clear}
            type="button"
            onClick={() => {
              onRangeChange(null)
            }}
          >
            Clear selection
          </button>
        )}
      </div>
      <div
        className={css.plot}
        aria-label="Timeline overview; drag horizontally to filter events"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerCancel}
      >
        <div className={css.ticks} aria-hidden="true">
          {ticks.map(tick => (
            <span
              className={css.tick}
              key={tick.fraction}
              style={{ '--trajectory-tick-left': `${tick.fraction * 100}%` } as CSSProperties}
            >
              {tick.label}
            </span>
          ))}
        </div>
        <div className={css.lanes} aria-hidden="true">
          {model.spans.map((span) => {
            const left = (span.start - model.start) / domainDuration
            const width = (span.end - span.start) / domainDuration
            return (
              <span
                className={css.span}
                data-timeline-span={span.kind}
                key={span.index}
                title={`${span.label} · ${formatTimelineOffset(span.end - span.start)}`}
                style={{
                  '--trajectory-span-left': `${left * 100}%`,
                  '--trajectory-span-width': `${Math.max(width * 100, 0.35)}%`,
                  '--trajectory-span-lane': span.lane,
                } as CSSProperties}
              />
            )
          })}
        </div>
        {visibleRange !== null && (
          <div
            className={css.selection}
            data-dragging={draft === null ? undefined : 'true'}
            aria-hidden="true"
            style={{
              '--trajectory-selection-left': `${visibleRange.start * 100}%`,
              '--trajectory-selection-width': `${(visibleRange.end - visibleRange.start) * 100}%`,
            } as CSSProperties}
          />
        )}
      </div>
    </section>
  )
})
