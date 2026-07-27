/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-session-projection`.
 * @module @deepseek-ai/dsh-session-projection/invariant
 */

/* jscpd:ignore-start */
import type { Context } from 'cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-session-projection'

/** Cordis companion plugin name. */
export const name = 'session-projection-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the registry's own contracts (duplicate-key rejection,
 * effect-tied removal) are enforced synchronously at the register() boundary,
 * and the served-block relation — every served key has a live registration —
 * lives on each carrier's wire path, which emits no cordis event this
 * companion could observe; carrier specs assert it instead. Synchronous-`get`
 * discipline is enforced as far as practical by the carrier's `schema.parse`
 * (a Promise value fails loudly).
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
