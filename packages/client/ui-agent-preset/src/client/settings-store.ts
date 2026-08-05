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

/**
 * Human text for a rejected wire call. A transport failure rejects with an
 * Error; a host or a runtime can reject with anything, and the surface still
 * has to say something.
 * @param error - the rejection value.
 * @returns the message to show.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Persist one preset as the default for sessions created later.
 *
 * The default is a settings field rather than a preset property, so both the
 * General row and the management section write it here — one home for which
 * namespace and field the host resolves at session creation.
 * @param api - the settings wire face.
 * @param id - the preset to make default.
 * @returns the failure message, or undefined once the write landed.
 */
export async function writeDefaultPreset(
  api: Pick<IApiClient, 'settings'>,
  id: string,
): Promise<string | undefined> {
  let response
  try {
    response = await api.settings.update({ ns: AGENT_PRESET_SETTINGS_NS, patch: { default: id } })
  } catch (error) {
    // The transport rejected rather than answering; the caller must be able to
    // say so instead of the row silently snapping back.
    return messageOf(error)
  }
  return response.result.ok ? undefined : response.result.error.message
}

/** One selectable preset. */
export interface AgentPresetOption {
  /** Preset id, written to Settings and the label's fallback. */
  id: string
  /** Whether the preset ships with the deployment or was authored locally. */
  trust: 'system' | 'user'
  /** Display name the preset published, absent when it published none. */
  name?: string
  /** One sentence on what the preset is for. */
  description?: string
}

/** Agent-preset settings-row snapshot. */
export interface AgentPresetSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'saving' | 'unavailable' | 'error'
  error: string | null
  writable: boolean
  currentValue: string
  options: readonly AgentPresetOption[]
}

const INITIAL: AgentPresetSettingsState = {
  status: 'idle',
  error: null,
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
      this.set({
        status: 'ready',
        error: null,
        options: presets.map(preset => ({
          id: preset.id,
          trust: preset.trust,
          ...preset.name === undefined ? {} : { name: preset.name },
          ...preset.description === undefined ? {} : { description: preset.description },
        })),
        // A roster can mark nothing default: settings can name a preset that
        // was since deleted, and the picker still has to show something.
        currentValue: presets.find(preset => preset.isDefault)?.id ?? first.id,
      })
    } catch (error) {
      this.set({ status: 'error', error: messageOf(error) })
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
    const failure = await writeDefaultPreset(this.api, id)
    if (failure !== undefined) {
      this.set({ status: 'ready', currentValue: before.currentValue, error: failure })
      return
    }
    // Re-read rather than trust the patch: the host resolves the default
    // through the same roster the row displays.
    await this.load()
  }
}
