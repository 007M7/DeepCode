/**
 * THE concrete agent plugin: creates ReactLoopAgents, runs their loops, and
 * registers them in ctx.agents. Deliberately thin — every behavior beyond
 * "call the model, run the tools, repeat" belongs to plugins on the event
 * taxonomy.
 *
 * @module @deepseek-ai/dsh-agent-loop
 */

import { Context, FiberState, Service } from 'cordis'
import { randomUUID } from 'node:crypto'
import z from 'schemastery'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { AgentFactory, AgentHandle, AgentId, AgentOptions, CreateAgentOptions, ResumeAgentOptions, SessionStartSource } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { prepareReactLoopAgent, ReactLoopAgent } from './agent.ts'

export { ReactLoopAgent } from './agent.ts'

declare module 'cordis' {
  interface Context {
    agentLoop: AgentLoop
  }
}

/**
 * Plugin config: the agents to create — or resume, via `resumeSessionId` —
 * declaratively at startup, so a cordis.yml deployment needs no code.
 */
export interface Config {
  /** Agents created from configuration at startup. */
  agents: (AgentOptions & {
    /** Agent id to register under; also seeds the fresh per-run session id (`${id}-session-<uuid>`). */
    id: AgentId
    /** Optional workspace cwd for the config-created fresh session. */
    cwd?: string
    /**
     * If set, the config agent RESUMES this persisted session id instead of
     * starting a fresh `${id}-session-<uuid>`. Sourced from an env var in
     * cordis.yml (`resumeSessionId: !!js process.env.RESUME_SESSION_ID`), so a
     * demo can continue a prior conversation without code changes. Requires a
     * `dsh-session-persistence` backend; the resume is deferred until that
     * service is available (via `ctx.inject`) and the loaded session's events
     * seed the live session so history continues.
     *
     * The schema accepts a plain string at runtime (cordis.yml values are
     * untyped); the brand is compile-time only — the config format is the
     * boundary where an id enters, so the TYPE declares the brand here.
     */
    resumeSessionId?: SessionId
  })[]
}

/**
 * The agent-loop plugin (`ctx.agentLoop`): creates {@link ReactLoopAgent}s, runs
 * their loops, and registers them in `ctx.agents`. Also implements the
 * {@link AgentFactory} seam, so plugins create/resume agents through
 * `ctx.agents` (the interface) without depending on this concrete package.
 *
 * The loop itself is deliberately thin — every behavior beyond "call the
 * model, run the tools, repeat" belongs to plugins listening on the event
 * taxonomy declared in @deepseek-ai/dsh-agent.
 */
export class AgentLoop extends Service implements AgentFactory {
  static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt']

  /** IDs held by unpublished async creation transactions. */
  private pendingAgentIds = new Set<AgentId>()
  private pendingSessionIds = new Set<SessionId>()

  // The schema validates plain strings (cordis.yml config values are untyped at
  // runtime); the {@link Config} TYPE declares the branded `id`/`resumeSessionId`
  // because the config format is the boundary where an id enters. The brand is a
  // zero-cost compile-time cast, so the runtime schema stays string-based and we
  // assert the branded view once here — the single schema boundary.
  static Config = z.object({
    agents: z.array(z.object({
      id: z.string().required(),
      model: z.string(),
      cwd: z.string(),
      resumeSessionId: z.string(),
    })).default([]),
  }) as unknown as z<Config>

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'agentLoop')
    // Provide the agent-creation factory to the registry (effect-scoped: the
    // slot is cleared on dispose).
    ctx.effect(() => this.ctx.agents.setFactory(this), 'agentLoop.setFactory()')
    // The prompt variables the shipped loop provides, registered once. The
    // sections themselves (`harness:identity`, `deployment:persona`) belong to
    // dsh-system-prompt — they must survive a swapped loop plugin — but
    // `{{model}}`/`{{cwd}}` are runtime facts of the agents THIS loop drives:
    // it assembles with `{ agent }` each step (loop.ts), and the variables
    // project the agent's configured model and its session workspace from that
    // context. A provider returns undefined when the fact is absent
    // (renderPrompt then rejects a persona that claims it — fail loud).
    ctx.systemPrompt.variable('model', context => context.agent?.options.model)
    ctx.systemPrompt.variable('cwd', context => context.agent?.session.header.cwd)
    for (const { id, cwd, resumeSessionId, ...options } of config.agents) {
      if (resumeSessionId !== undefined && resumeSessionId !== '') {
        // Resume a prior session instead of starting fresh. resume() needs
        // `ctx.sessionPersistence`, which may load AFTER this plugin (cordis.yml
        // lists the backend later). `ctx.inject(['sessionPersistence'], cb)`
        // runs `cb` with a child ctx once the service exists; the child reads
        // the persistence and hands it to resumeWith (which uses this.ctx — the
        // parent — for sessions/registry, all in AgentLoop's static inject). A
        // failed resume is contained + logged: startup must not crash.
        ctx.effect(() => {
          const fiber = this.ctx.inject(['sessionPersistence'], (childCtx: Context) => {
            void this.resumeWith(childCtx.sessionPersistence, { agentId: id, resumeSessionId, agentOptions: options })
              .catch((error: unknown) => {
                this.ctx.logger.warn(`agent "${id}": config-driven resume of "${resumeSessionId}" failed: ${String(error)}`)
              })
          })
          return () => void fiber.dispose()
        }, `agentLoop.resume(${id})`)
      } else {
        this.create(id, options, cwd === undefined ? {} : { cwd })
      }
    }
  }

  /**
   * Config-driven create: an agent on a FRESH, non-colliding session id per run
   * (`${id}-session-<uuid>`). Used for `cordis.yml`-configured agents and as
   * the shared core for the programmatic factory {@link createAgent}.
   *
   * Why a per-run id, not a fixed `${id}-session`: once a durable persistence
   * backend is loaded, a fixed id collides on the second run — the backend
   * refuses to re-create an id whose log already exists on disk (the SessionId
   * is the identity). A fresh id means each run is a new session.
   *
   * TODO(demo): each run starting a brand-new session is fine for demos but is
   * NOT real conversation continuity. A production config-driven agent needs a
   * deliberate resume-or-create policy (resume the prior session if one exists,
   * else start fresh) or an explicit caller-chosen session id — revisit when the
   * UI/ACP path owns session selection.
   * @param id - the agent id; also seeds the generated session id.
   * @param options - loop options (model, limits, …); defaults applied per option.
   * @param meta - optional session metadata for the fresh session.
   * @returns the running agent, owned by the calling fiber (no handle).
   */
  create(id: AgentId, options: AgentOptions = {}, meta: Pick<SessionHeader, 'cwd'> = {}): ReactLoopAgent {
    this.assertAgentIdFree(id)
    // Config/programmatic path: prepare the session and let start() fold its
    // lifecycle into the agent's composite effect (so a fiber unload tears the
    // session + agent down as one ordered chain, capturing the loop's closing
    // flush). The whole effect is owned by THIS fiber; no AgentHandle is needed.
    const session = this.ctx.sessions.prepare(SessionId(`${id}-session-${randomUUID()}`), { meta })
    const { agent } = this.start(id, options, session, 'startup')
    return agent
  }

  /**
   * Programmatic factory create ({@link AgentFactory}): an agent on a
   * caller-supplied `sessionId` (NOT `${id}-session`), with optional session
   * metadata (validated `cwd`, lineage) and an optional `seed` event prefix. The
   * ACP bridge uses this so the client-generated session id becomes the
   * live/persisted session id; the in-process FORK subagent backend passes a
   * `seed` (a balanced completed-turn prefix of the parent's log) so the child
   * starts with the parent's context. Returns an {@link AgentHandle} the owner
   * disposes to tear down exactly this agent.
   * @param options - agent id, caller-supplied session id, optional seed/meta,
   *   and agent options.
   * @returns the handle whose dispose tears down exactly this agent.
   */
  async createAgent(options: CreateAgentOptions): Promise<AgentHandle> {
    // Snapshot every caller-owned field before the first async setup boundary.
    // The callback itself is an identity capability; all data fields are
    // detached so caller mutation cannot drift a reserved/published identity or
    // the options the accepted agent observes.
    const agentId = options.agentId
    const sessionId = options.sessionId
    const setup = options.setup
    const agentOptions = structuredClone(options.agentOptions ?? {})
    const seed = options.seed === undefined ? undefined : structuredClone(options.seed)
    const meta = structuredClone(options.meta ?? {})
    const release = this.reserve(agentId, sessionId)
    try {
      const session = this.ctx.sessions.prepare(sessionId, {
        ...seed !== undefined ? { seed } : {},
        meta,
      })
      // A seeded (forked) create is still a fresh start, NOT a resume.
      return await this.startOwned(agentId, agentOptions, session, 'startup', setup)
    } finally {
      release()
    }
  }

  /**
   * Resume an agent on a persisted session ({@link AgentFactory}). Loads the
   * session log + metadata via `ctx.sessionPersistence`, reconstructs the live
   * session with the loaded events (so `lastTurnNumber`/`deriveMessages`
   * continue), and starts a fresh agent on it. The live session id is the
   * resumed id, NOT `${agentId}-session`.
   *
   * Requires `ctx.sessionPersistence`; rejects with a clear error if it is not
   * configured. NOT hard-injected (that would make non-persistent demos pend
   * forever) — callers that need resume (ACP) inject `sessionPersistence`, so
   * by the time this runs the service exists.
   * @param options - the persisted session id to reload, plus agent id/options.
   * @returns the handle for the agent resumed on the reconstructed session.
   */
  async resume(options: ResumeAgentOptions): Promise<AgentHandle> {
    // Read the service through `ctx.get('sessionPersistence')` — a direct
    // global-store lookup keyed by the isolate symbol — NOT
    // `this.ctx.sessionPersistence`. AgentLoop deliberately does NOT inject
    // `sessionPersistence` (injecting it would pend non-persistent demos
    // forever). The `ctx.<name>` property proxy resolves a service by an
    // ancestor-only walk of the current fiber's parent chain; from AgentLoop's
    // own fiber (which lacks the inject) that walk never reaches the sibling
    // backend fiber and throws "cannot get property … without inject". Worse,
    // when the call arrives via a traceable shadow (e.g. the ACP bridge child
    // fiber → `ctx.agents.resume()` → `this.factory.resume()`), the walk starts
    // at the shadow's origin fiber and fails the same way. `ctx.get(name)`
    // sidesteps the fiber walk entirely (a store lookup by the global isolate
    // key), so resume works from any caller fiber. It is strict by default: a
    // backend that is not ACTIVE (absent, or mid-teardown) reads as undefined
    // and we reject below, rather than handing back an unusable handle.
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error('cannot resume: session persistence is not configured (load a dsh-session-persistence backend)')
    }
    return this.resumeWith(persistence, options)
  }

  /**
   * Resume against an EXPLICIT persistence handle. Factored out of {@link resume}
   * so the config-driven path can pass the handle it obtained from a
   * `ctx.inject(['sessionPersistence'], …)` child context: `this.ctx` (the
   * service's own fiber) did not inject `sessionPersistence`, so reading it
   * there from inside the inject child trips the cordis inject guard. The
   * sessions store + registry are still read through `this.ctx` (both are in
   * AgentLoop's static inject, so they resolve fine).
   */
  private async resumeWith(persistence: SessionPersistence, options: ResumeAgentOptions): Promise<AgentHandle> {
    // Persistence is an async trust boundary. Reserve, load, reconstruct, and
    // publish only the identities/options accepted at entry—never fields
    // reread from a caller-owned object after the await.
    const agentId = options.agentId
    const sessionId = options.resumeSessionId
    const agentOptions = structuredClone(options.agentOptions ?? {})
    const setup = options.setup
    const { promise: ownerDisposed, resolve: markOwnerDisposed } = Promise.withResolvers<void>()
    const { promise: transactionSettled, resolve: markTransactionSettled } = Promise.withResolvers<void>()
    let observingOwner = true
    // Resume must observe its caller from BEFORE persistence I/O begins. The
    // full agent lifecycle does not exist until load returns, so without this
    // sentinel a never-settling backend outlives owner disposal and holds both
    // public identities forever. `this.ctx.effect` retains the traceable caller
    // ownership used by startOwned's lifecycle effect. Install it before even
    // reserving the ids: an inactive owner cannot leak a reservation if effect
    // registration fails.
    const disposeLoadSentinel = this.ctx.effect(() => () => {
      if (!observingOwner) return
      markOwnerDisposed()
      // Owner-triggered teardown does not reach quiescence until the resume
      // transaction has observed disposal and released both reservations.
      return transactionSettled
    }, `agentLoop.resumeLoad(${agentId})`)
    try {
      const release = this.reserve(agentId, sessionId)
      try {
        const loadTask = persistence.load(sessionId)
        const { meta, events } = await Promise.race([
          loadTask,
          ownerDisposed.then(() => {
            throw new Error(`agent "${agentId}" resume aborted: owner disposed during persistence load`)
          }),
        ])
        // An out-of-band direct registry/session insertion can still race this
        // service's reservation, so the public enter primitives re-check exact
        // liveness at publication.
        const session = this.ctx.sessions.prepare(sessionId, {
          seed: events,
          meta: {
            createdAt: meta.createdAt,
            ...meta.cwd !== undefined ? { cwd: meta.cwd } : {},
            ...meta.parentSession !== undefined ? { parentSession: meta.parentSession } : {},
            ...meta.seedLength !== undefined ? { seedLength: meta.seedLength } : {},
          },
        })
        // Calling startOwned synchronously installs the complete lifecycle
        // effect before it reaches its first setup await. Only then disarm the
        // load sentinel: ownership passes directly from one effect to the other
        // with no disposal gap.
        const starting = this.startOwned(agentId, agentOptions, session, 'resume', setup)
        observingOwner = false
        await disposeLoadSentinel()
        return await starting
      } finally {
        release()
      }
    } finally {
      try {
        // Manual handoff/removal must not return transactionSettled: awaiting
        // that promise from inside this transaction would deadlock it. If the
        // owner already triggered cleanup, this idempotent second disposal is a
        // no-op and the owner's first cleanup remains parked on the shared
        // settlement promise.
        observingOwner = false
        await disposeLoadSentinel()
      } finally {
        markTransactionSettled()
      }
    }
  }

  /**
   * Reject a duplicate agent id BEFORE the session is entered into the store, so
   * a failed factory call never leaves an orphaned live session (and lazy
   * persistence state) behind. `register()` enforces the same uniqueness, but
   * only after the session has already entered the store.
   */
  private assertAgentIdFree(id: AgentId): void {
    if (this.ctx.agents.get(id) !== undefined || this.pendingAgentIds.has(id)) {
      throw new Error(`agent "${id}" is already registered`)
    }
  }

  /** Reserve both public identities for one unpublished async transaction. */
  private reserve(agentId: AgentId, sessionId: SessionId): () => void {
    this.assertAgentIdFree(agentId)
    if (this.ctx.sessions.get(sessionId) !== undefined || this.pendingSessionIds.has(sessionId)) {
      throw new Error(`session "${sessionId}" already exists`)
    }
    this.pendingAgentIds.add(agentId)
    this.pendingSessionIds.add(sessionId)
    return () => {
      this.pendingAgentIds.delete(agentId)
      this.pendingSessionIds.delete(sessionId)
    }
  }

  /**
   * Construct an unpublished agent and synchronously install its complete
   * teardown skeleton before any setup await. The closures are assigned their
   * session/registry/loop disposers only at publication, while the exact scope
   * disposer is nested immediately. Therefore owner unload during setup flips
   * `active`, unwinds the scope, and wins the race without any late Cordis
   * effect collection.
   */
  private prepareLifecycle(id: AgentId, options: AgentOptions, session: Session): {
    agent: ReactLoopAgent
    active: () => boolean
    deactivated: Promise<void>
    publish: (source: SessionStartSource) => void
    disposeAgent: () => Promise<void>
  } {
    // When creation is invoked through an agent scope (subagents), the owner
    // agent's disposed status flips synchronously at handle teardown—earlier
    // than Cordis reaches nested scope effects. Include that signal in the
    // pre-publication liveness check so a same-turn parent dispose cannot race
    // an already-fulfilled setup promise into briefly publishing a child.
    const ownerAgent = this.ctx.agent
    const ownerFiber = this.ctx.fiber
    const driver = prepareReactLoopAgent(this.ctx, id, options, session)
    const { agent } = driver
    const scope: Scope = createScope(this.ctx, agent)
    agent.ctx = scope.ctx.extend({ agent })

    let active = true
    let detachSession: (() => void) | undefined
    let detachAgent: (() => void) | undefined
    let stop: (() => void) | undefined
    const { promise: deactivated, resolve: markDeactivated } = Promise.withResolvers<void>()
    const { promise: torndown, resolve: markTorndown } = Promise.withResolvers<void>()

    const dispose = this.ctx.effect(function* () {
      // First yielded, disposed last: every preceding teardown stage settled.
      yield () => { markTorndown() }
      // Exact identity moves the scope fiber out of the owner's concurrent
      // sibling list and into this ordered transaction.
      yield scope.rawDispose
      yield () => {
        detachSession?.()
        detachSession = undefined
      }
      yield () => {
        detachAgent?.()
        detachAgent = undefined
      }
      // Last yielded, disposed first. Keep the pre-publication path
      // synchronous: returning a Promise only after the loop actually began
      // lets a failed announcement roll back registry/store before create's
      // rejection is observed.
      yield () => {
        active = false
        markDeactivated()
        if (stop === undefined) return
        stop()
        return agent.done
      }
    }, 'agentLoop.lifecycle()')

    let disposing: Promise<void> | undefined
    const disposeAgent = (): Promise<void> => (disposing ??= (async () => {
      await dispose()
      await torndown
    })())

    const publish = (source: SessionStartSource): void => {
      // Publication is one synchronous, rollback-covered sequence. Setup has
      // already completed, so its scoped listeners observe both announcements.
      detachSession = agent.ctx.sessions.enter(session)
      detachAgent = this.ctx.agents.enter(agent)
      this.ctx.sessions.announce(session)
      this.ctx.agents.announce(agent)
      // Setup is over and both entries are live. Open the driving surface just
      // before session-start so its listeners retain their supported ability to
      // inject/queue, while setup itself can never drive an unpublished agent.
      driver.enableDrive()
      try {
        agentEvents(this.ctx, agent).emit('agent/session-start', source)
      } catch (error: unknown) {
        this.ctx.logger.warn(`agent "${id}": agent/session-start listener threw: ${String(error)}`)
      }
      stop = driver.startDriver()
    }

    return {
      agent,
      active: () => active
        && ownerFiber.state !== FiberState.UNLOADING
        && ownerFiber.state !== FiberState.DISPOSED
        && ownerFiber.state !== FiberState.FAILED
        && ownerAgent?.status !== 'disposed',
      deactivated,
      publish,
      disposeAgent,
    }
  }

  /** Publish a no-setup config agent synchronously. */
  private start(
    id: AgentId, options: AgentOptions, session: Session, source: SessionStartSource,
  ): { agent: ReactLoopAgent; disposeAgent: () => Promise<void> } {
    const lifecycle = this.prepareLifecycle(id, options, session)
    try {
      lifecycle.publish(source)
      return { agent: lifecycle.agent, disposeAgent: lifecycle.disposeAgent }
    } catch (error: unknown) {
      void lifecycle.disposeAgent()
      throw error
    }
  }

  /**
   * Build an {@link AgentHandle} for a PREPARED session + a fresh agent. The
   * handle's `dispose()` runs the composite effect's disposer (see
   * {@link start}) — which stops the loop, awaits its exit (final flush
   * captured), unregisters the agent, and detaches the session, in that order.
   * The same composite effect is what a fiber unload disposes, so both teardown
   * triggers honor the ordering identically.
   *
   * `dispose()` is MEMOIZED: the underlying cordis effect disposer is
   * single-shot (a second call returns immediately because the effect's epoch is
   * already cleared, NOT awaiting the in-flight teardown), so concurrent/repeated
   * `dispose()` calls would otherwise resolve before the first call's
   * `await agent.done` + final flush completed. Memoizing the promise makes every
   * caller observe the SAME quiescence boundary, honoring the
   * `AgentHandle.dispose(): Promise<void>` contract (mirrors the ACP `quiesce()`
   * helper).
   */
  private async startOwned(
    id: AgentId, options: AgentOptions, session: Session, source: SessionStartSource,
    setup?: (agentCtx: Context) => Promise<void> | void,
  ): Promise<AgentHandle> {
    const lifecycle = this.prepareLifecycle(id, options, session)
    try {
      // The owner-disposal branch makes a never-settling setup unable to hold
      // the transaction or its ID reservations forever. Promise.race installs
      // rejection observation on setup even if owner disposal wins first.
      const setupTask = Promise.resolve(setup?.(lifecycle.agent.ctx))
      await Promise.race([
        setupTask,
        lifecycle.deactivated.then(() => {
          throw new Error(`agent "${id}" setup aborted: owner disposed during setup`)
        }),
      ])
      // Cordis begins a fiber unload synchronously but invokes nested effect
      // disposers from its next microtask. Give that already-started unload one
      // checkpoint to deactivate this lifecycle before publication; otherwise
      // an immediately fulfilled setup continuation can outrun its owner's
      // same-turn dispose and briefly publish an already-doomed child.
      await Promise.resolve()
      if (!lifecycle.active()) {
        throw new Error(`agent "${id}" setup aborted: owner disposed during setup`)
      }
      lifecycle.publish(source)
      return { agent: lifecycle.agent, dispose: lifecycle.disposeAgent }
    } catch (error: unknown) {
      await lifecycle.disposeAgent()
      throw error
    }
  }
}

export default AgentLoop
