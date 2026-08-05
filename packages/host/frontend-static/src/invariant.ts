/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-frontend-static`.
 * @module @deepseek-ai/dsh-frontend-static/invariant
 */

import type { Context } from 'cordis'
// Empty type import carries the Loader's Fiber#entry merge read below.
import type {} from '@cordisjs/plugin-loader'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-frontend-static'

/** Cordis companion plugin name. */
export const name = 'frontend-static-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * Owned relation: the fallback seat and the owning fiber must stay symmetric —
 * after the fiber holding the seat unloads, the seat must be claimable again
 * (a stale fallback would keep serving a disposed plugin's dist). Checked on
 * every fiber teardown by probing the registerFallback single-owner contract:
 * when this package's plugin is not mounted, a claim+release cycle must
 * succeed twice; residue from a leaked disposer makes the second claim throw.
 */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.on('internal/plugin', (fiber) => {
    // Only audit teardowns of this package's own rows: while a live
    // frontend-static row legitimately holds the seat, the probe would
    // false-positive on the legitimate owner.
    if (fiber.entry?.options.name !== PACKAGE_NAME) return
    const server = ctx.get('httpServer') as
      | { registerFallback(handler: () => void): () => void }
      | undefined
    if (server === undefined) return // torn down with the webserver itself
    // The probe handlers are registered and immediately released, never invoked.
    /* v8 ignore next 4 -- the arrow bodies are dead by design */
    try {
      server.registerFallback(() => {})()
      server.registerFallback(() => {})()
    } catch {
      fail('frontend-static fallback disposer left the seat claimed — seat ownership and fiber lifecycle diverged')
    }
  }, { global: true })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
