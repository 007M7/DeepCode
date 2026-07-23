// StateDot: session state indicator (figma nodes 14:3303/3305/3312, 122:9182).
// done/warning/error: 10x10 halo (same color, 10% opacity) around a 6x6 solid
// core. ongoing: 10x10 ring, 1px inside stroke, color fading out along a
// linear gradient, spinning. Colors resolve through --dsw-* tokens only.

import { useId } from 'react'
import clsx from 'clsx'
import css from './StateDot.module.css'

/** Four-color session state semantic (green done / amber approval-waiting / blue running ring / red error). */
export type StateDotState = 'done' | 'warning' | 'ongoing' | 'error'

/**
 * Render a state dot.
 * @param props.state - which of the four states to show.
 * @param props.size - outer diameter in px (default 10, the figma size).
 * @param props.className - extra class for layout placement.
 * @returns the dot element (aria-hidden; pair with text for accessibility).
 */
export function StateDot({ state, size = 10, className }: {
  state: StateDotState
  size?: number
  className?: string
}) {
  const gradientId = useId()
  if (state === 'ongoing') {
    return (
      <svg
        className={clsx(css.ring, className)}
        data-state="ongoing"
        width={size}
        height={size}
        viewBox="0 0 10 10"
        aria-hidden="true"
      >
        <defs>
          {/* Gradient handles from the figma node: (0.1,0) -> (0.85,1). */}
          <linearGradient id={gradientId} x1="1" y1="0" x2="8.5" y2="10" gradientUnits="userSpaceOnUse">
            <stop className={css.stopFrom} offset="0" />
            <stop className={css.stopTo} offset="1" />
          </linearGradient>
        </defs>
        <circle cx="5" cy="5" r="4.5" fill="none" strokeWidth="1" stroke={`url(#${gradientId})`} />
      </svg>
    )
  }
  return (
    <span
      className={clsx(css.dot, className)}
      data-state={state}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  )
}
