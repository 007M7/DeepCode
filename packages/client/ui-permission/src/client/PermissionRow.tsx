/**
 * Permission preference row: the default preset for subsequently created
 * sessions. Current-session switches remain on the composer `/permission`
 * control.
 */

import { useEffect, useState } from 'react'
import type {
  PropsLocale, PropsRuntime, SnapshotSelectorHook,
} from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  PermissionSettingsController, PermissionSettingsState,
} from './settings-store.ts'
import type { PermissionSettingsKey } from './locales.ts'
import css from './PermissionRow.module.css'

/** Injected controller and hook for the host-backed preference. */
export interface PermissionRowInjected {
  /** Permission settings controller. */
  controller: PermissionSettingsController
  /** Selector hook bound to the controller snapshot. */
  useSnapshot: SnapshotSelectorHook<PermissionSettingsState>
}

/** Full component props. */
export type PermissionRowProps =
  PropsRuntime<'settings.general.item'> & PropsLocale<'settings.permission'> & PermissionRowInjected

/**
 * Render the new-session Permission default selector.
 * @param props - composed slot props.
 * @returns the row, or null when the host does not expose permission settings.
 */
export function PermissionRow({ controller, useSnapshot, t }: PermissionRowProps) {
  const state = useSnapshot(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    void controller.load()
  }, [controller])
  if (state.status === 'unavailable') return null
  const selected = state.options.find(option => option.id === state.currentValue)
  const busy = state.status === 'loading' || state.status === 'saving'
  const label = selected?.label
    ?? (busy ? t('loading') : t('unavailable'))
  const description: string = state.error ?? t('description')

  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('title')}</div>
        <div className={css.desc} role={state.error === null ? undefined : 'alert'}>{description}</div>
      </div>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={state.options.map(option => ({ id: option.id, label: option.label }))}
        selectedId={state.currentValue}
        onSelect={(id) => {
          setOpen(false)
          void controller.select(id)
        }}
        align="end"
        portal
        anchor={(
          <button
            type="button"
            className={css.selector}
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={busy || !state.writable || state.options.length === 0}
            onClick={() => { setOpen(value => !value) }}
          >
            {label}
            <IconChevronDownOutline14 className={css.chevron} />
          </button>
        )}
      />
    </div>
  )
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Permission row copy. */
    'settings.permission': PermissionSettingsKey
  }
}
