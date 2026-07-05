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
import { acquireStructuredRuntime, startInProcessRun } from '@deepseek-ai/dsh-subagent-inprocess'

export const name = 'subagent-spawn'
export const inject = ['subagents', 'agents', 'tools']

/** Config: the registry name to register the provider under, plus structured-run tuning. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `spawn`). */
  providerName: string
  /**
   * How many times a structured run re-prompts a child that finished cleanly
   * without calling `structured_output` before giving up (default 1).
   */
  structuredNudgeRetries: number
}

export const Config: z<Config> = z.object({
  providerName: z.string().default('spawn'),
  structuredNudgeRetries: z.natural().default(1),
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

  constructor(
    readonly name: string,
    private readonly ctx: Context,
    private readonly structuredNudgeRetries: number,
  ) {}

  start(request: SubagentStartRequest) {
    // Fresh child: no seed. The shared driver mints ids, stamps cwd/lineage/
    // depth, drives the one-shot (including the structured capture/nudge loop
    // when the request carries an outputSchema), and maps the result.
    return startInProcessRun(this.ctx, request, {
      providerName: this.name,
      structuredNudgeRetries: this.structuredNudgeRetries,
    })
  }
}

export function apply(ctx: Context, config: Config): void {
  // Hold the structured runtime for the plugin's lifetime, so the capture tool
  // and its request-shaping listeners are registered before the first
  // structured run and torn down when the last backend unloads (live runs hold
  // their own acquisitions, so an unload mid-run cannot strand a child).
  ctx.effect(() => {
    const acquisition = acquireStructuredRuntime(ctx)
    return () => { acquisition.release() }
  }, 'subagent-spawn structured runtime')
  ctx.subagents.registerProvider(new SpawnProvider(config.providerName, ctx, config.structuredNudgeRetries))
}
