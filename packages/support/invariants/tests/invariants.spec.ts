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
      session.append('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
      session.append('step/start', { turn: 1, step: 1 })
      session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'h' } })
      session.append('assistant/message', { turn: 1, step: 1, content: [{ type: 'tool-call', id: CallId('c1'), name: 'echo', arguments: '{}' }] }, { surfaceOp: 'append' })
      session.append('tool/call', { turn: 1, step: 1, callId: CallId('c1'), name: 'echo', arguments: '{}' })
      session.append('tool/result', { turn: 1, step: 1, callId: CallId('c1'), content: [{ type: 'text', text: 'ok' }], isError: false }, { surfaceOp: 'append' })
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
    expect(() => session.append('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, { surfaceOp: 'append' }))
      .toThrow(/outside any open turn/)
    expect(() => session.append('context/message', { content: [{ type: 'text', text: 'ctx' }], source: { kind: 'user' } }, { surfaceOp: 'append' }))
      .toThrow(/outside any open turn/)
  })

  it('rejects steering and plugin-added events appended outside any open turn', async () => {
    const { ctx } = await setup({ freeze: false })
    const session = ctx.sessions.create()
    // steering/message is turn-scoped: outside a turn it would land past the
    // commit boundary and be dropped on resume (the turn-enclosure RFC).
    expect(() => session.append('steering/message', { turn: 1, content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }, { surfaceOp: 'append' }))
      .toThrow(/outside any open turn/)
    // A PLUGIN-added (merge-extensible) event type is caught by the default too.
    // Cast through `any`: 'compaction/marker' is not in SessionEventType (it's
    // merge-extensible), so the typed append() won't accept it. The test verifies
    // the runtime default-branch turn-enclosure check.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return
    expect(() => (session.append as any)('compaction/marker', { foo: 'bar' }))
      .toThrow(/outside any open turn/)
  })

  it('accepts message events once a turn is open', async () => {
    const { ctx } = await setup({ freeze: false })
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    expect(() => session.append('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, { surfaceOp: 'append' }))
      .not.toThrow()
  })

  it('rejects a tool/result with no prior tool/call', async () => {
    const { ctx } = await setup({ freeze: false })
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    expect(() => session.append('tool/result', { turn: 1, step: 1, callId: CallId('ghost'), content: [], isError: false }, { surfaceOp: 'append' }))
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
      ] }, { surfaceOp: 'append' })
      session.append('tool/result', {
        turn: 1,
        step: 1,
        callId: CallId('crashed'),
        content: [{ type: 'text', text: 'interrupted' }],
        isError: true,
        error: { name: 'InterruptedError', code: 'interrupted' },
      }, { surfaceOp: 'append' })
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
      session.append('turn/end', { turn: 1, reason: { kind: 'error', step: 1, message: 'boom' } })
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
      session.append('assistant/message', { turn: 1, step: 1, content: [] }, { surfaceOp: 'append' })
      session.append('step/end', { turn: 1, step: 1 })
      session.append('step/start', { turn: 1, step: 2 })
      session.append('assistant/message', { turn: 1, step: 2, content: [] }, { surfaceOp: 'append' })
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
    expect(() => session.append('tool/result', { turn: 1, step: 2, callId: CallId('c1'), content: [], isError: false }, { surfaceOp: 'append' }))
      .toThrow(/no prior tool\/call in this step/)
  })

  it('rejects an assistant/message naming the wrong step', async () => {
    const { ctx } = await setup({ freeze: false })
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    expect(() => session.append('assistant/message', { turn: 1, step: 2, content: [] }, { surfaceOp: 'append' }))
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
    const event = session.append('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    expect(Object.isFrozen(event)).toBe(true)
    expect(Object.isFrozen(event.data)).toBe(true)
    expect(Object.isFrozen(event.data.content)).toBe(true)
    expect(() => { (event.data.content[0] as { text: string }).text = 'HACKED' }).toThrow()
  })

  it('does not freeze when freeze:false', async () => {
    const { ctx } = await setup({ freeze: false })
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    const event = session.append('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    expect(Object.isFrozen(event)).toBe(false)
  })

  it('freezes seeded events on session/created', async () => {
    const { ctx } = await setup()
    const seed = [
      { type: 'turn/start' as const, seq: 0, time: 0, data: { turn: 1, trigger: { kind: 'message' as const, source: { kind: 'user' as const } } } },
      { type: 'user/message' as const, seq: 1, time: 0, data: { content: [{ type: 'text' as const, text: 'seeded' }], source: { kind: 'user' as const } }, surfaceOp: 'append' as const },
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
    const event = session.append('user/message', { content: [block], source: { kind: 'user' } }, { surfaceOp: 'append' })
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
    session.append('user/message', { content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    // our own spy fires, proving events still flow — but the plugin's frozen.
    expect(spy).toHaveBeenCalledOnce()
    expect(Object.isFrozen(session.events[0])).toBe(false)
  })
})

describe('surface invariants', () => {
  it('accepts well-formed surface metadata', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    // Events must be turn-enclosed and step-scoped events need an open step.
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    expect(() => {
      session.append('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
      session.append('assistant/message', { turn: 1, step: 1, content: [] }, { surfaceOp: 'append', sourceEventSeqs: [1] })
    }).not.toThrow()
  })

  it('accepts replace surface op', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', { content: [{ type: 'text', text: 'a' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 1, step: 1, content: [] }, { surfaceOp: { op: 'replace', start: 2, end: 2 }, sourceEventSeqs: [2] })
    // no throw — well-formed replace op
  })

  it('rejects empty sourceEventSeqs', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    expect(() => {
      session.append('assistant/message', { turn: 1, step: 1, content: [] }, { surfaceOp: 'append', sourceEventSeqs: [] })
    }).toThrow(InvariantError)
  })

  it('rejects duplicate sourceEventSeqs', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('user/message', { content: [{ type: 'text', text: 'a' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    expect(() => {
      session.append('assistant/message', { turn: 1, step: 1, content: [] }, { surfaceOp: 'append', sourceEventSeqs: [1, 1] })
    }).toThrow(/must not contain duplicates/)
  })

  it('rejects sourceEventSeqs referencing the event itself (self-reference)', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } }) // seq 0
    // The next event is seq 1. Referencing its own seq fails on "must reference
    // earlier events" (the check order is: earlier first, then unknown).
    expect(() => {
      session.append('assistant/message', { turn: 1, step: 1, content: [] }, { surfaceOp: 'append', sourceEventSeqs: [1] })
    }).toThrow(/must reference earlier/)
  })

  it('accepts sourceEventSeqs referencing a valid earlier event', async () => {
    // Positive test: ref < current seq and ref is in knownSeqs → passes.
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    // seqs so far: 0, 1. The next event at seq 2 references seq 1 → valid.
    expect(() => {
      session.append('assistant/message', { turn: 1, step: 1, content: [] }, { surfaceOp: 'append', sourceEventSeqs: [1] })
    }).not.toThrow()
  })

  it('rejects sourceEventSeqs referencing a far-future seq', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    expect(() => {
      session.append('assistant/message', { turn: 1, step: 1, content: [] }, { surfaceOp: 'append', sourceEventSeqs: [99] })
    }).toThrow(/must reference earlier/)
  })

  it('rejects sourceEventSeqs referencing unknown seq (gap in event log)', async () => {
    // The unknown-seq check fires when a ref passes the "earlier" test but is
    // not in knownSeqs — only possible with a gap in seqs. We create a gap by
    // directly manipulating the private log array to skip a seq.
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    // Push a fake event at seq 3 into the internal log, creating a gap at seq 2.
    // The invariants plugin replays session.events on every append, so it sees
    // this gap during trace reconstruction.
    ;(session as unknown as { log: unknown[] }).log.push({
      type: 'assistant/chunk',
      seq: 3,
      time: Date.now(),
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x' } },
    })
    // Now the log has seqs 0, 1, 3 (gap at 2). Append at what session believes
    // is seq 3 (log.length). Reference seq 2: passes earlier (2 < 3) but not
    // in knownSeqs ({0, 1, 3} — gap at 2).
    expect(() => {
      session.append('assistant/message', { turn: 1, step: 1, content: [] }, { surfaceOp: 'append', sourceEventSeqs: [2] })
    }).toThrow(/unknown seq 2/)
  })

  it('rejects a replace whose start is positioned after its end on the surface', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', { content: [{ type: 'text', text: 'a' }], source: { kind: 'user' } }, { surfaceOp: 'append' }) // seq 2
    session.append('user/message', { content: [{ type: 'text', text: 'b' }], source: { kind: 'user' } }, { surfaceOp: 'append' }) // seq 3
    // Reversed range: start seq 3 is at a later surface position than end seq 2.
    expect(() => {
      session.append('assistant/message', { turn: 1, step: 1, content: [] }, { surfaceOp: { op: 'replace', start: 3, end: 2 }, sourceEventSeqs: [2, 3] })
    }).toThrow(/is after end seq 2 .* on the surface/)
  })

  it('rejects a replace whose sourceEventSeqs omits a shadowed surface node', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', { content: [{ type: 'text', text: 'a' }], source: { kind: 'user' } }, { surfaceOp: 'append' }) // seq 2
    session.append('user/message', { content: [{ type: 'text', text: 'b' }], source: { kind: 'user' } }, { surfaceOp: 'append' }) // seq 3
    // Replace shadows surface nodes [2, 3] but records provenance for only [2].
    expect(() => {
      session.append('assistant/message', { turn: 1, step: 1, content: [{ type: 'text', text: 'sum' }] }, { surfaceOp: { op: 'replace', start: 2, end: 3 }, sourceEventSeqs: [2] })
    }).toThrow(/must include every shadowed surface node; missing 3/)
  })

  it('accepts a replace whose sourceEventSeqs covers every shadowed surface node', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', { content: [{ type: 'text', text: 'a' }], source: { kind: 'user' } }, { surfaceOp: 'append' }) // seq 2
    session.append('user/message', { content: [{ type: 'text', text: 'b' }], source: { kind: 'user' } }, { surfaceOp: 'append' }) // seq 3
    expect(() => {
      session.append('assistant/message', { turn: 1, step: 1, content: [{ type: 'text', text: 'sum' }] }, { surfaceOp: { op: 'replace', start: 2, end: 3 }, sourceEventSeqs: [2, 3] })
    }).not.toThrow()
  })

  it('rejects a replace naming a start seq that is not on the surface', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', { content: [{ type: 'text', text: 'a' }], source: { kind: 'user' } }, { surfaceOp: 'append' }) // seq 2
    // seq 1 (step/start) is a real earlier event but never entered the surface.
    expect(() => {
      session.append('assistant/message', { turn: 1, step: 1, content: [] }, { surfaceOp: { op: 'replace', start: 1, end: 2 }, sourceEventSeqs: [1, 2] })
    }).toThrow(/start seq 1 is not on the surface/)
  })

  it('rejects a replace naming an end seq that is not on the surface', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', { content: [{ type: 'text', text: 'a' }], source: { kind: 'user' } }, { surfaceOp: 'append' }) // seq 2
    // start (2) is on the surface but end (99) never entered it.
    expect(() => {
      session.append('assistant/message', { turn: 1, step: 1, content: [] }, { surfaceOp: { op: 'replace', start: 2, end: 99 }, sourceEventSeqs: [2] })
    }).toThrow(/end seq 99 is not on the surface/)
  })

  it('rejects a replace whose range is reversed in surface position after a prior replace reordered it', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', { content: [{ type: 'text', text: 'a' }], source: { kind: 'user' } }, { surfaceOp: 'append' }) // seq 2
    session.append('user/message', { content: [{ type: 'text', text: 'b' }], source: { kind: 'user' } }, { surfaceOp: 'append' }) // seq 3
    // Replace node 2 (position 0) with seq 4 — surface is now [4, 3], so seq 4
    // precedes seq 3 in linked-list order even though 4 > 3 numerically.
    session.append('assistant/message', { turn: 1, step: 1, content: [{ type: 'text', text: 's' }] }, { surfaceOp: { op: 'replace', start: 2, end: 2 }, sourceEventSeqs: [2] }) // seq 4
    // A replace with start=3, end=4 passes the seq check (3 <= 4) but is
    // reversed positionally (3 is at pos 1, 4 is at pos 0).
    expect(() => {
      session.append('assistant/message', { turn: 1, step: 1, content: [] }, { surfaceOp: { op: 'replace', start: 3, end: 4 }, sourceEventSeqs: [3, 4] }) // seq 5
    }).toThrow(/is after end seq 4 .* on the surface/)
  })

  it('accepts a replace whose start seq exceeds its end seq when the surface position order is valid', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', { content: [{ type: 'text', text: 'a' }], source: { kind: 'user' } }, { surfaceOp: 'append' }) // seq 2
    session.append('user/message', { content: [{ type: 'text', text: 'b' }], source: { kind: 'user' } }, { surfaceOp: 'append' }) // seq 3
    // Replace node 2 (position 0) with seq 4 — surface becomes [4, 3], so the
    // head seq (4) is numerically GREATER than the tail seq (3): the surface is
    // not seq-ordered. A replace spanning start=4 (pos 0) … end=3 (pos 1) is
    // valid positionally and must be accepted even though start seq > end seq.
    session.append('assistant/message', { turn: 1, step: 1, content: [{ type: 'text', text: 's' }] }, { surfaceOp: { op: 'replace', start: 2, end: 2 }, sourceEventSeqs: [2] }) // seq 4
    expect(() => {
      session.append('assistant/message', { turn: 1, step: 1, content: [] }, { surfaceOp: { op: 'replace', start: 4, end: 3 }, sourceEventSeqs: [4, 3] }) // seq 5
    }).not.toThrow()
  })

  it('rejects a replace that omits sourceEventSeqs entirely', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', { content: [{ type: 'text', text: 'a' }], source: { kind: 'user' } }, { surfaceOp: 'append' }) // seq 2
    // A replace with no sourceEventSeqs records no provenance for the node it shadows.
    expect(() => {
      session.append('assistant/message', { turn: 1, step: 1, content: [] }, { surfaceOp: { op: 'replace', start: 2, end: 2 } })
    }).toThrow(/must include every shadowed surface node; missing 2/)
  })

  it('catches an incomplete-provenance replace on the load/seed path', async () => {
    const { ctx } = await setup({ freeze: false })
    const badSeed = [
      { type: 'turn/start' as const, seq: 0, time: 0, data: { turn: 1, trigger: { kind: 'message' as const, source: { kind: 'user' as const } } } },
      { type: 'step/start' as const, seq: 1, time: 0, data: { turn: 1, step: 1 } },
      { type: 'user/message' as const, seq: 2, time: 0, data: { content: [{ type: 'text' as const, text: 'a' }], source: { kind: 'user' as const } }, surfaceOp: 'append' as const },
      { type: 'user/message' as const, seq: 3, time: 0, data: { content: [{ type: 'text' as const, text: 'b' }], source: { kind: 'user' as const } }, surfaceOp: 'append' as const },
      { type: 'assistant/message' as const, seq: 4, time: 0, data: { turn: 1, step: 1, content: [{ type: 'text' as const, text: 'sum' }] }, surfaceOp: { op: 'replace' as const, start: 2, end: 3 }, sourceEventSeqs: [2] },
    ]
    expect(() => ctx.sessions.create(undefined, { seed: badSeed })).toThrow(/must include every shadowed surface node; missing 3/)
  })

  it('rejects sourceEventSeqs on a non-surface event', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    // Type system prevents surface metadata on non-surface events; this test
    // exercises the runtime guard against casts or persisted-data bypass.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return
    expect(() => (session.append as any)('turn/end', { turn: 1, reason: { kind: 'completed' } }, { sourceEventSeqs: [0] }))
      .toThrow(/cannot carry sourceEventSeqs/)
  })

  it('rejects surfaceOp on a non-surface event', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return
    expect(() => (session.append as any)('turn/end', { turn: 1, reason: { kind: 'completed' } }, { surfaceOp: 'append' }))
      .toThrow(/cannot carry surfaceOp/)
  })
})
