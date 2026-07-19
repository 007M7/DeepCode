/** Package-owned runtime contracts for @deepseek-ai/dsh-scripts. @module @deepseek-ai/dsh-scripts/invariant */

/* jscpd:ignore-start */
import type { Context } from 'cordis'
import { assertInvariant, type InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-scripts'

/** Cordis companion plugin name. */
export const name = 'scripts-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** Assert the launcher's opaque post-separator forwarding boundary. */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.effect(async () => {
    const { splitForwardedArgs } = await import('./forwarding.ts')
    const plain = splitForwardedArgs(['dev', 'src/index.ts'])
    const separated = splitForwardedArgs(['dev', 'src/index.ts', '--', '--inspect', '9229'])
    assertInvariant(fail,
      plain.launcher.length === 2
        && plain.forwarded.length === 0
        && separated.launcher.length === 2
        && separated.launcher[1] === 'src/index.ts'
        && separated.forwarded.length === 2
        && separated.forwarded[0] === '--inspect'
        && separated.forwarded[1] === '9229',
      'dsh-sdk must split the first delimiter without interpreting forwarded runtime arguments')
    return () => {}
  }, 'dsh-sdk: validate command argument contracts')
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
