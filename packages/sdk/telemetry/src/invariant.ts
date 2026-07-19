/** Package-owned runtime contracts for @deepseek-ai/dsh-telemetry. @module @deepseek-ai/dsh-telemetry/invariant */

/* jscpd:ignore-start */
import type { Context } from 'cordis'
import { assertInvariant, type InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-telemetry'

/** Cordis companion plugin name. */
export const name = 'telemetry-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** Assert the final telemetry redaction boundary removes secrets without corrupting ordinary package metadata. */
const install: InvariantInstaller = async (_ctx, fail) => {
  const [{ telemetryRedactionViolation }, { DEFAULT_REDACTION_PLACEHOLDER, SecretRedactor }] = await Promise.all([
    import('./redaction-contract.ts'),
    import('./secret-redactor.ts'),
  ])
  const redactor = new SecretRedactor()
  const violation = telemetryRedactionViolation(redactor, DEFAULT_REDACTION_PLACEHOLDER, PACKAGE_NAME)
  assertInvariant(fail,
    violation === undefined,
    violation ?? 'telemetry redaction contract failed without a diagnostic')
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
