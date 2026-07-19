/** Package-owned runtime contract checks for `@deepseek-ai/dsh-session-query`. @module @deepseek-ai/dsh-session-query/invariant */

import type { Context } from 'cordis'
import { observePluginInvariant, type InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-session-query'

/** Cordis companion plugin name. */
export const name = 'session-query-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** Install checks for this package's active plugin fibers. */
const install: InvariantInstaller = (ctx, fail) => {
  observePluginInvariant(ctx, fail, {
    name: 'SessionQueryService',
    inject: [
      'sessions',
    ],
    effects: [
      'ctx.provide("sessionQuery")',
    ],
    services: [
      'sessionQuery',
    ],
  })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
