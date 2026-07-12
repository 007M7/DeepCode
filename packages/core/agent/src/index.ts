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
   * excluded — a factory caller never sets it). The factory reads this raw
   * reference once and hands it synchronously to the session boundary, which
   * rejects an exotic shell and captures each accepted field once before any
   * asynchronous setup.
   */
  meta?: { cwd?: string; parentSession?: SessionId; seedLength?: number }
  /**
   * Seed events to reconstruct the child session's log from (the fork lineage
   * primitive). When present, the factory creates the session with this event
   * prefix so `deriveMessages()`/`lastTurnNumber` continue from it — used by the
   * in-process FORK subagent backend to seed a child with a balanced
   * completed-turn prefix of the parent's log. The prefix MUST be contiguous
   * from seq 0, carry only lossless-JSON data, and be balanced (no open
   * turn/step, no dangling tool-call), or the session constructor (and the
   * dev-mode invariants replay) reject it. The factory passes the raw seed to
   * the synchronous one-pass validator/copier; it never pre-clones and thereby
   * sanitizes exotic prototypes. Absent for a fresh (spawn) child.
   */
  seed?: SessionEvent[]
  /** Per-agent options (model, …). */
  agentOptions?: AgentOptions
  /**
   * Creation-time composition of the agent's scoped world. The factory awaits
   * setup after minting `agentCtx` but BEFORE inserting or announcing either
   * the session or agent, so observers can never see a partially configured
   * world. Everything registered through `agentCtx` (scoped tools, prompt
   * sections/variables, `restrict()`, listeners, awaited child plugins) exists
   * before `session/created`, `agent/created`, `agent/session-start`, and the
   * first prompt assembly. A throw/rejection or owner disposal rolls the scope
   * back without publishing either id.
   *
   * **Setup composes, it never drives**: calling `send`/`steer`/`inject` here
   * would run an unpublished agent and violate the session-start boundary.
   * Drive the agent only after the creation promise resolves.
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
 * An owned agent plus its disposer, returned by {@link AgentRegistry.create} /
 * {@link AgentRegistry.resume}. The disposer is a CAPABILITY: among consumers,
 * only the holder can tear this agent down. The registered factory provider is
 * also a structural owner because the scoped agent depends on that provider's
 * service surface; provider unload stops and drains every live handle it made.
 * `dispose()` stops the loop, awaits its exit and every outstanding
 * idle-injection flush (quiescence — NOT just the `disposed`
 * status flip), unregisters the agent, removes its session from the store, and
 * finally unwinds its scoped world. This order captures every agent-started
 * `session/flush` before the session is detached and keeps scoped listeners
 * alive through those checkpoints.
 *
 * `ctx.agents.get(id)` still returns a bare {@link Agent} — the handle is
 * exposed only to the consumer owner that created it; the structural provider
 * reaches the same teardown internally. Config-created agents (the loop's own
 * startup) are owned by the loop fiber and never need a handle.
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
   * Create a new agent on a caller-supplied session id. Async because creation
   * awaits unpublished setup, inserts both session and agent, emits their
   * creation notifications in order, unlocks driving at
   * `agent/session-start`, and only then starts the loop. The sequence is
   * rollback-covered, but notifications delivered before a later listener
   * failure remain observable; every agent or session creation announcement
   * that began is paired by `agent/disposed` or `session/disposed` during
   * rollback. The owner disposes the resolved handle to stop/drain,
   * unregister, remove the session, and unwind the scope.
   * The registry passes a context carrying the `create()` caller's fiber and
   * scope as `ownerCtx`. The implementation attaches the unpublished
   * transaction and resulting lifecycle to that owner; it must not infer
   * ownership from the factory object's registration context.
   * @param ownerCtx - caller-bound context that owns the transaction and live handle.
   * @param options - agent/session identity, configuration, and optional setup.
   * @returns the owned handle after setup, both announcements, and loop start complete.
   */
  createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle>
  /**
   * Load a persisted session and resume an agent on it. Async because it awaits
   * both `ctx.sessionPersistence.load` and the optional unpublished setup
   * transaction; must be called after that service exists (consumers inject
   * `sessionPersistence`). Publication and drive unlocking follow the same
   * ordered boundary as {@link createAgent}.
   * @param ownerCtx - caller-bound context that owns load, setup, and the live handle.
   * @param options - persisted identity, configuration, and optional setup.
   * @returns the owned handle after setup, both announcements, and loop start complete.
   */
  resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle>
}

/** One accepted factory target plus the callback identities captured at registration. */
interface AcceptedAgentFactory {
  target: AgentFactory
  createAgent: AgentFactory['createAgent']
  resume: AgentFactory['resume']
}

/** Slot reservation while callback accessors are being captured. */
const ACCEPTING_FACTORY = Symbol('accepting agent factory')

/** Capture and validate the complete factory contract exactly once. */
function acceptAgentFactory(factory: unknown): AcceptedAgentFactory {
  if ((typeof factory !== 'object' && typeof factory !== 'function') || factory === null) {
    throw new TypeError('agent factory must be a non-null object or function')
  }
  // A service read through ctx is already a Cordis trace proxy. Retaining that
  // proxy and tracing it again for each create() caller produces two shadow
  // layers; raw-identity state (AgentLoop's private ownership controller is
  // one example) then unwraps only to the inner proxy instead of its service.
  // Canonicalize the one framework-produced layer at acceptance and capture
  // callbacks from the concrete target. Plain objects expose no original.
  const original: unknown = Reflect.get(factory, symbols.original)
  const target = ((typeof original === 'object' || typeof original === 'function') && original !== null)
    ? original
    : factory
  const createAgent: unknown = Reflect.get(target, 'createAgent')
  const resume: unknown = Reflect.get(target, 'resume')
  if (typeof createAgent !== 'function') throw new TypeError('agent factory createAgent must be a function')
  if (typeof resume !== 'function') throw new TypeError('agent factory resume must be a function')
  return Object.freeze({
    target: target as AgentFactory,
    createAgent: createAgent as AgentFactory['createAgent'],
    resume: resume as AgentFactory['resume'],
  })
}

/** Thrown when create/resume is called before an agent factory is registered. */
const NO_FACTORY_MESSAGE = 'no agent factory registered (load an agent-loop plugin)'

/** Render an arbitrary thrown value without allowing coercion to throw again. */
function renderThrown(value: unknown): string {
  try {
    return value instanceof Error ? `${value.name}: ${value.message}` : String(value)
  } catch {
    return '<unrenderable thrown value>'
  }
}

/**
 * Unforgeable ownership handle for one unpublished agent id. The factory holds
 * this object across asynchronous setup; while it is live, ordinary public
 * registration of that id fails, so setup cannot publish the factory's agent
 * (or a replacement with the same id) ahead of the transaction. Callers obtain
 * handles only from {@link AgentRegistry.reserve}.
 */
export interface AgentRegistrationReservation {
  /** The reserved registry id. */
  readonly id: AgentId
  /**
   * Release the unpublished reservation; idempotent. The registry also
   * releases it automatically when the fiber that called `reserve` disposes.
   * This function is that exact Cordis effect disposer, so an ordered
   * lifecycle may yield it by identity and place release after quiescence.
   * @returns nothing.
   */
  release(): void
}

/**
 * Agent registry (`ctx.agents`): tracks live agents so UI, hook, and
 * orchestrator plugins can find them without depending on the concrete loop
 * package. Agent *creation* is provided by whichever plugin implements the
 * {@link AgentFactory} (`@deepseek-ai/dsh-agent-loop`), registered via
 * {@link setFactory}.
 */
export class AgentRegistry extends Service {
  private store = new Map<AgentId, Agent>()
  /** Ids claimed across caller-code boundaries before their exact entry commits. */
  private enteringIds = new Set<AgentId>()
  /** The one accepted registry key for each live agent; never reread caller state. */
  private acceptedIds = new WeakMap<Agent, AgentId>()
  /** Unpublished identities held across factory setup/load transactions. */
  private reservations = new Map<AgentId, AgentRegistrationReservation>()
  /** Entries whose `agent/created` announcement phase began. */
  private announced = new WeakSet<Agent>()
  /** Entries currently dispatching `agent/created`; detach waits for that dispatch to unwind. */
  private announcing = new WeakSet<Agent>()
  /** A detach requested reentrantly from `agent/created`. */
  private pendingDetach = new WeakSet<Agent>()
  /** Stable lifecycle dispatch carrier captured before an entry commits. */
  private carriers = new WeakMap<Agent, Scoped<Agent>>()
  private factory: AcceptedAgentFactory | typeof ACCEPTING_FACTORY | undefined

  constructor(ctx: Context) {
    super(ctx, 'agents')
    // The `ctx.agent` DX accessor: default `undefined` on every context, so a
    // plain plugin context reads cleanly instead of hitting the Cordis
    // unknown-property throw. Each Agent.ctx shadows it with an own property
    // (own properties resolve before the context proxy is consulted), so the
    // accessor body never needs to resolve a scope itself. Effect-scoped:
    // unwinds with this service's fiber.
    ctx.accessor('agent', { get: () => undefined })
  }

  /**
   * Reserve an unpublished agent id. Registration through {@link register} or
   * bare {@link enter} fails until the returned capability is released; the
   * owning factory passes the exact capability back to `enter` at publication.
   * This makes “setup cannot publish” structural rather than a cooperative
   * convention, including attempts to register a different object under the
   * reserved id. The reservation belongs to the calling fiber and is released
   * automatically if that owner unloads before the transaction settles.
   * @param id - the id the factory transaction will publish.
   * @returns the opaque reservation capability.
   * @throws if the id is malformed, live, or already reserved.
   */
  reserve(id: AgentId): AgentRegistrationReservation {
    if (typeof id !== 'string') throw new TypeError('agent id must be a string')
    if (this.store.has(id) || this.reservations.has(id) || this.enteringIds.has(id)) {
      throw new Error(`agent "${id}" is already registered or reserved`)
    }
    const rawRelease = (): void => {
      this.reservations.delete(id)
    }
    // `release` is the exact effect disposer. A composite lifecycle can yield
    // it by identity, moving automatic owner cleanup from a racing sibling to
    // the transaction's final ordered position.
    const release = this.ctx.effect(() => rawRelease, `agents.reserve(${id})`)
    const reservation: AgentRegistrationReservation = Object.freeze({ id, release })
    this.reservations.set(id, reservation)
    return reservation
  }

  /**
   * Register the agent-creation factory (the loop calls this on construction,
   * effect-scoped). The registry captures both callback identities once and
   * later invokes them against the retained target receiver. Throws if a
   * factory is already registered. Returns the disposer; on dispose the
   * factory slot is cleared.
   * @param factory - the loop-owned factory {@link create}/{@link resume} delegate to.
   * @returns the disposer that clears the factory slot. The exact
   *   Cordis effect disposer (single-shot): composite (generator) effects may
   *   yield it directly — exact identity nests the teardown in order.
   */
  setFactory(factory: AgentFactory): () => Promise<void> | void {
    const dispose = this.ctx.effect(() => {
      if (this.factory !== undefined) throw new Error('an agent factory is already registered')
      // Claim the slot before reading caller-controlled method accessors. A
      // getter may synchronously re-enter setFactory(); it must observe the
      // registration in progress instead of installing a nested factory that
      // the outer call would silently overwrite.
      this.factory = ACCEPTING_FACTORY
      try {
        this.factory = acceptAgentFactory(factory)
      } catch (error: unknown) {
        this.factory = undefined
        throw error
      }
      return () => { this.factory = undefined }
    }, 'agents.setFactory()')
    // The exact cordis effect disposer (the agents.register() convention): a
    // caller's composite effect can yield it for in-order teardown; the
    // loop's constructor effect returns it directly, identity-nesting the
    // registration under that effect.
    return dispose
  }

  /** Return the accepted factory, excluding absence and reentrant acceptance. */
  private requireFactory(): AcceptedAgentFactory {
    const accepted = this.factory
    if (accepted === undefined || accepted === ACCEPTING_FACTORY) throw new Error(NO_FACTORY_MESSAGE)
    return accepted
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
    const accepted = this.requireFactory()
    const ownerCtx = this.ctx
    // Re-trace a Service-backed factory through the accessing context
    // explicitly. This preserves AgentLoop's dependency origin while binding
    // its effects to ownerCtx; plain factories receive ownerCtx as an explicit
    // capability and need no Cordis tracker magic.
    const receiver = getTraceable(ownerCtx, accepted.target)
    return Reflect.apply(accepted.createAgent, receiver, [ownerCtx, options])
  }

  /**
   * Load a persisted session and resume an agent on it through the registered
   * factory. Rejects if no factory is registered; the factory rejects if
   * session persistence is not configured or persistence/setup fails.
   * @param options - persisted identity, configuration, and optional setup.
   * @returns the handle after setup, rollback-covered publication, and loop start complete.
   */
  async resume(options: ResumeAgentOptions): Promise<AgentHandle> {
    const accepted = this.requireFactory()
    const ownerCtx = this.ctx
    const receiver = getTraceable(ownerCtx, accepted.target)
    return Reflect.apply(accepted.resume, receiver, [ownerCtx, options])
  }

  /**
   * Register a live agent. Throws if an agent with the same id is already
   * registered. Emits `agent/created` on registration and `agent/disposed`
   * when the calling fiber is disposed — both with the agent's scope carrier
   * (`scopeTarget(agent, agent)`): the subject is the agent in hand, so the
   * emits are scope-filtered regardless of which context invoked `register`
   * (calling through `agent.ctx` scopes EFFECTS; dispatch scoping always
   * requires passing the carrier). Returns the disposer.
   * @param agent - the already-constructed agent to record in the store.
   * @returns the EXACT Cordis effect disposer (single-shot; a repeat call
   *   returns undefined without awaiting an in-flight teardown). Exact
   *   identity is load-bearing: a composite (generator) effect that owns a
   *   teardown ORDER — the agent factory's lifecycle chain — must yield THIS
   *   function so Cordis nests the unregistration at that yield position;
   *   yielding a wrapper would leave it disposing as a concurrent sibling on
   *   owner unload, unregistering the agent (and emitting `agent/disposed`)
   *   while its final turn is still draining.
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
   * @param reservation - the exact unpublished-id capability, when a factory
   *   reserved this id across setup.
   * @returns an idempotent closure that removes this exact entry and emits
   *   `agent/disposed` with listener failures contained. When called from a
   *   synchronous `agent/created` listener, removal and disposal wait until
   *   that creation dispatch unwinds.
   */
  enter(agent: Agent, reservation?: AgentRegistrationReservation): () => void {
    const id = agent.id
    if (typeof id !== 'string') throw new TypeError('agent id must be a string')
    const held = this.reservations.get(id)
    if (reservation === undefined) {
      if (held !== undefined) throw new Error(`agent "${id}" is reserved for unpublished creation`)
    } else if (reservation.id !== id || held !== reservation) {
      throw new Error(`agent "${id}" registration reservation is not active for this id`)
    }
    if (this.acceptedIds.has(agent)) {
      throw new Error(`agent "${id}" is already registered`)
    }
    if (this.store.has(id) || this.enteringIds.has(id)) {
      throw new Error(`agent "${id}" is already registered`)
    }
    this.enteringIds.add(id)
    let carrier: Scoped<Agent>
    try {
      // Registration accepts ownership of the public identity contract. Pin an
      // own data slot from the one captured value so a custom JavaScript Agent
      // with a getter or writable field cannot later present a different id to
      // event listeners while the registry still owns the accepted key.
      try {
        Object.defineProperty(agent, 'id', {
          value: id,
          enumerable: true,
          writable: false,
          configurable: false,
        })
      } catch {
        // Only the engine's property-definition failure is normalized; filter
        // construction below retains its own precise failure.
        throw new TypeError('agent id must be installable as a stable own property')
      }
      // Capture one carrier for the paired lifecycle edges. Constructing it
      // reads a custom Agent's Context.filter and is therefore caller code;
      // the id claim above makes a same-id reentrant enter lose deterministically.
      carrier = scopeTarget(agent, agent)
    } finally {
      // Kept through the entire caller-code window; the final commit below is
      // synchronous and callback-free.
      this.enteringIds.delete(id)
    }
    const currentReservation = this.reservations.get(id)
    if (reservation === undefined) {
      /* v8 ignore next 2 -- reserve() rejects enteringIds, so no callback in
       * carrier construction can install a new same-id reservation */
      if (currentReservation !== undefined) {
        throw new Error(`agent "${id}" is reserved for unpublished creation`)
      }
    } else if (currentReservation !== reservation) {
      throw new Error(`agent "${id}" registration reservation is not active for this id`)
    }
    /* v8 ignore next 2 -- the enteringIds claim blocks every public same-id
     * commit until this callback-free final check has completed */
    if (this.acceptedIds.has(agent) || this.store.has(id)) {
      throw new Error(`agent "${id}" is already registered`)
    }
    this.store.set(id, agent)
    this.acceptedIds.set(agent, id)
    this.carriers.set(agent, carrier)
    let entered = true
    const detach = (): void => {
      if (!entered) return
      entered = false
      // Every callback reached by this creation dispatch must observe the same
      // live entry, and disposal must follow creation. A listener may own
      // the advanced detach capability, so make that ordering structural:
      // visibility and the paired disposal are deferred until announce()'s
      // synchronous dispatch has unwound.
      if (this.announcing.has(agent)) {
        this.pendingDetach.add(agent)
        return
      }
      this.detachEntered(agent, id)
    }
    return detach
  }

  /** Remove one exact entered agent and emit its paired disposal when announced. */
  private detachEntered(agent: Agent, id: AgentId): void {
    this.pendingDetach.delete(agent)
    // A stale capability can never delete a later same-id lifecycle. The
    // commit claim prevents this mismatch in normal operation; retain the
    // exact-object guard as the final identity boundary.
    /* v8 ignore next 1 -- the commit claim makes replacement impossible; this
     * remains the exact-identity backstop against future mutation paths */
    if (this.store.get(id) !== agent || this.acceptedIds.get(agent) !== id) return
    this.store.delete(id)
    this.acceptedIds.delete(agent)
    const carrier = this.carriers.get(agent)
    this.carriers.delete(agent)
    // An insertion rolled back before announce was never externally created,
    // so emitting disposed would invent an impossible lifecycle edge. Marking
    // happens before the created emit: if a later created listener throws,
    // earlier listeners may already have observed it and must see disposal.
    if (!this.announced.delete(agent)) return
    /* v8 ignore next -- enter commits the carrier with the exact store entry */
    if (carrier === undefined) throw new Error(`agent "${id}" has no dispatch carrier`)
    this.emitDisposed(agent, carrier, id)
  }

  /** Emit the paired disposal edge through the entry's stable carrier. */
  private emitDisposed(agent: Agent, carrier: Scoped<Agent>, id: AgentId): void {
    const args: unknown[] = [carrier, 'agent/disposed', agent]
    for (const callback of this.ctx.events.dispatch('emit', args)) {
      try {
        const returned: unknown = callback(...args)
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`agent "${id}": agent/disposed listener rejected: ${renderThrown(error)}`)
        })
      } catch (error: unknown) {
        this.ctx.logger.warn(`agent "${id}": agent/disposed listener threw: ${renderThrown(error)}`)
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
    const id = this.acceptedIds.get(agent)
    if (id === undefined || this.store.get(id) !== agent) {
      throw new Error(`agent "${id ?? '<unknown>'}" is not live in this registry`)
    }
    if (this.announced.has(agent) || this.announcing.has(agent)) {
      throw new Error(`agent "${id}" was already announced`)
    }
    const carrier = this.carriers.get(agent)
    /* v8 ignore next -- enter commits the carrier with the exact store entry */
    if (carrier === undefined) throw new Error(`agent "${id}" has no dispatch carrier`)
    // Mark before dispatch so a listener cannot recursively create a second
    // lifecycle edge; detach still pairs a partially delivered first edge.
    this.announcing.add(agent)
    this.announced.add(agent)
    const args: unknown[] = [carrier, 'agent/created', agent]
    try {
      for (const callback of this.ctx.events.dispatch('emit', args)) {
        // A synchronous creation failure vetoes publication and rolls back.
        // Returned-promise rejection happens after this synchronous boundary, so
        // observe and report it instead of leaking an unhandled rejection.
        const returned: unknown = callback(...args)
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`agent "${id}": agent/created listener rejected: ${renderThrown(error)}`)
        })
      }
    } finally {
      this.announcing.delete(agent)
      if (this.pendingDetach.has(agent)) this.detachEntered(agent, id)
    }
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
