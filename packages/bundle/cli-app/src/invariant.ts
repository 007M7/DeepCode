/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-cli-app`.
 * @module @deepseek-ai/dsh-cli-app/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-cli-app'

/** Cordis companion plugin name. */
export const name = 'cli-app-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: the runner owns the process's single readline
 * interface and its stdout/stderr/exit; that observable contract (streamed
 * assistant text, flush-before-exit, EOF/close exit) is process-level and
 * covered by the launcher's built-bin e2e, while every tree-side registration
 * (session/event listener, approval answerer, user-questions provider) is
 * disposed by the run's finally block, leaving no mutable relation for this
 * package to audit.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
