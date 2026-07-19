/** Package-owned runtime contract checks for `@deepseek-ai/dsh-invariants`. @module @deepseek-ai/dsh-invariants/invariant */

import type { Context } from 'cordis'
import InvariantService, { observePluginInvariant, type InvariantInstaller } from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-invariants'

/** Cordis companion plugin name. */
export const name = 'invariants-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** Install checks for this package's active plugin fibers. */
const install: InvariantInstaller = (ctx, fail) => {
  observePluginInvariant(ctx, fail, {
    plugin: InvariantService,
    name: 'InvariantService',
    effects: [
      'ctx.provide("invariants")',
    ],
    services: [
      'invariants',
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
