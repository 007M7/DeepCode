/**
 * General section slot store: locale/theme snapshot mirrors. The plugin
 * creates the handle at apply time (identity follows the fiber) and its
 * change listeners are the only writers; components read via props.useStore.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { GeneralSettingsState, LocaleOptionRow, ThemePreferenceId } from './contract.ts'

/** Declared action shape used to give the exported factory a stable return type. */
type GeneralSettingsActions = {
  syncLocale: (draft: GeneralSettingsState, active: string, options: LocaleOptionRow[], revision: number) => void
  syncTheme: (draft: GeneralSettingsState, preference: ThemePreferenceId, revision: number) => void
}

/**
 * Declares the General section state and write surface. Revisions start at -1
 * so the apply-time initial sync (revision 0) always lands as a change.
 * @returns the store handle.
 */
export function createGeneralSettingsStore(): EngineStoreHandle<GeneralSettingsState, GeneralSettingsActions> {
  return defineStore({
    init: (): GeneralSettingsState => ({
      localeActive: '',
      localeOptions: [],
      localeRevision: -1,
      themePreference: 'system',
      themeRevision: -1,
    }),
    actions: {
      syncLocale: (d, active: string, options: LocaleOptionRow[], revision: number) => {
        if (revision <= d.localeRevision) return
        d.localeActive = active
        d.localeOptions = options
        d.localeRevision = revision
      },
      syncTheme: (d, preference: ThemePreferenceId, revision: number) => {
        if (revision <= d.themeRevision) return
        d.themePreference = preference
        d.themeRevision = revision
      },
    },
  })
}
