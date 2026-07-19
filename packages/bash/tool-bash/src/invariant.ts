/** Package-owned runtime contract checks for `@deepseek-ai/dsh-tool-bash`. @module @deepseek-ai/dsh-tool-bash/invariant */

import type { Context } from 'cordis'
import { observePluginInvariant, type InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-bash'

/** Cordis companion plugin name. */
export const name = 'tool-bash-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** Install checks for this package's active plugin fibers. */
const install: InvariantInstaller = (ctx, fail) => {
  observePluginInvariant(ctx, fail, {
    name: 'tool-bash',
    inject: [
      'tools',
      'bash',
      'systemPrompt',
    ],
    effects: [
      'ctx.provide("bashEnv")',
      'bashEnv.register()',
      'tools.register()',
    ],
    services: [
      'bashEnv',
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
