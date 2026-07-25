/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-hmr`.
 * @module @deepseek-ai/dsh-client-hmr/invariant
 */

/* jscpd:ignore-start */
import type { Context } from 'cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-hmr'

/** Cordis companion plugin name. */
export const name = 'client-hmr-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: a dev-only reload driver — it consumes the loader
 * entry tree and module cache but owns no events and no cross-plugin mutable
 * state; reload correctness (dispose → style removal → re-execute ordering)
 * is observable only through the assembled browser runtime, not a host-side
 * event relation.
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
