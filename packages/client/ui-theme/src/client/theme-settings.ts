/** Host-backed persistence controller for the browser theme preference. */

import type {
  IApiClient, SettingsNamespaceView,
} from '@deepseek-ai/dsh-client-connection/client'
import {
  THEME_PREFERENCE_FIELD, THEME_SETTINGS_NAMESPACE, isThemePreference,
  type ThemePreference,
} from '../theme-settings.ts'

/** Preference target implemented by {@link ThemeService}. */
export interface ThemePreferenceTarget {
  /**
   * Apply a Host value without writing it back.
   * @param preference - validated durable preference.
   */
  syncPreference(preference: ThemePreference): void
}

function preferenceOf(view: SettingsNamespaceView): ThemePreference | undefined {
  if (typeof view.value !== 'object' || view.value === null) return undefined
  const preference = (view.value as Record<string, unknown>)[THEME_PREFERENCE_FIELD]
  return isThemePreference(preference) ? preference : undefined
}

/** Coordinates startup reads, ordered writes, and pushed invalidations. */
export class ThemeSettingsController {
  private generation = 0
  private writeTail: Promise<void> = Promise.resolve()

  /**
   * @param api - settings wire face.
   * @param target - live theme service receiving durable values.
   * @param persistence - remote browsers stay process-local because the settings API is loopback-only.
   */
  constructor(
    private readonly api: Pick<IApiClient, 'settings'>,
    private readonly target: ThemePreferenceTarget,
    private readonly persistence: 'host' | 'memory' = 'host',
  ) {}

  /**
   * Load the durable preference after earlier writes settle; the latest operation wins.
   * @returns nothing; an unavailable or invalid descriptor leaves the last good value active.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    if (this.persistence === 'memory') return
    await this.writeTail
    if (generation !== this.generation) return
    let response: Awaited<ReturnType<Pick<IApiClient, 'settings'>['settings']['describe']>>
    try {
      response = await this.api.settings.describe({})
    } catch (_settingsReadFailure) {
      // A transport failure leaves the last good in-process theme active. A
      // connection/reset or settings/changed notification retries the read.
      return
    }
    if (!response.result.ok || generation !== this.generation) return
    const view = response.result.value.namespaces.find(
      candidate => candidate.ns === THEME_SETTINGS_NAMESPACE,
    )
    if (view === undefined) return
    const preference = preferenceOf(view)
    if (preference !== undefined) this.target.syncPreference(preference)
  }

  /**
   * Persist one user selection. Writes are serialized so rapid picks land in
   * gesture order; a rejected latest write reloads the durable value.
   * @param preference - selected built-in preference.
   * @returns nothing after the write or recovery read settles.
   */
  async persist(preference: ThemePreference): Promise<void> {
    const generation = ++this.generation
    if (this.persistence === 'memory') return
    const write = this.writeTail.then(async () => {
      const response = await this.api.settings.mutate({
        ns: THEME_SETTINGS_NAMESPACE,
        ops: [{ op: 'set', path: [THEME_PREFERENCE_FIELD], value: preference }],
      })
      if (!response.result.ok) throw new Error(response.result.error.message)
      if (generation === this.generation) {
        const accepted = preferenceOf(response.result.value)
        if (accepted !== undefined) this.target.syncPreference(accepted)
      }
    })
    this.writeTail = write.catch(() => {})
    try {
      await write
    } catch {
      if (generation === this.generation) await this.load()
    }
  }

  /** Prevent in-flight reads and writes from publishing after plugin disposal. */
  dispose(): void {
    this.generation += 1
  }
}
