// PermissionSelect: the composer bottom-row permission chip (draft
// start.jpeg's `Read-only ∨` control). Options and the current value load on
// mount from the injected permissions() callback; empty options
// (permission-less host composition) render nothing. The visible chip is
// presentation only — an invisible native select stretched over it owns the
// menu and interaction. A switch disables the control until the host
// confirms, then adopts the confirmed value (`custom` is shown as the current
// value but never offered as a target — the host already omits it from
// switchable options; a stale-select failure restores the previous value).

import { useEffect, useRef, useState } from 'react'
import type { PermissionSelect as PermissionSelectData } from '@deepseek-ai/dsh-client-runtime/client'
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
  /** Read the select material; null hides the control. */
  permissions: () => Promise<PermissionSelectData | null>
  /** Switch the preset; resolves the confirmed value, or null on failure. */
  setPermission: (value: string) => Promise<string | null>
}

export function PermissionSelect({ permissions, setPermission }: PermissionSelectProps) {
  const [data, setData] = useState<PermissionSelectData | null>(null)
  const [switching, setSwitching] = useState(false)
  // Unmount guard: the load/switch promises outlive a session switch's remount.
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    void permissions().then((loaded) => {
      if (aliveRef.current) setData(loaded)
    })
    return () => {
      aliveRef.current = false
    }
  }, [permissions])

  if (data === null) return null

  const onChange = (value: string): void => {
    if (value === data.currentValue) return
    setSwitching(true)
    const previous = data
    setData({ ...data, currentValue: value })
    void setPermission(value).then((confirmed) => {
      if (!aliveRef.current) return
      setSwitching(false)
      if (confirmed === null) setData(previous)
      else setData({ ...previous, currentValue: confirmed })
    })
  }

  const current = data.options.find(option => option.value === data.currentValue)

  return (
    <label className={css.root} title={current?.description}>
      <span className={css.chip}>
        {displayName(current?.name ?? data.currentValue)}
        <svg className={css.chevron} viewBox="0 0 12 12" width="12" height="12" aria-hidden>
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
      </span>
      <select
        className={css.select}
        aria-label="权限策略"
        value={data.currentValue}
        disabled={switching}
        onChange={(e) => { onChange(e.target.value) }}
      >
        {data.options.map(option => (
          <option key={option.value} value={option.value} disabled={option.value === 'custom'}>
            {displayName(option.name)}
          </option>
        ))}
      </select>
    </label>
  )
}
