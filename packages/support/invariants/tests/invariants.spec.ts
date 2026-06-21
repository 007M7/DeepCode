import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
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

  it('rejects a non-monotonic seq (replay spine)', async () => {
    const { ctx } = await setup({ freeze: false })
    const session = ctx.sessions.create()
    // Session.append enforces seq-contiguity at the source, so drive the
    // invariants seq check directly via session/event with a regressing seq.
    ctx.emit('session/event', session, { type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } } as never)
    expect(() => { ctx.emit('session/event', session, { type: 'turn/end', seq: 0, time: 2, data: { turn: 1, reason: { kind: 'completed' } } } as never) })
      .toThrow(/seq must strictly increase/)
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

  it('rejects a message event appended outside any open turn (turn-enclosure)', async () => {
    const { ctx } = await setup({ freeze: false })
    const session = ctx.sessions.create()
    // No turn open: every message-bearing event must be turn-enclosed (the turn-enclosure RFC).
    expect(() => session.append('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
      .toThrow(/outside any open turn/)
    expect(() => session.append('context/message', { content: [{ type: 'text', text: 'ctx' }], source: { kind: 'user' } }))
      .toThrow(/outside any open turn/)
  })

  it('rejects usage/error and plugin-added events appended outside any open turn', async () => {
    const { ctx } = await setup({ freeze: false })
    const session = ctx.sessions.create()
    // usage and error are turn-scoped: outside a turn they would land past the
    // commit boundary and be dropped on resume (the turn-enclosure RFC).
    expect(() => session.append('usage', { turn: 1, step: 1, usage: { inputTokens: 1, outputTokens: 1 } }))
      .toThrow(/outside any open turn/)
    expect(() => session.append('error', { turn: 1, step: 1, message: 'boom' }))
      .toThrow(/outside any open turn/)
    // A PLUGIN-added (merge-extensible) event type is caught by the default too.
    expect(() => session.append('compaction/marker' as never, { foo: 'bar' } as never))
      .toThrow(/outside any open turn/)
  })

  it('accepts message events once a turn is open', async () => {
    const { ctx } = await setup({ freeze: false })
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    expect(() => session.append('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
      .not.toThrow()
  })

  it('rejects a tool/result with no prior tool/call', async () => {
    const { ctx } = await setup({ freeze: false })
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    expect(() => session.append('tool/result', { turn: 1, step: 1, callId: CallId('ghost'), content: [], isError: false }))
      .toThrow(/no prior tool\/call/)
  })

  it('allows a synthetic interrupted tool/result from crash repair without a prior tool/call event', async () => {
    const { ctx } = await setup({ freeze: false })
    const session = ctx.sessions.create()
    expect(() => {
      session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
      session.append('step/start', { turn: 1, step: 1 })
      session.append('assistant/message', { turn: 1, step: 1, content: [
        { type: 'tool-call', id: CallId('crashed'), name: 'bash', arguments: '{}' },
      ] })
      session.append('tool/result', {
        turn: 1,
        step: 1,
        callId: CallId('crashed'),
        content: [{ type: 'text', text: 'interrupted' }],
        isError: true,
        error: { name: 'InterruptedError', code: 'interrupted' },
      })
      session.append('step/end', { turn: 1, step: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } })
    }).not.toThrow()
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
    // A seq-contiguous, serializable seed (so it passes Session's constructor
    // validation) that nonetheless violates turn nesting — a second turn/start
    // while the first turn is still open — must be rejected by the invariants
    // plugin when it replays the seed on session/created.
    const badSeed = [
      { type: 'turn/start' as const, seq: 0, time: 0, data: { turn: 1, trigger: { kind: 'message' as const, source: { kind: 'user' as const } } } },
      { type: 'turn/start' as const, seq: 1, time: 0, data: { turn: 2, trigger: { kind: 'message' as const, source: { kind: 'user' as const } } } },
    ]
    expect(() => ctx.sessions.create(undefined, { seed: badSeed })).toThrow(InvariantError)
  })

  it('tracks turns per session independently', async () => {
    const { ctx } = await setup({ freeze: false })
    const a = ctx.sessions.create(SessionId('a'))
    const b = ctx.sessions.create(SessionId('b'))
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

  it('rejects a skipped turn number', async () => {
    const { ctx } = await setup({ freeze: false })
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(() => session.append('turn/start', { turn: 3, trigger: { kind: 'message', source: { kind: 'user' } } }))
      .toThrow(/expected turn 2, got 3/)
  })

  it('rejects a skipped step number within a turn', async () => {
    const { ctx } = await setup({ freeze: false })
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('step/end', { turn: 1, step: 1 })
    expect(() => session.append('step/start', { turn: 1, step: 3 }))
      .toThrow(/expected step 2 in turn 1, got 3/)
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
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    const event = session.append('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })
    expect(Object.isFrozen(event)).toBe(true)
    expect(Object.isFrozen(event.data)).toBe(true)
    expect(Object.isFrozen(event.data.content)).toBe(true)
    expect(() => { (event.data.content[0] as { text: string }).text = 'HACKED' }).toThrow()
  })

  it('does not freeze when freeze:false', async () => {
    const { ctx } = await setup({ freeze: false })
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    const event = session.append('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })
    expect(Object.isFrozen(event)).toBe(false)
  })

  it('freezes seeded events on session/created', async () => {
    const { ctx } = await setup()
    const seed = [
      { type: 'turn/start' as const, seq: 0, time: 0, data: { turn: 1, trigger: { kind: 'message' as const, source: { kind: 'user' as const } } } },
      { type: 'user/message' as const, seq: 1, time: 0, data: { content: [{ type: 'text' as const, text: 'seeded' }], source: { kind: 'user' as const } } },
    ]
    const session = ctx.sessions.create(undefined, { seed })
    expect(Object.isFrozen(session.events[0])).toBe(true)
  })

  it('freezes mutable descendants of a shallow-frozen event datum', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    // A caller hands in a SHALLOW-frozen block whose nested array is still
    // mutable. deepFreeze must descend into the already-frozen object and
    // freeze the descendant, not short-circuit on the frozen container —
    // otherwise dev-mode misses exactly the history mutation the dev-invariants RFC catches.
    // `append` snapshots `data`, so the freeze applies to the LOGGED clone, not
    // the caller's input — read the event back and assert on its data.
    const innerContent: { type: 'text'; text: string }[] = [{ type: 'text', text: 'inner' }]
    const block = Object.freeze({ type: 'tool-result' as const, toolCallId: CallId('c1'), content: innerContent, isError: false })
    const event = session.append('user/message', { content: [block], source: { kind: 'user' } })
    const logged = event.data.content[0] as { content: { type: 'text'; text: string }[] }
    expect(Object.isFrozen(logged.content)).toBe(true)
    expect(Object.isFrozen(logged.content[0])).toBe(true)
    expect(() => { logged.content.push({ type: 'text', text: 'mutation' }) }).toThrow()
  })

  it('terminates on a cyclic event datum (WeakSet guard)', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    // The deep-freeze WeakSet guard must terminate on a self-referential
    // structure rather than recursing forever. Session.append now rejects
    // non-serializable (incl. cyclic) data at the source, so drive the freeze
    // handler directly via hand-built session/events — exactly the shape the
    // invariants listener receives. Open a turn first (seq 0) so the cyclic
    // user/message (seq 1) satisfies the turn-enclosure invariant.
    ctx.emit('session/event', session, { type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } } as never)
    const cyclic: Record<string, unknown> = { type: 'text', text: 'x' }
    cyclic['self'] = cyclic
    const event = { type: 'user/message', seq: 1, time: 1, data: { content: [cyclic], source: { kind: 'user' } } }
    expect(() => { ctx.emit('session/event', session, event as never) }).not.toThrow()
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
