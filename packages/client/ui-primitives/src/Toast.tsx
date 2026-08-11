import { useEffect } from 'react'
import type { ReactNode } from 'react'
import css from './Toast.module.css'

/** Full-opacity hold before the fade starts. Must agree with the stylesheet's
 * toast-fade delay (Toast.module.css) or the banner unmounts mid-fade. */
const HOLD_MS = 3000
/** Fade duration. Must agree with the stylesheet's toast-fade duration. */
const FADE_MS = 1000

/**
 * Transient top-center banner: slides in, holds at full opacity, fades out,
 * then reports done so the owner can unmount it. Re-showing the same text
 * restarts the cycle when the owner remounts the component (key it by a
 * per-show sequence).
 *
 * @param props.text - resolved banner copy; the owner passes localized text.
 * @param props.icon - optional leading glyph (e.g. a warning icon).
 * @param props.onDone - called once the fade completes; unmount the toast here.
 * @returns the floating banner.
 */
export function Toast({ text, icon, onDone }: {
  text: string
  icon?: ReactNode
  onDone: () => void
}) {
  useEffect(() => {
    const timer = setTimeout(onDone, HOLD_MS + FADE_MS)
    return () => { clearTimeout(timer) }
  }, [onDone])
  return (
    <div className={css.toast} role="alert">
      {icon !== undefined && <span className={css.icon} aria-hidden>{icon}</span>}
      <span className={css.text}>{text}</span>
    </div>
  )
}
