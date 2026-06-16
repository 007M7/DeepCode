import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionMeta } from '@deepseek-ai/dsh-session'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { encodeSegment, logPath, scanLog, sessionDir, sidecarPath } from '../src/format.ts'
import { runPersistenceContract, meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

let root: string
const dirs: string[] = []

async function freshRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-jsonl-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

// Run the shared backend contract against the real JSONL backend.
runPersistenceContract('jsonl', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-jsonl-'))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(SessionPersistenceJsonl, { root: dir })
  return {
    persistence: ctx.sessionPersistence,
    dispose: async () => {
      await fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    },
  }
})

describe('SessionPersistenceJsonl: format helpers', () => {
  it('encodeSegment neutralizes traversal, separators, and absolute paths', () => {
    expect(encodeSegment('..')).toBe('~002E~002E')
    expect(encodeSegment('.')).toBe('~002E')
    expect(encodeSegment('a/b')).toBe('a~002Fb')
    expect(encodeSegment('/etc/passwd')).toBe('~002Fetc~002Fpasswd')
    expect(encodeSegment('a\u0000b')).toBe('a~0000b')
    expect(encodeSegment('plain-ID_1.2')).toBe('plain-ID_1.2') // safe chars pass through
    expect(encodeSegment('a~b')).toBe('a~007Eb') // ~ itself is escaped
  })

  it('encodeSegment is injective over UTF-16, incl. lone surrogates', () => {
    // Distinct lone surrogates must NOT collide (Buffer.from would normalize
    // both to U+FFFD; code-unit escaping keeps them distinct).
    const hi = encodeSegment(String.fromCharCode(0xD800))
    const lo = encodeSegment(String.fromCharCode(0xDC00))
    expect(hi).toBe('~D800')
    expect(lo).toBe('~DC00')
    expect(hi).not.toBe(lo)
    // A literal "~002F" input cannot collide with the encoding of "/".
    expect(encodeSegment('~002F')).not.toBe(encodeSegment('/'))
  })

  it('encodeSegment rejects an empty id', () => {
    expect(() => encodeSegment('')).toThrow(/empty/)
  })
})

describe('SessionPersistenceJsonl: durability and crash semantics', () => {
  let ctx: Context
  beforeEach(async () => {
    root = await freshRoot()
    ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPersistenceJsonl, { root })
  })
  afterEach(async () => { await ctx.fiber.dispose() })

  it('lazy materialization: create() writes no file until the first append', async () => {
    const m = meta('lazy', '/work')
    await ctx.sessionPersistence.create(m)
    // nothing on disk yet
    const dir = sessionDir(root, '/work')
    await expect(stat(logPath(root, '/work', m.id))).rejects.toThrow()
    expect(await ctx.sessionPersistence.has(m.id)).toBe(false)

    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    // now materialized
    expect((await stat(logPath(root, '/work', m.id))).isFile()).toBe(true)
    expect(await ctx.sessionPersistence.has(m.id)).toBe(true)
    void dir
  })

  it('round-trip is byte-identical (incl. assistant/chunk verbatim)', async () => {
    const m = meta('chunks')
    const log: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
      { type: 'assistant/chunk', seq: 2, time: 3, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'he' } } },
      { type: 'assistant/chunk', seq: 3, time: 4, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'llo' } } },
      { type: 'assistant/message', seq: 4, time: 5, data: { turn: 1, step: 1, content: [{ type: 'text', text: 'hello' }] } },
      { type: 'step/end', seq: 5, time: 6, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 6, time: 7, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, log)
    const loaded = await ctx.sessionPersistence.load(m.id)
    expect(loaded.events).toEqual(log) // chunks preserved, contiguous seqs
  })

  it('crash recovery: load preserves the interrupted turn and closes it with a synthetic turn/end {interrupted}', async () => {
    const m = meta('crash', '/proj')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog()) // seqs 0..5, turn/end at 5

    // Simulate a crash mid-second-turn: append raw lines that are NOT closed by
    // a turn/end (turn/start + step/start are fully written), plus a final
    // partial line with no newline (a torn fragment never fully flushed).
    const path = logPath(root, '/proj', m.id)
    await writeFile(path, [
      JSON.stringify({ type: 'turn/start', seq: 6, time: 8, data: { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } } }),
      JSON.stringify({ type: 'step/start', seq: 7, time: 9, data: { turn: 2, step: 1 } }),
      '{"type":"assistant/chunk","seq":8,"ti', // truncated partial line (no newline)
    ].join('\n'), { flag: 'a' })

    // load PRESERVES the interrupted turn's real events (turn/start 6, step/start
    // 7) — a turn can be huge, so they must not be truncated — and durably closes
    // the orphaned turn with synthetic step/end (8) + turn/end {interrupted} (9).
    const loaded = await ctx.sessionPersistence.load(m.id)
    expect(loaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    const last = loaded.events.at(-1)!
    expect(last.type === 'turn/end' && last.data.reason).toEqual({ kind: 'interrupted' })
    const stepEnd = loaded.events[8]!
    expect(stepEnd.type).toBe('step/end')
    // the torn seq-8 chunk fragment did not survive
    expect(loaded.events.some(e => e.type === 'assistant/chunk' && e.seq === 8)).toBe(false)

    // The next append continues at seq 10 (the balanced length).
    const turn3 = [
      { type: 'turn/start', seq: 10, time: 11, data: { turn: 3, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'turn/end', seq: 11, time: 12, data: { turn: 3, reason: { kind: 'completed' } } },
    ] as SessionEvent[]
    await ctx.sessionPersistence.append(m.id, turn3)
    const reloaded = await ctx.sessionPersistence.load(m.id)
    expect(reloaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })

  it('committed events are never rewritten: only the crash tail is repaired', async () => {
    const m = meta('append-only')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    const before = await readFile(logPath(root, undefined, m.id), 'utf8')
    const committedPrefix = before // the whole committed log

    // A crash tail then a repair-append.
    await writeFile(logPath(root, undefined, m.id), '\n{"partial', { flag: 'a' })
    await ctx.sessionPersistence.load(m.id)
    await ctx.sessionPersistence.append(m.id, [
      { type: 'turn/start', seq: 6, time: 9, data: { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'turn/end', seq: 7, time: 10, data: { turn: 2, reason: { kind: 'completed' } } },
    ] as SessionEvent[])
    const after = await readFile(logPath(root, undefined, m.id), 'utf8')
    // the committed prefix is byte-for-byte intact at the head of the file
    expect(after.startsWith(committedPrefix)).toBe(true)
  })

  it('a failed appendLines truncates partial bytes so a retry has no seq gap', async () => {
    const m = meta('truncate-retry')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog()) // materialized, seqs 0..5
    const sizeBefore = (await stat(logPath(root, undefined, m.id))).size

    // Force the NEXT fsync (inside appendLines) to fail once, AFTER writeFile
    // has already put bytes on disk — simulating an ENOSPC/fsync error
    // mid-append. The recovery truncate() also fsyncs, so allow that one.
    const handle = await (await import('node:fs/promises')).open(logPath(root, undefined, m.id), 'r')
    const proto = Object.getPrototypeOf(handle) as { sync: () => Promise<void> }
    await handle.close()
    const realSync = proto.sync
    let failed = false
    const spy = vi.spyOn(proto, 'sync').mockImplementation(async function (this: unknown) {
      if (!failed) { failed = true; throw new Error('simulated fsync ENOSPC') }
      return realSync.call(this)
    })

    const turn2 = [
      { type: 'turn/start', seq: 6, time: 9, data: { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'turn/end', seq: 7, time: 10, data: { turn: 2, reason: { kind: 'completed' } } },
    ] as SessionEvent[]
    // The append rejects, but the partial bytes are truncated back: the file is
    // its pre-append size and the cursor is unchanged.
    await expect(ctx.sessionPersistence.append(m.id, turn2)).rejects.toThrow(/ENOSPC/)
    expect((await stat(logPath(root, undefined, m.id))).size).toBe(sizeBefore)
    spy.mockRestore()

    // The retry now succeeds with NO seq gap — the log is contiguous 0..7.
    await ctx.sessionPersistence.append(m.id, turn2)
    const loaded = await ctx.sessionPersistence.load(m.id)
    expect(loaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('append snapshots its batch: mutating the caller array after the call is ignored', async () => {
    const m = meta('snapshot')
    await ctx.sessionPersistence.create(m)
    const events = oneTurnLog() // seqs 0..5
    const p = ctx.sessionPersistence.append(m.id, events)
    // Mutate the caller's array immediately after calling append (before the
    // queued op runs). The backend must persist the snapshot taken at call time,
    // not the mutated array.
    events.push({ type: 'turn/start', seq: 6, time: 99, data: { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } } })
    await p
    const loaded = await ctx.sessionPersistence.load(m.id)
    expect(loaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5]) // not 0..6
  })

  it('append deep-snapshots event objects: mutating an event after the call is ignored', async () => {
    const m = meta('deep-snapshot')
    await ctx.sessionPersistence.create(m)
    const events = oneTurnLog()
    const userMsg = events[1] // the user/message event
    const p = ctx.sessionPersistence.append(m.id, events)
    // Mutate an event OBJECT (not just the array) after calling append. The deep
    // snapshot taken at call time must shield the persisted data.
    if (userMsg?.type === 'user/message') userMsg.data.content = [{ type: 'text', text: 'MUTATED' }]
    await p
    const loaded = await ctx.sessionPersistence.load(m.id)
    const persisted = JSON.stringify(loaded.events)
    expect(persisted).toContain('hi') // original content
    expect(persisted).not.toContain('MUTATED')
  })

  it('load returns a meta copy: mutating it does not corrupt backend pathing', async () => {
    const m = meta('meta-copy', '/proj')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    const loaded = await ctx.sessionPersistence.load(m.id)
    // A consumer mutates the returned meta's cwd. The backend's stored pathing
    // metadata must be unaffected, so a later append still finds the right log.
    loaded.meta.cwd = '/evil'
    await ctx.sessionPersistence.append(m.id, [
      { type: 'turn/start', seq: 6, time: 9, data: { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'turn/end', seq: 7, time: 10, data: { turn: 2, reason: { kind: 'completed' } } },
    ] as SessionEvent[])
    // The append landed in the ORIGINAL /proj log, not beside an /evil path.
    const reloaded = await ctx.sessionPersistence.load(m.id)
    expect(reloaded.meta.cwd).toBe('/proj')
    expect(reloaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('rejects an unknown format version on load', async () => {
    const m = meta('v2')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    // Corrupt the header version on disk.
    const path = logPath(root, undefined, m.id)
    const lines = (await readFile(path, 'utf8')).split('\n')
    const header = JSON.parse(lines[0]!) as { version: number }
    header.version = 2
    lines[0] = JSON.stringify(header)
    await writeFile(path, lines.join('\n'))
    // Fresh backend (no in-memory state) → must reject on load.
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SessionPersistenceJsonl, { root })
    await expect(ctx2.sessionPersistence.load(m.id)).rejects.toThrow(/version/)
    await ctx2.fiber.dispose()
  })

  it('rejects a re-append of an already-stored seq', async () => {
    const m = meta('reappend')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    await expect(ctx.sessionPersistence.append(m.id, oneTurnLog())).rejects.toThrow(/seq mismatch/)
  })

  it('path-traversal session ids are neutralized (no escape from root)', async () => {
    const evil = SessionId('../../etc/pwn')
    const m = { version: 1, id: evil, createdAt: 1, updatedAt: 1 }
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(evil, oneTurnLog())
    // The file lives UNDER root, not at ../../etc.
    const all: string[] = []
    async function walk(dir: string): Promise<void> {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) await walk(p)
        else all.push(p)
      }
    }
    await walk(root)
    expect(all.length).toBeGreaterThan(0)
    expect(all.every(p => p.startsWith(root))).toBe(true)
  })
})

describe('SessionPersistenceJsonl: write path (session/event → flush)', () => {
  it('persists a live session driven through the store, surviving reload', async () => {
    root = await freshRoot()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPersistenceJsonl, { root })

    const session = ctx.sessions.create('live', { meta: { cwd: '/w' } })
    for (const e of oneTurnLog()) session.append(e.type, e.data)
    await ctx.parallel('session/flush', session)

    const loaded = await ctx.sessionPersistence.load(SessionId('live'))
    expect(loaded.events).toHaveLength(6)
    expect(loaded.meta.cwd).toBe('/w')
    await ctx.fiber.dispose()
  })

  it('snapshot-on-buffer: mutating an event after session/event does not corrupt the persisted copy', async () => {
    root = await freshRoot()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPersistenceJsonl, { root })

    const session = ctx.sessions.create('mutate')
    const ev = session.append('user/message', { content: [{ type: 'text', text: 'original' }], source: { kind: 'user' } })
    // Mutate the live event object AFTER it was buffered.
    ;(ev.data as { content: { type: 'text'; text: string }[] }).content[0]!.text = 'HACKED'
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.parallel('session/flush', session)

    const loaded = await ctx.sessionPersistence.load(SessionId('mutate'))
    const first = loaded.events[0]
    expect(first?.type === 'user/message' && (first.data.content[0] as { text: string }).text).toBe('original')
    await ctx.fiber.dispose()
  })

  it('fork: a seeded new session persists its seed once', async () => {
    root = await freshRoot()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPersistenceJsonl, { root })

    const seed = oneTurnLog()
    // A fork: a brand-new id whose seed came from elsewhere.
    const forked = ctx.sessions.create('forked', { seed })
    // onCreated persisted the seed asynchronously; wait a tick.
    await new Promise(r => setTimeout(r, 10))
    const loaded = await ctx.sessionPersistence.load(SessionId('forked'))
    expect(loaded.events).toEqual(seed)
    // A flush with no NEW events must not double-write.
    await ctx.parallel('session/flush', forked)
    const reloaded = await ctx.sessionPersistence.load(SessionId('forked'))
    expect(reloaded.events).toEqual(seed)
    await ctx.fiber.dispose()
  })

  it('concurrent sessions do not cross buffers', async () => {
    root = await freshRoot()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPersistenceJsonl, { root })

    const a = ctx.sessions.create('sa')
    const b = ctx.sessions.create('sb')
    a.append('user/message', { content: [{ type: 'text', text: 'A' }], source: { kind: 'user' } })
    b.append('user/message', { content: [{ type: 'text', text: 'B' }], source: { kind: 'user' } })
    a.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    b.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.parallel('session/flush', a)
    await ctx.parallel('session/flush', b)

    const la = await ctx.sessionPersistence.load(SessionId('sa'))
    const lb = await ctx.sessionPersistence.load(SessionId('sb'))
    expect(JSON.stringify(la.events)).toContain('"A"')
    expect(JSON.stringify(la.events)).not.toContain('"B"')
    expect(JSON.stringify(lb.events)).toContain('"B"')
    expect(JSON.stringify(lb.events)).not.toContain('"A"')
    await ctx.fiber.dispose()
  })

  it('HMR: applying the plugin seeds existing live sessions', async () => {
    root = await freshRoot()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    // A session exists BEFORE the persistence plugin is applied.
    const session = ctx.sessions.create('pre-existing')
    session.append('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await ctx.plugin(SessionPersistenceJsonl, { root })
    // The plugin seeded it on apply; a subsequent flush persists its events.
    await ctx.parallel('session/flush', session)
    const loaded = await ctx.sessionPersistence.load(SessionId('pre-existing'))
    expect(loaded.events.length).toBeGreaterThanOrEqual(2)
    await ctx.fiber.dispose()
  })

  it('HMR: dispose drains remaining buffers', async () => {
    root = await freshRoot()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    let session!: Session
    const fiber = await ctx.plugin(SessionPersistenceJsonl, { root })
    const sessFiber = await ctx.plugin(Object.assign((inner: Context) => {
      session = inner.sessions.create('drain')
    }, { inject: ['sessions'] }))
    session.append('user/message', { content: [{ type: 'text', text: 'buffered' }], source: { kind: 'user' } })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    // No explicit flush — dispose must drain.
    await fiber.dispose()
    await sessFiber.dispose()

    // A fresh backend reads what the disposed one drained.
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SessionPersistenceJsonl, { root })
    const loaded = await ctx2.sessionPersistence.load(SessionId('drain'))
    expect(loaded.events.length).toBeGreaterThanOrEqual(2)
    await ctx2.fiber.dispose()
  })

  it('HMR: reloading the backend adopts a still-live, already-materialized session', async () => {
    root = await freshRoot()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    // The session lives in its OWN fiber so it survives the backend reload.
    let session!: Session
    await ctx.plugin(Object.assign((inner: Context) => {
      session = inner.sessions.create('hmr-adopt')
    }, { inject: ['sessions'] }))

    // Backend instance 1 materializes the session on disk.
    const backend1 = await ctx.plugin(SessionPersistenceJsonl, { root })
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.parallel('session/flush', session)

    // Hot-reload the backend: dispose instance 1, plug in instance 2 over the
    // SAME root while the session stays live. Instance 2 has an empty states
    // map but the log is on disk — it must ADOPT (not reject) so flush keeps
    // working. A second turn appended after reload then persists.
    await backend1.dispose()
    await ctx.plugin(SessionPersistenceJsonl, { root })
    session.append('turn/start', { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('user/message', { content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await expect(ctx.parallel('session/flush', session)).resolves.not.toThrow()

    const loaded = await ctx.sessionPersistence.load(SessionId('hmr-adopt'))
    expect(loaded.events.filter(e => e.type === 'turn/start')).toHaveLength(2)
    await ctx.fiber.dispose()
  })

  it('HMR: adoption persists the live SUFFIX that was ahead of the on-disk prefix', async () => {
    root = await freshRoot()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    let session!: Session
    await ctx.plugin(Object.assign((inner: Context) => {
      session = inner.sessions.create('hmr-suffix')
    }, { inject: ['sessions'] }))

    // Instance 1 flushes turn 1 to disk.
    const backend1 = await ctx.plugin(SessionPersistenceJsonl, { root })
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.parallel('session/flush', session)

    // Append turn 2 to the LIVE session, then dispose instance 1 WITHOUT
    // flushing turn 2. Turn 2 is now ONLY in the live session's events; the new
    // backend never buffered it via session/event.
    await backend1.dispose()
    session.append('turn/start', { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

    // Instance 2 adopts the on-disk prefix (turn 1) and MUST also persist the
    // live suffix (turn 2) carried in the session's events — otherwise turn 2 is
    // lost and a later flush would mismatch.
    await ctx.plugin(SessionPersistenceJsonl, { root })
    await ctx.parallel('session/flush', session)
    const loaded = await ctx.sessionPersistence.load(SessionId('hmr-suffix'))
    expect(loaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3])
    expect(loaded.events.filter(e => e.type === 'turn/start')).toHaveLength(2)
    await ctx.fiber.dispose()
  })
})


describe('SessionPersistenceJsonl: scanLog unit', () => {
  it('rejects a header-less / empty log', () => {
    expect(() => scanLog(Buffer.from(''))).toThrow()
  })

  it('rejects a corrupt header line', () => {
    expect(() => scanLog(Buffer.from('not json\n'))).toThrow(/header/)
  })

  it('rejects a non-session first line', () => {
    expect(() => scanLog(Buffer.from('{"type":"event"}\n'))).toThrow(/session header/)
  })

  it('a seq gap after the last turn/end bounds the preserved tail (torn fragment tolerated)', () => {
    const log = [
      JSON.stringify({ type: 'session', version: 1, id: 'g', createdAt: 1 }),
      JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } }),
      JSON.stringify({ type: 'step/start', seq: 2, time: 2, data: { turn: 1, step: 1 } }), // gap: missing seq 1
    ].join('\n') + '\n'
    // No committed turn/end, so the gap is a tolerated crash boundary: scanLog
    // PRESERVES the contiguous prefix (turn/start seq 0) — real interrupted-turn
    // work, not discarded — and stops at the gap. The orphaned open turn is
    // closed by loadCore's synthetic turn/end, not here.
    expect(scanLog(Buffer.from(log)).events.map(e => e.seq)).toEqual([0])
  })

  it('rejects a seq gap BEFORE a later committed turn/end (committed data damaged)', () => {
    const log = [
      JSON.stringify({ type: 'session', version: 1, id: 'g2', createdAt: 1 }),
      JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } }),
      JSON.stringify({ type: 'step/start', seq: 2, time: 2, data: { turn: 1, step: 1 } }), // gap: missing seq 1
      JSON.stringify({ type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: { kind: 'completed' } } }),
    ].join('\n') + '\n'
    // A turn/end exists, so the prefix up to it is committed — but it has a hole.
    // Truncating it would silently drop committed data → unloadable.
    expect(() => scanLog(Buffer.from(log))).toThrow(/seq gap in committed region/)
  })

  it('rejects a corrupt line BEFORE a later committed turn/end (committed data damaged)', () => {
    const log = [
      JSON.stringify({ type: 'session', version: 1, id: 'c', createdAt: 1 }),
      '{not json', // corrupt, sits in the committed region (a turn/end follows)
      JSON.stringify({ type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } }),
    ].join('\n') + '\n'
    expect(() => scanLog(Buffer.from(log))).toThrow(/unparsable committed event/)
  })

  it('a header-only log (no event lines at all) preserves nothing — committedBytes is the header', () => {
    const log = JSON.stringify({ type: 'session', version: 1, id: 'h0', createdAt: 1 }) + '\n'
    const scanned = scanLog(Buffer.from(log))
    expect(scanned.events).toEqual([])
    // committedBytes falls back to the header line's end (no preserved events).
    expect(scanned.committedBytes).toBe(Buffer.byteLength(log, 'utf8'))
  })

  it('a corrupt line after the last turn/end bounds the preserved tail', () => {
    const log = [
      JSON.stringify({ type: 'session', version: 1, id: 'c2', createdAt: 1 }),
      JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } }),
      '{not json', // corrupt crash fragment, no turn/end committed
    ].join('\n') + '\n'
    // The contiguous prefix (turn/start seq 0) is preserved; the corrupt
    // fragment after it is the tolerated crash boundary.
    expect(scanLog(Buffer.from(log)).events.map(e => e.seq)).toEqual([0])
  })

  it('tolerates a seq gap AFTER a turn/end (uncommitted tail)', () => {
    const log = [
      JSON.stringify({ type: 'session', version: 1, id: 't', createdAt: 1 }),
      JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } }),
      JSON.stringify({ type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } }),
      JSON.stringify({ type: 'step/start', seq: 9, time: 3, data: { turn: 2, step: 1 } }), // gap in uncommitted tail
    ].join('\n') + '\n'
    const { events } = scanLog(Buffer.from(log))
    expect(events.map(e => e.seq)).toEqual([0, 1]) // tail dropped
  })
})

describe('SessionPersistenceJsonl: edge cases', () => {
  let ctx: Context
  beforeEach(async () => {
    root = await freshRoot()
    ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPersistenceJsonl, { root })
  })
  afterEach(async () => { await ctx.fiber.dispose() })

  it('load rejects a missing session', async () => {
    await expect(ctx.sessionPersistence.load(SessionId('nope'))).rejects.toThrow(/not found/)
  })

  it('append of an empty batch is a no-op', async () => {
    const m = meta('empty-batch')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, [])
    expect(await ctx.sessionPersistence.has(m.id)).toBe(false)
  })

  it('append resolves even when the best-effort sidecar write fails (log is the transaction)', async () => {
    const m = meta('sidecar-fail')
    await ctx.sessionPersistence.create(m)
    // Force the sidecar write to reject AFTER the durable log append commits.
    // The append must still resolve and advance the cursor — a failed sidecar
    // is recoverable metadata and must never desync the log (which would let a
    // retry duplicate seqs). This exercises the `.catch()` on touchSummary.
    const backend = ctx.sessionPersistence as unknown as { writeSidecar: (state: unknown) => Promise<void> }
    const original = backend.writeSidecar.bind(backend)
    backend.writeSidecar = () => Promise.reject(new Error('disk full'))
    await expect(ctx.sessionPersistence.append(m.id, oneTurnLog())).resolves.toBeUndefined()
    backend.writeSidecar = original
    // The durable log landed in full despite the sidecar failure.
    const loaded = await ctx.sessionPersistence.load(m.id)
    expect(loaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('append rejects non-JSON-serializable undefined-producing data', async () => {
    const m = meta('undef')
    await ctx.sessionPersistence.create(m)
    // A value whose JSON.stringify yields undefined (a bare function as data).
    const bad = [{ type: 'user/message', seq: 0, time: 1, data: (() => 0) as unknown }] as unknown as SessionEvent[]
    await expect(ctx.sessionPersistence.append(m.id, bad)).rejects.toThrow(/non-JSON-serializable/)
  })

  it('delete of a non-existent session is a no-op', async () => {
    await expect(ctx.sessionPersistence.delete(SessionId('ghost'))).resolves.toBeUndefined()
  })

  it('update adopts a session that exists only on disk', async () => {
    const m = meta('disk-only')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    // A fresh backend has no in-memory state → update must adopt from disk.
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SessionPersistenceJsonl, { root })
    await ctx2.sessionPersistence.update(m.id, { title: 'adopted' })
    const loaded = await ctx2.sessionPersistence.load(m.id)
    expect(loaded.meta.title).toBe('adopted')
    await ctx2.fiber.dispose()
  })

  it('a failed update does not become durable via a later append', async () => {
    const m = meta('update-fail')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    // Force the sidecar write to fail for the update.
    const backend = ctx.sessionPersistence as unknown as { writeSidecar: (meta: unknown) => Promise<void> }
    const original = backend.writeSidecar.bind(backend)
    backend.writeSidecar = () => Promise.reject(new Error('disk full'))
    await expect(ctx.sessionPersistence.update(m.id, { title: 'rejected-title' })).rejects.toThrow(/disk full/)
    backend.writeSidecar = original
    // A later successful append's touchSummary must NOT persist the rejected
    // title (it was never committed to in-memory state).
    await ctx.sessionPersistence.append(m.id, [
      { type: 'turn/start', seq: 6, time: 9, data: { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'turn/end', seq: 7, time: 10, data: { turn: 2, reason: { kind: 'completed' } } },
    ] as SessionEvent[])
    const loaded = await ctx.sessionPersistence.load(m.id)
    expect(loaded.meta.title).toBeUndefined()
  })

  it('delete removes the sidecar of a lazy session that has no log', async () => {
    // update() before the first append() writes a .summary.json sidecar but no
    // .jsonl log (lazy create). delete() must still remove that sidecar.
    const m = meta('lazy-del', '/a')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.update(m.id, { title: 'secret', firstPrompt: 'sensitive' })
    const sidecar = sidecarPath(root, '/a', m.id)
    expect((await stat(sidecar)).isFile()).toBe(true) // sidecar exists, no log
    await expect(stat(logPath(root, '/a', m.id))).rejects.toThrow() // no log
    await ctx.sessionPersistence.delete(m.id)
    await expect(stat(sidecar)).rejects.toThrow() // sidecar gone
  })

  it('delete removes a cwd-bucket sidecar even after a restart loses the in-memory cwd', async () => {
    // A lazy session writes a sidecar under cwd /a (no log). Restart the backend
    // (fresh instance, empty state) and delete: the in-memory cwd is gone and
    // there is no log to recover it from, so delete must scan every bucket for
    // the sidecar rather than only the _no-cwd bucket.
    await ctx.sessionPersistence.create(meta('restart-del', '/a'))
    await ctx.sessionPersistence.update(SessionId('restart-del'), { title: 'secret' })
    const sidecar = sidecarPath(root, '/a', SessionId('restart-del'))
    expect((await stat(sidecar)).isFile()).toBe(true)

    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SessionPersistenceJsonl, { root })
    await ctx2.sessionPersistence.delete(SessionId('restart-del'))
    await expect(stat(sidecar)).rejects.toThrow() // sidecar gone despite no in-memory cwd
    await ctx2.fiber.dispose()
  })

  it('an abandoned lazy session (never materialized) releases its id for reuse', async () => {
    // A live session is created then disposed BEFORE its first append: cursor 0,
    // never materialized, nothing on disk. A new live session reusing the id
    // must reclaim it (lazy materialization promises no lingering artifact),
    // not wedge on an "already bound" collision until restart.
    const backend = ctx.sessionPersistence as unknown as { inits: Map<Session, Promise<void>> }
    let firstSession!: Session
    const firstFiber = await ctx.plugin(Object.assign((inner: Context) => {
      firstSession = inner.sessions.create('abandoned', { meta: { cwd: '/a' } })
    }, { inject: ['sessions'] }))
    await backend.inits.get(firstSession) // let the lazy create register the state
    await firstFiber.dispose() // disposed before any append → never materialized

    let reuse!: Session
    await ctx.plugin(Object.assign((inner: Context) => {
      reuse = inner.sessions.create('abandoned', { meta: { cwd: '/a' } })
    }, { inject: ['sessions'] }))
    // The new session claims the id without error and can persist a turn.
    await expect(backend.inits.get(reuse)).resolves.toBeUndefined()
    reuse.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    reuse.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.parallel('session/flush', reuse)
    const loaded = await ctx.sessionPersistence.load(SessionId('abandoned'))
    expect(loaded.events.map(e => e.seq)).toEqual([0, 1])
  })

  it('does NOT reclaim an id whose abandoned owner still has buffered (unflushed) events', async () => {
    // A session that appended events but was disposed BEFORE its first flush is
    // not materialized yet but still holds a write-behind buffer. Reusing the id
    // must be rejected (not reclaimed), or the stale buffer would drain against
    // the new session — persisting old events under the new id or dropping the
    // new session's seq-0 events.
    const backend = ctx.sessionPersistence as unknown as { inits: Map<Session, Promise<void>> }
    let first!: Session
    const firstFiber = await ctx.plugin(Object.assign((inner: Context) => {
      first = inner.sessions.create('buffered', { meta: { cwd: '/a' } })
    }, { inject: ['sessions'] }))
    await backend.inits.get(first)
    // Append a turn but do NOT flush — events sit in the write-behind buffer.
    first.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    first.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await firstFiber.dispose() // disposed before flush; not materialized, buffer pending

    let reuse!: Session
    await ctx.plugin(Object.assign((inner: Context) => {
      reuse = inner.sessions.create('buffered', { meta: { cwd: '/a' } })
    }, { inject: ['sessions'] }))
    await expect(backend.inits.get(reuse)).rejects.toThrow(/already bound to a different live session/)
  })

  it('create snapshots its meta: mutating the caller object after the call is ignored', async () => {
    const m = meta('create-snap', '/orig')
    const p = ctx.sessionPersistence.create(m)
    // Mutate the caller's meta object immediately after calling create.
    m.cwd = '/mutated'
    await p
    await ctx.sessionPersistence.append(SessionId('create-snap'), oneTurnLog())
    // The log materialized under the ORIGINAL cwd, not the mutated one.
    expect((await stat(logPath(root, '/orig', SessionId('create-snap')))).isFile()).toBe(true)
    await expect(stat(logPath(root, '/mutated', SessionId('create-snap')))).rejects.toThrow()
  })

  it('list discovers sessions across multiple cwd buckets', async () => {
    await ctx.sessionPersistence.create(meta('p1', '/projA'))
    await ctx.sessionPersistence.append(SessionId('p1'), oneTurnLog())
    await ctx.sessionPersistence.create(meta('p2', '/projB'))
    await ctx.sessionPersistence.append(SessionId('p2'), oneTurnLog())
    await ctx.sessionPersistence.create(meta('p3')) // no cwd → _no-cwd bucket
    await ctx.sessionPersistence.append(SessionId('p3'), oneTurnLog())

    const ids = (await ctx.sessionPersistence.list()).map(x => x.id).sort()
    expect(ids).toEqual(['p1', 'p2', 'p3'])
  })

  it('list on an empty root returns nothing', async () => {
    expect(await ctx.sessionPersistence.list()).toEqual([])
  })

  it('list skips empty and non-header .jsonl files (metadata-only read)', async () => {
    // A real session…
    await ctx.sessionPersistence.create(meta('real', '/p'))
    await ctx.sessionPersistence.append(SessionId('real'), oneTurnLog())
    // …alongside two junk files in the _no-cwd bucket: an EMPTY file (readFirstLine
    // returns undefined) and a file whose first line is not a session header
    // (parseHeaderMeta returns undefined). Both are skipped, not listed.
    const bucket = join(root, '_no-cwd')
    await mkdir(bucket, { recursive: true })
    await writeFile(join(bucket, 'empty.jsonl'), '')
    await writeFile(join(bucket, 'notheader.jsonl'), '{"type":"turn/start"}\n')
    await writeFile(join(bucket, 'badjson.jsonl'), 'not json at all\n')

    const ids = (await ctx.sessionPersistence.list()).map(x => x.id).sort()
    expect(ids).toEqual(['real'])
  })

  it('list reads a header line longer than the 8KB read chunk', async () => {
    // readFirstLine accumulates across reads when the first line exceeds its
    // buffer. Plant a valid header whose line is > 8192 bytes (a long extra
    // field is tolerated by the header type guard) and confirm list() reads it.
    const bucket = join(root, '_no-cwd')
    await mkdir(bucket, { recursive: true })
    const bigHeader = JSON.stringify({ type: 'session', version: 1, id: 'big', createdAt: 1, pad: 'x'.repeat(9000) })
    await writeFile(join(bucket, 'big.jsonl'), bigHeader + '\n')
    const ids = (await ctx.sessionPersistence.list()).map(x => x.id)
    expect(ids).toContain('big')
  })

  it('has() finds a session on disk under an unknown cwd (cross-bucket scan)', async () => {
    const m = meta('scan-me', '/somewhere')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    // A fresh backend with no in-memory state → has() must scan disk buckets.
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SessionPersistenceJsonl, { root })
    expect(await ctx2.sessionPersistence.has(m.id)).toBe(true)
    expect(await ctx2.sessionPersistence.has(SessionId('absent'))).toBe(false)
    await ctx2.fiber.dispose()
  })

  it('resume/adopt: a live session whose id is already on disk continues from the stored length', async () => {
    // First lifecycle: persist a session through the store.
    const s1 = ctx.sessions.create('resumed', { meta: { cwd: '/r' } })
    for (const e of oneTurnLog()) s1.append(e.type, e.data)
    await ctx.parallel('session/flush', s1)

    // Second lifecycle: a NEW backend + a session re-created with the same id
    // and SEEDED with the loaded events (the resume path). onCreated must adopt
    // the on-disk log (not re-persist the seed), and a new turn appends at seq 6.
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SessionPersistenceJsonl, { root })
    const loaded = await ctx2.sessionPersistence.load(SessionId('resumed'))
    const s2 = ctx2.sessions.create('resumed', { seed: loaded.events, meta: { cwd: '/r' } })
    await new Promise(r => setTimeout(r, 10)) // let onCreated adopt
    // Append a fresh turn through the live session.
    s2.append('turn/start', { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } })
    s2.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await ctx2.parallel('session/flush', s2)

    const reloaded = await ctx2.sessionPersistence.load(SessionId('resumed'))
    // 6 original + 2 new, contiguous, no duplicated seed.
    expect(reloaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    await ctx2.fiber.dispose()
  })

  it('a NEW live session whose id collides with an on-disk log is rejected, not silently adopted', async () => {
    // Persist a session on disk.
    const s1 = ctx.sessions.create('collide', { meta: { cwd: '/a' } })
    for (const e of oneTurnLog()) s1.append(e.type, e.data)
    await ctx.parallel('session/flush', s1)
    const before = await readFile(logPath(root, '/a', SessionId('collide')), 'utf8')

    // A FRESH backend + a NEW live session with the same id but NO explicit
    // load/resume. onCreated must NOT adopt-from-disk (resume is explicit); it
    // treats this as a new session and create() rejects because a log already
    // exists on disk. The rejection surfaces via the init promise (flush awaits
    // it); the on-disk committed log is left byte-for-byte intact.
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SessionPersistenceJsonl, { root })
    const backend = ctx2.sessionPersistence as unknown as { inits: Map<Session, Promise<void>> }
    const s2 = ctx2.sessions.create('collide', { meta: { cwd: '/a' } })
    // The init for the new live session rejects (observed via the per-session
    // init map and, in production, via flush which awaits the same promise).
    await expect(backend.inits.get(s2)).rejects.toThrow(/already has a persisted log on disk/)
    // The committed log is untouched (no clobber).
    expect(await readFile(logPath(root, '/a', SessionId('collide')), 'utf8')).toBe(before)
    await ctx2.fiber.dispose()
  })

  it('a DIFFERENT live session object reusing a disposed id gets its own init (no stale cache)', async () => {
    // Session A materializes a log under id "reuse".
    const sessFiberA = await ctx.plugin(Object.assign((inner: Context) => {
      const a = inner.sessions.create('reuse', { meta: { cwd: '/a' } })
      for (const e of oneTurnLog()) a.append(e.type, e.data)
    }, { inject: ['sessions'] }))
    // Drain A, then dispose ITS fiber (the live session A is gone) while the
    // backend stays loaded.
    for (const s of ctx.sessions.list()) await ctx.parallel('session/flush', s)
    await sessFiberA.dispose()

    // A NEW live Session object reuses id "reuse". The init cache is keyed by
    // the Session OBJECT, so this gets its OWN onCreated (not A's stale promise)
    // — which detects the on-disk collision and rejects, rather than silently
    // appending the new session's events onto A's log under a stale cursor.
    const backend = ctx.sessionPersistence as unknown as { inits: Map<Session, Promise<void>> }
    let b!: Session
    await ctx.plugin(Object.assign((inner: Context) => {
      b = inner.sessions.create('reuse', { meta: { cwd: '/a' } })
    }, { inject: ['sessions'] }))
    await expect(backend.inits.get(b)).rejects.toThrow(/already bound to a different live session|already has a persisted log on disk/)
  })

  it('a live session claims cursor-0 ownerless state created via the public API', async () => {
    // create() registers ownerless state with cursor 0 (lazy, nothing persisted
    // yet). A live session with that id then arrives and claims it without a
    // prefix check (cursor 0 matches trivially), persisting its seed.
    await ctx.sessionPersistence.create(meta('lazy-claim', '/a'))
    const backend = ctx.sessionPersistence as unknown as { inits: Map<Session, Promise<void>> }
    let live!: Session
    await ctx.plugin(Object.assign((inner: Context) => {
      live = inner.sessions.create('lazy-claim', { meta: { cwd: '/a' } })
    }, { inject: ['sessions'] }))
    await expect(backend.inits.get(live)).resolves.toBeUndefined()
    live.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    live.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.parallel('session/flush', live)
    const loaded = await ctx.sessionPersistence.load(SessionId('lazy-claim'))
    expect(loaded.events.map(e => e.seq)).toEqual([0, 1])
  })

  it('a fresh session reusing a previously-loaded id is rejected (ownerless guard)', async () => {
    // Materialize a log, then load() it into the backend's state WITHOUT a live
    // session — leaving state.owner undefined and cursor at the persisted length
    // (the public preview path).
    await ctx.sessionPersistence.create(meta('preview', '/a'))
    await ctx.sessionPersistence.append(SessionId('preview'), oneTurnLog())
    await ctx.sessionPersistence.load(SessionId('preview'))

    const backend = ctx.sessionPersistence as unknown as { inits: Map<Session, Promise<void>> }
    // A FRESH (empty-seed) live session reusing that id must be rejected: its
    // seq 0..cursor-1 events would otherwise be filtered as already-persisted
    // and its conversation grafted onto the old log.
    let fresh!: Session
    await ctx.plugin(Object.assign((inner: Context) => {
      fresh = inner.sessions.create('preview', { meta: { cwd: '/a' } })
    }, { inject: ['sessions'] }))
    await expect(backend.inits.get(fresh)).rejects.toThrow(/do not match this live session|already has a persisted log/)
  })

  it('a session whose seed matches the loaded prefix claims ownerless state', async () => {
    // Materialize a log and load it (ownerless state, cursor = 6).
    await ctx.sessionPersistence.create(meta('match', '/a'))
    await ctx.sessionPersistence.append(SessionId('match'), oneTurnLog())
    await ctx.sessionPersistence.load(SessionId('match'))

    const backend = ctx.sessionPersistence as unknown as { inits: Map<Session, Promise<void>> }
    // A live session SEEDED with the persisted log legitimately continues it —
    // its seed reproduces the loaded prefix, so it claims the ownerless state.
    let cont!: Session
    await ctx.plugin(Object.assign((inner: Context) => {
      cont = inner.sessions.create('match', { seed: oneTurnLog(), meta: { cwd: '/a' } })
    }, { inject: ['sessions'] }))
    await expect(backend.inits.get(cont)).resolves.toBeUndefined()
  })

  it('claiming ownerless state persists the seed suffix beyond the prefix', async () => {
    // Materialize a one-turn log and load it (ownerless state, cursor = 6).
    await ctx.sessionPersistence.create(meta('suffix-claim', '/a'))
    await ctx.sessionPersistence.append(SessionId('suffix-claim'), oneTurnLog())
    await ctx.sessionPersistence.load(SessionId('suffix-claim'))

    const backend = ctx.sessionPersistence as unknown as { inits: Map<Session, Promise<void>> }
    // A live session seeded with the prefix PLUS a second turn (seqs 6,7). The
    // suffix (constructor seed, never emits session/event) must be persisted on
    // claim, not lost.
    const seed = [
      ...oneTurnLog(),
      { type: 'turn/start', seq: 6, time: 7, data: { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'turn/end', seq: 7, time: 8, data: { turn: 2, reason: { kind: 'completed' } } },
    ] as SessionEvent[]
    let cont!: Session
    await ctx.plugin(Object.assign((inner: Context) => {
      cont = inner.sessions.create('suffix-claim', { seed, meta: { cwd: '/a' } })
    }, { inject: ['sessions'] }))
    await backend.inits.get(cont)
    const loaded = await ctx.sessionPersistence.load(SessionId('suffix-claim'))
    expect(loaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('claiming cursor-0 ownerless state persists the whole constructor seed', async () => {
    // create() registers ownerless state with cursor 0 (lazy, nothing on disk).
    await ctx.sessionPersistence.create(meta('lazy-seed', '/a'))
    const backend = ctx.sessionPersistence as unknown as { inits: Map<Session, Promise<void>> }
    // A live session seeded with a full turn claims it; the whole seed (cursor
    // is 0) must be persisted.
    let cont!: Session
    await ctx.plugin(Object.assign((inner: Context) => {
      cont = inner.sessions.create('lazy-seed', { seed: oneTurnLog(), meta: { cwd: '/a' } })
    }, { inject: ['sessions'] }))
    await backend.inits.get(cont)
    const loaded = await ctx.sessionPersistence.load(SessionId('lazy-seed'))
    expect(loaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('a seed with matching seq/type/time but DIFFERENT data is rejected (deep prefix compare)', async () => {
    // Materialize and load (ownerless, cursor = 6).
    await ctx.sessionPersistence.create(meta('divergent', '/a'))
    await ctx.sessionPersistence.append(SessionId('divergent'), oneTurnLog())
    await ctx.sessionPersistence.load(SessionId('divergent'))

    const backend = ctx.sessionPersistence as unknown as { inits: Map<Session, Promise<void>> }
    // A seed that keeps every seq/type/time but mutates a payload must NOT be
    // accepted as "the same session" — otherwise drain filters those seqs as
    // already persisted and the divergent payload is silently lost.
    const tampered = oneTurnLog()
    const userMsg = tampered[1]
    if (userMsg?.type === 'user/message') userMsg.data.content = [{ type: 'text', text: 'DIFFERENT' }]
    let bad!: Session
    await ctx.plugin(Object.assign((inner: Context) => {
      bad = inner.sessions.create('divergent', { seed: tampered, meta: { cwd: '/a' } })
    }, { inject: ['sessions'] }))
    await expect(backend.inits.get(bad)).rejects.toThrow(/do not match this live session|already has a persisted log/)
  })

  it('a second live session reusing a bound id is rejected', async () => {
    // A live session materializes and owns the id.
    const firstFiber = await ctx.plugin(Object.assign((inner: Context) => {
      const a = inner.sessions.create('bound', { meta: { cwd: '/a' } })
      a.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
      a.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    }, { inject: ['sessions'] }))
    for (const s of ctx.sessions.list()) await ctx.parallel('session/flush', s)
    await firstFiber.dispose()

    const backend = ctx.sessionPersistence as unknown as { inits: Map<Session, Promise<void>> }
    let second!: Session
    await ctx.plugin(Object.assign((inner: Context) => {
      second = inner.sessions.create('bound', { meta: { cwd: '/a' } })
    }, { inject: ['sessions'] }))
    await expect(backend.inits.get(second))
      .rejects.toThrow(/already bound to a different live session|already has a persisted log|do not match/)
  })

  it('round-trips a header with parentSession (fork lineage)', async () => {
    const m: SessionMeta = { version: 1, id: SessionId('forked-child'), createdAt: 1, updatedAt: 1, parentSession: SessionId('the-parent') }
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    const loaded = await ctx.sessionPersistence.load(m.id)
    expect(loaded.meta.parentSession).toBe('the-parent')
  })

  it('loads a log that has no sidecar (default summary)', async () => {
    // Hand-write a valid log WITHOUT a sidecar, then load it.
    const dir = sessionDir(root, undefined)
    await (await import('node:fs/promises')).mkdir(dir, { recursive: true })
    const header = JSON.stringify({ type: 'session', version: 1, id: 'no-sidecar', createdAt: 5 })
    const body = oneTurnLog().map(e => JSON.stringify(e)).join('\n')
    await writeFile(logPath(root, undefined, SessionId('no-sidecar')), header + '\n' + body + '\n')
    const loaded = await ctx.sessionPersistence.load(SessionId('no-sidecar'))
    expect(loaded.events).toHaveLength(6)
    expect(loaded.meta.title).toBeUndefined() // no sidecar → no title
    // With no sidecar, updatedAt falls back to the header createdAt (5), NOT 0
    // — reporting an active session as updated at the Unix epoch would be wrong.
    expect(loaded.meta.updatedAt).toBe(5)
  })

  it('list returns nothing when the root directory does not exist', async () => {
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SessionPersistenceJsonl, { root: join(root, 'does-not-exist-yet') })
    expect(await ctx2.sessionPersistence.list()).toEqual([])
    await ctx2.fiber.dispose()
  })

  it('list surfaces a non-ENOENT root error (ENOTDIR) instead of reporting no sessions', async () => {
    // A durable backend must NOT collapse a storage fault to "no sessions". Point
    // the root at a regular FILE: readdir then fails with ENOTDIR, which must
    // propagate rather than be swallowed as an empty listing.
    const filePath = join(root, 'not-a-dir')
    await writeFile(filePath, 'x')
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SessionPersistenceJsonl, { root: filePath })
    await expect(ctx2.sessionPersistence.list()).rejects.toThrow(/ENOTDIR/)
    await ctx2.fiber.dispose()
  })

  it('exists() surfaces a non-ENOENT lookup error (ENOTDIR) instead of reporting absent', async () => {
    // Same contract on the existence path: a non-ENOENT error from the per-id
    // open() must surface, not be collapsed to "not found" (which would let a
    // collision check proceed under a false absence assumption). A LAZY session
    // (created, never appended) keeps its cwd in state, so has() reaches
    // findLog(id, cwd) → exists(logPath). Make that cwd's bucket DIRECTORY a
    // regular file: open()ing `bucket/<id>.jsonl` under it then fails ENOTDIR.
    const cwd = '/x'
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SessionPersistenceJsonl, { root })
    await ctx2.sessionPersistence.create(meta('exists-fault', cwd)) // lazy: no bucket yet
    await writeFile(sessionDir(root, cwd), 'x') // bucket path is now a FILE
    await expect(ctx2.sessionPersistence.has(SessionId('exists-fault'))).rejects.toThrow(/ENOTDIR/)
    await ctx2.fiber.dispose()
  })

  it('append() to a disk-only session adopts it and repairs a crash tail', async () => {
    // Persist a session, then corrupt its tail, all through ONE backend.
    const m = meta('disk-append', '/d')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    await writeFile(logPath(root, '/d', m.id), '\n{"partial crash', { flag: 'a' })

    // A FRESH backend with no in-memory state: append directly (no prior load)
    // → append must adopt from disk, and the adopt's load schedules a repair
    // that the same append then performs before writing.
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SessionPersistenceJsonl, { root })
    await ctx2.sessionPersistence.append(m.id, [
      { type: 'turn/start', seq: 6, time: 9, data: { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'turn/end', seq: 7, time: 10, data: { turn: 2, reason: { kind: 'completed' } } },
    ] as SessionEvent[])
    const loaded = await ctx2.sessionPersistence.load(m.id)
    expect(loaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    await ctx2.fiber.dispose()
  })

  it('a header-only log (open turn, no turn/end) preserves the open turn on load and closes it', async () => {
    // A session whose only durable content is an unclosed first turn. scanLog
    // preserves the turn/start; loadCore closes it with a synthetic
    // turn/end {interrupted} so the returned log is balanced.
    const m = meta('open-turn', '/h')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
    ] as SessionEvent[])
    const { events } = await ctx.sessionPersistence.load(m.id)
    expect(events.map(e => e.type)).toEqual(['turn/start', 'turn/end'])
    const end = events[1]!
    expect(end.type === 'turn/end' && end.data.reason).toEqual({ kind: 'interrupted' })
  })

  it('initFor is idempotent: a re-seeded existing session is not re-initialized', async () => {
    const session = ctx.sessions.create('idem', { meta: { cwd: '/i' } })
    session.append('user/message', { content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.parallel('session/flush', session)
    // Re-emit session/created for the SAME live session (idempotent initFor).
    ctx.emit('session/created', session)
    await ctx.parallel('session/flush', session)
    const loaded = await ctx.sessionPersistence.load(SessionId('idem'))
    expect(loaded.events).toHaveLength(2) // not doubled
  })


  it('flush before init resolves with no state uses cursor 0', async () => {
    // Drive a fork (seed) flush where the buffer holds the seed; the fresh
    // events filter against cursor. Exercises the state-undefined cursor path.
    const session = ctx.sessions.create('flush-nostate')
    // Append directly to the live session and flush IMMEDIATELY, before the
    // async onCreated init has necessarily set state.
    session.append('user/message', { content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.parallel('session/flush', session)
    const loaded = await ctx.sessionPersistence.load(SessionId('flush-nostate'))
    expect(loaded.events).toHaveLength(2)
  })

  it('createCore rejects creating an id this backend already tracks', async () => {
    await ctx.sessionPersistence.create(meta('dup'))
    await expect(ctx.sessionPersistence.create(meta('dup'))).rejects.toThrow(/already exists in this backend/)
  })

  it('createCore rejects creating an id whose log already exists on disk', async () => {
    const m = meta('on-disk', '/od')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    // A fresh backend (no in-memory state) must refuse to create over the log.
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SessionPersistenceJsonl, { root })
    await expect(ctx2.sessionPersistence.create(meta('on-disk', '/od'))).rejects.toThrow(/already has a persisted log on disk/)
    await ctx2.fiber.dispose()
  })

  it('createCore rejects an id already on disk under a DIFFERENT cwd bucket', async () => {
    // Persist the id under cwd A.
    const a = meta('dup-id', '/projA')
    await ctx.sessionPersistence.create(a)
    await ctx.sessionPersistence.append(a.id, oneTurnLog())
    // A fresh backend creating the SAME id under cwd B must still refuse: load/
    // has identify by id across all buckets, so a second log would make resume
    // nondeterministic. create scans every bucket, not just meta.cwd's.
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SessionPersistenceJsonl, { root })
    await expect(ctx2.sessionPersistence.create(meta('dup-id', '/projB')))
      .rejects.toThrow(/already has a persisted log on disk/)
    await ctx2.fiber.dispose()
  })

  it('flush keeps buffered events when the append fails (no silent loss)', async () => {
    root = await freshRoot()
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SessionPersistenceJsonl, { root })
    const session = ctx2.sessions.create('flush-fail')
    // A full turn lands in the write-behind buffer.
    session.append('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    // Make the durable materialize fail on the next flush.
    const backend = ctx2.sessionPersistence as unknown as { materialize: (...args: unknown[]) => Promise<void> }
    const origMat = backend.materialize.bind(backend)
    backend.materialize = () => Promise.reject(new Error('disk full'))
    await expect(ctx2.parallel('session/flush', session)).rejects.toThrow(/disk full/)
    // The events are STILL buffered (not silently dropped): a retry persists them.
    backend.materialize = origMat
    await ctx2.parallel('session/flush', session)
    const loaded = await ctx2.sessionPersistence.load(SessionId('flush-fail'))
    expect(loaded.events.map(e => e.seq)).toEqual([0, 1])
    await ctx2.fiber.dispose()
  })

  it('rejects non-JSON event data: BigInt, function, circular, Map, undefined property', async () => {
    const m = meta('serial')
    await ctx.sessionPersistence.create(m)
    const bad = (extra: unknown) => [{ type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: 'x' }], source: { kind: 'user' }, extra } }] as unknown as SessionEvent[]
    await expect(ctx.sessionPersistence.append(m.id, bad(1n))).rejects.toThrow(/non-JSON-serializable/)
    await expect(ctx.sessionPersistence.append(m.id, bad(() => 0))).rejects.toThrow(/non-JSON-serializable/)
    await expect(ctx.sessionPersistence.append(m.id, bad(Symbol('s')))).rejects.toThrow(/non-JSON-serializable/)
    await expect(ctx.sessionPersistence.append(m.id, bad(new Map()))).rejects.toThrow(/non-JSON-serializable/)
    await expect(ctx.sessionPersistence.append(m.id, bad(undefined))).rejects.toThrow(/non-JSON-serializable/)
    await expect(ctx.sessionPersistence.append(m.id, bad(Infinity))).rejects.toThrow(/non-JSON-serializable/)
    // a circular structure
    const circ: Record<string, unknown> = {}
    circ.self = circ
    await expect(ctx.sessionPersistence.append(m.id, bad(circ))).rejects.toThrow(/non-JSON-serializable/)
    // The session was never materialized by any of the rejected appends.
    expect(await ctx.sessionPersistence.has(m.id)).toBe(false)
  })

  it('accepts well-formed JSON values (null, booleans, nested arrays/objects)', async () => {
    const m = meta('json-ok')
    await ctx.sessionPersistence.create(m)
    const ev = [{ type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: 'x' }], source: { kind: 'user' }, extra: { a: null, b: true, c: [1, 2, { d: 'nested' }] } } }] as unknown as SessionEvent[]
    await ctx.sessionPersistence.append(m.id, ev)
    expect(await ctx.sessionPersistence.has(m.id)).toBe(true)
  })

  it('Session.append rejects a non-serializable event at the source (never enters the log)', () => {
    const session = ctx.sessions.create('reject-bad')
    // Serializability is enforced at the source: Session.append throws on a
    // BigInt-bearing event BEFORE it enters session.events, so the durable log
    // can never diverge from the live log. The throw surfaces at the caller's
    // append site, not asynchronously in a backend flush.
    expect(() => {
      session.append('user/message', { content: [{ type: 'text', text: 'bad' }], source: { kind: 'user' }, bad: 1n } as never)
    }).toThrow(/non-JSON-serializable/)
    // The bad event was rejected, so the log stayed empty.
    expect(session.events.length).toBe(0)
  })

})
