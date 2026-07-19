/** Package-owned runtime contracts for @deepseek-ai/dsh-subagent-subprocess. @module @deepseek-ai/dsh-subagent-subprocess/invariant */

/* jscpd:ignore-start */
import type { Context } from 'cordis'
import { assertInvariant, type InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-subagent-subprocess'
const SENSITIVE_ENV_PATTERN = /KEY|SECRET|TOKEN/i

/** Cordis companion plugin name. */
export const name = 'subagent-subprocess-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** Assert ambient credential scrubbing and explicit credential precedence. */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.effect(async () => {
    const { buildChildEnv } = await import('./index.ts')
    const scrubbed = buildChildEnv({})
    const ambientSensitiveNames = Object.keys(process.env).filter(key => SENSITIVE_ENV_PATTERN.test(key))
    assertInvariant(fail, ambientSensitiveNames.every(key => !Object.hasOwn(scrubbed, key)),
      'subprocess environments must omit every credential-shaped ambient variable')

    const explicit = buildChildEnv({ DSH_INVARIANT_TOKEN: 'explicit-child-value' })
    assertInvariant(fail, explicit.DSH_INVARIANT_TOKEN === 'explicit-child-value',
      'explicit child credentials must be applied after ambient scrubbing')
    return () => {}
  }, 'subagent-subprocess: validate child environment isolation')
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
