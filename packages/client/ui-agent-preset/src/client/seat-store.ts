/**
 * Composer-seat controller: what one session may switch to, and whether it
 * still may.
 *
 * A session's composition is fixed once its conversation starts, so the seat
 * reads the session's own `blank` bit rather than a local guess — the host
 * enforces the same rule and answers `agent-preset-locked` to a late attempt.
 */

import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import {
  createSnapshotStore, type SessionId, type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { AgentPresetOption } from './settings-store.ts'

/** Composer-seat snapshot for one session. */
export interface AgentPresetSeatState {
  /** Presets the deployment supplies; empty means the seat renders nothing. */
  options: readonly AgentPresetOption[]
  /** The preset this session runs, empty until the roster and summary load. */
  current: string
  /** False once the conversation has started — the switch is gone for good. */
  switchable: boolean
  /** A rejected switch's message, cleared by the next attempt. */
  error: string | null
  busy: boolean
}

const INITIAL: AgentPresetSeatState = {
  options: [], current: '', switchable: false, error: null, busy: false,
}

/** Reads what one session may switch to and performs the switch. */
export class AgentPresetSeatController {
  /** Seat snapshot the renderer subscribes to. */
  readonly store: SnapshotStore<AgentPresetSeatState> = createSnapshotStore(INITIAL)

  constructor(
    private readonly api: IApiClient,
    private readonly sessionId: SessionId,
    /** Reads this session's blank bit and recorded preset from the session list. */
    private readonly summary: () => { blank: boolean; agentPreset?: string } | undefined,
  ) {}

  private set(patch: Partial<AgentPresetSeatState>): void {
    this.store.set({ ...this.store.getSnapshot(), ...patch })
  }

  /**
   * Load the roster and reconcile with this session's own state.
   * @returns once the snapshot reflects the host.
   */
  async load(): Promise<void> {
    const summary = this.summary()
    try {
      const response = await this.api.agentPresets.list({})
      if (!response.result.ok) {
        this.set({ error: response.result.error.message })
        return
      }
      const presets = response.result.value.presets
      this.set({
        options: presets.map(preset => ({ id: preset.id, trust: preset.trust })),
        // The session's recorded preset wins over the roster default: a
        // resumed session runs what it was created with, not what the
        // deployment now prefers.
        current: summary?.agentPreset ?? presets.find(preset => preset.isDefault)?.id ?? '',
        switchable: summary?.blank ?? false,
        error: null,
      })
    } catch (error) {
      this.set({ error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Switch this session to another preset.
   * @param id - the preset to compose the session's agent from.
   * @returns once the switch settled; a rejection leaves the previous value.
   */
  async select(id: string): Promise<void> {
    const before = this.store.getSnapshot()
    if (before.busy || id === before.current || !before.switchable) return
    this.set({ busy: true, error: null, current: id })
    try {
      const response = await this.api.agentPresets.select({ sessionId: this.sessionId, agentPreset: id })
      if (!response.result.ok) {
        this.set({ busy: false, current: before.current, error: response.result.error.message })
        return
      }
      this.set({ busy: false, current: response.result.value.agentPreset })
    } catch (error) {
      this.set({
        busy: false,
        current: before.current,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
