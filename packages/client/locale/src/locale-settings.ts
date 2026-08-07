/** Locale preference stored in the Host user-settings document. */

/** Settings namespace owned by the locale plugin. */
export const LOCALE_SETTINGS_NAMESPACE = 'locale'

/** Field carrying an explicit locale selection; absence delegates to the browser. */
export const LOCALE_PREFERENCE_FIELD = 'preference'

/** Locale identifiers shipped by the browser client. */
export const LOCALE_IDS = ['zh', 'en'] as const

/** Shipped locale identifier. */
export type LocaleId = typeof LOCALE_IDS[number]

/**
 * Narrow one settings-wire value to a shipped locale.
 * @param value - value crossing the settings boundary.
 * @returns whether the value names a shipped locale.
 */
export function isLocaleId(value: unknown): value is LocaleId {
  return LOCALE_IDS.some(locale => locale === value)
}
