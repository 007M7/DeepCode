/**
 * Agent registry service. Tracks live agents so plugins can find them without
 * depending on the concrete loop package. Agent creation belongs to the loop.
 *
 * @module @deepseek-ai/dsh-agent
 */

import { Context, getTraceable, Service, symbols } from 'cordis'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Scoped } from '@deepseek-ai/dsh-scope'
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

/** Options for creating an agent and its caller-named session. */
export interface CreateAgentOptions {
  /** The agent's id (the registry handle). */
  readonly agentId: AgentId
  /** The live session's id (NOT derived from agentId). */
  readonly sessionId: SessionId
  /** Durable session metadata, validated and detached before setup. */
  readonly meta?: { readonly cwd?: string; readonly parentSession?: SessionId; readonly seedLength?: number }
  /** Balanced contiguous event prefix for a forked session. */
  readonly seed?: readonly SessionEvent[]
  /** Per-agent options (model, …). */
  readonly agentOptions?: AgentOptions
  /** Optional creation-only cancellation signal; detached before the returned handle becomes visible. */
  readonly signal?: AbortSignal
  /**
   * Compose the unpublished scoped context before lifecycle announcements.
   * Failure rolls back without publishing either id; setup must not drive the agent.
   */
  readonly setup?: (agentCtx: Context) => Promise<void> | void
}

/**
 * Options for resuming an agent on a persisted session
 * ({@link AgentRegistry.resume}).
 */
export interface ResumeAgentOptions {
  /** The agent's id (the registry handle). */
  readonly agentId: AgentId
  /** The persisted session id to load and resume on. */
  readonly resumeSessionId: SessionId
  /** Per-agent options (model, …). */
  readonly agentOptions?: AgentOptions
  /** Optional creation-only cancellation signal for persistence load/setup; detached before return. */
  readonly signal?: AbortSignal
  /** Compose after persistence load under the same unpublished rollback contract as create. */
  readonly setup?: (agentCtx: Context) => Promise<void> | void
}

/**
 * Holder-owned agent capability. Disposal stops and drains the loop and idle
 * flushes before unregistering the agent, detaching its session, and unwinding
 * its scoped context. Provider unload reaches the same quiescence boundary;
 * registry observers receive only the bare {@link Agent}.
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
   * Create and compose under caller ownership, publish and announce session then
   * agent, emit session-start, and start the driver. Rollback pairs any creation
   * announcement that began.
   * @param ownerCtx - caller-bound context that owns the transaction and live handle.
   * @param options - agent/session identity, configuration, and optional setup.
   * @returns the owned handle after setup, both announcements, and loop start complete.
   */
  createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle>
  /**
   * Load, compose, publish, announce, and resume an agent under caller ownership.
   * @param ownerCtx - caller-bound context that owns load, setup, and the live handle.
   * @param options - persisted identity, configuration, and optional setup.
   * @returns the owned handle after setup, both announcements, and loop start complete.
   */
  resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle>
}

/** Thrown when create/resume is called before an agent factory is registered. */
const NO_FACTORY_MESSAGE = 'no agent factory registered (load an agent-loop plugin)'

/** All mutable lifecycle state for one exact registry entry. */
interface AgentEntry {
  readonly id: AgentId
  readonly agent: Agent
  readonly carrier: Scoped<Agent>
  announced: boolean
  announcing: boolean
  detachRequested: boolean
}

/** Plain holder prevents Cordis from tracing the factory field before the caller context is known. */
interface FactorySlot {
  readonly target: AgentFactory
}

/**
 * Agent registry (`ctx.agents`): tracks live agents so UI, hook, and
 * orchestrator plugins can find them without depending on the concrete loop
 * package. Agent *creation* is provided by whichever plugin implements the
 * {@link AgentFactory} (`@deepseek-ai/dsh-agent-loop`), registered via
 * {@link setFactory}.
 */
export class AgentRegistry extends Service {
  private store = new Map<AgentId, AgentEntry>()
  // TODO(agent-entry-mirror): derive exact-object checks from store.get(agent.id)
  // plus entry.agent identity; this WeakMap mirrors the authoritative id map.
  private entries = new WeakMap<Agent, AgentEntry>()
  private factory: FactorySlot | undefined

  constructor(ctx: Context) {
    super(ctx, 'agents')
    // Agent contexts shadow this plain-context default with an own property.
    ctx.accessor('agent', { get: () => undefined })
  }

  /**
   * Register the effect-scoped creation factory, rejecting a duplicate. Service
   * factories are retraced through each create/resume caller for ownership.
   * @param factory - the loop-owned factory {@link create}/{@link resume} delegate to.
   * @returns the exact Cordis effect disposer.
   */
  setFactory(factory: AgentFactory): () => void {
    const dispose = this.ctx.effect(() => {
      if (this.factory !== undefined) throw new Error('an agent factory is already registered')
      // Store the concrete service; calls are retraced through their owner.
      const target = (factory as AgentFactory & { [symbols.original]?: AgentFactory })[symbols.original] ?? factory
      this.factory = { target }
      return () => { this.factory = undefined }
    }, 'agents.setFactory()')
    // Return the exact disposer so composite effects preserve teardown order.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return dispose
  }

  /** Return the active creation factory. */
  private requireFactory(): FactorySlot {
    if (this.factory === undefined) throw new Error(NO_FACTORY_MESSAGE)
    return this.factory
  }

  /**
   * Create and publish an owned agent and session through the active factory.
   * Rejects if no factory is registered or creation, setup, or publication fails.
   * @param options - agent id, session id/seed/metadata, and agent options.
   * @returns the handle after setup, rollback-covered publication, and loop start complete.
   */
  async create(options: CreateAgentOptions): Promise<AgentHandle> {
    const ownerCtx = this.ctx
    // Bind service effects to this caller while preserving factory dependencies.
    const { target } = this.requireFactory()
    const receiver = getTraceable(ownerCtx, target)
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply intentionally supplies the caller-traced receiver
    return Reflect.apply(target.createAgent, receiver, [ownerCtx, options])
  }

  /**
   * Load a persisted session and resume an agent on it through the registered
   * factory. Rejects if no factory is registered; the factory rejects if
   * session persistence is not configured or persistence/setup fails.
   * @param options - persisted identity, configuration, and optional setup.
   * @returns the handle after setup, rollback-covered publication, and loop start complete.
   */
  async resume(options: ResumeAgentOptions): Promise<AgentHandle> {
    const ownerCtx = this.ctx
    const { target } = this.requireFactory()
    const receiver = getTraceable(ownerCtx, target)
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply intentionally supplies the caller-traced receiver
    return Reflect.apply(target.resume, receiver, [ownerCtx, options])
  }

  /**
   * Register a live agent in the calling effect scope, with scope-filtered
   * creation and disposal events. Duplicate ids throw.
   * @param agent - the already-constructed agent to record in the store.
   * @returns the exact Cordis effect disposer for nested teardown ordering.
   */
  register(agent: Agent): () => void {
    const dispose = this.ctx.effect(function* (this: AgentRegistry) {
      yield this.enter(agent)
      this.announce(agent)
    }.bind(this), 'agents.register()')
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return dispose
  }

  /**
   * Insert an unpublished agent for an ordered factory transaction.
   * @param agent - the prepared, unpublished agent.
   * @returns an idempotent closure that removes this exact entry and emits the
   * paired disposal edge; detachment during creation dispatch is deferred.
   */
  enter(agent: Agent): () => void {
    const id = agent.id
    const carrier = scopeTarget(agent, agent)
    // Prepared transactions arbitrate identity at this publication boundary.
    if (this.entries.has(agent) || this.store.has(id)) throw new Error(`agent "${id}" is already registered`)
    const entry: AgentEntry = {
      id,
      agent,
      carrier,
      announced: false,
      announcing: false,
      detachRequested: false,
    }
    this.store.set(id, entry)
    this.entries.set(agent, entry)
    let entered = true
    const detach = (): void => {
      if (!entered) return
      entered = false
      // Creation listeners observe one stable entry before paired disposal.
      if (entry.announcing) {
        entry.detachRequested = true
        return
      }
      this.detachEntered(entry)
    }
    return detach
  }

  /** Remove one exact entered agent and emit its paired disposal when announced. */
  private detachEntered(entry: AgentEntry): void {
    entry.detachRequested = false
    // A stale capability can never delete a later same-id lifecycle. The
    // captured entry identity is the final boundary.
    /* v8 ignore next -- enter() rejects replacement while this single-shot detach capability is live. */
    if (this.store.get(entry.id) !== entry) return
    this.store.delete(entry.id)
    this.entries.delete(entry.agent)
    // An insertion rolled back before announce was never externally created,
    // so emitting disposed would invent an impossible lifecycle edge. Marking
    // happens before the created emit: if a later created listener throws,
    // earlier listeners may already have observed it and must see disposal.
    if (!entry.announced) return
    this.emitDisposed(entry)
  }

  /** Emit the paired disposal edge through the entry's stable carrier. */
  private emitDisposed(entry: AgentEntry): void {
    const args: unknown[] = [entry.carrier, 'agent/disposed', entry.agent]
    for (const callback of this.ctx.events.dispatch('emit', args)) {
      try {
        const returned: unknown = callback(...args)
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`agent "${entry.id}": agent/disposed listener rejected: ${String(error)}`)
        })
      } catch (error: unknown) {
        this.ctx.logger.warn(`agent "${entry.id}": agent/disposed listener threw: ${String(error)}`)
      }
    }
  }

  /**
   * Announce an agent previously inserted with {@link enter}.
   * @param agent - the live inserted agent to announce.
   * @throws if `agent` is not the exact live registry entry for its id, or its
   *   creation announcement already began (including a reentrant call from a
   *   creation listener).
   */
  announce(agent: Agent): void {
    const entry = this.entries.get(agent)
    if (entry === undefined || this.store.get(entry.id) !== entry) {
      throw new Error(`agent "${agent.id}" is not live in this registry`)
    }
    if (entry.announced || entry.announcing) {
      throw new Error(`agent "${entry.id}" was already announced`)
    }
    // Mark before dispatch so a listener cannot recursively create a second
    // lifecycle edge; detach still pairs a partially delivered first edge.
    entry.announcing = true
    entry.announced = true
    const args: unknown[] = [entry.carrier, 'agent/created', entry.agent]
    try {
      for (const callback of this.ctx.events.dispatch('emit', args)) {
        // A synchronous creation failure vetoes publication and rolls back.
        // Returned-promise rejection happens after this synchronous boundary, so
        // observe and report it instead of leaking an unhandled rejection.
        const returned: unknown = callback(...args)
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`agent "${entry.id}": agent/created listener rejected: ${String(error)}`)
        })
      }
    } finally {
      entry.announcing = false
      if (entry.detachRequested) this.detachEntered(entry)
    }
  }

  /**
   * Look up a live agent.
   * @param id - the agent id to look up.
   * @returns the agent, or undefined when no live agent has that id.
   */
  get(id: AgentId): Agent | undefined {
    return this.store.get(id)?.agent
  }

  /**
   * All live agents, in registration order.
   * @returns a fresh array; mutating it does not affect the registry.
   */
  list(): Agent[] {
    return [...this.store.values()].map(entry => entry.agent)
  }
}

export default AgentRegistry
