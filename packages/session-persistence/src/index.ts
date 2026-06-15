/**
 * The durable session-persistence seam (`ctx.sessionPersistence`): an abstract
 * service defining WHAT a persistence backend does — durably store, reload,
 * list, and update sessions — without saying HOW. Implementations subclass
 * {@link SessionPersistence} and register themselves as the
 * `sessionPersistence` service; `@deepseek-ai/dsh-session-persistence-jsonl`
 * (an append-only JSONL log per session) is the first. Future backends swap in
 * SQLite/WAL, an object store, or a remote service without touching the
 * consumers (the write-path plugin, the agent-loop resume seam).
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
 * - **Append-only.** Committed events — those at or below a flushed `turn/end`
 *   — are never rewritten. The ONLY exception is the one-time truncation-repair
 *   of a never-committed crash tail on the first {@link append} after a
 *   {@link load} (see {@link load}).
 * - **Contiguous seq.** A persisted log is contiguous: `events[i].seq === i`.
 *   {@link load} rejects a parse error or a `seq` gap in the MIDDLE of the log
 *   (unloadable); {@link append}'s first event `seq` MUST equal the backend's
 *   stored next-seq after any repair.
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
   * contracts: the first event's `seq` MUST equal the stored next-seq after
   * any truncation-repair of a crash tail. Rejects non-JSON-serializable
   * `event.data` with an error naming the offending event type.
   */
  abstract append(id: SessionId, events: readonly SessionEvent[]): Promise<void>

  /**
   * Reload a session: its {@link SessionMeta} plus the event log up to the last
   * durable checkpoint. Returns `meta` AND `events` so the live session is
   * reconstructed with its `cwd`/lineage, not just its log.
   *
   * The loop only flushes at `turn/end`, so a crash can leave a half-written
   * final turn below the last committed checkpoint. `load` returns events only
   * up to the **last complete `turn/end`**; a subsequent {@link append} runs
   * the one-time truncation-repair that physically discards the orphaned tail
   * before writing. Returned events are contiguous (`events[i].seq === i`); a
   * parse error or a `seq` gap in the MIDDLE of the log makes the session
   * unloadable (reject). Rejects an unknown format `version`.
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
