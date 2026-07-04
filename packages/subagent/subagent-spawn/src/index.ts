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
 * Plugin export shape: named `name`/`inject`/`Config`/`apply`, NO default.
 *
 * @module @deepseek-ai/dsh-subagent-spawn
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import type { SubagentCapabilities, SubagentProvider, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { startInProcessRun } from '@deepseek-ai/dsh-subagent-inprocess'

export const name = 'subagent-spawn'
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
 * enforce a recursion cap) but NOT `outputSchema` or `toolFilter` in this cut —
 * a request that needs either is rejected by the service before `start` runs.
 */
class SpawnProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = { outputSchema: false, depthLimit: true, toolFilter: false }

  constructor(readonly name: string, private readonly ctx: Context) {}

  start(request: SubagentStartRequest) {
    // Fresh child: no seed. The shared driver mints ids, stamps cwd/lineage/
    // depth, drives the one-shot, and maps the result.
    return startInProcessRun(this.ctx, request, { providerName: this.name })
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.subagents.registerProvider(new SpawnProvider(config.providerName, ctx))
}
