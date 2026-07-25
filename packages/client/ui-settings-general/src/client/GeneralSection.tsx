/**
 * General settings section: Permission and Tool Call skeleton rows (visual
 * only, no interaction), live Language and Appearance preference rows wired
 * through the injected setLocale/setTheme callbacks and the snapshot-mirror
 * store. Figma: Settings > Content > Options (501:29983).
 */
import { useState } from 'react'
import clsx from 'clsx'
import {
  IconChevronDownOutline14, IconDarkOutline16, IconFollowsystemOutline16, IconLightOutline16,
  Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { GeneralSectionComponentProps, ThemePreferenceId } from './contract.ts'
import css from './GeneralSection.module.css'

/** Appearance cube order and icons (figma 501:30015-30017: Light, Dark, System). */
const THEME_CUBES: readonly { id: ThemePreferenceId; labelKey: string; Icon: typeof IconLightOutline16 }[] = [
  { id: 'light', labelKey: 'appearance.light', Icon: IconLightOutline16 },
  { id: 'dark', labelKey: 'appearance.dark', Icon: IconDarkOutline16 },
  { id: 'system', labelKey: 'appearance.system', Icon: IconFollowsystemOutline16 },
]

/**
 * Render the General section content column.
 * @param props - composed slot props (contract.ts).
 * @returns the section element tree.
 */
export function GeneralSection(props: GeneralSectionComponentProps) {
  const { t, setLocale, setTheme, useStore } = props
  const localeActive = useStore(s => s.localeActive)
  const localeOptions = useStore(s => s.localeOptions)
  const themePreference = useStore(s => s.themePreference)
  const [languageOpen, setLanguageOpen] = useState(false)

  const activeLocaleLabel = localeOptions.find(l => l.id === localeActive)?.label ?? localeActive

  return (
    <div className={css.section}>
      {/* Permission (skeleton): disabled selector pill. */}
      <div className={css.row}>
        <div className={css.rowText}>
          <div className={css.title}>{t('permission.title')}</div>
          <div className={css.desc}>{t('permission.desc')}</div>
        </div>
        <button type="button" className={css.selector} disabled>
          {t('permission.value')}
          <IconChevronDownOutline14 className={css.chevron} />
        </button>
      </div>

      {/* Tool Call (skeleton): schema cube pinned selected, code cube unselected. */}
      <div className={css.group}>
        <div className={css.title}>{t('toolcall.title')}</div>
        <div className={css.cubeRow}>
          <div className={clsx(css.modeCube, css.selected)}>
            <div className={css.title}>{t('toolcall.schema.title')}</div>
            <div className={css.desc}>{t('toolcall.schema.desc')}</div>
          </div>
          <div className={css.modeCube}>
            <div className={css.title}>{t('toolcall.code.title')}</div>
            <div className={css.desc}>{t('toolcall.code.desc')}</div>
          </div>
        </div>
      </div>

      {/* Language: selector pill opens the locale menu. */}
      <div className={css.row}>
        <div className={css.rowText}>
          <div className={css.title}>{t('language.title')}</div>
        </div>
        <Menu
          open={languageOpen}
          onClose={() => { setLanguageOpen(false) }}
          items={localeOptions.map(l => ({ id: l.id, label: l.label }))}
          selectedId={localeActive}
          onSelect={(id) => {
            setLocale(id)
            setLanguageOpen(false)
          }}
          align="end"
          portal
          anchor={(
            <button
              type="button"
              className={css.selector}
              aria-haspopup="menu"
              aria-expanded={languageOpen}
              onClick={() => { setLanguageOpen(v => !v) }}
            >
              {activeLocaleLabel}
              <IconChevronDownOutline14 className={css.chevron} />
            </button>
          )}
        />
      </div>

      {/* Appearance: three preference cubes; selection follows the persisted
        * preference, never the resolved active theme. */}
      <div className={clsx(css.group, css.last)}>
        <div className={css.title}>{t('appearance.title')}</div>
        <div className={css.cubeRow}>
          {THEME_CUBES.map(({ id, labelKey, Icon }) => (
            <button
              key={id}
              type="button"
              className={clsx(css.themeCube, themePreference === id && css.selected)}
              aria-pressed={themePreference === id}
              onClick={() => { setTheme(id) }}
            >
              <Icon />
              {t(labelKey)}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
