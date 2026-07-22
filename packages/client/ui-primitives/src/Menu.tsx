// Menu: minimal controlled dropdown (group-by pickers, project selectors).
// Pure CSS positioning relative to the anchor wrapper — no portal, no popper.
// The owner controls `open`; outside-click closing uses one document listener
// active only while open.

import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { IconCheckOutline16 } from './icons/index.tsx'
import css from './Menu.module.css'

/** One selectable menu row. */
export interface MenuItem {
  id: string
  label: ReactNode
  disabled?: boolean
}

/**
 * Render an anchored dropdown menu.
 * @param props.open - whether the list is showing (owner-controlled).
 * @param props.anchor - the trigger element (rendered in place).
 * @param props.items - selectable rows.
 * @param props.selectedId - row shown as selected.
 * @param props.onSelect - row click callback (not called for disabled rows).
 * @param props.onClose - invoked on outside click or Escape.
 * @param props.align - list alignment against the anchor (default 'start').
 * @returns anchor wrapper with the conditional list.
 */
export function Menu({ open, anchor, items, selectedId, onSelect, onClose, align = 'start', className }: {
  open: boolean
  anchor: ReactNode
  items: readonly MenuItem[]
  selectedId?: string
  onSelect: (id: string) => void
  onClose: () => void
  align?: 'start' | 'end'
  className?: string
}) {
  const rootRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
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
        <div className={clsx(css.list, align === 'end' && css.alignEnd)} role="menu">
          {items.map(item => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={clsx(css.item, item.id === selectedId && css.selected)}
              disabled={item.disabled}
              onClick={() => onSelect(item.id)}
            >
              <span className={css.itemLabel}>{item.label}</span>
              {/* Selection marker is a trailing check (figma .Menu_cell), not a fill. */}
              {item.id === selectedId && <IconCheckOutline16 className={css.check} />}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}
