/**
 * Persisted projection cache (`ctx.sessionProjectionCache`): durable
 * checkpoints of every registered projection unit's state, one record per
 * session on the domain data form (`session_projcache` domain — the shipped
 * json backend lands it beside `workspace.json`). The cache is a fold
 * shortcut, never an authority: a row is possibly stale (its `observedSeq`
 * says how stale) but never wrong, so every write path is fail-soft (a lost
 * write costs a longer tail replay on the next cold read) and a
 * `stateVersion` mismatch discards the row instead of migrating it. Design
 * authority: the session-projection RFC
 * (.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md).
 * @module @deepseek-ai/dsh-session-projection-cache
 */

import { Context, Service } from 'cordis'
import z from 'schemastery'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
// Empty type import: applies the package's cordis Context merge
// (`ctx.sessionPersistence`), which this service reads on the cold path.
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { ProjectionCheckpoint, ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { projectionCacheDomainSpec } from './spec.ts'
import type { CheckpointRecord } from './spec.ts'

export { checkpointRecord, checkpointRow, projectionCacheDomainSpec } from './spec.ts'
export type { CheckpointRecord } from './spec.ts'

declare module 'cordis' {
  interface Context {
    sessionProjectionCache: SessionProjectionCache
  }
}

/**
 * Plugin config. Both throttle triggers are deployment choices with no
 * universally correct value, so the composition states them explicitly
 * (cordis.yml); the two mandatory write points (`turn/end` and session
 * disposal) are policy, not tunables, and always fire.
 */
export interface Config {
  /** Committed events per session that force a durable checkpoint write between mandatory points. */
  writeEveryEvents: number
  /** Longest time (milliseconds) a dirty checkpoint may stay unwritten between mandatory points. */
  writeIntervalMs: number
}

export const Config: z<Config> = z.object({
  writeEveryEvents: z.natural().min(1).required(),
  writeIntervalMs: z.natural().min(1).required(),
})

/** Per-session write-behind bookkeeping (live sessions only; dropped at retire). */
interface DirtyState {
  /** Committed events since the last durable write. */
  pending: number
  /** Interval trigger armed at the first dirty event after a clean write. */
  timer: ReturnType<typeof setTimeout> | undefined
}

/**
 * The persisted projection cache service. Opens the `session_projcache`
 * domain at init, checkpoints live sessions on a throttled write-behind
 * (count/interval triggers from {@link Config}) plus two mandatory points —
 * `turn/end` and session disposal (the live-to-cold moment) — and serves the
 * cold-read ladder: cached row, persistence `readFrom` tail, registry
 * `restore`, durable write-back. Every durable write is fail-soft: failures
 * log a warning and the cache self-heals on the next write or cold read.
 */
export class SessionProjectionCache extends Service {
  static inject = ['storageDomain', 'sessionProjections', 'sessionPersistence', 'sessions']

  static Config: z<Config> = Config

  private table?: KvTable<SessionId, CheckpointRecord>
  private readonly dirty = new Map<Session, DirtyState>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'sessionProjectionCache')
  }

  /** Open the domain and install the write-behind listeners. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(projectionCacheDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'sessionProjectionCache.domainClose')
    this.table = domain.table('sessions')
    this.installWritePath()
  }

  /**
   * The stored checkpoint rows for one session, or an empty checkpoint when
   * none is stored. Synchronous from the domain's in-memory state.
   * @param id - the session whose cached rows are read.
   * @returns the persisted `key → row` checkpoint (possibly empty).
   */
  checkpointOf(id: SessionId): ProjectionCheckpoint {
    return this.requireTable().get(id)?.rows ?? {}
  }

  /**
   * Durably checkpoint one live session NOW (both mandatory points call
   * this; tests and carriers may too). The registry cut is snapshotted at
   * this boundary (states are live references), then the whole record is
   * replaced. NOT fail-soft — callers on the fail-soft paths contain it.
   * @param session - the live session to checkpoint.
   * @returns resolution after durability and event emission.
   */
  async write(session: Session): Promise<void> {
    const rows = this.ctx.sessionProjections.checkpoint(session)
    this.markClean(session)
    await this.put(session.id, rows)
  }

  /**
   * Cold-read one persisted session's projections with zero full-log load:
   * cached rows + a persistence `readFrom` tail from the registry's restore
   * floor, refolded by the registry and written back (fail-soft) so the next
   * cold read starts closer. A cache row invalidated by a shrunk log
   * (crash-repair truncation) triggers one full re-read from seq 0 — the
   * ladder's slow rung, still no crash. Rejects when the session has no
   * persisted log (`not found` from the persistence seam).
   * @param id - the persisted session to read.
   * @param signal - optional cancellation for the persistence reads.
   * @returns the snapshot cut at the stored log end.
   */
  async coldSnapshot(id: SessionId, signal?: AbortSignal): Promise<ProjectionSnapshot> {
    const cached = this.checkpointOf(id)
    const floor = this.ctx.sessionProjections.restoreFloor(cached)
    if (floor === undefined) return { asOfSeq: -1, values: {} }
    const persistence = this.ctx.sessionPersistence
    let restored: { snapshot: ProjectionSnapshot; checkpoint: ProjectionCheckpoint }
    const tail = await persistence.readFrom(id, floor, signal)
    try {
      restored = this.ctx.sessionProjections.restore(cached, tail.events, floor)
    } catch {
      // The one recoverable restore failure: a row overreaching the stored
      // log end (or predating the floor), detected by the registry. Both
      // resolve identically — discard the cache and refold the full log.
      const whole = await persistence.readFrom(id, 0, signal)
      restored = this.ctx.sessionProjections.restore({}, whole.events, 0)
    }
    await this.putSoft(id, restored.checkpoint, 'cold-read write-back')
    return restored.snapshot
  }

  // --- write-behind (throttle + mandatory points) ---

  private installWritePath(): void {
    // Every committed event advances the dirty counter; turn/end is a
    // mandatory point (the durable value most reads want is the turn-final
    // one), count/interval throttle the in-turn stream.
    this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (event.type === 'turn/end') {
        void this.flushSoft(session, 'turn/end')
        return
      }
      const state = this.dirty.get(session) ?? { pending: 0, timer: undefined }
      this.dirty.set(session, state)
      state.pending += 1
      if (state.pending >= this.config.writeEveryEvents) {
        void this.flushSoft(session, 'count threshold')
        return
      }
      state.timer ??= setTimeout(() => {
        void this.flushSoft(session, 'interval')
      }, this.config.writeIntervalMs)
    })

    // Detach (the live-to-cold moment): the second mandatory point. After
    // this write the cold-read ladder serves the session from the cache.
    // flushSoft's synchronous prefix reads and resets the dirty state, so
    // dropping it (timer already cleared by markClean) right after is safe.
    this.ctx.on('session/disposed', (session: Session) => {
      void this.flushSoft(session, 'detach')
      this.markClean(session)
      this.dirty.delete(session)
    })

    // Clear pending timers with the plugin (their sessions outlive the cache).
    this.ctx.effect(() => () => {
      for (const state of this.dirty.values()) {
        if (state.timer !== undefined) clearTimeout(state.timer)
      }
      this.dirty.clear()
    }, 'sessionProjectionCache.timers')
  }

  /** One fail-soft durable checkpoint: skip when clean, log on failure. */
  private async flushSoft(session: Session, trigger: string): Promise<void> {
    const state = this.dirty.get(session)
    const mandatory = trigger === 'turn/end' || trigger === 'detach'
    if (!mandatory && (state === undefined || state.pending === 0)) return
    try {
      await this.write(session)
    } catch (error) {
      this.ctx.logger.warn(`session projection cache: ${trigger} write for "${session.id}" failed (cache stays stale): ${String(error)}`)
    }
  }

  /** Reset one session's dirty bookkeeping (its checkpoint is being written). */
  private markClean(session: Session): void {
    const state = this.dirty.get(session)
    if (state === undefined) return
    state.pending = 0
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
  }

  /** Replace one session's stored record with a detached snapshot of `rows`. */
  private async put(id: SessionId, rows: ProjectionCheckpoint): Promise<void> {
    const detached = snapshotJsonValue(rows)
    if (detached === undefined) {
      throw new TypeError('projection checkpoint is not losslessly JSON-serializable (a unit state violates the plain-JSON contract)')
    }
    await this.requireTable().put(id, { rows: detached as CheckpointRecord['rows'] })
  }

  /** Fail-soft {@link put}: cache writes must never fail their caller's read or event path. */
  private async putSoft(id: SessionId, rows: ProjectionCheckpoint, what: string): Promise<void> {
    try {
      await this.put(id, rows)
    } catch (error) {
      this.ctx.logger.warn(`session projection cache: ${what} for "${id}" failed (cache stays stale): ${String(error)}`)
    }
  }

  private requireTable(): KvTable<SessionId, CheckpointRecord> {
    /* v8 ignore next -- Service.init assigns the table before the service becomes injectable */
    if (this.table === undefined) throw new Error('session projection cache is not initialized')
    return this.table
  }
}

export default SessionProjectionCache
