/**
 * General section component contract: the slot-store state shape, the
 * injected business face, and the composed props type. The component imports
 * only from here; service snapshot shapes are mirrored as plain rows so the
 * presentation layer stays decoupled from the locale/theme packages.
 */
import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { createGeneralSettingsStore } from './store.ts'

/** One selectable locale row projected into the store (id + self-described label). */
export interface LocaleOptionRow {
  /** Locale id (the setLocale argument). */
  id: string
  /** Display name in its own language (中文 / English). */
  label: string
}

/** Theme preference union mirrored from the theme service snapshot. */
export type ThemePreferenceId = 'light' | 'dark' | 'system'

/**
 * Store state: mirrors of the locale/theme service snapshots, written only by
 * the plugin's apply-world change listeners (components have no write path —
 * preference writes go through the injected callbacks to the services, and
 * the resulting change events flow back into this mirror).
 */
export interface GeneralSettingsState {
  /** Active locale id. */
  localeActive: string
  /** Selectable locales in display order. */
  localeOptions: LocaleOptionRow[]
  /** Locale service revision (re-renders translated copy on dictionary/locale changes); -1 until first sync. */
  localeRevision: number
  /** Persisted theme preference (selection state reads this, never the resolved active theme). */
  themePreference: ThemePreferenceId
  /** Theme service revision; -1 until first sync. */
  themeRevision: number
}

/**
 * Registrant-private injected share of the General section (assembled in
 * apply): the namespace-bound translate function (stable identity — re-render
 * on locale change comes from the store revision, not from `t`) and the two
 * preference write callbacks.
 */
export interface GeneralSectionInjected {
  /** Translate a `settings.general` dictionary key to the active-locale text. */
  t: (key: string) => string
  /** Switch the active locale (a registered locale id). */
  setLocale: (id: string) => void
  /** Switch the theme preference. */
  setTheme: (id: ThemePreferenceId) => void
}

/** Store handle type for the props share (type-only; the factory stays internal to apply and tests). */
export type GeneralSettingsStoreHandle = ReturnType<typeof createGeneralSettingsStore>

/**
 * Full component props of the General section: the section owner share
 * (empty marker) plus the store share and the injected face. No child slots
 * are declared; menu open state is component-local viewing state.
 */
export type GeneralSectionComponentProps =
  PropsRuntime<'settings.section'> & PropsStore<GeneralSettingsStoreHandle> & GeneralSectionInjected
