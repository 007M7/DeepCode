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
 * Structured output (`outputSchema`) is supported through the driver's
 * per-child scoped runtime: the child registers its real-schema capture tool,
 * prompt instruction, and enforcement listeners inside the creation setup
 * window, and its scope owns their lifetime.
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
// `tools` is deliberately NOT injected: the shared driver registers structured
// output through the child's creation context, whose factory already requires
// the tool service. Keeping it out of this backend's inject list preserves the
// provider's independent apply timing.
export const inject = ['subagents']

/** Config: the registry name to register the provider under. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `spawn`). */
  providerName: string
}

export const Config: z<Config> = z.object({
  providerName: z.string().default('spawn'),
})

/**
 * The spawn provider. Supports every start-time capability: `depthLimit` (it
 * constructs the child, so it can enforce a recursion cap), `outputSchema`
 * (the scoped structured runtime), and `toolFilter`/`persona` (scoped
 * `restrict()` and a scoped shadowing persona section, applied in the child's
 * creation window).
 */
class SpawnProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = { outputSchema: true, depthLimit: true, toolFilter: true, persona: true }
  // Context contract: a spawned child starts fresh — it never sees the parent conversation.
  readonly inheritsParentContext = false

  constructor(readonly name: string) {}

  start(request: SubagentStartRequest) {
    // Fresh child: no seed. The shared driver mints ids, stamps cwd/lineage/
    // depth, drives the one-shot (including the structured capture when the
    // request carries an outputSchema), and maps the result.
    return startInProcessRun(request, {})
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.subagents.registerProvider(new SpawnProvider(config.providerName))
}
