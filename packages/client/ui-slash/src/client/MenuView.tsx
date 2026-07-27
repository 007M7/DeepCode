/**
 * Trigger candidate menu: renders the SlashService menu store into the
 * conversation.input.overlay anchor. Closed state renders null (the overlay
 * slot stays mounted); groups render in roster order, pending groups as a
 * loading row; pointer picks route back through the service (combobox
 * pattern — focus never leaves the textarea, so rows are mousedown-handled
 * and the highlight is exposed via aria-activedescendant on the listbox).
 */
import { useSyncExternalStore } from 'react'
import clsx from 'clsx'
import css from './MenuView.module.css'
import type { MenuViewInjected } from './slots.ts'

/** DOM id of one option row (the aria-activedescendant target). */
function optionId(source: string, index: number): string {
  return `dsh-slash-option-${source}-${index}`
}

/**
 * Render the candidate menu overlay entry.
 * @param props - injected face: the menu store and the pick route.
 * @returns the dropdown while open; null while closed.
 */
export function MenuView({ menu, onPick }: MenuViewInjected) {
  const state = useSyncExternalStore(
    fn => menu.subscribe(fn),
    () => menu.getSnapshot(),
  )
  if (!state.open) return null
  const { highlight } = state
  return (
    <div
      className={css.menu}
      role="listbox"
      aria-label="Trigger suggestions"
      aria-activedescendant={highlight !== null ? optionId(highlight.source, highlight.index) : undefined}
    >
      {state.groups.map(group => group.status === 'pending'
        ? <div key={group.source} className={css.loading} data-source={group.source}>Loading {group.source}…</div>
        : group.items.map((item, index) => {
          const active = highlight !== null && highlight.source === group.source && highlight.index === index
          return (
            <button
              key={`${group.source}:${item.name}`}
              id={optionId(group.source, index)}
              type="button"
              role="option"
              aria-selected={active}
              className={clsx(css.item, active && css.active)}
              // mousedown, not click: the textarea keeps focus (combobox
              // pattern) — preventing default stops the focus steal, and the
              // pick runs before any blur-driven teardown.
              onMouseDown={(ev) => {
                ev.preventDefault()
                onPick(group.source, index)
              }}
            >
              {item.icon !== undefined && <span className={css.itemIcon} aria-hidden>{item.icon}</span>}
              <span className={css.itemName}>{item.name}</span>
              {item.description !== undefined && <span className={css.itemDescription}>{item.description}</span>}
            </button>
          )
        }))}
    </div>
  )
}
