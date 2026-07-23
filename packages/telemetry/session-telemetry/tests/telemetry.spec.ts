/**
 * Coordinator semantics against a bare fake backend — the RFC's named unit
 * tier for the seam: adoption (fresh, seeded, re-adoption via the handoff
 * cursor), the fixed chunk projection, deep-copy isolation, turn-latency and
 * dispose-ordering pins, failure containment, and the `agent/error` relay.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import SessionStore, { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TelemetryCoordinator, type TelemetryBackend, type TelemetryRecord } from '../src/index.ts'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /**
     * Test-only merged event proving unknown types flow through unchanged.
     * @mode emit
     * @param payload - opaque test payload
     */
    'telemetry-test/opaque': { payload: { nested: string[] } }
  }
}

class FakeBackend implements TelemetryBackend {
  records: TelemetryRecord[] = []
  calls: string[] = []
  emitError: Error | undefined
  shutdownError: Error | undefined
  shutdownResolved = false

  emit(record: TelemetryRecord): void {
    if (this.emitError) throw this.emitError
    this.records.push(record)
    this.calls.push(`emit:${String(record.attributes['event.seq'] ?? record.attributes['telemetry.op'])}`)
  }

  flush = vi.fn()

  async shutdown(): Promise<void> {
    this.calls.push('shutdown')
    await new Promise(resolve => setTimeout(resolve, 5))
    if (this.shutdownError) throw this.shutdownError
    this.shutdownResolved = true
  }

  ledger(): TelemetryRecord[] {
    return this.records.filter(r => r.channel === 'ledger')
  }
}

async function setup(backend: FakeBackend = new FakeBackend()) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin({
    name: 'fake-telemetry',
    inject: ['sessions'],
    apply: (inner: Context) => void new TelemetryCoordinator(inner, backend),
  })
  return { ctx, backend, fiber }
}

function liveSession(ctx: Context, id = `s-${Math.random().toString(36).slice(2)}`): Session {
  return ctx.sessions.create(SessionId(id), { meta: {} })
}

function appendTurn(session: Session): void {
  session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
  session.append('user/message', { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
}

describe('TelemetryCoordinator capture', () => {
  it('hands every appended event over with envelope identity and cloned body', async () => {
    const { ctx, backend } = await setup()
    const session = liveSession(ctx, 'cap')
    appendTurn(session)

    const start = backend.ledger()[0]!
    const message = backend.ledger()[1]!
    expect(start.attributes).toMatchObject({ 'session.id': 'cap', 'event.type': 'turn/start', 'event.seq': 0 })
    expect(start.time).toBe(session.events[0]!.time)
    expect(start.severity).toBe('info')
    expect(message.attributes['event.seq']).toBe(1)
    // Deep-copy isolation: mutating the handed-off body never reaches the log.
    ;(message.body as { content: { text: string }[] }).content[0]!.text = 'tampered'
    const logged = session.events[1] as SessionEvent<'user/message'>
    expect(logged.data.content[0]).toMatchObject({ text: 'hello' })
  })

  it('stamps header facts on every record when present', async () => {
    const { ctx, backend } = await setup()
    const parent = SessionId('parent')
    const session = ctx.sessions.create(SessionId('child'), { meta: { cwd: '/tmp/proj', parentSession: parent } })
    appendTurn(session)
    for (const record of backend.ledger()) {
      expect(record.attributes['session.cwd']).toBe('/tmp/proj')
      expect(record.attributes['session.parent_id']).toBe('parent')
    }
  })

  it('maps outcome flags to severity, unknown types falling through as info', async () => {
    const { ctx, backend } = await setup()
    const session = liveSession(ctx)
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('tool/result', { turn: 1, step: 1, callId: 'c1' as never, content: [], isError: true }, { surfaceOp: 'append' })
    session.append('tool/result', { turn: 1, step: 1, callId: 'c2' as never, content: [], isError: false }, { surfaceOp: 'append' })
    session.append('prompt/blocked', { content: [], source: { kind: 'user' }, reason: 'vetoed' })
    session.append('telemetry-test/opaque', { payload: { nested: [] } })
    session.append('turn/end', { turn: 1, reason: { kind: 'error', step: 1, message: 'boom' } })
    const severities = backend.ledger().map(r => [r.attributes['event.type'], r.severity])
    expect(severities).toEqual([
      ['turn/start', 'info'],
      ['tool/result', 'error'],
      ['tool/result', 'info'],
      ['prompt/blocked', 'warn'],
      ['telemetry-test/opaque', 'info'],
      ['turn/end', 'error'],
    ])
  })

  it('passes unknown merged event types through unchanged', async () => {
    const { ctx, backend } = await setup()
    const session = liveSession(ctx)
    session.append('telemetry-test/opaque', { payload: { nested: ['a', 'b'] } })
    const record = backend.ledger()[0]!
    expect(record.attributes['event.type']).toBe('telemetry-test/opaque')
    expect(record.severity).toBe('info')
    expect(record.body).toEqual({ payload: { nested: ['a', 'b'] } })
  })

  it('ships only the first chunk of each (turn, step), per session', async () => {
    const { ctx, backend } = await setup()
    const a = liveSession(ctx, 'a')
    const b = liveSession(ctx, 'b')
    const chunk = (s: Session, turn: number, step: number, text: string) =>
      s.append('assistant/chunk', { turn, step, chunk: { type: 'text-delta', index: 0, text } })
    chunk(a, 1, 1, 'a11-first')
    chunk(a, 1, 1, 'a11-second')
    chunk(a, 1, 2, 'a12-first')
    chunk(b, 1, 1, 'b11-first')
    chunk(b, 1, 1, 'b11-second')
    const shipped = backend.ledger().map(r => [r.attributes['session.id'], (r.body as { chunk: { text: string } }).chunk.text])
    expect(shipped).toEqual([
      ['a', 'a11-first'],
      ['a', 'a12-first'],
      ['b', 'b11-first'],
    ])
  })
})

describe('TelemetryCoordinator adoption', () => {
  it('reads seeded events back at adoption (fork/resume seeds never re-emit)', async () => {
    const backend = new FakeBackend()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const parent = liveSession(ctx, 'seed-parent')
    appendTurn(parent)
    ctx.sessions.create(SessionId('seeded'), { seed: [...parent.events], meta: {} })
    await ctx.plugin({
      name: 'fake-telemetry',
      inject: ['sessions'],
      apply: (inner: Context) => void new TelemetryCoordinator(inner, backend),
    })
    const seqs = backend.ledger().map(r => [r.attributes['session.id'], r.attributes['event.seq']])
    expect(seqs).toEqual(expect.arrayContaining([
      ['seed-parent', 0], ['seed-parent', 1],
      ['seeded', 0], ['seeded', 1],
    ]))
  })

  it('adopts exactly once when created fires after the sweep', async () => {
    const backend = new FakeBackend()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    // The enter/announce window: prepare+enter puts the session in the store
    // (visible to the constructor sweep) before `session/created` fires, so a
    // coordinator loaded inside that window sees the session twice — sweep
    // first, created second. The second adoption must be a no-op.
    const session = ctx.sessions.prepare(SessionId('overlap'))
    appendTurn(session)
    ctx.sessions.enter(session)
    await ctx.plugin({
      name: 'fake-telemetry',
      inject: ['sessions'],
      apply: (inner: Context) => void new TelemetryCoordinator(inner, backend),
    })
    expect(backend.ledger()).toHaveLength(2)
    ctx.sessions.announce(session)
    expect(backend.ledger()).toHaveLength(2)
  })

  it('resumes from the handoff cursor across a reload, re-dropping mid-step chunks', async () => {
    const backend = new FakeBackend()
    const { ctx, fiber } = await setup(backend)
    const session = liveSession(ctx, 'hmr')
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'first' } })
    expect(backend.ledger()).toHaveLength(2)

    await fiber.dispose()
    // The reload window: appends while no telemetry listener is registered.
    session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'mid-step continuation' } })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const second = new FakeBackend()
    await ctx.plugin({
      name: 'fake-telemetry-2',
      inject: ['sessions'],
      apply: (inner: Context) => void new TelemetryCoordinator(inner, second),
    })
    // Only the window events past the cursor are re-handed, and the mid-step
    // continuation is re-dropped because ≤cursor events rebuilt the projection.
    expect(second.ledger().map(r => r.attributes['event.type'])).toEqual(['turn/end'])
  })

  it('re-hands the full log when no cursor survived (fresh session object)', async () => {
    const backend = new FakeBackend()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = liveSession(ctx, 'fresh')
    appendTurn(session)
    await ctx.plugin({
      name: 'fake-telemetry',
      inject: ['sessions'],
      apply: (inner: Context) => void new TelemetryCoordinator(inner, backend),
    })
    expect(backend.ledger().map(r => r.attributes['event.seq'])).toEqual([0, 1])
  })
})

describe('TelemetryCoordinator lifecycle and containment', () => {
  it('forwards session/flush as a hint without awaiting backend work', async () => {
    const { ctx, backend } = await setup()
    const session = liveSession(ctx)
    let settled = false
    backend.flush.mockImplementation(() => {
      // The backend may kick off arbitrary async work; the loop's parallel must not wait for it.
      void new Promise(resolve => setTimeout(resolve, 50)).then(() => { settled = true })
    })
    await ctx.parallel('session/flush', session)
    expect(backend.flush).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)
  })

  it('ignores flush hints for sessions it never adopted', async () => {
    const { ctx, backend } = await setup()
    const stranger = ctx.sessions.prepare(SessionId('stranger'), { meta: {} })
    await ctx.parallel('session/flush', stranger)
    expect(backend.flush).not.toHaveBeenCalled()
  })

  it('emits each adopted session’s shutdown record before awaiting backend shutdown', async () => {
    const { ctx, backend, fiber } = await setup()
    liveSession(ctx, 's1')
    liveSession(ctx, 's2')
    await fiber.dispose()
    expect(backend.calls).toEqual(['emit:shutdown', 'emit:shutdown', 'shutdown'])
    expect(backend.shutdownResolved).toBe(true)
    const ops = backend.records.filter(r => r.channel === 'ops')
    expect(ops.map(r => r.attributes['session.id']).sort()).toEqual(['s1', 's2'])
    expect(ops.every(r => r.attributes['telemetry.op'] === 'shutdown' && r.severity === 'info')).toBe(true)
    expect(ops.every(r => !('event.seq' in r.attributes) && !('event.type' in r.attributes))).toBe(true)
  })

  it('warns instead of throwing when backend shutdown fails', async () => {
    const backend = new FakeBackend()
    backend.shutdownError = new Error('exporter unreachable')
    const { ctx, fiber } = await setup(backend)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    liveSession(ctx)
    await expect(fiber.dispose()).resolves.not.toThrow()
    expect(warn.mock.calls.some(args => String(args[0]).includes('shutdown failed'))).toBe(true)
  })

  it('contains emit failures: the append succeeds and capture heals', async () => {
    const { ctx, backend } = await setup()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const session = liveSession(ctx)
    backend.emitError = new Error('backend broke')
    expect(() => session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })).not.toThrow()
    expect(warn).toHaveBeenCalled()
    backend.emitError = undefined
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(backend.ledger().map(r => r.attributes['event.type'])).toEqual(['turn/end'])
  })

  it('relays agent/error as an ops record with identity and structured name', async () => {
    const { ctx, backend } = await setup()
    const session = liveSession(ctx, 'erring')
    // Only the members the relay reads; the full Agent surface is irrelevant here.
    const agent = { id: 'agent-1', session } as Agent
    ctx.emit('agent/error', agent, 3, 2, new TypeError('adapter exploded'))
    const record = backend.records.find(r => r.channel === 'ops')!
    expect(record.severity).toBe('error')
    expect(record.attributes).toMatchObject({
      'telemetry.op': 'agent-error',
      'session.id': 'erring',
      'agent.id': 'agent-1',
      'error.name': 'TypeError',
      turn: 3,
      step: 2,
    })
    expect(record.body).toEqual({ name: 'TypeError', message: 'adapter exploded' })
  })
})
