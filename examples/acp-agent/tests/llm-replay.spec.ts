import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LlmService, { GenerateOptions, LlmAdapter, LlmError, StreamChunk } from '@deepseek-ai/dsh-llm'
import { type ReplayEntry, installLlmReplay, loadFixture } from '../src/llm-replay.ts'

/**
 * Unit tests for the record/replay llm/stream plugin. These drive the listener
 * through the REAL LlmService waterfall (not a hand-rolled stub) so they verify
 * the actual seam the snapshot harness depends on.
 */

const TEXT_SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'hi' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } },
  { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** A scripted adapter whose every call yields one of a list of scripts. */
class MultiScriptAdapter extends LlmAdapter {
  calls = 0
  constructor(private scripts: (StreamChunk[] | (() => never))[]) {
    super()
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const script = this.scripts[this.calls++]
    if (script === undefined) throw new Error('MultiScriptAdapter: script exhausted')
    if (typeof script === 'function') return script() // throws (returns never)
    yield* script
  }
}

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'llm-replay-spec-'))
  file = join(dir, 'llm.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function drain(iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of iter) out.push(chunk)
  return out
}

describe('llm-replay record mode', () => {
  it('tees the real stream unchanged and flushes one chunks-entry per call', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['m'], new MultiScriptAdapter([TEXT_SCRIPT]))
    installLlmReplay(ctx, { mode: 'record', file })

    const seen = await drain(ctx.llm.stream({ model: 'm', messages: [] }))
    expect(seen).toEqual(TEXT_SCRIPT) // consumer sees the real chunks unchanged

    const fixture = loadFixture(file)
    expect(fixture).toEqual([{ kind: 'chunks', chunks: TEXT_SCRIPT }])
  })

  it('flushes after EACH stream (durable without dispose)', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['m'], new MultiScriptAdapter([TEXT_SCRIPT, TEXT_SCRIPT]))
    installLlmReplay(ctx, { mode: 'record', file })

    await drain(ctx.llm.stream({ model: 'm', messages: [] }))
    expect(loadFixture(file)).toHaveLength(1) // already on disk, no dispose needed
    await drain(ctx.llm.stream({ model: 'm', messages: [] }))
    expect(loadFixture(file)).toHaveLength(2)
  })

  it('records a throw-entry then re-throws when the adapter throws', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['m'], new MultiScriptAdapter([() => { throw new Error('boom') }]))
    installLlmReplay(ctx, { mode: 'record', file })

    await expect(drain(ctx.llm.stream({ model: 'm', messages: [] }))).rejects.toThrow('boom')
    expect(loadFixture(file)).toEqual([{ kind: 'throw', chunks: [], message: 'boom', code: 'UNKNOWN' }])
  })

  it('records the partial chunks emitted before a mid-stream throw', async () => {
    const partial: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'par' },
    ]
    function* chunkThenThrow(): Generator<StreamChunk> {
      yield* partial
      throw new LlmError('connection dropped', 'STREAM_CLOSED')
    }
    // An adapter that streams two chunks, then throws mid-stream.
    class MidStreamThrowAdapter extends LlmAdapter {
      async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        yield* chunkThenThrow()
      }
    }
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['m'], new MidStreamThrowAdapter())
    installLlmReplay(ctx, { mode: 'record', file })

    const seen: StreamChunk[] = []
    await expect((async () => {
      for await (const c of ctx.llm.stream({ model: 'm', messages: [] })) seen.push(c)
    })()).rejects.toThrow('connection dropped')
    expect(seen).toEqual(partial) // consumer saw the partial output before the throw
    expect(loadFixture(file)).toEqual([
      { kind: 'throw', chunks: partial, message: 'connection dropped', code: 'STREAM_CLOSED' },
    ])
  })
})

describe('llm-replay replay mode', () => {
  function writeFixture(entries: ReplayEntry[]): void {
    writeFileSync(file, JSON.stringify(entries), 'utf8')
  }

  it('serves recorded chunks back in order, short-circuiting the adapter', async () => {
    writeFixture([{ kind: 'chunks', chunks: TEXT_SCRIPT }])
    const ctx = new Context()
    await ctx.plugin(LlmService)
    // No adapter registered for 'm' — replay must not reach it.
    installLlmReplay(ctx, { mode: 'replay', file })

    const seen = await drain(ctx.llm.stream({ model: 'm', messages: [] }))
    expect(seen).toEqual(TEXT_SCRIPT)
  })

  it('serves the Nth call the Nth entry (positional)', async () => {
    const second: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'two' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    writeFixture([{ kind: 'chunks', chunks: TEXT_SCRIPT }, { kind: 'chunks', chunks: second }])
    const ctx = new Context()
    await ctx.plugin(LlmService)
    installLlmReplay(ctx, { mode: 'replay', file })

    expect(await drain(ctx.llm.stream({ model: 'm', messages: [] }))).toEqual(TEXT_SCRIPT)
    expect(await drain(ctx.llm.stream({ model: 'm', messages: [] }))).toEqual(second)
  })

  it('replays a throw-entry as an LlmError with the recorded code/status', async () => {
    writeFixture([{ kind: 'throw', chunks: [], message: 'unauthorized', code: 'AUTH', status: 401 }])
    const ctx = new Context()
    await ctx.plugin(LlmService)
    installLlmReplay(ctx, { mode: 'replay', file })

    await expect(drain(ctx.llm.stream({ model: 'm', messages: [] }))).rejects.toMatchObject({
      message: 'unauthorized',
      code: 'AUTH',
      status: 401,
    })
  })

  it('replays a throw-entry preceded by its partial chunks', async () => {
    const partial: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'par' },
    ]
    writeFixture([{ kind: 'throw', chunks: partial, message: 'dropped', code: 'STREAM_CLOSED' }])
    const ctx = new Context()
    await ctx.plugin(LlmService)
    installLlmReplay(ctx, { mode: 'replay', file })

    const seen: StreamChunk[] = []
    await expect((async () => {
      for await (const c of ctx.llm.stream({ model: 'm', messages: [] })) seen.push(c)
    })()).rejects.toThrow('dropped')
    expect(seen).toEqual(partial) // partial output replayed before the throw
  })

  it('replays a hang-entry that surfaces abort when the signal fires', async () => {
    writeFixture([{ kind: 'hang' }])
    const ctx = new Context()
    await ctx.plugin(LlmService)
    installLlmReplay(ctx, { mode: 'replay', file })

    const controller = new AbortController()
    const iterator = ctx.llm.stream({ model: 'm', messages: [], signal: controller.signal })[Symbol.asyncIterator]()
    // Deterministically consume the two pre-hang chunks (no sleep), then abort
    // and assert the next pull rejects — event-driven, per the no-sleeps rule.
    expect((await iterator.next()).value).toMatchObject({ type: 'block-start' })
    expect((await iterator.next()).value).toMatchObject({ type: 'text-delta' })
    controller.abort()
    await expect(iterator.next()).rejects.toThrow('aborted')
  })

  it('fails loud when the fixture is missing', () => {
    const ctx = new Context()
    expect(() => installLlmReplay(ctx, { mode: 'replay', file: join(dir, 'absent.json') }))
      .toThrow(/fixture not found/)
  })

  it('fails loud when the fixture is exhausted', async () => {
    writeFixture([{ kind: 'chunks', chunks: TEXT_SCRIPT }])
    const ctx = new Context()
    await ctx.plugin(LlmService)
    installLlmReplay(ctx, { mode: 'replay', file })

    await drain(ctx.llm.stream({ model: 'm', messages: [] }))
    await expect(drain(ctx.llm.stream({ model: 'm', messages: [] }))).rejects.toThrow(/exhausted/)
  })

  it('aborts mid-replay when the signal is already set', async () => {
    writeFixture([{ kind: 'chunks', chunks: TEXT_SCRIPT }])
    const ctx = new Context()
    await ctx.plugin(LlmService)
    installLlmReplay(ctx, { mode: 'replay', file })

    const controller = new AbortController()
    controller.abort()
    await expect(drain(ctx.llm.stream({ model: 'm', messages: [], signal: controller.signal })))
      .rejects.toThrow('aborted')
  })
})

describe('llm-replay HMR safety', () => {
  it('removes the waterfall listener when the owning fiber is disposed', async () => {
    writeFileSync(file, JSON.stringify([{ kind: 'chunks', chunks: TEXT_SCRIPT }]), 'utf8')
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['m'], new MultiScriptAdapter([TEXT_SCRIPT, TEXT_SCRIPT]))

    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      installLlmReplay(inner, { mode: 'replay', file })
    }, { inject: ['llm'] }))

    // While installed, replay short-circuits to the fixture ('hi').
    expect(await drain(ctx.llm.stream({ model: 'm', messages: [] }))).toEqual(TEXT_SCRIPT)

    await fiber.dispose()
    // After dispose, the listener is gone and the call reaches the real adapter
    // (also TEXT_SCRIPT here) — proving the waterfall no longer intercepts.
    const afterDispose = await drain(ctx.llm.stream({ model: 'm', messages: [] }))
    expect(afterDispose).toEqual(TEXT_SCRIPT)
  })
})

describe('loadFixture', () => {
  it('throws on a non-array JSON fixture', () => {
    writeFileSync(file, '{"not":"an array"}', 'utf8')
    expect(() => loadFixture(file)).toThrow(/not a JSON array/)
  })

  it('reads back what was written', () => {
    const entries: ReplayEntry[] = [{ kind: 'chunks', chunks: TEXT_SCRIPT }]
    writeFileSync(file, JSON.stringify(entries), 'utf8')
    expect(loadFixture(file)).toEqual(entries)
  })
})
