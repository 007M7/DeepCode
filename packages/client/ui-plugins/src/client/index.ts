/** Read-only Host plugin inventory registered into Web Settings. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { PluginSettingsSection, type PluginSettingsSectionInjected } from './PluginSettingsSection.tsx'
import { en, zh, type PluginsKey } from './locales.ts'

export type { PluginSettingsSectionInjected, PluginSettingsSectionProps } from './PluginSettingsSection.tsx'
export type { PluginsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Read-only Host plugin inventory copy. */
    'settings.plugins': PluginsKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.plugins'

/** Services required by the Settings registration and generated Remote face. */
export const inject = ['slots', 'locale', 'remote', 'remote.pluginInventory']

/** Register the lazy plugin inventory page below Models in Settings. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-plugins: dictionaries')

  const t = ctx.locale.bind(NS)
  const list: PluginSettingsSectionInjected['list'] = async () => {
    const result = await ctx.remote.pluginInventory.list()
    if (!result.ok) {
      throw new Error(`pluginInventory.list failed: ${result.error.code}: ${result.error.message}`)
    }
    return result.value
  }
  const injected = (): PluginSettingsSectionInjected => ({ list })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'plugin-inventory',
    order: 15,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, PluginSettingsSection))
}
