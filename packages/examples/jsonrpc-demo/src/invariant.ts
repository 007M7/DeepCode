/** Package-owned runtime contract for @deepseek-ai/dsh-jsonrpc-demo. @module @deepseek-ai/dsh-jsonrpc-demo/invariant */

/* jscpd:ignore-start */
import type { Context } from 'cordis'
import { assertInvariant, type InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-jsonrpc-demo'

/** Cordis companion plugin name. */
export const name = 'jsonrpc-demo-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** Assert that Loader configuration, rather than a hidden root plugin, owns composition. */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.effect(async () => {
    const packageEntry = await import('./index.ts')
    assertInvariant(fail, Object.keys(packageEntry).length === 0,
      'the JSON-RPC demo library entrypoint must remain empty because cordis.yml owns composition')
    return () => {}
  }, 'jsonrpc-demo: validate bin-only entrypoint')
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
