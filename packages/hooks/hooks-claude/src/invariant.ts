/** Package-owned runtime contract checks for `@deepseek-ai/dsh-hooks-claude`. @module @deepseek-ai/dsh-hooks-claude/invariant */

import type { Context } from 'cordis'
import { observePluginInvariant, type InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-hooks-claude'

/** Cordis companion plugin name. */
export const name = 'hooks-claude-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** Install checks for this package's active plugin fibers. */
const install: InvariantInstaller = (ctx, fail) => {
  observePluginInvariant(ctx, fail, {
    name: 'hooks-claude',
    inject: [
      'bash',
    ],
    validate: (_fiber, effectLabels) => {
      const hookEffects = [
        'hooks-claude: drain detached hook runs',
        'ctx.on("agent/session-start")',
        'ctx.on("agent/prompt-submit")',
        'ctx.on("tools/pre-execute")',
        'ctx.on("tools/post-execute")',
        'ctx.on("agent/turn-continuation")',
        'ctx.on("subagent/start")',
        'ctx.on("subagent/end")',
      ]
      const installed = hookEffects.filter(label => effectLabels.has(label)).length
      return installed === 0 || installed === hookEffects.length
        ? undefined
        : 'a readable Claude hook config must install its complete listener set atomically'
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
