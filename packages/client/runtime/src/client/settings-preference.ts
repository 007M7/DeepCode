/** Host-backed scalar preference synchronization for browser plugins. */

import type { Context } from 'cordis'
import type {
  ConnectionHandle, IApiClient, SettingsNamespaceView,
} from '@deepseek-ai/dsh-client-connection/client'

/** Domain-owned description of one scalar field in a settings namespace. */
export interface SettingsPreferenceSpec<T> {
  /** Settings namespace registered by the owning Host plugin. */
  namespace: string
  /** Scalar field inside that namespace. */
  field: string
  /** Validate a wire value; undefined leaves the current in-process value active. */
  decode(value: unknown): T | undefined
  /** Apply a validated Host value without writing it back. */
  sync(value: T): void
}

type SettingsFace = Pick<IApiClient, 'settings'>

/**
 * Serializes one scalar preference's Host reads and writes. Reads never block
 * plugin activation; writes carry the latest known namespace revision and
 * teardown waits for the operation already crossing the wire.
 */
export class SettingsPreferenceController<T> {
  private tail: Promise<void> = Promise.resolve()
  private readGeneration = 0
  private writeGeneration = 0
  private revision: number | undefined
  private disposed = false

  /**
   * @param api - settings wire face.
   * @param spec - namespace, field validator, and live target.
   * @param persistence - remote browsers remain process-local because settings RPCs are loopback-only.
   */
  constructor(
    private readonly api: SettingsFace,
    private readonly spec: SettingsPreferenceSpec<T>,
    private readonly persistence: 'host' | 'memory' = 'host',
  ) {}

  /**
   * Queue a Host refresh; a newer read or user write suppresses stale publication.
   * @returns settlement after the queued read completes or is skipped.
   */
  load(): Promise<void> {
    const generation = ++this.readGeneration
    return this.enqueue(() => this.read(generation))
  }

  /**
   * Queue one user preference write. Rapid selections preserve mutation order,
   * while only the latest settlement may resynchronize the live target.
   * @param value - validated domain preference selected by the user.
   * @returns settlement after the write and any latest-write recovery read.
   */
  persist(value: T): Promise<void> {
    this.readGeneration += 1
    const generation = ++this.writeGeneration
    return this.enqueue(async () => {
      let response: Awaited<ReturnType<SettingsFace['settings']['mutate']>>
      try {
        response = await this.api.settings.mutate({
          ns: this.spec.namespace,
          ops: [{ op: 'set', path: [this.spec.field], value }],
          ...(this.revision === undefined ? {} : { expectedRevision: this.revision }),
        })
      } catch (_settingsWriteFailure) {
        if (!this.disposed && generation === this.writeGeneration) await this.read(++this.readGeneration)
        return
      }
      if (!response.result.ok) {
        if (!this.disposed && generation === this.writeGeneration) await this.read(++this.readGeneration)
        return
      }
      this.accept(response.result.value, generation === this.writeGeneration)
    })
  }

  /**
   * Stop queued operations and wait for the current wire call to settle.
   * @returns settlement after the controller reaches quiescence.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    this.readGeneration += 1
    this.writeGeneration += 1
    await this.tail
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    if (this.persistence === 'memory' || this.disposed) return Promise.resolve()
    const task = this.tail.then(async () => {
      if (this.disposed) return
      await operation()
    })
    // The returned task carries its own settlement to the caller; the queue
    // tail is kept fulfilled so one failed target callback cannot strand later operations.
    this.tail = task.catch(() => {})
    return task
  }

  private async read(generation: number): Promise<void> {
    let response: Awaited<ReturnType<SettingsFace['settings']['describe']>>
    try {
      response = await this.api.settings.describe({})
    } catch (_settingsReadFailure) {
      return
    }
    if (!response.result.ok || this.disposed) return
    const view = response.result.value.namespaces.find(candidate => candidate.ns === this.spec.namespace)
    if (view === undefined) return
    this.accept(view, generation === this.readGeneration)
  }

  private accept(view: SettingsNamespaceView, publish: boolean): void {
    this.revision = view.revision
    if (!publish || typeof view.value !== 'object' || view.value === null) return
    const value = this.spec.decode((view.value as Record<string, unknown>)[this.spec.field])
    if (value !== undefined) this.spec.sync(value)
  }
}

/**
 * Bind one controller to settings and connection invalidations on the caller's
 * plugin lifecycle. Listeners exist before the initial background read starts.
 * @param ctx - owning browser plugin context.
 * @param spec - domain-owned scalar preference contract.
 * @returns the bound controller used by the domain's user-write callback.
 */
export function bindSettingsPreference<T>(
  ctx: Context,
  spec: SettingsPreferenceSpec<T>,
): SettingsPreferenceController<T> {
  const connection = ctx.get('connection') as ConnectionHandle
  const controller = new SettingsPreferenceController(
    connection.api,
    spec,
    connection.isLoopback ? 'host' : 'memory',
  )
  ctx.effect(() => {
    const refresh = (namespace?: string): void => {
      if (namespace !== undefined && namespace !== spec.namespace) return
      void controller.load()
    }
    const disposers = [
      ctx.on('settings/changed', refresh),
      ctx.on('connection/reset', () => { refresh() }),
    ]
    void controller.load()
    return async () => {
      for (const dispose of disposers) dispose()
      await controller.dispose()
    }
  }, `runtime: ${spec.namespace}.${spec.field} preference`)
  return controller
}
