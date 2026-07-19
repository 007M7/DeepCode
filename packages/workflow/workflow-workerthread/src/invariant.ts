/**
 * Generated invariant ownership companion for `@deepseek-ai/dsh-workflow-workerthread`.
 * Replace this file with package-owned checks while preserving its registration.
 *
 * @generated scripts/gen-package-invariants.ts
 * @module @deepseek-ai/dsh-workflow-workerthread/invariant
 */

/* jscpd:ignore-start */
import type { Context } from 'cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-workflow-workerthread'

/** Cordis companion plugin name. */
export const name = 'workflow-workerthread-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** Reserve this package's invariant ownership until it adds relational checks. */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
