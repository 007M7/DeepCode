/** Package-owned runtime contracts for @deepseek-ai/dsh-paths. @module @deepseek-ai/dsh-paths/invariant */

/* jscpd:ignore-start */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from 'cordis'
import { assertInvariant, type InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-paths'

/** Cordis companion plugin name. */
export const name = 'paths-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** Assert tilde expansion and explicit-over-environment home precedence. */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.effect(async () => {
    const { DSH_HOME_ENV, expandHomePath, resolveDshHome } = await import('./index.ts')
    assertInvariant(fail, expandHomePath('~/invariant-probe') === join(homedir(), 'invariant-probe'),
      'supported tilde prefixes must expand against the operating-system home')
    const configured = 'relative-invariant-home'
    const resolved = resolveDshHome(configured, { [DSH_HOME_ENV]: '/ignored-environment-home' })
    assertInvariant(fail, resolved === resolve(configured),
      'an explicit DSH home must override the environment and normalize to an absolute path')
    return () => {}
  }, 'paths: validate DSH home resolution')
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
