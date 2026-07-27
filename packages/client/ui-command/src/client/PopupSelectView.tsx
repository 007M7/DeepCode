/**
 * Official popupSelect shell: renders one session's PopupSelectController
 * store into the conversation.input.overlay anchor. Unlike the slash menu
 * (combobox — textarea keeps focus), this shell HOLDS focus while open: the
 * inner search input takes focus, plain typing filters the loaded options
 * locally, Enter/↑↓ drive the filtered highlight, Escape dismisses back to
 * the composer, and ←→ keep the search input's native caret. Any pointer
 * interaction outside the box dismisses (the click's own target takes
 * focus). Closed state renders null; the overlay slot stays mounted.
 */
import { useEffect, useRef } from 'react'
import { useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { IconCheckOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { filterOptions } from './popup.ts'
import type { PopupSelectController } from './popup.ts'
import css from './PopupSelectView.module.css'

/** Injected business face of the popupSelect overlay entry. */
export interface PopupSelectInjected {
  /** The session's shell controller (state store + verbs; the view never touches the open-context type). */
  popup: PopupSelectController
}

/**
 * Render the popupSelect shell overlay entry.
 * @param props - injected face: the session's shell controller.
 * @returns the select card while open; null while closed.
 */
export function PopupSelectView({ popup }: PopupSelectInjected) {
  const state = useSyncExternalStore(
    fn => popup.state.subscribe(fn),
    () => popup.state.getSnapshot(),
  )
  const cardRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // Focus ownership: the search input grabs on open (the design's
  // transient-layer rule), and ANY outside pointer interaction dismisses —
  // capture phase so a click landing anywhere else (textarea included)
  // closes the shell before its own handlers run; that click's target then
  // takes focus naturally, so no focusComposer here.
  useEffect(() => {
    if (!state.open) return
    searchRef.current?.focus()
    const onPointerDown = (ev: PointerEvent): void => {
      if (cardRef.current !== null && ev.target instanceof Node && cardRef.current.contains(ev.target)) return
      popup.dismiss()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => { document.removeEventListener('pointerdown', onPointerDown, true) }
  }, [state.open, popup])

  if (!state.open) return null

  const rows = filterOptions(state.options, state.search)

  const onKeyDown = (ev: React.KeyboardEvent<HTMLDivElement>): void => {
    // ArrowLeft/ArrowRight fall through on purpose: the search input keeps
    // its native caret movement.
    switch (ev.key) {
      case 'ArrowDown':
        ev.preventDefault()
        popup.move(1)
        return
      case 'ArrowUp':
        ev.preventDefault()
        popup.move(-1)
        return
      case 'Enter':
        ev.preventDefault()
        void popup.select(state.active)
        return
      case 'Escape':
        ev.preventDefault()
        popup.dismiss({ focusComposer: true })
        return
      default:
    }
  }

  return (
    <div
      ref={cardRef}
      className={css.card}
      aria-label={`/${String(state.command)} options`}
      onKeyDown={onKeyDown}
    >
      <input
        ref={searchRef}
        className={css.search}
        type="text"
        placeholder="Search…"
        aria-label="Filter options"
        value={state.search}
        readOnly={state.submitting}
        onChange={(ev) => { popup.setSearch(ev.currentTarget.value) }}
      />
      {state.error !== null && (
        <div className={css.error} role="alert">
          <span className={css.errorText}>{state.error}</span>
          {state.status === 'failed' && (
            <button type="button" className={css.retry} onClick={() => { popup.retry() }}>Retry</button>
          )}
        </div>
      )}
      {state.status === 'pending' && <div className={css.status}>Loading options…</div>}
      {state.submitting && <div className={css.status}>Applying…</div>}
      {state.status === 'ready' && rows.length === 0 && <div className={css.status}>No options</div>}
      {state.status === 'ready' && (
        <div role="listbox" aria-label={`/${String(state.command)} matches`}>
          {rows.map((option, index) => (
            <div
              key={option.id}
              role="option"
              aria-selected={index === state.active}
              className={clsx(css.row, index === state.active && css.rowActive)}
              // mousedown would race the document capture listener; the shell
              // owns focus anyway, so a plain click (inside the card → no
              // dismiss) works.
              onClick={() => { void popup.select(index) }}
              onMouseEnter={() => { popup.highlight(index) }}
            >
              <span className={css.label}>{option.label}</span>
              {option.detail !== undefined && <span className={css.detail}>{option.detail}</span>}
              {option.active === true && <span className={css.check}><IconCheckOutline16 /></span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
