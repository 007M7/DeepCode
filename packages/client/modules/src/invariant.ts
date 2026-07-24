/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-modules`.
 * @module @deepseek-ai/dsh-client-modules/invariant
 */

/* jscpd:ignore-start */
import type { Context } from 'cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-modules'

/** Cordis companion plugin name. */
export const name = 'client-modules-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the module loader is pre-plugin kernel machinery —
 * it emits no cordis events (the vendored Loader owns entry lifecycle events)
 * and its mutable state (loadCache, handoff slot) lives below the plugin
 * layer where invariant observers cannot mount before it runs; resolve branch
 * order and handoff discipline are asserted by the web boot specs against the
 * real execution path.
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
