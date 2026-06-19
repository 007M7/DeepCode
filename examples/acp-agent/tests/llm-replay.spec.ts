import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import LlmService, { GenerateOptions, LlmAdapter, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  type ReplayEntry,
  deriveReplayScript,
  installLlmReplay,
  loadReplayScript,
  parseSessionLog,
} from '../src/llm-replay.ts'

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
function sessionJsonl(events: SessionEvent[]): string {
  const header = JSON.stringify({ type: 'session', version: 1, id: 's1', createdAt: 0 })
  return [header, ...events.map(e => JSON.stringify(e))].join('\n') + '\n'
}

/** A SessionEvent of type assistant/chunk for (turn, step). */
function chunkEvent(seq: number, turn: number, step: number, chunk: StreamChunk): SessionEvent {
  return { type: 'assistant/chunk', seq, time: 0, data: { turn, step, chunk } }
}

let dir: string
let file: string

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
    const header = JSON.stringify({ type: 'session', version: 1, id: 's1', createdAt: 0 })
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
      { type: 'turn/start', seq: seq++, time: 0, data: { turn: 1, trigger: { kind: 'continuation' } } },
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
    // A thrown stream(): prefix chunks logged, then error/turn/end, NO finish.
    const events: SessionEvent[] = [
      chunkEvent(1, 1, 1, { type: 'block-start', index: 0, blockType: 'text' }),
      chunkEvent(2, 1, 1, { type: 'text-delta', index: 0, text: 'par' }),
      { type: 'turn/end', seq: 3, time: 0, data: { turn: 1, reason: { kind: 'error', message: 'x' } } },
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
    const override: ReplayEntry[] = [{ kind: 'throw', chunks: [], message: '401', code: 'AUTH', status: 401 }]
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

describe('installLlmReplay (through the real waterfall)', () => {
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
    expect(await drain(ctx.llm.stream({ model: 'm', messages: [] }))).toEqual(TEXT_CHUNKS)
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
    expect(await drain(ctx.llm.stream({ model: 'm', messages: [] }))).toEqual(TEXT_CHUNKS)
    expect(await drain(ctx.llm.stream({ model: 'm', messages: [] }))).toEqual(second)
  })

  it('replays a sidecar throw-entry as an LlmError with code/status, after its prefix chunks', async () => {
    writeFileSync(file, sessionJsonl([]), 'utf8')
    const overrideFile = join(dir, 'replay.override.json')
    const partial: StreamChunk[] = [{ type: 'block-start', index: 0, blockType: 'text' }]
    writeFileSync(overrideFile, JSON.stringify([
      { kind: 'throw', chunks: partial, message: 'unauthorized', code: 'AUTH', status: 401 },
    ]), 'utf8')
    const ctx = new Context()
    await ctx.plugin(LlmService)
    installLlmReplay(ctx, { file, overrideFile })

    const seen: StreamChunk[] = []
    await expect((async () => {
      for await (const c of ctx.llm.stream({ model: 'm', messages: [] })) seen.push(c)
    })()).rejects.toMatchObject({ message: 'unauthorized', code: 'AUTH', status: 401 })
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
    const iterator = ctx.llm.stream({ model: 'm', messages: [], signal: controller.signal })[Symbol.asyncIterator]()
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
    await drain(ctx.llm.stream({ model: 'm', messages: [] }))
    await expect(drain(ctx.llm.stream({ model: 'm', messages: [] }))).rejects.toThrow(/exhausted/)
  })

  it('aborts mid-replay when the signal is already set', async () => {
    writeLog(TEXT_CHUNKS)
    const ctx = new Context()
    await ctx.plugin(LlmService)
    installLlmReplay(ctx, { file })
    const controller = new AbortController()
    controller.abort()
    await expect(drain(ctx.llm.stream({ model: 'm', messages: [], signal: controller.signal })))
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
    expect(await drain(ctx.llm.stream({ model: 'm', messages: [] }))).toEqual(TEXT_CHUNKS)

    await fiber.dispose()
    // After dispose the listener is gone; the call reaches the real adapter.
    expect(await drain(ctx.llm.stream({ model: 'm', messages: [] })))
      .toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
  })
})
