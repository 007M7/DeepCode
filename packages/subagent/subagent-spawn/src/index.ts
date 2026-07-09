/**
 * The in-process SPAWN subagent backend: registers a {@link SubagentProvider}
 * on `ctx.subagents` that runs each child as a FRESH child {@link Agent} on the
 * same cordis context (its own session, own system prompt, zero parent
 * context). The cheapest transport, reusing the agent factory's quiescent
 * teardown.
 *
 * The run mechanics live in `@deepseek-ai/dsh-subagent-inprocess`
 * ({@link startInProcessRun}); this backend just passes NO seed (a fresh
 * child). The fork backend is an independent peer over the same driver.
 *
 * Structured output (`outputSchema`) is supported via the driver's shared
 * structured runtime: the backend acquires it for its plugin lifetime (so the
 * capture tool and request-shaping listeners exist before any run), and each
 * structured run holds its own acquisition until it settles.
 *
 * Plugin export shape: named `name`/`inject`/`Config`/`apply`, NO default.
 *
 * @module @deepseek-ai/dsh-subagent-spawn
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import type { SubagentCapabilities, SubagentProvider, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { startInProcessRun } from '@deepseek-ai/dsh-subagent-inprocess'

export const name = 'subagent-spawn'
// `tools` is deliberately NOT injected: the shared driver's structured runtime
// (acquired per structured RUN, not at apply) gates its own capture-tool
// registration on `tools` availability, so this backend's apply timing — and
// with it the provider-mirroring delegation tool's position in the
// model-visible tool list — stays what it was before structured output existed.
export const inject = ['subagents', 'agents']

/** Config: the registry name to register the provider under. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `spawn`). */
  providerName: string
}

export const Config: z<Config> = z.object({
  providerName: z.string().default('spawn'),
})

/**
 * The spawn provider. Supports `depthLimit` (it constructs the child, so it can
 * enforce a recursion cap) and `outputSchema` (via the shared in-process
 * structured runtime); NOT `toolFilter` in this cut — a request that needs it
 * is rejected by the service before `start` runs.
 */
class SpawnProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = { outputSchema: true, depthLimit: true, toolFilter: false }
  // Context contract: a spawned child starts fresh — it never sees the parent conversation.
  readonly inheritsParentContext = false

  constructor(readonly name: string, private readonly ctx: Context) {}

  start(request: SubagentStartRequest) {
    // Fresh child: no seed. The shared driver mints ids, stamps cwd/lineage/
    // depth, drives the one-shot (including the structured capture when the
    // request carries an outputSchema), and maps the result.
    return startInProcessRun(this.ctx, request, { providerName: this.name })
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.subagents.registerProvider(new SpawnProvider(config.providerName, ctx))
}
