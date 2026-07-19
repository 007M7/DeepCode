/** Package-owned runtime contracts for @deepseek-ai/dsh-home. @module @deepseek-ai/dsh-home/invariant */

/* jscpd:ignore-start */
import { resolve } from 'node:path'
import type { Context } from 'cordis'
import { assertInvariant, type InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-home'

/** Cordis companion plugin name. */
export const name = 'home-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** Assert the canonical environment key and configured-path precedence. */
const install: InvariantInstaller = async (_ctx, fail) => {
  const { DSH_HOME_ENV, resolveDshHome } = await import('./index.ts')
  const environmentKey: string = DSH_HOME_ENV
  assertInvariant(fail, environmentKey === ['DSH', 'HOME'].join('_'),
    'the canonical Harness home environment key must remain DSH_HOME')
  const configured = 'relative-invariant-home'
  assertInvariant(fail, resolveDshHome(configured) === resolve(configured),
    'an explicitly configured Harness home must normalize to an absolute path')
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
