/** Package-owned runtime contracts for @deepseek-ai/dsh-loader-smoke. @module @deepseek-ai/dsh-loader-smoke/invariant */

/* jscpd:ignore-start */
import type { Context } from 'cordis'
import { assertInvariant, type InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-loader-smoke'

/** Cordis companion plugin name. */
export const name = 'loader-smoke-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** Assert default source mode and plain-Node built-artifact launch resolution. */
const install: InvariantInstaller = async (_ctx, fail) => {
  const { resolveExampleLaunch, resolveExampleMode } = await import('./index.ts')
  assertInvariant(fail, resolveExampleMode('') === 'src',
    'an empty example-mode selection must preserve source-mode development')
  const launch = resolveExampleLaunch({
    srcBin: '/workspace/probe/src/bin.ts',
    mode: 'lib',
  })
  assertInvariant(fail,
    launch.command === process.execPath
      && launch.args.length === 1
      && launch.args[0] === '/workspace/probe/lib/bin.js'
      && launch.env.TSX_TSCONFIG_PATH === undefined,
    'built example launches must use plain Node, the derived lib entry, and no tsx paths map')
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
