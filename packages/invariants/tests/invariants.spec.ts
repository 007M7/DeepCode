import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import * as Invariants from '@deepseek-ai/dsh-invariants'
import { InvariantError } from '@deepseek-ai/dsh-invariants'

/** A Context with the session store and the invariants plugin registered. */
async function setup(config?: { freeze?: boolean }) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(Invariants, config ?? {})
  return { ctx, fiber }
}

/** A minimal Agent stand-in for agent/status emission. */
function mockAgent(id: string): Agent {
  return { id } as unknown as Agent
}

describe('session-log invariants', () => {
  it('accepts a well-formed turn/step/tool sequence', async () => {
    const { ctx } = await setup({ freeze: false })
    const session = ctx.sessions.create()
    expect(() => {
      session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
      session.append('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })
      session.append('step/start', { turn: 1, step: 1 })
      session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'h' } })
      session.append('assistant/message', { turn: 1, step: 1, content: [{ type: 'tool-call', id: CallId('c1'), name: 'echo', arguments: '{}' }] })
      session.append('tool/call', { turn: 1, step: 1, callId: CallId('c1'), name: 'echo', arguments: '{}' })
      session.append('tool/result', { turn: 1, step: 1, callId: CallId('c1'), content: [{ type: 'text', text: 'ok' }], isError: false })
      session.append('step/end', { turn: 1, step: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    }).not.toThrow()
  })

  it('rejects a turn/start while another turn is open', async () => {
    const { ctx } = await setup({ freeze: false })
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    expect(() => session.append('turn/start', { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } }))
      .toThrow(/turn 1 is still open/)
  })

  it('rejects a turn/end that does not match the open turn', async () => {
    const { ctx } = await setup({ freeze: false })
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    expect(() => session.append('turn/end', { turn: 2, reason: { kind: 'completed' } }))
      .toThrow(/does not match open turn 1/)
  })

  it('rejects a step/start outside its declared turn', async () => {
    const { ctx } = await setup({ freeze: false })
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    expect(() => session.append('step/start', { turn: 2, step: 1 })).toThrow(/open turn is 1/)
  })

  it('rejects a step/end that does not match the open step', async () => {
    const { ctx } = await setup({ freeze: false })
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    expect(() => session.append('step/end', { turn: 1, step: 2 })).toThrow(/open is turn 1\/step 1/)
  })

  it('rejects an assistant/chunk outside an open step', async () => {
    const { ctx } = await setup({ freeze: false })
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    expect(() => session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x' } }))
      .toThrow(/open is turn 1\/step null/)
  })

  it('rejects a tool/result with no prior tool/call', async () => {
    const { ctx } = await setup({ freeze: false })
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    expect(() => session.append('tool/result', { turn: 1, step: 1, callId: CallId('ghost'), content: [], isError: false }))
      .toThrow(/no prior tool\/call/)
  })

  it('allows a tool/call with no matching tool/result (thrown waterfall ends the step)', async () => {
    const { ctx } = await setup({ freeze: false })
    const session = ctx.sessions.create()
    expect(() => {
      session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
      session.append('step/start', { turn: 1, step: 1 })
      session.append('tool/call', { turn: 1, step: 1, callId: CallId('c1'), name: 'echo', arguments: '{}' })
      session.append('step/end', { turn: 1, step: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'error', message: 'boom' } })
    }).not.toThrow()
  })

  it('holds seeded sessions to the contract on session/created', async () => {
    const { ctx } = await setup({ freeze: false })
    // A seed whose seq is non-monotonic must be rejected when the session is
    // created (the constructor copies the seed without emitting session/event).
    const badSeed = [
      { type: 'turn/start' as const, seq: 0, time: 0, data: { turn: 1, trigger: { kind: 'message' as const, source: { kind: 'user' as const } } } },
      { type: 'turn/start' as const, seq: 0, time: 0, data: { turn: 2, trigger: { kind: 'message' as const, source: { kind: 'user' as const } } } },
    ]
    expect(() => ctx.sessions.create(undefined, badSeed)).toThrow(InvariantError)
  })

  it('tracks turns per session independently', async () => {
    const { ctx } = await setup({ freeze: false })
    const a = ctx.sessions.create('a')
    const b = ctx.sessions.create('b')
    a.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    // b is a fresh session — its own turn/start must not see a's open turn.
    expect(() => b.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })).not.toThrow()
  })

  it('accepts multiple steps in a turn and consecutive turns', async () => {
    const { ctx } = await setup({ freeze: false })
    const session = ctx.sessions.create()
    expect(() => {
      session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
      session.append('step/start', { turn: 1, step: 1 })
      session.append('assistant/message', { turn: 1, step: 1, content: [] })
      session.append('step/end', { turn: 1, step: 1 })
      session.append('step/start', { turn: 1, step: 2 })
      session.append('assistant/message', { turn: 1, step: 2, content: [] })
      session.append('step/end', { turn: 1, step: 2 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      session.append('turn/start', { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } })
      session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    }).not.toThrow()
  })

  it('rejects a turn/end while a step is still open', async () => {
    const { ctx } = await setup({ freeze: false })
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    expect(() => session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }))
      .toThrow(/while step 1 is still open/)
  })

  it('rejects a step/start while a step is still open', async () => {
    const { ctx } = await setup({ freeze: false })
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    expect(() => session.append('step/start', { turn: 1, step: 2 })).toThrow(/while step 1 is still open/)
  })

  it('rejects a tool/result satisfying a call from a previous step', async () => {
    const { ctx } = await setup({ freeze: false })
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('tool/call', { turn: 1, step: 1, callId: CallId('c1'), name: 'echo', arguments: '{}' })
    // step ends with the call unresolved — pendingCalls is cleared.
    session.append('step/end', { turn: 1, step: 1 })
    session.append('step/start', { turn: 1, step: 2 })
    expect(() => session.append('tool/result', { turn: 1, step: 2, callId: CallId('c1'), content: [], isError: false }))
      .toThrow(/no prior tool\/call in this step/)
  })

  it('rejects an assistant/message naming the wrong step', async () => {
    const { ctx } = await setup({ freeze: false })
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    expect(() => session.append('assistant/message', { turn: 1, step: 2, content: [] }))
      .toThrow(/open is turn 1\/step 1/)
  })
})

describe('HMR state rebuild', () => {
  it('rebuilds trace state for a session that exists at (re-)apply time', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    // First registration, mid-turn: a turn is open when the plugin reloads.
    const first = await ctx.plugin(Invariants, { freeze: false })
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    await first.dispose()

    // Re-apply (HMR): the fresh fiber must replay the existing log so the open
    // step is known — the next chunk must NOT be a false positive.
    await ctx.plugin(Invariants, { freeze: false })
    expect(() => session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'h' } }))
      .not.toThrow()
    // And a genuine violation is still caught after the rebuild.
    expect(() => session.append('turn/start', { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } }))
      .toThrow(/turn 1 is still open/)
  })
})

describe('dev-freeze', () => {
  it('freezes appended event data so mutating a logged event throws', async () => {
    const { ctx } = await setup() // freeze defaults true
    const session = ctx.sessions.create()
    const event = session.append('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })
    expect(Object.isFrozen(event)).toBe(true)
    expect(Object.isFrozen(event.data)).toBe(true)
    expect(Object.isFrozen(event.data.content)).toBe(true)
    expect(() => { (event.data.content[0] as { text: string }).text = 'HACKED' }).toThrow()
  })

  it('does not freeze when freeze:false', async () => {
    const { ctx } = await setup({ freeze: false })
    const session = ctx.sessions.create()
    const event = session.append('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })
    expect(Object.isFrozen(event)).toBe(false)
  })

  it('freezes seeded events on session/created', async () => {
    const { ctx } = await setup()
    const seed = [
      { type: 'user/message' as const, seq: 0, time: 0, data: { content: [{ type: 'text' as const, text: 'seeded' }], source: { kind: 'user' as const } } },
    ]
    const session = ctx.sessions.create(undefined, seed)
    expect(Object.isFrozen(session.events[0])).toBe(true)
  })

  it('freezes mutable descendants of a shallow-frozen event datum', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    // A caller hands in a SHALLOW-frozen block whose nested array is still
    // mutable. deepFreeze must descend into the already-frozen object and
    // freeze the descendant, not short-circuit on the frozen container —
    // otherwise dev-mode misses exactly the history mutation ADR 0012 catches.
    const innerContent: { type: 'text'; text: string }[] = [{ type: 'text', text: 'inner' }]
    const block = Object.freeze({ type: 'tool-result' as const, toolCallId: CallId('c1'), content: innerContent, isError: false })
    session.append('user/message', { content: [block], source: { kind: 'user' } })
    expect(Object.isFrozen(block.content)).toBe(true)
    expect(Object.isFrozen(block.content[0])).toBe(true)
    expect(() => { block.content.push({ type: 'text', text: 'mutation' }) }).toThrow()
  })

  it('terminates on a cyclic event datum (WeakSet guard)', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    // A self-referential structure must not loop forever.
    const cyclic: Record<string, unknown> = { type: 'text', text: 'x' }
    cyclic['self'] = cyclic
    expect(() => session.append('user/message', { content: [cyclic as never], source: { kind: 'user' } })).not.toThrow()
    expect(Object.isFrozen(cyclic)).toBe(true)
  })
})

describe('agent status invariants', () => {
  it('accepts legal transitions: idle→running→idle and →disposed', async () => {
    const { ctx } = await setup({ freeze: false })
    const agent = mockAgent('a1')
    expect(() => {
      ctx.emit('agent/status', agent, 'idle')
      ctx.emit('agent/status', agent, 'running')
      ctx.emit('agent/status', agent, 'idle')
      ctx.emit('agent/status', agent, 'disposed')
    }).not.toThrow()
  })

  it('accepts running→disposed', async () => {
    const { ctx } = await setup({ freeze: false })
    const agent = mockAgent('a2')
    ctx.emit('agent/status', agent, 'running')
    expect(() => { ctx.emit('agent/status', agent, 'disposed') }).not.toThrow()
  })

  it('rejects a no-op transition', async () => {
    const { ctx } = await setup({ freeze: false })
    const agent = mockAgent('a3')
    ctx.emit('agent/status', agent, 'running')
    expect(() => { ctx.emit('agent/status', agent, 'running') }).toThrow(/no-op transition/)
  })

  it('rejects leaving the terminal disposed state', async () => {
    const { ctx } = await setup({ freeze: false })
    const agent = mockAgent('a4')
    ctx.emit('agent/status', agent, 'disposed')
    expect(() => { ctx.emit('agent/status', agent, 'idle') }).toThrow(/left terminal state disposed/)
  })

  it('tracks status per agent independently', async () => {
    const { ctx } = await setup({ freeze: false })
    const a = mockAgent('a5')
    const b = mockAgent('b5')
    ctx.emit('agent/status', a, 'running')
    // b's first observation is independent of a.
    expect(() => { ctx.emit('agent/status', b, 'running') }).not.toThrow()
  })
})

describe('HMR safety', () => {
  it('removes all listeners when the plugin fiber is disposed', async () => {
    const { ctx, fiber } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })

    await fiber.dispose()

    // After disposal: no freezing, no assertions. An event that WOULD have
    // violated the open-turn rule now passes silently, and is not frozen.
    const event = session.append('turn/start', { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } })
    expect(Object.isFrozen(event)).toBe(false)
    // A no-op status transition no longer throws either.
    const agent = mockAgent('hmr')
    ctx.emit('agent/status', agent, 'idle')
    expect(() => { ctx.emit('agent/status', agent, 'idle') }).not.toThrow()
  })

  it('InvariantError carries a stable code', () => {
    const err = new InvariantError('seq must strictly increase')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('InvariantError')
    expect(err.code).toBe('INVARIANT')
    expect(err.message).toBe('invariant violated: seq must strictly increase')
  })

  it('does not leak listeners across dispose (no stale freezing)', async () => {
    const { ctx, fiber } = await setup()
    await fiber.dispose()
    const spy = vi.fn()
    ctx.on('session/event', spy)
    const session = ctx.sessions.create()
    session.append('user/message', { content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } })
    // our own spy fires, proving events still flow — but the plugin's frozen.
    expect(spy).toHaveBeenCalledOnce()
    expect(Object.isFrozen(session.events[0])).toBe(false)
  })
})
