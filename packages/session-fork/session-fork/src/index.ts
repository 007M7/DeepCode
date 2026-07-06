/**
 * Session forking as an optional service. The core session store exposes the
 * low-level seed primitive; this plugin owns the policy for when a live session
 * may be forked and the metadata stamped on the child.
 *
 * @module @deepseek-ai/dsh-session-fork
 */

import { Context, Service } from 'cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

declare module 'cordis' {
  interface Context {
    sessionFork: SessionForkService
  }
}

/** A fork source: either the live session object or its live store id. */
export type SessionForkSource = Session | SessionId

/** Metadata and seed events that can create a forked child session or agent. */
export interface SessionForkSeed {
  /** The resolved live source session. */
  source: Session
  /** Deep-cloned seed events copied from the source session at a turn boundary. */
  seed: SessionEvent[]
  /** Session creation metadata for the forked child. */
  meta: {
    /** The source session id. */
    parentSession: SessionId
    /** How many leading child events were inherited rather than produced. */
    seedLength: number
    /** The source session workspace, inherited by the child when present. */
    cwd?: string
  }
}

/** Inputs for the convenience session-creation path. */
export interface ForkSessionOptions {
  /** Live source session object or id. */
  source: SessionForkSource
  /** Optional child session id; omitted delegates to SessionStore's id policy. */
  sessionId?: SessionId
}

export type SessionForkErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_NOT_LIVE'
  | 'SESSION_ALREADY_EXISTS'
  | 'OPEN_TURN'

/** Typed error for service-level fork rejections. */
export class SessionForkError extends Error {
  constructor(message: string, public readonly code: SessionForkErrorCode) {
    super(message)
    this.name = 'SessionForkError'
  }
}

/**
 * `ctx.sessionFork`: validates live session fork boundaries and creates seeded
 * child sessions using the existing `ctx.sessions.create({ seed })` primitive.
 */
export class SessionForkService extends Service {
  static inject = ['sessions']

  constructor(ctx: Context) {
    super(ctx, 'sessionFork')
  }

  /**
   * Resolve and validate a live source session, then return a reusable deep-
   * cloned fork seed. A non-empty source must end exactly at `turn/end`; this
   * service rejects open turns rather than clipping to an older boundary.
   *
   * @param source Live session object or live store id to snapshot.
   * @returns Deep-cloned seed events plus child session metadata.
   */
  snapshot(source: SessionForkSource): SessionForkSeed {
    const session = this._resolve(source)
    this._assertTurnBoundary(session)
    const seed = session.events.map(event => structuredClone(event))
    return {
      source: session,
      seed,
      meta: {
        ...session.header.cwd !== undefined ? { cwd: session.header.cwd } : {},
        parentSession: session.id,
        seedLength: seed.length,
      },
    }
  }

  /**
   * Convenience path: create a live child session from a fork snapshot. Callers
   * that create agents can use {@link snapshot} and pass its seed/meta through
   * `ctx.agents.create` instead.
   *
   * @param options Source and optional child session id for the fork.
   * @returns The created live child session.
   */
  fork(options: ForkSessionOptions): Session {
    if (options.sessionId !== undefined && this.ctx.sessions.get(options.sessionId) !== undefined) {
      throw new SessionForkError(`session "${options.sessionId}" already exists`, 'SESSION_ALREADY_EXISTS')
    }
    const snapshot = this.snapshot(options.source)
    return this.ctx.sessions.create(options.sessionId, {
      seed: snapshot.seed,
      meta: snapshot.meta,
    })
  }

  private _resolve(source: SessionForkSource): Session {
    if (typeof source === 'string') {
      const session = this.ctx.sessions.get(source)
      if (session === undefined) throw new SessionForkError(`session "${source}" not found`, 'SESSION_NOT_FOUND')
      return session
    }

    const live = this.ctx.sessions.get(source.id)
    if (live === undefined) {
      throw new SessionForkError(`session "${source.id}" not found`, 'SESSION_NOT_FOUND')
    }
    if (live !== source) throw new SessionForkError(`session "${source.id}" is not the live store instance`, 'SESSION_NOT_LIVE')
    return source
  }

  private _assertTurnBoundary(session: Session): void {
    const last = session.events.at(-1)
    if (last !== undefined && last.type !== 'turn/end') {
      throw new SessionForkError(
        `cannot fork session "${session.id}" inside an open turn (last event: ${last.type})`,
        'OPEN_TURN',
      )
    }
  }
}

export default SessionForkService
