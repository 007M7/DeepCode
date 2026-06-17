/**
 * THE concrete agent plugin: creates LoopAgents, runs their loops, and
 * registers them in ctx.agents. Deliberately thin — every behavior beyond
 * "call the model, run the tools, repeat" belongs to plugins on the event
 * taxonomy.
 *
 * @module @deepseek-ai/dsh-agent-loop
 */

import { Context, Service } from 'cordis'
import { randomUUID } from 'node:crypto'
import z from 'schemastery'
import { AgentId } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentFactory, AgentOptions, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
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
  agents: (AgentOptions & {
    id: string
    /**
     * If set, the config agent RESUMES this persisted session id instead of
     * starting a fresh `${id}-session-<uuid>`. Sourced from an env var in
     * cordis.yml (`resumeSessionId: !!js process.env.RESUME_SESSION_ID`), so a
     * demo can continue a prior conversation without code changes. Requires a
     * `dsh-session-persistence` backend; the resume is deferred until that
     * service is available (via `ctx.inject`) and the loaded session's events
     * seed the live session so history continues.
     */
    resumeSessionId?: string
  })[]
}

/**
 * The agent-loop plugin (`ctx.agentLoop`): creates {@link LoopAgent}s, runs
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

  static Config: z<Config> = z.object({
    agents: z.array(z.object({
      id: z.string().required(),
      model: z.string(),
      systemPrompt: z.string(),
      resumeSessionId: z.string(),
    })).default([]),
  })

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'agentLoop')
    // Provide the agent-creation factory to the registry (effect-scoped: the
    // slot is cleared on dispose).
    ctx.effect(() => this.ctx.agents.setFactory(this), 'agentLoop.setFactory()')
    for (const { id, resumeSessionId, ...options } of config.agents) {
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
        this.create(id, options)
      }
    }
  }

  /**
   * Config-driven create: an agent on a FRESH, non-colliding session id per run
   * (`${id}-session-<uuid>`, no cwd). Used for `cordis.yml`-configured agents
   * and as the shared core for the programmatic factory {@link createAgent}.
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
   *
   * TODO(sub-agents): spawn/fork land here — accept a parent agent reference;
   * fork seeds the new Session with the parent's event log, spawn starts
   * fresh; the child is returned as a regular Agent handle.
   */
  create(id: string, options: AgentOptions = {}): LoopAgent {
    this.assertAgentIdFree(id)
    const session = this.ctx.sessions.create(`${id}-session-${randomUUID()}`, { meta: {} })
    return this.start(AgentId(id), options, session)
  }

  /**
   * Programmatic factory create ({@link AgentFactory}): an agent on a
   * caller-supplied `sessionId` (NOT `${id}-session`), with optional session
   * metadata (validated `cwd`, lineage). The ACP bridge uses this so the
   * client-generated session id becomes the live/persisted session id.
   */
  createAgent(options: CreateAgentOptions): Agent {
    // Check the agent id BEFORE creating the session: register() would reject a
    // duplicate id only AFTER sessions.create(), leaving an orphaned live
    // session (and lazy persistence state) that blocks reuse of that id.
    this.assertAgentIdFree(options.agentId)
    const session = this.ctx.sessions.create(options.sessionId, { meta: options.meta ?? {} })
    return this.start(AgentId(options.agentId), options.agentOptions ?? {}, session)
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
   */
  async resume(options: ResumeAgentOptions): Promise<Agent> {
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
  private async resumeWith(persistence: SessionPersistence, options: ResumeAgentOptions): Promise<Agent> {
    this.assertAgentIdFree(options.agentId)
    const { meta, events } = await persistence.load(SessionId(options.resumeSessionId))
    // Re-check the agent id AFTER the await: the pre-load check above can go
    // stale while load() is pending (a concurrent resume/create may register the
    // same id). Re-checking immediately before sessions.create() keeps the
    // "no orphaned session on a duplicate id" guarantee under concurrency.
    this.assertAgentIdFree(options.agentId)
    // Reconstruct the live session with the FULL persisted header (createdAt,
    // cwd, lineage) so resume preserves identity, not just the cwd. The seed
    // events make lastTurnNumber/deriveMessages continue; the backend already
    // has state (cursor) from the load above, so onCreated is a no-op and the
    // seed is not re-persisted.
    const session = this.ctx.sessions.create(options.resumeSessionId, {
      seed: events,
      meta: {
        createdAt: meta.createdAt,
        ...meta.cwd !== undefined ? { cwd: meta.cwd } : {},
        ...meta.parentSession !== undefined ? { parentSession: meta.parentSession } : {},
      },
    })
    return this.start(AgentId(options.agentId), options.agentOptions ?? {}, session)
  }

  /**
   * Reject a duplicate agent id BEFORE any session is created, so a failed
   * factory call never leaves an orphaned live session (and lazy persistence
   * state) behind. `register()` enforces the same uniqueness, but only after
   * `sessions.create()` has already run.
   */
  private assertAgentIdFree(id: string): void {
    if (this.ctx.agents.get(id) !== undefined) {
      throw new Error(`agent "${id}" is already registered`)
    }
  }

  /** Shared: construct a LoopAgent, register it, and start its loop (LIFO). */
  private start(id: AgentId, options: AgentOptions, session: Session): LoopAgent {
    const agent = new LoopAgent(this.ctx, id, options, session)
    // Generator effect: stop and unregister are independent disposables
    // (LIFO), so a throwing stop() cannot leak the registry entry.
    this.ctx.effect(function* (this: AgentLoop) {
      yield this.ctx.agents.register(agent)
      yield agent.start()
    }.bind(this), 'agentLoop.start()')
    return agent
  }
}

export default AgentLoop
