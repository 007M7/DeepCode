/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-agent-presets`.
 * @module @deepseek-ai/dsh-agent-presets/invariant
 */

import type { Context } from 'cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
// Imported through the package name, not `./mount.ts`: a module shared between
// the two build entry points becomes a third chunk that the published `files`
// list does not carry, which `verify-built-package-invariants` rejects.
import { leakedServices, livePresetMounts } from '@deepseek-ai/dsh-agent-presets'

const PACKAGE_NAME = '@deepseek-ai/dsh-agent-presets'

/** Cordis companion plugin name. */
export const name = 'agent-presets-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Assert that no installed preset composition reaches the root service realm.
 *
 * `mountPreset` proves this once, when the subtree settles. A row that
 * publishes later — from a timer, or an asynchronous continuation after its
 * plugin returned — would escape that one-shot audit, so re-check every live
 * mount whenever a service registration changes.
 */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.on('internal/service', function (this: Context, name) {
    for (const mount of livePresetMounts()) {
      const leaked = leakedServices(ctx, mount.fiber)
      if (leaked.length === 0) continue
      fail(
        `preset "${mount.presetId}" published process-global service(s) [${leaked.join(', ')}] `
        + `after its mount was audited (observed while notifying "${name}") — `
        + 'a preset service must sit behind an `isolate` realm or move to the host composition',
      )
    }
  }, { global: true })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
