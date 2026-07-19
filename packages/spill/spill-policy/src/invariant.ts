/** Package-owned runtime contract checks for `@deepseek-ai/dsh-spill-policy`. @module @deepseek-ai/dsh-spill-policy/invariant */

import type { Context } from 'cordis'
import { observePluginInvariant, type InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-spill-policy'

/** Cordis companion plugin name. */
export const name = 'spill-policy-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** Install checks for this package's active plugin fibers. */
const install: InvariantInstaller = (ctx, fail) => {
  observePluginInvariant(ctx, fail, {
    name: 'spill-policy',
    inject: [
      'tools',
    ],
    validate: (fiber, effectLabels) => {
      const installed = effectLabels.has('ctx.on("tools/post-execute")')
      const enabled = (fiber.config as { maxInlineBytes?: number }).maxInlineBytes !== undefined
      return installed === enabled
        ? undefined
        : 'the post-execute spill policy listener must exist exactly when maxInlineBytes is configured'
    },
  })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
