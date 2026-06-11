/**
 * THE concrete agent plugin: creates LoopAgents, runs their loops, and
 * registers them in ctx.agents. Deliberately thin — every behavior beyond
 * "call the model, run the tools, repeat" belongs to plugins on the event
 * taxonomy.
 *
 * @module @deepseek-ai/dsh-agent-loop
 */

import { Context, Service } from 'cordis'
import z from 'schemastery'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { LoopAgent } from './agent.ts'

export { LoopAgent } from './agent.ts'
export { Inbox, type InboxMessage } from './inbox.ts'
export { runLoop } from './loop.ts'

declare module 'cordis' {
  interface Context {
    agentLoop: AgentLoop
  }
}

export interface Config {
  /** Agents created from configuration at startup. */
  agents: (AgentOptions & { id: string })[]
}

/**
 * The agent-loop plugin (`ctx.agentLoop`): creates {@link LoopAgent}s, runs
 * their loops, and registers them in `ctx.agents`.
 *
 * The loop itself is deliberately thin — every behavior beyond "call the
 * model, run the tools, repeat" belongs to plugins listening on the event
 * taxonomy declared in @deepseek-ai/dsh-agent.
 */
export class AgentLoop extends Service {
  static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt']

  static Config: z<Config> = z.object({
    agents: z.array(z.object({
      id: z.string().required(),
      model: z.string(),
      systemPrompt: z.string(),
    })).default([]),
  })

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'agentLoop')
    for (const { id, ...options } of config.agents) {
      this.create(id, options)
    }
  }

  /**
   * Create an agent, start its loop, and register it. Returns the agent.
   * Disposed with the calling fiber.
   *
   * TODO(sub-agents): spawn/fork land here — accept a parent agent reference;
   * fork seeds the new Session with the parent's event log, spawn starts
   * fresh; the child is returned as a regular Agent handle.
   */
  create(id: string, options: AgentOptions = {}): LoopAgent {
    const session = this.ctx.sessions.create(`${id}-session`)
    const agent = new LoopAgent(this.ctx, id, options, session)
    // Generator effect: stop and unregister are independent disposables
    // (LIFO), so a throwing stop() cannot leak the registry entry.
    this.ctx.effect(function* (this: AgentLoop) {
      yield this.ctx.agents.register(agent)
      yield agent.start()
    }.bind(this), 'agentLoop.create()')
    return agent
  }
}

export default AgentLoop
