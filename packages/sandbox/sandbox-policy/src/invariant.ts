/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-sandbox-policy`.
 * @module @deepseek-ai/dsh-sandbox-policy/invariant
 */

/* jscpd:ignore-start */
import type { Context } from 'cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-sandbox-policy'

/** Cordis companion plugin name. */
export const name = 'sandbox-policy-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** No runtime invariant: the follow-up checks package-owned sandbox-mode events once this topology gate lands. */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
