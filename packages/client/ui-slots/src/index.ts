/**
 * Slot registry pure core. Owners declare slot contracts by merging into
 * {@link SlotMap}; `define` records the runtime spec, `register` contributes a
 * component. Zero runtime dependencies (React types only).
 *
 * SlotMap and its companion types live directly in this entry module: consumer
 * `declare module` augmentation merges with declarations lexically in the
 * augmented module, not with re-exports.
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents --
 * `keyof SlotMap & string` is the declare-merge key pattern: SlotMap is empty
 * in THIS compilation unit (so the intersection reads as `never`), but every
 * consumer merges keys in and the intersection is what keeps them string-typed.
 * The rule fires on the empty-map view, not on real redundancy. */
import type { FC, ReactNode } from 'react'

/** Slot contract table. Owners extend via declaration merging; entries are {@link SlotEntryDef}. */
export interface SlotMap {}

/** Slot cardinality: single occupant, ordered list, or key-dispatched. */
export type SlotKind = 'single' | 'list' | 'keyed'

/** Slot data context: root (no session) or session-bound. */
export type SlotScope = 'root' | 'session'

/**
 * One SlotMap entry: kind/scope axes, the owner-supplied props share, and an
 * optional sub-slot whitelist. Ownership rule (a share's type lives with
 * whoever wires it): `owner` is the render-side share declared by the
 * slot-owning package and REFERENCED by registrants; the registrant's own
 * injected share never enters this table — full component props are composed
 * at the component as `OwnerOf<K> & <injector-narrowed standard> & OwnInjected`.
 * `props` is the legacy full-props slot kept while consumers migrate to
 * composed declarations (new entries declare `owner` and omit it).
 */
export interface SlotEntryDef {
  kind: SlotKind
  scope: SlotScope
  props?: object
  owner?: object
  children?: keyof SlotMap & string
}

/**
 * Owner-supplied props share for a slot key: the render-side contract half.
 * Falls back to the legacy Partial form when the entry declares no `owner`.
 */
export type OwnerOf<K extends keyof SlotMap & string> =
  SlotMap[K] extends { owner: infer O extends object } ? O : OwnerProps<SlotMap[K]>

/**
 * CONSTRAINT-position standard share for register(): the framework supplies
 * session slots' bound selector hook, so it is bottom-typed here — any
 * registrant narrowing (e.g. a runtime-typed conversation hook) is accepted,
 * and the type responsibility for what actually arrives lives with the
 * injecting side (web-react's renderer). Do NOT compose component props from
 * this type; declare the narrowed hook the component actually consumes.
 */
export type StandardOf<K extends keyof SlotMap & string> =
  SlotMap[K]['scope'] extends 'session' ? { useSession: never } : object

/**
 * Delegable sub-slot whitelist declared by an entry: the `children` key union,
 * or `never` when the entry declares none (no delegation authorized).
 */
export type ChildrenOf<K extends keyof SlotMap & string> =
  SlotMap[K] extends { children: infer C extends keyof SlotMap & string } ? C : never

/**
 * B-b optional validation layer over the hand-written whitelist (B-a): the
 * composed register constraint carries a `slots` face whose key union is the
 * entry's `children` declaration. Components wanting a SUBSET whitelist
 * accept it through ScopedSlots covariance; an out-of-union whitelist makes
 * the component's `slots` parameter unsatisfiable and the register call site
 * reports it. Entries without `children` add no slots constraint, so any
 * hand-written whitelist registers freely (the layer is opt-in per entry).
 * This is constraint-side only: whether slots are actually delivered stays
 * with the renderer/owner (B-a trust).
 */
export type SlotsFaceOf<K extends keyof SlotMap & string> =
  [ChildrenOf<K>] extends [never]
    ? object
    : { slots: ScopedSlots<ChildrenOf<K>> }

/**
 * The registration-boundary composed props constraint: owner share + standard
 * share + registrant share, gated by the entry's `children` authorization
 * (see {@link ChildrenChecked}). Entries without an `owner` declaration
 * (legacy full-props form) keep the plain props constraint until they migrate.
 */
export type ComposedProps<K extends keyof SlotMap & string, I extends object> =
  SlotMap[K] extends { owner: infer O extends object }
    ? O & StandardOf<K> & SlotsFaceOf<K> & I
    : PropsShape<SlotMap[K]>

/**
 * Registration-position component shape: the bare call signature, so the
 * ComposedProps constraint checks through clean parameter contravariance
 * (FC's propTypes/defaultProps statics add covariant noise that rejects
 * legitimate narrowings of the bottom-typed standard share).
 */
export type SlotComponent<P> = (props: P) => ReactNode

/** The stored component's props shape: the legacy full-props slot, or wide for composed entries. */
export type PropsShape<E extends SlotEntryDef> =
  E extends { props: infer P extends object } ? P : object

/**
 * Session-scoped assembly handle passed to inject factories (apply world
 * only, never into props). `Ctx` defaults to unknown at this zero-dependency
 * layer; runtime re-exports the ClientContext-narrowed alias.
 */
export interface SessionBinding<Ctx = unknown> {
  readonly sessionId: string
  readonly session: SessionAccess
  readonly ctx: Ctx
}

/** Root-scoped assembly handle passed to inject factories. */
export interface RootBinding<Ctx = unknown> { readonly ctx: Ctx }

/** Session subscription surface; web-react narrows `useSelector` to the typed hook. */
export interface SessionAccess { readonly useSelector: unknown }

/**
 * Factory producing the registrant's private injected props, called once per
 * (entry x session) for session slots or per entry for root slots. `I` is the
 * registrant's own injected share, inferred at the registration site. `Ctx`
 * parameterizes the binding's context (default unknown keeps this layer
 * dependency-free); runtime's narrowed binding aliases flow through here so
 * factories written against a narrowed ctx type-check without a cast.
 */
export type InjectFactory<E extends SlotEntryDef, I extends object = Record<string, unknown>, Ctx = unknown> =
  (b: E['scope'] extends 'session' ? SessionBinding<Ctx> : RootBinding<Ctx>) => I

/** Runtime spec recorded at define time; must match the SlotMap declaration. */
export interface SlotSpec<E extends SlotEntryDef> { kind: E['kind']; scope: E['scope'] }

/**
 * Registration options, shaped by the slot kind and the registrant's injected
 * share `I`. `Ctx` flows through to the inject factory's binding parameter
 * (narrowing wrappers fix it to their client context type).
 */
export type SlotOptions<E extends SlotEntryDef, I extends object = Record<string, unknown>, Ctx = unknown> =
  E['kind'] extends 'keyed' ? { key: string; inject?: InjectFactory<E, I, Ctx> }
    : E['kind'] extends 'list' ? { id: string; order?: number; label?: string; inject?: InjectFactory<E, I, Ctx> }
      : { inject?: InjectFactory<E, I, Ctx> }

/** register() trailing args: options are statically mandatory for keyed/list kinds (key/id live there). */
export type RegisterArgs<E extends SlotEntryDef, I extends object = Record<string, unknown>, Ctx = unknown> =
  E['kind'] extends 'keyed' | 'list' ? [options: SlotOptions<E, I, Ctx>] : [options?: SlotOptions<E, I, Ctx>]

/** One registered contribution: the component plus its registration options. */
export interface SlotEntry<E extends SlotEntryDef, I extends object = Record<string, unknown>> {
  component: FC<PropsShape<E>>
  options: SlotOptions<E, I>
}

/** Type-erased stored entry; public typing is restored at the entries() boundary. */
interface StoredEntry {
  component: unknown
  options: { key?: string; id?: string; order?: number; label?: string; inject?: unknown }
}

/** Per-key registry record. Created on first define/subscribe/version read; never removed (version stays monotonic across redefines). */
interface SlotRecord {
  spec: SlotSpec<SlotEntryDef> | undefined
  entries: readonly StoredEntry[]
  version: number
  listeners: Set<() => void>
}

const NO_ENTRIES: readonly StoredEntry[] = Object.freeze([])

/**
 * Pure slot registry (no cordis; event emission lives in the runtime Service
 * wrapper via {@link SlotCore.onMutate}).
 *
 * Change propagation contract: versions bump and {@link SlotCore.onMutate}
 * fires synchronously per mutation (registry state is consistent when they
 * fire); {@link SlotCore.subscribe} notifications batch per microtask, so N
 * same-tick mutations produce one notification per touched key.
 */
export class SlotCore {
  private records = new Map<string, SlotRecord>()
  private mutateListeners = new Set<(key: string) => void>()
  // Dirty records, not keys: records are never removed, so holding the
  // reference skips a lookup (and an unreachable missing-record branch) at flush.
  private dirty = new Set<SlotRecord>()
  private flushScheduled = false

  /**
   * Record a slot's runtime spec. Registering into an undefined key throws;
   * defining an already-defined key throws (one owner per slot).
   * @param key - SlotMap key.
   * @param spec - kind/scope spec matching the declaration.
   * @returns disposer removing the definition and its entries (idempotent; a
   * stale disposer after redefine is a no-op).
   */
  define<K extends keyof SlotMap & string>(key: K, spec: SlotSpec<SlotMap[K]>): () => void {
    const rec = this.record(key)
    if (rec.spec) throw new Error(`slot "${String(key)}" is already defined`)
    const recorded: SlotSpec<SlotEntryDef> = spec
    rec.spec = recorded
    this.markDirty(key, rec)
    return () => {
      if (rec.spec !== recorded) return
      rec.spec = undefined
      rec.entries = NO_ENTRIES
      this.markDirty(key, rec)
    }
  }

  /**
   * Contribute a component to a defined slot. single: duplicate registration
   * throws; keyed: missing or duplicate `options.key` throws; list: missing or
   * duplicate `options.id` throws (duplicates would make `only`/`entryKey`
   * dispatch ambiguous).
   * @param key - SlotMap key.
   * @param component - component honoring the entry's composed props contract (owner & standard & injected shares).
   * @param args - kind-shaped registration options; statically mandatory for keyed/list (key/id live there).
   * @returns disposer removing the registration (idempotent; a stale disposer
   * after the slot's define disposer ran is a no-op).
   */
  register<K extends keyof SlotMap & string, I extends object = Record<string, unknown>, Ctx = unknown>(
    // NoInfer pins I's inference to the inject factory: letting the component
    // position drive I would absorb any props drift into the constraint.
    // Ctx flows from the options' inject-factory parameter annotation
    // (narrowing wrappers fix it; the core stays context-agnostic).
    key: K, component: SlotComponent<ComposedProps<K, NoInfer<I>>>, ...args: RegisterArgs<SlotMap[K], I, Ctx>): () => void {
    const rec = this.records.get(key)
    if (!rec?.spec) throw new Error(`slot "${String(key)}" is not defined`)
    const opts = (args[0] ?? {}) as StoredEntry['options']
    // keyed/list options are statically mandatory (RegisterArgs); the runtime
    // checks below stay for dynamically-composed callers.
    switch (rec.spec.kind) {
      case 'single':
        if (rec.entries.length > 0) throw new Error(`single slot "${String(key)}" already has a registration`)
        break
      case 'keyed':
        if (opts.key === undefined) throw new Error(`keyed slot "${String(key)}" requires options.key`)
        if (rec.entries.some(e => e.options.key === opts.key)) {
          throw new Error(`keyed slot "${String(key)}" already has an entry for key "${opts.key}"`)
        }
        break
      case 'list':
        if (opts.id === undefined) throw new Error(`list slot "${String(key)}" requires options.id`)
        if (rec.entries.some(e => e.options.id === opts.id)) {
          throw new Error(`list slot "${String(key)}" already has an entry with id "${opts.id}"`)
        }
        break
    }
    const entry: StoredEntry = { component, options: opts }
    const next = [...rec.entries, entry]
    // Stable sort: order ascending, ties keep registration sequence.
    if (rec.spec.kind === 'list') next.sort((a, b) => (a.options.order ?? 0) - (b.options.order ?? 0))
    rec.entries = next
    this.markDirty(key, rec)
    return () => {
      if (!rec.entries.includes(entry)) return
      rec.entries = rec.entries.filter(e => e !== entry)
      this.markDirty(key, rec)
    }
  }

  /**
   * Snapshot the registered entries for a key. Returns the cached array
   * reference (stable between mutations — safe as a uSES getSnapshot source);
   * empty for keys not (or no longer) defined, so renderers may probe ahead of
   * plugin load order.
   * @param key - SlotMap key.
   * @returns entries in registration (list: order) sequence.
   */
  entries<K extends keyof SlotMap & string>(key: K): readonly SlotEntry<SlotMap[K]>[] {
    return (this.records.get(key)?.entries ?? NO_ENTRIES) as unknown as readonly SlotEntry<SlotMap[K]>[]
  }

  /**
   * Look up a slot's defined spec, narrowed by the SlotMap key.
   * @param key - SlotMap key.
   * @returns the spec, or undefined before define.
   */
  spec<K extends keyof SlotMap & string>(key: K): SlotSpec<SlotMap[K]> | undefined {
    return this.records.get(key)?.spec as SlotSpec<SlotMap[K]> | undefined
  }

  /**
   * Dynamic-key escape hatch for spec lookup — renderers resolving keys they
   * only hold as strings (generic dispatch) use this wide form; statically
   * keyed callers use {@link SlotCore.spec}.
   * @param key - candidate slot key.
   * @returns the wide-typed spec, or undefined before define.
   */
  specDynamic(key: string): SlotSpec<SlotEntryDef> | undefined {
    return this.records.get(key)?.spec
  }

  /**
   * Subscribe to registration changes for a key (microtask-batched).
   * Subscribing ahead of define is allowed; the define itself notifies.
   * @param key - SlotMap key.
   * @param fn - change callback.
   * @returns unsubscribe.
   */
  subscribe(key: keyof SlotMap & string, fn: () => void): () => void {
    const rec = this.record(key)
    rec.listeners.add(fn)
    return () => { rec.listeners.delete(fn) }
  }

  /**
   * Monotonic version for a key, bumped synchronously per mutation so a
   * uSES getSnapshot read is never stale when its batched notification lands.
   * @param key - SlotMap key.
   * @returns current version (0 for untouched keys).
   */
  getVersion(key: keyof SlotMap & string): number {
    return this.records.get(key)?.version ?? 0
  }

  /**
   * Hook every mutation (the runtime Service wrapper bridges this to ctx.emit).
   * Fires synchronously per mutation, unbatched — event semantics need one
   * emission per change.
   * @param fn - called with the mutated key.
   * @returns unsubscribe.
   */
  onMutate(fn: (key: string) => void): () => void {
    this.mutateListeners.add(fn)
    return () => { this.mutateListeners.delete(fn) }
  }

  private record(key: string): SlotRecord {
    let rec = this.records.get(key)
    if (!rec) {
      rec = { spec: undefined, entries: NO_ENTRIES, version: 0, listeners: new Set() }
      this.records.set(key, rec)
    }
    return rec
  }

  private markDirty(key: string, rec: SlotRecord): void {
    rec.version += 1
    for (const fn of [...this.mutateListeners]) fn(key)
    this.dirty.add(rec)
    if (!this.flushScheduled) {
      this.flushScheduled = true
      queueMicrotask(() => { this.flush() })
    }
  }

  private flush(): void {
    // Reset before iterating so a mutation from inside a listener re-schedules.
    this.flushScheduled = false
    const dirty = [...this.dirty]
    this.dirty.clear()
    for (const rec of dirty) {
      for (const fn of [...rec.listeners]) fn()
    }
  }
}

/**
 * Whitelist-narrowed render surface handed to owner components via props
 * (implementation lives in web-react's scopedSlots factory).
 */
export interface ScopedSlots<K extends keyof SlotMap & string> {
  /**
   * Render a slot's registered entries.
   * @param key - whitelisted SlotMap key.
   * @param props - owner-supplied share of the entry's props contract.
   * @param opts - render options.
   * @returns rendered node(s).
   */
  renderSlot: <Key extends K>(key: Key, props: OwnerOf<Key>, opts?: RenderOpts) => ReactNode
  /**
   * Phantom variance anchor (never materialized at runtime): generic method
   * signatures compare loosely across differing key-union constraints, so
   * this contravariant marker is what actually enforces "a surface is
   * assignable only where its whitelist covers the target's keys".
   */
  readonly __accepts?: ((key: K) => void) | undefined
}

/** renderSlot options: keyed dispatch key, list filtering, empty fallback. */
export interface RenderOpts { entryKey?: string; only?: string; fallback?: ReactNode }

/**
 * Narrow a slots surface to a subset whitelist for delegation to a child
 * component (`K2` ⊆ `K1`). Pure type narrowing — ScopedSlots is covariant in
 * its key union, so the same object is returned.
 * @param slots - the owner's wider surface.
 * @returns the same surface, typed to the subset.
 */
export function narrowSlots<K2 extends K1, K1 extends keyof SlotMap & string>(
  slots: ScopedSlots<K1>): ScopedSlots<K2> {
  return slots
}

/**
 * The owner-supplied share of an entry's props. `useSession` is excluded (the
 * framework injects it on session slots; owners must not shadow the bound
 * hook). Registrant inject keys are per-registration and unknowable at the
 * type level, so the remaining share stays Partial rather than exact.
 */
export type OwnerProps<E extends SlotEntryDef> =
  E extends { props: infer P extends object } ? Partial<Omit<P, 'useSession'>> : object
