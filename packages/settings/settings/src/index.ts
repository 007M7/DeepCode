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
import { redactSecrets } from './redact.ts'
import type { RedactedSecret } from './redact.ts'

export { redactSecrets } from './redact.ts'
export type { RedactedSecret, RedactedValue } from './redact.ts'

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
  /** The registered namespace. */
  ns: SettingsNamespace
  /** Serialized schemastery schema (`schema.toJSON()`). */
  schema: unknown
  /** Current resolved value. */
  value: unknown
  /** Registrant's composition `base` layer (detached), when one was declared. */
  base?: unknown
  /**
   * Raw user section from the stored document (detached), when one exists and
   * is well-formed; a field's presence here is what marks it user-overridden.
   */
  user?: unknown
  /** Owner's declared effect timing. */
  applies: SettingsApplies
  /** Schema-declared secret positions; present only under `redactSecrets`. */
  secrets?: RedactedSecret[]
}

/** Options for {@link Settings.describe}. */
export interface SettingsDescribeOptions {
  /**
   * Strip `role('secret')` fields from `value`/`base`/`user` and enumerate
   * them in each descriptor's `secrets`. Every wire surface MUST pass this;
   * the verbatim default exists for same-process configuration UIs only.
   */
  redactSecrets?: boolean
}

/** Owner-facing handle for one registered namespace. */
export interface SettingsScope<T> {
  /** Current resolved value: schema defaults, then `base`, then the user layer. */
  get(): T
  /**
   * Observe committed changes to this namespace's resolved value. Invocations
   * of one callback run asynchronously, one at a time, in commit order; a
   * rejection is contained and logged like a sync throw.
   * @param callback - invoked after each commit with the next and previous values.
   * @returns the disposer removing this observer.
   */
  watch(callback: (next: T, prev: T) => void | Promise<void>): () => void
  /**
   * Merge a partial patch into this namespace's user layer and persist it.
   * @param patch - plain-object patch over the user section.
   */
  update(patch: object): Promise<void>
  /**
   * Replace this namespace's user section wholesale; absent keys re-inherit
   * the composition `base` and schema defaults (`replace({})` resets all).
   * @param section - the complete next user section.
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

/**
 * Layer `over` onto `under`: plain objects merge recursively, every other
 * value (arrays included) replaces the lower layer wholesale, and `undefined`
 * entries in `over` are ignored so a sparse patch cannot erase lower keys.
 */
function mergeLayers(under: unknown, over: unknown): unknown {
  if (over === undefined) return under
  if (!isPlainObject(under) || !isPlainObject(over)) return over
  const merged: Record<string, unknown> = { ...under }
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) continue
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
      // Teardown: refuse new writes, then wait until every queued write chain
      // settles so disposal completes only once storage is quiescent.
      this.stopped = true
      await Promise.allSettled([...this.writeQueues.values()])
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
      return () => this.registrations.delete(ns)
    }, `settings.register(${JSON.stringify(String(ns))})`)
    return {
      get: () => registration.resolved as T,
      watch: (callback) => {
        const watcher: SettingsWatcher = { callback: callback, tail: Promise.resolve() }
        registration.watchers.add(watcher)
        return () => registration.watchers.delete(watcher)
      },
      update: patch => this.update(ns, patch),
      replace: section => this.replace(ns, section),
    }
  }

  /**
   * Describe every registered namespace for configuration surfaces, including
   * the composition `base` and raw user layers so a form can mark which fields
   * the user overrode (presence in `user`) and what a reset returns to.
   * @param options - redaction switch; wire surfaces must redact.
   * @returns one descriptor per registered namespace, in registration order.
   */
  describe(options?: SettingsDescribeOptions): SettingsDescriptor[] {
    return [...this.registrations.values()].map((registration) => {
      let user: Record<string, unknown> | undefined
      try {
        user = this.section(registration.ns)
      } catch {
        // A malformed stored section already warned at publish and kept the
        // last good resolved value; only that malformed shape can throw here,
        // and describing it as "no user layer" keeps this read total.
        user = undefined
      }
      const base = registration.base === undefined ? undefined : structuredClone(registration.base)
      const detachedUser = user === undefined ? undefined : structuredClone(user)
      const descriptor: SettingsDescriptor = {
        ns: registration.ns,
        schema: registration.schema.toJSON(),
        value: registration.resolved,
        ...base === undefined ? {} : { base },
        ...detachedUser === undefined ? {} : { user: detachedUser },
        applies: registration.applies,
      }
      if (options?.redactSecrets !== true) return descriptor
      const schema = registration.schema as z<never>
      const redacted = redactSecrets(schema, registration.resolved)
      return {
        ...descriptor,
        value: redacted.value,
        ...base === undefined ? {} : { base: redactSecrets(schema, base).value },
        ...detachedUser === undefined ? {} : { user: redactSecrets(schema, detachedUser).value },
        secrets: redacted.secrets,
      }
    })
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
    // the caller may keep mutating while the write waits its turn.
    let snapshot: Record<string, unknown>
    try {
      snapshot = structuredClone(input)
    } catch {
      throw new TypeError(`settings ${verb} for "${ns}" must be JSON-shaped (structured-cloneable) data`)
    }
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
      watcher.tail = watcher.tail
        .then(() => watcher.callback(next as never, prev as never))
        .then(() => undefined, (error: unknown) => {
          this.warnWatcherFailure(registration.ns, error)
        })
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
        listener(registration.ns, next, prev, source)
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'INVARIANT') {
          invariantFailure ??= error
          continue
        }
        this.ctx.logger.warn('settings: a settings/updated listener for "%s" failed', registration.ns)
        this.ctx.logger.warn(error)
      }
    }
    if (invariantFailure !== undefined) throw invariantFailure as Error
  }

  /** Contained-watcher diagnostic shared by the sync and async failure paths. */
  private warnWatcherFailure(ns: SettingsNamespace, error: unknown): void {
    this.ctx.logger.warn('settings: watcher for "%s" failed', ns)
    this.ctx.logger.warn(error)
  }
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
      hooks.setSource(() => entry)
      hooks.onChange()
    })
    hooks.onChange()
    scope.watch(() => {
      hooks.onChange()
    })
  })
}

export default Settings
