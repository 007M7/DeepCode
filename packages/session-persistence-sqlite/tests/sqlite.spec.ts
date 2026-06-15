import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionMeta } from '@deepseek-ai/dsh-session'
import SessionPersistenceSqlite, { SCHEMA_VERSION } from '@deepseek-ai/dsh-session-persistence-sqlite'
import { cutAtLastTurnEnd, openDatabase } from '../src/schema.ts'
import { runPersistenceContract, meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

async function freshDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sqlite-'))
  dirs.push(dir)
  return join(dir, 'sessions.db')
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

describe('cutAtLastTurnEnd', () => {
  it('returns the prefix through the last complete turn/end and flags a cut tail', () => {
    const log = oneTurnLog()
    const withTail: SessionEvent[] = [
      ...log,
      { type: 'turn/start', seq: 6, time: 7, data: { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'user/message', seq: 7, time: 8, data: { content: [{ type: 'text', text: 'q2' }], source: { kind: 'user' } } },
    ]
    const { committed, cutTail } = cutAtLastTurnEnd(withTail)
    expect(committed).toEqual(log)
    expect(cutTail).toBe(true)
  })

  it('treats a log with no turn/end as fully uncommitted', () => {
    const partial: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'user/message', seq: 1, time: 2, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } },
    ]
    expect(cutAtLastTurnEnd(partial)).toEqual({ committed: [], cutTail: true })
  })

  it('reports no cut when the log ends exactly on a turn/end', () => {
    const { committed, cutTail } = cutAtLastTurnEnd(oneTurnLog())
    expect(committed).toEqual(oneTurnLog())
    expect(cutTail).toBe(false)
  })

  it('an empty log is committed-empty with no tail', () => {
    expect(cutAtLastTurnEnd([])).toEqual({ committed: [], cutTail: false })
  })

  it('throws on a seq gap inside the committed region', () => {
    const gapped: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'step/start', seq: 2, time: 2, data: { turn: 1, step: 1 } }, // seq 1 missing
      { type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    expect(() => cutAtLastTurnEnd(gapped)).toThrow(/seq gap in committed region/)
  })
})

describe('SessionPersistenceSqlite: durability and crash semantics', () => {
  it('a crash tail (rows after the last turn/end) is excluded and deleted on load', async () => {
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
      { type: 'user/message', seq: 7, time: 8, data: { content: [{ type: 'text', text: 'q2' }], source: { kind: 'user' } } },
    ])
    await fiber1.dispose()

    // Run 2: load returns only the committed first turn; the tail is gone.
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    const fiber2 = await ctx2.plugin(SessionPersistenceSqlite, { path })
    const loaded = await ctx2.sessionPersistence.load(m.id)
    expect(loaded.events).toEqual(oneTurnLog())

    // The next append continues at seq 6 (the committed length) and the cut
    // tail was physically deleted, so there is no UNIQUE collision.
    await ctx2.sessionPersistence.append(m.id, [
      { type: 'turn/start', seq: 6, time: 9, data: { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'turn/end', seq: 7, time: 10, data: { turn: 2, reason: { kind: 'completed' } } },
    ])
    const reloaded = await ctx2.sessionPersistence.load(m.id)
    expect(reloaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    await fiber2.dispose()
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
    db.prepare('INSERT INTO sessions (id, version, created_at, updated_at, materialized) VALUES (?, ?, ?, ?, 1)')
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
  async function backend(path = ':memory:'): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { path })
    return { ctx, dispose: () => fiber.dispose() }
  }

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
