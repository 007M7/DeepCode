/** Package-owned runtime contract checks for `@deepseek-ai/dsh-code-runtime`. @module @deepseek-ai/dsh-code-runtime/invariant */

import type { Context } from 'cordis'
import { observeServiceInvariant, serviceShapeViolation, type InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-code-runtime'

/** Cordis companion plugin name. */
export const name = 'code-runtime-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** Validate every implementation bound to this package's service seam. */
const install: InvariantInstaller = (ctx, fail) => {
  observeServiceInvariant(ctx, fail, 'codeRuntime', (value) => {
    const violation = serviceShapeViolation(value, {
      methods: ['run'],
      stringProperties: ['language', 'isolation'],
    })
    if (violation !== undefined) return violation
    const service = value as { language: string; isolation: string }
    return /^[a-z][a-z0-9-]*$/.test(service.language) && /^[a-z][a-z0-9-]*$/.test(service.isolation)
      ? undefined
      : 'code runtime language and isolation must be lowercase identifiers'
  })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
