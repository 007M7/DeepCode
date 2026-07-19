/** Package-owned runtime contracts for @deepseek-ai/dsh-hook-protocol. @module @deepseek-ai/dsh-hook-protocol/invariant */

/* jscpd:ignore-start */
import type { Context } from 'cordis'
import { assertInvariant, type InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-hook-protocol'

/** Cordis companion plugin name. */
export const name = 'hook-protocol-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** Assert blocking-exit decoding and restrictive merge precedence. */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.effect(async () => {
    const { parseHookOutput } = await import('./codec.ts')
    const { mergeHookOutputs } = await import('./merge.ts')
    const blocked = parseHookOutput(2, '', ' denied ')
    assertInvariant(fail, blocked.decision === 'block' && blocked.reason === 'denied',
      'exit 2 must decode as a block whose reason is trimmed stderr')

    const merged = mergeHookOutputs([
      { exitCode: 0, stderr: '', stdout: '', decision: 'allow', reason: 'permitted' },
      { exitCode: 0, stderr: '', stdout: '', decision: 'deny', reason: 'forbidden' },
    ])
    assertInvariant(fail, merged.decision === 'deny' && merged.reason === 'forbidden',
      'deny must override allow and retain only the winning decision reason')
    return () => {}
  }, 'hook-protocol: validate decode and merge algebra')
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
