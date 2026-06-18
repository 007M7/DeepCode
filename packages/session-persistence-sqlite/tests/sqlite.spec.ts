import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionMeta } from '@deepseek-ai/dsh-session'
import SessionPersistenceSqlite, { SCHEMA_VERSION } from '@deepseek-ai/dsh-session-persistence-sqlite'
import { openDatabase, scanRows, type EventRow } from '../src/schema.ts'
import { runPersistenceContract, meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

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

// The payoff: the SAME backend-agnostic contract the JSONL backend runs, now
// proving the SQLite backend satisfies identical semantics.
runPersistenceContract('sqlite', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(SessionPersistenceSqlite, { path: ':memory:' })
  return {
    persistence: ctx.sessionPersistence,
    dispose: async () => { await fiber.dispose() },
  }
})

describe('scanRows', () => {
  // scanRows works off EventRows (data is a JSON string column); build them from
  // SessionEvents so the unit tests read in terms of the event vocabulary.
  const rows = (events: SessionEvent[]): EventRow[] =>
    events.map(e => ({ seq: e.seq, type: e.type, time: e.time, data: JSON.stringify(e.data) }))

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
      { seq: 0, type: 'turn/start', time: 1, data: '{not json' }, // corrupt, sits before a turn/end
      { seq: 1, type: 'turn/end', time: 2, data: JSON.stringify({ turn: 1, reason: { kind: 'completed' } }) },
    ]
    expect(() => scanRows(withCorruptCommitted)).toThrow(/unparsable committed event/)
  })

  it('tolerates an unparsable torn-tail row after the last turn/end', () => {
    const withCorruptTail: EventRow[] = [
      ...rows(oneTurnLog()),
      { seq: 6, type: 'turn/start', time: 7, data: '{not json' }, // torn fragment, no committed turn/end after
    ]
    const { preserved, tornFrom } = scanRows(withCorruptTail)
    expect(preserved).toEqual(oneTurnLog())
    expect(tornFrom).toBe(6)
  })
})

describe('SessionPersistenceSqlite: HMR adoption', () => {
  it('does not crash-repair an active open turn as interrupted', async () => {
    const path = await freshDbPath()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const first = await ctx.plugin(SessionPersistenceSqlite, { path })
    const session = ctx.sessions.create('hmr-open', { meta: { cwd: '/hmr' } })
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    await ctx.parallel('session/flush', session)

    await first.dispose()
    const db = openDatabase(path)
    db.prepare('INSERT INTO events (session_id, seq, type, time, data) VALUES (?, ?, ?, ?, ?)')
      .run('hmr-open', 2, 'step/end', 2, '{"torn":')
    db.close()
    const second = await ctx.plugin(SessionPersistenceSqlite, { path })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.parallel('session/flush', session)

    const loaded = await ctx.sessionPersistence.load(SessionId('hmr-open'))
    expect(loaded.events.map(e => e.type)).toEqual(['turn/start', 'step/start', 'step/end', 'turn/end'])
    expect(loaded.events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await second.dispose()
    await ctx.fiber.dispose()
  })
})

describe('SessionPersistenceSqlite: durability and crash semantics', () => {
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
    const db = openDatabase(path)
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
    const probe = openDatabase(path)
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
    expect(await b1.ctx.sessionPersistence.has(m.id)).toBe(true) // materialized
    await b1.dispose()

    // A fresh backend loads it: the interrupted (only) turn's real events are
    // preserved and closed with a synthetic turn/end {interrupted} — NOT
    // truncated. The session was materialized, so has()/list() report it present.
    const b2 = await backend(path)
    const loaded = await b2.ctx.sessionPersistence.load(m.id)
    expect(loaded.events.map(e => e.type)).toEqual(['turn/start', 'user/message', 'turn/end'])
    expect(loaded.events.at(-1)!.type === 'turn/end' && loaded.events.at(-1)!.data).toMatchObject({ reason: { kind: 'interrupted' } })
    expect(await b2.ctx.sessionPersistence.has(m.id)).toBe(true)
    expect((await b2.ctx.sessionPersistence.list()).map(x => x.id)).toContain(m.id)
    await b2.dispose()
  })

  it('rejects opening a database whose schema version is newer than this build', async () => {
    const path = await freshDbPath()
    openDatabase(path).close() // stamp user_version = SCHEMA_VERSION
    // Bump user_version past what this build supports.
    const db = openDatabase(path)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    db.close()
    expect(() => openDatabase(path)).toThrow(/newer than this build/)
  })

  it('append snapshots the batch: mutating an event after the call does not corrupt the persisted copy', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { path: ':memory:' })
    const m = meta('snapshot')
    await ctx.sessionPersistence.create(m)
    const batch: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'user/message', seq: 1, time: 2, data: { content: [{ type: 'text', text: 'original' }], source: { kind: 'user' } } },
      { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const p = ctx.sessionPersistence.append(m.id, batch)
    // Mutate the live array AND an event's data AFTER the call but before it
    // drains behind the per-session chain. The snapshot taken at call time must
    // shield the persisted copy.
    ;(batch[1]!.data as { content: { type: 'text'; text: string }[] }).content[0]!.text = 'HACKED'
    batch.push({ type: 'user/message', seq: 3, time: 4, data: { content: [{ type: 'text', text: 'injected' }], source: { kind: 'user' } } })
    await p
    const loaded = await ctx.sessionPersistence.load(m.id)
    expect(loaded.events).toHaveLength(3) // the pushed event was not persisted
    const um = loaded.events[1]
    expect(um?.type === 'user/message' && (um.data.content[0] as { text: string }).text).toBe('original')
    await fiber.dispose()
  })

  it('a corrupt-JSON row in the uncommitted tail is discarded on load, not unloadable', async () => {
    const path = await freshDbPath()
    const m = meta('corrupt-tail')
    const b1 = await backend(path)
    await b1.ctx.sessionPersistence.create(m)
    await b1.ctx.sessionPersistence.append(m.id, oneTurnLog()) // committed: seqs 0..5
    await b1.dispose()

    // Hand-insert a torn tail row (seq 6, no closing turn/end) whose `data` is
    // invalid JSON. The contract: only a parse error in the COMMITTED region is
    // unloadable; a torn tail must be discarded. scanRows finds the last
    // turn/end on the seq+type columns (never parsing tail `data`), so the
    // unparsable row after it bounds the preserved prefix and is deleted by load.
    const db = openDatabase(path)
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
    await ctx1.sessionPersistence.update(m.id, { title: 'T', firstPrompt: 'hi' })
    await fiber1.dispose()

    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    const fiber2 = await ctx2.plugin(SessionPersistenceSqlite, { path })
    expect((await ctx2.sessionPersistence.list()).map(x => x.id)).toContain(m.id)
    const loaded = await ctx2.sessionPersistence.load(m.id)
    expect(loaded.meta).toMatchObject({ id: m.id, cwd: '/proj', title: 'T', firstPrompt: 'hi' })
    expect(loaded.events).toEqual(oneTurnLog())
    await fiber2.dispose()
  })

  it('rejects an unknown format version on load', async () => {
    const path = await freshDbPath()
    // Materialize a row with version 2 directly via the real schema.
    const db = openDatabase(path)
    db.prepare('INSERT INTO sessions (id, version, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('v2', 2, 1, 1)
    db.close()

    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { path })
    await expect(ctx.sessionPersistence.load(SessionId('v2'))).rejects.toThrow(/version 2/)
    await fiber.dispose()
  })

  it('create rejects a duplicate id (in memory and on a persisted row)', async () => {
    const path = await freshDbPath()
    const m = meta('dup')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { path })
    await ctx.sessionPersistence.create(m)
    // Same in-memory state.
    await expect(ctx.sessionPersistence.create(m)).rejects.toThrow(/already exists/)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    await fiber.dispose()

    // A fresh instance over the same file sees the persisted row.
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    const fiber2 = await ctx2.plugin(SessionPersistenceSqlite, { path })
    await expect(ctx2.sessionPersistence.create(m)).rejects.toThrow(/already has a persisted row/)
    await fiber2.dispose()
  })

  it('exposes the schema version constant', () => {
    expect(SCHEMA_VERSION).toBe(1)
  })
})

describe('SessionPersistenceSqlite: write path (session/event → flush)', () => {
  function send(session: Session, events: SessionEvent[]): void {
    for (const e of events) session.append(e.type, e.data)
  }

  it('persists a turn appended through the live session on flush', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { path: ':memory:' })
    const session = ctx.sessions.create('w1')
    send(session, oneTurnLog())
    await ctx.parallel('session/flush', session)
    const loaded = await ctx.sessionPersistence.load(SessionId('w1'))
    expect(loaded.events.map(e => e.type)).toEqual(oneTurnLog().map(e => e.type))
    await fiber.dispose()
  })

  it('a resumed session does not re-append its seed', async () => {
    const path = await freshDbPath()
    // Run 1: persist a full turn through the live session.
    const ctx1 = new Context()
    await ctx1.plugin(SessionStore)
    const fiber1 = await ctx1.plugin(SessionPersistenceSqlite, { path })
    const s1 = ctx1.sessions.create('resume')
    for (const e of oneTurnLog()) s1.append(e.type, e.data)
    await ctx1.parallel('session/flush', s1)
    await fiber1.dispose()

    // Run 2: reconstruct the live session from the loaded log (seed), then add a
    // second turn. The seed must NOT be re-appended (no UNIQUE collision), and
    // the second turn continues the seq.
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    const fiber2 = await ctx2.plugin(SessionPersistenceSqlite, { path })
    const { events } = await ctx2.sessionPersistence.load(SessionId('resume'))
    const s2 = ctx2.sessions.create('resume', { seed: events })
    s2.append('turn/start', { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } })
    s2.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await ctx2.parallel('session/flush', s2)
    const reloaded = await ctx2.sessionPersistence.load(SessionId('resume'))
    expect(reloaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    await fiber2.dispose()
  })

  it('HMR: applying the plugin seeds existing live sessions', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create('hmr')
    for (const e of oneTurnLog()) session.append(e.type, e.data)
    // Plugin applied AFTER the session already has events.
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { path: ':memory:' })
    await ctx.parallel('session/flush', session)
    expect(await ctx.sessionPersistence.has(SessionId('hmr'))).toBe(true)
    await fiber.dispose()
  })

  it('dispose drains a pending buffer before closing the database', async () => {
    const path = await freshDbPath()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { path })
    const session = ctx.sessions.create('drain')
    for (const e of oneTurnLog()) session.append(e.type, e.data)
    // No explicit flush — dispose must drain the buffer.
    await fiber.dispose()

    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    const fiber2 = await ctx2.plugin(SessionPersistenceSqlite, { path })
    expect(await ctx2.sessionPersistence.has(SessionId('drain'))).toBe(true)
    await fiber2.dispose()
  })

  it('rejects a different live session colliding on a persisted id', async () => {
    const path = await freshDbPath()
    const ctx1 = new Context()
    await ctx1.plugin(SessionStore)
    const fiber1 = await ctx1.plugin(SessionPersistenceSqlite, { path })
    const s1 = ctx1.sessions.create('collide')
    for (const e of oneTurnLog()) s1.append(e.type, e.data)
    await ctx1.parallel('session/flush', s1)
    await fiber1.dispose()

    // A fresh, unrelated session reusing the id (no seed) must be rejected.
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    const fiber2 = await ctx2.plugin(SessionPersistenceSqlite, { path })
    const s2 = ctx2.sessions.create('collide')
    s2.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    await expect(ctx2.parallel('session/flush', s2)).rejects.toThrow(/id collision/)
    await fiber2.dispose()
  })

  it('update before the first append keeps the summary in memory and the session lazy', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { path: ':memory:' })
    const m = meta('lazy-update')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.update(m.id, { title: 'pending' })
    // Still lazy: no materialized row yet.
    expect(await ctx.sessionPersistence.has(m.id)).toBe(false)
    // The first append materializes and carries the pending title.
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    const loaded = await ctx.sessionPersistence.load(m.id)
    expect(loaded.meta.title).toBe('pending')
    await fiber.dispose()
  })
})

describe('SessionPersistenceSqlite: edge cases', () => {
  it('append of an empty batch is a no-op', async () => {
    const { ctx, dispose } = await backend()
    const m = meta('empty-batch')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, [])
    expect(await ctx.sessionPersistence.has(m.id)).toBe(false) // still lazy
    await dispose()
  })

  it('load rejects a missing session', async () => {
    const { ctx, dispose } = await backend()
    await expect(ctx.sessionPersistence.load(SessionId('nope'))).rejects.toThrow(/not found/)
    await dispose()
  })

  it('delete of a non-existent session is a no-op', async () => {
    const { ctx, dispose } = await backend()
    await ctx.sessionPersistence.delete(SessionId('ghost'))
    expect(await ctx.sessionPersistence.has(SessionId('ghost'))).toBe(false)
    await dispose()
  })

  it('append adopts a session that exists only in the DB (fresh instance)', async () => {
    const path = await freshDbPath()
    const m = meta('adopt-append')
    const b1 = await backend(path)
    await b1.ctx.sessionPersistence.create(m)
    await b1.ctx.sessionPersistence.append(m.id, oneTurnLog())
    await b1.dispose()

    // A fresh instance appends a second turn WITHOUT a prior create/load: append
    // must adopt the on-disk row (cursor = stored length) and continue the seq.
    const b2 = await backend(path)
    await b2.ctx.sessionPersistence.append(m.id, [
      { type: 'turn/start', seq: 6, time: 7, data: { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'turn/end', seq: 7, time: 8, data: { turn: 2, reason: { kind: 'completed' } } },
    ])
    const loaded = await b2.ctx.sessionPersistence.load(m.id)
    expect(loaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    await b2.dispose()
  })

  it('update adopts a session that exists only in the DB (fresh instance)', async () => {
    const path = await freshDbPath()
    const m = meta('adopt-update')
    const b1 = await backend(path)
    await b1.ctx.sessionPersistence.create(m)
    await b1.ctx.sessionPersistence.append(m.id, oneTurnLog())
    await b1.dispose()

    const b2 = await backend(path)
    await b2.ctx.sessionPersistence.update(m.id, { title: 'after restart' })
    const loaded = await b2.ctx.sessionPersistence.load(m.id)
    expect(loaded.meta.title).toBe('after restart')
    await b2.dispose()
  })

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

  it('round-trips a header with parentSession (fork lineage)', async () => {
    const { ctx, dispose } = await backend()
    const m: SessionMeta = { ...meta('child'), parentSession: SessionId('parent') }
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    const loaded = await ctx.sessionPersistence.load(m.id)
    expect(loaded.meta.parentSession).toBe(SessionId('parent'))
    await dispose()
  })

  it('a fresh live session reusing a previously-loaded id is rejected (ownerless guard)', async () => {
    const path = await freshDbPath()
    const m = meta('ownerless')
    const b1 = await backend(path)
    await b1.ctx.sessionPersistence.create(m)
    await b1.ctx.sessionPersistence.append(m.id, oneTurnLog())
    await b1.dispose()

    const b2 = await backend(path)
    // load() leaves ownerless state with cursor 6.
    await b2.ctx.sessionPersistence.load(m.id)
    // A fresh, unrelated live session reusing the id has a shorter/non-matching
    // seed → its onCreated must reject rather than graft onto the loaded prefix.
    const s = b2.ctx.sessions.create('ownerless')
    s.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    await expect(b2.ctx.parallel('session/flush', s)).rejects.toThrow(/id collision/)
    await b2.dispose()
  })

  it('a live session whose seed matches the loaded prefix claims ownerless state and persists the suffix', async () => {
    const path = await freshDbPath()
    const m = meta('claim')
    const b1 = await backend(path)
    await b1.ctx.sessionPersistence.create(m)
    await b1.ctx.sessionPersistence.append(m.id, oneTurnLog())
    await b1.dispose()

    const b2 = await backend(path)
    const { events } = await b2.ctx.sessionPersistence.load(m.id) // ownerless, cursor 6
    // A live session seeded with the loaded log PLUS a new turn claims the state
    // and persists only the suffix.
    const s = b2.ctx.sessions.create('claim', { seed: [
      ...events,
      { type: 'turn/start', seq: 6, time: 7, data: { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'turn/end', seq: 7, time: 8, data: { turn: 2, reason: { kind: 'completed' } } },
    ] })
    await b2.ctx.parallel('session/flush', s)
    const loaded = await b2.ctx.sessionPersistence.load(m.id)
    expect(loaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    await b2.dispose()
  })

  it('an abandoned lazy session (never materialized) releases its id for reuse', async () => {
    const { ctx, dispose } = await backend()
    const inits = (ctx.sessionPersistence as unknown as { inits: Map<Session, Promise<void>> }).inits
    let first!: Session
    const firstFiber = await ctx.plugin(Object.assign((inner: Context) => {
      first = inner.sessions.create('reuse')
    }, { inject: ['sessions'] }))
    await inits.get(first) // let the lazy create register the state
    await firstFiber.dispose() // disposed before any append → never materialized

    let reuse!: Session
    await ctx.plugin(Object.assign((inner: Context) => {
      reuse = inner.sessions.create('reuse')
    }, { inject: ['sessions'] }))
    await expect(inits.get(reuse)).resolves.toBeUndefined()
    reuse.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    reuse.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.parallel('session/flush', reuse)
    expect(await ctx.sessionPersistence.has(SessionId('reuse'))).toBe(true)
    await dispose()
  })

  it('does NOT reclaim an id whose abandoned owner still has buffered (unflushed) events', async () => {
    const { ctx, dispose } = await backend()
    const inits = (ctx.sessionPersistence as unknown as { inits: Map<Session, Promise<void>> }).inits
    let first!: Session
    const firstFiber = await ctx.plugin(Object.assign((inner: Context) => {
      first = inner.sessions.create('buffered')
    }, { inject: ['sessions'] }))
    await inits.get(first)
    // Append a turn but do NOT flush — events sit in the write-behind buffer.
    first.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    first.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await firstFiber.dispose() // disposed before flush; not materialized, buffer pending

    let reuse!: Session
    await ctx.plugin(Object.assign((inner: Context) => {
      reuse = inner.sessions.create('buffered')
    }, { inject: ['sessions'] }))
    await expect(inits.get(reuse)).rejects.toThrow(/already bound to a different live session/)
    await dispose()
  })

  it('initFor is idempotent: re-emitting session/created does not re-initialize', async () => {
    const { ctx, dispose } = await backend()
    const session = ctx.sessions.create('idem')
    ctx.emit('session/created', session) // second create event for the same object
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.parallel('session/flush', session)
    expect(await ctx.sessionPersistence.has(SessionId('idem'))).toBe(true)
    await dispose()
  })

  it('a live session claims cursor-0 ownerless state created via the public API and persists its seed', async () => {
    const { ctx, dispose } = await backend()
    // create() registers ownerless state with cursor 0 (no events yet).
    await ctx.sessionPersistence.create(meta('cursor0'))
    // A live session reusing that id, seeded with a turn, claims the ownerless
    // state (cursor 0 trivially matches any seed) and persists the whole seed.
    const s = ctx.sessions.create('cursor0', { seed: [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ] })
    await ctx.parallel('session/flush', s)
    const loaded = await ctx.sessionPersistence.load(SessionId('cursor0'))
    expect(loaded.events.map(e => e.seq)).toEqual([0, 1])
    await dispose()
  })

  it('HMR: reloading the backend adopts a still-live, already-materialized session', async () => {
    const path = await freshDbPath()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    // The session lives in its OWN fiber so it survives the backend reload.
    let session!: Session
    await ctx.plugin(Object.assign((inner: Context) => {
      session = inner.sessions.create('hmr-adopt')
    }, { inject: ['sessions'] }))

    // Backend instance 1 materializes the session on disk.
    const backend1 = await ctx.plugin(SessionPersistenceSqlite, { path })
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.parallel('session/flush', session)

    // Hot-reload: dispose instance 1, plug in instance 2 over the SAME file
    // while the session stays live. Instance 2 has an empty states map but the
    // row is materialized on disk and is a prefix of the live events — it must
    // ADOPT (not reject), and a second turn then persists.
    await backend1.dispose()
    await ctx.plugin(SessionPersistenceSqlite, { path })
    session.append('turn/start', { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await expect(ctx.parallel('session/flush', session)).resolves.not.toThrow()

    const loaded = await ctx.sessionPersistence.load(SessionId('hmr-adopt'))
    expect(loaded.events.filter(e => e.type === 'turn/start')).toHaveLength(2)
    await ctx.fiber.dispose()
  })

  it('HMR: adoption persists the live SUFFIX that was ahead of the on-disk prefix', async () => {
    const path = await freshDbPath()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    let session!: Session
    await ctx.plugin(Object.assign((inner: Context) => {
      session = inner.sessions.create('hmr-suffix')
    }, { inject: ['sessions'] }))

    const backend1 = await ctx.plugin(SessionPersistenceSqlite, { path })
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.parallel('session/flush', session)

    // Append turn 2 to the LIVE session, then dispose instance 1 WITHOUT
    // flushing turn 2: it is now ONLY in the live session's events.
    await backend1.dispose()
    session.append('turn/start', { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

    // Instance 2 adopts the on-disk prefix (turn 1) and MUST persist the live
    // suffix (turn 2) carried in the session's events.
    await ctx.plugin(SessionPersistenceSqlite, { path })
    await ctx.parallel('session/flush', session)
    const loaded = await ctx.sessionPersistence.load(SessionId('hmr-suffix'))
    expect(loaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3])
    expect(loaded.events.filter(e => e.type === 'turn/start')).toHaveLength(2)
    await ctx.fiber.dispose()
  })

  it('HMR: a DIFFERENT session colliding with a materialized on-disk id is rejected', async () => {
    const path = await freshDbPath()
    // Instance 1 materializes a session and disposes.
    const b1 = await backend(path)
    const s1 = b1.ctx.sessions.create('hmr-collide')
    for (const e of oneTurnLog()) s1.append(e.type, e.data)
    await b1.ctx.parallel('session/flush', s1)
    await b1.dispose()

    // A fresh context with an UNRELATED live session reusing the id meets a
    // materialized row that is NOT a prefix of its events → reject.
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    let session!: Session
    await ctx.plugin(Object.assign((inner: Context) => {
      session = inner.sessions.create('hmr-collide')
    }, { inject: ['sessions'] }))
    session.append('turn/start', { turn: 9, trigger: { kind: 'message', source: { kind: 'user' } } })
    await ctx.plugin(SessionPersistenceSqlite, { path })
    await expect(ctx.parallel('session/flush', session)).rejects.toThrow(/id collision/)
    await ctx.fiber.dispose()
  })
})
