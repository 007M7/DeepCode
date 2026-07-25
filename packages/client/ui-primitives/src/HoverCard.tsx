// HoverCard: delayed hover-preview card portaled to document.body.
// Same portal mechanics as Menu: the wrapper span supplies the anchor rect,
// the card is fixed-positioned at its right edge and repositions on
// scroll/resize while open. Display-only — the card ignores pointer events
// and closes the instant the pointer leaves the anchor (no close delay).

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import css from './HoverCard.module.css'

/**
 * Render an anchor with a hover-triggered preview card.
 * @param props.anchor - the hover target (rendered in place inside a wrapper span).
 * @param props.content - card content (display-only, no pointer interaction).
 * @param props.openDelayMs - hover dwell before the card shows (default 500).
 * @param props.disabled - suppress opening; turning true closes an open card.
 * @returns anchor wrapper with the conditional portaled card.
 */
export function HoverCard({ anchor, content, openDelayMs = 500, disabled = false }: {
  anchor: ReactNode
  content: ReactNode
  openDelayMs?: number
  disabled?: boolean
}) {
  const rootRef = useRef<HTMLSpanElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  // Owner disabling mid-hover (menu opened, drag started) closes immediately.
  useEffect(() => {
    if (!disabled) return
    clearTimer()
    setOpen(false)
  }, [disabled])

  useEffect(() => clearTimer, [])

  // Fixed-position from the anchor rect before paint; track the anchor while
  // open (capture-phase scroll catches nested panes), as in Menu portal mode.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    const place = () => {
      const wrapper = rootRef.current
      /* v8 ignore next -- the ref is attached before the layout effect runs and the listeners die with it. */
      if (wrapper === null) return
      const r = wrapper.getBoundingClientRect()
      const h = cardRef.current?.offsetHeight ?? 0
      const top = r.top + h > window.innerHeight - 8 ? window.innerHeight - h - 8 : r.top
      setPos({ left: r.right + 8, top })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open])

  // The first placement ran before the card mounted (height read 0): once the
  // card's real height is measurable, correct the bottom-edge clamp. The
  // correction converges — a clamped top satisfies the guard, so it runs once.
  useLayoutEffect(() => {
    if (!open || pos === null) return
    /* v8 ignore next -- the card is mounted whenever pos is set, so the ref is attached here. */
    const h = cardRef.current?.offsetHeight ?? 0
    if (pos.top + h > window.innerHeight - 8) {
      setPos({ left: pos.left, top: window.innerHeight - h - 8 })
    }
  }, [open, pos])

  const card = open && pos !== null && (
    <div ref={cardRef} className={css.card} style={pos}>
      {content}
    </div>
  )

  return (
    <span
      ref={rootRef}
      className={css.root}
      onPointerEnter={() => {
        if (disabled) return
        clearTimer()
        timerRef.current = setTimeout(() => { setOpen(true) }, openDelayMs)
      }}
      onPointerLeave={() => {
        clearTimer()
        setOpen(false)
      }}
      // Any press inside the anchor (row click, menu trigger) dismisses the
      // card immediately, without waiting for the owner to flip `disabled`.
      onPointerDownCapture={() => {
        clearTimer()
        setOpen(false)
      }}
    >
      {anchor}
      {card !== false && createPortal(card, document.body)}
    </span>
  )
}
