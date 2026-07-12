/**
 * THE concrete agent plugin: creates ReactLoopAgents, runs their loops, and
 * registers them in ctx.agents. Deliberately thin — every behavior beyond
 * "call the model, run the tools, repeat" belongs to plugins on the event
 * taxonomy.
 *
 * @module @deepseek-ai/dsh-agent-loop
 */

import { Context, CordisError, FiberState, Service, symbols } from 'cordis'
import { randomUUID } from 'node:crypto'
import z from 'schemastery'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { AgentFactory, AgentHandle, AgentId, AgentOptions, AgentRegistrationReservation, CreateAgentOptions, ResumeAgentOptions, SessionStartSource } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { Session, SessionRegistrationReservation } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { bindReactLoopAgentContext, prepareReactLoopAgent, ReactLoopAgent } from './agent.ts'

export { ReactLoopAgent } from './agent.ts'

/** Both unpublished identity capabilities held by one factory transaction. */
interface RegistrationReservations {
  agent: AgentRegistrationReservation
  session: SessionRegistrationReservation
  release(): void
}

/** A synchronously established ownership handoff plus its async publication result. */
interface OwnedAgentStart {
  result: Promise<AgentHandle>
  dispose: () => Promise<void>
}

/** Internal carrier for a preparation error whose rollback still has to quiesce. */
class LifecyclePreparationFailure extends Error {
  constructor(
    readonly reason: unknown,
    readonly dispose: () => Promise<void>,
  ) {
    super('agent lifecycle preparation failed', { cause: reason })
    this.name = 'LifecyclePreparationFailure'
  }
}

/** Stable construction-time state shared by every traceable AgentLoop receiver. */
interface FactoryOwnership {
  isActive(): boolean
  track(dispose: () => Promise<void>): () => void
  dispose(): Promise<void>
}

/** Fiber states in which a concrete factory cannot safely serve dependencies. */
const INACTIVE_FACTORY_STATES: ReadonlySet<FiberState> = new Set([
  FiberState.UNLOADING,
  FiberState.DISPOSED,
  FiberState.FAILED,
])

/** Build a tamper-resistant controller around one factory's private ledger. */
function createFactoryOwnership(fiber: Context['fiber']): FactoryOwnership {
  let accepting = true
  const transactions = new Set<() => Promise<void>>()
  const isActive = (): boolean => accepting && !INACTIVE_FACTORY_STATES.has(fiber.state)
  return Object.freeze({
    isActive,
    track(dispose: () => Promise<void>): () => void {
      /* v8 ignore next -- every call site checks the same controller immediately
       * before this synchronous, non-reentrant insertion; retain the guard as an invariant */
      if (!isActive()) throw new Error('agent loop is not active')
      transactions.add(dispose)
      return () => { transactions.delete(dispose) }
    },
    async dispose(): Promise<void> {
      accepting = false
      const disposers = [...transactions]
      transactions.clear()
      const results = await Promise.allSettled(disposers.map(dispose => Promise.resolve().then(dispose)))
      /* v8 ignore next -- tracked lifecycle/load boundaries are deliberately
       * infallible; keep reasons if that lower-level contract ever breaks */
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
      /* v8 ignore next -- every tracked boundary is deliberately infallible;
       * preserve an exact unexpected single failure as a defensive backstop */
      if (errors.length === 1) throw errors[0]
      /* v8 ignore next -- multiple failures require multiple contract-breaking
       * lifecycle disposers, but teardown must still retain every cause */
      if (errors.length > 1) throw new AggregateError(errors, 'agent loop transaction disposal failed')
    },
  })
}

/** Private ownership controllers keyed by the concrete, unproxied service. */
const factoryOwnerships = new WeakMap<AgentLoop, FactoryOwnership>()

/** Recover the stable controller when a Cordis trace proxy is the receiver. */
function factoryOwnershipFor(loop: AgentLoop): FactoryOwnership {
  const original = (loop as AgentLoop & { [symbols.original]?: AgentLoop })[symbols.original] ?? loop
  // Installed immediately after Service construction, before AgentLoop starts
  // any effect or config-driven transaction.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return factoryOwnerships.get(original)!
}

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
    const factoryOwnership = createFactoryOwnership(ctx.fiber)
    factoryOwnerships.set(this, factoryOwnership)
    // Programmatic agents are caller-owned, but this implementation is their
    // dependency provider too. Retain a second ownership edge so unloading the
    // loop aborts unpublished work and drains every live lifecycle before its
    // service surface disappears.
    ctx.effect(() => () => factoryOwnership.dispose(), 'agentLoop.factoryTransactions()')
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
            void this.resumeWith(ctx, childCtx.sessionPersistence, {
              agentId: id,
              resumeSessionId,
              agentOptions: options,
            })
              .catch((error: unknown) => {
                this.ctx.logger.warn(`agent "${id}": config-driven resume of "${resumeSessionId}" failed: ${String(error)}`)
              })
          })
          // Return the EXACT child-fiber disposer. Cordis moves a returned
          // effect into this labeled owner's teardown tree by function
          // identity; a wrapper would leave the child as a concurrent sibling
          // and could discard its async quiescence promise.
          return fiber.dispose
        }, `agentLoop.resume(${id})`)
      } else {
        this.create(id, options, cwd === undefined ? {} : { cwd })
      }
    }
  }

  /** Whether this concrete factory may begin or publish more work. */
  private factoryIsActive(): boolean {
    return factoryOwnershipFor(this).isActive()
  }

  /** Reject a call that raced the concrete loop's unload boundary. */
  private assertFactoryActive(): void {
    if (this.factoryIsActive()) return
    throw new Error('agent loop is not active')
  }

  /** Add one memoized quiescence boundary to the factory's ownership set. */
  private trackFactoryTransaction(dispose: () => Promise<void>): () => void {
    return factoryOwnershipFor(this).track(dispose)
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
    const sessionId = SessionId(`${id}-session-${randomUUID()}`)
    const reservations = this.reserve(id, sessionId)
    // Config/programmatic path: prepare the session and let start() fold its
    // lifecycle into the agent's composite effect (so a fiber unload tears the
    // session + agent down as one ordered chain, capturing the loop's closing
    // flush). The whole effect is owned by THIS fiber; no AgentHandle is needed.
    let session: Session
    try {
      session = reservations.session.prepare({ meta })
    } catch (error: unknown) {
      reservations.release()
      throw error
    }
    // start() accepts ownership of both reservation capabilities even when
    // synchronous preparation fails; its rollback releases them at quiescence.
    const { agent } = this.start(id, options, session, 'startup', reservations)
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
   * @param ownerCtx - the caller context that owns setup and the live lifecycle.
   * @param options - agent id, caller-supplied session id, optional seed/meta,
   *   and agent options.
   * @returns the handle whose dispose tears down exactly this agent.
   */
  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    this.assertFactoryActive()
    // Snapshot every caller-owned field before the first async setup boundary.
    // The callback itself is an identity capability. Agent options detach here;
    // seed and metadata stay raw only until sessions.prepare() synchronously
    // reads, validates, and detaches them, so structuredClone cannot erase an
    // exotic prototype before the session boundary sees it.
    const agentId = options.agentId
    const sessionId = options.sessionId
    const setup = options.setup
    const agentOptions = structuredClone(options.agentOptions ?? {})
    const seed = options.seed
    const meta = options.meta
    // Snapshot accessors can reenter plugin teardown; do not reserve identities
    // after the dependency provider has begun unloading.
    this.assertFactoryActive()
    const { promise: transactionSettled, resolve: markTransactionSettled } = Promise.withResolvers<void>()
    const disposeCreateForFactory = (): Promise<void> => transactionSettled
    const untrackFactoryCreate = this.trackFactoryTransaction(disposeCreateForFactory)
    try {
      const reservations = this.reserve(agentId, sessionId)
      let lifecycleStarted = false
      try {
        const session = reservations.session.prepare({
          ...seed !== undefined ? { seed } : {},
          ...meta !== undefined ? { meta } : {},
        })
        // A seeded (forked) create is still a fresh start, NOT a resume.
        lifecycleStarted = true
        return await this.startOwned(ownerCtx, agentId, agentOptions, session, 'startup', reservations, setup).result
      } finally {
        // Once startOwned is invoked, even a preparation failure carries its
        // own quiescent rollback boundary. Only failures before that handoff
        // release directly here.
        if (!lifecycleStarted) reservations.release()
      }
    } finally {
      markTransactionSettled()
      untrackFactoryCreate()
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
   * @param ownerCtx - the caller context that owns load, setup, and the live lifecycle.
   * @param options - the persisted session id to reload, plus agent id/options.
   * @returns the handle for the agent resumed on the reconstructed session.
   */
  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    this.assertFactoryActive()
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
    return this.resumeWith(ownerCtx, persistence, options)
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
  private async resumeWith(ownerCtx: Context, persistence: SessionPersistence, options: ResumeAgentOptions): Promise<AgentHandle> {
    // Persistence is an async trust boundary. Reserve, load, reconstruct, and
    // publish only the identities/options accepted at entry—never fields
    // reread from a caller-owned object after the await.
    const agentId = options.agentId
    const sessionId = options.resumeSessionId
    const agentOptions = structuredClone(options.agentOptions ?? {})
    const setup = options.setup
    // Caller-owned accessors above are a synchronous reentrancy boundary: one
    // can begin factory unload while options are snapshotted. Re-check before
    // installing either ownership sentinel, so a rejected transaction leaves
    // no orphan effect or unresolved settlement promise.
    this.assertFactoryActive()
    const { promise: ownerDisposed, resolve: markOwnerDisposed } = Promise.withResolvers<void>()
    const { promise: transactionSettled, resolve: markTransactionSettled } = Promise.withResolvers<void>()
    let observingOwner = true
    // Resume must observe its caller from BEFORE persistence I/O begins. The
    // full agent lifecycle does not exist until load returns, so without this
    // sentinel a never-settling backend outlives owner disposal and holds both
    // public identities forever. The caller-bound effect retains the same owner
    // later used by startOwned's lifecycle effect and adopts both reservation
    // disposers before persistence I/O begins.
    let lifecycleBoundary: (() => Promise<void>) | undefined
    let disposingForFactory: Promise<void> | undefined
    const disposeLoadForFactory = (): Promise<void> => (disposingForFactory ??= (async () => {
      markOwnerDisposed()
      await transactionSettled
    })())
    let untrackFactoryLoad: (() => void) | undefined
    let disposeLoadSentinel: (() => Promise<void> | void) | undefined
    let loadSentinelRetired = false
    const retireLoadSentinel = (): void => {
      /* v8 ignore next -- every lifecycle/rollback boundary is memoized and
       * invokes its after-quiescence hook once; retain idempotence defensively */
      if (loadSentinelRetired) return
      // Disarm the follower before invoking its wrapper: retirement can happen
      // from inside the lifecycle it used to follow, so recursing into that
      // same boundary here would deadlock final teardown.
      loadSentinelRetired = true
      observingOwner = false
      void disposeLoadSentinel?.()
    }
    let reservations: RegistrationReservations | undefined
    let lifecycleStarted = false
    try {
      reservations = this.reserve(agentId, sessionId)
      const ownedReservations = reservations
      // Move both reservation effects under a sentinel BEFORE persistence I/O.
      // Its first teardown stage either aborts/waits for the load transaction
      // or follows the full lifecycle after handoff; only then do the exact
      // reservation disposers run. They therefore cannot race ahead as owner
      // siblings and reopen ids while load/setup/scope cleanup is still live.
      disposeLoadSentinel = ownerCtx.effect(function* () {
        // eslint-disable-next-line @typescript-eslint/unbound-method -- exact effect-disposer identity is the ownership contract
        yield ownedReservations.agent.release
        // eslint-disable-next-line @typescript-eslint/unbound-method -- exact effect-disposer identity is the ownership contract
        yield ownedReservations.session.release
        yield () => {
          if (loadSentinelRetired) return
          if (observingOwner) {
            markOwnerDisposed()
            return transactionSettled
          }
          return lifecycleBoundary?.()
        }
      }, `agentLoop.resumeLoad(${agentId})`)
      untrackFactoryLoad = this.trackFactoryTransaction(disposeLoadForFactory)
      try {
        const loadTask = persistence.load(sessionId)
        const { meta, events } = await Promise.race([
          loadTask,
          ownerDisposed.then(() => {
            throw new Error(`agent "${agentId}" resume aborted: owner disposed during persistence load`)
          }),
        ])
        // The backend is an async boundary too. Read each loaded header field
        // once so a stateful implementation cannot pass a valid presence check
        // and then substitute a different value during reconstruction.
        const createdAt = meta.createdAt
        const cwd = meta.cwd
        const parentSession = meta.parentSession
        const seedLength = meta.seedLength
        // An out-of-band direct registry/session insertion can still race this
        // service's reservation, so the public enter primitives re-check exact
        // liveness at publication.
        const session = reservations.session.prepare({
          seed: events,
          meta: {
            createdAt,
            ...cwd !== undefined ? { cwd } : {},
            ...parentSession !== undefined ? { parentSession } : {},
            ...seedLength !== undefined ? { seedLength } : {},
          },
        })
        // startOwned synchronously returns either the complete lifecycle or a
        // preparation-rollback boundary before its result reaches the first
        // setup await. Retarget the lifecycle-long load sentinel to that disposer;
        // ownership overlaps instead of creating a gap.
        lifecycleStarted = true
        const starting = this.startOwned(
          ownerCtx,
          agentId,
          agentOptions,
          session,
          'resume',
          reservations,
          setup,
          retireLoadSentinel,
        )
        lifecycleBoundary = starting.dispose
        observingOwner = false
        return await starting.result
      } finally {
        if (!lifecycleStarted) reservations.release()
      }
    } finally {
      try {
        // Manual handoff/removal must not return transactionSettled: awaiting
        // that promise from inside this transaction would deadlock it. If the
        // owner already triggered cleanup, this idempotent second disposal is a
        // no-op and the owner's first cleanup remains parked on the shared
        // settlement promise.
        if (!lifecycleStarted) {
          // Covers reserve succeeding but sentinel/factory tracking failing
          // before the inner load transaction begins.
          reservations?.release()
          // A failed pre-lifecycle transaction has already released directly;
          // retire the sentinel so it cannot remain as a stale owner effect.
          retireLoadSentinel()
          await disposeLoadSentinel?.()
        }
      } finally {
        markTransactionSettled()
        untrackFactoryLoad?.()
      }
    }
  }

  /** Reserve both public identities in their owning registries. */
  private reserve(agentId: AgentId, sessionId: SessionId): RegistrationReservations {
    const agent = this.ctx.agents.reserve(agentId)
    try {
      const session = this.ctx.sessions.reserve(sessionId)
      return {
        agent,
        session,
        release() {
          // Both owner capabilities are independently idempotent, so the
          // composite needs no second state machine of its own.
          session.release()
          agent.release()
        },
      }
    } catch (error: unknown) {
      agent.release()
      throw error
    }
  }

  /**
   * Construct an unpublished agent and synchronously install its complete
   * teardown skeleton before any setup await. A lifecycle-long caller sentinel and
   * factory placeholder exist before driver/scope construction; the closures
   * receive their session/registry/loop disposers only at publication, while
   * the exact scope disposer is nested as soon as construction returns. Owner
   * unload during preparation or setup therefore follows a real rollback
   * boundary, flips liveness, and wins without late Cordis effect collection.
   */
  private prepareLifecycle(
    ownerCtx: Context,
    id: AgentId,
    options: AgentOptions,
    session: Session,
    reservations: RegistrationReservations,
    afterQuiescence?: () => void,
  ): {
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
    let ownerAgent: Context['agent']
    let ownerFiber: Context['fiber']
    try {
      this.assertFactoryActive()
      ownerCtx.fiber.assertActive()
      ownerAgent = ownerCtx.agent
      ownerFiber = ownerCtx.fiber
    } catch (error: unknown) {
      reservations.release()
      afterQuiescence?.()
      const dispose = (): Promise<void> => Promise.resolve()
      throw new LifecyclePreparationFailure(error, dispose)
    }

    // Establish BOTH ownership edges before driver preparation or scope
    // minting can publish an internal lifecycle notification. The lifecycle-long
    // caller sentinel also adopts the exact reservation effects: owner unload
    // first waits for the memoized lifecycle boundary, then reaches those
    // capabilities, so IDs cannot reopen while scope cleanup is still live.
    const { promise: lifecycleReady, resolve: markLifecycleReady }
      = Promise.withResolvers<() => Promise<void>>()
    const { promise: deactivated, resolve: markDeactivated } = Promise.withResolvers<void>()
    let ownerDisposed = false
    const ownerIsDisposed = (): boolean => ownerDisposed
    let ownerSentinelRetired = false
    let disposeOwnerSentinel: () => Promise<void> | void
    try {
      disposeOwnerSentinel = ownerCtx.effect(function* () {
        // eslint-disable-next-line @typescript-eslint/unbound-method -- exact effect-disposer identity is the ownership contract
        yield reservations.agent.release
        // eslint-disable-next-line @typescript-eslint/unbound-method -- exact effect-disposer identity is the ownership contract
        yield reservations.session.release
        yield () => {
          if (ownerSentinelRetired) return
          ownerDisposed = true
          markDeactivated()
          return lifecycleReady.then(disposeLifecycle => disposeLifecycle())
        }
      }, `agentLoop.ownerLifecycle(${id})`)
    } catch (error: unknown) {
      reservations.release()
      afterQuiescence?.()
      const dispose = (): Promise<void> => Promise.resolve()
      markLifecycleReady(dispose)
      // The only callback-free effect-install failure is Cordis's inactive
      // owner boundary; preserve the original value as cause for diagnostics.
      const reportedError = new Error(`agent "${id}" setup aborted: owner disposed during setup`, { cause: error })
      throw new LifecyclePreparationFailure(reportedError, dispose)
    }
    let disposingForFactory: Promise<void> | undefined
    const disposeForFactory = (): Promise<void> => (disposingForFactory ??= (async () => {
      const disposeLifecycle = await lifecycleReady
      await disposeLifecycle()
    })())
    let untrackFactory: () => void
    try {
      untrackFactory = this.trackFactoryTransaction(disposeForFactory)
    } catch (error: unknown) {
      /* v8 ignore start -- no callback boundary exists between the active
       * factory check, sentinel installation, and this synchronous ledger insert */
      let cleanupTask: Promise<void> | undefined
      const cleanup = (): Promise<void> => (cleanupTask ??= Promise.resolve().then(() => {
        reservations.release()
        afterQuiescence?.()
      }))
      markLifecycleReady(cleanup)
      void disposeOwnerSentinel()
      throw new LifecyclePreparationFailure(error, cleanup)
      /* v8 ignore stop */
    }

    let scope: Scope | undefined
    let stopPrepared: (() => Promise<void> | void) | undefined
    let disposeAgent: (() => Promise<void>) | undefined
    try {
      const driver = prepareReactLoopAgent(this.ctx, id, options, session)
      stopPrepared = () => driver.dispose()
      const { agent } = driver
      scope = createScope(this.ctx, agent)
      const lifecycleScope = scope
      if (ownerIsDisposed() || !this.factoryIsActive()
        || ownerFiber.state === FiberState.UNLOADING
        || ownerFiber.state === FiberState.DISPOSED
        || ownerFiber.state === FiberState.FAILED
        || ownerAgent?.status === 'disposed') {
        throw new Error(`agent "${id}" setup aborted: owner disposed during setup`)
      }
      bindReactLoopAgentContext(agent, lifecycleScope.ctx.extend({ agent }))

      let active = true
      let detachSession: (() => void) | undefined
      let detachAgent: (() => void) | undefined
      const stop = stopPrepared
      const { promise: torndown, resolve: markTorndown } = Promise.withResolvers<void>()
      const { promise: publicationSettled, resolve: markPublicationSettled } = Promise.withResolvers<void>()
      let publishing = false

      const dispose = ownerCtx.effect(function* () {
        // First yielded, disposed last: every preceding teardown stage settled.
        yield () => {
          // Reservation ownership is part of lifecycle settlement: a factory
          // unload that awaited this disposer may reuse both ids immediately.
          reservations.release()
          // Retire both follower effects only after quiescence reached this final
          // stage. Their retired branches skip recursively disposing this same
          // lifecycle while their exact reservation children are already inert.
          ownerSentinelRetired = true
          void disposeOwnerSentinel()
          afterQuiescence?.()
          untrackFactory()
          markTorndown()
        }
        // Exact identity moves the scope fiber out of the owner's concurrent
        // sibling list and into this ordered transaction.
        yield lifecycleScope.rawDispose
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
          // A listener can begin owner teardown reentrantly. Flip liveness now
          // so publish's next checkpoint aborts, but keep both registry entries
          // and the scope intact until the current synchronous publication
          // phase has unwound.
          if (publishing) return publicationSettled.then(stop)
          return stop()
        }
      }, 'agentLoop.lifecycle()')

      let disposing: Promise<void> | undefined
      disposeAgent = (): Promise<void> => (disposing ??= (async () => {
        await dispose()
        await torndown
      })())
      markLifecycleReady(disposeAgent)

      const isActive = (): boolean => active
        && !ownerIsDisposed()
        && this.factoryIsActive()
        && ownerFiber.state !== FiberState.UNLOADING
        && ownerFiber.state !== FiberState.DISPOSED
        && ownerFiber.state !== FiberState.FAILED
        && ownerAgent?.status !== 'disposed'

      const publish = (source: SessionStartSource): void => {
        publishing = true
        try {
          /* v8 ignore next 3 -- both callers check active immediately before
           * this callback-free synchronous publish entry */
          if (!isActive()) {
            throw new Error(`agent "${id}" setup aborted: owner disposed during setup`)
          }
          // Publication is one synchronous, rollback-covered sequence. Setup has
          // already completed, so its scoped listeners observe both announcements.
          detachSession = agent.ctx.sessions.enter(session, reservations.session)
          detachAgent = this.ctx.agents.enter(agent, reservations.agent)
          // Both enter() calls capture stable dispatch carriers and therefore
          // evaluate a caller-owned Context.filter. A getter can begin teardown;
          // entries exist for rollback, but no creation edge may escape afterward.
          if (!isActive()) {
            throw new Error(`agent "${id}" setup aborted: owner disposed during setup`)
          }
          this.ctx.sessions.announce(session)
          // Session listeners can dispose an owner. Finish that dispatch while
          // both entries/scope remain live, then skip the agent edge entirely.
          if (!isActive()) {
            throw new Error(`agent "${id}" setup aborted: owner disposed during setup`)
          }
          this.ctx.agents.announce(agent)
          // Creation listeners may synchronously dispose either owner. Cordis
          // flips the relevant fiber state before it invokes nested effects, so
          // re-check here and never unlock a driver after teardown began.
          if (!isActive()) {
            throw new Error(`agent "${id}" setup aborted: owner disposed during setup`)
          }
          // Setup is over and both entries are live. Open the driving surface just
          // before session-start so its listeners retain their supported ability to
          // inject/queue, while setup itself can never drive an unpublished agent.
          driver.enableDrive()
          agentEvents(this.ctx, agent).emit('agent/session-start', source)
          // session-start is the final synchronous listener boundary before the
          // loop begins. Teardown there must win just like teardown from either
          // creation announcement; the prebuilt driver disposer makes rollback
          // quiescent even though the loop never started.
          if (!isActive()) {
            throw new Error(`agent "${id}" setup aborted: owner disposed during setup`)
          }
          driver.startDriver()
        } finally {
          publishing = false
          markPublicationSettled()
        }
      }

      return {
        agent,
        active: isActive,
        deactivated,
        publish,
        disposeAgent,
      }
    } catch (error: unknown) {
      // Preparation failed before startOwned received a lifecycle object. Give
      // a factory unload that already captured the placeholder a real boundary,
      // and retire the entry only after the minted scope (if any) is quiescent.
      const failedScope = scope
      const ownershipInactive = ownerIsDisposed() || ownerFiber.uid === null || !this.factoryIsActive()
        || ownerFiber.state === FiberState.UNLOADING
        || ownerFiber.state === FiberState.DISPOSED
        || ownerFiber.state === FiberState.FAILED
        || ownerAgent?.status === 'disposed'
      const reportedError = ownershipInactive && error instanceof CordisError
        ? new Error(`agent "${id}" setup aborted: owner disposed during setup`, { cause: error })
        : error
      let fallbackTask: Promise<void> | undefined
      const cleanup = disposeAgent ?? (() => (fallbackTask ??= (async () => {
        try {
          await stopPrepared?.()
        } finally {
          try {
            await failedScope?.dispose()
          } finally {
            // Factory and caller quiescence include the prepared driver,
            // minted scope, and both unpublished identities even when the
            // complete lifecycle effect could not be installed.
            reservations.release()
            afterQuiescence?.()
          }
        }
      })()))
      markLifecycleReady(cleanup)
      const cleanupTask = cleanup()
      // Retire the provisional owner edge. If owner unload already claimed it,
      // this is an inert repeat and that first caller is following cleanupTask.
      void disposeOwnerSentinel()
      void cleanupTask.then(
        untrackFactory,
        /* v8 ignore next -- Scope.dispose is specified to contain child
         * failures; preserve diagnostics if that lower-level contract breaks */
        (cleanupError: unknown) => {
          untrackFactory()
          try {
            this.ctx.logger.error(new AggregateError([reportedError, cleanupError], 'agent lifecycle preparation and rollback failed'))
          } catch {
            // Only a logger-export failure is swallowed: the original
            // preparation error is already propagating to the caller.
          }
        },
      )
      throw new LifecyclePreparationFailure(reportedError, cleanup)
    }
  }

  /** Publish a no-setup config agent synchronously. */
  private start(
    id: AgentId,
    options: AgentOptions,
    session: Session,
    source: SessionStartSource,
    reservations: RegistrationReservations,
  ): { agent: ReactLoopAgent; disposeAgent: () => Promise<void> } {
    let lifecycle: ReturnType<AgentLoop['prepareLifecycle']>
    try {
      lifecycle = this.prepareLifecycle(this.ctx, id, options, session, reservations)
    } catch (error: unknown) {
      /* v8 ignore next -- prepareLifecycle converts every failure into its
       * rollback-bearing internal error before crossing this boundary */
      if (!(error instanceof LifecyclePreparationFailure)) throw error
      void error.dispose()
      throw error.reason
    }
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
   * {@link start}) — which stops the loop, awaits its exit and outstanding
   * idle-injection flushes, unregisters the agent, detaches the session,
   * unwinds the scope, and releases both ids, in that order. Caller-fiber unload
   * also invokes an independent sentinel that follows this memoized boundary,
   * so handle-first and owner-first races honor the same ordering.
   *
   * `dispose()` is MEMOIZED: the underlying cordis effect disposer is
   * single-shot (a second call returns immediately because the effect's epoch is
   * already cleared, NOT awaiting the in-flight teardown), so concurrent/repeated
   * `dispose()` calls would otherwise resolve before the first call's
   * loop + flush quiescence boundary completed. Memoizing the promise makes
   * every caller observe that SAME boundary, honoring the
   * `AgentHandle.dispose(): Promise<void>` contract (mirrors the ACP `quiesce()`
   * helper).
   */
  private startOwned(
    ownerCtx: Context,
    id: AgentId, options: AgentOptions, session: Session, source: SessionStartSource,
    reservations: RegistrationReservations,
    setup?: (agentCtx: Context) => Promise<void> | void,
    afterQuiescence?: () => void,
  ): OwnedAgentStart {
    let lifecycle: ReturnType<AgentLoop['prepareLifecycle']>
    try {
      lifecycle = this.prepareLifecycle(ownerCtx, id, options, session, reservations, afterQuiescence)
    } catch (error: unknown) {
      /* v8 ignore next 1 -- prepareLifecycle wraps every synchronous failure */
      if (!(error instanceof LifecyclePreparationFailure)) throw error
      return {
        dispose: error.dispose,
        result: (async () => {
          await error.dispose()
          throw error.reason
        })(),
      }
    }
    return {
      dispose: lifecycle.disposeAgent,
      result: this.finishOwnedStart(lifecycle, id, source, setup),
    }
  }

  /** Await setup and publish after {@link startOwned} established ownership synchronously. */
  private async finishOwnedStart(
    lifecycle: ReturnType<AgentLoop['prepareLifecycle']>,
    id: AgentId,
    source: SessionStartSource,
    setup?: (agentCtx: Context) => Promise<void> | void,
  ): Promise<AgentHandle> {
    try {
      // Scope minting emits Cordis's synchronous internal/plugin notification.
      // A listener can unload either owner there; never run arbitrary setup in
      // the already-doomed scope while the tracked disposer is catching up.
      /* v8 ignore next 3 -- prepareLifecycle returns success only after its
       * final synchronous liveness check; no callback runs before this line */
      if (!lifecycle.active()) {
        throw new Error(`agent "${id}" setup aborted: owner disposed during setup`)
      }
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
