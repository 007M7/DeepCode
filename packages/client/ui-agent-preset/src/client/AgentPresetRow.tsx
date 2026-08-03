/**
 * Agent-preset preference row: the preset new sessions are composed from.
 * A running session keeps the composition it began with, so this row never
 * disturbs work in progress.
 */

import { useEffect, useState } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentPresetSettingsState } from './settings-store.ts'
import type { AgentPresetSettingsKey } from './locales.ts'
import css from './AgentPresetRow.module.css'

/** Registration-side business face for the host-backed preference. */
export interface AgentPresetRowInjected {
  hooks: {
    /** Agent-preset settings snapshot bound by the renderer as useAgentPreset. */
    agentPreset: SnapshotStore<AgentPresetSettingsState>
  }
  /** Load the roster when the row first renders. */
  load: () => Promise<void>
  /** Persist one preset as the default for later sessions. */
  select: (id: string) => Promise<void>
}

/** Full component props. */
export type AgentPresetRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'settings.agentPreset'>
  & InjectFace<AgentPresetRowInjected>

/**
 * Render the new-session agent-preset selector.
 * @param props - composed slot props.
 * @returns the row, or null when the deployment composes no presets.
 */
export function AgentPresetRow({ load, select, useAgentPreset, t }: AgentPresetRowProps) {
  const state = useAgentPreset(snapshot => snapshot)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (state.writable && state.status !== 'unavailable') return
    setOpen(false)
  }, [state.status, state.writable])

  // A deployment that composes no presets has nothing to choose between, and
  // every session shares the host composition — the row simply does not exist.
  if (state.status === 'unavailable') return null
  const busy = state.status === 'loading' || state.status === 'saving'
  const label = state.currentValue === '' ? t('loading') : state.currentValue
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
        // A locally authored preset is exactly as privileged as the plugins it
        // names, so the list says which rows are local rather than presenting
        // every preset as shipped and vetted.
        items={state.options.map(option => ({
          id: option.id,
          label: option.trust === 'user' ? `${option.id} · ${t('userTrust')}` : option.id,
        }))}
        selectedId={state.currentValue}
        onSelect={(id) => {
          setOpen(false)
          void select(id)
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
    /** Agent-preset row copy. */
    'settings.agentPreset': AgentPresetSettingsKey
  }
}
