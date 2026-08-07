/** Host registration for the browser theme preference. */

import type { Context } from 'cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { THEME_SETTINGS_NAMESPACE, ThemeSettingsSchema } from './theme-settings.ts'

export {
  DEFAULT_PREFERENCE, THEME_PREFERENCE_FIELD, THEME_PREFERENCES, THEME_SETTINGS_NAMESPACE,
  type ThemePreference, type ThemeSettings,
} from './theme-settings.ts'

/**
 * Register the durable theme section when a settings provider exists.
 * @param ctx - Host context whose optional settings service owns the section.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(
      settingsNamespace(THEME_SETTINGS_NAMESPACE),
      ThemeSettingsSchema,
    )
  })
}
