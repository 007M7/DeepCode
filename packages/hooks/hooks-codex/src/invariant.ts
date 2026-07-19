/** Package-owned runtime contract checks for `@deepseek-ai/dsh-hooks-codex`. @module @deepseek-ai/dsh-hooks-codex/invariant */

import type { Context } from 'cordis'
import { observePluginInvariant, type InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-hooks-codex'

/** Cordis companion plugin name. */
export const name = 'hooks-codex-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** Install checks for this package's active plugin fibers. */
const install: InvariantInstaller = (ctx, fail) => {
  observePluginInvariant(ctx, fail, {
    name: 'hooks-codex',
    inject: [
      'bash',
    ],
    validate: (_fiber, effectLabels) => {
      const hookEffects = [
        'hooks-codex: drain detached hook runs',
        'ctx.on("agent/session-start")',
        'ctx.on("agent/prompt-submit")',
        'ctx.on("tools/pre-execute")',
        'ctx.on("tools/post-execute")',
        'ctx.on("agent/turn-continuation")',
      ]
      const installed = hookEffects.filter(label => effectLabels.has(label)).length
      return installed === 0 || installed === hookEffects.length
        ? undefined
        : 'a readable Codex hook config must install its complete listener set atomically'
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
