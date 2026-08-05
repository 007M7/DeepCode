/**
 * One-shot runner behavior over a scripted in-process API: turn anchoring on
 * the first message-triggered turn, last-text-wins aggregation, exit-code
 * mapping by turn-end reason, stream/error and RPC-error paths, and the
 * launcher-owned `ctx.headlessIo` requirement.
 */

import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { apply, Config, type HeadlessIo } from '../src/index.ts'

interface ScriptedEvent { type: string; seq?: number; time?: number; sessionId?: string; data: Record<string, unknown> }

let nextSeq = 0
/** Stamp the envelope fields the wire schema requires. */
function stamped(event: ScriptedEvent): ScriptedEvent {
  nextSeq += 1
  return { seq: nextSeq, time: nextSeq, ...event }
}

interface RpcShapedRequest { rpcId: string }

/** Build a fake apiProxy (echoing rpcIds like the real gateway) whose mux stream replays `events` for the created session. */
function scriptedApi(events: ScriptedEvent[], options: { promptFails?: boolean } = {}): unknown {
  return {
    sessions: {
      create: (request: RpcShapedRequest) =>
        Promise.resolve({ rpcId: request.rpcId, result: { ok: true, value: { sessionId: 'S1' } } }),
      prompt: (request: RpcShapedRequest) => Promise.resolve(options.promptFails === true
        // A code from the closed wire union: the carrier schema rejects invented codes.
        ? { rpcId: request.rpcId, result: { ok: false, error: { code: 'agent-busy', message: 'agent is busy', details: { reason: 'test' } } } }
        : { rpcId: request.rpcId, result: { ok: true, value: { accepted: true } } }),
    },
    events: {
      mux: async function* () {
        for (const event of events) {
          if (event.type === 'stream/error') {
            yield { rpcId: 'e', payload: { type: 'stream/error', error: { code: 'cancelled', message: 'stream broke', details: {} } } }
            continue
          }
          const { sessionId = 'S1', ...rest } = event
          yield { rpcId: 'e', payload: { type: 'session/event', sessionId, event: stamped(rest) } }
        }
      },
    },
  }
}

/** Mount the runner against a scripted API and wait for its exit request. */
async function run(events: ScriptedEvent[], options: { promptFails?: boolean } = {}): Promise<{ code: number; out: string; err: string }> {
  const ctx = new Context()
  let out = ''
  let err = ''
  const exited = new Promise<number>((resolve) => {
    const io: HeadlessIo = {
      stdout: { write: (chunk: string) => { out += chunk; return true } },
      stderr: { write: (chunk: string) => { err += chunk; return true } },
      exit: resolve,
    }
    ctx.provide('headlessIo', io)
  })
  ctx.provide('apiProxy', scriptedApi(events, options) as never)
  ctx.provide('httpServer', { port: 12345 } as never)
  apply(ctx, { task: 'do the thing' })
  const code = await exited
  await ctx.fiber.dispose()
  return { code, out, err }
}

const startupTurn: ScriptedEvent = { type: 'turn/start', data: { turn: 0, trigger: { kind: 'startup' } } }
const messageTurn: ScriptedEvent = { type: 'turn/start', data: { turn: 1, trigger: { kind: 'message' } } }
const text = (turn: number, value: string): ScriptedEvent => ({
  type: 'assistant/message',
  data: { turn, message: { content: [{ type: 'text', text: value }] } },
})
const end = (turn: number, reason: string): ScriptedEvent => ({ type: 'turn/end', data: { turn, reason: { kind: reason } } })

describe('headless runner', () => {
  it('anchors past startup turns, keeps the last text, prints, and exits 0 on completion', async () => {
    const { code, out, err } = await run([
      startupTurn,
      end(0, 'completed'),
      messageTurn,
      // Off-session, non-text, and text-empty frames are skipped without affecting the aggregate.
      { type: 'assistant/message', sessionId: 'OTHER', data: { turn: 1, message: { content: [{ type: 'text', text: 'other session' }] } } },
      { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'tool_call', text: 'ignored' }] } } },
      text(1, 'draft'),
      text(1, 'final answer'),
      end(1, 'completed'),
    ])
    expect(code).toBe(0)
    expect(out).toBe('final answer\n')
    expect(err).toContain('observing at http://127.0.0.1:12345')
  })

  it('exits 1 when the turn ends for any other reason', async () => {
    const { code } = await run([messageTurn, end(1, 'aborted')])
    expect(code).toBe(1)
  })

  it('reports a stream error and exits 1', async () => {
    const { code, err } = await run([messageTurn, { type: 'stream/error', data: {} }])
    expect(code).toBe(1)
    expect(err).toContain('stream error')
  })

  it('prints an RPC business error and exits 1 without prompting further', async () => {
    const { code, err } = await run([messageTurn, end(1, 'completed')], { promptFails: true })
    expect(code).toBe(1)
    expect(err).toContain('agent-busy')
  })

  it('exits 1 through the stream-error path when the underlying carrier dies', async () => {
    const ctx = new Context()
    let err = ''
    const exited = new Promise<number>((resolve) => {
      ctx.provide('headlessIo', {
        stdout: { write: () => true },
        stderr: { write: (chunk: string) => { err += chunk; return true } },
        exit: resolve,
      } satisfies HeadlessIo)
    })
    ctx.provide('apiProxy', {
      sessions: {
        create: (request: RpcShapedRequest) =>
          Promise.resolve({ rpcId: request.rpcId, result: { ok: true, value: { sessionId: 'S1' } } }),
        prompt: (request: RpcShapedRequest) =>
          Promise.resolve({ rpcId: request.rpcId, result: { ok: true, value: { accepted: true } } }),
      },
      events: {
        mux: async function* (): AsyncGenerator<never> {
          throw new Error('carrier died')
        },
      },
    } as never)
    ctx.provide('httpServer', { port: 1 } as never)
    apply(ctx, { task: 't' })
    expect(await exited).toBe(1)
    // The carrier converts its own failure into a stream/error frame.
    expect(err).toContain('stream error')
    expect(err).toContain('carrier died')
    await ctx.fiber.dispose()
  })

  it('fails loud without the launcher-owned headlessIo seam', () => {
    const ctx = new Context()
    ctx.provide('apiProxy', scriptedApi([]) as never)
    ctx.provide('httpServer', { port: 1 } as never)
    expect(() => { apply(ctx, { task: 't' }) }).toThrow('must provide ctx.headlessIo')
  })

  it('exits 1 with the stream-failed diagnostic when the event channel cannot open at all', async () => {
    const ctx = new Context()
    let err = ''
    const exited = new Promise<number>((resolve) => {
      ctx.provide('headlessIo', {
        stdout: { write: () => true },
        stderr: { write: (chunk: string) => { err += chunk; return true } },
        exit: resolve,
      } satisfies HeadlessIo)
    })
    ctx.provide('apiProxy', {
      sessions: {
        create: (request: RpcShapedRequest) =>
          Promise.resolve({ rpcId: request.rpcId, result: { ok: true, value: { sessionId: 'S1' } } }),
        prompt: (request: RpcShapedRequest) =>
          Promise.resolve({ rpcId: request.rpcId, result: { ok: true, value: { accepted: true } } }),
      },
      events: {
        // Synchronous throw: the SSE response never forms, so the client-side
        // iterable rejects — the runner's own catch path, not a carrier frame.
        mux: () => { throw new Error('channel exploded') },
      },
    } as never)
    ctx.provide('httpServer', { port: 1 } as never)
    apply(ctx, { task: 't' })
    expect(await exited).toBe(1)
    expect(err).toContain('event stream failed')
    await ctx.fiber.dispose()
  })

  it('validates config: the task is required', () => {
    expect(() => new Config({ } as never)).toThrow()
    expect(new Config({ task: 'x' })).toEqual({ task: 'x' })
  })
})
