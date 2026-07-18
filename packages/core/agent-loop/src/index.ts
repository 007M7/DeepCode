/**
 * Concrete agent-loop plugin: creates scoped ReactLoopAgents, publishes them
 * through the agent/session registries, and owns their ordered teardown.
 *
 * @module @deepseek-ai/dsh-agent-loop
 */

import { Context, FiberState, Service } from 'cordis'
import { randomUUID } from 'node:crypto'
import z from 'schemastery'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type {
  AgentFactory,
  AgentHandle,
  AgentId,
  AgentOptions,
  CreateAgentOptions,
  ResumeAgentOptions,
  SessionStartSource,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import {
  bindReactLoopAgentContext,
  prepareReactLoopAgent,
  ReactLoopAgent,
} from './agent.ts'
import type { PreparedReactLoopAgent } from './agent.ts'
import { DEFAULT_MAX_PARALLEL_TOOL_CALLS } from './constants.ts'

export { ReactLoopAgent } from './agent.ts'

/** Fiber states that cannot own or serve a new lifecycle. */
const INACTIVE_STATES: ReadonlySet<FiberState> = new Set([
  FiberState.UNLOADING,
  FiberState.DISPOSED,
  FiberState.FAILED,
])

/** Factory-level ownership of every preparing or live transaction. */
class FactoryOwnership {
  private accepting = true
  private transactions = new Set<AgentCreationTransaction>()

  constructor(private readonly fiber: Context['fiber']) {}

  isActive(): boolean {
    return this.accepting && !INACTIVE_STATES.has(this.fiber.state)
  }

  track(transaction: AgentCreationTransaction): () => void {
    this.transactions.add(transaction)
    return () => { this.transactions.delete(transaction) }
  }

  async dispose(): Promise<void> {
    this.accepting = false
    const reason = new Error('agent loop is not active')
    await Promise.all(
      [...this.transactions].map(transaction => transaction.disposeForFactory(reason)),
    )
  }
}

/** Build the public cancellation error while preserving a caller-supplied cause. */
function signalAbortError(id: AgentId, signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new Error(`agent "${id}" creation aborted`, { cause: signal.reason })
}

/** Resolve the deployment-wide scheduler cap at the owning config boundary. */
function resolveMaxParallelToolCalls(value: number | undefined): number {
  const maxParallelToolCalls = value ?? DEFAULT_MAX_PARALLEL_TOOL_CALLS
  if (!Number.isInteger(maxParallelToolCalls) || maxParallelToolCalls < 1) {
    throw new Error('maxParallelToolCalls must be a positive integer')
  }
  return maxParallelToolCalls
}

/**
 * Caller-owned create/resume transaction through rollback-covered publication
 * and quiescent teardown. Resources remain private until the final registry
 * entry arbitrates identity.
 */
class AgentCreationTransaction {
  private active = true
  private failure: Error | undefined
  private readonly deactivation = Promise.withResolvers<void>()
  private readonly publication = Promise.withResolvers<void>()
  private readonly torndown = Promise.withResolvers<void>()
  private readonly wrapperCompletion = Promise.withResolvers<void>()
  private preparing: Promise<void> | undefined
  private driver: PreparedReactLoopAgent | undefined
  private scope: Scope | undefined
  private session: Session | undefined
  private lifecycleDispose: (() => Promise<void> | void) | undefined
  private detachSession: (() => void) | undefined
  private detachAgent: (() => void) | undefined
  private publishing = false
  private cleanupTask: Promise<void> | undefined
  private ownerFollowing = true
  private readonly ownerDispose: () => Promise<void> | void
  private readonly untrackFactory: () => void
  private readonly abortListener: (() => void) | undefined
  readonly ownerAgent: Context['agent']
  readonly ownerFiber: Context['fiber']

  constructor(
    private readonly loopCtx: Context,
    private readonly ownerCtx: Context,
    private readonly ownership: FactoryOwnership,
    readonly id: AgentId,
    signal?: AbortSignal,
  ) {
    ownerCtx.fiber.assertActive()
    this.ownerAgent = ownerCtx.agent
    this.ownerFiber = ownerCtx.fiber
    if (!ownership.isActive()) throw new Error('agent loop is not active')
    this.ownerDispose = ownerCtx.effect(() => () => {
      if (!this.ownerFollowing) return
      return this.dispose(new Error(`agent "${id}" setup aborted: owner disposed during setup`))
    }, `agentLoop.owner(${id})`)
    this.untrackFactory = ownership.track(this)
    if (signal === undefined) {
      this.abortListener = undefined
    } else {
      this.abortListener = () => {
        /* v8 ignore next 3 -- transaction teardown contains callback/driver failures; rejection is a future-drift backstop. */
        void this.dispose(signalAbortError(id, signal)).catch((error: unknown) => {
          this.loopCtx.logger.error(error)
        })
      }
      signal.addEventListener('abort', this.abortListener, { once: true })
      if (signal.aborted) this.deactivate(signalAbortError(id, signal))
    }
    this.signal = signal
  }

  private readonly signal: AbortSignal | undefined

  /** Whether caller, provider, and optional parent-agent ownership remain live. */
  isActive(): boolean {
    return this.active
      && this.ownership.isActive()
      && this.ownerFiber.uid !== null
      && !INACTIVE_STATES.has(this.ownerFiber.state)
      && this.ownerAgent?.status !== 'disposed'
  }

  /** Fail synchronously at every real lifecycle boundary after deactivation. */
  assertActive(): void {
    if (this.isActive()) return
    if (!this.ownership.isActive()) throw new Error('agent loop is not active')
    throw this.failure ?? new Error(`agent "${this.id}" setup aborted: owner disposed during setup`)
  }

  /** Race an external async operation against structural/signal deactivation. */
  async waitFor<T>(operation: PromiseLike<T> | T): Promise<T> {
    this.assertActive()
    return await Promise.race([
      Promise.resolve(operation),
      this.deactivation.promise.then(() => {
        /* v8 ignore next -- deactivate() assigns failure before resolving deactivation. */
        throw this.failure ?? new Error(`agent "${this.id}" creation deactivated`)
      }),
    ])
  }

  /** Construct the driver and scope, then install their complete ordered lifecycle. */
  prepare(options: AgentOptions, session: Session, maxParallelToolCalls: number): ReactLoopAgent {
    this.assertActive()
    const gate = Promise.withResolvers<void>()
    this.preparing = gate.promise
    try {
      this.session = session
      const driver = prepareReactLoopAgent(this.loopCtx, this.id, options, session, maxParallelToolCalls)
      this.driver = driver
      const agent = driver.agent
      const scope = createScope(this.loopCtx, agent)
      this.scope = scope
      bindReactLoopAgentContext(agent, scope.ctx.extend({ agent }))
      this.installLifecycle(scope, driver)
      this.assertActive()
      return agent
    } catch (error: unknown) {
      if (!this.isActive() && error instanceof Error && /inactive context/.test(error.message)) {
        throw this.failure ?? this.disposalReason()
      }
      throw error
    } finally {
      gate.resolve()
      this.preparing = undefined
    }
  }

  /** Register the exact scope disposer inside the ordered transaction effect. */
  private installLifecycle(scope: Scope, driver: PreparedReactLoopAgent): void {
    this.lifecycleDispose = this.ownerCtx.effect(function* (this: AgentCreationTransaction) {
      // First yielded, disposed last.
      yield () => { this.finish() }
      yield scope.rawDispose
      yield () => {
        this.detachSession?.()
        this.detachSession = undefined
      }
      yield () => {
        this.detachAgent?.()
        this.detachAgent = undefined
      }
      // Last yielded, disposed first.
      yield () => {
        this.deactivate(this.disposalReason())
        if (this.publishing) {
          return this.publication.promise.then(() => driver.dispose())
        }
        return driver.dispose()
      }
    }.bind(this), `agentLoop.lifecycle(${this.id})`)
  }

  /** Publish the exact prepared objects and start the driver. */
  publish(source: SessionStartSource): AgentHandle {
    this.assertActive()
    const driver = this.driver
    /* v8 ignore next -- publish() is private and every caller invokes prepare() first. */
    if (driver === undefined) throw new Error(`agent "${this.id}" is not prepared`)
    const agent = driver.agent
    const session = this.session
    /* v8 ignore next -- prepare() assigns the session before it can produce the driver above. */
    if (session === undefined) throw new Error(`agent "${this.id}" has no prepared session`)
    this.publishing = true
    try {
      this.detachSession = agent.ctx.sessions.enter(session)
      this.detachAgent = this.loopCtx.agents.enter(agent)

      agent.ctx.sessions.announce(session)
      this.assertActive()
      this.loopCtx.agents.announce(agent)
      this.assertActive()

      driver.markPublished()
      agentEvents(this.loopCtx, agent).emit('agent/session-start', source)
      this.assertActive()
      driver.startDriver()
      return { agent, dispose: () => this.dispose() }
    } finally {
      this.publishing = false
      this.publication.resolve()
    }
  }

  /** Mark the transaction inactive exactly once and wake load/setup races. */
  private deactivate(reason: Error): void {
    if (!this.active) return
    this.active = false
    this.failure = reason
    this.deactivation.resolve()
  }

  /** Choose the structural cause when an owner/factory effect starts teardown first. */
  private disposalReason(): Error {
    if (this.failure !== undefined) return this.failure
    if (!this.ownership.isActive()) return new Error('agent loop is not active')
    if (this.ownerFiber.uid === null || INACTIVE_STATES.has(this.ownerFiber.state) || this.ownerAgent?.status === 'disposed') {
      return new Error(`agent "${this.id}" setup aborted: owner disposed during setup`)
    }
    return new Error(`agent "${this.id}" lifecycle disposed`)
  }

  /** Complete ownership bookkeeping after every resource reached quiescence. */
  private finish(): void {
    this.untrackFactory()
    this.ownerFollowing = false
    void this.ownerDispose()
    this.torndown.resolve()
  }

  /**
   * Deactivate and quiesce this transaction. The promise is memoized because
   * Cordis effect disposers are single-shot while handles promise shared
   * quiescence to every racing owner.
   */
  dispose(reason = new Error(`agent "${this.id}" lifecycle disposed`)): Promise<void> {
    this.deactivate(reason)
    return (this.cleanupTask ??= (async () => {
      if (this.preparing !== undefined) await this.preparing
      if (this.lifecycleDispose !== undefined) {
        await this.lifecycleDispose()
        await this.torndown.promise
        return
      }
      try {
        await this.driver?.dispose()
      } finally {
        try {
          await this.scope?.dispose()
        } finally {
          this.finish()
        }
      }
    })())
  }

  /** Mark the public create/resume continuation settled and detach its creation-only signal. */
  finishWrapper(): void {
    if (this.signal !== undefined && this.abortListener !== undefined) {
      this.signal.removeEventListener('abort', this.abortListener)
    }
    this.wrapperCompletion.resolve()
  }

  /** Factory shutdown joins both resource teardown and the public wrapper's deactivation continuation. */
  async disposeForFactory(reason: Error): Promise<void> {
    await this.dispose(reason)
    await this.wrapperCompletion.promise
  }
}

declare module 'cordis' {
  interface Context {
    agentLoop: AgentLoop
  }
}

export { DEFAULT_MAX_PARALLEL_TOOL_CALLS }

/** Agent-loop plugin configuration. */
export interface Config {
  /**
   * Maximum parallel-safe calls in flight per agent step. `1` is serial;
   * omission defaults to {@link DEFAULT_MAX_PARALLEL_TOOL_CALLS}.
   */
  maxParallelToolCalls?: number
  /** Agents created or resumed at plugin startup. */
  agents: (AgentOptions & {
    /** Registry identity for the live agent. */
    id: AgentId
    /** Optional workspace for a fresh session. */
    cwd?: string
    /** Persisted session to resume instead of creating a fresh session. */
    resumeSessionId?: SessionId
  })[]
}

/** Concrete ReactLoopAgent factory and driver service. */
export class AgentLoop extends Service implements AgentFactory {
  static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt']

  /** Runtime schema for declarative agents. */
  static Config = z.object({
    maxParallelToolCalls: z.number().step(1).min(1).default(DEFAULT_MAX_PARALLEL_TOOL_CALLS),
    agents: z.array(z.object({
      id: z.string().required(),
      provider: z.string(),
      model: z.string(),
      cwd: z.string(),
      resumeSessionId: z.string(),
    })).default([]),
  }) as unknown as z<Config>

  private readonly ownership: FactoryOwnership
  /** Resolved concurrency cap for every driver created by this factory. */
  private readonly maxParallelToolCalls: number
  /** Plain holder prevents Cordis from re-tracing the factory's dependency context through a caller shadow. */
  private readonly runtime: { ctx: Context }

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'agentLoop')
    this.maxParallelToolCalls = resolveMaxParallelToolCalls(config.maxParallelToolCalls)
    this.ownership = new FactoryOwnership(ctx.fiber)
    this.runtime = { ctx }
    ctx.effect(() => () => this.ownership.dispose(), 'agentLoop.transactions()')
    ctx.effect(() => ctx.agents.setFactory(this), 'agentLoop.setFactory()')
    ctx.systemPrompt.variable('provider', context => context.agent?.options.provider)
    ctx.systemPrompt.variable('model', context => context.agent?.options.model)
    ctx.systemPrompt.variable('cwd', context => context.agent?.session.header.cwd)

    for (const { id, cwd, resumeSessionId, ...options } of config.agents) {
      if (resumeSessionId === undefined || resumeSessionId === '') {
        this.create(id, options, cwd === undefined ? {} : { cwd })
        continue
      }
      ctx.effect(() => {
        const fiber = ctx.inject(['sessionPersistence'], (childCtx: Context) => {
          void this.resumeWith(ctx, childCtx.sessionPersistence, {
            agentId: id,
            resumeSessionId,
            agentOptions: options,
          }).catch((error: unknown) => {
            ctx.logger.warn(`agent "${id}": config-driven resume of "${resumeSessionId}" failed: ${String(error)}`)
          })
        })
        return fiber.dispose
      }, `agentLoop.resume(${id})`)
    }
  }

  /**
   * Create an agent on a fresh per-run session, owned by the accessing fiber.
   * Constructor-driven config calls use the loop fiber itself.
   * @param id - agent registry id.
   * @param options - concrete loop options.
   * @param meta - optional fresh-session workspace metadata.
   * @returns the published running agent.
   */
  create(id: AgentId, options: AgentOptions = {}, meta: Pick<SessionHeader, 'cwd'> = {}): ReactLoopAgent {
    const loopCtx = this.runtime.ctx
    const transaction = new AgentCreationTransaction(loopCtx, this.ctx, this.ownership, id)
    try {
      const sessionId = SessionId(`${id}-session-${randomUUID()}`)
      const session = loopCtx.sessions.prepare(sessionId, { meta })
      const agent = transaction.prepare(options, session, this.maxParallelToolCalls)
      transaction.publish('startup')
      return agent
    } catch (error: unknown) {
      void transaction.dispose(error instanceof Error ? error : new Error(String(error)))
      throw error
    } finally {
      transaction.finishWrapper()
    }
  }

  /**
   * Create an owned agent on a caller-supplied session id.
   * @param ownerCtx - caller context that structurally owns the transaction.
   * @param options - identities, session seed/metadata, loop options, setup, and cancellation.
   * @returns the published handle.
   */
  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const agentOptions = options.agentOptions ?? {}
    const transaction = new AgentCreationTransaction(
      this.runtime.ctx,
      ownerCtx,
      this.ownership,
      options.agentId,
      options.signal,
    )
    try {
      const session = this.runtime.ctx.sessions.prepare(options.sessionId, {
        ...options.seed === undefined ? {} : { seed: options.seed },
        ...options.meta === undefined ? {} : { meta: options.meta },
      })
      const agent = transaction.prepare(agentOptions, session, this.maxParallelToolCalls)
      await transaction.waitFor(options.setup?.(agent.ctx))
      transaction.assertActive()
      return transaction.publish('startup')
    } catch (error: unknown) {
      await transaction.dispose(error instanceof Error ? error : new Error(String(error)))
      throw error
    } finally {
      transaction.finishWrapper()
    }
  }

  /**
   * Resume an owned agent from the configured persistence service.
   * @param ownerCtx - caller context that owns load, setup, and the live lifecycle.
   * @param options - persisted identity, loop options, setup, and cancellation.
   * @returns the published handle.
   */
  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const persistence = this.runtime.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error('cannot resume: session persistence is not configured (load a dsh-session-persistence backend)')
    }
    return this.resumeWith(ownerCtx, persistence, options)
  }

  /** Resume through an explicit persistence handle used by the deferred config path. */
  private async resumeWith(
    ownerCtx: Context,
    persistence: SessionPersistence,
    options: ResumeAgentOptions,
  ): Promise<AgentHandle> {
    const agentOptions = options.agentOptions ?? {}
    const transaction = new AgentCreationTransaction(
      this.runtime.ctx,
      ownerCtx,
      this.ownership,
      options.agentId,
      options.signal,
    )
    try {
      const loaded = await transaction.waitFor(persistence.load(options.resumeSessionId))
      transaction.assertActive()
      const session = this.runtime.ctx.sessions.prepare(options.resumeSessionId, {
        seed: loaded.events,
        meta: {
          createdAt: loaded.meta.createdAt,
          ...loaded.meta.cwd === undefined ? {} : { cwd: loaded.meta.cwd },
          ...loaded.meta.parentSession === undefined ? {} : { parentSession: loaded.meta.parentSession },
          ...loaded.meta.seedLength === undefined ? {} : { seedLength: loaded.meta.seedLength },
        },
      })
      const agent = transaction.prepare(agentOptions, session, this.maxParallelToolCalls)
      await transaction.waitFor(options.setup?.(agent.ctx))
      transaction.assertActive()
      return transaction.publish('resume')
    } catch (error: unknown) {
      await transaction.dispose(error instanceof Error ? error : new Error(String(error)))
      throw error
    } finally {
      transaction.finishWrapper()
    }
  }
}

export default AgentLoop
