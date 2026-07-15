import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as Invariants from '@deepseek-ai/dsh-invariants'
import { InvariantError } from '@deepseek-ai/dsh-invariants'

/** A Context with the session store and the invariants plugin registered. */
async function setup() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(Invariants)
  return { ctx, fiber }
}

/** A minimal Agent stand-in for agent/status emission. */
function mockAgent(id: string): Agent {
  return { id } as unknown as Agent
}

describe('session-log invariants', () => {
  it('keeps pre-commit staging and post-commit application global when mounted under a scope', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    let scopedCtx!: Context
    await ctx.plugin(Object.assign((inner: Context) => {
      scopedCtx = createScope(inner, {}).ctx
    }, { inject: ['sessions'] }))
    await scopedCtx.plugin(Invariants)
    const globalSession = ctx.sessions.create(SessionId('global-under-scoped-invariants'))

    expect(() => {
      globalSession.append('turn/start', {
        turn: 1,
        trigger: { kind: 'message', source: { kind: 'user' } },
      })
      globalSession.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    }).not.toThrow()
  })

  it('accepts a well-formed turn/step/tool sequence', async () => {
    const { ctx } = await setup()
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

  it('does not advance the trace when a later internal-dispatch listener vetoes', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create(SessionId('dispatch-veto-rollback'))
    let veto = true
    ctx.on('internal/dispatch', (_mode, name) => {
      if (name !== 'session/event' || !veto) return
      veto = false
      throw new Error('later dispatch veto')
    })

    expect(() => session.append('turn/start', {
      turn: 1,
      trigger: { kind: 'message', source: { kind: 'user' } },
    })).toThrow('later dispatch veto')
    expect(session.events).toEqual([])

    expect(() => {
      session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    }).not.toThrow()
    expect(session.events.map(event => event.type)).toEqual(['turn/start', 'turn/end'])
  })

  it('applies the committed transition after a prepended observer throws', async () => {
    const { ctx } = await setup()
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    const session = ctx.sessions.create(SessionId('postcommit-peer'))
    ctx.on('session/event', () => { throw new Error('hostile observer') }, { prepend: true })

    expect(() => {
      session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    }).not.toThrow()
    expect(session.events.map(event => event.type)).toEqual(['turn/start', 'turn/end'])
    expect(warnings).toEqual([
      'session "postcommit-peer": session/event listener threw: Error: hostile observer',
      'session "postcommit-peer": session/event listener threw: Error: hostile observer',
    ])
  })

  it('rejects a non-monotonic seq (replay spine)', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    // Session.append enforces seq-contiguity at the source, so drive the
    // invariants seq check directly via session/event with a regressing seq.
    ctx.emit(scopeTarget(session, undefined), 'session/event', session, { type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } } as never)
    expect(() => { ctx.emit(scopeTarget(session, undefined), 'session/event', session, { type: 'turn/end', seq: 0, time: 2, data: { turn: 1, reason: { kind: 'completed' } } } as never) })
      .toThrow(/seq must strictly increase/)
  })

  it('rejects a turn/start while another turn is open', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    expect(() => session.append('turn/start', { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } }))
      .toThrow(/turn 1 is still open/)
  })

  it('rejects a turn/end that does not match the open turn', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    expect(() => session.append('turn/end', { turn: 2, reason: { kind: 'completed' } }))
      .toThrow(/does not match open turn 1/)
  })

  it('rejects a step/start outside its declared turn', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    expect(() => session.append('step/start', { turn: 2, step: 1 })).toThrow(/open turn is 1/)
  })

  it('rejects a step/end that does not match the open step', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    expect(() => session.append('step/end', { turn: 1, step: 2 })).toThrow(/open is turn 1\/step 1/)
  })

  it('rejects an assistant/chunk outside an open step', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    expect(() => session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x' } }))
      .toThrow(/open is turn 1\/step null/)
  })

  it('rejects a message event appended outside any open turn (turn-enclosure)', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    // No turn open: every message-bearing event must be turn-enclosed (the turn-enclosure RFC).
    expect(() => session.append('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, { surfaceOp: 'append' }))
      .toThrow(/outside any open turn/)
    expect(() => session.append('context/message', { content: [{ type: 'text', text: 'ctx' }], source: { kind: 'user' } }, { surfaceOp: 'append' }))
      .toThrow(/outside any open turn/)
  })

  it('rejects steering and plugin-added events appended outside any open turn', async () => {
    const { ctx } = await setup()
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
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    expect(() => session.append('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, { surfaceOp: 'append' }))
      .not.toThrow()
  })

  it('rejects a tool/result with no prior tool/call', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    expect(() => session.append('tool/result', { turn: 1, step: 1, callId: CallId('ghost'), content: [], isError: false }, { surfaceOp: 'append' }))
      .toThrow(/no prior tool\/call/)
  })

  it('allows a synthetic interrupted tool/result from crash repair without a prior tool/call event', async () => {
    const { ctx } = await setup()
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
    const { ctx } = await setup()
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
    const { ctx } = await setup()
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
    const { ctx } = await setup()
    const a = ctx.sessions.create(SessionId('a'))
    const b = ctx.sessions.create(SessionId('b'))
    a.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    // b is a fresh session — its own turn/start must not see a's open turn.
    expect(() => b.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })).not.toThrow()
  })

  it('accepts multiple steps in a turn and consecutive turns', async () => {
    const { ctx } = await setup()
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
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(() => session.append('turn/start', { turn: 3, trigger: { kind: 'message', source: { kind: 'user' } } }))
      .toThrow(/expected turn 2, got 3/)
  })

  it('rejects a skipped step number within a turn', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('step/end', { turn: 1, step: 1 })
    expect(() => session.append('step/start', { turn: 1, step: 3 }))
      .toThrow(/expected step 2 in turn 1, got 3/)
  })

  it('rejects a turn/end while a step is still open', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    expect(() => session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }))
      .toThrow(/while step 1 is still open/)
  })

  it('rejects a step/start while a step is still open', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    expect(() => session.append('step/start', { turn: 1, step: 2 })).toThrow(/while step 1 is still open/)
  })

  it('rejects a tool/result satisfying a call from a previous step', async () => {
    const { ctx } = await setup()
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
    const { ctx } = await setup()
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
    const first = await ctx.plugin(Invariants)
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    await first.dispose()

    // Re-apply mid-step: the new fiber must reconstruct the open boundaries from the log.
    await ctx.plugin(Invariants)
    expect(() => session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'h' } }))
      .not.toThrow()
    // Rebuild must not disable later violations.
    expect(() => session.append('turn/start', { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } }))
      .toThrow(/turn 1 is still open/)
  })
})

describe('session immutability', () => {
  it('always freezes appended event data without the invariants plugin', () => {
    const session = new Session(SessionId('appended'))
    const event = session.append('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    expect(Object.isFrozen(event)).toBe(true)
    expect(Object.isFrozen(event.data)).toBe(true)
    expect(Object.isFrozen(event.data.content)).toBe(true)
    expect(Object.isFrozen(event.data.content[0])).toBe(true)
    expect(Object.isFrozen(session.events)).toBe(true)
    expect(() => { (event.data.content[0] as { text: string }).text = 'HACKED' }).toThrow()
  })

  it('always freezes seeded events without the invariants plugin', () => {
    const seed = [
      { type: 'turn/start' as const, seq: 0, time: 0, data: { turn: 1, trigger: { kind: 'message' as const, source: { kind: 'user' as const } } } },
      { type: 'user/message' as const, seq: 1, time: 0, data: { content: [{ type: 'text' as const, text: 'seeded' }], source: { kind: 'user' as const } }, surfaceOp: 'append' as const },
    ]
    const session = new Session(SessionId('seeded'), seed)
    expect(Object.isFrozen(seed[0])).toBe(false)
    expect(Object.isFrozen(session.events)).toBe(true)
    expect(Object.isFrozen(session.events[0])).toBe(true)
    expect(Object.isFrozen(session.events[0]?.data)).toBe(true)
    expect(Object.isFrozen(session.events[1]?.data)).toBe(true)
  })

  it('snapshots and freezes descendants of a shallow-frozen caller value', () => {
    const session = new Session(SessionId('shallow-frozen'))
    const innerContent: { type: 'text'; text: string }[] = [{ type: 'text', text: 'inner' }]
    const block = Object.freeze({ type: 'tool-result' as const, toolCallId: CallId('c1'), content: innerContent, isError: false })
    const event = session.append('user/message', { content: [block], source: { kind: 'user' } }, { surfaceOp: 'append' })
    const logged = event.data.content[0] as { content: { type: 'text'; text: string }[] }
    expect(Object.isFrozen(innerContent)).toBe(false)
    expect(Object.isFrozen(logged.content)).toBe(true)
    expect(Object.isFrozen(logged.content[0])).toBe(true)
    innerContent[0]!.text = 'caller mutation'
    expect(logged.content[0]!.text).toBe('inner')
    expect(() => { logged.content.push({ type: 'text', text: 'mutation' }) }).toThrow()
  })
})

describe('agent status invariants', () => {
  it('accepts legal transitions: idle→running→idle and →disposed', async () => {
    const { ctx } = await setup()
    const agent = mockAgent('a1')
    expect(() => {
      ctx.emit(scopeTarget(agent, agent), 'agent/status', agent, 'idle')
      ctx.emit(scopeTarget(agent, agent), 'agent/status', agent, 'running')
      ctx.emit(scopeTarget(agent, agent), 'agent/status', agent, 'idle')
      ctx.emit(scopeTarget(agent, agent), 'agent/status', agent, 'disposed')
    }).not.toThrow()
  })

  it('accepts running→disposed', async () => {
    const { ctx } = await setup()
    const agent = mockAgent('a2')
    ctx.emit(scopeTarget(agent, agent), 'agent/status', agent, 'running')
    expect(() => { ctx.emit(scopeTarget(agent, agent), 'agent/status', agent, 'disposed') }).not.toThrow()
  })

  it('rejects a no-op transition', async () => {
    const { ctx } = await setup()
    const agent = mockAgent('a3')
    ctx.emit(scopeTarget(agent, agent), 'agent/status', agent, 'running')
    expect(() => { ctx.emit(scopeTarget(agent, agent), 'agent/status', agent, 'running') }).toThrow(/no-op transition/)
  })

  it('rejects leaving the terminal disposed state', async () => {
    const { ctx } = await setup()
    const agent = mockAgent('a4')
    ctx.emit(scopeTarget(agent, agent), 'agent/status', agent, 'disposed')
    expect(() => { ctx.emit(scopeTarget(agent, agent), 'agent/status', agent, 'idle') }).toThrow(/left terminal state disposed/)
  })

  it('tracks status per agent independently', async () => {
    const { ctx } = await setup()
    const a = mockAgent('a5')
    const b = mockAgent('b5')
    ctx.emit(scopeTarget(a, a), 'agent/status', a, 'running')
    // b's first observation is independent of a.
    expect(() => { ctx.emit(scopeTarget(b, b), 'agent/status', b, 'running') }).not.toThrow()
  })
})

describe('HMR safety', () => {
  it('removes all listeners when the plugin fiber is disposed', async () => {
    const { ctx, fiber } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })

    await fiber.dispose()

    // After disposal the plugin's assertions are gone, so an event that would
    // violate the open-turn rule passes. Session still owns immutability.
    const event = session.append('turn/start', { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } })
    expect(Object.isFrozen(event)).toBe(true)
    // A no-op status transition no longer throws either.
    const agent = mockAgent('hmr')
    ctx.emit(scopeTarget(agent, agent), 'agent/status', agent, 'idle')
    expect(() => { ctx.emit(scopeTarget(agent, agent), 'agent/status', agent, 'idle') }).not.toThrow()
  })

  it('InvariantError carries a stable code', () => {
    const err = new InvariantError('seq must strictly increase')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('InvariantError')
    expect(err.code).toBe('INVARIANT')
    expect(err.message).toBe('invariant violated: seq must strictly increase')
  })

  it('does not leak listeners across dispose', async () => {
    const { ctx, fiber } = await setup()
    await fiber.dispose()
    const spy = vi.fn()
    ctx.on('session/event', spy)
    const session = ctx.sessions.create()
    session.append('user/message', { content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    // The spy proves events still flow after plugin disposal. Session, not the
    // disposed listener, freezes the accepted record.
    expect(spy).toHaveBeenCalledOnce()
    expect(Object.isFrozen(session.events[0])).toBe(true)
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
    // Create an impossible-through-public-API gap so seq 2 is earlier but unknown.
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    ;(session as unknown as { log: unknown[] }).log.push({
      type: 'assistant/chunk',
      seq: 3,
      time: Date.now(),
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x' } },
    })
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
    const { ctx } = await setup()
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
    // Session rejects this at its own acceptance boundary. Emit a hand-built
    // record to cover the listener's defensive check for alternate producers.
    const event = { type: 'turn/end', seq: 1, time: 1, data: { turn: 1, reason: { kind: 'completed' } }, sourceEventSeqs: [0] }
    expect(() => { ctx.emit(scopeTarget(session, undefined), 'session/event', session, event as never) })
      .toThrow(/cannot carry sourceEventSeqs/)
  })

  it('rejects surfaceOp on a non-surface event', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    const event = { type: 'turn/end', seq: 1, time: 1, data: { turn: 1, reason: { kind: 'completed' } }, surfaceOp: 'append' }
    expect(() => { ctx.emit(scopeTarget(session, undefined), 'session/event', session, event as never) })
      .toThrow(/cannot carry surfaceOp/)
  })
})

describe('request-reconstruction cross-check (llm/stream)', () => {
  /** Session with a boundary: one derivable user message, an open step, and the header event the loop would have logged. */
  async function requestSetup() {
    const { ctx } = await setup()
    const session = ctx.sessions.create(SessionId('req-check'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    const boundary = session.deriveMessages()
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', { header: { config: { model: 'm' } }, reason: 'initial' })
    return { ctx, session, boundary }
  }

  /** Dispatch the llm/stream waterfall with a stub core, collecting the check's verdict. */
  function dispatch(ctx: Context, options: unknown): void {
    // The invariants listener runs synchronously at dispatch time (its checks
    // precede next()); the stub core just yields nothing.
    void ctx.waterfall('llm/stream', options as never, () => (async function* () {})() as never)
  }

  it('passes a frozen request that equals the boundary derivation + the folded header', async () => {
    const { ctx, session, boundary } = await requestSetup()
    const options = Object.freeze({ model: 'm', messages: Object.freeze(boundary), sessionId: session.id })
    expect(() => { dispatch(ctx, options) }).not.toThrow()
  })

  it('is boundary-correct: content logged after step/start is legitimately absent from this request', async () => {
    const { ctx, session, boundary } = await requestSetup()
    // An agent/request-window inject: lands in the log after the boundary,
    // belongs to the NEXT request. A current-surface comparison would
    // false-fire here; the seq-bounded rebuild must not.
    session.append('context/message', { content: [{ type: 'text', text: '[late]' }], source: { kind: 'plugin', plugin: 'x' } }, { surfaceOp: 'append' })
    const options = Object.freeze({ model: 'm', messages: Object.freeze(boundary), sessionId: session.id })
    expect(() => { dispatch(ctx, options) }).not.toThrow()
  })

  it('expects the folded header\'s session prefix ahead of the derivation (prefix + derived)', async () => {
    const { ctx, session, boundary } = await requestSetup()
    const prefix = { role: 'user' as const, content: [{ type: 'text' as const, text: '<system-reminder>catalog</system-reminder>' }] }
    session.append('request/header-delta', { messagePrefix: [prefix] })
    // The prefixed request matches the fold…
    const prefixed = Object.freeze({ model: 'm', messages: Object.freeze([prefix, ...boundary]), sessionId: session.id })
    expect(() => { dispatch(ctx, prefixed) }).not.toThrow()
    // …a request that DROPPED the logged prefix diverges…
    const bare = Object.freeze({ model: 'm', messages: Object.freeze([...boundary]), sessionId: session.id })
    expect(() => { dispatch(ctx, bare) }).toThrow(/diverges from the boundary derivation/)
    // …and so does one that misplaced it (prefix sent after the history).
    const misplaced = Object.freeze({ model: 'm', messages: Object.freeze([...boundary, prefix]), sessionId: session.id })
    expect(() => { dispatch(ctx, misplaced) }).toThrow(/diverges from the boundary derivation/)
  })

  it('rejects a frozen request whose messages diverge from the boundary derivation', async () => {
    const { ctx, session, boundary } = await requestSetup()
    const messages = [...boundary, { role: 'user', content: [{ type: 'text', text: 'phantom' }] }]
    const options = Object.freeze({ model: 'm', messages: Object.freeze(messages), sessionId: session.id })
    expect(() => { dispatch(ctx, options) }).toThrow(/diverges from the boundary derivation/)
  })

  it('rejects a frozen request whose fields diverge from the folded header', async () => {
    const { ctx, session, boundary } = await requestSetup()
    const options = Object.freeze({ model: 'other', messages: Object.freeze(boundary), sessionId: session.id })
    expect(() => { dispatch(ctx, options) }).toThrow(/diverges from the folded request header/)
  })

  it('rejects a loop-built request with no header event or no step/start in its log', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create(SessionId('req-bare'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    const bare = Object.freeze({ model: 'm', messages: Object.freeze([]), sessionId: session.id })
    expect(() => { dispatch(ctx, bare) }).toThrow(/no step\/start/)

    session.append('step/start', { turn: 1, step: 1 })
    expect(() => { dispatch(ctx, bare) }).toThrow(/no request\/header event/)
  })

  it('rejects a frozen request carrying an unfrozen messages array', async () => {
    const { ctx, session, boundary } = await requestSetup()
    const options = Object.freeze({ model: 'm', messages: [...boundary], sessionId: session.id })
    expect(() => { dispatch(ctx, options) }).toThrow(/frozen messages array/)
  })

  it('skips hand-built (unfrozen) requests — compaction summarize is out of scope', async () => {
    const { ctx, session } = await requestSetup()
    // Unfrozen envelope + arbitrary messages: a direct one-shot call.
    const options = { model: 'summarizer', messages: [{ role: 'user', content: [{ type: 'text', text: 'summarize!' }] }], sessionId: session.id }
    expect(() => { dispatch(ctx, options) }).not.toThrow()
  })

  it('skips requests without a sessionId or with an unknown session', async () => {
    const { ctx } = await requestSetup()
    expect(() => { dispatch(ctx, Object.freeze({ model: 'm', messages: Object.freeze([]) })) }).not.toThrow()
    expect(() => { dispatch(ctx, Object.freeze({ model: 'm', messages: Object.freeze([]), sessionId: SessionId('ghost') })) }).not.toThrow()
  })
})

describe('request cross-check ordering (prepend)', () => {
  it('runs ahead of a short-circuiting llm/stream listener registered before it', async () => {
    // Replay short-circuits without next(), so the check prepends ahead of ordinary listeners;
    // correctness still comes from its sequence-bounded rebuild, not listener timing.
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.on('llm/stream', () => (async function* () {})() as never) // short-circuits, no next()
    await ctx.plugin(Invariants)

    const session = ctx.sessions.create(SessionId('prepend-check'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', { header: { config: { model: 'm' } }, reason: 'initial' })

    const divergent = Object.freeze({
      model: 'm',
      messages: Object.freeze([{ role: 'user', content: [{ type: 'text', text: 'phantom' }] }]),
      sessionId: session.id,
    })
    expect(() => {
      void ctx.waterfall('llm/stream', divergent as never, () => (async function* () {})() as never)
    }).toThrow(/diverges from the boundary derivation/)
  })
})

describe('scoped-dispatch invariants', () => {
  async function scopedCtx() {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(Invariants)
    return ctx
  }

  it('rejects a scoped-family dispatch without a carrier (teaching error)', async () => {
    const ctx = await scopedCtx()
    const agent = { id: 'a1' } as unknown as Agent
    expect(() => { ctx.emit('agent/error', agent, 1, 0, new Error('x')) })
      .toThrow(/dispatched without a scope carrier/)
  })

  it('accepts a matching carrier and rejects a mismatched one for EVERY agent-subject event', async () => {
    const ctx = await scopedCtx()
    // Real Session objects keep the synthetic Agent handles structurally valid.
    const agent = { id: 'a1', session: new Session(SessionId('a1-s')) } as unknown as Agent
    const other = { id: 'a2', session: new Session(SessionId('a2-s')) } as unknown as Agent
    // One dispatch per table row keeps every subject extractor covered: the
    // matching carrier passes, the foreign-keyed one throws.
    const rows: [string, unknown[]][] = [
      ['agent/created', [agent]],
      ['agent/disposed', [agent]],
      ['agent/status', [agent, 'idle']],
      ['agent/queued', [agent, [], { source: { kind: 'user' }, steering: false }]],
      ['agent/session-start', [agent, 'startup']],
      ['agent/pre-step', [agent, 1, 1, '', new AbortController().signal]],
      ['agent/prompt-submit', [agent, [], { kind: 'user' }, () => Promise.resolve({ kind: 'allow' })]],
      ['agent/request', [agent, 1, 1, { model: 'm' }, () => Promise.resolve({ model: 'm' })]],
      ['agent/session-prefix', [agent, [], new AbortController().signal, () => Promise.resolve([])]],
      ['agent/step-result', [agent, 1, 1, { role: 'assistant', content: [] }, () => Promise.resolve({ role: 'assistant', content: [] })]],
      ['agent/turn-continuation', [agent, 1, { action: 'stop' }, () => Promise.resolve({ action: 'stop' })]],
      ['agent/turn-stop', [agent, 1]],
      ['agent/error', [agent, 1, 0, new Error('x')]],
      ['approval/request', [{ agent, toolName: 'echo' }, () => Promise.resolve('unavailable')]],
      ['tools/pre-execute', [{ callId: 'c', name: 't', arguments: {}, agent }, () => Promise.resolve({ kind: 'allow' })]],
      ['tools/execute', [{ callId: 'c', name: 't', arguments: {}, agent }, () => Promise.resolve({ content: [], isError: false })]],
      ['tools/post-execute', [{ callId: 'c', name: 't', arguments: {}, agent }, { content: [], isError: false }, () => Promise.resolve({ kind: 'accept' })]],
      ['tools/result', [{ callId: 'c', name: 't', arguments: {}, agent }, { content: [], isError: false }]],
    ]
    for (const [event, args] of rows) {
      const subject = agent
      expect(() => { (ctx.emit as (...a: unknown[]) => void)(scopeTarget(agent, subject), event, ...args) },
        `${event} with matching carrier`).not.toThrow()
      expect(() => { (ctx.emit as (...a: unknown[]) => void)(scopeTarget(agent, other), event, ...args) },
        `${event} with foreign carrier`).toThrow(/DIFFERENT subject/)
    }
  })

  it('rejects a carrier keyed to a different subject than the arguments name', async () => {
    const ctx = await scopedCtx()
    const agent = { id: 'a1' } as unknown as Agent
    const other = { id: 'a2' } as unknown as Agent
    expect(() => { ctx.emit(scopeTarget(agent, other), 'agent/error', agent, 1, 0, new Error('x')) })
      .toThrow(/keyed to a DIFFERENT subject/)
    // The correct spelling passes.
    expect(() => { ctx.emit(scopeTarget(agent, agent), 'agent/error', agent, 1, 0, new Error('x')) })
      .not.toThrow()
  })

})
