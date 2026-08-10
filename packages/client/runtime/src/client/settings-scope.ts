/** Host-backed settings-namespace synchronization for browser plugins. */

import type { Context } from 'cordis'
import type {
  ConnectionHandle, IApiClient, SettingsNamespaceView, SettingsPathOpView,
} from '@deepseek-ai/dsh-client-connection/client'
import { rehydrateSchema, validateDraft } from '@deepseek-ai/dsh-client-schema-form'
import { createSnapshotStore, type SnapshotStore } from './contract/store.ts'

/** Client-side sync state of one settings namespace. */
export interface SettingsScopeSnapshot<T> {
  /**
   * `loading` until the first accepted section, `ready` while one stands, and
   * `unavailable` when the namespace is not exposed to this client or the
   * connection keeps preferences process-local (memory mode).
   */
  status: 'loading' | 'ready' | 'unavailable'
  /** Last accepted schema-resolved section; undefined before the first acceptance. */
  value: T | undefined
  /**
   * Composition layer the Host resolved {@link value} over, when the owning
   * plugin declared one. What a field reverts to once cleared.
   */
  base: unknown
  /**
   * Raw user layer as stored, when one exists. A field's PRESENCE here is what
   * marks it overridden — an override whose value equals the composition
   * default is still an override, and comparing values could not see it.
   */
  user: unknown
  /** Namespace revision fencing the next write; undefined before the first Host view. */
  revision: number | undefined
  /** Whether the Host document accepts writes; memory mode never does. */
  writable: boolean
  /** `host` syncs with the Host document; `memory` keeps a remote browser process-local. */
  mode: 'host' | 'memory'
}

/** Domain-owned description of one settings namespace consumed by a browser plugin. */
export interface SettingsScopeSpec<T> {
  /** Settings namespace registered by the owning Host plugin. */
  namespace: string
  /**
   * Narrow one wire section; undefined keeps the last accepted value. The
   * default validates the section against the namespace's own serialized wire
   * schema, so domains add a decoder only to narrow beyond that schema.
   */
  decode?: (section: unknown) => T | undefined
}

/**
 * Reactive owner handle over one namespace's durable section — the browser
 * mirror of the Host-side `SettingsScope` owner seam. Domain services read
 * and observe the snapshot and route explicit user choices through `set`.
 */
export interface SettingsScope<T> {
  /** @returns the current sync snapshot (stable reference until the next change). */
  getSnapshot(): SettingsScopeSnapshot<T>
  /**
   * Observe snapshot replacements.
   * @param listener - invoked after each snapshot change.
   * @returns the disposer removing this listener.
   */
  subscribe(listener: () => void): () => void
  /**
   * Queue one field write. Rapid writes preserve mutation order, each carries
   * the latest known namespace revision, and only the latest settlement may
   * publish; a rejected or failed latest write reloads Host state instead.
   * @param field - scalar field inside the namespace section.
   * @param value - JSON-shaped value selected by the user.
   * @returns settlement after the write and any latest-write recovery read.
   */
  set(field: string, value: unknown): Promise<void>
  /**
   * Queue one field clear, so the field re-inherits the composition layer.
   * Shares {@link set}'s ordering, revision, and recovery contract.
   * @param field - scalar field inside the namespace section.
   * @returns settlement after the clear and any latest-write recovery read.
   */
  unset(field: string): Promise<void>
}

type SettingsFace = Pick<IApiClient, 'settings'>

/**
 * Serializes one namespace's Host reads and writes behind a snapshot store.
 * Reads never block plugin activation; writes carry the latest known
 * namespace revision and teardown waits for the operation already crossing
 * the wire.
 */
export class SettingsScopeController<T> implements SettingsScope<T> {
  private readonly store: SnapshotStore<SettingsScopeSnapshot<T>>
  private tail: Promise<void> = Promise.resolve()
  private readGeneration = 0
  private writeGeneration = 0
  private disposed = false

  /**
   * @param api - settings wire face.
   * @param spec - namespace identity and optional narrowing decoder.
   * @param persistence - remote browsers remain process-local because settings RPCs are loopback-only.
   */
  constructor(
    private readonly api: SettingsFace,
    private readonly spec: SettingsScopeSpec<T>,
    private readonly persistence: 'host' | 'memory' = 'host',
  ) {
    this.store = createSnapshotStore<SettingsScopeSnapshot<T>>({
      status: persistence === 'host' ? 'loading' : 'unavailable',
      value: undefined,
      base: undefined,
      user: undefined,
      revision: undefined,
      writable: false,
      mode: persistence,
    })
  }

  /** @returns the current sync snapshot (stable reference until the next change). */
  getSnapshot(): SettingsScopeSnapshot<T> {
    return this.store.getSnapshot()
  }

  /**
   * Observe snapshot replacements.
   * @param listener - invoked after each snapshot change.
   * @returns the disposer removing this listener.
   */
  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener)
  }

  /**
   * Queue a Host refresh; a newer read or user write suppresses stale publication.
   * @returns settlement after the queued read completes or is skipped.
   */
  load(): Promise<void> {
    const generation = ++this.readGeneration
    return this.enqueue(() => this.read(generation))
  }

  /**
   * Queue one field write; see {@link SettingsScope.set} for the ordering,
   * revision, and recovery contract.
   * @param field - scalar field inside the namespace section.
   * @param value - JSON-shaped value selected by the user.
   * @returns settlement after the write and any latest-write recovery read.
   */
  set(field: string, value: unknown): Promise<void> {
    return this.write({ op: 'set', path: [field], value })
  }

  /**
   * Queue one field clear; see {@link SettingsScope.unset} for the ordering,
   * revision, and recovery contract.
   * @param field - scalar field inside the namespace section.
   * @returns settlement after the clear and any latest-write recovery read.
   */
  unset(field: string): Promise<void> {
    return this.write({ op: 'unset', path: [field] })
  }

  private write(op: SettingsPathOpView): Promise<void> {
    this.readGeneration += 1
    const generation = ++this.writeGeneration
    return this.enqueue(async () => {
      const revision = this.getSnapshot().revision
      let response: Awaited<ReturnType<SettingsFace['settings']['mutate']>>
      try {
        response = await this.api.settings.mutate({
          ns: this.spec.namespace,
          ops: [op],
          ...(revision === undefined ? {} : { expectedRevision: revision }),
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
    // tail is kept fulfilled so one failed subscriber cannot strand later operations.
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
    const { namespaces, writable } = response.result.value
    const view = namespaces.find(candidate => candidate.ns === this.spec.namespace)
    const publish = generation === this.readGeneration
    if (view === undefined) {
      if (publish) {
        this.store.update((draft) => {
          draft.status = 'unavailable'
          draft.writable = writable
        })
      }
      return
    }
    this.accept(view, publish, writable)
  }

  private accept(view: SettingsNamespaceView, publish: boolean, writable?: boolean): void {
    const decoded = publish ? this.decode(view) : undefined
    this.store.update((draft) => {
      draft.revision = view.revision
      draft.base = view.base
      draft.user = view.user
      if (writable !== undefined) draft.writable = writable
      if (decoded === undefined) return
      draft.status = 'ready'
      draft.value = decoded
    })
  }

  private decode(view: SettingsNamespaceView): T | undefined {
    if (this.spec.decode !== undefined) return this.spec.decode(view.value)
    // Sections are plain objects by construction; schemastery alone would
    // resolve null or an array through object defaults instead of refusing.
    if (typeof view.value !== 'object' || view.value === null || Array.isArray(view.value)) return undefined
    let failure: string | undefined
    try {
      failure = validateDraft(rehydrateSchema(view.schema), view.value)
    } catch (_malformedSchemaEnvelope) {
      // A schema envelope this client cannot rehydrate vouches for no section;
      // the value is treated exactly like a schema-invalid one.
      return undefined
    }
    return failure === undefined ? view.value as T : undefined
  }
}

/**
 * Bind one namespace scope to settings and connection invalidations on the
 * caller's plugin lifecycle. Listeners exist before the initial background
 * read starts, so activation never blocks on the settings transport.
 * @param ctx - owning browser plugin context.
 * @param spec - domain-owned namespace contract.
 * @returns the bound scope consumed by the domain's services and rows.
 */
export function bindSettingsScope<T>(
  ctx: Context,
  spec: SettingsScopeSpec<T>,
): SettingsScope<T> {
  const connection = ctx.get('connection') as ConnectionHandle
  const controller = new SettingsScopeController<T>(
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
  }, `runtime: ${spec.namespace} settings scope`)
  return controller
}
