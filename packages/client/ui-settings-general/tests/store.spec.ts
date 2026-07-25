/** General settings store: snapshot-mirror actions and the revision guard. */
import { describe, expect, it } from 'vitest'
import { createGeneralSettingsStore } from '../src/client/store.ts'

const LOCALES = [{ id: 'zh', label: '中文' }, { id: 'en', label: 'English' }]

describe('createGeneralSettingsStore', () => {
  it('init shape: empty mirrors with revisions at -1', () => {
    const store = createGeneralSettingsStore().create()
    expect(store.getSnapshot()).toEqual({
      localeActive: '',
      localeOptions: [],
      localeRevision: -1,
      themePreference: 'system',
      themeRevision: -1,
    })
  })

  it('syncLocale mirrors the snapshot and advances the revision', () => {
    const store = createGeneralSettingsStore().create()
    store.actions.syncLocale('zh', LOCALES, 0)
    expect(store.getSnapshot().localeActive).toBe('zh')
    expect(store.getSnapshot().localeOptions).toEqual(LOCALES)
    expect(store.getSnapshot().localeRevision).toBe(0)

    store.actions.syncLocale('en', LOCALES, 1)
    expect(store.getSnapshot().localeActive).toBe('en')
    expect(store.getSnapshot().localeRevision).toBe(1)
  })

  it('syncLocale revision guard drops stale and duplicate writes', () => {
    const store = createGeneralSettingsStore().create()
    store.actions.syncLocale('en', LOCALES, 5)
    // Stale (lower) and duplicate (equal) revisions leave the mirror intact.
    store.actions.syncLocale('zh', LOCALES, 4)
    store.actions.syncLocale('zh', LOCALES, 5)
    expect(store.getSnapshot().localeActive).toBe('en')
    expect(store.getSnapshot().localeRevision).toBe(5)
  })

  it('syncTheme mirrors the preference and guards its revision independently', () => {
    const store = createGeneralSettingsStore().create()
    store.actions.syncTheme('dark', 0)
    expect(store.getSnapshot().themePreference).toBe('dark')
    expect(store.getSnapshot().themeRevision).toBe(0)

    store.actions.syncTheme('light', 2)
    expect(store.getSnapshot().themePreference).toBe('light')

    // Stale theme write is dropped; the locale revision axis is untouched.
    store.actions.syncTheme('system', 1)
    expect(store.getSnapshot().themePreference).toBe('light')
    expect(store.getSnapshot().themeRevision).toBe(2)
    expect(store.getSnapshot().localeRevision).toBe(-1)
  })
})
