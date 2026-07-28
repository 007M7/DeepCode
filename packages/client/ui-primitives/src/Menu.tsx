// Menu: minimal controlled dropdown (group-by pickers, project selectors).
// Default: pure CSS positioning relative to the anchor wrapper — no popper.
// Opt-in `portal` renders the list into document.body, fixed-positioned from
// the anchor rect, for anchors inside overflow-clipping containers (sidebar).
// The owner controls `open`; outside-click closing uses one document listener
// active only while open. Submenus open on hover/focus inside the same root.
// Entries also cover non-interactive `label` headings and `danger` rows.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { IconCheckOutline16 } from './icons/index.tsx'
import css from './Menu.module.css'

/** Selectable row (optionally with a nested submenu). */
export interface MenuItem {
  id: string
  label: ReactNode
  disabled?: boolean
  /** Leading icon (figma .Menu_cell gap 8). */
  icon?: ReactNode
  /** Destructive row: error-colored text/icon and danger hover fill. */
  danger?: boolean
  /** Nested card opened to the right on hover/focus. */
  submenu?: readonly MenuItem[]
}

/** Hairline between item groups (not selectable). */
export interface MenuSeparator {
  type: 'separator'
  id: string
}

/** Non-interactive heading row above a group of items. */
export interface MenuLabel {
  type: 'label'
  id: string
  text: string
}

/** One primary-menu entry: a row, a separator, or a heading label. */
export type MenuEntry = MenuItem | MenuSeparator | MenuLabel

function isSeparator(entry: MenuEntry): entry is MenuSeparator {
  return 'type' in entry && entry.type === 'separator'
}

function isLabel(entry: MenuEntry): entry is MenuLabel {
  return 'type' in entry && entry.type === 'label'
}

/**
 * Render an anchored dropdown menu.
 * @param props.open - whether the list is showing (owner-controlled).
 * @param props.anchor - the trigger element (rendered in place).
 * @param props.items - selectable rows and optional separators.
 * @param props.selectedId - row shown as selected.
 * @param props.onSelect - row click callback (not called for disabled rows or submenu parents that only open children).
 * @param props.onClose - invoked on outside click or Escape.
 * @param props.align - list alignment against the anchor (default 'start').
 * @param props.side - open below (`bottom`, default) or above (`top`) the anchor.
 * @param props.portal - render the list into document.body, fixed-positioned
 * from the anchor rect (repositions on scroll/resize while open). Use when an
 * ancestor's overflow clipping would crop the in-place list; default false
 * keeps the pure-CSS in-place behavior.
 * @param props.closeOnPointerLeave - close the list when the pointer leaves
 * it (default false keeps it open until outside click/Escape/selection).
 * @param props.getAnchorRect - portal mode only: supply the anchor rect
 * directly (e.g. from a host-owned trigger button) instead of measuring the
 * Menu's own wrapper span. Required when the wrapper isn't itself laid out at
 * the trigger (render-prop anchors, effect-positioned proxies — measuring the
 * wrapper there races the host's layout effects). Called on open and on every
 * scroll/resize; return null to skip placement for that frame.
 * @returns anchor wrapper with the conditional list.
 */
export function Menu({ open, anchor, items, selectedId, onSelect, onClose, align = 'start', side = 'bottom', portal = false, closeOnPointerLeave = false, getAnchorRect, className }: {
  open: boolean
  anchor: ReactNode
  items: readonly MenuEntry[]
  selectedId?: string
  onSelect: (id: string) => void
  onClose: () => void
  align?: 'start' | 'end'
  side?: 'bottom' | 'top'
  portal?: boolean
  closeOnPointerLeave?: boolean
  getAnchorRect?: () => DOMRect | null
  className?: string
}) {
  const rootRef = useRef<HTMLSpanElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [openSubmenuId, setOpenSubmenuId] = useState<string | null>(null)
  const [fixedPos, setFixedPos] = useState<CSSProperties | null>(null)

  // Portal mode: fixed-position the list from the anchor rect before paint;
  // track the anchor while open (capture-phase scroll catches nested panes).
  // getAnchorRect trumps measuring the wrapper span: a child layout effect
  // runs before the parent's, so a wrapper the host positions in its own
  // effect measures stale here — the host callback owns the truth instead.
  useLayoutEffect(() => {
    if (!open || !portal) { setFixedPos(null); return }
    const place = () => {
      let r: DOMRect | null
      if (getAnchorRect !== undefined) {
        r = getAnchorRect()
      } else {
        /* v8 ignore next 2 -- the ref is attached before the layout effect runs and the listeners die with it. */
        r = rootRef.current?.getBoundingClientRect() ?? null
      }
      if (r === null) return
      setFixedPos({
        ...(align === 'start' ? { left: r.left } : { right: window.innerWidth - r.right }),
        ...(side === 'bottom' ? { top: r.bottom + 4 } : { bottom: window.innerHeight - r.top + 4 }),
      })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, portal, align, side, getAnchorRect])

  useEffect(() => {
    if (!open) {
      setOpenSubmenuId(null)
      return
    }
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node)) return
      // The portaled list is outside the anchor subtree; check both.
      if (rootRef.current?.contains(e.target) === true) return
      if (listRef.current?.contains(e.target) === true) return
      onClose()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onClose])

  const list = open && (!portal || fixedPos !== null) && (
    <div
      ref={listRef}
      className={clsx(css.list, portal && css.portal, side === 'top' && !portal && css.sideTop, align === 'end' && !portal && css.alignEnd)}
      style={fixedPos ?? undefined}
      role="menu"
      onPointerLeave={closeOnPointerLeave ? () => { onClose() } : undefined}
      // React portals bubble synthetic events through the REACT tree: without
      // this stop, an item click re-fires the anchor row's own onClick
      // (open/toggle) after onSelect.
      onClick={(e) => { e.stopPropagation() }}
    >
      {items.map((entry) => {
        if (isSeparator(entry)) {
          return <div key={entry.id} className={css.separator} role="separator" />
        }
        if (isLabel(entry)) {
          return <div key={entry.id} className={css.label} role="presentation">{entry.text}</div>
        }
        const hasSub = entry.submenu !== undefined && entry.submenu.length > 0
        const subOpen = hasSub && openSubmenuId === entry.id
        return (
          <div
            key={entry.id}
            className={css.itemWrap}
            onMouseEnter={() => { setOpenSubmenuId(hasSub ? entry.id : null) }}
            onMouseLeave={() => { setOpenSubmenuId(null) }}
          >
            <button
              type="button"
              role="menuitem"
              className={clsx(css.item, entry.id === selectedId && css.selected, entry.danger === true && css.danger)}
              disabled={entry.disabled}
              aria-haspopup={hasSub ? 'menu' : undefined}
              aria-expanded={hasSub ? subOpen : undefined}
              onFocus={() => { setOpenSubmenuId(hasSub ? entry.id : null) }}
              onClick={() => {
                if (hasSub) {
                  setOpenSubmenuId(entry.id)
                  return
                }
                onSelect(entry.id)
              }}
            >
              {entry.icon !== undefined && <span className={css.itemIcon}>{entry.icon}</span>}
              <span className={css.itemLabel}>{entry.label}</span>
              {/* Selection marker is a trailing check (figma .Menu_cell), not a fill. */}
              {entry.id === selectedId && <IconCheckOutline16 className={css.check} />}
            </button>
            {subOpen && entry.submenu !== undefined && (
              <div className={css.submenu} role="menu">
                {entry.submenu.map(sub => (
                  <button
                    key={sub.id}
                    type="button"
                    role="menuitem"
                    className={css.item}
                    disabled={sub.disabled}
                    onClick={() => { onSelect(sub.id) }}
                  >
                    {sub.icon !== undefined && <span className={css.itemIcon}>{sub.icon}</span>}
                    <span className={css.itemLabel}>{sub.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )

  return (
    <span ref={rootRef} className={clsx(css.root, className)}>
      {anchor}
      {portal ? (list !== false && createPortal(list, document.body)) : list}
    </span>
  )
}
