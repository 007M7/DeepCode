import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { appendFile, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { logPath, scanLog, sessionDir, toHeaderLine, type JsonlCompression } from '../src/format.ts'
import { compressZstdFrame, decompressZstdFrame, scanZstdFrames } from '../src/zstd.ts'
import { runPersistenceContract, meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'
import { runCoordinatorContract, type CoordinatorFixture } from '../../session-persistence/tests/coordinator-contract.ts'

const MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])
const roots: string[] = []
const contexts: Context[] = []

async function freshRoot(prefix = 'dsh-jsonl-zstd-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

async function mount(root: string, compression?: JsonlCompression): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionPersistenceJsonl, {
    root,
    ...(compression === undefined ? {} : { compression }),
  })
  return ctx
}

async function decodeCompleteFrames(buffer: Buffer): Promise<Buffer> {
  const { frames, tornStart } = scanZstdFrames(buffer)
  expect(tornStart).toBeUndefined()
  const plaintext: Buffer[] = []
  for (const frame of frames) {
    plaintext.push(await decompressZstdFrame(buffer.subarray(frame.start, frame.end)))
  }
  return Buffer.concat(plaintext)
}

async function tornFrame(
  plaintext: string,
  accepts: (decoded: string) => boolean,
): Promise<Buffer> {
  const frame = await compressZstdFrame(plaintext)
  const candidateEnds = [
    frame.length - 1,
    frame.length - 4,
    ...[0.9, 0.75, 0.6, 0.5, 0.4, 0.25].map(ratio => Math.floor(frame.length * ratio)),
  ]
  for (const end of candidateEnds) {
    const candidate = frame.subarray(0, end)
    if (scanZstdFrames(candidate).tornStart !== 0) continue
    try {
      const decoded = (await decompressZstdFrame(candidate)).toString('utf8')
      if (accepts(decoded)) return candidate
    } catch {
      // Some early cuts precede the first decodable block; keep searching for
      // a cut that exercises partial-plaintext recovery.
    }
  }
  throw new Error('test fixture could not produce the requested torn Zstandard frame')
}

function deterministicNoise(length: number): string {
  let state = 0x12345678
  let output = ''
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    output += String.fromCharCode(33 + (state % 90))
  }
  return output
}

function emptyStructuralFrame(descriptor: number): Buffer {
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 0x20) !== 0
  const dictionaryBytes = [0, 1, 2, 4][descriptor & 0x03]!
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
  const variableHeader = Buffer.alloc((singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes)
  const lastEmptyRawBlock = Buffer.from([1, 0, 0])
  const checksum = (descriptor & 0x04) === 0 ? Buffer.alloc(0) : Buffer.alloc(4)
  return Buffer.concat([MAGIC, Buffer.from([descriptor]), variableHeader, lastEmptyRawBlock, checksum])
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

runPersistenceContract('jsonl-zstd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-zstd-contract-'))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(SessionPersistenceJsonl, { root })
  return {
    persistence: ctx.sessionPersistence,
    dispose: async () => {
      await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
})

runCoordinatorContract('jsonl-zstd', async (): Promise<CoordinatorFixture> => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-zstd-coordinator-'))
  return {
    mount: async ctx => ctx.plugin(SessionPersistenceJsonl, { root }),
    corruptTail: async (id, cwd) => {
      const line = JSON.stringify({
        type: 'assistant/chunk',
        seq: 8,
        time: 9,
        data: { turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: deterministicNoise(300_000) } },
      }) + '\n'
      const partial = await tornFrame(line, decoded => decoded.length > 0 && !decoded.endsWith('\n'))
      await appendFile(logPath(root, cwd, id, 'zstd'), partial)
    },
    cleanup: async () => { await rm(root, { recursive: true, force: true }) },
  }
})

describe('Zstandard frame structure', () => {
  it('scans concatenated checksummed frames and honors a frame limit', async () => {
    const first = await compressZstdFrame('header\n')
    const second = await compressZstdFrame('event\n')
    const stream = Buffer.concat([first, second])
    expect(scanZstdFrames(Buffer.alloc(0))).toEqual({ frames: [] })
    expect(scanZstdFrames(stream)).toEqual({
      frames: [{ start: 0, end: first.length }, { start: first.length, end: stream.length }],
    })
    expect(scanZstdFrames(stream, 1)).toEqual({ frames: [{ start: 0, end: first.length }] })
    expect(first[4]! & 0x04).toBe(0x04)
    expect(second[4]! & 0x04).toBe(0x04)
    expect((await decompressZstdFrame(first)).toString()).toBe('header\n')
  })

  it('distinguishes incomplete frame regions from invalid complete structure', () => {
    expect(scanZstdFrames(MAGIC.subarray(0, 2))).toEqual({ frames: [], tornStart: 0 })
    expect(scanZstdFrames(MAGIC)).toEqual({ frames: [], tornStart: 0 })
    expect(() => scanZstdFrames(Buffer.alloc(4))).toThrow(/invalid frame magic/)
    expect(() => scanZstdFrames(Buffer.concat([MAGIC, Buffer.from([0x08])]))).toThrow(/reserved frame-header bit/)

    // Non-single-segment descriptor with no window descriptor.
    expect(scanZstdFrames(Buffer.concat([MAGIC, Buffer.from([0x00])]))).toEqual({ frames: [], tornStart: 0 })
    // Single-segment header followed by only two bytes of the three-byte block header.
    expect(scanZstdFrames(Buffer.concat([MAGIC, Buffer.from([0x20, 0x00, 0x01, 0x00])]))).toEqual({
      frames: [],
      tornStart: 0,
    })

    const rawFiveBytes = Buffer.from([(5 << 3) | 1, 0, 0])
    expect(scanZstdFrames(Buffer.concat([
      MAGIC,
      Buffer.from([0x20, 0x00]),
      rawFiveBytes,
      Buffer.from([0x01, 0x02]),
    ]))).toEqual({ frames: [], tornStart: 0 })

    const reservedBlock = Buffer.concat([
      MAGIC,
      Buffer.from([0x20, 0x00, 0x07, 0x00, 0x00]),
    ])
    expect(() => scanZstdFrames(reservedBlock)).toThrow(/reserved block type/)
  })

  it('covers standard header variants, RLE blocks, multiple blocks, and checksums', () => {
    for (const descriptor of [0x00, 0x21, 0x42, 0x83, 0xE3]) {
      const frame = emptyStructuralFrame(descriptor)
      expect(scanZstdFrames(frame)).toEqual({ frames: [{ start: 0, end: frame.length }] })
    }

    const rle = Buffer.concat([
      MAGIC,
      Buffer.from([0x20, 0x01]),
      Buffer.from([(1 << 3) | (1 << 1) | 1, 0, 0]),
      Buffer.from([0x41]),
    ])
    expect(scanZstdFrames(rle)).toEqual({ frames: [{ start: 0, end: rle.length }] })

    const twoBlocks = Buffer.concat([
      MAGIC,
      Buffer.from([0x20, 0x00]),
      Buffer.from([0, 0, 0]),
      Buffer.from([1, 0, 0]),
    ])
    expect(scanZstdFrames(twoBlocks)).toEqual({ frames: [{ start: 0, end: twoBlocks.length }] })

    const checksummed = emptyStructuralFrame(0x24)
    expect(scanZstdFrames(checksummed.subarray(0, -1))).toEqual({ frames: [], tornStart: 0 })
    expect(scanZstdFrames(checksummed)).toEqual({ frames: [{ start: 0, end: checksummed.length }] })
  })
})

describe('SessionPersistenceJsonl: default Zstandard encoding', () => {
  it('writes .jsonl.zstd by default with one header frame and one first-batch frame', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    const header = meta('default-zstd', '/work')
    await ctx.sessionPersistence.create(header)
    await ctx.sessionPersistence.append(header.id, oneTurnLog())

    const path = logPath(root, header.cwd, header.id, 'zstd')
    const buffer = await readFile(path)
    expect(buffer.subarray(0, 4)).toEqual(MAGIC)
    await expect(stat(logPath(root, header.cwd, header.id, 'none'))).rejects.toThrow()
    expect(ctx.sessionPersistence.locate(header)).toEqual({ kind: 'jsonl', path })

    const scan = scanZstdFrames(buffer)
    expect(scan.frames).toHaveLength(2)
    const plaintext = await decodeCompleteFrames(buffer)
    expect(plaintext.toString()).toBe([
      JSON.stringify(toHeaderLine(header)),
      ...oneTurnLog().map(e => JSON.stringify(e)),
      '',
    ].join('\n'))
    expect((await ctx.sessionPersistence.load(header.id)).events).toEqual(oneTurnLog())
  })

  it('resolves the default when a programmatic wrapper bypasses Loader schema normalization', async () => {
    const root = await freshRoot()
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    let backend!: SessionPersistenceJsonl
    await ctx.plugin(Object.assign((inner: Context) => {
      backend = new SessionPersistenceJsonl(inner, { root })
    }, { inject: ['sessions'] }))
    const header = meta('direct-default')
    expect(backend.locate(header)).toEqual({
      kind: 'jsonl',
      path: logPath(root, header.cwd, header.id, 'zstd'),
    })
  })

  it('appends one frame per durable batch without rewriting prior bytes', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    const header = meta('append-frame')
    await ctx.sessionPersistence.create(header)
    await ctx.sessionPersistence.append(header.id, oneTurnLog())
    const path = logPath(root, header.cwd, header.id, 'zstd')
    const before = await readFile(path)
    const secondTurn = [
      { type: 'turn/start', seq: 6, time: 7, data: { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'turn/end', seq: 7, time: 8, data: { turn: 2, reason: { kind: 'completed' } } },
    ] as SessionEvent[]
    await ctx.sessionPersistence.append(header.id, secondTurn)

    const after = await readFile(path)
    expect(after.subarray(0, before.length)).toEqual(before)
    expect(scanZstdFrames(after).frames).toHaveLength(3)
    expect((await ctx.sessionPersistence.load(header.id)).events).toEqual([...oneTurnLog(), ...secondTurn])
  })

  it('lists from a multi-chunk header frame without decoding a corrupt event frame', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    const header = meta('large-header', `/work/${'x'.repeat(24_000)}`)
    await ctx.sessionPersistence.create(header)
    await ctx.sessionPersistence.append(header.id, oneTurnLog())
    const path = logPath(root, header.cwd, header.id, 'zstd')
    const buffer = Buffer.from(await readFile(path))
    const eventFrame = scanZstdFrames(buffer).frames[1]!
    buffer[eventFrame.end - 1] = buffer[eventFrame.end - 1]! ^ 0xFF
    await writeFile(path, buffer)

    expect((await ctx.sessionPersistence.list()).map(item => item.id)).toEqual([header.id])
    await expect(ctx.sessionPersistence.load(header.id)).rejects.toThrow(/frame at byte .* failed validation/)
  })

  it('preserves complete records from a torn frame and re-encodes them with crash closers', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    const header = meta('recover-torn', '/proj')
    await ctx.sessionPersistence.create(header)
    await ctx.sessionPersistence.append(header.id, oneTurnLog())
    const path = logPath(root, header.cwd, header.id, 'zstd')
    const committed = await readFile(path)
    const openTurn = [
      { type: 'turn/start', seq: 6, time: 7, data: { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'step/start', seq: 7, time: 8, data: { turn: 2, step: 1 } },
      { type: 'assistant/chunk', seq: 8, time: 9, data: { turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: deterministicNoise(300_000) } } },
    ] as SessionEvent[]
    const plaintext = openTurn.map(e => JSON.stringify(e)).join('\n') + '\n'
    const partial = await tornFrame(plaintext, (decoded) => {
      const newlines = decoded.match(/\n/g)?.length ?? 0
      return newlines >= 2 && !decoded.endsWith('\n')
    })
    await appendFile(path, partial)

    const loaded = await ctx.sessionPersistence.load(header.id)
    expect(loaded.events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(loaded.events[6]).toEqual(openTurn[0])
    expect(loaded.events[7]).toEqual(openTurn[1])
    expect(loaded.events.some(event => event.type === 'assistant/chunk' && event.seq === 8)).toBe(false)
    expect(loaded.events[8]?.type).toBe('step/end')
    expect(loaded.events[9]?.type).toBe('turn/end')

    const repaired = await readFile(path)
    expect(repaired.subarray(0, committed.length)).toEqual(committed)
    expect(scanZstdFrames(repaired).tornStart).toBeUndefined()
    expect(scanLog(await decodeCompleteFrames(repaired)).events).toEqual(loaded.events)
  })

  it('drops a frame torn in its header before it has produced plaintext', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    const header = meta('partial-magic')
    await ctx.sessionPersistence.create(header)
    await ctx.sessionPersistence.append(header.id, oneTurnLog())
    const path = logPath(root, header.cwd, header.id, 'zstd')
    const committed = await readFile(path)
    await appendFile(path, MAGIC.subarray(0, 2))

    expect((await ctx.sessionPersistence.load(header.id)).events).toEqual(oneTurnLog())
    expect(await readFile(path)).toEqual(committed)
  })

  it('recovers complete events when EOF tears only the final frame checksum', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    const header = meta('partial-checksum')
    await ctx.sessionPersistence.create(header)
    await ctx.sessionPersistence.append(header.id, oneTurnLog())
    const path = logPath(root, header.cwd, header.id, 'zstd')
    const secondTurn = [
      { type: 'turn/start', seq: 6, time: 7, data: { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'turn/end', seq: 7, time: 8, data: { turn: 2, reason: { kind: 'completed' } } },
    ] as SessionEvent[]
    const frame = await compressZstdFrame(secondTurn.map(e => JSON.stringify(e)).join('\n') + '\n')
    await appendFile(path, frame.subarray(0, -1))

    const loaded = await ctx.sessionPersistence.load(header.id)
    expect(loaded.events).toEqual([...oneTurnLog(), ...secondTurn])
    const repaired = await readFile(path)
    expect(scanZstdFrames(repaired).tornStart).toBeUndefined()
    expect(scanLog(await decodeCompleteFrames(repaired)).events).toEqual(loaded.events)
  })

  it('rejects a complete frame containing a torn JSONL record', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    const header = meta('complete-bad-jsonl')
    await ctx.sessionPersistence.create(header)
    await ctx.sessionPersistence.append(header.id, oneTurnLog())
    await appendFile(
      logPath(root, header.cwd, header.id, 'zstd'),
      await compressZstdFrame('{"type":"turn/start"'),
    )
    await expect(ctx.sessionPersistence.load(header.id)).rejects.toThrow(/complete frame contains a torn JSONL record/)
  })

  it('rolls back a checksummed append frame when fsync fails', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    const header = meta('zstd-fsync-rollback')
    await ctx.sessionPersistence.create(header)
    await ctx.sessionPersistence.append(header.id, oneTurnLog())
    const path = logPath(root, header.cwd, header.id, 'zstd')
    const before = await readFile(path)

    const handle = await open(path, 'r')
    const prototype = Object.getPrototypeOf(handle) as { sync: () => Promise<void> }
    await handle.close()
    const realSync = prototype.sync
    let failed = false
    const spy = vi.spyOn(prototype, 'sync').mockImplementation(async function (this: FileHandle) {
      if (!failed) {
        failed = true
        throw new Error('simulated Zstandard fsync failure')
      }
      return realSync.call(this)
    })
    const secondTurn = [
      { type: 'turn/start', seq: 6, time: 7, data: { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'turn/end', seq: 7, time: 8, data: { turn: 2, reason: { kind: 'completed' } } },
    ] as SessionEvent[]
    await expect(ctx.sessionPersistence.append(header.id, secondTurn)).rejects.toThrow(/simulated Zstandard fsync failure/)
    expect(await readFile(path)).toEqual(before)
    spy.mockRestore()
    await ctx.sessionPersistence.append(header.id, secondTurn)
    expect((await ctx.sessionPersistence.load(header.id)).events).toEqual([...oneTurnLog(), ...secondTurn])
  })

  it('skips empty, incomplete, and non-header compressed artifacts while rejecting malformed header frames', async () => {
    const root = await freshRoot()
    const bucket = sessionDir(root, undefined)
    await mkdir(bucket, { recursive: true })
    await writeFile(join(bucket, 'empty.jsonl.zstd'), '')
    await writeFile(join(bucket, 'partial.jsonl.zstd'), MAGIC)
    await writeFile(join(bucket, 'not-header.jsonl.zstd'), await compressZstdFrame('{"type":"turn/start"}\n'))
    const ctx = await mount(root)
    expect(await ctx.sessionPersistence.list()).toEqual([])

    await writeFile(join(bucket, 'two-lines.jsonl.zstd'), await compressZstdFrame([
      JSON.stringify(toHeaderLine(meta('two-lines'))),
      JSON.stringify({ type: 'turn/start' }),
      '',
    ].join('\n')))
    await expect(ctx.sessionPersistence.list()).rejects.toThrow(/first frame is not exactly one header line/)
    await expect(ctx.sessionPersistence.load(SessionId('two-lines')))
      .rejects.toThrow(/first frame is not exactly one header line/)
  })

  it('rejects missing, empty, and checksum-corrupt header frames on targeted reads', async () => {
    const root = await freshRoot()
    const bucket = sessionDir(root, undefined)
    await mkdir(bucket, { recursive: true })
    await writeFile(logPath(root, undefined, SessionId('partial-only'), 'zstd'), MAGIC)
    await writeFile(logPath(root, undefined, SessionId('empty-header'), 'zstd'), await compressZstdFrame(''))
    const corruptHeader = Buffer.from(await compressZstdFrame(`${JSON.stringify(toHeaderLine(meta('bad-checksum')))}\n`))
    corruptHeader[corruptHeader.length - 1] = corruptHeader[corruptHeader.length - 1]! ^ 0xFF
    await writeFile(logPath(root, undefined, SessionId('bad-checksum'), 'zstd'), corruptHeader)
    const ctx = await mount(root)

    await expect(ctx.sessionPersistence.load(SessionId('partial-only')))
      .rejects.toThrow(/empty or header-less Zstandard session log/)
    await expect(ctx.sessionPersistence.load(SessionId('empty-header')))
      .rejects.toThrow(/first frame is not exactly one header line/)
    await expect(ctx.sessionPersistence.list()).rejects.toThrow(/header frame failed validation/)
  })
})

describe('SessionPersistenceJsonl: encoding selection', () => {
  it('rejects roots owned by the opposite encoding in both directions', async () => {
    const rawRoot = await freshRoot('dsh-jsonl-raw-mismatch-')
    const raw = await mount(rawRoot, 'none')
    const rawHeader = meta('raw-log')
    await raw.sessionPersistence.create(rawHeader)
    await raw.sessionPersistence.append(rawHeader.id, oneTurnLog())
    const defaultBackend = await mount(rawRoot)
    await expect(defaultBackend.sessionPersistence.list()).rejects.toThrow(/configured for compression "zstd"/)

    const zstdRoot = await freshRoot('dsh-jsonl-zstd-mismatch-')
    const zstd = await mount(zstdRoot)
    const zstdHeader = meta('zstd-log')
    await zstd.sessionPersistence.create(zstdHeader)
    await zstd.sessionPersistence.append(zstdHeader.id, oneTurnLog())
    const rawBackend = await mount(zstdRoot, 'none')
    await expect(rawBackend.sessionPersistence.list()).rejects.toThrow(/configured for compression "none"/)
  })

  it('rechecks targeted artifacts and listing after an initially empty root', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    expect(await ctx.sessionPersistence.list()).toEqual([])

    const loadHeader = meta('late-raw-load', '/late')
    await mkdir(sessionDir(root, loadHeader.cwd), { recursive: true })
    await writeFile(logPath(root, loadHeader.cwd, loadHeader.id, 'none'), [
      JSON.stringify(toHeaderLine(loadHeader)),
      ...oneTurnLog().map(e => JSON.stringify(e)),
      '',
    ].join('\n'))
    await expect(ctx.sessionPersistence.load(loadHeader.id)).rejects.toThrow(/uses \.jsonl/)
    await expect((ctx.sessionPersistence as SessionPersistenceJsonl).loadStored(loadHeader.id))
      .rejects.toThrow(/uses \.jsonl/)
    await expect(ctx.sessionPersistence.list()).rejects.toThrow(/uses \.jsonl/)
  })

  it('refuses materialization when an opposite artifact appears after create', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    await ctx.sessionPersistence.list()
    const header = meta('late-raw-materialize', '/late')
    await ctx.sessionPersistence.create(header)
    await mkdir(sessionDir(root, header.cwd), { recursive: true })
    await writeFile(logPath(root, header.cwd, header.id, 'none'), [
      JSON.stringify(toHeaderLine(header)),
      ...oneTurnLog().map(e => JSON.stringify(e)),
      '',
    ].join('\n'))
    await expect(ctx.sessionPersistence.append(header.id, oneTurnLog())).rejects.toThrow(/uses \.jsonl/)
    expect((await readdir(sessionDir(root, header.cwd))).some(name => name.endsWith('.jsonl.zstd'))).toBe(false)
  })
})
