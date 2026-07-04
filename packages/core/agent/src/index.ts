/**
 * Agent registry service. Tracks live agents so plugins can find them without
 * depending on the concrete loop package. Agent creation belongs to the loop.
 *
 * @module @deepseek-ai/dsh-agent
 */

import { Context, Service } from 'cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, AgentId, AgentOptions } from './types.ts'

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
  /** Per-agent options (model, system prompt). */
  agentOptions?: AgentOptions
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
  /** Per-agent options (model, system prompt). */
  agentOptions?: AgentOptions
}

/**
 * An owned agent plus its disposer, returned by {@link AgentRegistry.create} /
 * {@link AgentRegistry.resume}. The disposer is a CAPABILITY: only the holder
 * can tear this agent down. `dispose()` unregisters the agent, stops its loop,
 * awaits the loop's exit (quiescence — NOT just the `disposed` status flip), and
 * removes the agent's session from the store, in an order that captures the
 * loop's final `session/flush` before the session is detached.
 *
 * `ctx.agents.get(id)` still returns a bare {@link Agent} — the handle is only
 * for the OWNER that created it. Config-created agents (the loop's own startup)
 * are owned by the loop fiber and never need a handle.
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
   * Create, start, and register a new agent on a caller-supplied session id.
   * Returns an {@link AgentHandle} — the owner disposes it to tear down exactly
   * this agent (unregister + stop loop + await quiescence + remove session).
   */
  createAgent(options: CreateAgentOptions): AgentHandle
  /**
   * Load a persisted session and resume an agent on it. Async because it awaits
   * `ctx.sessionPersistence.load`; must be called after that service exists
   * (consumers inject `sessionPersistence`). Returns an {@link AgentHandle}.
   */
  resume(options: ResumeAgentOptions): Promise<AgentHandle>
}

/** Thrown when create/resume is called before an agent factory is registered. */
const NO_FACTORY_MESSAGE = 'no agent factory registered (load an agent-loop plugin)'

/**
 * Agent registry (`ctx.agents`): tracks live agents so UI, hook, and
 * orchestrator plugins can find them without depending on the concrete loop
 * package. Agent *creation* is provided by whichever plugin implements the
 * {@link AgentFactory} (phase 1: `@deepseek-ai/dsh-agent-loop`), registered via
 * {@link setFactory}.
 */
export class AgentRegistry extends Service {
  private store = new Map<AgentId, Agent>()
  private factory: AgentFactory | undefined

  constructor(ctx: Context) {
    super(ctx, 'agents')
  }

  /**
   * Register the agent-creation factory (the loop calls this on construction,
   * effect-scoped). Throws if a factory is already registered. Returns the
   * disposer; on dispose the factory slot is cleared.
   * @param factory - the loop-owned factory {@link create}/{@link resume} delegate to.
   * @returns the disposer that clears the factory slot.
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
   * registered. Returns an {@link AgentHandle} — the owner disposes it to tear
   * down exactly this agent.
   * @param options - agent id, session id/seed/metadata, and agent options.
   * @returns the handle whose dispose tears down exactly this agent.
   */
  create(options: CreateAgentOptions): AgentHandle {
    if (this.factory === undefined) throw new Error(NO_FACTORY_MESSAGE)
    return this.factory.createAgent(options)
  }

  /**
   * Load a persisted session and resume an agent on it through the registered
   * factory. Rejects if no factory is registered; the factory rejects if
   * session persistence is not configured. Returns an {@link AgentHandle}.
   * @param options - the persisted session id plus agent id and options.
   * @returns the handle for the resumed agent.
   */
  async resume(options: ResumeAgentOptions): Promise<AgentHandle> {
    if (this.factory === undefined) throw new Error(NO_FACTORY_MESSAGE)
    return this.factory.resume(options)
  }

  /**
   * Register a live agent. Throws if an agent with the same id is already
   * registered. Emits `agent/created` on registration and `agent/disposed`
   * when the calling fiber is disposed. Returns the disposer.
   * @param agent - the already-constructed agent to record in the store.
   * @returns the disposer that removes the agent and emits `agent/disposed`.
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
        // CONTAIN a throwing `agent/disposed` listener: this disposer runs as
        // one link in the owning fiber/effect's disposal chain, and Cordis
        // chains later disposers with `task.then(next)` — so an UNCAUGHT throw
        // here rejects the chain and SKIPS every later disposer. When this
        // registration shares a composite effect with a session (the agent
        // factory's `AgentLoop.start`, where the session-detach disposer runs
        // AFTER this one), a swallowed-less throw would strand the session in
        // the store with `onAppend` attached — a leak AND a durability hole.
        // The store entry is already removed above (the useful state), so
        // logging the listener bug and continuing is correct (mirrors the
        // guarded `agent/status` emit in dsh-agent-loop's ReactLoopAgent).
        try {
          this.ctx.emit('agent/disposed', agent)
        } catch (error: unknown) {
          this.ctx.logger.warn(`agent "${agent.id}": agent/disposed listener threw: ${String(error)}`)
        }
      }
      this.ctx.emit('agent/created', agent)
    }.bind(this), 'agents.register()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
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
