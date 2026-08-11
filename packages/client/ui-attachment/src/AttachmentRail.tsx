/** Draft-attachment thumbnail rail: scrollbar-less horizontal overflow paged
 * by edge arrows, hover-revealed per-item remove, single-click open. */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { WheelEvent } from 'react'
import clsx from 'clsx'
import {
  IconChevronLeftOutline14, IconChevronRightOutline14, IconCloseFill14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './AttachmentRail.module.css'

/** One rail thumbnail; strings arrive resolved (zero-cordis atom). */
export interface AttachmentRailItem {
  /** Stable identity for the React key. */
  id: string
  /** Object or data URL rendered as the thumbnail. */
  previewUrl: string
  /** Image alt text (display name with the owner's fallback applied). */
  alt: string
  /** Accessible label of the item's remove control. */
  removeLabel: string
}

/** Rail-level strings the owner resolves from its own locale namespace. */
export interface AttachmentRailLabels {
  /** Accessible name of the rail group. */
  group: string
  /** Thumbnail tooltip inviting the original-image preview. */
  open: string
  /** Accessible label of the left paging arrow. */
  scrollLeft: string
  /** Accessible label of the right paging arrow. */
  scrollRight: string
}

/**
 * Horizontal thumbnail rail over the caller's draft attachments.
 *
 * The rail scrolls with its scrollbar hidden; overflow is announced by edge
 * arrows recomputed from scroll geometry on scroll, item-count changes, and
 * window resizes. A vertical wheel pans horizontally, a newly added item is
 * revealed at the rail's end, and each thumbnail opens on a single click while
 * its remove control sits inside the card and reveals on hover or focus.
 * The owner decides mounting; it renders the rail only while items exist.
 *
 * @param props.items - resolved thumbnails in draft order.
 * @param props.labels - rail-level strings (group name, open tooltip, arrows).
 * @param props.onOpen - single-click open of one item's original image.
 * @param props.onRemove - remove one item from the draft.
 * @returns the rail group with its paging arrows.
 */
export function AttachmentRail<T extends AttachmentRailItem>({ items, labels, onOpen, onRemove }: {
  items: readonly T[]
  labels: AttachmentRailLabels
  onOpen: (item: T) => void
  onRemove: (item: T) => void
}) {
  const railRef = useRef<HTMLDivElement | null>(null)
  const countRef = useRef(0)
  const [edges, setEdges] = useState({ left: false, right: false })
  const updateEdges = useCallback(() => {
    const el = railRef.current
    /* v8 ignore next -- defensive: every caller runs while the rail element is mounted. */
    if (el === null) return
    // 1px slack: engines report fractional scroll positions at the edges.
    const left = el.scrollLeft > 1
    const right = el.scrollLeft < el.scrollWidth - el.clientWidth - 1
    setEdges(prev => prev.left === left && prev.right === right ? prev : { left, right })
  }, [])
  useLayoutEffect(() => {
    const grew = items.length > countRef.current
    countRef.current = items.length
    const el = railRef.current
    // A newly added attachment lands at the rail's end: reveal it.
    if (grew && el !== null) el.scrollLeft = el.scrollWidth - el.clientWidth
    updateEdges()
  }, [items.length, updateEdges])
  useEffect(() => {
    window.addEventListener('resize', updateEdges)
    return () => { window.removeEventListener('resize', updateEdges) }
  }, [updateEdges])
  const page = (direction: -1 | 1): void => {
    const el = railRef.current
    /* v8 ignore next -- defensive: the arrows render only while the rail is mounted, so a click cannot find a null ref. */
    if (el === null) return
    // One viewport minus a card keeps the last visible thumbnail as context;
    // the floor keeps narrow rails paging a useful distance.
    el.scrollBy({ left: direction * Math.max(el.clientWidth - 64, 200), behavior: 'smooth' })
  }
  // A vertical wheel pans the rail horizontally (trackpads pan natively via
  // deltaX); per-tick travel is clamped so a fast notch wheel stays followable.
  const onWheel = (event: WheelEvent<HTMLDivElement>): void => {
    if (event.deltaX !== 0 || event.deltaY === 0) return
    event.currentTarget.scrollBy({
      left: Math.sign(event.deltaY) * Math.min(Math.abs(event.deltaY), 60),
      behavior: 'auto',
    })
  }
  return (
    <div className={css.root}>
      {edges.left && (
        <button
          type="button"
          className={clsx(css.arrow, css.arrowLeft)}
          aria-label={labels.scrollLeft}
          onClick={() => { page(-1) }}
        >
          <IconChevronLeftOutline14 />
        </button>
      )}
      <div
        ref={railRef}
        className={css.rail}
        role="group"
        aria-label={labels.group}
        onScroll={updateEdges}
        onWheel={onWheel}
      >
        {items.map(item => (
          <div key={item.id} className={css.item}>
            <button
              type="button"
              className={css.thumbnail}
              title={labels.open}
              onClick={() => { onOpen(item) }}
            >
              <img src={item.previewUrl} alt={item.alt} />
            </button>
            <button
              type="button"
              className={css.remove}
              aria-label={item.removeLabel}
              onClick={() => { onRemove(item) }}
            >
              <IconCloseFill14 size={12} />
            </button>
          </div>
        ))}
      </div>
      {edges.right && (
        <button
          type="button"
          className={clsx(css.arrow, css.arrowRight)}
          aria-label={labels.scrollRight}
          onClick={() => { page(1) }}
        >
          <IconChevronRightOutline14 />
        </button>
      )}
    </div>
  )
}
