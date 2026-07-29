/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-session-registry-live`.
 * @module @deepseek-ai/dsh-session-registry-live/invariant
 */

/* jscpd:ignore-start */
import type { Context } from 'cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-session-registry-live'

/** Cordis companion plugin name. */
export const name = 'session-registry-live-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this plugin owns no durable state of its own — the
 * uniqueness and liveness relations over published records are checked by the
 * companion in `@deepseek-ai/dsh-session-registry`, which owns that file.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
