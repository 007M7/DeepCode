/** Package-owned runtime contracts for @deepseek-ai/dsh-retention. @module @deepseek-ai/dsh-retention/invariant */

/* jscpd:ignore-start */
import type { Context } from 'cordis'
import { assertInvariant, type InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-retention'

/** Cordis companion plugin name. */
export const name = 'retention-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** Assert exact head-retention accounting after the budget is exceeded. */
const install: InvariantInstaller = async (_ctx, fail) => {
  const { ItemRetainer } = await import('./index.ts')
  const retainer = new ItemRetainer<string>({ kind: 'head', maxItems: 2 })
  retainer.push('first')
  retainer.push('second')
  retainer.push('third')
  const result = retainer.finish()
  assertInvariant(fail,
    result.items.join(',') === 'first,second'
      && result.seen === 3
      && result.kept === 2
      && result.truncated
      && result.omitted.kind === 'exact'
      && result.omitted.count === 1,
    'head retention must keep the prefix and report exact seen, kept, and omitted counts')
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
