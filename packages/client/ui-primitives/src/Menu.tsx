// Menu: minimal controlled dropdown (group-by pickers, project selectors).
// Pure CSS positioning relative to the anchor wrapper — no portal, no popper.
// The owner controls `open`; outside-click closing uses one document listener
// active only while open. Submenus open on hover/focus inside the same root.

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
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
  /** Nested card opened to the right on hover/focus. */
  submenu?: readonly MenuItem[]
}

/** Hairline between item groups (not selectable). */
export interface MenuSeparator {
  type: 'separator'
  id: string
}

/** One primary-menu entry: a row or a separator. */
export type MenuEntry = MenuItem | MenuSeparator

function isSeparator(entry: MenuEntry): entry is MenuSeparator {
  return 'type' in entry && entry.type === 'separator'
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
 * @returns anchor wrapper with the conditional list.
 */
export function Menu({ open, anchor, items, selectedId, onSelect, onClose, align = 'start', side = 'bottom', className }: {
  open: boolean
  anchor: ReactNode
  items: readonly MenuEntry[]
  selectedId?: string
  onSelect: (id: string) => void
  onClose: () => void
  align?: 'start' | 'end'
  side?: 'bottom' | 'top'
  className?: string
}) {
  const rootRef = useRef<HTMLSpanElement>(null)
  const [openSubmenuId, setOpenSubmenuId] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setOpenSubmenuId(null)
      return
    }
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) onClose()
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

  return (
    <span ref={rootRef} className={clsx(css.root, className)}>
      {anchor}
      {open && (
        <div className={clsx(css.list, side === 'top' && css.sideTop, align === 'end' && css.alignEnd)} role="menu">
          {items.map(entry => {
            if (isSeparator(entry)) {
              return <div key={entry.id} className={css.separator} role="separator" />
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
                  className={clsx(css.item, entry.id === selectedId && css.selected)}
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
      )}
    </span>
  )
}
