/** Package-owned runtime contract for @deepseek-ai/dsh-brand. @module @deepseek-ai/dsh-brand/invariant */

/* jscpd:ignore-start */
import type { Context } from 'cordis'
import { assertInvariant, type InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-brand'

/** Cordis companion plugin name. */
export const name = 'brand-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** Assert that the nominal-type primitive remains erased at runtime. */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.effect(async () => {
    const brandRuntime = await import('./index.ts')
    assertInvariant(fail, Object.keys(brandRuntime).length === 0,
      'the branded-id primitive must remain type-only with no runtime exports')
    return () => {}
  }, 'brand: validate type-only runtime erasure')
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
