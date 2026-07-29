import { useState } from 'react'
import type { PermissionSelect as PermissionSelectValue } from '@deepseek-ai/dsh-permission/client'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './PermissionSelect.module.css'

/**
 * Display transform: kebab-case machine names render as title-case labels
 * (`workspace-write` → `Workspace Write`); non-kebab host-configured names
 * pass through. Twin of the /permission popup's (client ui-permission) — the
 * two permission surfaces must show the same text.
 */
function displayName(name: string): string {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return name
  return name.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

export interface PermissionSelectProps {
  value: PermissionSelectValue | undefined
  locked: boolean
  command: (line: string) => Promise<boolean>
}

export function PermissionSelect({ value, locked, command }: PermissionSelectProps) {
  const [pick, setPick] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  if (value === undefined) return null

  const currentValue = pick ?? value.currentValue
  const current = value.options.find(option => option.value === currentValue)
  const busy = pick !== null

  const items: MenuEntry[] = value.options
    .filter(o => o.value !== 'custom')
    .map(option => ({ id: option.value, label: displayName(option.name) }))

  const choose = (id: string): void => {
    setOpen(false)
    if (id === value.currentValue) return
    setPick(id)
    void command(`/permission ${id}`)
      .catch(() => false)
      .then(() => { setPick(null) })
  }

  return (
    <Menu
      open={open}
      items={items}
      selectedId={currentValue}
      onSelect={choose}
      onClose={() => { setOpen(false) }}
      side="top"
      anchor={
        <button
          type="button"
          className={css.trigger}
          aria-label={`Access mode, current: ${displayName(current?.name ?? currentValue)}`}
          title={current?.description}
          disabled={locked || busy}
          onClick={() => { setOpen(!open) }}
        >
          <span className={css.triggerLabel}>{displayName(current?.name ?? currentValue)}</span>
          <svg className={css.chevron} viewBox="0 0 12 12" width="12" height="12" aria-hidden>
            <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
        </button>
      }
    />
  )
}
