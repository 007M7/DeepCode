/** Durable welcome-notice state over the Host settings document. */

import type { IApiClient, SettingsNamespaceView } from '@deepseek-ai/dsh-client-connection/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  WELCOME_NOTICE_ACK_FIELD, WELCOME_NOTICE_SETTINGS_NAMESPACE, WELCOME_NOTICE_VERSION,
} from '../onboarding-copy.ts'

/** State rendered by the welcome step. */
export interface WelcomeNoticeState {
  status: 'idle' | 'loading' | 'ready' | 'saving' | 'error'
  acknowledged: boolean
  error: string | null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function acknowledgementOf(view: SettingsNamespaceView): string | undefined {
  if (typeof view.value !== 'object' || view.value === null) return undefined
  const value = (view.value as Record<string, unknown>)[WELCOME_NOTICE_ACK_FIELD]
  return typeof value === 'string' ? value : undefined
}

/** Coordinates welcome acknowledgement reads and the sole durable write. */
export class WelcomeNoticeStore {
  /** uSES-safe state source shared by the registered welcome step. */
  readonly store: SnapshotStore<WelcomeNoticeState> = createSnapshotStore({
    status: 'idle', acknowledged: false, error: null,
  })

  private generation = 0

  /** @param api - settings wire face used for durable reads and writes. */
  constructor(private readonly api: Pick<IApiClient, 'settings'>) {}

  /** Load the current acknowledgement from the Host settings document. */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((state) => { state.status = 'loading'; state.error = null })
    try {
      const response = await this.api.settings.describe({})
      if (!response.result.ok) throw new Error(response.result.error.message)
      const view = response.result.value.namespaces.find(
        candidate => candidate.ns === WELCOME_NOTICE_SETTINGS_NAMESPACE,
      )
      if (view === undefined) throw new Error('welcome acknowledgement settings are unavailable')
      if (generation !== this.generation) return
      this.store.update((state) => {
        state.status = 'ready'
        state.acknowledged = acknowledgementOf(view) === WELCOME_NOTICE_VERSION
        state.error = null
      })
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((state) => {
        state.status = 'error'
        state.acknowledged = false
        state.error = messageOf(error)
      })
    }
  }

  /**
   * Persist this copy version. The path mutation is idempotent across tabs and
   * preserves every sibling setting; failure leaves the step unacknowledged.
   * @returns true only when the Host committed the acknowledgement.
   */
  async acknowledge(): Promise<boolean> {
    const generation = ++this.generation
    this.store.update((state) => { state.status = 'saving'; state.error = null })
    try {
      const response = await this.api.settings.mutate({
        ns: WELCOME_NOTICE_SETTINGS_NAMESPACE,
        ops: [{ op: 'set', path: [WELCOME_NOTICE_ACK_FIELD], value: WELCOME_NOTICE_VERSION }],
      })
      if (!response.result.ok) throw new Error(response.result.error.message)
      if (generation === this.generation) {
        this.store.update((state) => {
          state.status = 'ready'
          state.acknowledged = true
          state.error = null
        })
      }
      return true
    } catch (error) {
      if (generation === this.generation) {
        this.store.update((state) => {
          state.status = 'error'
          state.acknowledged = false
          state.error = messageOf(error)
        })
      }
      return false
    }
  }
}

/**
 * Refresh only after the welcome step has begun reading durable state.
 * @param controller - welcome state owner whose current status decides whether to load.
 */
export function refreshWelcomeIfLoaded(controller: WelcomeNoticeStore): void {
  if (controller.store.getSnapshot().status === 'idle') return
  void controller.load()
}
