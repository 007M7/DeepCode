/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-conversation`.
 * @module @deepseek-ai/dsh-client-ui-conversation/invariant
 */

/* jscpd:ignore-start */
import type { Context } from 'cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-conversation'

/** Cordis companion plugin name. */
export const name = 'client-ui-conversation-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the conversation service emits no cordis events — its
 * view and toolview registries notify through package-local subscribe faces
 * whose ordering (synchronous version bump before notification) is exercised
 * directly by the behavior specs, and the per-scope store accounts are owned
 * mutable state with no cross-plugin observer to contradict.
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
