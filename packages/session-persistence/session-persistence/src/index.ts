/**
 * The durable session-persistence seam (`ctx.sessionPersistence`): an abstract
 * service defining WHAT a persistence backend does — durably store, reload,
 * and list sessions — without saying HOW. Implementations subclass
 * {@link SessionPersistence} and register themselves as the
 * `sessionPersistence` service; `@deepseek-ai/dsh-session-persistence-jsonl`
 * (an append-only JSONL log per session) is the first and
 * `@deepseek-ai/dsh-session-persistence-sqlite` (`node:sqlite`, one row per
 * event) is a second that validates the seam is backend-agnostic by passing
 * the same `runPersistenceContract` suite. Further backends swap in an object
 * store or a remote service without touching the consumers (the write-path
 * plugin, the agent-loop resume seam).
 *
 * The persisted unit IS the existing {@link SessionEvent} — there is no
 * parallel "persisted message" type the log must be converted to and from
 * (faithful to the event-sourced model: the log is the single source of
 * truth). Metadata that is NOT replayable conversation state (format version,
 * cwd, lineage, seed boundary) travels separately as {@link SessionHeader},
 * which is owned by `dsh-session` and re-exported here.
 *
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
 * Whether a live session's seed reproduces a persisted prefix exactly. Backends
 * use this collision check to distinguish a legitimate resume/HMR rebind from a
 * different live session reusing an existing session id.
 *
 * The comparison includes the full event payload, not just seq/type/time, so a
 * mutated seed cannot be grafted onto a durable log with the same envelope.
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
 */
export function assertSerializable(events: readonly SessionEvent[]): void {
  for (const event of events) {
    if (!isJsonValue(event.data)) {
      throw new Error(`event "${event.type}" carries non-JSON-serializable data (seq ${event.seq})`)
    }
  }
}

/**
 * Abstract durable session-persistence service. Subclass, implement the
 * abstract methods, and load the subclass as a plugin — it registers as
 * `ctx.sessionPersistence` (one implementation per context; loading a second
 * throws, cordis' standard duplicate-service behavior).
 *
 * Contracts every implementation MUST honor (a DB backend asserts them inside
 * a transaction; a file backend appends at EOF):
 *
 * - **Append-only; a crashed turn is closed, not truncated.** Committed events
 *   — those at or below a flushed `turn/end` — are never rewritten. A crash can
 *   leave an unclosed final turn whose events are real (and possibly large);
 *   {@link load} preserves them and closes the orphaned turn with synthetic
 *   boundary events (see {@link load}). Only a never-fully-written torn tail
 *   fragment is discarded.
 * - **Contiguous seq.** A persisted log is contiguous: `events[i].seq === i`.
 *   {@link load} rejects a parse error or a `seq` gap in the COMMITTED region
 *   (unloadable); {@link append}'s first event `seq` MUST equal the backend's
 *   stored next-seq (after `load` has balanced any interrupted turn).
 * - **JSON-serializable data.** `SessionEventMap` is merge-extensible and
 *   `event.data` is typed only as `SessionEventMap[K]`, so {@link append}
 *   REJECTS non-JSON-serializable data with an error naming the offending
 *   event type. A backend snapshots (serializes/clones) each event when it
 *   buffers, since `session.events` hands out the live mutable object.
 * - **Durability.** {@link append} returns only once the batch is durable
 *   (the file backend fsyncs; a DB commits). {@link create} MAY defer the
 *   physical write until the first {@link append} (lazy materialization).
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
   */
  abstract create(meta: SessionHeader): Promise<void>

  /**
   * Durably persist a batch of events (called from the write-behind drain at
   * the `session/flush` checkpoint). Honors the append-only and contiguous-seq
   * contracts: the first event's `seq` MUST equal the stored next-seq (after
   * `load` has durably closed any interrupted turn). Rejects non-JSON-
   * serializable `event.data` with an error naming the offending event type.
   */
  abstract append(id: SessionId, events: readonly SessionEvent[]): Promise<void>

  /**
   * Reload a session: its {@link SessionHeader} plus the event log up to the last
   * durable checkpoint. Returns `meta` AND `events` so the live session is
   * reconstructed with its `cwd`/lineage, not just its log.
   *
   * The loop only flushes at `turn/end`, so a crash can leave a durable log
   * whose final turn never closed: real, fully-written events sit after the last
   * `turn/end`. Those events are PRESERVED — a single turn can be huge in a
   * long-horizon task, so truncating it would destroy real work — and `load`
   * CLOSES the orphaned turn by durably appending the minimal synthetic boundary
   * events: an error `tool/result` for every `tool-call` the crash left
   * unanswered (so the rehydrated history is a valid provider transcript — a
   * dangling assistant tool-call is otherwise rejected), then a `step/end` if a
   * step was open, then a `turn/end` carrying the `{ kind: 'interrupted' }`
   * reason. The returned `events` therefore end on a balanced `turn/end` and are
   * immediately usable as a session seed. Only a never-fully-written TORN tail
   * fragment (a half-written final record) is discarded. Returned events are
   * contiguous (`events[i].seq === i`); a parse error or a `seq` gap in the
   * COMMITTED region (at or before the last real `turn/end`) makes the session
   * unloadable (reject). Rejects an unknown format `version`. See the session-persistence RFC for
   * the crash-recovery contract.
   */
  abstract load(id: SessionId): Promise<{ meta: SessionHeader; events: SessionEvent[] }>

  /** Lightweight listing from metadata, without a full-log parse. */
  abstract list(): Promise<SessionHeader[]>
}

export default SessionPersistence
