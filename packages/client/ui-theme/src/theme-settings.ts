/** Theme preferences stored in the Host user-settings document. */

/** Settings namespace owned by the theme plugin. */
export const THEME_SETTINGS_NAMESPACE = 'ui-theme'

/** Field carrying the selected built-in theme preference. */
export const THEME_PREFERENCE_FIELD = 'preference'

/** Theme preference persisted by the product Appearance row. */
export type ThemePreference = 'light' | 'dark' | 'system'

/** Default preference when the user-settings document has no override. */
export const DEFAULT_PREFERENCE: ThemePreference = 'system'

/**
 * Narrow one wire or registry value to a persistable preference.
 * @param value - value crossing the settings or registry boundary.
 * @returns whether the value is a built-in preference.
 */
export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system'
}
