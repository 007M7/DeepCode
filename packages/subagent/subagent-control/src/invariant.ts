/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-subagent-control`.
 * @module @deepseek-ai/dsh-subagent-control/invariant
 */

/* jscpd:ignore-start */
import type { Context } from 'cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-subagent-control'

/** Cordis companion plugin name. */
export const name = 'subagent-control-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the activation association is deliberately private
 * process-local routing state with no event stream of its own; the run
 * lifecycle pair it participates in is checked by `@deepseek-ai/dsh-subagent`,
 * and Task lifecycle relations belong to `@deepseek-ai/dsh-tasks`.
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
