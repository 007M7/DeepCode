/**
 * User-settings seam (`ctx.settings`). Providers store one raw document of
 * per-namespace sections; plugins register a namespace schema and read the
 * resolved value, which layers schema defaults, the registrant's composition
 * `base`, and the user document section, in that order.
 * @module @deepseek-ai/dsh-settings
 */

import { Context, Service } from 'cordis'
import type z from 'schemastery'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Nominal id of one registered settings namespace. */
export type SettingsNamespace = Branded<'SettingsNamespace'>

const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/

/**
 * Brand a raw string as a {@link SettingsNamespace}.
 * @param value - candidate namespace; lowercase kebab-case, as in plugin short names.
 * @returns the branded namespace.
 */
export function settingsNamespace(value: string): SettingsNamespace {
  if (!NAMESPACE_PATTERN.test(value)) {
    throw new TypeError(`settings namespace "${value}" must match ${String(NAMESPACE_PATTERN)}`)
  }
  return value as SettingsNamespace
}

/** When a namespace's changes take effect for its owner. */
export type SettingsApplies = 'live' | 'restart'

/** Origin of one committed settings change. */
export type SettingsUpdateSource = 'update' | 'provider'

/** Registration options beyond the namespace schema. */
export interface SettingsRegisterOptions<T> {
  /** Composition-layer values resolved below the user layer (entry-config subset). */
  base?: Partial<T>
  /** Owner's effect timing, surfaced to configuration UIs; defaults to `live`. */
  applies?: SettingsApplies
}

/** One registered namespace as surfaced to configuration UIs. */
export interface SettingsDescriptor {
  // TODO(settings-namespace-vocabulary): Rename `ns` to `namespace` across the
  // public seam, provider contract, implementations, tests, and consumers.
  /** The registered namespace. */
  ns: SettingsNamespace
  /** Serialized schemastery schema (`schema.toJSON()`). */
  schema: unknown
  /** Current resolved value. */
  value: unknown
  /** Owner's declared effect timing. */
  applies: SettingsApplies
}

/** Owner-facing handle for one registered namespace. */
export interface SettingsScope<T> {
  /** Current resolved value: schema defaults, then `base`, then the user layer. */
  get(): T
  /**
   * Observe committed changes to this namespace's resolved value. Invocations
   * of one callback run asynchronously, one at a time, in commit order; a
   * rejection is contained and logged like a sync throw. After the disposer
   * returns, no further invocation starts — one already queued is skipped;
   * one already started still settles, and service disposal waits for it.
   * @param callback - invoked after each commit with the next and previous values.
   * @returns the disposer removing this observer.
   */
  watch(callback: (next: T, prev: T) => void | Promise<void>): () => void
  /**
   * Merge a partial patch into this namespace's user layer and persist it.
   * @param patch - plain-object patch over the user section; JSON-shaped data
   * only (non-JSON values reject with their path before anything persists).
   */
  update(patch: object): Promise<void>
  /**
   * Replace this namespace's user section wholesale; absent keys re-inherit
   * the composition `base` and schema defaults (`replace({})` resets all).
   * @param section - the complete next user section; JSON-shaped data only,
   * as for {@link update}.
   */
  replace(section: object): Promise<void>
}

declare module 'cordis' {
  interface Context {
    settings: Settings
  }

  interface Events {
    /**
     * Committed change to one registered namespace's resolved value. Emitted
     * after the provider persisted (for `update`) or published (`provider`)
     * the change; never emitted when the resolved value is deep-equal.
     * Listener failures are contained and logged — a sync throw and an async
     * rejection alike — except `INVARIANT`-coded failures, which rethrow
     * after every listener ran; that rethrow reaches the emitter only from
     * synchronous listeners, so invariant checks on this event must not be
     * async functions.
     * @param ns - the namespace whose resolved value changed.
     * @param next - the new resolved value.
     * @param prev - the previous resolved value.
     * @param source - whether the change entered through `update()` or the provider.
     * @mode emit
     */
    'settings/updated'(ns: SettingsNamespace, next: unknown, prev: unknown, source: SettingsUpdateSource): void
  }
}

/**
 * Deep equality over JSON-shaped data (objects, arrays, primitives) — the
 * seam's single change-detection predicate, exported so the invariant
 * companion checks exactly the implementation's relation.
 * @param a - one JSON-shaped value.
 * @param b - the other JSON-shaped value.
 * @returns whether the two values are structurally equal.
 */
export function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((entry, index) => deepEqualJson(entry, b[index]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every(key => key in right && deepEqualJson(left[key], right[key]))
}

/** Whether a value is a plain data object (not an array, null, or class instance). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Human label for a value rejected by the JSON-shape boundary (numbers reject inline). */
function describeRejected(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (typeof value === 'object' && value !== null) {
    const proto = Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null
    const name = proto?.constructor?.name
    return name === undefined || name === 'Object' ? 'a non-plain object' : `a ${name}`
  }
  return `a ${typeof value}`
}

/**
 * Detach one write input in a single walk that doubles as the durable-boundary
 * shape check: only JSON data (plain objects, arrays, strings, finite numbers,
 * booleans, `null`) may reach a provider document. `structuredClone` alone
 * would admit Dates, Maps, BigInts, and cycles that YAML/JSON storage then
 * silently distorts on the reload round-trip. `undefined` entries in objects
 * are skipped — the same sparse-patch semantics as {@link mergeLayers} — while
 * an `undefined` array entry is rejected rather than coerced.
 * @param root - plain-object write input (caller-checked).
 * @param reject - builds the boundary error from a value label and its `$`-rooted path.
 * @returns the detached JSON-shaped clone.
 */
function cloneJsonShaped(
  root: Record<string, unknown>,
  reject: (label: string, path: string) => TypeError,
): Record<string, unknown> {
  const visiting = new WeakSet<object>()
  const clone = (value: unknown, path: string): unknown => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw reject('a non-finite number', path)
      return value
    }
    if (Array.isArray(value)) {
      if (visiting.has(value)) throw reject('a circular reference', path)
      visiting.add(value)
      const entries = value.map((entry, index) => clone(entry, `${path}[${index}]`))
      // Un-mark on exit so one object referenced twice without a cycle passes.
      visiting.delete(value)
      return entries
    }
    if (isPlainObject(value)) {
      if (visiting.has(value)) throw reject('a circular reference', path)
      visiting.add(value)
      // TODO(settings-json-properties): Use property-safe construction here and
      // in mergeLayers so valid JSON keys such as "__proto__" remain own data.
      const out: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(value)) {
        if (entry === undefined) continue
        out[key] = clone(entry, `${path}.${key}`)
      }
      visiting.delete(value)
      return out
    }
    throw reject(describeRejected(value), path)
  }
  return clone(root, '$') as Record<string, unknown>
}

/**
 * Layer `over` onto `under`: plain objects merge recursively, every other
 * value (arrays included) replaces the lower layer wholesale. `over` never
 * carries `undefined` entries — sections come from parsed documents and write
 * snapshots pass {@link cloneJsonShaped}, which strips them so a sparse patch
 * cannot erase lower keys.
 */
function mergeLayers(under: unknown, over: unknown): unknown {
  if (over === undefined) return under
  if (!isPlainObject(under) || !isPlainObject(over)) return over
  const merged: Record<string, unknown> = { ...under }
  for (const [key, value] of Object.entries(over)) {
    merged[key] = key in merged ? mergeLayers(merged[key], value) : value
  }
  return merged
}

/** Recursively freeze one resolved value so handed-out snapshots stay immutable. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const entry of Object.values(value)) deepFreeze(entry)
  return Object.freeze(value)
}

/** One registered watcher and its serialized invocation chain. */
interface SettingsWatcher {
  callback: (next: never, prev: never) => void | Promise<void>
  /** Settled tail: invocations of this callback run one at a time, in commit order. */
  tail: Promise<void>
  /** Cleared by the disposer: a queued invocation checks this before starting. */
  active: boolean
}

/** One live namespace registration owned by a registrant fiber. */
interface SettingsRegistration {
  ns: SettingsNamespace
  schema: z<unknown>
  base: unknown
  applies: SettingsApplies
  resolved: unknown
  watchers: Set<SettingsWatcher>
}

/**
 * Abstract settings service. Providers implement raw-document storage
 * (`load`/`persist`) and push external changes through {@link Settings.publish};
 * the base class owns namespace registration, resolution, validation, change
 * detection, and the `settings/updated` commit event.
 */
export abstract class Settings extends Service {
  private readonly registrations = new Map<SettingsNamespace, SettingsRegistration>()
  /** Latest published raw document; empty until the provider's first publish. */
  private document: Record<string, unknown> = {}
  /** Per-namespace write chains; settled tails, so a failure never poisons the queue. */
  private readonly writeQueues = new Map<SettingsNamespace, Promise<unknown>>()
  /** In-flight watcher invocation segments, drained by the dispose teardown. */
  private readonly pendingTails = new Set<Promise<void>>()
  /** Set at service dispose: refuse new writes while queued ones drain. */
  private stopped = false

  /** Opaque read of {@link stopped}: control flow cannot narrow it across awaits. */
  private isStopped(): boolean {
    return this.stopped
  }

  constructor(ctx: Context) {
    super(ctx, 'settings')
  }

  /**
   * Load the provider's document once and publish it before the service
   * becomes injectable, and register the write-drain teardown. Providers with
   * their own init (watchers, connections) delegate here first via
   * `yield* super[Service.init]()`; their disposers then run before the drain.
   */
  async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    yield async () => {
      // Teardown: refuse new writes and new watcher starts, then wait until
      // every queued write chain and every started watcher invocation settles
      // so disposal completes only once storage and observers are quiescent.
      // Invocations queued but not yet started skip via the stopped check.
      this.stopped = true
      await Promise.allSettled([...this.writeQueues.values(), ...this.pendingTails])
    }
    this.publish(await this.load())
  }

  /** Whether {@link update} may persist through this provider. */
  abstract readonly writable: boolean

  /**
   * Read the provider's current raw document (namespace to raw section).
   * @returns the detached raw document.
   */
  protected abstract load(): Promise<Record<string, unknown>>

  /**
   * Durably store one namespace's merged user section.
   * @param ns - the namespace being written.
   * @param section - the complete merged user section to store.
   */
  protected abstract persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void>

  /**
   * Register a namespace schema and receive its owner scope. The registration
   * is an effect on the calling plugin's fiber: disposing that fiber removes
   * the namespace and its observers. An invalid stored section fails the
   * registration itself — the earliest point where the schema can judge it.
   * @param ns - unique namespace; duplicate registration fails loud.
   * @param schema - schemastery schema resolving this namespace's value.
   * @param options - composition `base` layer and effect timing.
   * @returns the owner scope for reads, observation, and updates.
   */
  register<T>(ns: SettingsNamespace, schema: z<T>, options?: SettingsRegisterOptions<T>): SettingsScope<T> {
    if (this.registrations.has(ns)) {
      throw new Error(`settings namespace "${ns}" is already registered`)
    }
    const registration: SettingsRegistration = {
      ns,
      schema: schema as z<unknown>,
      base: options?.base,
      applies: options?.applies ?? 'live',
      resolved: deepFreeze(this.resolve(schema, options?.base, this.section(ns))),
      watchers: new Set(),
    }
    this.ctx.effect(() => {
      this.registrations.set(ns, registration)
      // TODO(settings-registration-quiescence): Deactivate every watcher and await
      // its tail on disposal so callbacks cannot outlive the registrant fiber.
      return () => this.registrations.delete(ns)
    }, `settings.register(${JSON.stringify(String(ns))})`)
    return {
      get: () => registration.resolved as T,
      watch: (callback) => {
        const watcher: SettingsWatcher = { callback: callback, tail: Promise.resolve(), active: true }
        registration.watchers.add(watcher)
        return () => {
          watcher.active = false
          registration.watchers.delete(watcher)
        }
      },
      update: patch => this.update(ns, patch),
      replace: section => this.replace(ns, section),
    }
  }

  /**
   * Describe every registered namespace for configuration surfaces.
   * @returns one descriptor per registered namespace, in registration order.
   */
  describe(): SettingsDescriptor[] {
    return [...this.registrations.values()].map(registration => ({
      ns: registration.ns,
      schema: registration.schema.toJSON(),
      value: registration.resolved,
      applies: registration.applies,
    }))
  }

  /**
   * Read one registered namespace's resolved value.
   * @param ns - the namespace to read.
   * @returns the resolved value, or `undefined` while unregistered.
   */
  get(ns: SettingsNamespace): unknown {
    return this.registrations.get(ns)?.resolved
  }

  /**
   * Merge a patch into one registered namespace's user layer, validate the
   * resolved candidate, persist through the provider, then commit and emit.
   * A validation failure rejects before anything is persisted. Writes to one
   * namespace are serialized: concurrent updates apply in call order, each
   * merging over the previous write's committed section.
   * @param ns - the registered namespace to update.
   * @param patch - plain-object patch over the user section.
   */
  async update(ns: SettingsNamespace, patch: object): Promise<void> {
    return this.write(ns, patch, 'merge')
  }

  /**
   * Replace one registered namespace's user section wholesale, validate,
   * persist, then commit and emit. Keys absent from `section` fall back to the
   * composition `base` and schema defaults — this is the removal/reset path a
   * merge-only patch cannot express (`replace({})` re-inherits everything).
   * @param ns - the registered namespace to replace.
   * @param section - the complete next user section.
   */
  async replace(ns: SettingsNamespace, section: object): Promise<void> {
    return this.write(ns, section, 'replace')
  }

  /** Validate a write, then queue it on the namespace's serialized write chain. */
  private write(ns: SettingsNamespace, input: object, mode: 'merge' | 'replace'): Promise<void> {
    const verb = mode === 'merge' ? 'update' : 'replace'
    const registration = this.registrations.get(ns)
    if (registration === undefined) {
      throw new Error(`settings namespace "${ns}" is not registered`)
    }
    if (this.isStopped()) {
      throw new Error(`settings service is disposed: "${ns}" cannot be written`)
    }
    if (!this.writable) {
      throw new Error(`settings provider is read-only: "${ns}" cannot be updated in-process`)
    }
    if (!isPlainObject(input)) {
      throw new TypeError(`settings ${verb} for "${ns}" must be a plain object`)
    }
    // Snapshot at call time: the queue must never read a caller-owned object
    // the caller may keep mutating while the write waits its turn. The same
    // walk is the JSON-shape boundary check (see cloneJsonShaped).
    const snapshot = cloneJsonShaped(input, (label, path) =>
      new TypeError(`settings ${verb} for "${ns}" must be JSON-shaped data (found ${label} at ${path})`))
    const previous = this.writeQueues.get(ns) ?? Promise.resolve()
    // Chain past a failed predecessor: one rejected write must not poison the
    // namespace queue for every later caller.
    const run = previous.catch(() => undefined).then(async () => {
      if (this.isStopped()) {
        throw new Error(`settings service was disposed before the queued "${ns}" ${verb} ran`)
      }
      if (this.registrations.get(ns) !== registration) {
        throw new Error(`settings namespace "${ns}" registration was disposed before the queued ${verb} ran`)
      }
      const section = mode === 'merge'
        ? mergeLayers(this.section(ns) ?? {}, snapshot) as Record<string, unknown>
        : snapshot
      const next = deepFreeze(this.resolve(registration.schema, registration.base, section))
      await this.persist(ns, section)
      // The write reached storage either way; the cache must say so. Commit
      // only when this registration is still the namespace owner — a fiber
      // disposed (or replaced) mid-persist must not receive the notification.
      this.document[ns] = section
      // TODO(settings-replacement-resync): Re-resolve any replacement registration
      // from this persisted section so an old in-flight write cannot leave it stale.
      if (this.registrations.get(ns) === registration && !this.isStopped()) {
        this.commit(registration, next, 'update')
      }
    })
    this.writeQueues.set(ns, run)
    return run
  }

  /**
   * Provider hook: commit a complete raw document observed in storage. Each
   * registered namespace re-resolves; an invalid section keeps that
   * namespace's last good value and warns, other namespaces still commit.
   * @param doc - the detached raw document (unregistered sections preserved).
   * @param source - change origin; defaults to `provider`.
   */
  protected publish(doc: Record<string, unknown>, source: SettingsUpdateSource = 'provider'): void {
    this.document = doc
    for (const registration of this.registrations.values()) {
      let next: unknown
      try {
        next = deepFreeze(this.resolve(registration.schema, registration.base, this.section(registration.ns)))
      } catch (error) {
        this.ctx.logger.warn('settings: keeping last good "%s" after invalid stored section', registration.ns)
        this.ctx.logger.warn(error)
        continue
      }
      this.commit(registration, next, source)
    }
  }

  /** Read one namespace's raw user section, rejecting non-object sections. */
  private section(ns: SettingsNamespace): Record<string, unknown> | undefined {
    const section = this.document[ns]
    if (section === undefined) return undefined
    if (!isPlainObject(section)) {
      throw new TypeError(`settings section "${ns}" must be an object of keys`)
    }
    return section
  }

  /** Resolve one namespace value: schema defaults, then `base`, then the user layer. */
  private resolve<T>(schema: z<T>, base: unknown, section: Record<string, unknown> | undefined): T {
    // The merged candidate is untyped by construction; the schema call is the
    // runtime validation that admits it into T.
    return schema(mergeLayers(base, section) as never)
  }

  /** Commit a resolved value when changed: swap, notify watchers, emit the event. */
  private commit(registration: SettingsRegistration, next: unknown, source: SettingsUpdateSource): void {
    const prev = registration.resolved
    if (deepEqualJson(next, prev)) return
    registration.resolved = next
    for (const watcher of [...registration.watchers]) {
      // Serialize per watcher: invocations of one callback run one at a time
      // in commit order, so a slow stale invocation can never apply after a
      // newer one. Sync throws and async rejections land in the same handler.
      // The activity check runs when the queued invocation would start, so a
      // disposer (or service stop) that ran while it waited prevents the
      // start entirely; started invocations drain at service dispose.
      const segment = watcher.tail
        .then(() => {
          if (!watcher.active || this.isStopped()) return
          return watcher.callback(next as never, prev as never)
        })
        .then(() => undefined, (error: unknown) => {
          this.warnWatcherFailure(registration.ns, error)
        })
      watcher.tail = segment
      this.pendingTails.add(segment)
      void segment.then(() => this.pendingTails.delete(segment))
    }
    // Fan the event out one listener at a time (the plain emit stops at the
    // first throwing listener, starving the rest). Invariant violations are
    // harness-fatal by design and rethrow after every listener ran; any other
    // failure is contained so one broken observer cannot wedge the commit
    // path (and, through it, a provider's reload loop).
    let invariantFailure: unknown
    const args = ['settings/updated', registration.ns, next, prev, source]
    for (const listener of this.ctx.events.dispatch('emit', args) as Array<(...listenerArgs: unknown[]) => unknown>) {
      try {
        const returned = listener(registration.ns, next, prev, source)
        if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
          // An emit listener may still be an async function; its rejection
          // cannot reach the synchronous INVARIANT rethrow below, so it is
          // contained here instead of becoming an unhandled rejection.
          void Promise.resolve(returned as PromiseLike<unknown>).then(undefined, (error: unknown) => {
            this.warnListenerFailure(registration.ns, error)
          })
        }
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'INVARIANT') {
          invariantFailure ??= error
          continue
        }
        this.warnListenerFailure(registration.ns, error)
      }
    }
    if (invariantFailure !== undefined) throw invariantFailure as Error
  }

  /** Contained-watcher diagnostic shared by the sync and async failure paths. */
  private warnWatcherFailure(ns: SettingsNamespace, error: unknown): void {
    this.ctx.logger.warn('settings: watcher for "%s" failed', ns)
    this.ctx.logger.warn(error)
  }

  /** Contained-listener diagnostic shared by the sync and async failure paths. */
  private warnListenerFailure(ns: SettingsNamespace, error: unknown): void {
    this.ctx.logger.warn('settings: a settings/updated listener for "%s" failed', ns)
    this.ctx.logger.warn(error)
  }
}

/**
 * Value mirror of the `FiberState` members {@link isUnloading} compares
 * against: a const enum has no runtime object to import, and the value is
 * needed at runtime (same rationale as the CLI boot driver's mirror).
 */
const FIBER_DISPOSED = 4
const FIBER_UNLOADING = 5

/** Whether the consumer's own fiber is tearing down (not just losing the settings service). */
function isUnloading(ctx: Context): boolean {
  const state: number = ctx.fiber.state
  return state === FIBER_UNLOADING || state === FIBER_DISPOSED
}

/** Hooks a consumer hands to {@link installSettingsSection}. */
export interface SettingsSectionHooks<T> {
  /**
   * Receive the active configuration source: the resolved settings scope
   * while one is attached, the composition entry otherwise. Called before
   * the matching `onChange` at attach and at detach.
   * @param current - thunk returning the currently authoritative value.
   */
  setSource(current: () => T): void
  /**
   * Re-judge anything derived from the source — registration-level facts,
   * memoized resolutions — after an attach, a detach, or a committed change.
   */
  onChange(): void
}

/**
 * Install the canonical optional-settings consumer wiring: while a settings
 * service exists, register `ns` with the consumer's composition entry as the
 * `base` layer and point the source thunk at the resolved scope; when the
 * service goes away (disposal, provider reload), fall back to the entry so
 * the consumer keeps working exactly as composed. The registration rides the
 * scoped fiber, so no settings service ever mounted means none of this runs.
 * @param ctx - consumer plugin context owning the wiring.
 * @param ns - the consumer-owned settings namespace.
 * @param schema - schema resolving the namespace (typically the plugin Config).
 * @param entry - the consumer's composition entry config, used as `base`.
 * @param hooks - source sink and change notification.
 */
export function installSettingsSection<T>(
  ctx: Context,
  ns: SettingsNamespace,
  schema: z<T>,
  entry: T,
  hooks: SettingsSectionHooks<T>,
): void {
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(ns, schema, { base: entry })
    hooks.setSource(() => scope.get())
    sctx.effect(() => () => {
      // This disposer runs for two different reasons. A settings provider
      // detaching leaves the consumer running, so it must fall back to its
      // composition entry and re-judge what it derived. The consumer's own
      // unload runs it too — and there `onChange` would re-register routes
      // and touch resources the teardown is releasing, so the fallback is
      // pointless and the notification actively harmful.
      if (isUnloading(ctx)) return
      hooks.setSource(() => entry)
      hooks.onChange()
    })
    hooks.onChange()
    scope.watch(() => {
      // A stored change landing while the consumer unloads reaches the watcher
      // before the registration is released, and `onChange` is exactly as
      // harmful here as in the disposer above: it re-registers routes against
      // a fiber whose resources are being let go.
      if (isUnloading(ctx)) return
      hooks.onChange()
    })
  })
}

export default Settings
