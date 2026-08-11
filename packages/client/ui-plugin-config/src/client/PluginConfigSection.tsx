/**
 * Plugin configuration section: the shell around the per-plugin cards. It
 * enumerates nothing itself — cards arrive through the `settings.plugin.item`
 * slot it declares, so a plugin that ships a browser half owns its own card
 * and this section never learns what a namespace means.
 */

import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './slot-contract.ts'
import type { PluginConfigKey } from './locales.ts'
import css from './PluginConfigSection.module.css'

/** Registration-side business face for the section. */
export interface PluginConfigSectionInjected {
  /** How many cards the slot ledger currently holds; zero renders the empty line. */
  cardCount: number
}

/** Props the renderer binds for the section. */
export type PluginConfigSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.pluginConfig'>
  & PropsRenderSlots<'settings.plugin.item'>
  & InjectFace<PluginConfigSectionInjected>

/**
 * Render the plugin configuration section.
 * @param props - runtime slot rendering, locale copy, and the card count.
 * @returns the section.
 */
export function PluginConfigSection(props: PluginConfigSectionProps) {
  const { t, renderSlot, cardCount } = props
  return (
    <div className={css.section}>
      <h2 className={css.heading}>{t('title')}</h2>
      <p className={css.intro}>{t('intro')}</p>
      {cardCount === 0
        ? <p className={css.empty}>{t('empty')}</p>
        : <ul className={css.cards}>{renderSlot('settings.plugin.item', {})}</ul>}
    </div>
  )
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Plugin configuration section and card copy. */
    'settings.pluginConfig': PluginConfigKey
  }
}
