/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-credentials`.
 * @module @deepseek-ai/dsh-credentials/invariant
 */

import type { Context } from 'cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-credentials'

/** Cordis companion plugin name. */
export const name = 'credentials-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this read-only seam exposes no event sequence or
 * mutable data relation; provider resolution crosses an asynchronous I/O
 * boundary and stays pinned by each provider's own suite.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
