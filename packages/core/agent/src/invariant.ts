/** Package-owned agent lifecycle invariants. @module @deepseek-ai/dsh-agent/invariant */

import type { Context } from 'cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'

const PACKAGE_NAME = '@deepseek-ai/dsh-agent'

/** Cordis companion plugin name. */
export const name = 'agent-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** Install the agent contribution into its child registration fiber. */
const install: InvariantInstaller = (ctx, fail) => {
  const lastStatus = new WeakMap<Agent, AgentStatus>()
  ctx.on('agent/status', (agent, status) => {
    const previous = lastStatus.get(agent)
    if (previous === status) {
      fail(`agent/status repeated ${status} (no-op transition)`)
    }
    lastStatus.set(agent, status)
  }, { global: true })

  // Inbox FIFO conservation: an item leaves the inbox (dequeue) or is dropped
  // (discard) only after it entered (enqueue), so the live outstanding count
  // per agent can never go negative. Injection bypasses the FIFOs entirely and
  // never appears on these events.
  const outstanding = new WeakMap<Agent, number>()
  ctx.on('agent/inbox/enqueue', (agent) => {
    outstanding.set(agent, (outstanding.get(agent) ?? 0) + 1)
  }, { global: true })
  ctx.on('agent/inbox/dequeue', (agent) => {
    const count = outstanding.get(agent) ?? 0
    if (count <= 0) fail('agent/inbox/dequeue without a matching prior enqueue')
    outstanding.set(agent, count - 1)
  }, { global: true })
  ctx.on('agent/inbox/discard', (agent, items) => {
    const count = outstanding.get(agent) ?? 0
    if (items.length > count) {
      fail(`agent/inbox/discard dropped ${items.length} items but only ${count} were outstanding`)
    }
    outstanding.set(agent, count - items.length)
  }, { global: true })
}

/**
 * Register the agent invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
