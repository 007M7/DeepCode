/**
 * Live-session registry seam (`ctx.sessionRegistry`): a cross-process registry
 * of live `dsh` sessions, so a separate short-lived process such as
 * `dsh list-sessions` can answer "what am I running right now".
 *
 * This package owns only the service contract and the record vocabulary; a
 * backend (the lock-guarded JSON file in
 * `@deepseek-ai/dsh-session-registry-file` today, a database later) owns the
 * medium. Whatever the medium, liveness is part of the contract: {@link list}
 * returns only records whose process existed at observation time, so a process
 * killed without running its disposer leaves no permanent phantom.
 * @module @deepseek-ai/dsh-session-registry
 */

import { Context, Service } from 'cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { BootId, type SessionRegistryRecord } from './types.ts'

export { BootId } from './types.ts'
export type { SessionRegistryRecord } from './types.ts'

declare module 'cordis' {
  interface Context {
    sessionRegistry: SessionRegistry
  }
}

/** What one process publishes about itself; the service supplies pid and timing. */
export interface SessionRegistration {
  /** The session this process runs. */
  sessionId: SessionId
  /** Absolute workspace directory the session acts on. */
  cwd: string
  /** Human-readable session title, when one already exists. */
  title?: string
}

/**
 * Cross-process live-session registry. Reads prune dead records, so every
 * returned record's process existed at observation time. Backends serialize
 * mutations against concurrent registrars — other processes and overlapping
 * calls in this one — so records are never lost to a torn read-modify-write.
 */
export abstract class SessionRegistry extends Service {
  /** This process incarnation's id, stamped into every record it publishes. */
  protected readonly bootId: BootId

  constructor(ctx: Context, bootId: BootId) {
    super(ctx, 'sessionRegistry')
    this.bootId = bootId
  }

  /**
   * Publish this process's record, replacing any stale record for the same
   * session id, and prune records whose process is gone.
   * @param registration - the session, surface, and workspace to publish.
   * @returns the effect disposer that removes this record again; awaiting it
   * waits for the removal to reach durability.
   */
  abstract register(registration: SessionRegistration): Promise<() => Promise<void>>

  /**
   * Replace the recorded title of a session this process registered.
   *
   * Titles arrive after registration and can be revised, so this is the one
   * mutable field. Only a record matching this process and incarnation is
   * touched, leaving a same-id record owned by another process alone. An unknown
   * session id is a no-op rather than an error: a title can resolve after the
   * session's record has already been removed.
   * @param sessionId - the session whose recorded title changes.
   * @param title - the new title text.
   */
  abstract retitle(sessionId: SessionId, title: string): Promise<void>

  /**
   * List live sessions, pruning records whose process no longer exists.
   * @returns one record per live registered session, newest registration last.
   */
  abstract list(): Promise<SessionRegistryRecord[]>
}

export default SessionRegistry
