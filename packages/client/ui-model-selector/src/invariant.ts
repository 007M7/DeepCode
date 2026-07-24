/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-model-selector`.
 * @module @deepseek-ai/dsh-client-ui-model-selector/invariant
 */

/* jscpd:ignore-start */
import type { Context } from 'cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-model-selector'

/** Cordis companion plugin name. */
export const name = 'client-ui-model-selector-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the slot registry owns selector registration
 * lifecycle, and the wire/object-layer tests own model-target consistency.
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
