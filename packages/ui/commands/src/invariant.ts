/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-commands`.
 * @module @deepseek-ai/dsh-commands/invariant
 */

/* jscpd:ignore-start */
import type { Context } from 'cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-commands'

/** Cordis companion plugin name. */
export const name = 'commands-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: registry notifications intentionally hide mutation details and contain
 * observers, so list/find self-comparisons would duplicate implementation rather than detect drift.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
