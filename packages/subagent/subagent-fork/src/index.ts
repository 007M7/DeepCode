/**
 * The in-process FORK subagent backend: registers a {@link SubagentProvider} on
 * `ctx.subagents` that runs each child as a child {@link Agent} SEEDED with a
 * prefix of the parent's session log — so the child inherits the parent's
 * conversation context instead of starting fresh. The run mechanics live in
 * `@deepseek-ai/dsh-subagent-inprocess` ({@link startInProcessRun}); this
 * backend just computes the seed. The spawn backend is an independent peer over
 * the same driver.
 *
 * The seed boundary is the crux: at the moment a subagent tool's `execute`
 * runs, the parent's CURRENT turn is open and unbalanced (it holds the
 * `assistant/message` with this spawn's tool-call, plus the dangling `tool/call`
 * with no `tool/result`). Seeding that raw prefix gives the child an open turn
 * the session constructor and the dev-mode invariants replay REJECT. So the
 * fork seeds only the **balanced completed-turn prefix**: the parent's log up
 * to and including its last `turn/end`, excluding the in-flight turn entirely.
 *
 * Plugin export shape: named `name`/`inject`/`Config`/`apply`, NO default.
 *
 * @module @deepseek-ai/dsh-subagent-fork
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentCapabilities, SubagentProvider, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { startInProcessRun } from '@deepseek-ai/dsh-subagent-inprocess'

export const name = 'subagent-fork'
export const inject = ['subagents', 'agents']

/** Config: the registry name to register the provider under. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `fork`). */
  providerName: string
}

export const Config: z<Config> = z.object({
  providerName: z.string().default('fork'),
})

/**
 * The balanced completed-turn prefix of `parent`'s log: every event up to and
 * including the last `turn/end`. Empty if the parent has never completed a turn
 * (the in-flight turn is excluded, so a parent on its very first turn forks an
 * empty — i.e. fresh — child). The result is contiguous from seq 0 (the live
 * log keeps `seq === index`), so it is a valid session seed; the in-flight,
 * unbalanced turn is dropped so the invariants replay accepts it.
 */
export function completedTurnPrefix(parent: Agent): SessionEvent[] {
  const events = parent.session.events
  const lastEnd = events.findLast(e => e.type === 'turn/end')
  if (lastEnd === undefined) return []
  // seq === array index (the append contract), so slice up to and including it.
  return events.slice(0, lastEnd.seq + 1)
}

/**
 * The fork provider. Supports `depthLimit`; NOT `outputSchema`/`toolFilter` this
 * cut (the service rejects a request needing either before `start` runs).
 */
class ForkProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = { outputSchema: false, depthLimit: true, toolFilter: false }

  constructor(readonly name: string, private readonly ctx: Context) {}

  start(request: SubagentStartRequest) {
    const seed = completedTurnPrefix(request.parent)
    return startInProcessRun(this.ctx, request, {
      providerName: this.name,
      // Only pass a seed when there's a completed turn to inherit; an empty seed
      // is equivalent to a fresh child, so omit it to keep the session unseeded.
      ...seed.length > 0 ? { seed } : {},
    })
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.subagents.registerProvider(new ForkProvider(config.providerName, ctx))
}
