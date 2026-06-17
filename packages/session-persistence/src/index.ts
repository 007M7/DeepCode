/**
 * The durable session-persistence seam (`ctx.sessionPersistence`): an abstract
 * service defining WHAT a persistence backend does — durably store, reload,
 * list, and update sessions — without saying HOW. Implementations subclass
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
 * cwd, lineage) travels separately as {@link SessionMeta}, which is owned by
 * `dsh-session` and re-exported here.
 *
 * @module @deepseek-ai/dsh-session-persistence
 */

import { Context, Service } from 'cordis'
import type { SessionEvent, SessionId, SessionMeta, SessionSummary } from '@deepseek-ai/dsh-session'

// Re-export the metadata vocabulary so consumers import it from the seam.
export type { SessionHeader, SessionSummary, SessionMeta } from '@deepseek-ai/dsh-session'

declare module 'cordis' {
  interface Context {
    sessionPersistence: SessionPersistence
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
   * created-but-never-appended session is absent from {@link has}/{@link list}
   * — abandoned sessions leave nothing behind.
   */
  abstract create(meta: SessionMeta): Promise<void>

  /**
   * Durably persist a batch of events (called from the write-behind drain at
   * the `session/flush` checkpoint). Honors the append-only and contiguous-seq
   * contracts: the first event's `seq` MUST equal the stored next-seq (after
   * `load` has durably closed any interrupted turn). Rejects non-JSON-
   * serializable `event.data` with an error naming the offending event type.
   */
  abstract append(id: SessionId, events: readonly SessionEvent[]): Promise<void>

  /**
   * Reload a session: its {@link SessionMeta} plus the event log up to the last
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
   * unloadable (reject). Rejects an unknown format `version`. See ADR 0018 for
   * the crash-recovery contract.
   */
  abstract load(id: SessionId): Promise<{ meta: SessionMeta; events: SessionEvent[] }>

  /** Lightweight listing from metadata, without a full-log parse. */
  abstract list(): Promise<SessionMeta[]>

  /** Whether a session is durably present (materialized). */
  abstract has(id: SessionId): Promise<boolean>

  /** Remove a session and all its persisted artifacts. */
  abstract delete(id: SessionId): Promise<void>

  /**
   * Update mutable metadata ({@link SessionSummary}: `updatedAt`, `title`,
   * `firstPrompt`) WITHOUT touching the append-only event log. A backend
   * stores the summary beside the log (a sidecar file, a header row) and
   * rewrites only it.
   */
  abstract update(id: SessionId, summary: Partial<SessionSummary>): Promise<void>
}

export default SessionPersistence
