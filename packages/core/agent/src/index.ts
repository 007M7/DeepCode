/**
 * Agent registry service. Tracks live agents so plugins can find them without
 * depending on the concrete loop package. Agent creation belongs to the loop.
 *
 * @module @deepseek-ai/dsh-agent
 */

import { Context, Service } from 'cordis'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, AgentId, AgentOptions } from './types.ts'

export * from './types.ts'
export { agentEvents, assembleContextFor } from './dispatch.ts'
export type { AgentEventDispatch, AgentSubjectEvent } from './dispatch.ts'

declare module 'cordis' {
  interface Context {
    agents: AgentRegistry
    /**
     * The agent association installed as an own property on `Agent.ctx`, or
     * `undefined` on a plain context. Contexts derived from `Agent.ctx` inherit
     * the association; a deliberately nested scope may carry a nearer
     * `dsh-scope` tag while retaining it, so this field is DX context rather
     * than the scope resolver. {@link AgentRegistry} registers a root accessor
     * defaulting to `undefined`, and core packages below the agent layer use
     * `scopeOf()` for layer selection instead of reading this field.
     */
    agent?: Agent
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
  agentId: AgentId
  /** The live session's id (NOT derived from agentId). */
  sessionId: SessionId
  /**
   * Session creation metadata: validated absolute `cwd`, `parentSession`
   * fork lineage, and the `seedLength` seed boundary. Mirrors the
   * `cwd`/`parentSession`/`seedLength` fields of
   * {@link CreateSessionOptions.meta} in dsh-session (the internal-only
   * `createdAt`, used when reconstructing a persisted session, is deliberately
   * excluded — a factory caller never sets it).
   */
  meta?: { cwd?: string; parentSession?: SessionId; seedLength?: number }
  /**
   * Seed events to reconstruct the child session's log from (the fork lineage
   * primitive). When present, the factory creates the session with this event
   * prefix so `deriveMessages()`/`lastTurnNumber` continue from it — used by the
   * in-process FORK subagent backend to seed a child with a balanced
   * completed-turn prefix of the parent's log. The prefix MUST be contiguous
   * from seq 0 and balanced (no open turn/step, no dangling tool-call), or the
   * session constructor (and the dev-mode invariants replay) reject it. Absent
   * for a fresh (spawn) child.
   */
  seed?: SessionEvent[]
  /** Per-agent options (model, …). */
  agentOptions?: AgentOptions
  /**
   * Creation-time composition of the agent's scoped world.
   */
  setup?: (agentCtx: Context) => Promise<void> | void
}

/**
 * Options for resuming an agent on a persisted session
 * ({@link AgentRegistry.resume}).
 */
export interface ResumeAgentOptions {
  /** The agent's id (the registry handle). */
  agentId: AgentId
  /** The persisted session id to load and resume on. */
  resumeSessionId: SessionId
  /** Per-agent options (model, …). */
  agentOptions?: AgentOptions
  /**
   * Resume-time composition of the agent's fresh scoped world. Persistence is
   * loaded first; the factory then mints `agentCtx` and awaits setup while the
   * reconstructed session and agent remain unpublished. The callback has the
   * same composition-only contract as {@link CreateAgentOptions.setup}: all
   * registrations exist before either creation announcement, driving verbs are
   * unavailable until the session-start boundary, and rejection or owner
   * disposal rolls the transaction back without publishing either id.
   */
  setup?: (agentCtx: Context) => Promise<void> | void
}

/**
 * An owned agent plus its disposer, returned by {@link AgentRegistry.create} / {@link
 * AgentRegistry.resume}.
 */
export interface AgentHandle {
  agent: Agent
  dispose(): Promise<void>
}

/**
 * The agent-creation factory the loop implementation provides to the registry
 * via {@link AgentRegistry.setFactory}. Kept on the `dsh-agent` interface so
 * consumers (e.g. the ACP bridge) program against `ctx.agents` without
 * depending on the concrete `dsh-agent-loop` package.
 */
export interface AgentFactory {
  /**
   * Create a new agent on a caller-supplied session id.
   *
   * @param options - agent/session identity, configuration, and optional setup.
   * @returns the owned handle after setup, both announcements, and loop start complete.
   */
  createAgent(options: CreateAgentOptions): Promise<AgentHandle>
  /**
   * Load a persisted session and resume an agent on it. Async because it awaits
   * both `ctx.sessionPersistence.load` and the optional unpublished setup
   * transaction; must be called after that service exists (consumers inject
   * `sessionPersistence`). Publication and drive unlocking follow the same
   * ordered boundary as {@link createAgent}.
   * @param options - persisted identity, configuration, and optional setup.
   * @returns the owned handle after setup, both announcements, and loop start complete.
   */
  resume(options: ResumeAgentOptions): Promise<AgentHandle>
}

/** Thrown when create/resume is called before an agent factory is registered. */
const NO_FACTORY_MESSAGE = 'no agent factory registered (load an agent-loop plugin)'

/**
 * Agent registry (`ctx.agents`): tracks live agents so UI, hook, and
 * orchestrator plugins can find them without depending on the concrete loop
 * package. Agent *creation* is provided by whichever plugin implements the
 * {@link AgentFactory} (`@deepseek-ai/dsh-agent-loop`), registered via
 * {@link setFactory}.
 */
export class AgentRegistry extends Service {
  private store = new Map<AgentId, Agent>()
  /** Entries whose `agent/created` announcement phase began. */
  private announced = new WeakSet<Agent>()
  private factory: AgentFactory | undefined

  constructor(ctx: Context) {
    super(ctx, 'agents')
    // The `ctx.agent` DX accessor: default `undefined` on every context, so a plain plugin
    // context reads cleanly instead of hitting the Cordis unknown-property throw.
    ctx.accessor('agent', { get: () => undefined })
  }

  /**
   * Register the agent-creation factory (the loop calls this on construction,
   * effect-scoped). Throws if a factory is already registered. Returns the
   * disposer; on dispose the factory slot is cleared.
   * @param factory - the loop-owned factory {@link create}/{@link resume} delegate to.
   * @returns the disposer that clears the factory slot. The exact
   *   Cordis effect disposer (single-shot): composite (generator) effects may
   *   yield it directly — exact identity nests the teardown in order.
   */
  setFactory(factory: AgentFactory): () => Promise<void> | void {
    const dispose = this.ctx.effect(() => {
      if (this.factory !== undefined) throw new Error('an agent factory is already registered')
      this.factory = factory
      return () => { this.factory = undefined }
    }, 'agents.setFactory()')
    // Return the exact Cordis disposer to preserve teardown nesting.
    return dispose
  }

  /**
   * Create and publish a new agent through the registered factory.
   * Distinct from {@link register} (which records an already-constructed
   * agent): this constructs the agent and its session. Rejects if no factory is
   * registered or creation/setup fails. The resolved {@link AgentHandle} lets
   * the owner tear down exactly this agent.
   * @param options - agent id, session id/seed/metadata, and agent options.
   * @returns the handle after setup, rollback-covered publication, and loop start complete.
   */
  async create(options: CreateAgentOptions): Promise<AgentHandle> {
    if (this.factory === undefined) throw new Error(NO_FACTORY_MESSAGE)
    return this.factory.createAgent(options)
  }

  /**
   * Load a persisted session and resume an agent on it through the registered
   * factory. Rejects if no factory is registered; the factory rejects if
   * session persistence is not configured or persistence/setup fails.
   * @param options - persisted identity, configuration, and optional setup.
   * @returns the handle after setup, rollback-covered publication, and loop start complete.
   */
  async resume(options: ResumeAgentOptions): Promise<AgentHandle> {
    if (this.factory === undefined) throw new Error(NO_FACTORY_MESSAGE)
    return this.factory.resume(options)
  }

  /**
   * Register a live agent.
   *
   * @param agent - the already-constructed agent to record in the store.
   * @returns the EXACT Cordis effect disposer (single-shot; a repeat call returns undefined
   *   without awaiting an in-flight teardown).
   */
  register(agent: Agent): () => Promise<void> | void {
    const dispose = this.ctx.effect(function* (this: AgentRegistry) {
      yield this.enter(agent)
      this.announce(agent)
    }.bind(this), 'agents.register()')
    return dispose
  }

  /**
   * Insert an already-constructed agent without announcing it. This is the
   * advanced ordered-lifecycle primitive used by the async agent factory: it
   * first completes setup while the agent is unpublished, then assigns the
   * returned detach closure into its pre-installed composite teardown before
   * calling {@link announce}. Ordinary callers use {@link register}.
   * @param agent - the prepared, unpublished agent.
   * @returns an idempotent closure that removes this exact entry and emits
   *   `agent/disposed` with listener failures contained.
   */
  enter(agent: Agent): () => void {
    if (this.store.has(agent.id)) {
      throw new Error(`agent "${agent.id}" is already registered`)
    }
    this.store.set(agent.id, agent)
    let entered = true
    return () => {
      if (!entered) return
      entered = false
      this.store.delete(agent.id)
      // An insertion rolled back before announce was never externally created, so emitting
      // disposed would invent an impossible lifecycle edge.
      if (!this.announced.delete(agent)) return
      try {
        this.ctx.emit(scopeTarget(agent, agent), 'agent/disposed', agent)
      } catch (error: unknown) {
        this.ctx.logger.warn(`agent "${agent.id}": agent/disposed listener threw: ${String(error)}`)
      }
    }
  }

  /**
   * Announce an agent previously inserted with {@link enter}.
   * @param agent - the live inserted agent to announce.
   * @throws if `agent` is not the exact live registry entry for its id.
   */
  announce(agent: Agent): void {
    if (this.store.get(agent.id) !== agent) {
      throw new Error(`agent "${agent.id}" is not live in this registry`)
    }
    this.announced.add(agent)
    this.ctx.emit(scopeTarget(agent, agent), 'agent/created', agent)
  }

  /**
   * Look up a live agent.
   * @param id - the agent id to look up.
   * @returns the agent, or undefined when no live agent has that id.
   */
  get(id: AgentId): Agent | undefined {
    return this.store.get(id)
  }

  /**
   * All live agents, in registration order.
   * @returns a fresh array; mutating it does not affect the registry.
   */
  list(): Agent[] {
    return [...this.store.values()]
  }
}

export default AgentRegistry
