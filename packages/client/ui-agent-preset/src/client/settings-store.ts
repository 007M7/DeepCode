/**
 * Agent-preset default-settings controller.
 *
 * Options and the current default both come from one `agentPreset.list` call:
 * the roster already reports which id a session with no explicit choice gets,
 * so the row needs no schema introspection. Writes target the settings
 * namespace's `default` field, which is what the host resolves at creation.
 */

import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** The agent-preset settings namespace on the host wire. */
export const AGENT_PRESET_SETTINGS_NS = 'agent-presets'

/** One selectable preset. */
export interface AgentPresetOption {
  /** Preset id, written to Settings and shown as the label. */
  id: string
  /** Whether the preset ships with the deployment or was authored locally. */
  trust: 'system' | 'user'
}

/** Agent-preset settings-row snapshot. */
export interface AgentPresetSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'saving' | 'unavailable' | 'error'
  error: string | null
  /**
   * Whether this browser may persist the choice at all. `settings.describe` is
   * loopback-only and reports a read-only provider as `writable: false`; the
   * row then shows the current default and disables the control rather than
   * offering a write the gateway will refuse.
   */
  writable: boolean
  currentValue: string
  options: readonly AgentPresetOption[]
}

const INITIAL: AgentPresetSettingsState = {
  status: 'idle',
  error: null,
  // Assumed until `load()` asks; a row that has not read yet renders nothing
  // interactive anyway (status 'idle').
  writable: true,
  currentValue: '',
  options: [],
}

/** Reads the roster and persists the chosen default. */
export class AgentPresetSettingsController {
  /** Row snapshot the renderer subscribes to. */
  readonly store: SnapshotStore<AgentPresetSettingsState> = createSnapshotStore(INITIAL)

  constructor(private readonly api: IApiClient) {}

  private set(patch: Partial<AgentPresetSettingsState>): void {
    this.store.set({ ...this.store.getSnapshot(), ...patch })
  }

  /**
   * Load the roster. An empty roster means the deployment composes no
   * presets, which is a valid deployment rather than a failure — the row
   * reports `unavailable` and renders nothing.
   * @returns once the snapshot reflects the host.
   */
  async load(): Promise<void> {
    if (this.store.getSnapshot().status === 'loading') return
    this.set({ status: 'loading', error: null })
    try {
      const response = await this.api.agentPresets.list({})
      if (!response.result.ok) {
        this.set({ status: 'error', error: response.result.error.message })
        return
      }
      const presets = response.result.value.presets
      const [first] = presets
      if (first === undefined) {
        this.set({ status: 'unavailable', options: [], currentValue: '' })
        return
      }
      // The roster says what may be chosen; `settings.describe` says whether
      // this browser may write the choice down. A non-loopback browser reaches
      // neither method, so a refused describe leaves the row read-only rather
      // than offering a control whose write answers `settings-not-exposed`.
      const described = await this.api.settings.describe({})
      this.set({
        status: 'ready',
        error: null,
        writable: described.result.ok && described.result.value.writable,
        options: presets.map(preset => ({ id: preset.id, trust: preset.trust })),
        // A roster can mark nothing default: settings can name a preset that
        // was since deleted, and the picker still has to show something.
        currentValue: presets.find(preset => preset.isDefault)?.id ?? first.id,
      })
    } catch (error) {
      this.set({ status: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Persist one preset as the default for sessions created later. Running
   * sessions keep the composition they were created with, so this never
   * disturbs work in progress.
   * @param id - the preset to make default.
   * @returns once the write settled and the roster was re-read.
   */
  async select(id: string): Promise<void> {
    const before = this.store.getSnapshot()
    if (before.status === 'saving' || id === before.currentValue) return
    this.set({ status: 'saving', error: null, currentValue: id })
    try {
      const response = await this.api.settings.update({
        ns: AGENT_PRESET_SETTINGS_NS,
        patch: { default: id },
      })
      if (!response.result.ok) {
        this.set({ status: 'ready', currentValue: before.currentValue, error: response.result.error.message })
        return
      }
      // Re-read rather than trust the patch: the host resolves the default
      // through the same roster the row displays.
      await this.load()
    } catch (error) {
      this.set({
        status: 'ready',
        currentValue: before.currentValue,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
