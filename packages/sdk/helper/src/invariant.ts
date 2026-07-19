/** Package-owned runtime contracts for @deepseek-ai/dsh-helper. @module @deepseek-ai/dsh-helper/invariant */

/* jscpd:ignore-start */
import type { Context } from 'cordis'
import { assertInvariant, type InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-helper'

/** Cordis companion plugin name. */
export const name = 'helper-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** Assert FeatureId's zero-cost representation and boundary validation. */
const install: InvariantInstaller = async (_ctx, fail) => {
  const { featureId } = await import('./ids.ts')
  assertInvariant(fail, featureId('local-plugin') === 'local-plugin',
    'a valid feature id must preserve its runtime string value')
  let rejected = false
  try {
    featureId('Invalid Feature')
  } catch (error) {
    rejected = error instanceof Error
  }
  assertInvariant(fail, rejected, 'feature ids must reject values outside lowercase kebab-case')
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
