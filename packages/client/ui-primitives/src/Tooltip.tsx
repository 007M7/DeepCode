// Hover/focus label bubble (figma tooltip pill: dark plate, white text).
// TODO: interaction is a placeholder (no show delay, no flip on viewport
// collision, no arrow) — visuals and behavior get a proper pass later.
// The anchor is the child element itself (cloneElement, no wrapper node), so
// attaching a tooltip never changes the anchor's layout context. The bubble is
// position:fixed and coordinates come from the anchor's rect at show time, so
// it escapes ancestor overflow clipping (the sidebar rail clips its column)
// without a portal.

import { cloneElement, useEffect, useRef, useState } from 'react'
import type { FocusEventHandler, MouseEventHandler, ReactElement, Ref } from 'react'
import css from './Tooltip.module.css'

/** Bubble placement relative to the anchor. */
export type TooltipSide = 'right' | 'bottom'

/** Props Tooltip injects into its anchor child; the child's own handlers are chained ahead of the tooltip's. */
interface AnchorProps {
  ref?: Ref<HTMLElement> | undefined
  onMouseEnter?: MouseEventHandler | undefined
  onMouseLeave?: MouseEventHandler | undefined
  onFocus?: FocusEventHandler | undefined
  onBlur?: FocusEventHandler | undefined
}

/**
 * Attach a hover/focus tooltip to an anchor element.
 * @param props.label - bubble text.
 * @param props.side - placement relative to the anchor (default 'right').
 * @param props.disabled - suppress the bubble while true; the anchor renders identically so toggling never remounts it (which would cut its CSS transitions).
 * @param props.children - a single anchor element. Tooltip owns its ref (no current consumer passes one).
 * @returns the cloned anchor plus a fixed-position bubble while hovered/focused.
 */
export function Tooltip({ label, side = 'right', disabled = false, children }: { label: string; side?: TooltipSide; disabled?: boolean; children: ReactElement<AnchorProps> }) {
  const anchor = useRef<HTMLElement | null>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  // Hover and focus are independent triggers: the bubble hides only after
  // BOTH clear (hovering away from a focused anchor must not drop it).
  const triggers = useRef({ hover: false, focus: false })

  // Disabling mid-hover (e.g. clicking a rail control expands the sidebar)
  // must drop an already-visible bubble: no mouseleave fires.
  useEffect(() => {
    if (disabled) { triggers.current = { hover: false, focus: false }; setPos(null) }
  }, [disabled])

  const show = () => {
    if (disabled) return
    const el = anchor.current
    /* v8 ignore next -- the ref is attached by event time: events fire on the cloned anchor. */
    if (el === null) return
    const r = el.getBoundingClientRect()
    setPos(side === 'right'
      ? { x: r.right + 10, y: r.top + r.height / 2 }
      : { x: r.left + r.width / 2, y: r.bottom + 8 })
  }
  const hide = () => {
    if (!triggers.current.hover && !triggers.current.focus) setPos(null)
  }

  return (
    <>
      {cloneElement(children, {
        ref: anchor,
        onMouseEnter: (e) => { children.props.onMouseEnter?.(e); triggers.current.hover = true; show() },
        onMouseLeave: (e) => { children.props.onMouseLeave?.(e); triggers.current.hover = false; hide() },
        onFocus: (e) => { children.props.onFocus?.(e); triggers.current.focus = true; show() },
        onBlur: (e) => { children.props.onBlur?.(e); triggers.current.focus = false; hide() },
      })}
      {pos !== null && (
        <span className={css.bubble} data-side={side} style={{ left: pos.x, top: pos.y }} role="tooltip">
          {label}
        </span>
      )}
    </>
  )
}
