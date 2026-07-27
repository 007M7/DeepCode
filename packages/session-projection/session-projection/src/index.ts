/**
 * Session-projection seam: the merge-extensible `SessionProjectionMap` type
 * table, the `ProjectionProvider` contract, and the `ctx.sessionProjections`
 * registry. Domain host plugins contribute whole current values of
 * log-derived per-session state; carriers (api-proxy history tail page, and
 * future TUI/ACP consumers) walk the registry synchronously so every key and
 * the accompanying `asOfSeq` form one consistent cut. Neither side knows the
 * other (capability-seam three-way split).
 *
 * Whole-value rule (load-bearing): a state-carrying log event MUST carry the
 * complete post-change state, never a delta, so the client-side fold is
 * last-wins by seq. See the session-projection RFC
 * (.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md).
 *
 * @module @deepseek-ai/dsh-session-projection
 */

import { Context, Service } from 'cordis'
import type { ZodType } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'

declare module 'cordis' {
  interface Context {
    sessionProjections: SessionProjectionRegistry
  }
}

/**
 * The single projection type table for the whole chain (host provider, wire
 * block, client cell, React hook). Domain packages merge their key here via
 * declaration merging; values are wire-JSON whole values. How a value is
 * rendered is the slot system's business, never this layer's.
 */
export interface SessionProjectionMap {}

/**
 * One domain's host-side contribution: the current whole value of its
 * log-derived per-session state.
 */
export interface ProjectionProvider<K extends keyof SessionProjectionMap> {
  /** The projection key this provider owns (its `SessionProjectionMap` entry). */
  key: K
  /** Validates the payload before it leaves the host (carriers parse each value through this). */
  schema: ZodType<SessionProjectionMap[K]>
  /**
   * Return the current whole value for one agent's session. MUST be
   * synchronous — carriers read `session.seq` and every provider value with no
   * await between them, so an async provider would tear the consistency cut
   * (an accidentally returned Promise fails the carrier's `schema.parse`
   * loudly). Runs against the host's full in-memory log
   * (`agent.session.events`): a last-wins domain may backscan from the tail; a
   * domain with an expensive fold keeps an incremental cache keyed by observed
   * seq.
   * @param agent - the agent whose session state is projected.
   * @returns the whole current value for this provider's key.
   */
  get(agent: Agent): SessionProjectionMap[K]
}

/** Union-typed view of a registered provider, as seen by carriers walking the table. */
export type AnyProjectionProvider = ProjectionProvider<keyof SessionProjectionMap>

/**
 * `ctx.sessionProjections`: the projection provider table. Registration is an
 * effect (disposer rides the calling fiber): an unloaded domain plugin's key
 * disappears from subsequent walks and clients read it as capability absence.
 * Duplicate keys throw. Domain plugins register under
 * `ctx.inject(['sessionProjections'], …)` so headless assemblies without the
 * registry stay unaffected.
 */
export class SessionProjectionRegistry extends Service {
  private readonly providers = new Map<keyof SessionProjectionMap, AnyProjectionProvider>()

  /**
   * Create and install the registry as `ctx.sessionProjections`.
   * @param ctx - Cordis context that owns the service.
   */
  constructor(ctx: Context) {
    super(ctx, 'sessionProjections')
  }

  /**
   * Register one domain's provider. The registration is an effect on the
   * calling context's fiber: disposing the fiber (or calling the returned
   * disposer) removes the key from subsequent walks.
   * @param provider - key, boundary schema, and synchronous whole-value read.
   * @returns the exact disposer that unregisters this provider.
   */
  register<K extends keyof SessionProjectionMap>(provider: ProjectionProvider<K>): () => void {
    const dispose = this.ctx.effect(function* (this: SessionProjectionRegistry) {
      if (this.providers.has(provider.key)) {
        throw new Error(`session projection key ${JSON.stringify(provider.key)} is already registered`)
      }
      this.providers.set(provider.key, provider)
      yield () => {
        this.providers.delete(provider.key)
      }
    }.bind(this), 'sessionProjections.register()')
    return () => void dispose()
  }

  /**
   * Snapshot the registered providers in registration order — the carrier
   * walk surface. Each provider carries its own `key` and `schema`.
   * @returns the providers registered at this moment.
   */
  entries(): AnyProjectionProvider[] {
    return [...this.providers.values()]
  }
}

export default SessionProjectionRegistry
