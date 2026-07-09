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

import type { Context } from 'cordis'
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
   * registration disposer. Idempotent and always awaitable — a repeat call
   * resolves immediately (the underlying Cordis disposer is single-shot and
   * returns undefined the second time; this wrapper Promise-normalizes it).
   * After disposal the scoped context is inert — a further registration
   * through it throws Cordis's INACTIVE_EFFECT.
   * @returns for the call that initiates teardown: resolves when every
   *   registration's disposer has settled. A repeat/racing call resolves
   *   immediately WITHOUT awaiting the in-flight teardown (the underlying
   *   Cordis disposer is single-shot) — a caller needing a shared quiescence
   *   boundary across racing disposers keeps its own completion promise (the
   *   agent factory's pattern).
   */
  dispose(): Promise<void>
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
 * capability; see `Agent.ctx` in `@deepseek-ai/dsh-agent` for the harness's
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
  if (typeof key !== 'object' || key === null) {
    throw new TypeError('createScope: key must be an object (scope keys are identity-compared)')
  }
  const fiber = ctx.plugin(scope)
  const scoped: Context = fiber.ctx.extend({ [kScope]: key })
  return {
    ctx: scoped,
    // fiber.dispose IS the disposer Cordis pushed onto the minting fiber's
    // disposable list — the identity a composite effect must yield (see
    // Scope.rawDispose).
    rawDispose: fiber.dispose,
    // Promise.resolve-normalized: a cordis fiber's dispose returns undefined
    // on a repeat call (the epoch is already cleared), and Scope.dispose
    // promises an awaitable on every call.
    dispose: () => Promise.resolve(fiber.dispose()),
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
 * Build the dispatch carrier for a scope-filtered event: `base` overlaid with
 * a `Context.filter` that admits a listener iff
 *
 * - its registering context is UNTAGGED (a context-global listener — the
 *   compatibility default: plain plugin listeners see every subject), or
 * - its tag IS `key` (a scoped listener seeing exactly its own subject),
 *
 * AND `base`'s own filter (a Cordis `Service`'s isolation check) also admits
 * it. Dispatching with `key === undefined` — a subject-less dispatch, e.g. a
 * tool call with no calling agent or a bare (agent-less) session's events —
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
 * tell a carrier from a bare subject.
 * @param base - the object the event is dispatched on behalf of (the owning
 *   service, or the subject agent itself); its own `Context.filter` is
 *   preserved and composed.
 * @param key - the subject's scope key, or `undefined` for a subject-less
 *   dispatch.
 * @returns the carrier to pass as the dispatch `thisArg`.
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
  // A hand-rolled proxy, NOT cordis withProps: withProps delegates gets with
  // the PROXY as receiver, so a getter on `base` runs with proxy `this` and a
  // method call through the carrier gets a proxy receiver — either one throws
  // on a native `#private` field of the subject (TypeError: private member
  // not declared). Cordis hands the carrier to listeners as `this`, and the
  // event declarations type it `Scoped<Agent>` — so subject method calls
  // through it are a SUPPORTED shape and must reach the real object: gets
  // delegate with `base` as receiver, functions come back bound to `base`,
  // and sets land on `base` directly.
  return new Proxy(base, {
    get(target, prop) {
      // Proxy get invariants pin what this trap may report for a
      // non-configurable OWN property of the base: a non-writable data prop
      // must be reported AS-IS (neither overlaid nor bound), a getterless
      // accessor as undefined — checked FIRST so even an overlay key
      // colliding with a frozen own prop of a (pathological) base yields the
      // base's value instead of an engine TypeError. Such a base forgoes
      // scope filtering; no production base freezes these keys.
      const own = Reflect.getOwnPropertyDescriptor(target, prop)
      const pinned = own !== undefined && own.configurable === false
        && own.get === undefined && own.writable !== true
      // hasOwn, not `in`: the overlay literal inherits Object.prototype, so
      // `in` would claim `toString`/`constructor` and shadow the subject's.
      if (!pinned && Object.hasOwn(overlay, prop)) return overlay[prop]
      const value: unknown = Reflect.get(target, prop, target)
      if (typeof value !== 'function' || pinned) return value
      // `constructor` is looked up, never invoked as a subject method — keep
      // the real one (withProps special-cases it the same way), so
      // `carrier.constructor` still identifies the subject's class.
      if (prop === 'constructor') return value
      // `Function.prototype.bind` types as `any`; the value is structurally
      // T[prop] and the trap's contract is untyped (`any`), so unknown is the
      // honest safe return.
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
   * @returns resolves when all collected disposers have settled (first call;
   *   a repeat call resolves immediately — single-shot, like Scope.dispose).
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
  return {
    mint: (key: ScopeKey) => createScope(host, key),
    dispose: () => Promise.resolve(fiber.dispose()),
  }
}
