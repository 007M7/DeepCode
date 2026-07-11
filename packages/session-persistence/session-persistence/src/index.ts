/**
 * The durable session-persistence seam (`ctx.sessionPersistence`): an abstract service
 * defining what a persistence backend does — durably store, reload, and list sessions —
 * without saying how.
 * @module @deepseek-ai/dsh-session-persistence
 */

import { Context, Service } from 'cordis'
import { isJsonValue } from '@deepseek-ai/dsh-session'
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
 * Whether a live session's seed reproduces a persisted prefix exactly. Backends use this
 * collision check to distinguish a legitimate resume/HMR rebind from a different live session
 * reusing an existing session id.
 *
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
 * Reject non-JSON-serializable event data before a backend serializes a batch.
 * Live session appends already enforce this; persistence append paths also
 * accept replay/fork batches that may bypass a live session instance.
 * @param events - the batch to validate; throws naming the offending event's type and seq.
 */
export function assertSerializable(events: readonly SessionEvent[]): void {
  for (const event of events) {
    if (!isJsonValue(event.data)) {
      throw new Error(`event "${event.type}" carries non-JSON-serializable data (seq ${event.seq})`)
    }
  }
}

/**
 * Abstract durable session-persistence service. Subclass, implement the abstract methods, and
 * load the subclass as a plugin — it registers as `ctx.sessionPersistence` (one implementation
 * per context; loading a second throws, cordis' standard duplicate-service behavior).
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
   * Reload a session: its {@link SessionHeader} plus the event log up to the last durable
   * checkpoint. Returns `meta` AND `events` so the live session is reconstructed with its
   * `cwd`/lineage, not just its log.
   *
   * @param id - the persisted session to reload.
   * @returns the header plus the event log, ending on a balanced `turn/end` —
   *   immediately usable as a session seed.
   */
  abstract load(id: SessionId): Promise<{ meta: SessionHeader; events: SessionEvent[] }>

  /**
   * Lightweight listing from metadata, without a full-log parse.
   * @returns one header per materialized session.
   */
  abstract list(): Promise<SessionHeader[]>
}

export default SessionPersistence
