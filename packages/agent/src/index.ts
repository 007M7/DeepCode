/**
 * Agent registry service. Tracks live agents so plugins can find them without
 * depending on the concrete loop package. Agent creation belongs to the loop.
 *
 * @module @deepseek-ai/dsh-agent
 */

import { Context, Service } from 'cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, AgentOptions } from './types.ts'

export * from './types.ts'

declare module 'cordis' {
  interface Context {
    agents: AgentRegistry
  }
}

/**
 * Options for programmatically creating an agent through the registry factory
 * ({@link AgentRegistry.create}). The caller supplies the live `sessionId`
 * (e.g. an ACP-generated id) and optional session metadata (the validated
 * `cwd`, fork lineage); the factory creates the session, the agent, and wires
 * them together.
 */
export interface CreateAgentOptions {
  /** The agent's id (the registry handle). */
  agentId: string
  /** The live session's id (NOT derived from agentId). */
  sessionId: string
  /**
   * Session creation metadata: validated absolute `cwd` and `parentSession`
   * fork lineage. Mirrors the `cwd`/`parentSession` fields of
   * {@link CreateSessionOptions.meta} in dsh-session (the internal-only
   * `createdAt`, used when reconstructing a persisted session, is deliberately
   * excluded — a factory caller never sets it).
   */
  meta?: { cwd?: string; parentSession?: SessionId }
  /** Per-agent options (model, system prompt). */
  agentOptions?: AgentOptions
}

/**
 * Options for resuming an agent on a persisted session
 * ({@link AgentRegistry.resume}).
 */
export interface ResumeAgentOptions {
  /** The agent's id (the registry handle). */
  agentId: string
  /** The persisted session id to load and resume on. */
  resumeSessionId: string
  /** Per-agent options (model, system prompt). */
  agentOptions?: AgentOptions
}

/**
 * The agent-creation factory the loop implementation provides to the registry
 * via {@link AgentRegistry.setFactory}. Kept on the `dsh-agent` interface so
 * consumers (e.g. the ACP bridge) program against `ctx.agents` without
 * depending on the concrete `dsh-agent-loop` package.
 */
export interface AgentFactory {
  /** Create, start, and register a new agent on a caller-supplied session id. */
  createAgent(options: CreateAgentOptions): Agent
  /**
   * Load a persisted session and resume an agent on it. Async because it awaits
   * `ctx.sessionPersistence.load`; must be called after that service exists
   * (consumers inject `sessionPersistence`).
   */
  resume(options: ResumeAgentOptions): Promise<Agent>
}

/**
 * Agent registry (`ctx.agents`): tracks live agents so UI, hook, and
 * orchestrator plugins can find them without depending on the concrete loop
 * package. Agent *creation* is provided by whichever plugin implements the
 * {@link AgentFactory} (phase 1: `@deepseek-ai/dsh-agent-loop`), registered via
 * {@link setFactory}.
 */
export class AgentRegistry extends Service {
  private store = new Map<string, Agent>()
  private factory: AgentFactory | undefined

  constructor(ctx: Context) {
    super(ctx, 'agents')
  }

  /**
   * Register the agent-creation factory (the loop calls this on construction,
   * effect-scoped). Throws if a factory is already registered. Returns the
   * disposer; on dispose the factory slot is cleared.
   */
  setFactory(factory: AgentFactory): () => void {
    const dispose = this.ctx.effect(() => {
      if (this.factory !== undefined) throw new Error('an agent factory is already registered')
      this.factory = factory
      return () => { this.factory = undefined }
    }, 'agents.setFactory()')
    return () => void dispose()
  }

  /**
   * Create, start, and register a new agent through the registered factory.
   * Distinct from {@link register} (which records an already-constructed
   * agent): this constructs the agent and its session. Throws if no factory is
   * registered.
   */
  create(options: CreateAgentOptions): Agent {
    if (this.factory === undefined) throw new Error('no agent factory registered (load an agent-loop plugin)')
    return this.factory.createAgent(options)
  }

  /**
   * Load a persisted session and resume an agent on it through the registered
   * factory. Rejects if no factory is registered; the factory rejects if
   * session persistence is not configured.
   */
  async resume(options: ResumeAgentOptions): Promise<Agent> {
    if (this.factory === undefined) throw new Error('no agent factory registered (load an agent-loop plugin)')
    return this.factory.resume(options)
  }

  /**
   * Register a live agent. Throws if an agent with the same id is already
   * registered. Emits `agent/created` on registration and `agent/disposed`
   * when the calling fiber is disposed. Returns the disposer.
   */
  register(agent: Agent): () => void {
    const dispose = this.ctx.effect(function* (this: AgentRegistry) {
      if (this.store.has(agent.id)) {
        throw new Error(`agent "${agent.id}" is already registered`)
      }
      this.store.set(agent.id, agent)
      // Yield the rollback BEFORE emitting `agent/created`: a generator effect
      // collects each yielded disposer before the next step runs, so a
      // throwing `agent/created` listener rolls the entry back instead of
      // leaking it (a leak would wedge the duplicate-id check until restart).
      // The duplicate throw above fires before any mutation — it leaks nothing.
      yield () => {
        this.store.delete(agent.id)
        this.ctx.emit('agent/disposed', agent)
      }
      this.ctx.emit('agent/created', agent)
    }.bind(this), 'agents.register()')
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
