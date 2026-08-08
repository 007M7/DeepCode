/**
 * Scoped-context primitive: mint a Cordis context that tags registrations with
 * an opaque identity and build routing-only event carriers for that identity.
 *
 * @module @deepseek-ai/dsh-scope
 */

import type { Context, Fiber } from 'cordis'
import { Context as CordisContext } from 'cordis'

export { AnonymousEntries, NamedEntries, ScopedLayers } from './store.ts'
export type { ScopeLayer } from './store.ts'

/** An opaque, identity-compared scope key. */
export type ScopeKey = object

/** Context tag written by {@link createScope}. */
const kScope = Symbol('dsh.scope')

declare const ScopedBrand: unique symbol

/**
 * A routing-only event receiver built by {@link scopeTarget}. The type
 * parameter records the subject type for dispatch checking; the carrier does
 * not expose the subject's properties. Event payloads carry the real subject.
 */
export type Scoped<T extends object> = object & { readonly [ScopedBrand]: T }

/** The key associated with each carrier. Presence distinguishes an unkeyed carrier from a non-carrier. */
const carrierKeys = new WeakMap<object, ScopeKey | undefined>()

/**
 * The enclosing scope of each key. One relation powers both directions of
 * scope nesting: registration views inherit DOWN the chain (a child scope
 * sees its ancestors' layers — {@link ScopedLayers}), and event admission
 * extends UP it (a listener tagged with an ancestor receives events dispatched
 * to a descendant key — {@link scopeTarget}).
 */
const scopeParents = new WeakMap<ScopeKey, ScopeKey>()

/**
 * Record `parent` as `key`'s enclosing scope.
 *
 * Ordinarily set once when the child scope is minted ({@link createScope}'s
 * `parent` option). Re-linking an existing key to a different parent is the
 * blank-session recompose operation: valid only while nothing produced under
 * the old parent is retained, which is the caller's contract to uphold — this
 * relation cannot see what a session logged. A link that would close a cycle
 * is rejected, because every chain consumer walks parents to the root.
 * @param key - the child scope key.
 * @param parent - its enclosing scope key.
 */
export function setScopeParent(key: ScopeKey, parent: ScopeKey): void {
  for (let cursor: ScopeKey | undefined = parent; cursor !== undefined; cursor = scopeParents.get(cursor)) {
    if (cursor === key) throw new Error('dsh-scope: scope parent link would form a cycle')
  }
  scopeParents.set(key, parent)
}

/**
 * Read one key's enclosing scope.
 * @param key - the scope key to inspect.
 * @returns its parent key, or `undefined` for a root scope.
 */
export function scopeParentOf(key: ScopeKey): ScopeKey | undefined {
  return scopeParents.get(key)
}

/**
 * The chain from a key to its root ancestor.
 * @param key - the starting key, or `undefined` for the empty chain.
 * @returns keys nearest-first: `[key, parent, grandparent, …]`.
 */
export function scopeChainOf(key: ScopeKey | undefined): ScopeKey[] {
  const chain: ScopeKey[] = []
  for (let cursor = key; cursor !== undefined; cursor = scopeParents.get(cursor)) chain.push(cursor)
  return chain
}

/** A minted registration scope and its quiescent disposal boundaries. */
export interface Scope {
  /** Context through which scope-owned registrations are made. */
  ctx: Context
  /** Exact Cordis disposer, used when nesting this scope in an ordered composite effect. */
  rawDispose: () => Promise<void> | void
  /** Dispose every scope-owned registration; racing calls await the same completion. */
  dispose(): Promise<void>
}

/** Follow a Cordis fiber through asynchronous teardown even if its raw disposer was already claimed. */
async function quiesceFiber(fiber: Fiber): Promise<void> {
  await Promise.resolve(fiber.dispose())
  while (fiber.inertia !== undefined) await fiber.inertia
}

/** Shared no-op plugin used as the backing scope fiber. */
function scope(): void {}

/** Options accepted by {@link createScope}. */
export interface CreateScopeOptions {
  /** Enclosing scope recorded via {@link setScopeParent} before the scope is usable. */
  parent?: ScopeKey
}

/**
 * Mint a scope under `ctx`. The scoped context inherits the minting plugin's
 * dependency surface and owns every registration made through it.
 * @param ctx - active context whose dependency surface the scope inherits.
 * @param key - opaque identity used for listener routing.
 * @param options - optional scope-chain placement.
 * @returns the scoped context and exact/shared disposal boundaries.
 */
export function createScope(ctx: Context, key: ScopeKey, options?: CreateScopeOptions): Scope {
  if (options?.parent !== undefined) setScopeParent(key, options.parent)
  const fiber = ctx.plugin(scope)
  const scoped: Context = fiber.ctx.extend({ [kScope]: key })
  let disposing: Promise<void> | undefined
  return {
    ctx: scoped,
    rawDispose: fiber.dispose,
    dispose: () => (disposing ??= quiesceFiber(fiber)),
  }
}

/**
 * Read the nearest scope tag inherited by a context.
 * @param ctx - context to inspect.
 * @returns its scope key, or `undefined` for an unscoped context.
 */
export function scopeOf(ctx: Context): ScopeKey | undefined {
  return (ctx as Context & { [kScope]?: ScopeKey })[kScope]
}

/**
 * Build an opaque receiver that preserves the base filter, admits untagged
 * listeners globally, and admits tagged listeners for a matching key or any
 * of its ancestors ({@link setScopeParent}): a listener owned by an enclosing
 * scope receives every descendant scope's events, which is what lets one
 * standing composition observe each of the agents composed under it. A tag
 * BELOW the dispatch key stays excluded — events flow up the chain, never
 * down.
 * @param base - subject or service whose existing Cordis filter is preserved.
 * @param key - routed scope identity, or `undefined` for an unscoped subject.
 * @returns a carrier whose subject remains available only through event arguments.
 */
export function scopeTarget<T extends object>(base: T, key: ScopeKey | undefined): Scoped<T> {
  const baseFilter = (base as { [CordisContext.filter]?: (ctx: Context) => boolean })[CordisContext.filter]
  const carrier = {
    [CordisContext.filter](ctx: Context): boolean {
      if (baseFilter !== undefined && !baseFilter.call(base, ctx)) return false
      const tag = scopeOf(ctx)
      if (tag === undefined) return true
      for (let cursor = key; cursor !== undefined; cursor = scopeParents.get(cursor)) {
        if (cursor === tag) return true
      }
      return false
    },
  }
  carrierKeys.set(carrier, key)
  return carrier as unknown as Scoped<T>
}

/**
 * Test whether a value is a scope carrier.
 * @param value - dispatch receiver to inspect.
 * @returns whether {@link scopeTarget} created it.
 */
export function isScopeCarrier(value: unknown): value is Scoped<object> {
  return typeof value === 'object' && value !== null && carrierKeys.has(value)
}

/**
 * Read a carrier's routing key.
 * @param value - dispatch receiver to inspect.
 * @returns the carrier key, or `undefined` for an unkeyed/non-carrier value.
 */
export function carrierKeyOf(value: unknown): ScopeKey | undefined {
  if (!isScopeCarrier(value)) return undefined
  return carrierKeys.get(value)
}
