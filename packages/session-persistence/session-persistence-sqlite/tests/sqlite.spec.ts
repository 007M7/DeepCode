import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SurfaceEvent, SurfaceEventType } from '@deepseek-ai/dsh-session'
import SessionPersistenceSqlite, { SCHEMA_VERSION } from '@deepseek-ai/dsh-session-persistence-sqlite'
import { openDatabase, rowToEvent, scanRows, type EventRow } from '../src/schema.ts'
import { runPersistenceContract, meta, oneTurnLog, appendLog } from '../../session-persistence/tests/contract.ts'
import { runCoordinatorContract, type CoordinatorFixture } from '../../session-persistence/tests/coordinator-contract.ts'

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

async function expectParallelFlushError(promise: Promise<unknown>, message: RegExp): Promise<void> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError)
    const [cause] = (error as AggregateError).errors as unknown[]
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toMatch(message)
    return
  }
  throw new Error('expected parallel flush to reject')
}

async function freshDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sqlite-'))
  dirs.push(dir)
  return join(dir, 'sessions.db')
}

/** A context with the session store + SQLite backend, plus a teardown. */
async function backend(path = ':memory:'): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(SessionPersistenceSqlite, { path })
  return { ctx, dispose: () => fiber.dispose() }
}

// Run the same backend-agnostic contract as JSONL to pin identical semantics.
runPersistenceContract('sqlite', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(SessionPersistenceSqlite, { path: ':memory:' })
  return {
    persistence: ctx.sessionPersistence,
    dispose: async () => { await fiber.dispose() },
  }
})

// A file-backed database lets two mounts share rows across reload. `corruptTail` inserts invalid
// JSON past the committed seq, exercising coordinator repair against real database rows.
runCoordinatorContract('sqlite', async (): Promise<CoordinatorFixture> => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sqlite-coord-'))
  const path = join(dir, 'sessions.db')
  return {
    mount: async ctx => ctx.plugin(SessionPersistenceSqlite, { path }),
    corruptTail: async (id) => {
      // A row past the committed region whose `data` does not parse: scanRows
      // bounds the preserved prefix at it and returns its seq as tornFrom, which
      // the backend surfaces to the coordinator as the tornMarker to delete from.
      const db = openDatabase(path, 'wal')
      const next = (db.prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM events WHERE session_id = ?')
        .get(id) as { n: number }).n
      db.prepare('INSERT INTO events (session_id, seq, type, time, data) VALUES (?, ?, ?, ?, ?)')
        .run(id, next, 'assistant/chunk', 99, '{not valid json')
      db.close()
    },
    cleanup: async () => { await rm(dir, { recursive: true, force: true }) },
  }
})

describe('scanRows', () => {
  // scanRows works off EventRows (data is a JSON string column); build them from SessionEvents
  // so the unit tests read in terms of the event vocabulary. Surface metadata is serialized to
  // its nullable columns so the conversion remains faithful.
  const rows = (events: SessionEvent[]): EventRow[] =>
    events.map((e) => {
      const se = e as SessionEvent<SurfaceEventType>
      return {
        seq: e.seq, type: e.type, time: e.time, data: JSON.stringify(e.data),
        source_event_seqs: se.sourceEventSeqs !== undefined ? JSON.stringify(se.sourceEventSeqs) : null,
        surface_op: se.surfaceOp !== undefined ? JSON.stringify(se.surfaceOp) : null,
      }
    })

  it('preserves the full log when it ends exactly on a turn/end (no torn tail)', () => {
    const { preserved, tornFrom } = scanRows(rows(oneTurnLog()))
    expect(preserved).toEqual(oneTurnLog())
    expect(tornFrom).toBeUndefined()
  })

  it('PRESERVES the real events of an interrupted turn after the last turn/end', () => {
    // turn 1 committed (0..5) + a crashed turn 2 (turn/start 6, step/start 7, no
    // close): all 8 rows are intact, so the whole prefix is preserved and there
    // is no torn fragment to delete. (load() then synthesizes the closers.)
    const withOpenTurn: SessionEvent[] = [
      ...oneTurnLog(),
      { type: 'turn/start', seq: 6, time: 7, data: { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'step/start', seq: 7, time: 8, data: { turn: 2, step: 1 } },
    ]
    const { preserved, tornFrom } = scanRows(rows(withOpenTurn))
    expect(preserved.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(tornFrom).toBeUndefined()
  })

  it('preserves the contiguous prefix and flags a torn tail at a seq gap', () => {
    // A gap after seq 0 (no committed turn/end): seq 0 is the preserved
    // interrupted-turn event; the gap bounds it and marks the torn fragment.
    const gapped: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'step/start', seq: 2, time: 2, data: { turn: 1, step: 1 } }, // seq 1 missing
    ]
    const { preserved, tornFrom } = scanRows(rows(gapped))
    expect(preserved.map(e => e.seq)).toEqual([0])
    expect(tornFrom).toBe(1)
  })

  it('an empty log preserves nothing and has no torn tail', () => {
    expect(scanRows([])).toEqual({ preserved: [] })
  })

  it('throws on a seq gap inside the committed region (before the last turn/end)', () => {
    const gapped: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'step/start', seq: 2, time: 2, data: { turn: 1, step: 1 } }, // seq 1 missing
      { type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    expect(() => scanRows(rows(gapped))).toThrow(/seq gap in committed region/)
  })

  it('throws on an unparsable row inside the committed region', () => {
    const withCorruptCommitted: EventRow[] = [
      { seq: 0, type: 'turn/start', time: 1, data: '{not json', source_event_seqs: null, surface_op: null }, // corrupt, sits before a turn/end
      { seq: 1, type: 'turn/end', time: 2, data: JSON.stringify({ turn: 1, reason: { kind: 'completed' } }), source_event_seqs: null, surface_op: null },
    ]
    expect(() => scanRows(withCorruptCommitted)).toThrow(/unparsable committed event/)
  })

  it('tolerates an unparsable torn-tail row after the last turn/end', () => {
    const withCorruptTail: EventRow[] = [
      ...rows(oneTurnLog()),
      { seq: 6, type: 'turn/start', time: 7, data: '{not json', source_event_seqs: null, surface_op: null }, // torn fragment, no committed turn/end after
    ]
    const { preserved, tornFrom } = scanRows(withCorruptTail)
    expect(preserved).toEqual(oneTurnLog())
    expect(tornFrom).toBe(6)
  })
})

describe('SessionPersistenceSqlite: durability and crash semantics', () => {
  it('rejects a stored v0 log containing a legacy request/header-delta event', async () => {
    const path = await freshDbPath()
    const m = meta('legacy-header-delta', '/legacy')
    const db = openDatabase(path, 'wal')
    db.prepare('INSERT INTO sessions (id, version, created_at, cwd, parent_session, seed_length) VALUES (?, ?, ?, ?, NULL, NULL)')
      .run(m.id, m.version, m.createdAt, m.cwd ?? null)
    const insert = db.prepare('INSERT INTO events (session_id, seq, type, time, data) VALUES (?, ?, ?, ?, ?)')
    insert.run(m.id, 0, 'turn/start', 1, JSON.stringify({ turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } }))
    insert.run(m.id, 1, 'request/header-delta', 2, JSON.stringify({ config: { model: 'legacy' } }))
    insert.run(m.id, 2, 'turn/end', 3, JSON.stringify({ turn: 1, reason: { kind: 'completed' } }))
    db.close()

    const mounted = await backend(path)
    await expect(mounted.ctx.sessionPersistence.load(m.id)).rejects.toThrow(/unsupported legacy request\/header-delta event at seq 1/)
    await mounted.dispose()
  })

  it('rejects a stored v0 full header carrying the legacy fallback reason', async () => {
    const path = await freshDbPath()
    const m = meta('legacy-header-fallback', '/legacy')
    const db = openDatabase(path, 'wal')
    db.prepare('INSERT INTO sessions (id, version, created_at, cwd, parent_session, seed_length) VALUES (?, ?, ?, ?, NULL, NULL)')
      .run(m.id, m.version, m.createdAt, m.cwd ?? null)
    db.prepare('INSERT INTO events (session_id, seq, type, time, data) VALUES (?, ?, ?, ?, ?)')
      .run(m.id, 0, 'request/header', 1, JSON.stringify({
        header: { config: { model: 'legacy' } },
        reason: 'fallback',
      }))
    db.close()

    const mounted = await backend(path)
    await expect(mounted.ctx.sessionPersistence.load(m.id))
      .rejects.toThrow(/unsupported legacy request\/header reason "fallback" at seq 0/)
    await mounted.dispose()
  })

  it('has no independent per-session log location', async () => {
    const { ctx, dispose } = await backend()
    expect(ctx.sessionPersistence.locate(meta('sqlite-location'))).toBeUndefined()
    await dispose()
  })

  it('an interrupted turn (rows after the last turn/end) is PRESERVED and closed during load', async () => {
    const path = await freshDbPath()
    const m = meta('crash')
    // Run 1: persist a complete turn, then a half-written second turn (no turn/end).
    const ctx1 = new Context()
    await ctx1.plugin(SessionStore)
    const fiber1 = await ctx1.plugin(SessionPersistenceSqlite, { path })
    await ctx1.sessionPersistence.create(m)
    await ctx1.sessionPersistence.append(m.id, oneTurnLog())
    await ctx1.sessionPersistence.append(m.id, [
      { type: 'turn/start', seq: 6, time: 7, data: { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'step/start', seq: 7, time: 8, data: { turn: 2, step: 1 } },
    ])
    await fiber1.dispose()

    // Run 2: load PRESERVES the interrupted turn's real events (a turn can be huge
    // — never truncated) and closes the orphaned turn with synthetic boundary
    // events: step/end (the step was open) then turn/end {interrupted}.
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    const fiber2 = await ctx2.plugin(SessionPersistenceSqlite, { path })
    const loaded = await ctx2.sessionPersistence.load(m.id)
    expect(loaded.events.map(e => e.type)).toEqual([
      'turn/start', 'user/message', 'step/start', 'assistant/message', 'step/end', 'turn/end', // turn 1
      'turn/start', 'step/start', 'step/end', 'turn/end', // turn 2: real events + synthetic closers
    ])
    expect(loaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    const last = loaded.events.at(-1)!
    expect(last.type === 'turn/end' && last.data.reason).toEqual({ kind: 'interrupted' })

    // load durably closed the turn, so the next append continues at the balanced
    // length (seq 10) and a reload round-trips identically.
    await ctx2.sessionPersistence.append(m.id, [
      { type: 'turn/start', seq: 10, time: 9, data: { turn: 3, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'turn/end', seq: 11, time: 10, data: { turn: 3, reason: { kind: 'completed' } } },
    ])
    const reloaded = await ctx2.sessionPersistence.load(m.id)
    expect(reloaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    await fiber2.dispose()
  })

  it('load() durably closes the interrupted turn: the synthetic closers are on disk after load', async () => {
    const path = await freshDbPath()
    const m = meta('load-closes')
    const b1 = await backend(path)
    await b1.ctx.sessionPersistence.create(m)
    await b1.ctx.sessionPersistence.append(m.id, oneTurnLog()) // seqs 0..5
    await b1.dispose()
    // Hand-write an interrupted turn (turn/start seq 6, no turn/end).
    const db = openDatabase(path, 'wal')
    db.prepare('INSERT INTO events (session_id, seq, type, time, data) VALUES (?, 6, ?, 7, ?)')
      .run(m.id, 'turn/start', JSON.stringify({ turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } }))
    db.close()

    const b2 = await backend(path)
    const loaded = await b2.ctx.sessionPersistence.load(m.id)
    // turn 2's real turn/start (seq 6) is preserved + a synthetic turn/end (seq 7).
    expect(loaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(loaded.events.at(-1)!.type).toBe('turn/end')
    // load() is mutating: the synthetic turn/end MUST be on disk so the stored log
    // is balanced and the cursor is truthful (contract: load closes, not defers).
    const probe = openDatabase(path, 'wal')
    const stored = probe.prepare('SELECT seq, type FROM events WHERE session_id = ? ORDER BY seq').all(m.id) as { seq: number; type: string }[]
    probe.close()
    expect(stored.map(r => r.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(stored.at(-1)!.type).toBe('turn/end')
    await b2.dispose()
  })

  it('all-tail load: a session whose only turn never closed is preserved and closed on load', async () => {
    const path = await freshDbPath()
    const m = meta('all-tail')
    const b1 = await backend(path)
    await b1.ctx.sessionPersistence.create(m)
    // A first turn that NEVER completed: turn/start + user/message, no turn/end.
    await b1.ctx.sessionPersistence.append(m.id, [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'user/message', seq: 1, time: 2, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } },
    ])
    await b1.dispose()

    // A fresh backend loads it: the interrupted (only) turn's real events are
    // preserved and closed with a synthetic turn/end {interrupted} — NOT
    // truncated. The session was materialized, so list() reports it present.
    const b2 = await backend(path)
    const loaded = await b2.ctx.sessionPersistence.load(m.id)
    expect(loaded.events.map(e => e.type)).toEqual(['turn/start', 'user/message', 'turn/end'])
    expect(loaded.events.at(-1)!.type === 'turn/end' && loaded.events.at(-1)!.data).toMatchObject({ reason: { kind: 'interrupted' } })
    expect((await b2.ctx.sessionPersistence.list()).map(x => x.id)).toContain(m.id)
    await b2.dispose()
  })

  it('rejects opening a database whose schema version is not the current build (newer OR older)', async () => {
    const path = await freshDbPath()
    openDatabase(path, 'wal').close() // stamp user_version = SCHEMA_VERSION
    // Bump user_version past what this build supports.
    const dbNewer = openDatabase(path, 'wal')
    dbNewer.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    dbNewer.close()
    expect(() => openDatabase(path, 'wal')).toThrow(/incompatible with this build/)

    // A stale OLDER version (e.g. a pre-summary-drop v1 DB) is also rejected —
    // we do not migrate (unreleased software, no backward-compat).
    const olderPath = await freshDbPath()
    openDatabase(olderPath, 'wal').close()
    const dbOlder = openDatabase(olderPath, 'wal')
    dbOlder.exec('PRAGMA user_version = 1')
    dbOlder.close()
    expect(() => openDatabase(olderPath, 'wal')).toThrow(/incompatible with this build/)
  })

  it('rejects a sibling v3 database (the merge-collided version) rather than opening it against missing columns', async () => {
    // Two unmerged branches each shipped a DISTINCT layout under user_version 3 (one added only
    // `seed_length`, the other only the surface columns). The merged v4 cannot interpret that
    // ambiguous, incomplete layout and must reject it.
    const path = await freshDbPath()
    openDatabase(path, 'wal').close() // creates + stamps user_version = SCHEMA_VERSION (4)
    const db = openDatabase(path, 'wal')
    db.exec('PRAGMA user_version = 3')
    db.close()
    expect(() => openDatabase(path, 'wal')).toThrow(/schema version 3, incompatible with this build/)
  })

  it('a corrupt-JSON row in the uncommitted tail is discarded on load, not unloadable', async () => {
    const path = await freshDbPath()
    const m = meta('corrupt-tail')
    const b1 = await backend(path)
    await b1.ctx.sessionPersistence.create(m)
    await b1.ctx.sessionPersistence.append(m.id, oneTurnLog()) // committed: seqs 0..5
    await b1.dispose()

    // A torn row after the last committed turn has invalid JSON. `scanRows` locates the boundary
    // from seq/type columns without parsing the tail, preserves the committed prefix, and load
    // deletes the row; invalid JSON inside the committed region would remain fatal.
    const db = openDatabase(path, 'wal')
    db.prepare('INSERT INTO events (session_id, seq, type, time, data) VALUES (?, 6, ?, 7, ?)')
      .run(m.id, 'turn/start', '{not valid json')
    db.close()

    const b2 = await backend(path)
    const loaded = await b2.ctx.sessionPersistence.load(m.id)
    expect(loaded.events).toEqual(oneTurnLog()) // torn tail discarded, committed intact (turn 1 already balanced → no closers)
    // load physically deleted the corrupt tail row, so a fresh append continues.
    await b2.ctx.sessionPersistence.append(m.id, [
      { type: 'turn/start', seq: 6, time: 8, data: { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'turn/end', seq: 7, time: 9, data: { turn: 2, reason: { kind: 'completed' } } },
    ])
    const reloaded = await b2.ctx.sessionPersistence.load(m.id)
    expect(reloaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    await b2.dispose()
  })

  it('append rolls back the whole batch on a mid-batch seq collision (transaction)', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { path: ':memory:' })
    const m = meta('rollback')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog()) // seqs 0..5

    // A batch that re-states an already-stored seq must be rejected and leave
    // the stored log unchanged (the UNIQUE (session_id, seq) constraint fires
    // inside the transaction → ROLLBACK).
    await expect(ctx.sessionPersistence.append(m.id, oneTurnLog())).rejects.toThrow()
    const loaded = await ctx.sessionPersistence.load(m.id)
    expect(loaded.events).toEqual(oneTurnLog()) // unchanged
    await fiber.dispose()
  })

  it('persists across separate backend instances over the same file', async () => {
    const path = await freshDbPath()
    const m = meta('persist', '/proj')
    const ctx1 = new Context()
    await ctx1.plugin(SessionStore)
    const fiber1 = await ctx1.plugin(SessionPersistenceSqlite, { path })
    await ctx1.sessionPersistence.create(m)
    await ctx1.sessionPersistence.append(m.id, oneTurnLog())
    await fiber1.dispose()

    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    const fiber2 = await ctx2.plugin(SessionPersistenceSqlite, { path })
    expect((await ctx2.sessionPersistence.list()).map(x => x.id)).toContain(m.id)
    const loaded = await ctx2.sessionPersistence.load(m.id)
    expect(loaded.meta).toMatchObject({ id: m.id, cwd: '/proj' })
    expect(loaded.events).toEqual(oneTurnLog())
    await fiber2.dispose()
  })

  it('exposes the schema version constant', () => {
    expect(SCHEMA_VERSION).toBe(4)
  })
})

describe('SessionPersistenceSqlite: edge cases', () => {
  it('append rolls back and rethrows when an event INSERT fails inside the transaction', async () => {
    const path = await freshDbPath()
    const m = meta('rollback-insert')
    const b1 = await backend(path)
    await b1.ctx.sessionPersistence.create(m)
    await b1.ctx.sessionPersistence.append(m.id, oneTurnLog())

    // A SECOND backend over the same file loads the session first, so it adopts
    // cursor 6 (the committed length) into its OWN in-memory state.
    const b2 = await backend(path)
    await b2.ctx.sessionPersistence.load(m.id) // cursor 6 in b2
    const turn2: SessionEvent[] = [
      { type: 'turn/start', seq: 6, time: 7, data: { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'turn/end', seq: 7, time: 8, data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    // b1 commits seq 6..7 first.
    await b1.ctx.sessionPersistence.append(m.id, turn2)
    // b2 still thinks its cursor is 6, so this batch passes the contiguity check
    // but its INSERT of seq 6 hits the UNIQUE (session_id, seq) constraint
    // mid-transaction → ROLLBACK + rethrow.
    await expect(b2.ctx.sessionPersistence.append(m.id, turn2)).rejects.toThrow(/UNIQUE/)
    // b1's turn is intact; b2's rolled-back attempt left nothing extra.
    const loaded = await b1.ctx.sessionPersistence.load(m.id)
    expect(loaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    await b1.dispose()
    await b2.dispose()
  })

  it('journalMode config reaches the database (default wal, rollback modes selectable)', async () => {
    // :memory: databases always report journal_mode=memory, so probe file DBs.
    const walPath = await freshDbPath()
    const bWal = await backend(walPath)
    await bWal.ctx.sessionPersistence.create(meta('jm-wal'))
    expect((openDatabase(walPath, 'wal').prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
    await bWal.dispose()

    const deletePath = await freshDbPath()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { path: deletePath, journalMode: 'delete' })
    await ctx.sessionPersistence.create(meta('jm-delete'))
    // Probe through a second connection: journal_mode=delete is a per-database
    // property only insofar as no WAL files exist — assert the world, not the
    // backend's self-report (no -wal sidecar after writes in delete mode).
    const db = openDatabase(deletePath, 'delete')
    expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('delete')
    db.close()
    expect(existsSync(`${deletePath}-wal`)).toBe(false)
    await fiber.dispose()
  })

  it('HMR: a DIFFERENT session colliding with a materialized on-disk id is rejected', async () => {
    const path = await freshDbPath()
    // Instance 1 materializes a session and disposes.
    const b1 = await backend(path)
    const s1 = b1.ctx.sessions.create(SessionId('hmr-collide'))
    appendLog(s1, oneTurnLog())
    await b1.ctx.parallel('session/flush', s1)
    await b1.dispose()

    // A fresh context with an UNRELATED live session reusing the id meets a
    // materialized row that is NOT a prefix of its events → reject.
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    let session!: Session
    await ctx.plugin(Object.assign((inner: Context) => {
      session = inner.sessions.create(SessionId('hmr-collide'))
    }, { inject: ['sessions'] }))
    session.append('turn/start', { turn: 9, trigger: { kind: 'message', source: { kind: 'user' } } })
    await ctx.plugin(SessionPersistenceSqlite, { path })
    await expectParallelFlushError(ctx.parallel('session/flush', session), /id collision/)
    await ctx.fiber.dispose()
  })
})

describe('surface field round-trip', () => {
  it('rowToEvent parses surface fields from EventRow columns', () => {
    const row: EventRow = {
      seq: 0, type: 'assistant/message', time: 1,
      data: JSON.stringify({ turn: 1, step: 1, content: [] }),
      source_event_seqs: JSON.stringify([3, 5]),
      surface_op: JSON.stringify('append'),
    }
    const event = rowToEvent(row)
    expect((event as SurfaceEvent).sourceEventSeqs).toEqual([3, 5])
    expect((event as SurfaceEvent).surfaceOp).toBe('append')
  })

  it('rowToEvent handles replace surfaceOp object', () => {
    const row: EventRow = {
      seq: 0, type: 'assistant/message', time: 1,
      data: JSON.stringify({ turn: 1, step: 1, content: [] }),
      source_event_seqs: JSON.stringify([0, 1]),
      surface_op: JSON.stringify({ op: 'replace', start: 0, end: 1 }),
    }
    const event = rowToEvent(row)
    expect((event as SurfaceEvent).sourceEventSeqs).toEqual([0, 1])
    expect((event as SurfaceEvent).surfaceOp).toEqual({ op: 'replace', start: 0, end: 1 })
  })

  it('scanRows with surface columns reconstructs events with surface fields', () => {
    const rows: EventRow[] = [
      { seq: 0, type: 'user/message', time: 1,
        data: JSON.stringify({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }),
        source_event_seqs: null, surface_op: '{"op":"replace","start":0,"end":0}' },
      { seq: 1, type: 'turn/end', time: 2,
        data: JSON.stringify({ turn: 1, reason: { kind: 'completed' } }),
        source_event_seqs: null, surface_op: null },
    ]
    const { preserved } = scanRows(rows)
    expect(preserved).toHaveLength(2)
    expect((preserved[0]! as SurfaceEvent).surfaceOp).toEqual({ op: 'replace', start: 0, end: 0 })
    expect((preserved[0]! as SurfaceEvent).sourceEventSeqs).toBeUndefined()
    expect((preserved[1] as SessionEvent<SurfaceEventType>).surfaceOp).toBeUndefined()
  })

  it('append and load round-trips surface fields through SQLite', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { path: ':memory:' })
    const session = ctx.sessions.create(SessionId('roundtrip-surface'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    session.append('assistant/message', { provenance: { provider: 'mock', model: 'mock' }, turn: 1, step: 1, content: [] }, { surfaceOp: 'append', sourceEventSeqs: [0] })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.parallel('session/flush', session)
    const loaded = await ctx.sessionPersistence.load(SessionId('roundtrip-surface'))
    expect(loaded.events).toHaveLength(4)
    const um = loaded.events[1]!
    expect((um as SurfaceEvent).surfaceOp).toBe('append')
    expect((um as SurfaceEvent).sourceEventSeqs).toBeUndefined()
    const am = loaded.events[2]!
    expect((am as SurfaceEvent).surfaceOp).toBe('append')
    expect((am as SurfaceEvent).sourceEventSeqs).toEqual([0])
    await fiber.dispose()
  })

  it('persists events with surfaceOp but no sourceEventSeqs (covers null branch in surfaceBindings)', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { path: ':memory:' })
    const session = ctx.sessions.create(SessionId('surface-noseq'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('steering/message', { turn: 1, content: [], source: { kind: 'user' } }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.parallel('session/flush', session)
    const loaded = await ctx.sessionPersistence.load(SessionId('surface-noseq'))
    expect((loaded.events[1]! as SurfaceEvent).surfaceOp).toBe('append')
    expect((loaded.events[1]! as SurfaceEvent).sourceEventSeqs).toBeUndefined()
    await fiber.dispose()
  })
})
