/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-cmdline`.
 * @module @deepseek-ai/dsh-cmdline/invariant
 */

import type { Context } from 'cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-cmdline'

/** Cordis companion plugin name. */
export const name = 'cmdline-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: the owned relation is "no row is left waiting for a
 * startup service", which is a property of the whole tree at Loader
 * settlement, and the invariant service carries no settlement signal to
 * evaluate it at. Observing it from the entry stream would fire while startup
 * is still parsing, when every waiting row is legitimately still waiting. The
 * launcher's post-settlement audit (`assertEntriesActivated`) already reports
 * a startup service that was never provided as a pending entry naming it, and
 * the built-bin e2e asserts the apps boot with flag values applied.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
