import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { appendFile, mkdtemp, mkdir, open, rm, readFile, writeFile, readdir, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { encodeSegment, logPath, scanLog, sessionDir, toHeaderLine } from '../src/format.ts'
import { runPersistenceContract, meta, oneTurnLog, appendLog } from '../../session-persistence/tests/contract.ts'
import { runCoordinatorContract, type CoordinatorFixture } from '../../session-persistence/tests/coordinator-contract.ts'

let root: string
const dirs: string[] = []

type MutableSessionHeader = { -readonly [K in keyof SessionHeader]: SessionHeader[K] }

/** Test-only mutable view used to verify that backends detach returned/caller metadata. */
function mutableHeader(header: SessionHeader): MutableSessionHeader {
  return header
}

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

async function freshRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-jsonl-'))
  dirs.push(dir)
  return dir
}

function rawLogPath(root: string, cwd: string | undefined, id: SessionId): string {
  return logPath(root, cwd, id, 'none')
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function rejectDirectorySync(code: string): Promise<void> {
  const handle = await open(root, 'r')
  const proto = Object.getPrototypeOf(handle) as { sync: () => Promise<void> }
  await handle.close()
  const realSync = proto.sync
  vi.spyOn(proto, 'sync').mockImplementation(async function (this: FileHandle) {
    if ((await this.stat()).isDirectory()) {
      const error = new Error(`simulated directory fsync ${code}`) as NodeJS.ErrnoException
      error.code = code
      throw error
    }
    return realSync.call(this)
  })
}

function appendClosedTurn(session: Session): void {
  session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
  session.append('user/message', {
    content: [{ type: 'text', text: 'hello' }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

// Run the shared backend contract against the real JSONL backend.
runPersistenceContract('jsonl-none', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-jsonl-'))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(SessionPersistenceJsonl, { root: dir, compression: 'none' })
  return {
    persistence: ctx.sessionPersistence,
    dispose: async () => {
      await fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    },
  }
})

// Two mounts share this temp root to exercise reload. `corruptTail` appends a partial,
// newline-less fragment past the committed region so coordinator repair runs on real file bytes.
runCoordinatorContract('jsonl-none', async (): Promise<CoordinatorFixture> => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-jsonl-coord-'))
  return {
    mount: async (ctx) => {
      const fiber = await ctx.plugin(SessionPersistenceJsonl, { root: dir, compression: 'none' })
      return fiber
    },
    corruptTail: async (id, cwd) => {
      // A half-written record with no trailing newline: scanLog treats it as an
      // uncommitted crash fragment and reports committedBytes < byteLength, so
      // the coordinator sees a tornMarker to truncate.
      await appendFile(rawLogPath(dir, cwd, id), '{"type":"assistant/chunk","seq":8,"ti')
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

  it('resolves a relative custom root before locating a session', async () => {
    const absoluteRoot = await freshRoot()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(SessionPersistenceJsonl, {
      root: relative(process.cwd(), absoluteRoot),
      compression: 'none',
    })
    const m = meta('relative-location', '/work')
    expect(ctx.sessionPersistence.locate(m)).toEqual({
      kind: 'jsonl',
      path: rawLogPath(resolve(absoluteRoot), '/work', m.id),
    })
    await fiber.dispose()
  })
})

describe('SessionPersistenceJsonl: durability and crash semantics', () => {
  let ctx: Context
  beforeEach(async () => {
    root = await freshRoot()
    ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPersistenceJsonl, { root, compression: 'none' })
  })
  afterEach(async () => { await ctx.fiber.dispose() })

  it('lazy materialization: create() writes no file until the first append', async () => {
    const m = meta('lazy', '/work')
    const location = ctx.sessionPersistence.locate(m)
    expect(location).toEqual({ kind: 'jsonl', path: rawLogPath(root, '/work', m.id) })
    expect(isAbsolute(location!.path)).toBe(true)

    await ctx.sessionPersistence.create(m)
    // locate() is a pure target-path calculation: neither it nor create()
    // materializes a file before the first append.
    const dir = sessionDir(root, '/work')
    await expect(stat(rawLogPath(root, '/work', m.id))).rejects.toThrow()
    expect((await ctx.sessionPersistence.list()).map(h => h.id)).not.toContain(m.id)

    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    // now materialized
    expect((await stat(rawLogPath(root, '/work', m.id))).isFile()).toBe(true)
    expect((await ctx.sessionPersistence.list()).map(h => h.id)).toContain(m.id)
    void dir
  })

  it('keeps the same location on resume and gives a fork its own location', async () => {
    const parent = meta('location-parent', '/work')
    const parentLocation = ctx.sessionPersistence.locate(parent)
    await ctx.sessionPersistence.create(parent)
    await ctx.sessionPersistence.append(parent.id, oneTurnLog())

    const loaded = await ctx.sessionPersistence.load(parent.id)
    expect(ctx.sessionPersistence.locate(loaded.meta)).toEqual(parentLocation)

    const child = {
      ...loaded.meta,
      id: SessionId('location-child'),
      parentSession: parent.id,
      seedLength: loaded.events.length,
    }
    const childLocation = ctx.sessionPersistence.locate(child)
    expect(childLocation?.path).not.toBe(parentLocation?.path)
    expect(childLocation).toEqual({ kind: 'jsonl', path: rawLogPath(root, '/work', child.id) })
  })

  it('round-trip is byte-identical (incl. assistant/chunk verbatim)', async () => {
    const m = meta('chunks')
    const log: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
      { type: 'assistant/chunk', seq: 2, time: 3, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'he' } } },
      { type: 'assistant/chunk', seq: 3, time: 4, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'llo' } } },
      { type: 'assistant/message', seq: 4, time: 5, data: { turn: 1, step: 1, content: [{ type: 'text', text: 'hello' }], provenance: { provider: 'mock', model: 'mock' } }, surfaceOp: 'append', sourceEventSeqs: [2, 3] },
      { type: 'step/end', seq: 5, time: 6, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 6, time: 7, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, log)
    const loaded = await ctx.sessionPersistence.load(m.id)
    expect(loaded.events).toEqual(log) // chunks preserved, contiguous seqs
  })

  it('rejects a stored v0 log containing a legacy request/header-delta event', async () => {
    const m = meta('legacy-header-delta', '/legacy')
    const path = rawLogPath(root, m.cwd, m.id)
    await mkdir(sessionDir(root, m.cwd), { recursive: true })
    await writeFile(path, [
      JSON.stringify(toHeaderLine(m)),
      JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } }),
      JSON.stringify({ type: 'request/header-delta', seq: 1, time: 2, data: { config: { model: 'legacy' } } }),
      JSON.stringify({ type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } }),
      '',
    ].join('\n'))

    await expect(ctx.sessionPersistence.load(m.id)).rejects.toThrow(/unsupported legacy request\/header-delta event at seq 1/)
  })

  it('rejects a stored v0 full header carrying the legacy fallback reason', async () => {
    const m = meta('legacy-header-fallback', '/legacy')
    const path = rawLogPath(root, m.cwd, m.id)
    await mkdir(sessionDir(root, m.cwd), { recursive: true })
    await writeFile(path, [
      JSON.stringify(toHeaderLine(m)),
      JSON.stringify({
        type: 'request/header',
        seq: 0,
        time: 1,
        data: { header: { config: { model: 'legacy' } }, reason: 'fallback' },
      }),
      '',
    ].join('\n'))

    await expect(ctx.sessionPersistence.load(m.id))
      .rejects.toThrow(/unsupported legacy request\/header reason "fallback" at seq 0/)
  })

  it('persists a forked child seed through the existing session write path', async () => {
    const source = ctx.sessions.create(SessionId('persist-parent'), { meta: { cwd: '/workspace' } })
    appendClosedTurn(source)

    const child = ctx.sessions.fork(source, undefined, SessionId('persist-child'))
    await ctx.parallel('session/flush', child)
    const loaded = await ctx.sessionPersistence.load(child.id)

    expect(loaded.events).toEqual(source.events)
    expect(loaded.meta).toMatchObject({
      id: SessionId('persist-child'),
      cwd: '/workspace',
      parentSession: SessionId('persist-parent'),
      seedLength: source.events.length,
    })
  })

  it('crash recovery: load preserves the interrupted turn and closes it with a synthetic turn/end {interrupted}', async () => {
    const m = meta('crash', '/proj')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog()) // seqs 0..5, turn/end at 5

    // Simulate a crash mid-second-turn: append raw lines that are NOT closed by
    // a turn/end (turn/start + step/start are fully written), plus a final
    // partial line with no newline (a torn fragment never fully flushed).
    const path = rawLogPath(root, '/proj', m.id)
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
    const before = await readFile(rawLogPath(root, undefined, m.id), 'utf8')
    const committedPrefix = before // the whole committed log

    // A crash tail then a repair-append.
    await writeFile(rawLogPath(root, undefined, m.id), '\n{"partial', { flag: 'a' })
    await ctx.sessionPersistence.load(m.id)
    await ctx.sessionPersistence.append(m.id, [
      { type: 'turn/start', seq: 6, time: 9, data: { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'turn/end', seq: 7, time: 10, data: { turn: 2, reason: { kind: 'completed' } } },
    ] as SessionEvent[])
    const after = await readFile(rawLogPath(root, undefined, m.id), 'utf8')
    // the committed prefix is byte-for-byte intact at the head of the file
    expect(after.startsWith(committedPrefix)).toBe(true)
  })

  it('a failed appendLines truncates partial bytes so a retry has no seq gap', async () => {
    const m = meta('truncate-retry')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog()) // materialized, seqs 0..5
    const sizeBefore = (await stat(rawLogPath(root, undefined, m.id))).size

    // Force the NEXT fsync (inside appendLines) to fail once, AFTER writeFile
    // has already put bytes on disk — simulating an ENOSPC/fsync error
    // mid-append. The recovery truncate() also fsyncs, so allow that one.
    const handle = await (await import('node:fs/promises')).open(rawLogPath(root, undefined, m.id), 'r')
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
    expect((await stat(rawLogPath(root, undefined, m.id))).size).toBe(sizeBefore)
    spy.mockRestore()

    // The retry now succeeds with NO seq gap — the log is contiguous 0..7.
    await ctx.sessionPersistence.append(m.id, turn2)
    const loaded = await ctx.sessionPersistence.load(m.id)
    expect(loaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('keeps file fsync mandatory while tolerating unsupported Windows directory fsync', async () => {
    await rejectDirectorySync('EPERM')
    const backend = ctx.sessionPersistence as SessionPersistenceJsonl
    backend.internals.platform = 'win32'
    const m = meta('windows-directory-sync')
    await ctx.sessionPersistence.create(m)
    await expect(ctx.sessionPersistence.append(m.id, oneTurnLog())).resolves.toBeUndefined()
    expect((await ctx.sessionPersistence.load(m.id)).events).toEqual(oneTurnLog())
  })

  it.each([
    ['linux', 'EPERM'],
    ['win32', 'EIO'],
  ] as const)('surfaces directory fsync errors on %s with %s', async (platform, code) => {
    await rejectDirectorySync(code)
    const backend = ctx.sessionPersistence as SessionPersistenceJsonl
    backend.internals.platform = platform
    const m = meta(`directory-sync-${platform}-${code}`)
    await ctx.sessionPersistence.create(m)
    await expect(ctx.sessionPersistence.append(m.id, oneTurnLog())).rejects.toMatchObject({ code })
  })

  it('load returns a meta copy: mutating it does not corrupt backend pathing', async () => {
    const m = meta('meta-copy', '/proj')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    const loaded = await ctx.sessionPersistence.load(m.id)
    // A consumer mutates the returned meta's cwd. The backend's stored pathing
    // metadata must be unaffected, so a later append still finds the right log.
    mutableHeader(loaded.meta).cwd = '/evil'
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
    await ctx.plugin(SessionPersistenceJsonl, { root, compression: 'none' })

    const a = ctx.sessions.create(SessionId('sa'))
    const b = ctx.sessions.create(SessionId('sb'))
    a.append('user/message', { content: [{ type: 'text', text: 'A' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    b.append('user/message', { content: [{ type: 'text', text: 'B' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
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

  it.each([
    ['missing', undefined],
    ['a string', '1'],
    ['fractional', 1.5],
    ['negative', -1],
  ])('rejects a session header with %s delegationDepth', (_label, delegationDepth) => {
    const log = JSON.stringify({
      type: 'session',
      version: 0,
      id: 'invalid-depth',
      createdAt: 1,
      ...delegationDepth === undefined ? {} : { delegationDepth },
    }) + '\n'
    expect(() => scanLog(Buffer.from(log))).toThrow(/session header/)
  })

  it('rejects a session header with negative-zero delegationDepth', () => {
    const log = '{"type":"session","version":0,"id":"invalid-depth","createdAt":1,"delegationDepth":-0}\n'
    expect(() => scanLog(Buffer.from(log))).toThrow(/session header/)
  })

  it('a seq gap after the last turn/end bounds the preserved tail (torn fragment tolerated)', () => {
    const log = [
      JSON.stringify({ type: 'session', version: 0, id: 'g', createdAt: 1, delegationDepth: 0 }),
      JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } }),
      JSON.stringify({ type: 'step/start', seq: 2, time: 2, data: { turn: 1, step: 1 } }), // gap: missing seq 1
    ].join('\n') + '\n'
    // No committed turn/end, so the gap is a tolerated crash boundary: scanLog PRESERVES the
    // contiguous prefix (turn/start seq 0) — real interrupted-turn work, not discarded — and
    // stops at the gap. `loadCore`, not this scanner, later closes the orphaned turn.
    expect(scanLog(Buffer.from(log)).events.map(e => e.seq)).toEqual([0])
  })

  it('rejects a seq gap BEFORE a later committed turn/end (committed data damaged)', () => {
    const log = [
      JSON.stringify({ type: 'session', version: 0, id: 'g2', createdAt: 1, delegationDepth: 0 }),
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
      JSON.stringify({ type: 'session', version: 0, id: 'c', createdAt: 1, delegationDepth: 0 }),
      '{not json', // corrupt, sits in the committed region (a turn/end follows)
      JSON.stringify({ type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } }),
    ].join('\n') + '\n'
    expect(() => scanLog(Buffer.from(log))).toThrow(/unparsable committed event/)
  })

  it('a header-only log (no event lines at all) preserves nothing — committedBytes is the header', () => {
    const log = JSON.stringify({ type: 'session', version: 0, id: 'h0', createdAt: 1, delegationDepth: 0 }) + '\n'
    const scanned = scanLog(Buffer.from(log))
    expect(scanned.events).toEqual([])
    // committedBytes falls back to the header line's end (no preserved events).
    expect(scanned.committedBytes).toBe(Buffer.byteLength(log, 'utf8'))
  })

  it('a corrupt line after the last turn/end bounds the preserved tail', () => {
    const log = [
      JSON.stringify({ type: 'session', version: 0, id: 'c2', createdAt: 1, delegationDepth: 0 }),
      JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } }),
      '{not json', // corrupt crash fragment, no turn/end committed
    ].join('\n') + '\n'
    // The contiguous prefix (turn/start seq 0) is preserved; the corrupt
    // fragment after it is the tolerated crash boundary.
    expect(scanLog(Buffer.from(log)).events.map(e => e.seq)).toEqual([0])
  })

  it('tolerates a seq gap AFTER a turn/end (uncommitted tail)', () => {
    const log = [
      JSON.stringify({ type: 'session', version: 0, id: 't', createdAt: 1, delegationDepth: 0 }),
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
    await ctx.plugin(SessionPersistenceJsonl, { root, compression: 'none' })
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
    mutableHeader(m).cwd = '/mutated'
    await p
    await ctx.sessionPersistence.append(SessionId('create-snap'), oneTurnLog())
    // The log materialized under the ORIGINAL cwd, not the mutated one.
    expect((await stat(rawLogPath(root, '/orig', SessionId('create-snap')))).isFile()).toBe(true)
    await expect(stat(rawLogPath(root, '/mutated', SessionId('create-snap')))).rejects.toThrow()
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
    // A tolerated extra field makes this valid header exceed the 8192-byte read buffer, proving
    // `readFirstLine` accumulates chunks before `list()` parses it.
    const bucket = join(root, '_no-cwd')
    await mkdir(bucket, { recursive: true })
    const bigHeader = JSON.stringify({ type: 'session', version: 0, id: 'big', createdAt: 1, delegationDepth: 0, pad: 'x'.repeat(9000) })
    await writeFile(join(bucket, 'big.jsonl'), bigHeader + '\n')
    const ids = (await ctx.sessionPersistence.list()).map(x => x.id)
    expect(ids).toContain('big')
  })

  it('a DIFFERENT live session object reusing a disposed id gets its own init (no stale cache)', async () => {
    // Session A materializes a log under id "reuse".
    const sessFiberA = await ctx.plugin(Object.assign((inner: Context) => {
      const a = inner.sessions.create(SessionId('reuse'), { meta: { cwd: '/a' } })
      appendLog(a, oneTurnLog())
    }, { inject: ['sessions'] }))
    // Drain A, then dispose ITS fiber (the live session A is gone) while the
    // backend stays loaded.
    for (const s of ctx.sessions.list()) await ctx.parallel('session/flush', s)
    await sessFiberA.dispose()

    // A new Session object reuses the id. Object-keyed initialization must run independently,
    // detect the disk collision, and reject instead of appending through session A's stale cursor.
    let b!: Session
    await ctx.plugin(Object.assign((inner: Context) => {
      b = inner.sessions.create(SessionId('reuse'), { meta: { cwd: '/a' } })
    }, { inject: ['sessions'] }))
    await expect(ctx.sessions.flush(b)).rejects.toThrow(/already bound to a different live session|already has a persisted log on disk/)
  })

  it('a NO-CWD live session does NOT cross-cwd-adopt a same-id log from a real cwd bucket (loadLive is scope-exact)', async () => {
    // Backend 1: materialize a log under id "x" in the cwd "/w" bucket, then
    // dispose the WHOLE backend (so backend 2 mounts with an EMPTY states map —
    // the HMR/reload path where onCreated goes through loadLive, not a tracked
    // collision).
    await ctx.sessionPersistence.create(meta('x', '/w'))
    await ctx.sessionPersistence.append(SessionId('x'), oneTurnLog())
    await ctx.fiber.dispose()

    // Backend 2 creates a no-cwd session whose id exists only in `/w`. Exact `loadLive(id,
    // undefined)` must not adopt across buckets; the any-cwd collision check then rejects instead
    // of grafting no-cwd events onto a log with mismatched cwd.
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SessionPersistenceJsonl, { root, compression: 'none' })
    let b!: Session
    await ctx2.plugin(Object.assign((inner: Context) => {
      b = inner.sessions.create(SessionId('x')) // no cwd
    }, { inject: ['sessions'] }))
    await expect(ctx2.sessions.flush(b)).rejects.toThrow(/already has a persisted log on disk/)

    // The "/w" log is untouched — no no-cwd events were grafted onto it, and no
    // `_no-cwd` log for "x" was created.
    const inW = scanLog(await readFile(rawLogPath(root, '/w', SessionId('x'))))
    expect(inW.meta.cwd).toBe('/w')
    expect(inW.events).toHaveLength(6)
    await expect(stat(rawLogPath(root, undefined, SessionId('x')))).rejects.toThrow()
    await ctx2.fiber.dispose()
  })

  it('a seed with matching seq/type/time but DIFFERENT data is rejected (deep prefix compare)', async () => {
    // Materialize and load (ownerless, cursor = 6).
    await ctx.sessionPersistence.create(meta('divergent', '/a'))
    await ctx.sessionPersistence.append(SessionId('divergent'), oneTurnLog())
    await ctx.sessionPersistence.load(SessionId('divergent'))

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
    await expect(ctx.sessions.flush(bad)).rejects.toThrow(/do not match this live session|already has a persisted log/)
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

    let second!: Session
    await ctx.plugin(Object.assign((inner: Context) => {
      second = inner.sessions.create(SessionId('bound'), { meta: { cwd: '/a' } })
    }, { inject: ['sessions'] }))
    await expect(ctx.sessions.flush(second))
      .rejects.toThrow(/already bound to a different live session|already has a persisted log|do not match/)
  })

  it('list returns nothing when the root directory does not exist', async () => {
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SessionPersistenceJsonl, {
      root: join(root, 'does-not-exist-yet'),
      compression: 'none',
    })
    expect(await ctx2.sessionPersistence.list()).toEqual([])
    await ctx2.fiber.dispose()
  })

  it('list surfaces a non-ENOENT root error (ENOTDIR) instead of reporting no sessions', async () => {
    // A durable backend must not collapse a storage fault to "no sessions". Making the root a
    // regular file forces ENOTDIR from `readdir`, which must propagate.
    const filePath = join(root, 'not-a-dir')
    await writeFile(filePath, 'x')
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SessionPersistenceJsonl, { root: filePath, compression: 'none' })
    await expect(ctx2.sessionPersistence.list()).rejects.toThrow(/ENOTDIR/)
    await ctx2.fiber.dispose()
  })

  it('loadLive surfaces a non-ENOENT lookup error (ENOTDIR) instead of reporting absent', async () => {
    // A non-ENOENT per-id open error must surface rather than become "not found" and permit false
    // live adoption. Making the cwd bucket a regular file forces ENOTDIR for its child log path.
    const cwd = '/x'
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SessionPersistenceJsonl, { root, compression: 'none' })
    await writeFile(sessionDir(root, cwd), 'x') // bucket path is now a FILE
    let s!: Session
    await ctx2.plugin(Object.assign((inner: Context) => {
      s = inner.sessions.create(SessionId('exists-fault'), { meta: { cwd } })
    }, { inject: ['sessions'] }))
    await expect(ctx2.sessions.flush(s)).rejects.toThrow(/ENOTDIR/)
    await ctx2.fiber.dispose()
  })

  it('append() to a disk-only session adopts it and repairs a crash tail', async () => {
    // Persist a session, then corrupt its tail, all through ONE backend.
    const m = meta('disk-append', '/d')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    await writeFile(rawLogPath(root, '/d', m.id), '\n{"partial crash', { flag: 'a' })

    // A FRESH backend with no in-memory state: append directly (no prior load)
    // → append must adopt from disk, and the adopt's load schedules a repair
    // that the same append then performs before writing.
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SessionPersistenceJsonl, { root, compression: 'none' })
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
    await ctx2.plugin(SessionPersistenceJsonl, { root, compression: 'none' })
    await expect(ctx2.sessionPersistence.create(meta('dup-id', '/projB')))
      .rejects.toThrow(/already has a persisted log on disk/)
    await ctx2.fiber.dispose()
  })

  it('flush keeps buffered events when the append fails (no silent loss)', async () => {
    root = await freshRoot()
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SessionPersistenceJsonl, { root, compression: 'none' })
    const session = ctx2.sessions.create(SessionId('flush-fail'))
    // A full turn lands in the write-behind buffer.
    session.append('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    // Make the durable materialize fail on the next flush.
    const backend = ctx2.sessionPersistence as unknown as { materialize: (...args: unknown[]) => Promise<void> }
    const origMat = backend.materialize.bind(backend)
    backend.materialize = () => Promise.reject(new Error('disk full'))
    await expectParallelFlushError(ctx2.parallel('session/flush', session), /disk full/)
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
    // Serializability is enforced at the source: Session.append throws on a BigInt-bearing
    // event before it enters session.events, so the durable log can never diverge from the live
    // log. The error therefore surfaces synchronously at append, not later during backend flush.
    expect(() => {
      session.append('user/message', { content: [{ type: 'text', text: 'bad' }], source: { kind: 'user' }, bad: 1n } as never, { surfaceOp: 'append' })
    }).toThrow(/non-JSON-serializable/)
    // The bad event was rejected, so the log stayed empty.
    expect(session.events.length).toBe(0)
  })

})
