// PermissionSelect: the composer bottom-row permission chip (draft
// start.jpeg's `Read-only ∨` control), the Access seat's wired occupant.
// Options and the current value read from the host-computed `permissions`
// projection (baseline block + push frames — no fetch, no mount timing);
// key absence (a permission-less composition, or a Draft with no host
// session yet) renders nothing. The visible chip is presentation only — an
// invisible native select stretched over it owns the menu and interaction.
// A switch submits the `/permission <preset>` command line (the one write
// path); the control shows the picked value optimistically and disables
// until the admission result, then re-follows the projection — the pushed
// frame confirms the switch, and a failed/unmatched submit falls back to
// the still-authoritative projection value (`custom` is shown as the
// current value but never offered as a target — the host omits it from
// switchable options).

import { useState } from 'react'
import type { PermissionSelect as PermissionSelectValue } from '@deepseek-ai/dsh-permission/client'
import css from './PermissionSelect.module.css'

/**
 * Display transform: kebab-case machine names render as title-case labels
 * (`workspace-write` → `Workspace Write`). Presentation-only — the wire
 * vocabulary and the host's advertised names are untouched; a host-configured
 * name that is not kebab-case (contains spaces or uppercase) passes through.
 */
function displayName(name: string): string {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return name
  return name.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

export interface PermissionSelectProps {
  /** The host-computed select, or undefined while the capability is absent. */
  value: PermissionSelectValue | undefined
  /** Session-removed lock (the bar's chrome disable state). */
  locked: boolean
  /** Submit one slash-command line; resolves admission (false = rejected/unmatched). */
  command: (line: string) => Promise<boolean>
}

export function PermissionSelect({ value, locked, command }: PermissionSelectProps) {
  // Optimistic pick, shown while the admission round-trip runs; null follows
  // the projection (the pushed frame lands the confirmed value there).
  const [pick, setPick] = useState<string | null>(null)
  if (value === undefined) return null

  const currentValue = pick ?? value.currentValue
  const current = value.options.find(option => option.value === currentValue)

  const onChange = (next: string): void => {
    if (next === value.currentValue) return
    setPick(next)
    void command(`/permission ${next}`)
      .catch(() => false)
      .then(() => { setPick(null) })
  }

  return (
    <label className={css.root} title={current?.description}>
      <span className={css.chip}>
        {displayName(current?.name ?? currentValue)}
        <svg className={css.chevron} viewBox="0 0 12 12" width="12" height="12" aria-hidden>
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
      </span>
      <select
        className={css.select}
        aria-label="Access mode"
        value={currentValue}
        disabled={locked || pick !== null}
        onChange={(e) => { onChange(e.target.value) }}
      >
        {value.options.map(option => (
          <option key={option.value} value={option.value} disabled={option.value === 'custom'}>
            {displayName(option.name)}
          </option>
        ))}
      </select>
    </label>
  )
}
