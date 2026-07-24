/**
 * Durable session-persistence seam (`ctx.sessionPersistence`). Backends store
 * {@link SessionEvent}s as the event-sourced log and carry non-replayable
 * {@link SessionHeader} metadata separately.
 * @module @deepseek-ai/dsh-session-persistence
 */

import { Context, Service } from 'cordis'
import type { SessionEvent, SessionId, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistenceRevision } from './revision.ts'
import type { SessionLiveLease } from './lease.ts'

// Re-export the metadata vocabulary so consumers import it from the seam.
export type { SessionHeader } from '@deepseek-ai/dsh-session'
export { SessionPersistenceRevision } from './revision.ts'
export {
  sessionLeaseOwnerIsLive,
  sessionLeaseProcessIsLive,
  sessionLiveOwner,
  shareSessionLiveLease,
} from './lease.ts'
export type { SessionLiveLease, SessionLiveOwner } from './lease.ts'

/** Lightweight immutable source identity returned without loading a full log. */
export interface SessionPersistenceSnapshot {
  /** Detached metadata for one materialized session. */
  header: SessionHeader
  /** Opaque source-qualified token that changes whenever this stored log changes. */
  revision: SessionPersistenceRevision
}

// The backend-agnostic write-path orchestration first-party backends compose.
export { PersistenceCoordinator } from './coordinator.ts'
export type { PersistenceBackend, StoredPrefix } from './coordinator.ts'

declare module 'cordis' {
  interface Context {
    sessionPersistence: SessionPersistence
  }
}

/**
 * A backend-resolved, per-session local artifact location. The path is an
 * absolute target path and can name an artifact that has not materialized yet.
 * Consumers must treat it as a location hint, never as an authorization token.
 */
export interface SessionLocation {
  /** Backend-specific artifact kind, for example `jsonl`. */
  readonly kind: string
  /** Absolute path to this session's backend-owned artifact. */
  readonly path: string
}

/**
 * Durable append-only session storage. Implementations preserve contiguous,
 * losslessly JSON-serializable events; {@link append} resolves only after
 * durability, and {@link load} balances a complete interrupted tail without
 * rewriting committed events.
 */
export abstract class SessionPersistence extends Service {
  private readonly localLiveClaims = new Map<SessionId, number>()

  constructor(ctx: Context) {
    super(ctx, 'sessionPersistence')
  }

  /**
   * Resolve this backend's independent local artifact for a session without
   * reading, creating, flushing, or otherwise materializing it. Backends such
   * as SQLite that do not own one artifact per session return `undefined`.
   * @param meta - the immutable session header whose artifact is requested.
   * @returns the backend-specific absolute location, when one exists.
   */
  abstract locate(meta: SessionHeader): SessionLocation | undefined

  /**
   * Register a new session's metadata. A backend MAY defer the physical write
   * until the first {@link append} (lazy materialization), in which case a
   * created-but-never-appended session is absent from {@link list}
   * — abandoned sessions leave nothing behind.
   * @param meta - the immutable header (id, version, cwd, lineage) to record.
   */
  abstract create(meta: SessionHeader): Promise<void>

  /**
   * Durably persist a batch of events. Honors the append-only and contiguous-
   * seq contracts: the first event's `seq` MUST equal the stored next-seq
   * (after `load` has durably closed any interrupted turn). Rejects non-JSON-
   * serializable `event.data` with an error naming the offending event type.
   * @param id - the session the batch belongs to.
   * @param events - the contiguous batch to persist, in seq order.
   */
  abstract append(id: SessionId, events: readonly SessionEvent[]): Promise<void>

  /**
   * Load a header and balanced contiguous log. A complete interrupted final
   * turn is preserved and durably closed with missing tool errors plus any open
   * step and turn boundaries; only a torn final record is discarded. Unknown
   * versions and corruption in the committed prefix reject. Implementations
   * MUST NOT crash-repair an identity still bound to a live Session: a balanced
   * live log may return with its stored header as a durable snapshot, while an
   * open live turn rejects.
   * A coordinator-backed cold load reserves the identity across storage awaits,
   * so concurrent publication of a same-id live Session rejects.
   * @param id - the persisted session to reload.
   * @returns the header and a log ending on a balanced `turn/end`.
   */
  abstract load(id: SessionId): Promise<{ meta: SessionHeader; events: SessionEvent[] }>

  /**
   * Inspect a header and its valid contiguous stored prefix without repairing
   * a torn tail, closing an interrupted turn, or publishing coordinator state.
   * This read is serialized with writes for the same id and returns detached
   * values, so observers cannot mutate backend-owned state.
   * @param id - the persisted session to inspect.
   * @returns the header and valid stored event prefix exactly as observed.
   */
  abstract inspect(id: SessionId): Promise<{ meta: SessionHeader; events: SessionEvent[] }>

  /**
   * Lightweight listing from metadata, without a full-log parse.
   * @returns one header per materialized session.
   */
  abstract list(): Promise<SessionHeader[]>

  /**
   * List materialized sessions with cheap per-log change tokens.
   *
   * Repeated observations of an unchanged log return the same revision. A
   * successful mutating {@link load} repair changes the next listed revision.
   * Revisions also distinguish independently backed stores so backend-local
   * counters cannot compare equal across different persistence sources.
   * @returns one header and opaque revision per materialized session without loading full logs.
   */
  abstract listSnapshots(): Promise<SessionPersistenceSnapshot[]>

  /**
   * Atomically acquire this process's live ownership of a session id.
   * Reentrant claims share one backend lease. First-party backends override
   * this process-local fallback to reject another live process and reclaim a
   * dead owner.
   * @param id - session identity that is about to become live.
   * @returns a single-release reference owned by the caller.
   */
  claimLive(id: SessionId): Promise<SessionLiveLease> {
    this.localLiveClaims.set(id, (this.localLiveClaims.get(id) ?? 0) + 1)
    let released = false
    return Promise.resolve({
      release: () => {
        if (released) return Promise.resolve()
        released = true
        const refs = this.localLiveClaims.get(id) as number
        if (refs <= 1) this.localLiveClaims.delete(id)
        else this.localLiveClaims.set(id, refs - 1)
        return Promise.resolve()
      },
    })
  }

  /**
   * Check whether any process currently owns a live lease for this session.
   * The base implementation reports only claims on this service instance.
   * @param id - persisted or prospective session identity.
   * @returns true while a non-stale lease exists, including this process's lease.
   */
  isLive(id: SessionId): Promise<boolean> {
    return Promise.resolve(this.localLiveClaims.has(id))
  }
}

export default SessionPersistence
