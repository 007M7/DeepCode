/**
 * Durable session-persistence seam (`ctx.sessionPersistence`). Backends store
 * {@link SessionEvent}s as the event-sourced log and carry non-replayable
 * {@link SessionHeader} metadata separately.
 * @module @deepseek-ai/dsh-session-persistence
 */

import { Context, Service } from 'cordis'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId, SessionHeader } from '@deepseek-ai/dsh-session'

// Re-export the metadata vocabulary so consumers import it from the seam.
export type { SessionHeader } from '@deepseek-ai/dsh-session'

// The backend-agnostic write-path orchestration first-party backends compose.
export { PersistenceCoordinator } from './coordinator.ts'
export type { PersistenceBackend, StoredPrefix } from './coordinator.ts'

declare module 'cordis' {
  interface Context {
    sessionPersistence: SessionPersistence
  }
}

/**
 * Check whether a live seed exactly reproduces a durable prefix, including full
 * payloads. This distinguishes resume/HMR rebinding from an id collision.
 * @param seed - the live session's creation-time event snapshot.
 * @param prefix - the persisted prefix the seed must reproduce.
 * @returns `true` when the prefix fits within the seed and every event matches by JSON text.
 */
export function seedCoversPrefix(seed: readonly SessionEvent[], prefix: readonly SessionEvent[]): boolean {
  return prefix.length <= seed.length
    && prefix.every((event, index) => {
      const seedEvent = seed[index]
      return seedEvent !== undefined && JSON.stringify(seedEvent) === JSON.stringify(event)
    })
}

/**
 * Reject a batch that is not wholly losslessly JSON-serializable. Live session
 * appends already enforce this; persistence append paths also accept replay or
 * direct batches that may bypass a live session instance. Validation uses the
 * same one-pass materializer as the coordinator, so getters are read once.
 * @param events - the complete event batch to validate.
 */
export function assertSerializable(events: readonly SessionEvent[]): void {
  const snapshot = snapshotJsonValue(events)
  if (snapshot === undefined) {
    throw new Error('session event batch is not losslessly JSON-serializable because it contains non-JSON-serializable data')
  }
}

/**
 * Durable append-only session storage. Implementations preserve contiguous,
 * losslessly JSON-serializable events; {@link append} resolves only after
 * durability, and {@link load} balances a complete interrupted tail without
 * rewriting committed events.
 */
export abstract class SessionPersistence extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessionPersistence')
  }

  /**
   * Register a new session's metadata. A backend MAY defer the physical write
   * until the first {@link append} (lazy materialization), in which case a
   * created-but-never-appended session is absent from {@link list}
   * — abandoned sessions leave nothing behind.
   * @param meta - the immutable header (id, version, cwd, lineage) to record.
   */
  abstract create(meta: SessionHeader): Promise<void>

  /**
   * Durably persist a batch of events (called from the write-behind drain at
   * the `session/flush` checkpoint). Honors the append-only and contiguous-seq
   * contracts: the first event's `seq` MUST equal the stored next-seq (after
   * `load` has durably closed any interrupted turn). Rejects non-JSON-
   * serializable `event.data` with an error naming the offending event type.
   * @param id - the session the batch belongs to.
   * @param events - the contiguous batch to persist, in seq order.
   */
  abstract append(id: SessionId, events: readonly SessionEvent[]): Promise<void>

  /**
   * Load a header and balanced contiguous log. A complete interrupted final
 * turn is preserved and durably closed with missing tool errors plus any open
 * step and turn boundaries; only a torn final record is discarded. Unknown
 * versions and corruption in the committed prefix reject.
   * @param id - the persisted session to reload.
   * @returns the header and a log ending on a balanced `turn/end`.
   */
  abstract load(id: SessionId): Promise<{ meta: SessionHeader; events: SessionEvent[] }>

  /**
   * Lightweight listing from metadata, without a full-log parse.
   * @returns one header per materialized session.
   */
  abstract list(): Promise<SessionHeader[]>
}

export default SessionPersistence
