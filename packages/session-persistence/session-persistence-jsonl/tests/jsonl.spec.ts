import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { appendFile, mkdtemp, mkdir, rm, readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { encodeSegment, logPath, scanLog, sessionDir } from '../src/format.ts'
import { runPersistenceContract, meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'
import { runCoordinatorContract, type CoordinatorFixture } from '../../session-persistence/tests/coordinator-contract.ts'

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

// Run the shared coordinator orchestration suite against the real JSONL backend.
// One temp root is the shared storage scope (two mounted instances over the same
// root = HMR/reload). `corruptTail` appends a partial, newline-less fragment to
// the session's .jsonl past the committed region — a never-committed torn tail
// that drives the coordinator's commitRepair-with-tornMarker branch over real
// file bytes.
runCoordinatorContract('jsonl', async (): Promise<CoordinatorFixture> => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-jsonl-coord-'))
  return {
    mount: async (ctx) => {
      const fiber = await ctx.plugin(SessionPersistenceJsonl, { root: dir })
      return fiber
    },
    corruptTail: async (id, cwd) => {
      // A half-written record with no trailing newline: scanLog treats it as an
      // uncommitted crash fragment and reports committedBytes < byteLength, so
      // the coordinator sees a tornMarker to truncate.
      await appendFile(logPath(dir, cwd, id), '{"type":"assistant/chunk","seq":8,"ti')
    },
    cleanup: async () => { await rm(dir, { recursive: true, force: true }) },
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
    expect((await ctx.sessionPersistence.list()).map(h => h.id)).not.toContain(m.id)

    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    // now materialized
    expect((await stat(logPath(root, '/work', m.id))).isFile()).toBe(true)
    expect((await ctx.sessionPersistence.list()).map(h => h.id)).toContain(m.id)
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

  it('rejects a re-append of an already-stored seq', async () => {
    const m = meta('reappend')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    await expect(ctx.sessionPersistence.append(m.id, oneTurnLog())).rejects.toThrow(/seq mismatch/)
  })

  it('path-traversal session ids are neutralized (no escape from root)', async () => {
    const evil = SessionId('../../etc/pwn')
    const m = { version: 0, id: evil, createdAt: 1 }
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
  it('concurrent sessions do not cross buffers', async () => {
    root = await freshRoot()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPersistenceJsonl, { root })

    const a = ctx.sessions.create(SessionId('sa'))
    const b = ctx.sessions.create(SessionId('sb'))
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
      JSON.stringify({ type: 'session', version: 0, id: 'g', createdAt: 1 }),
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
      JSON.stringify({ type: 'session', version: 0, id: 'g2', createdAt: 1 }),
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
      JSON.stringify({ type: 'session', version: 0, id: 'c', createdAt: 1 }),
      '{not json', // corrupt, sits in the committed region (a turn/end follows)
      JSON.stringify({ type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } }),
    ].join('\n') + '\n'
    expect(() => scanLog(Buffer.from(log))).toThrow(/unparsable committed event/)
  })

  it('a header-only log (no event lines at all) preserves nothing — committedBytes is the header', () => {
    const log = JSON.stringify({ type: 'session', version: 0, id: 'h0', createdAt: 1 }) + '\n'
    const scanned = scanLog(Buffer.from(log))
    expect(scanned.events).toEqual([])
    // committedBytes falls back to the header line's end (no preserved events).
    expect(scanned.committedBytes).toBe(Buffer.byteLength(log, 'utf8'))
  })

  it('a corrupt line after the last turn/end bounds the preserved tail', () => {
    const log = [
      JSON.stringify({ type: 'session', version: 0, id: 'c2', createdAt: 1 }),
      JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } }),
      '{not json', // corrupt crash fragment, no turn/end committed
    ].join('\n') + '\n'
    // The contiguous prefix (turn/start seq 0) is preserved; the corrupt
    // fragment after it is the tolerated crash boundary.
    expect(scanLog(Buffer.from(log)).events.map(e => e.seq)).toEqual([0])
  })

  it('tolerates a seq gap AFTER a turn/end (uncommitted tail)', () => {
    const log = [
      JSON.stringify({ type: 'session', version: 0, id: 't', createdAt: 1 }),
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

  it('append rejects non-JSON-serializable undefined-producing data', async () => {
    const m = meta('undef')
    await ctx.sessionPersistence.create(m)
    // A value whose JSON.stringify yields undefined (a bare function as data).
    const bad = [{ type: 'user/message', seq: 0, time: 1, data: (() => 0) as unknown }] as unknown as SessionEvent[]
    await expect(ctx.sessionPersistence.append(m.id, bad)).rejects.toThrow(/non-JSON-serializable/)
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
    const bigHeader = JSON.stringify({ type: 'session', version: 0, id: 'big', createdAt: 1, pad: 'x'.repeat(9000) })
    await writeFile(join(bucket, 'big.jsonl'), bigHeader + '\n')
    const ids = (await ctx.sessionPersistence.list()).map(x => x.id)
    expect(ids).toContain('big')
  })

  it('a DIFFERENT live session object reusing a disposed id gets its own init (no stale cache)', async () => {
    // Session A materializes a log under id "reuse".
    const sessFiberA = await ctx.plugin(Object.assign((inner: Context) => {
      const a = inner.sessions.create(SessionId('reuse'), { meta: { cwd: '/a' } })
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
      b = inner.sessions.create(SessionId('reuse'), { meta: { cwd: '/a' } })
    }, { inject: ['sessions'] }))
    await expect(backend.inits.get(b)).rejects.toThrow(/already bound to a different live session|already has a persisted log on disk/)
  })

  it('a NO-CWD live session does NOT cross-cwd-adopt a same-id log from a real cwd bucket (loadLive is scope-exact)', async () => {
    // Backend 1: materialize a log under id "x" in the cwd "/w" bucket, then
    // dispose the WHOLE backend (so backend 2 mounts with an EMPTY states map —
    // the HMR/reload path where onCreated goes through loadLive, not a tracked
    // collision).
    await ctx.sessionPersistence.create(meta('x', '/w'))
    await ctx.sessionPersistence.append(SessionId('x'), oneTurnLog())
    await ctx.fiber.dispose()

    // Backend 2 over the SAME root. A live no-cwd session reuses id "x". Because
    // loadLive(id, undefined) is the DEFINITE no-cwd bucket (NOT an all-buckets
    // scan), case-2 adoption does NOT match the "/w" log — so it would NOT
    // silently graft the no-cwd events onto the "/w" log with a mismatched cwd
    // (the bug a non-scope-exact loadLive caused). It falls through to the
    // new-session path, where createCore's any-cwd collision probe (loadStored)
    // catches the duplicate id and REJECTS — the id is taken in another bucket.
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SessionPersistenceJsonl, { root })
    const backend = ctx2.sessionPersistence as unknown as { inits: Map<Session, Promise<void>> }
    let b!: Session
    await ctx2.plugin(Object.assign((inner: Context) => {
      b = inner.sessions.create(SessionId('x')) // no cwd
    }, { inject: ['sessions'] }))
    await expect(backend.inits.get(b)).rejects.toThrow(/already has a persisted log on disk/)

    // The "/w" log is untouched — no no-cwd events were grafted onto it, and no
    // `_no-cwd` log for "x" was created.
    const inW = scanLog(await readFile(logPath(root, '/w', SessionId('x'))))
    expect(inW.meta.cwd).toBe('/w')
    expect(inW.events).toHaveLength(6)
    await expect(stat(logPath(root, undefined, SessionId('x')))).rejects.toThrow()
    await ctx2.fiber.dispose()
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
      bad = inner.sessions.create(SessionId('divergent'), { seed: tampered, meta: { cwd: '/a' } })
    }, { inject: ['sessions'] }))
    await expect(backend.inits.get(bad)).rejects.toThrow(/do not match this live session|already has a persisted log/)
  })

  it('a second live session reusing a bound id is rejected', async () => {
    // A live session materializes and owns the id.
    const firstFiber = await ctx.plugin(Object.assign((inner: Context) => {
      const a = inner.sessions.create(SessionId('bound'), { meta: { cwd: '/a' } })
      a.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
      a.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    }, { inject: ['sessions'] }))
    for (const s of ctx.sessions.list()) await ctx.parallel('session/flush', s)
    await firstFiber.dispose()

    const backend = ctx.sessionPersistence as unknown as { inits: Map<Session, Promise<void>> }
    let second!: Session
    await ctx.plugin(Object.assign((inner: Context) => {
      second = inner.sessions.create(SessionId('bound'), { meta: { cwd: '/a' } })
    }, { inject: ['sessions'] }))
    await expect(backend.inits.get(second))
      .rejects.toThrow(/already bound to a different live session|already has a persisted log|do not match/)
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

  it('loadLive surfaces a non-ENOENT lookup error (ENOTDIR) instead of reporting absent', async () => {
    // A non-ENOENT error from the per-id open() must surface, not be collapsed to
    // "not found" (which would let live-adoption proceed under a false absence
    // assumption). A live session's onCreated reaches loadLive(id, cwd) →
    // exists(logPath). Make that cwd's bucket DIRECTORY a regular file: open()ing
    // `bucket/<id>.jsonl` under it then fails ENOTDIR.
    const cwd = '/x'
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SessionPersistenceJsonl, { root })
    await writeFile(sessionDir(root, cwd), 'x') // bucket path is now a FILE
    const backend = ctx2.sessionPersistence as unknown as { inits: Map<Session, Promise<void>> }
    let s!: Session
    await ctx2.plugin(Object.assign((inner: Context) => {
      s = inner.sessions.create(SessionId('exists-fault'), { meta: { cwd } })
    }, { inject: ['sessions'] }))
    await expect(backend.inits.get(s)).rejects.toThrow(/ENOTDIR/)
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


  it('createCore rejects an id already on disk under a DIFFERENT cwd bucket', async () => {
    // Persist the id under cwd A.
    const a = meta('dup-id', '/projA')
    await ctx.sessionPersistence.create(a)
    await ctx.sessionPersistence.append(a.id, oneTurnLog())
    // A fresh backend creating the SAME id under cwd B must still refuse: load
    // identifies by id across all buckets, so a second log would make resume
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
    const session = ctx2.sessions.create(SessionId('flush-fail'))
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
    expect((await ctx.sessionPersistence.list()).map(h => h.id)).not.toContain(m.id)
  })

  it('accepts well-formed JSON values (null, booleans, nested arrays/objects)', async () => {
    const m = meta('json-ok')
    await ctx.sessionPersistence.create(m)
    const ev = [{ type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: 'x' }], source: { kind: 'user' }, extra: { a: null, b: true, c: [1, 2, { d: 'nested' }] } } }] as unknown as SessionEvent[]
    await ctx.sessionPersistence.append(m.id, ev)
    expect((await ctx.sessionPersistence.list()).map(h => h.id)).toContain(m.id)
  })

  it('Session.append rejects a non-serializable event at the source (never enters the log)', () => {
    const session = ctx.sessions.create(SessionId('reject-bad'))
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
