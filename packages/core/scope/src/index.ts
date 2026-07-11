/**
 * Scoped-context primitive: mint a Cordis context that TAGS everything registered through it
 * with an opaque {@link ScopeKey}, and dispatch events so listeners registered through such a
 * context fire only for their key's subject.
 * @module @deepseek-ai/dsh-scope
 */

import type { Context, Fiber } from 'cordis'
import { Context as CordisContext } from 'cordis'

/**
 * The identity a scope is keyed by. Opaque and compared by object identity —
 * never inspected. The harness convention: a live `Agent` is the key of its
 * own scope, so seam vocabularies that already carry the agent
 * (`ToolExecution.agent`, `AssembleContext.scope`) name the layer directly.
 */
export type ScopeKey = object

/** The context tag {@link createScope} writes and {@link scopeOf} reads (module-private). */
const kScope = Symbol('dsh.scope')

/** The carrier mark {@link scopeTarget} writes and {@link carrierKeyOf} reads (module-private). */
const kCarrier = Symbol('dsh.scope.carrier')

declare const ScopedBrand: unique symbol

/**
 * A dispatch carrier built by {@link scopeTarget}: structurally the `base` it
 * overlays, branded so scope-filtered events can DEMAND a carrier as their
 * `this` type — passing a bare subject where a `Scoped<T>` is required is a
 * compile error, which is what makes "forgot the carrier" unrepresentable at
 * dispatch sites. The brand is compile-time only; {@link isScopeCarrier} is
 * the runtime counterpart (used by the dev invariants).
 */
export type Scoped<T> = T & { readonly [ScopedBrand]: 'dsh.scope.carrier' }

/**
 * A minted scope: the tagged context to register through, plus the disposers
 * that unwind every registration made through it.
 */
export interface Scope {
  /**
   * The scoped context. Registrations through it are tagged with the scope's
   * key (scope-aware registries file them in that key's layer; `ctx.on`
   * listeners fire only for dispatches targeted at that key) and owned by the
   * scope's fiber (disposed together on {@link dispose}). Contexts DERIVED
   * from it — an `extend`, a fiber mounted under it — inherit the tag through
   * the prototype chain.
   */
  ctx: Context
  /**
   * The EXACT disposer Cordis registered on the minting fiber for the scope's
   * backing fiber. A composite (generator) effect that owns the scope's
   * position in an ordered teardown must yield THIS function: Cordis dedupes a
   * nested effect out of the parent's concurrent disposal list by function
   * identity, so yielding a wrapper would leave the scope disposing as an
   * unordered sibling. Callers outside a composite effect use {@link dispose}.
   * @returns the backing fiber's teardown promise (undefined on a repeat call
   *   — Cordis effect disposers are single-shot).
   */
  rawDispose: () => Promise<void> | void
  /**
   * Unwind the scope: dispose the backing fiber, running every collected
   * registration disposer. Idempotent and always awaitable: repeat and racing
   * calls share one completion even though the underlying Cordis disposer is
   * single-shot and returns undefined after its first invocation.
   * After disposal the scoped context is inert — a further registration
   * through it throws Cordis's INACTIVE_EFFECT.
   * @returns for the call that initiates teardown: resolves when every
   *   registration's disposer has settled. Every repeat/racing call awaits
   *   that same quiescence boundary, including when {@link rawDispose} claimed
   *   the underlying single-shot Cordis disposer first.
   */
  dispose(): Promise<void>
}

/**
 * Dispose a Cordis fiber and await its lifecycle inertia even when some other
 * caller claimed the single-shot raw disposer first. `Fiber.dispose()` returns
 * `undefined` on a repeat call, but the fiber's `inertia` remains the
 * authoritative promise while its async unload is running.
 */
async function quiesceFiber(fiber: Fiber): Promise<void> {
  await Promise.resolve(fiber.dispose())
  while (fiber.inertia !== undefined) await fiber.inertia
}

/**
 * The shared no-op plugin every scope fiber mounts: named so diagnostics read
 * `scope` and shared so all scopes join ONE plugin runtime (Cordis deletes the
 * runtime record when its last fiber disposes, so idle deployments carry no
 * residue).
 */
function scope(): void {}

/**
 * Mint a registration scope for `key` under `ctx`.
 *
 * @param ctx - the context to mount the scope under; its fiber must be active
 *   (a disposing owner throws Cordis's INACTIVE_EFFECT), and its plugin's
 *   `inject` surface is what the scoped context resolves services against.
 * @param key - the scope's identity ({@link ScopeKey}); must be an object
 *   (identity-compared), else this throws.
 * @returns the tagged context plus its disposers ({@link Scope}).
 */
export function createScope(ctx: Context, key: ScopeKey): Scope {
  // Runtime guard behind the ScopeKey type: callers outside the typechecker
  // (yml-configured plugins, JS consumers) can still pass a primitive.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if ((typeof key !== 'object' && typeof key !== 'function') || key === null) {
    throw new TypeError('createScope: key must be a non-null object or function (scope keys are identity-compared)')
  }
  const fiber = ctx.plugin(scope)
  const scoped: Context = fiber.ctx.extend({ [kScope]: key })
  let disposing: Promise<void> | undefined
  return {
    ctx: scoped,
    // fiber.dispose IS the disposer Cordis pushed onto the minting fiber's
    // disposable list — the identity a composite effect must yield (see
    // Scope.rawDispose).
    rawDispose: fiber.dispose,
    // Memoize the public boundary and explicitly follow fiber inertia: the raw
    // disposer must remain the exact Cordis function for ordered composition,
    // so it cannot itself be wrapped to record a raw-first invocation.
    dispose: () => (disposing ??= quiesceFiber(fiber)),
  }
}

/**
 * Read the scope key a context is tagged with, or `undefined` for an untagged
 * (context-global) context. Walks the prototype chain, so any context DERIVED
 * from a scoped context — service shadows, `extend`s, fibers mounted under it
 * — reads as that scope; with nested scopes the nearest tag wins.
 * @param ctx - the context to inspect (typically a registry method's
 *   `this.ctx`, i.e. the ACCESSING context).
 * @returns the key given to {@link createScope}, or `undefined` when the
 *   context is not derived from any scope.
 */
export function scopeOf(ctx: Context): ScopeKey | undefined {
  // A plain (possibly proxied) property read: symbols bypass the Cordis
  // context proxy's service resolution, and Reflect walks the prototype chain.
  return (ctx as Context & { [kScope]?: ScopeKey })[kScope]
}

/**
 * Build an event receiver admitting global listeners plus listeners tagged with `key`.
 * The proxy preserves `base` filtering and binds subject methods to `base`.
 * @param base - dispatch subject whose filter is preserved.
 * @param key - subject scope, or `undefined` for global-only delivery.
 * @returns branded receiver for the dispatch `thisArg`.
 */
export function scopeTarget<T extends object>(base: T, key: ScopeKey | undefined): Scoped<T> {
  const baseFilter = (base as { [CordisContext.filter]?: (ctx: Context) => boolean })[CordisContext.filter]
  const filter = (ctx: Context): boolean => {
    if (baseFilter && !baseFilter.call(base, ctx)) return false
    const tag = scopeOf(ctx)
    return tag === undefined || tag === key
  }
  const overlay: Record<string | symbol, unknown> = {
    [CordisContext.filter]: filter,
    [kCarrier]: { key },
  }
  // Bind through the real subject so native private fields remain accessible.
  return new Proxy(base, {
    get(target, prop) {
      // Non-configurable own properties must be reported unchanged.
      const own = Reflect.getOwnPropertyDescriptor(target, prop)
      const pinned = own !== undefined && own.configurable === false
        && own.get === undefined && own.writable !== true
      // `in` would let Object.prototype shadow subject properties.
      if (!pinned && Object.hasOwn(overlay, prop)) return overlay[prop]
      const value: unknown = Reflect.get(target, prop, target)
      if (typeof value !== 'function' || pinned) return value
      // Preserve class identity.
      if (prop === 'constructor') return value
      // `bind` is typed as `any`; keep the trap boundary `unknown`.
      return value.bind(target) as unknown
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value, target)
    },
  }) as Scoped<T>
}

/**
 * Whether `value` is a carrier built by {@link scopeTarget} — the runtime
 * counterpart of the {@link Scoped} brand, used by the dev invariants to
 * assert that a scope-filtered event was dispatched with a carrier and not a
 * bare subject.
 * @param value - the dispatch `thisArg` to test.
 * @returns true iff `value` came from {@link scopeTarget}.
 */
export function isScopeCarrier(value: unknown): value is Scoped<object> {
  if (typeof value !== 'object' || value === null) return false
  // A property READ, not an `in` check: the carrier overlays its marks in the
  // get trap only (no `has` trap), so `kCarrier in carrier` would fall
  // through to the wrapped base and always answer false.
  return (value as { [kCarrier]?: { key: ScopeKey | undefined } })[kCarrier] !== undefined
}

/**
 * The scope key a carrier was built for — `undefined` for a subject-less
 * carrier, and also `undefined` for a non-carrier (pair with
 * {@link isScopeCarrier} when the distinction matters). The dev invariants
 * use it to assert the carrier's key IS the subject the event's arguments
 * name.
 * @param value - the dispatch `thisArg` to read.
 * @returns the `key` given to {@link scopeTarget}, or `undefined`.
 */
export function carrierKeyOf(value: unknown): ScopeKey | undefined {
  if (!isScopeCarrier(value)) return undefined
  // Optional-prop cast: the guard proves the mark is present at runtime, but
  // the Scoped<> brand carries no structural kCarrier member to narrow from.
  return (value as { [kCarrier]?: { key: ScopeKey | undefined } })[kCarrier]?.key
}

/**
 * A test/tooling host for minting scopes: one mounted plugin whose `inject`
 * list is the service surface every scope minted through it can reach.
 */
export interface ScopeHost {
  /**
   * Mint a scope under the host (see {@link createScope}); the scoped context
   * resolves exactly the host's injected services.
   * @param key - the scope's identity ({@link ScopeKey}).
   * @returns the minted scope.
   */
  mint(key: ScopeKey): Scope
  /**
   * Dispose the host fiber and with it every scope minted through it.
   * Every racing/repeat caller observes the same completion, including when a
   * child's raw disposer started before host disposal.
   * @returns resolves when the host and every minted scope have reached
   *   quiescence.
   */
  dispose(): Promise<void>
}

/**
 * Mount a scope-minting host plugin that injects `services`, THE sanctioned way to mint scopes
 * in tests (production scopes are minted by the agent loop).
 *
 * @param ctx - the context to mount the host under.
 * @param services - the service names scopes minted through this host reach
 *   (the host plugin's `inject` list).
 * @returns the host (mint scopes, dispose them all at once).
 * @throws when any of `services` is not available on `ctx` — named, not the
 *   Cordis dead end.
 */
export async function scopeHost(ctx: Context, services: string[]): Promise<ScopeHost> {
  let hostCtx: Context | undefined
  // A named function statement (not Object.assign({name}) — Function.name is
  // read-only) so diagnostics read `scopeHost`.
  function scopeHostPlugin(inner: Context): void { hostCtx = inner }
  const fiber = ctx.plugin(Object.assign(scopeHostPlugin, { inject: services }))
  await fiber
  if (hostCtx === undefined) {
    // Dependency-pending: cordis resolves the await without running the
    // callback. Name the absentees and unwind the pending fiber.
    const missing = services.filter(name => ctx.get(name) === undefined)
    await fiber.dispose()
    /* v8 ignore next -- the '(unknown)' fallback is defensive: a pending
     * fiber with zero absent services cannot occur (an all-present inject
     * list runs the callback) */
    const named = missing.map(name => `"${name}"`).join(', ') || '(unknown)'
    throw new Error(`scopeHost: service${missing.length === 1 ? '' : 's'} ${named} not available on this context — load the providing plugin(s) before minting scopes`)
  }
  const host = hostCtx
  const scopes = new Set<Scope>()
  let disposing: Promise<void> | undefined
  const dispose = async (): Promise<void> => {
    // Start every boundary before awaiting any one of them.
    const tasks = [quiesceFiber(fiber), ...[...scopes].map(scope => scope.dispose())]
    const results = await Promise.allSettled(tasks)
    scopes.clear()
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'scopeHost: disposal failed')
  }
  return {
    mint: (key: ScopeKey) => {
      const minted = createScope(host, key)
      let disposing: Promise<void> | undefined
      const tracked: Scope = {
        ctx: minted.ctx,
        // Preserve the exact Cordis identity: only the public shared boundary
        // is wrapped to retire this child from the host's tracking set.
        rawDispose: minted.rawDispose,
        dispose: () => (disposing ??= minted.dispose().finally(() => { scopes.delete(tracked) })),
      }
      scopes.add(tracked)
      return tracked
    },
    dispose: () => (disposing ??= dispose()),
  }
}
