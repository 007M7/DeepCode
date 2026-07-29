/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tool-bash-persistent`.
 * @module @deepseek-ai/dsh-tool-bash-persistent/invariant
 */

/* jscpd:ignore-start */
import type { Context } from 'cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-bash-persistent'

/** Cordis companion plugin name. */
export const name = 'tool-bash-persistent-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the tool adapter owns no independent durable state;
 * PTY ownership and filesystem mutation relations stay with their services.
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
