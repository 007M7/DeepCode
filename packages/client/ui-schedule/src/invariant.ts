/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-schedule`.
 * @module @deepseek-ai/dsh-client-ui-schedule/invariant
 */

/* jscpd:ignore-start */
import type { Context } from 'cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-schedule'

/** Cordis companion plugin name. */
export const name = 'client-ui-schedule-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the keyed slot registry owns contribution lifecycle,
 * and the component has no state outside its immutable owner payload.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns The installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
