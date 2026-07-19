/** Package-owned runtime contracts for @deepseek-ai/create-sdk. @module @deepseek-ai/create-sdk/invariant */

/* jscpd:ignore-start */
import type { Context } from 'cordis'
import { assertInvariant, type InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/create-sdk'

/** Cordis companion plugin name. */
export const name = 'create-sdk-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** Assert the bin-only entrypoint and its core argument mapping. */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.effect(async () => {
    const { parseCreateArgs } = await import('./args.ts')
    const packageEntry = await import('./index.ts')
    assertInvariant(fail, Object.keys(packageEntry).length === 0,
      'the create-sdk library entrypoint must remain empty because the package is bin-only')
    const parsed = parseCreateArgs([
      'workspace', '--provider=custom', '--base-url=https://example.test', '--interface=embed', '--no-install',
    ])
    assertInvariant(fail,
      parsed.directory === 'workspace'
        && parsed.provider === 'custom'
        && parsed.baseURL === 'https://example.test'
        && parsed.runInterface === 'embed'
        && parsed.install === false,
      'create-sdk arguments must preserve directory, provider, base URL, interface, and negative install flags')
    return () => {}
  }, 'create-sdk: validate bin and argument contracts')
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
