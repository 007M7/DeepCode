/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-agent-presets`.
 * @module @deepseek-ai/dsh-agent-presets/invariant
 */

import type { Context } from 'cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { scopeChainOf } from '@deepseek-ai/dsh-scope'
// Type-only: resolves the `system-prompt/assemble` waterfall this companion joins.
import type {} from '@deepseek-ai/dsh-system-prompt'
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
 * Assert that no installed preset composition reaches the root service realm,
 * and that a deployment configuring a roster composes every agent from it.
 *
 * `mountPreset` proves the first once, when the subtree settles. A row that
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

  // The join is a scope-parent link, and `AgentPresets.mount()` is the only
  // thing in the runtime that installs one. An agent minted without it keeps a
  // chain of length one, so its `tools`, `system-prompt`, and `skill` views
  // fall back to the empty global layer and the model receives nothing.
  //
  // Checked at ASSEMBLY, not at publication: an unjoined agent is legal until
  // it addresses a model — `recompose` binds a bare agent as its first link,
  // and that agent is unjoined for its whole life up to the switch. Assembling
  // a prompt is the point where the empty world stops being a state and
  // becomes what the model sees, and it is the only caller that supplies an
  // agent scope, so a host assembly (no scope) and a standing mount are both
  // correctly out of range.
  ctx.on('system-prompt/assemble', (_assembly, context, next) => {
    const presets = ctx.get('agentPresets')
    const scope = context.scope
    if (presets !== undefined && presets.config.roots.length > 0
      && scope !== undefined && scopeChainOf(scope).length === 1) {
      fail(
        'an agent addressed a model without joining any agent preset while a roster is composed; '
        + 'its tools, prompt sections, and skill catalog resolve against the empty global layer',
      )
    }
    return next()
  })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
