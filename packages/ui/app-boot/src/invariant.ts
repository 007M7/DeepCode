/** Package-owned runtime contracts for @deepseek-ai/dsh-app-boot. @module @deepseek-ai/dsh-app-boot/invariant */

/* jscpd:ignore-start */
import { resolve } from 'node:path'
import type { Context } from 'cordis'
import { assertInvariant, type InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-app-boot'

/** Cordis companion plugin name. */
export const name = 'app-boot-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** Assert ordinary and replay config-path selection. */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.effect(async () => {
    const { resolveConfigPath } = await import('./config-path.ts')
    const cwd = '/tmp/dsh-app-boot-invariant'
    const ordinary = resolveConfigPath('cordis.yml', undefined, cwd)
    const replay = resolveConfigPath('cordis.yml', 'replay', cwd)
    assertInvariant(fail, ordinary === resolve(cwd, 'cordis.yml'),
      'ordinary app boot must retain the requested config basename')
    assertInvariant(fail, replay === resolve(cwd, 'cordis.snapshot.yml'),
      'snapshot replay must select cordis.snapshot.yml in the requested config directory')
    return () => {}
  }, 'app-boot: validate ordinary and replay config selection')
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
