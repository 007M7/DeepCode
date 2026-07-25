/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-host-webserver`.
 * @module @deepseek-ai/dsh-host-webserver/invariant
 */

/* jscpd:ignore-start */
import type { Context } from 'cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-webserver'

/** Cordis companion plugin name. */
export const name = 'host-webserver-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * Owned relation: the web plugin registry's boot entry graph must stay
 * self-consistent — every row must resolve a clientPath under the same id
 * (the /plugins/<id>/client.js URL it advertises would otherwise 404 on a
 * browser that just received the graph). Checked synchronously on every
 * rescan trigger (cordis 'internal/plugin'): graph() and clientPath() read
 * the same table object, so the relation is self-consistent at any instant —
 * no need to wait out the registry's own debounced rescan. The registry
 * arrives through the context key the assembly publishes it under.
 */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.on('internal/plugin', () => {
    const registry = ctx.get('webPlugins') as
      | {
        graph(): { entries: { id: string; url: string }[] }
        clientPath(id: string): string | undefined
      }
      | undefined
    if (registry === undefined) return // carrier-only deployments never publish the registry
    for (const row of registry.graph().entries) {
      if (registry.clientPath(row.id) === undefined) {
        fail(`web plugin graph row "${row.id}" advertises ${row.url} but resolves no client bundle path — the served __DSH_BOOT__ would 404 on fetch`)
      }
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
/* jscpd:ignore-end */
