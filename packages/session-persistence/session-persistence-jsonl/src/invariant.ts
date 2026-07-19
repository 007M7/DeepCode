/**
 * Package-owned runtime contract checks for `@deepseek-ai/dsh-session-persistence-jsonl`.
 * @module @deepseek-ai/dsh-session-persistence-jsonl/invariant
 */

import type { Context } from 'cordis'
import { observePluginInvariant, type InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-session-persistence-jsonl'

/** Cordis companion plugin name. */
export const name = 'session-persistence-jsonl-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** Install checks for this package's active plugin fibers. */
const install: InvariantInstaller = (ctx, fail) => {
  observePluginInvariant(ctx, fail, {
    name: 'SessionPersistenceJsonl',
    inject: [
      'sessions',
    ],
    effects: [
      'ctx.provide("sessionPersistence")',
    ],
    services: [
      'sessionPersistence',
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
