import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import LlmService, { GenerateOptions, LlmAdapter, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  type ReplayEntry,
  type SessionScript,
  apply,
  deriveReplayScript,
  inject,
  installLlmReplay,
  loadReplayScript,
  loadSessionScripts,
  name,
  parseSessionHeader,
  parseSessionLog,
} from '../src/index.ts'

/**
 * Unit tests for the replay llm/stream plugin. These drive the listener through
 * the REAL LlmService waterfall (not a hand-rolled stub) so they verify the
 * actual seam the snapshot harness depends on, plus the pure
 * derive/parse/load helpers that turn a recorded session JSONL into a script.
 */

const TEXT_CHUNKS: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'hi' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } },
  { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** Build a minimal session-JSONL string: a header line + the given events. */
function sessionJsonl(events: SessionEvent[], header?: { id?: string; createdAt?: number; seedLength?: number }): string {
  const headerLine = JSON.stringify({
    type: 'session',
    version: 0,
    id: header?.id ?? 's1',
    createdAt: header?.createdAt ?? 0,
    ...header?.seedLength !== undefined ? { seedLength: header.seedLength } : {},
  })
  return [headerLine, ...events.map(e => JSON.stringify(e))].join('\n') + '\n'
}

/** A SessionEvent of type assistant/chunk for (turn, step). */
function chunkEvent(seq: number, turn: number, step: number, chunk: StreamChunk): SessionEvent {
  return { type: 'assistant/chunk', seq, time: 0, data: { turn, step, chunk } }
}

let dir: string
let file: string

/** Write a session log file and return its path. */
function writeSession(filename: string, header: { id: string; createdAt: number }, calls: StreamChunk[][]): string {
  let seq = 1
  const events: SessionEvent[] = []
  calls.forEach((chunks, step) => { for (const c of chunks) events.push(chunkEvent(seq++, 1, step + 1, c)) })
  const path = join(dir, filename)
  writeFileSync(path, sessionJsonl(events, header), 'utf8')
  return path
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'llm-replay-spec-'))
  file = join(dir, 'session.jsonl')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function drain(iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of iter) out.push(chunk)
  return out
}

describe('parseSessionLog', () => {
  it('skips the header line and parses each event', () => {
    const events = [chunkEvent(1, 1, 1, TEXT_CHUNKS[0] as StreamChunk)]
    expect(parseSessionLog(sessionJsonl(events))).toEqual(events)
  })

  it('ignores blank lines', () => {
    const header = JSON.stringify({ type: 'session', version: 0, id: 's1', createdAt: 0 })
    const ev = chunkEvent(1, 1, 1, TEXT_CHUNKS[0] as StreamChunk)
    expect(parseSessionLog(`${header}\n\n${JSON.stringify(ev)}\n\n`)).toEqual([ev])
  })
})

describe('deriveReplayScript', () => {
  it('groups assistant/chunk by (turn, step) into one entry per stream() call', () => {
    const events: SessionEvent[] = TEXT_CHUNKS.map((c, i) => chunkEvent(i + 1, 1, 1, c))
    expect(deriveReplayScript(events)).toEqual([{ kind: 'chunks', chunks: TEXT_CHUNKS }])
  })

  it('produces one entry per distinct (turn, step), in log order', () => {
    const callA = TEXT_CHUNKS
    const callB: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'two' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    let seq = 1
    const events: SessionEvent[] = [
      ...callA.map(c => chunkEvent(seq++, 1, 1, c)),
      ...callB.map(c => chunkEvent(seq++, 1, 2, c)), // same turn, next step
    ]
    expect(deriveReplayScript(events)).toEqual([
      { kind: 'chunks', chunks: callA },
      { kind: 'chunks', chunks: callB },
    ])
  })

  it('separates calls across turns too', () => {
    let seq = 1
    const events: SessionEvent[] = [
      ...TEXT_CHUNKS.map(c => chunkEvent(seq++, 1, 1, c)),
      ...TEXT_CHUNKS.map(c => chunkEvent(seq++, 2, 1, c)), // new turn, step resets to 1
    ]
    expect(deriveReplayScript(events)).toHaveLength(2)
  })

  it('ignores non-assistant/chunk events', () => {
    let seq = 1
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: seq++, time: 0, data: { turn: 1, trigger: { kind: 'injection', source: { kind: 'user' } } } },
      ...TEXT_CHUNKS.map(c => chunkEvent(seq++, 1, 1, c)),
      { type: 'turn/end', seq: seq++, time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    expect(deriveReplayScript(events)).toEqual([{ kind: 'chunks', chunks: TEXT_CHUNKS }])
  })

  it('returns an empty script for a log with no assistant/chunk events', () => {
    expect(deriveReplayScript([])).toEqual([])
  })

  it('keeps a finish-error chunk in the derived entry (replays naturally)', () => {
    const errChunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'finish', reason: { kind: 'error', message: 'boom', code: 'X' } },
    ]
    const events = errChunks.map((c, i) => chunkEvent(i + 1, 1, 1, c))
    expect(deriveReplayScript(events)).toEqual([{ kind: 'chunks', chunks: errChunks }])
  })

  it('throws on a group that lacks a terminal finish chunk (a thrown stream)', () => {
    // A thrown stream(): prefix chunks logged, then turn/end (error reason), NO finish.
    const events: SessionEvent[] = [
      chunkEvent(1, 1, 1, { type: 'block-start', index: 0, blockType: 'text' }),
      chunkEvent(2, 1, 1, { type: 'text-delta', index: 0, text: 'par' }),
      { type: 'turn/end', seq: 3, time: 0, data: { turn: 1, reason: { kind: 'error', step: 1, message: 'x' } } },
    ]
    expect(() => deriveReplayScript(events)).toThrow(/without a finish chunk.*replay\.override\.json/s)
  })

  it('names the offending (turn, step) when a group is incomplete', () => {
    const events: SessionEvent[] = [
      chunkEvent(1, 2, 3, { type: 'block-start', index: 0, blockType: 'text' }),
    ]
    expect(() => deriveReplayScript(events)).toThrow(/2\/3/)
  })
})

describe('loadReplayScript', () => {
  it('derives from the session JSONL when no override is present', () => {
    writeFileSync(file, sessionJsonl(TEXT_CHUNKS.map((c, i) => chunkEvent(i + 1, 1, 1, c))), 'utf8')
    expect(loadReplayScript({ file })).toEqual([{ kind: 'chunks', chunks: TEXT_CHUNKS }])
  })

  it('uses the sidecar override when present, ignoring the JSONL', () => {
    writeFileSync(file, sessionJsonl([]), 'utf8')
    const overrideFile = join(dir, 'replay.override.json')
    const override: ReplayEntry[] = [{ kind: 'throw', chunks: [], message: '401', code: 'AUTH' }]
    writeFileSync(overrideFile, JSON.stringify(override), 'utf8')
    expect(loadReplayScript({ file, overrideFile })).toEqual(override)
  })

  it('falls back to the JSONL when the override path is set but absent', () => {
    writeFileSync(file, sessionJsonl(TEXT_CHUNKS.map((c, i) => chunkEvent(i + 1, 1, 1, c))), 'utf8')
    expect(loadReplayScript({ file, overrideFile: join(dir, 'nope.json') }))
      .toEqual([{ kind: 'chunks', chunks: TEXT_CHUNKS }])
  })

  it('fails loud when the fixture is missing', () => {
    expect(() => loadReplayScript({ file: join(dir, 'absent.jsonl') })).toThrow(/fixture not found/)
  })

  it('throws when the override is not a JSON array', () => {
    writeFileSync(file, sessionJsonl([]), 'utf8')
    const overrideFile = join(dir, 'replay.override.json')
    writeFileSync(overrideFile, '{"not":"array"}', 'utf8')
    expect(() => loadReplayScript({ file, overrideFile })).toThrow(/not a JSON array/)
  })
})

describe('installLlmReplay (through the real LlmService)', () => {
  function writeLog(...calls: StreamChunk[][]): void {
    let seq = 1
    const events: SessionEvent[] = []
    calls.forEach((chunks, step) => {
      for (const c of chunks) events.push(chunkEvent(seq++, 1, step + 1, c))
    })
    writeFileSync(file, sessionJsonl(events), 'utf8')
  }

  it('serves derived chunks back, short-circuiting the adapter', async () => {
    writeLog(TEXT_CHUNKS)
    const ctx = new Context()
    await ctx.plugin(LlmService)
    // No adapter registered for 'm' — replay must not reach it.
    installLlmReplay(ctx, { file })
    expect(await drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [] }))).toEqual(TEXT_CHUNKS)
  })

  it('registers a replay-only provider catalog when configured', async () => {
    writeLog(TEXT_CHUNKS)
    const ctx = new Context()
    await ctx.plugin(LlmService)
    const dispose = installLlmReplay(ctx, {
      file,
      providers: [
        {
          id: 'deepseek',
          name: 'DeepSeek',
          models: [
            { id: 'flash' },
            { id: 'pro', name: 'Pro', description: 'Larger model' },
          ],
        },
        { id: 'empty' },
      ],
    })

    expect(ctx.llm.listProviders()).toEqual([
      { id: 'deepseek', name: 'DeepSeek' },
      { id: 'empty', name: 'empty' },
    ])
    await expect(ctx.llm.listModels('deepseek')).resolves.toEqual([
      { provider: 'deepseek', id: 'flash', name: 'flash' },
      { provider: 'deepseek', id: 'pro', name: 'Pro', description: 'Larger model' },
    ])
    await expect(ctx.llm.listModels('empty')).resolves.toEqual([])
    expect(await drain(ctx.llm.stream({ provider: 'deepseek', model: 'pro', messages: [] }))).toEqual(TEXT_CHUNKS)

    dispose()
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('serves the Nth call the Nth derived entry (positional)', async () => {
    const second: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'two' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    writeLog(TEXT_CHUNKS, second)
    const ctx = new Context()
    await ctx.plugin(LlmService)
    installLlmReplay(ctx, { file })
    expect(await drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [] }))).toEqual(TEXT_CHUNKS)
    expect(await drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [] }))).toEqual(second)
  })

  it('replays a sidecar throw-entry as an LlmError with its stable code, after its prefix chunks', async () => {
    writeFileSync(file, sessionJsonl([]), 'utf8')
    const overrideFile = join(dir, 'replay.override.json')
    const partial: StreamChunk[] = [{ type: 'block-start', index: 0, blockType: 'text' }]
    writeFileSync(overrideFile, JSON.stringify([
      { kind: 'throw', chunks: partial, message: 'unauthorized', code: 'AUTH' },
    ]), 'utf8')
    const ctx = new Context()
    await ctx.plugin(LlmService)
    installLlmReplay(ctx, { file, overrideFile })

    const seen: StreamChunk[] = []
    await expect((async () => {
      for await (const c of ctx.llm.stream({ provider: 'm', model: 'm', messages: [] })) seen.push(c)
    })()).rejects.toMatchObject({ message: 'unauthorized', code: 'AUTH' })
    expect(seen).toEqual(partial)
  })

  it('replays a sidecar hang-entry that surfaces abort when the signal fires', async () => {
    writeFileSync(file, sessionJsonl([]), 'utf8')
    const overrideFile = join(dir, 'replay.override.json')
    writeFileSync(overrideFile, JSON.stringify([{ kind: 'hang' }]), 'utf8')
    const ctx = new Context()
    await ctx.plugin(LlmService)
    installLlmReplay(ctx, { file, overrideFile })

    const controller = new AbortController()
    const iterator = ctx.llm.stream({ provider: 'm', model: 'm', messages: [], signal: controller.signal })[Symbol.asyncIterator]()
    // Deterministically consume the two pre-hang chunks (no sleep), then abort
    // and assert the next pull rejects — event-driven, per the no-sleeps rule.
    expect((await iterator.next()).value).toMatchObject({ type: 'block-start' })
    expect((await iterator.next()).value).toMatchObject({ type: 'text-delta' })
    controller.abort()
    await expect(iterator.next()).rejects.toThrow('aborted')
  })

  it('fails loud when the script is exhausted', async () => {
    writeLog(TEXT_CHUNKS)
    const ctx = new Context()
    await ctx.plugin(LlmService)
    installLlmReplay(ctx, { file })
    await drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [] }))
    await expect(drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [] }))).rejects.toThrow(/exhausted/)
  })

  it('aborts mid-replay when the signal is already set', async () => {
    writeLog(TEXT_CHUNKS)
    const ctx = new Context()
    await ctx.plugin(LlmService)
    installLlmReplay(ctx, { file })
    const controller = new AbortController()
    controller.abort()
    await expect(drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [], signal: controller.signal })))
      .rejects.toThrow('aborted')
  })

  it('removes the waterfall listener when the owning fiber is disposed (HMR safety)', async () => {
    writeLog(TEXT_CHUNKS, TEXT_CHUNKS)
    const ctx = new Context()
    await ctx.plugin(LlmService)

    // A real adapter to fall through to AFTER dispose, proving the listener is gone.
    class FallthroughAdapter extends LlmAdapter {
      async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['m'], new FallthroughAdapter())

    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      installLlmReplay(inner, { file })
    }, { inject: ['llm'] }))

    // While installed, replay short-circuits to the derived fixture ('hi').
    expect(await drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [] }))).toEqual(TEXT_CHUNKS)

    await fiber.dispose()
    // After dispose the listener is gone; the call reaches the real adapter.
    expect(await drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [] })))
      .toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
  })

  it('throws on a malformed sidecar entry kind (the assertNever guard)', async () => {
    writeFileSync(file, sessionJsonl([]), 'utf8')
    const overrideFile = join(dir, 'replay.override.json')
    // A kind the union does not know — hand-edited/drifted sidecar data.
    writeFileSync(overrideFile, JSON.stringify([{ kind: 'bogus' }]), 'utf8')
    const ctx = new Context()
    await ctx.plugin(LlmService)
    installLlmReplay(ctx, { file, overrideFile })
    await expect(drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [] })))
      .rejects.toThrow(/llm-replay replay entry/)
  })

  it('rejects a hang entry when the signal fires DURING the wait (abort listener path)', async () => {
    writeFileSync(file, sessionJsonl([]), 'utf8')
    const overrideFile = join(dir, 'replay.override.json')
    writeFileSync(overrideFile, JSON.stringify([{ kind: 'hang' }]), 'utf8')
    const ctx = new Context()
    await ctx.plugin(LlmService)
    installLlmReplay(ctx, { file, overrideFile })
    const controller = new AbortController()
    const iterator = ctx.llm.stream({ provider: 'm', model: 'm', messages: [], signal: controller.signal })[Symbol.asyncIterator]()
    // Consume the two pre-hang chunks, then start the third pull so the generator
    // is parked inside the await (signal NOT yet aborted — exercises the
    // addEventListener('abort') registration), and only THEN abort.
    expect((await iterator.next()).value).toMatchObject({ type: 'block-start' })
    expect((await iterator.next()).value).toMatchObject({ type: 'text-delta' })
    const pending = iterator.next()
    await new Promise(r => setImmediate(r))
    controller.abort()
    await expect(pending).rejects.toThrow('aborted')
  })

  it('aborts mid-replay of a throw-entry prefix when the signal is set', async () => {
    writeFileSync(file, sessionJsonl([]), 'utf8')
    const overrideFile = join(dir, 'replay.override.json')
    const partial: StreamChunk[] = [{ type: 'block-start', index: 0, blockType: 'text' }]
    writeFileSync(overrideFile, JSON.stringify([
      { kind: 'throw', chunks: partial, message: 'unauthorized', code: 'AUTH' },
    ]), 'utf8')
    const ctx = new Context()
    await ctx.plugin(LlmService)
    installLlmReplay(ctx, { file, overrideFile })
    const controller = new AbortController()
    controller.abort()
    // Already aborted: the throw-entry's prefix loop surfaces 'aborted' before
    // it can reach the recorded LlmError.
    await expect(drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [], signal: controller.signal })))
      .rejects.toThrow('aborted')
  })

  it('surfaces an already-aborted signal on a hang entry before waiting', async () => {
    writeFileSync(file, sessionJsonl([]), 'utf8')
    const overrideFile = join(dir, 'replay.override.json')
    writeFileSync(overrideFile, JSON.stringify([{ kind: 'hang' }]), 'utf8')
    const ctx = new Context()
    await ctx.plugin(LlmService)
    installLlmReplay(ctx, { file, overrideFile })
    const controller = new AbortController()
    controller.abort()
    // The two pre-hang chunks still flow; the abort surfaces at the await.
    const iterator = ctx.llm.stream({ provider: 'm', model: 'm', messages: [], signal: controller.signal })[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.next()
    await expect(iterator.next()).rejects.toThrow('aborted')
  })
})

describe('parseSessionHeader', () => {
  it('reads id, createdAt, and seedLength off the header line', () => {
    expect(parseSessionHeader(sessionJsonl([], { id: 'abc', createdAt: 42 })))
      .toEqual({ id: 'abc', createdAt: 42, seedLength: 0 })
  })

  it('reads a non-zero seedLength (a fork child header)', () => {
    expect(parseSessionHeader('{"type":"session","version":0,"id":"child","createdAt":7,"seedLength":4}\n'))
      .toEqual({ id: 'child', createdAt: 7, seedLength: 4 })
  })

  it('falls back to id="" / createdAt=0 / seedLength=0 when the header lacks them', () => {
    expect(parseSessionHeader('{"type":"session","version":0}\n')).toEqual({ id: '', createdAt: 0, seedLength: 0 })
  })

  it('falls back on an empty buffer (no header line)', () => {
    expect(parseSessionHeader('')).toEqual({ id: '', createdAt: 0, seedLength: 0 })
  })
})

describe('loadSessionScripts', () => {
  it('returns one primary script for a single-session scenario', () => {
    const f = writeSession('session.jsonl', { id: 'p', createdAt: 100 }, [TEXT_CHUNKS])
    const scripts: SessionScript[] = loadSessionScripts({ file: f })
    expect(scripts).toHaveLength(1)
    expect(scripts[0]).toMatchObject({ recordedId: 'p', createdAt: 100, primary: true })
    expect(scripts[0]?.entries).toEqual([{ kind: 'chunks', chunks: TEXT_CHUNKS }])
  })

  it('orders parent + children by createdAt with the primary first on a tie', () => {
    const f = writeSession('session.jsonl', { id: 'parent', createdAt: 100 }, [TEXT_CHUNKS])
    // One child created LATER, one child sharing the parent's createdAt (tie).
    const later = writeSession('session.1.jsonl', { id: 'late', createdAt: 200 }, [TEXT_CHUNKS])
    const tie = writeSession('session.2.jsonl', { id: 'tie', createdAt: 100 }, [TEXT_CHUNKS])
    const scripts = loadSessionScripts({ file: f, childFiles: [later, tie] })
    // parent (100, primary) → tie (100, non-primary) → late (200).
    expect(scripts.map(s => s.recordedId)).toEqual(['parent', 'tie', 'late'])
    expect(scripts[0]?.primary).toBe(true)
  })

  it('throws when a declared child fixture is missing', () => {
    const f = writeSession('session.jsonl', { id: 'p', createdAt: 1 }, [TEXT_CHUNKS])
    expect(() => loadSessionScripts({ file: f, childFiles: [join(dir, 'absent.jsonl')] }))
      .toThrow(/child fixture not found/)
  })

  it('derives a FORK child script from its OWN events only (skips the seeded parent prefix)', () => {
    // A fork log includes the parent's assistant chunks before `seedLength`. Deriving from the
    // whole log would replay parent responses as child calls, so only child-owned chunks qualify.
    const parentChunk: StreamChunk = { type: 'text-delta', index: 0, text: 'PARENT-RESPONSE' }
    const childChunks: StreamChunk[] = [{ type: 'text-delta', index: 0, text: 'CHILD-RESPONSE' }, { type: 'finish', reason: { kind: 'stop' } }]
    const f = writeSession('session.jsonl', { id: 'parent', createdAt: 100 }, [TEXT_CHUNKS])
    // The child fixture: 2 seeded parent events (a chunk + its finish) then the
    // child's own turn. seedLength = 2 marks where the inherited prefix ends.
    const childEvents: SessionEvent[] = [
      chunkEvent(0, 1, 1, parentChunk),
      chunkEvent(1, 1, 1, { type: 'finish', reason: { kind: 'stop' } }),
      chunkEvent(2, 2, 1, childChunks[0]!),
      chunkEvent(3, 2, 1, childChunks[1]!),
    ]
    const childPath = join(dir, 'session.1.jsonl')
    writeFileSync(childPath, sessionJsonl(childEvents, { id: 'child', createdAt: 200, seedLength: 2 }), 'utf8')

    const scripts = loadSessionScripts({ file: f, childFiles: [childPath] })
    // The child script is ONLY the child's own model call — the parent's seeded
    // chunk is gone.
    expect(scripts[1]?.entries).toEqual([{ kind: 'chunks', chunks: childChunks }])
  })

  it('uses the override for the primary and still derives children', () => {
    writeFileSync(file, sessionJsonl([], { id: 'p', createdAt: 1 }), 'utf8')
    const overrideFile = join(dir, 'replay.override.json')
    const override: ReplayEntry[] = [{ kind: 'hang' }]
    writeFileSync(overrideFile, JSON.stringify(override), 'utf8')
    const child = writeSession('session.1.jsonl', { id: 'c', createdAt: 2 }, [TEXT_CHUNKS])
    const scripts = loadSessionScripts({ file, overrideFile, childFiles: [child] })
    expect(scripts[0]?.entries).toEqual(override)
    expect(scripts[1]?.entries).toEqual([{ kind: 'chunks', chunks: TEXT_CHUNKS }])
  })

  it('defaults the primary header to id="" / createdAt=0 when only an override (no JSONL) exists', () => {
    // An override-only fixture: config.file does NOT exist, the override drives
    // the primary script, so the header default branch applies.
    const overrideFile = join(dir, 'replay.override.json')
    writeFileSync(overrideFile, JSON.stringify([{ kind: 'hang' }]), 'utf8')
    const scripts = loadSessionScripts({ file: join(dir, 'absent.jsonl'), overrideFile })
    expect(scripts).toHaveLength(1)
    expect(scripts[0]).toMatchObject({ recordedId: '', createdAt: 0, primary: true })
  })

  it('orders two same-createdAt children deterministically after the primary', () => {
    // Two children sharing a createdAt (both non-primary): exercises the sort
    // tie-break\'s "both same primary-ness" arm and a non-primary-vs-primary arm.
    const f = writeSession('session.jsonl', { id: 'parent', createdAt: 100 }, [TEXT_CHUNKS])
    const c1 = writeSession('session.1.jsonl', { id: 'c1', createdAt: 100 }, [TEXT_CHUNKS])
    const c2 = writeSession('session.2.jsonl', { id: 'c2', createdAt: 100 }, [TEXT_CHUNKS])
    const scripts = loadSessionScripts({ file: f, childFiles: [c1, c2] })
    // Primary first (its createdAt ties the children but primary wins); the two
    // children keep a stable relative order.
    expect(scripts[0]?.recordedId).toBe('parent')
    expect(scripts.every(s => s.createdAt === 100)).toBe(true)
    expect(scripts.map(s => s.primary)).toEqual([true, false, false])
  })

  it('keeps the primary first even when a child sorts BEFORE it in input order', () => {
    // The primary is appended first internally. A strictly earlier child sorts before it, while
    // equal creation times preserve primary-first order regardless of input order.
    const f = writeSession('session.jsonl', { id: 'parent', createdAt: 100 }, [TEXT_CHUNKS])
    const earlier = writeSession('session.1.jsonl', { id: 'early', createdAt: 100 }, [TEXT_CHUNKS])
    const scripts = loadSessionScripts({ file: f, childFiles: [earlier] })
    // Equal createdAt → primary first.
    expect(scripts.map(s => s.recordedId)).toEqual(['parent', 'early'])
  })
})

describe('installLlmReplay (per-session keying)', () => {
  const second: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'child' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]

  const live = (id: string): GenerateOptions =>
    ({ provider: 'm', model: 'm', messages: [], sessionId: id as NonNullable<GenerateOptions['sessionId']> })

  it('routes each live session to its own script by FIRST-CALL order', async () => {
    const parentFile = writeSession('session.jsonl', { id: 'rec-parent', createdAt: 100 }, [TEXT_CHUNKS])
    const childFile = writeSession('session.1.jsonl', { id: 'rec-child', createdAt: 200 }, [second])
    const ctx = new Context()
    await ctx.plugin(LlmService)
    installLlmReplay(ctx, { file: parentFile, childFiles: [childFile] })
    // The first live session to call binds to the parent script; a different
    // live session id binds to the child script — regardless of recorded ids.
    expect(await drain(ctx.llm.stream(live('live-A')))).toEqual(TEXT_CHUNKS)
    expect(await drain(ctx.llm.stream(live('live-B')))).toEqual(second)
    // The first session's SECOND call would exhaust its 1-entry script.
    await expect(drain(ctx.llm.stream(live('live-A')))).rejects.toThrow(/exhausted/)
  })

  it('keeps each session\'s cursor independent (interleaved calls)', async () => {
    const a2: StreamChunk[] = [{ type: 'text-delta', index: 0, text: 'a2' }, { type: 'finish', reason: { kind: 'stop' } }]
    const b2: StreamChunk[] = [{ type: 'text-delta', index: 0, text: 'b2' }, { type: 'finish', reason: { kind: 'stop' } }]
    const parentFile = writeSession('session.jsonl', { id: 'p', createdAt: 1 }, [TEXT_CHUNKS, a2])
    const childFile = writeSession('session.1.jsonl', { id: 'c', createdAt: 2 }, [second, b2])
    const ctx = new Context()
    await ctx.plugin(LlmService)
    installLlmReplay(ctx, { file: parentFile, childFiles: [childFile] })
    // Interleave: A#1, B#1, A#2, B#2 — each cursor advances per-session.
    expect(await drain(ctx.llm.stream(live('A')))).toEqual(TEXT_CHUNKS)
    expect(await drain(ctx.llm.stream(live('B')))).toEqual(second)
    expect(await drain(ctx.llm.stream(live('A')))).toEqual(a2)
    expect(await drain(ctx.llm.stream(live('B')))).toEqual(b2)
  })

  it('treats a call with no sessionId as the single anonymous (primary) session', async () => {
    const parentFile = writeSession('session.jsonl', { id: 'p', createdAt: 1 }, [TEXT_CHUNKS])
    const ctx = new Context()
    await ctx.plugin(LlmService)
    installLlmReplay(ctx, { file: parentFile })
    // No sessionId at all — the legacy single-session path.
    expect(await drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [] }))).toEqual(TEXT_CHUNKS)
  })

  it('fails loud when more distinct live sessions call than were recorded', async () => {
    const parentFile = writeSession('session.jsonl', { id: 'p', createdAt: 1 }, [TEXT_CHUNKS])
    const ctx = new Context()
    await ctx.plugin(LlmService)
    installLlmReplay(ctx, { file: parentFile }) // only ONE recorded session
    expect(await drain(ctx.llm.stream(live('first')))).toEqual(TEXT_CHUNKS)
    // A SECOND distinct live session has no script to bind to.
    await expect(drain(ctx.llm.stream(live('second')))).rejects.toThrow(/unrecorded session/)
  })
})

describe('apply (the plugin entry)', () => {
  const ORIG = {
    file: process.env.DSH_SNAPSHOT_FILE,
    override: process.env.DSH_SNAPSHOT_OVERRIDE,
    children: process.env.DSH_SNAPSHOT_CHILD_FILES,
  }
  afterEach(() => {
    if (ORIG.file === undefined) delete process.env.DSH_SNAPSHOT_FILE
    else process.env.DSH_SNAPSHOT_FILE = ORIG.file
    if (ORIG.override === undefined) delete process.env.DSH_SNAPSHOT_OVERRIDE
    else process.env.DSH_SNAPSHOT_OVERRIDE = ORIG.override
    if (ORIG.children === undefined) delete process.env.DSH_SNAPSHOT_CHILD_FILES
    else process.env.DSH_SNAPSHOT_CHILD_FILES = ORIG.children
  })

  it('exposes the namespace plugin shape (name/inject, no default export)', () => {
    expect(name).toBe('llm-replay')
    expect(inject).toEqual(['llm'])
  })

  it('installs replay and its catalog from explicit config', async () => {
    writeFileSync(file, sessionJsonl(TEXT_CHUNKS.map((c, i) => chunkEvent(i + 1, 1, 1, c))), 'utf8')
    const ctx = new Context()
    await ctx.plugin(LlmService)
    apply(ctx, { file, providers: [{ id: 'm', models: [{ id: 'm' }] }] })
    expect(ctx.llm.listProviders()).toEqual([{ id: 'm', name: 'm' }])
    expect(await drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [] }))).toEqual(TEXT_CHUNKS)
  })

  it('falls back to $DSH_SNAPSHOT_FILE / $DSH_SNAPSHOT_OVERRIDE when config is empty', async () => {
    writeFileSync(file, sessionJsonl([]), 'utf8')
    const overrideFile = join(dir, 'replay.override.json')
    writeFileSync(overrideFile, JSON.stringify([{ kind: 'chunks', chunks: TEXT_CHUNKS }]), 'utf8')
    process.env.DSH_SNAPSHOT_FILE = file
    process.env.DSH_SNAPSHOT_OVERRIDE = overrideFile
    const ctx = new Context()
    await ctx.plugin(LlmService)
    apply(ctx)
    expect(await drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [] }))).toEqual(TEXT_CHUNKS)
  })

  it('uses only the file when no override path is configured or in the env', async () => {
    writeFileSync(file, sessionJsonl(TEXT_CHUNKS.map((c, i) => chunkEvent(i + 1, 1, 1, c))), 'utf8')
    process.env.DSH_SNAPSHOT_FILE = file
    delete process.env.DSH_SNAPSHOT_OVERRIDE
    const ctx = new Context()
    await ctx.plugin(LlmService)
    apply(ctx)
    expect(await drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [] }))).toEqual(TEXT_CHUNKS)
  })

  it('throws when no fixture path is given by config or env', async () => {
    delete process.env.DSH_SNAPSHOT_FILE
    const ctx = new Context()
    await ctx.plugin(LlmService)
    expect(() => { apply(ctx, {}) }).toThrow(/a fixture path is required/)
  })

  it('treats an empty-string fixture path as missing', async () => {
    delete process.env.DSH_SNAPSHOT_FILE
    const ctx = new Context()
    await ctx.plugin(LlmService)
    expect(() => { apply(ctx, { file: '' }) }).toThrow(/a fixture path is required/)
  })

  it('loads child fixtures from config.childFiles (per-session routing)', async () => {
    const childSecond: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'kid' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    writeFileSync(file, sessionJsonl(TEXT_CHUNKS.map((c, i) => chunkEvent(i + 1, 1, 1, c)), { id: 'p', createdAt: 1 }), 'utf8')
    const childFile = join(dir, 'session.1.jsonl')
    writeFileSync(childFile, sessionJsonl(childSecond.map((c, i) => chunkEvent(i + 1, 1, 1, c)), { id: 'c', createdAt: 2 }), 'utf8')
    const ctx = new Context()
    await ctx.plugin(LlmService)
    apply(ctx, { file, childFiles: [childFile] })
    const live = (id: string): GenerateOptions =>
      ({ provider: 'm', model: 'm', messages: [], sessionId: id as NonNullable<GenerateOptions['sessionId']> })
    expect(await drain(ctx.llm.stream(live('A')))).toEqual(TEXT_CHUNKS)
    expect(await drain(ctx.llm.stream(live('B')))).toEqual(childSecond)
  })

  it('falls back to $DSH_SNAPSHOT_CHILD_FILES (path-delimited) when config omits childFiles', async () => {
    const childChunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'env-kid' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    writeFileSync(file, sessionJsonl(TEXT_CHUNKS.map((c, i) => chunkEvent(i + 1, 1, 1, c)), { id: 'p', createdAt: 1 }), 'utf8')
    const childFile = join(dir, 'session.1.jsonl')
    writeFileSync(childFile, sessionJsonl(childChunks.map((c, i) => chunkEvent(i + 1, 1, 1, c)), { id: 'c', createdAt: 2 }), 'utf8')
    process.env.DSH_SNAPSHOT_FILE = file
    process.env.DSH_SNAPSHOT_CHILD_FILES = childFile // single entry, no delimiter needed
    const ctx = new Context()
    await ctx.plugin(LlmService)
    apply(ctx)
    const live = (id: string): GenerateOptions =>
      ({ provider: 'm', model: 'm', messages: [], sessionId: id as NonNullable<GenerateOptions['sessionId']> })
    expect(await drain(ctx.llm.stream(live('A')))).toEqual(TEXT_CHUNKS)
    expect(await drain(ctx.llm.stream(live('B')))).toEqual(childChunks)
  })

  it('ignores an empty $DSH_SNAPSHOT_CHILD_FILES (single-session)', async () => {
    writeFileSync(file, sessionJsonl(TEXT_CHUNKS.map((c, i) => chunkEvent(i + 1, 1, 1, c)), { id: 'p', createdAt: 1 }), 'utf8')
    process.env.DSH_SNAPSHOT_FILE = file
    process.env.DSH_SNAPSHOT_CHILD_FILES = ''
    const ctx = new Context()
    await ctx.plugin(LlmService)
    apply(ctx)
    expect(await drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [] }))).toEqual(TEXT_CHUNKS)
  })
})
