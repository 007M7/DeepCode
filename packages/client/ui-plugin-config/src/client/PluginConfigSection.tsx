/** Plugins settings section: localized tabs around feature-owned pages. */

import { useEffect, useId, useState } from 'react'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { PluginConfigKey } from './locales.ts'
import css from './PluginConfigSection.module.css'

/** One tab projected from a `settings.plugins.tab` contribution. */
export interface PluginSettingsTabRow {
  id: string
  order: number
  label: string
}

/** Registration-side business face for the section. */
export interface PluginConfigSectionInjected {
  hooks: {
    /** Ordered, locale-aware projection of the Plugins tab ledger. */
    tabs: HostObservable<readonly PluginSettingsTabRow[]>
  }
}

/** Props the renderer binds for the section. */
export type PluginConfigSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.pluginConfig'>
  & PropsRenderSlots<'settings.plugins.tab'>
  & InjectFace<PluginConfigSectionInjected>

/** Render one Plugins page whose contents arrive from feature-owned tabs. */
export function PluginConfigSection({ t, renderSlot, useTabs }: PluginConfigSectionProps) {
  const tabsId = useId()
  const rows = useTabs(value => value)
  const [activeId, setActiveId] = useState<string>()
  const [visitedIds, setVisitedIds] = useState<ReadonlySet<string>>(() => new Set())
  const active = rows.find(row => row.id === activeId)?.id ?? rows[0]?.id

  // A tab mounts only when first selected, then stays mounted while hidden so
  // local drafts, disclosure state, search, and the inventory snapshot survive
  // switching between the two views.
  useEffect(() => {
    if (active === undefined) return
    setVisitedIds((previous) => {
      if (previous.has(active)) return previous
      return new Set([...previous, active])
    })
  }, [active])

  return (
    <div className={css.section}>
      <h2 className={css.heading}>{t('title')}</h2>
      <p className={css.intro}>{t('intro')}</p>
      {rows.length === 0 ? <p className={css.empty}>{t('empty')}</p> : (
        <>
          <div className={css.tabs} role="tablist" aria-label={t('tabs')}>
            {rows.map((row) => {
              const selected = row.id === active
              return (
                <button
                  key={row.id}
                  id={`${tabsId}-tab-${row.id}`}
                  type="button"
                  role="tab"
                  className={css.tab}
                  aria-selected={selected}
                  aria-controls={`${tabsId}-panel-${row.id}`}
                  data-active={selected ? 'true' : undefined}
                  onClick={() => { setActiveId(row.id) }}
                >
                  {row.label}
                </button>
              )
            })}
          </div>
          {rows
            .filter(row => row.id === active || visitedIds.has(row.id))
            .map((row) => {
              const selected = row.id === active
              return (
                <div
                  key={row.id}
                  id={`${tabsId}-panel-${row.id}`}
                  className={css.panel}
                  role="tabpanel"
                  aria-labelledby={`${tabsId}-tab-${row.id}`}
                  hidden={!selected}
                >
                  {renderSlot('settings.plugins.tab', {}, { only: row.id })}
                </div>
              )
            })}
        </>
      )}
    </div>
  )
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Plugins section, configurable-tab, and card copy. */
    'settings.pluginConfig': PluginConfigKey
  }
}
