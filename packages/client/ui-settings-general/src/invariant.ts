/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-settings-general`.
 * @module @deepseek-ai/dsh-client-ui-settings-general/invariant
 */

/* jscpd:ignore-start */
import type { Context } from 'cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-settings-general'

/** Cordis companion plugin name. */
export const name = 'client-ui-settings-general-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the settings seam validates and publishes the durable
 * welcome section, while slot conflicts fail loud in the slot core; this
 * package owns no additional event/data relationship between those systems.
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
