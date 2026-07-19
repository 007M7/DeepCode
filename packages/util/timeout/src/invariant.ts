/** Package-owned runtime contracts for @deepseek-ai/dsh-timeout. @module @deepseek-ai/dsh-timeout/invariant */

/* jscpd:ignore-start */
import type { Context } from 'cordis'
import { assertInvariant, type InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-timeout'

/** Cordis companion plugin name. */
export const name = 'timeout-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** Assert default-before-cap arithmetic and capability-code classification. */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.effect(async () => {
    const { clampTimeout, TimeoutReason, timeoutOf } = await import('./index.ts')
    assertInvariant(fail,
      clampTimeout(undefined, 50, 30) === 30 && clampTimeout(20, 50, 30) === 20,
      'timeout resolution must apply the default before capping and preserve smaller requests')
    const reason = new TimeoutReason('INVARIANT_TIMEOUT', 25)
    assertInvariant(fail, timeoutOf({ reason }, 'INVARIANT_TIMEOUT') === reason,
      'timeout classification must recover a matching capability-owned reason')
    assertInvariant(fail, timeoutOf({ reason }, 'FOREIGN_TIMEOUT') === undefined,
      'timeout classification must reject a reason owned by another capability')
    return () => {}
  }, 'timeout: validate resolution and reason classification')
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
