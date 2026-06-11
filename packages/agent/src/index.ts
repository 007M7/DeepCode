/**
 * Agent registry service. Tracks live agents so plugins can find them without
 * depending on the concrete loop package. Agent creation belongs to the loop.
 *
 * @module @deepseek-ai/dsh-agent
 */

import { Context, Service } from 'cordis'
import type { Agent } from './types.ts'

export * from './types.ts'

declare module 'cordis' {
  interface Context {
    agents: AgentRegistry
  }
}

/**
 * Agent registry (`ctx.agents`): tracks live agents so UI, hook, and
 * orchestrator plugins can find them without depending on the concrete loop
 * package. Agent *creation* belongs to whichever plugin implements the Agent
 * interface (phase 1: `@deepseek-ai/dsh-agent-loop`).
 */
export class AgentRegistry extends Service {
  private store = new Map<string, Agent>()

  constructor(ctx: Context) {
    super(ctx, 'agents')
  }

  /**
   * Register a live agent. Throws if an agent with the same id is already
   * registered. Emits `agent/created` on registration and `agent/disposed`
   * when the calling fiber is disposed. Returns the disposer.
   */
  register(agent: Agent): () => void {
    const dispose = this.ctx.effect(() => {
      if (this.store.has(agent.id)) {
        throw new Error(`agent "${agent.id}" is already registered`)
      }
      this.store.set(agent.id, agent)
      this.ctx.emit('agent/created', agent)
      return () => {
        this.store.delete(agent.id)
        this.ctx.emit('agent/disposed', agent)
      }
    }, 'agents.register()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  get(id: string): Agent | undefined {
    return this.store.get(id)
  }

  list(): Agent[] {
    return [...this.store.values()]
  }
}

export default AgentRegistry
