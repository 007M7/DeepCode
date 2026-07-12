/**
 * Scoped-context primitive: mint a Cordis context that TAGS everything
 * registered through it with an opaque {@link ScopeKey}, and dispatch events so
 * listeners registered through such a context fire only for their key's
 * subject. Scope-aware registries (`ctx.tools`, `ctx.systemPrompt`) read the
 * tag via {@link scopeOf} to file a registration in the right layer; the agent
 * loop is the one scope MINTER today (one scope per live agent, key = the
 * `Agent` object — see `Agent.ctx` in `@deepseek-ai/dsh-agent`), but the
 * mechanism is key-agnostic by design so packages below the agent layer
 * (`dsh-session`, `dsh-system-prompt`) can depend on it without a dependency
 * cycle.
 *
 * Ownership and visibility derive from ONE fact — which context a registration
 * went through: the scope's fiber owns the disposal (a `ctx.effect()`/
 * `ctx.on()`/registry call through the scoped context unwinds on
 * {@link Scope.dispose}, because Cordis routes a service method's `this.ctx`
 * to the ACCESSING context), and the tag decides who sees it. Splitting those
 * two — an explicit `{ scope }` registration parameter — would let a caller
 * express "visible to X, disposed with Y", which is almost always a bug; the
 * scoped context makes it unrepresentable.
 *
 * @module @deepseek-ai/dsh-scope
 */

import type { Context, Fiber } from 'cordis'
import { Context as CordisContext } from 'cordis'

// Capture the invocation primordials once. A carrier holder can reach the
// composed Context.filter function, so neither that function's mutable
// property surface nor a base filter's own `.call` may choose how listener-
// selection predicates are invoked.
const reflectApply = Reflect.apply
// eslint-disable-next-line @typescript-eslint/unbound-method
const functionCall = Function.prototype.call

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
 * Mounts a runtime fiber (`ctx.plugin`) and tags a child of its context with
 * `key`. The fiber is usable synchronously — Cordis activates it on a
 * microtask, but effect collection is uid-gated (not state-gated) and service
 * resolution falls through the pending fiber to the MINTING plugin's
 * dependency surface, so a caller may register through {@link Scope.ctx} the
 * moment this returns.
 *
 * Service resolution through the scoped context flows through the minting
 * plugin's dependency chain (the fiber walk), regardless of what the eventual
 * holder's own fiber injected — handing out the scoped context hands out that
 * dependency surface; see `Agent.ctx` in `@deepseek-ai/dsh-agent` for the harness's
 * contract.
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

/** Whether a callable has JavaScript's internal construction capability. */
function isConstructable(value: (...args: unknown[]) => unknown): boolean {
  try {
    // A Proxy has [[Construct]] iff its target does. Its trap returns before
    // the engine invokes `value` or reads `value.prototype`, so a hostile but
    // constructable callable cannot be mistaken for a non-constructor.
    Reflect.construct(new Proxy(value, { construct: () => ({}) }), [])
    return true
  } catch {
    // The harmless outer trap leaves lack of [[Construct]] as the only failure.
    return false
  }
}

/**
 * Build the dispatch carrier for a scope-filtered event: `base` overlaid with
 * a `Context.filter` that admits a listener iff
 *
 * - its registering context is UNTAGGED (a context-global listener — the
 *   compatibility default: plain plugin listeners see every subject), or
 * - its tag IS `key` (a scoped listener seeing exactly its own subject),
 *
 * AND `base`'s own filter (a Cordis `Service`'s listener-filter check) also admits
 * it. Both the captured base filter and the composed filter are invoked
 * through captured JavaScript primordials, so mutating either function's
 * public `.call` property cannot bypass either predicate. Dispatching with
 * `key === undefined` — a subject-less dispatch, e.g. a tool call with no
 * calling agent or a bare (agent-less) session's events —
 * admits only untagged listeners: a scoped listener never fires for someone
 * else's (or nobody's) subject. Listeners registered `{ global: true }`
 * bypass all filtering (Cordis semantics).
 *
 * Use it as the `thisArg` of the dispatch:
 * `ctx.waterfall(scopeTarget(this, exec.agent), 'tools/pre-execute', …)`. The
 * carrier is a TRANSPARENT proxy over `base`: reads delegate with `base` as
 * the receiver and retrieved methods are bound to `base`, so a listener may
 * call subject methods through its `this` (`this.send(…)` on a
 * `Scoped<Agent>`) even when the subject uses native `#private` fields — a
 * bare proxy receiver would throw on those. Identity is still not
 * transparent: `this !== subject` and method identity varies per read; the
 * subject always travels in the event's arguments. The returned carrier is
 * branded {@link Scoped} and runtime-marked ({@link isScopeCarrier} /
 * {@link carrierKeyOf}) so both the type system and the dev invariants can
 * tell a carrier from a bare subject. Defining an ordinary property through
 * the carrier is supported only when its descriptor explicitly says
 * `configurable: true`; an omitted or false flag is rejected before touching
 * `base`, because the extensible surrogate cannot truthfully report a new
 * non-configurable base property.
 * @param base - the object the event is dispatched on behalf of (the owning
 *   service, or the subject agent itself); its own `Context.filter` is
 *   preserved and composed.
 * @param key - the subject's scope key, or `undefined` for a subject-less
 *   dispatch.
 * @returns the carrier to pass as the dispatch `thisArg`.
 */
export function scopeTarget<T extends object>(base: T, key: ScopeKey | undefined): Scoped<T> {
  const baseFilter: unknown = (base as { [CordisContext.filter]?: unknown })[CordisContext.filter]
  if (baseFilter !== undefined && typeof baseFilter !== 'function') {
    throw new TypeError('scope target Context.filter must be a function when present')
  }
  const filter = (ctx: Context): boolean => {
    if (baseFilter && !reflectApply(functionCall, baseFilter, [base, ctx])) return false
    const tag = scopeOf(ctx)
    return tag === undefined || tag === key
  }
  // Cordis invokes a dispatch filter as `filter.call(thisArg, listenerCtx)`.
  // Pin that property to the captured primordial, then freeze the callable so
  // a carrier holder cannot replace it with an always-true scope bypass.
  Object.defineProperty(filter, 'call', {
    value: functionCall,
    writable: false,
    configurable: false,
  })
  Object.freeze(filter)
  const overlay: Record<string | symbol, unknown> = {
    [CordisContext.filter]: filter,
    [kCarrier]: Object.freeze({ key }),
  }
  // Use a dedicated extensible proxy TARGET, never `base` itself. Proxy get
  // invariants force a trap to return a base's non-configurable/non-writable
  // own value verbatim; if a caller pinned Context.filter during or after
  // construction, a base-target proxy would therefore silently replace the
  // composed scope predicate with the caller's filter. The surrogate owns the
  // two immutable overlay slots, so later descriptor changes on `base` cannot
  // affect listener selection. It shares the base prototype and delegates ordinary
  // reads/writes/keys to preserve the supported transparent shape. Callable
  // targets use native bound built-ins so V8 contributes no user-code surface;
  // the chosen built-in matches whether `base` has [[Construct]], and the traps
  // below delegate the actual call/construction to `base`.
  const callableBase = typeof base === 'function'
    ? base as unknown as (...args: unknown[]) => unknown
    : undefined
  const constructable = callableBase !== undefined && isConstructable(callableBase)
  const target: object = callableBase === undefined
    ? {}
    : constructable
      ? Object.bind(undefined)
      : Math.max.bind(undefined)
  Reflect.setPrototypeOf(target, Reflect.getPrototypeOf(base))
  Object.defineProperties(target, {
    [CordisContext.filter]: {
      value: filter,
      enumerable: false,
      writable: false,
      configurable: false,
    },
    [kCarrier]: {
      value: overlay[kCarrier],
      enumerable: false,
      writable: false,
      configurable: false,
    },
  })
  const carrier = new Proxy(target, {
    get(target, prop) {
      // The callable surrogate has engine-owned pinned properties (`prototype`,
      // `caller`, …); honor those target invariants. For object carriers the
      // only pinned target properties are the exact overlay values above.
      const own = Reflect.getOwnPropertyDescriptor(target, prop)
      const pinned = own !== undefined && own.configurable === false
        && own.get === undefined && own.writable !== true
      if (pinned) {
        const value: unknown = Reflect.get(target, prop, target)
        return value
      }
      const value: unknown = Reflect.get(base, prop, base)
      if (typeof value !== 'function') return value
      // `constructor` is looked up, never invoked as a subject method — keep
      // the real one (withProps special-cases it the same way), so
      // `carrier.constructor` still identifies the subject's class.
      if (prop === 'constructor') return value
      // `Function.prototype.bind` types as `any`; the value is structurally
      // T[prop] and the trap's contract is untyped (`any`), so unknown is the
      // honest safe return.
      return value.bind(base) as unknown
    },
    set(_target, prop, value) {
      if (Object.hasOwn(overlay, prop)) return false
      return Reflect.set(base, prop, value, base)
    },
    has(_target, prop) {
      // A Proxy may not hide a non-configurable target key. Configurable
      // surrogate-only keys (bound-function name/length) are omitted; the
      // base's own/inherited surface remains authoritative.
      const own = Reflect.getOwnPropertyDescriptor(target, prop)
      return own?.configurable === false || Reflect.has(base, prop)
    },
    ownKeys(target) {
      const requiredTargetKeys = Reflect.ownKeys(target).filter((prop) => {
        return Reflect.getOwnPropertyDescriptor(target, prop)?.configurable === false
      })
      return [...new Set([...requiredTargetKeys, ...Reflect.ownKeys(base)])]
    },
    getOwnPropertyDescriptor(target, prop) {
      const targetDescriptor = Reflect.getOwnPropertyDescriptor(target, prop)
      if (targetDescriptor?.configurable === false) return targetDescriptor
      const baseDescriptor = Reflect.getOwnPropertyDescriptor(base, prop)
      if (baseDescriptor !== undefined) return { ...baseDescriptor, configurable: true }
      // Configurable surrogate-only function metadata is intentionally hidden.
      return undefined
    },
    defineProperty(_target, prop, attributes) {
      if (Object.hasOwn(overlay, prop) || attributes.configurable !== true) return false
      return Reflect.defineProperty(base, prop, attributes)
    },
    deleteProperty(_target, prop) {
      if (Object.hasOwn(overlay, prop)) return false
      return Reflect.deleteProperty(base, prop)
    },
    preventExtensions() {
      // Keeping the surrogate extensible is required for ownKeys to report
      // caller-owned base fields that may change over the carrier's lifetime.
      return false
    },
    setPrototypeOf() {
      // The carrier prototype and base delegation must not be split.
      return false
    },
    apply(_target, thisArg, args) {
      const callable = callableBase as (...values: unknown[]) => unknown
      const result: unknown = Reflect.apply(callable, thisArg, args)
      return result
    },
    construct(_target, args, newTarget) {
      const constructor = callableBase as unknown as new (...values: unknown[]) => object
      const result: unknown = Reflect.construct(
        constructor,
        args,
        newTarget === carrier ? constructor : newTarget,
      )
      return result as object
    },
  })
  return carrier as Scoped<T>
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
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false
  // A property read checks the immutable marker owned by the surrogate target.
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
 * Mount a scope-minting host plugin that injects `services`, THE sanctioned
 * way to mint scopes in tests (production scopes are minted by the agent
 * loop). Exists because the naive spelling fails confusingly twice over:
 * a plugin with no `inject` mints scopes whose service reads throw Cordis's
 * cryptic `cannot get property … without inject`, and a plugin whose inject
 * can never be satisfied RESOLVES its fiber await without ever running the
 * callback — a silent no-op host. This helper fails LOUD instead: when the
 * callback did not run, it names the absent services and disposes the host.
 * The service list is copied before plugin activation so caller mutation
 * across the await cannot change dependency resolution or diagnostics.
 * @param ctx - the context to mount the host under.
 * @param services - the service names scopes minted through this host reach
 *   (the host plugin's `inject` list).
 * @returns the host (mint scopes, dispose them all at once).
 * @throws when any of `services` is not available on `ctx` — named, not the
 *   Cordis dead end.
 */
export async function scopeHost(ctx: Context, services: string[]): Promise<ScopeHost> {
  // The inject list crosses an await before missing-service diagnostics run.
  // Detach it now so caller mutation cannot change either Cordis dependency
  // resolution or the names reported by this helper.
  const requiredServices = [...services]
  let hostCtx: Context | undefined
  // A named function statement (not Object.assign({name}) — Function.name is
  // read-only) so diagnostics read `scopeHost`.
  function scopeHostPlugin(inner: Context): void { hostCtx = inner }
  const fiber = ctx.plugin(Object.assign(scopeHostPlugin, { inject: requiredServices }))
  await fiber
  if (hostCtx === undefined) {
    // Dependency-pending: cordis resolves the await without running the
    // callback. Name the absentees and unwind the pending fiber.
    const missing = requiredServices.filter(name => ctx.get(name) === undefined)
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
    // Start every boundary before awaiting any one of them. A child whose raw
    // disposer already ran is still followed through Scope.dispose(); a child
    // the host unload claims first is followed through the same fiber inertia.
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
