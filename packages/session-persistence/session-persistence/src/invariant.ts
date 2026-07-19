/**
 * Package-owned runtime contract checks for `@deepseek-ai/dsh-session-persistence`.
 * @module @deepseek-ai/dsh-session-persistence/invariant
 */

import type { Context } from 'cordis'
import { observeServiceInvariant, serviceShapeViolation, type InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-session-persistence'

/** Cordis companion plugin name. */
export const name = 'session-persistence-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** Validate every implementation bound to this package's service seam. */
const install: InvariantInstaller = (ctx, fail) => {
  observeServiceInvariant(ctx, fail, 'sessionPersistence', value => serviceShapeViolation(value, {
    methods: ['locate', 'create', 'append', 'load', 'list'],
  }))
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
