/**
 * Generated invariant ownership companion for `@deepseek-ai/dsh-tool-web`.
 * Replace this file with package-owned checks while preserving its registration.
 *
 * @generated scripts/gen-package-invariants.ts
 * @module @deepseek-ai/dsh-tool-web/invariant
 */

/* jscpd:ignore-start */
import type { Context } from 'cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-web'

/** Cordis companion plugin name. */
export const name = 'tool-web-invariant'
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
