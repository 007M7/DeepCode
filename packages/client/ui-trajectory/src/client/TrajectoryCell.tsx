// TrajectoryCell: one step row in the trajectory list — index, kind tag,
// ellipsis text, optional Message token metrics, and own-duration time.

import type { HTMLAttributes } from 'react'
import css from './TrajectoryCell.module.css'

/** Closed set of trajectory step kinds (call+result fold into Tool; no Think;
 *  subtool = one run_code sub-dispatch nested under its Tool cell). */
export type TrajectoryCellKind = 'user' | 'message' | 'tool' | 'subtool'

/** Display label per kind (matches the design tags). */
const KIND_LABEL: Record<TrajectoryCellKind, string> = {
  user: 'User',
  message: 'Message',
  tool: 'Tool',
  subtool: 'Sub',
}

const TAG_CLASS: Record<TrajectoryCellKind, string> = {
  user: css.tagUser!,
  message: css.tagMessage!,
  tool: css.tagTool!,
  subtool: css.tagSubtool!,
}

export interface TrajectoryCellProps extends HTMLAttributes<HTMLDivElement> {
  /** 1-based step index shown as `#N`. */
  index: number
  kind: TrajectoryCellKind
  /** Single-line summary; CSS ellipsis when it overflows. */
  text: string
  /**
   * Own duration in seconds. `null` means no duration to show (em dash) —
   * used for in-flight tools and tools missing callTime.
   */
  timeSeconds: number | null
  /** Message-only: prompt token count. */
  input?: number
  /** Message-only: completion token count. */
  output?: number
  /** Message-only: reasoning token count (usage column, not a Think cell). */
  think?: number
  /** Selected: 2px inset brand-primary-new-color ring (not wired to chat selection yet). */
  selected?: boolean
}

/**
 * Format own-duration for the trailing time column: `—` when unknown, `+Ns`
 * or `+N.1s` otherwise.
 * @param seconds - duration seconds, or null when absent.
 * @returns display string.
 */
export function formatElapsedSeconds(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—'
  const rounded = Math.round(seconds * 10) / 10
  if (Number.isInteger(rounded)) return `+${rounded}s`
  return `+${rounded.toFixed(1)}s`
}

/**
 * Render one trajectory step cell.
 * @param props - index, kind, text, time, and optional Message metrics.
 * @returns the cell element.
 */
export function TrajectoryCell({
  index,
  kind,
  text,
  timeSeconds,
  input,
  output,
  think,
  selected = false,
  className,
  ...rest
}: TrajectoryCellProps) {
  const rootClass = [
    css.root,
    selected ? css.selected : undefined,
    className,
  ].filter((c): c is string => c !== undefined).join(' ')
  const showMetrics = kind === 'message'
  return (
    <div className={rootClass} data-kind={kind} data-selected={selected || undefined} {...rest}>
      <span className={css.index}>#{index}</span>
      <span className={css.tagSlot}>
        <span className={`${css.tag} ${TAG_CLASS[kind]}`}>{KIND_LABEL[kind]}</span>
      </span>
      <span className={css.text}>{text}</span>
      <span className={css.trailing}>
        {showMetrics ? (
          <>
            <span className={css.metric}>{input ?? ''}</span>
            <span className={css.metric}>{output ?? ''}</span>
            <span className={css.metric}>{think ?? ''}</span>
          </>
        ) : null}
        <span className={css.time}>{formatElapsedSeconds(timeSeconds)}</span>
      </span>
    </div>
  )
}
