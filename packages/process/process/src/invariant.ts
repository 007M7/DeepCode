/** Package-owned invariant companion for the process-manager seam. @module @deepseek-ai/dsh-process/invariant */

import type { Context } from 'cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-process'

/** Cordis companion plugin name. */
export const name = 'process-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: this stateless seam owns spawn-spec/handle types, while implementations own observations. */
const install: InvariantInstaller = () => {}

/**
 * Register the process-manager invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
