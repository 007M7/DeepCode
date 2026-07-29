/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-session-registry-file`.
 * @module @deepseek-ai/dsh-session-registry-file/invariant
 */

import type { Context } from 'cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-session-registry-file'

/** Cordis companion plugin name. */
export const name = 'session-registry-file-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the relations a reader must trust (unique live session
 * ids, attributable pids) are contract-level and validated by the seam's
 * companion around the authoritative `list()`, whatever backend serves it. The
 * file medium's own correctness — locking, atomic republication, and
 * foreign-row rejection — requires cross-process round-trip tests, not a
 * continuously observable in-process relation.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
