/** Package-owned runtime contract checks for `@deepseek-ai/dsh-compact-basic`. @module @deepseek-ai/dsh-compact-basic/invariant */

import type { Context } from 'cordis'
import { observePluginInvariant, type InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-compact-basic'

/** Cordis companion plugin name. */
export const name = 'compact-basic-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** Install checks for this package's active plugin fibers. */
const install: InvariantInstaller = (ctx, fail) => {
  observePluginInvariant(ctx, fail, {
    name: 'BasicCompactService',
    inject: [
      'llm',
      'tokenMeter',
    ],
    effects: [
      'ctx.provide("compact")',
    ],
    services: [
      'compact',
    ],
    validate: (fiber, effectLabels) => {
      const automaticEffects = [
        'ctx.on("agent/post-step")',
        'ctx.on("agent/request-error")',
      ]
      const installed = automaticEffects.filter(label => effectLabels.has(label)).length
      const automatic = (fiber.config as { auto?: boolean }).auto !== false
      if (automatic && installed !== automaticEffects.length) {
        return 'automatic compaction must install both pressure and overflow listeners'
      }
      if (!automatic && installed !== 0) {
        return 'auto:false must install neither automatic compaction listener'
      }
      return undefined
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
