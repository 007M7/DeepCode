import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { AgentId } from '@deepseek-ai/dsh-agent'
import LlmService from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop, { DEFAULT_MAX_PARALLEL_TOOL_CALLS, ReactLoopAgent } from '@deepseek-ai/dsh-agent-loop'
import { bindReactLoopAgentContext, prepareReactLoopAgent } from '../src/agent.ts'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter) {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: ReactLoopAgent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', (subject, status) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function waitForStatus(ctx: Context, agent: ReactLoopAgent, expected: ReactLoopAgent['status']): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', (subject, status) => {
      if (subject === agent && status === expected) {
        dispose()
        resolve()
      }
    })
  })
}

function send(agent: ReactLoopAgent, text: string) {
  agent.send([{ type: 'text', text }])
}

describe('ReactLoopAgent', () => {
  it('rejects access before context binding and a second driver for one session', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('exclusive-driver'))
    const prepared = prepareReactLoopAgent(
      ctx, AgentId('first-driver'), { provider: 'mock', model: 'mock' }, session, DEFAULT_MAX_PARALLEL_TOOL_CALLS,
    )

    expect(() => prepared.agent.ctx).toThrow('context is not bound')
    expect(() => prepareReactLoopAgent(
      ctx, AgentId('second-driver'), { provider: 'mock', model: 'mock' }, session, DEFAULT_MAX_PARALLEL_TOOL_CALLS,
    ))
      .toThrow('already has a concrete agent driver')

    await prepared.dispose()
    await ctx.fiber.dispose()
  })

  it('borrows caller options and binds its scoped context exactly once', async () => {
    const ctx = await harness(new MockAdapter([textResponse('unused')]))
    const options = { provider: 'mock', model: 'mock' }
    const agent = ctx.agentLoop.create(AgentId('owned-bindings'), options)

    expect(agent.options).toBe(options)
    expect(agent.id).toBe('owned-bindings')
    expect(agent.session.id).toMatch(/^owned-bindings-session-/)
    expect(() => { bindReactLoopAgentContext(agent, new Context()) }).toThrow(/context is already bound/)

    await ctx.fiber.dispose()
  })

  it('send() throws after disposal', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)
    let agent!: ReactLoopAgent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create(AgentId('scoped'), { provider: 'mock', model: 'mock' })
    }, { inject: ['agentLoop'] }))
    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    await fiber.dispose()
    await agent.done

    expect(() => { agent.send([{ type: 'text', text: 'too late' }]) }).toThrow('disposed')
  })

  it('steer() throws after disposal', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)
    let agent!: ReactLoopAgent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create(AgentId('scoped'), { provider: 'mock', model: 'mock' })
    }, { inject: ['agentLoop'] }))
    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    await fiber.dispose()
    await agent.done

    expect(() => { agent.steer([{ type: 'text', text: 'too late' }]) }).toThrow('disposed')
  })

  it('inject() throws after disposal', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)
    let agent!: ReactLoopAgent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create(AgentId('scoped'), { provider: 'mock', model: 'mock' })
    }, { inject: ['agentLoop'] }))
    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    await fiber.dispose()
    await agent.done

    expect(() => { agent.inject([{ type: 'text', text: 'too late' }]) }).toThrow('disposed')
  })

  it('inject() decides enclosure from the LOG (open turn), not agent status', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { provider: 'mock', model: 'mock' })

    // Simulate an OPEN turn in the log while the agent is idle (status is not a
    // reliable open-turn signal). inject must append into that open turn, NOT
    // wrap a new one.
    agent.session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    agent.inject([{ type: 'text', text: 'mid' }], { source: { kind: 'plugin', plugin: 'p' } })
    expect(agent.session.events.filter(e => e.type === 'turn/start')).toHaveLength(1)
    expect(agent.session.events.at(-1)!.type).toBe('context/message')

    // Close the turn; now inject must wrap its own one-shot injection turn.
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    agent.inject([{ type: 'text', text: 'after' }], { source: { kind: 'plugin', plugin: 'p' } })
    const starts = agent.session.events.filter(e => e.type === 'turn/start')
    expect(starts).toHaveLength(2)
    const last = starts[1]!
    expect(last.type === 'turn/start' && last.data.trigger.kind).toBe('injection')
    expect(agent.session.events.at(-1)!.type).toBe('turn/end') // turn-enclosed
  })

  it('idle inject() contains a failing flush (logs, does not throw into the caller)', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    // A persistence-like listener whose flush rejects.
    ctx.on('session/flush', () => { throw new Error('disk gone') })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const agent = ctx.agentLoop.create(AgentId('a1'), { provider: 'mock', model: 'mock' })

    // inject() is synchronous and fires a fire-and-forget flush; a rejecting
    // flush must be contained (logged), never thrown into the caller.
    expect(() => { agent.inject([{ type: 'text', text: 'notice' }], { source: { kind: 'plugin', plugin: 'p' } }) }).not.toThrow()
    await new Promise(r => setTimeout(r, 20)) // let the contained flush settle
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('flush after idle injection failed'))
    warn.mockRestore()
  })

  it('idle inject() closes its one-shot turn AND still checkpoints even if the append throws', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { provider: 'mock', model: 'mock' })
    let flushes = 0
    ctx.on('session/flush', () => { flushes += 1 })

    // Invalid injected content throws after turn/start. `finally` must still append turn/end and
    // flush the balanced in-memory turn so a crash cannot lose it before the next checkpoint.
    expect(() => {
      agent.inject([{ type: 'text', text: 'x', bad: 1n } as never], { source: { kind: 'plugin', plugin: 'p' } })
    }).toThrow(/non-JSON-serializable/)
    const types = agent.session.events.map(e => e.type)
    expect(types).toEqual(['turn/start', 'turn/end']) // balanced, no open turn
    await new Promise(r => setTimeout(r, 10)) // let the fire-and-forget flush run
    expect(flushes).toBe(1) // checkpoint fired despite the throw
  })

  it('idle inject() still checkpoints when a listener throws on the synthetic turn/end', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { provider: 'mock', model: 'mock' })
    let flushes = 0
    ctx.on('session/flush', () => { flushes += 1 })
    // Session contains a throwing post-commit turn/end observer. The accepted
    // boundary still triggers the idle injection's durability checkpoint.
    let threw = false
    ctx.on('session/event', (_s, event) => {
      if (!threw && event.type === 'turn/end') { threw = true; throw new Error('boom turn/end') }
    })

    expect(() => { agent.inject([{ type: 'text', text: 'notice' }], { source: { kind: 'plugin', plugin: 'p' } }) }).not.toThrow()
    const types = agent.session.events.map(e => e.type)
    expect(types).toEqual(['turn/start', 'context/message', 'turn/end']) // balanced
    await new Promise(r => setTimeout(r, 10))
    expect(flushes).toBe(1) // checkpoint fired despite the throwing turn/end listener
  })

  it('idle inject() reports a failing flush via agent/error (step 0) AND the logger', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    // A non-Error rejection exercises the String() normalization branch.
    ctx.on('session/flush', () => { throw 'disk gone' })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const agent = ctx.agentLoop.create(AgentId('a1'), { provider: 'mock', model: 'mock' })
    const errors: { turn: number; step: number; message: string }[] = []
    ctx.on('agent/error', (_a, turn, step, error) => void errors.push({ turn, step, message: error.message }))

    agent.inject([{ type: 'text', text: 'notice' }], { source: { kind: 'plugin', plugin: 'p' } })
    await new Promise(r => setTimeout(r, 20)) // let the contained flush settle

    // Reported via agent/error (step 0 — the idle-injection convention) so
    // plugins monitoring agent/error see idle-injection persistence failures,
    // mirroring the loop's post-turn/end flush path. A non-Error throw is
    // normalized to an Error.
    expect(errors).toEqual([{ turn: 1, step: 0, message: 'disk gone' }])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('flush after idle injection failed'))
    warn.mockRestore()
  })

  it('idle inject() with a non-serializable source opens no turn (nothing to close)', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { provider: 'mock', model: 'mock' })

    // A non-serializable source makes the turn/start append throw BEFORE the
    // event is pushed (Session.append validates before push), so NO turn opens.
    // The finally's isTurnOpen() guard sees no open turn and appends nothing —
    // the log stays empty, not left with a dangling turn/start.
    expect(() => {
      agent.inject([{ type: 'text', text: 'x' }], { source: { kind: 'plugin', plugin: 'p', bad: 1n } as never })
    }).toThrow(/non-JSON-serializable/)
    expect(agent.session.events).toHaveLength(0)
  })

  it('steer() when idle falls through to send() and starts a turn', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { provider: 'mock', model: 'mock' })

    // steer while idle delegates to send
    agent.steer([{ type: 'text', text: 'steer idle' }], { source: { kind: 'plugin', plugin: 'test' } })
    await waitForIdle(ctx, agent)

    // The message was recorded as a user-level message (send path)
    expect(agent.session.events.some(e => e.type === 'user/message')).toBe(true)
    expect(adapter.requests).toHaveLength(1)
  })

  it('disposer is idempotent (double-stop)', async () => {
    // The internal start seam exposes one idle driver's disposer for repeated invocation.
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('test'))
    const prepared = prepareReactLoopAgent(
      ctx, AgentId('bare'), { provider: 'mock', model: 'mock' }, session, DEFAULT_MAX_PARALLEL_TOOL_CALLS,
    )
    const { agent } = prepared

    prepared.markPublished()
    const dispose = prepared.startDriver()

    const firstDisposal = dispose()
    expect(agent.status).toBe('disposed')
    await firstDisposal

    await expect(dispose()).resolves.toBeUndefined()
    expect(agent.status).toBe('disposed')
  })

  it('a pre-start disposal makes a later driver-start attempt inert', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('pre-start-dispose'))
    const prepared = prepareReactLoopAgent(
      ctx, AgentId('pre-start-dispose'), { provider: 'mock', model: 'mock' }, session, DEFAULT_MAX_PARALLEL_TOOL_CALLS,
    )

    await prepared.dispose()
    expect(prepared.agent.status).toBe('disposed')
    const dispose = prepared.startDriver()
    await dispose()
    await expect(prepared.agent.done).resolves.toBeUndefined()
    expect(prepared.agent.session.events).toEqual([])
    await ctx.fiber.dispose()
  })

  it('setting the same status does not emit agent/status again', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { provider: 'mock', model: 'mock' })

    const statuses: string[] = []
    ctx.on('agent/status', (subject, status) => {
      if (subject === agent) statuses.push(status)
    })

    send(agent, 'hi')
    await waitForIdle(ctx, agent)

    // After the turn, agent is idle. Send again to trigger another attempt
    // to go idle — but it's already idle, so no emission.
    const idleTransitionCount = statuses.filter(s => s === 'idle').length
    expect(idleTransitionCount).toBe(1) // only the final transition from running
  })

  it('whenIdle() resolves immediately when the agent is not running', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { provider: 'mock', model: 'mock' })

    // Fresh agent is idle — whenIdle() takes the not-running fast path and
    // resolves without subscribing. await must not hang.
    await agent.whenIdle()
    expect(agent.status).not.toBe('running')
  })

  it('whenIdle() waits for queued work that has not flipped status yet', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'queued')
    let settled = false
    const idle = agent.whenIdle().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    await waitForStatus(ctx, agent, 'running')
    agent.cancel('done')
    await idle
    expect(settled).toBe(true)
    expect(agent.status).toBe('idle')
  })

  it('whenIdle() awaits the running→idle transition, ignoring other subjects/running events', async () => {
    const adapter = new MockAdapter([textResponse('ok'), textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { provider: 'mock', model: 'mock' })
    const other = ctx.agentLoop.create(AgentId('a2'), { provider: 'mock', model: 'mock' })

    // Drive `agent` into `running`, then await whenIdle() — it subscribes to
    // agent/status and resolves on the first transition out of running.
    const running = new Promise<void>((resolve) => {
      const dispose = ctx.on('agent/status', (subject, status) => {
        if (subject === agent && status === 'running') { dispose(); resolve() }
      })
    })
    send(agent, 'go')
    await running
    expect(agent.status).toBe('running')

    // While `agent`'s whenIdle is pending, churn `other` through running→idle:
    // every status event it emits hits whenIdle's guard with `subject !== this`,
    // so the wait must ignore them and only resolve on `agent`'s own idle.
    send(other, 'go')

    await agent.whenIdle()
    expect(agent.status).toBe('idle')
  })

  it('whenIdle() subscribed while running resolves via done when the agent is then disposed', async () => {
    // Queue the internal waiter while running, then dispose the bare driver. Its disposed branch
    // must chain the loop's `done` promise rather than resolve before exit.
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    const adapter = new MockAdapter(['hang'])
    ctx.llm.registerAdapter(['mock'], adapter)
    const session = ctx.sessions.create(SessionId('bare'))
    const prepared = prepareReactLoopAgent(
      ctx, AgentId('bare'), { provider: 'mock', model: 'mock' }, session, DEFAULT_MAX_PARALLEL_TOOL_CALLS,
    )
    const { agent } = prepared
    prepared.markPublished()
    const dispose = prepared.startDriver()
    agent.send([{ type: 'text', text: 'go' }])
    await new Promise(r => setTimeout(r, 30))
    expect(agent.status).toBe('running')

    const idle = agent.whenIdle() // queues an internal waiter (running)
    const disposal = dispose() // settles the waiter synchronously; whenIdle chains done
    await idle
    expect(agent.status).toBe('disposed')
    await disposal
  })

  it('whenIdle() subscribed while running survives a FIBER dispose (no hung promise)', async () => {
    // The waiter is agent-owned state, not an effect-scoped listener that owner disposal would
    // remove before the disposed transition. Fiber teardown must still settle it.
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)
    let agent!: ReactLoopAgent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create(AgentId('scoped'), { provider: 'mock', model: 'mock' })
    }, { inject: ['agentLoop'] }))
    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    expect(agent.status).toBe('running')

    const idle = agent.whenIdle() // queued while running
    await fiber.dispose()         // tears the fiber down (drops agent listeners)
    await idle                    // must resolve, not hang
    expect(agent.status).toBe('disposed')
  })

  it('whenIdle() on a disposed agent awaits the loop exit (done), not just the status flip', async () => {
    // Disposed status is emitted before the driver unwinds. `whenIdle()` must chain `done` so it
    // resolves only after true loop exit.
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)
    let agent!: ReactLoopAgent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create(AgentId('scoped'), { provider: 'mock', model: 'mock' })
    }, { inject: ['agentLoop'] }))
    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))

    let doneResolved = false
    void agent.done.then(() => { doneResolved = true })
    await fiber.dispose() // sets status disposed, aborts, drains the loop
    expect(agent.status).toBe('disposed')

    // whenIdle() must not resolve before `done` has — chaining `done` is the
    // quiescence guarantee. By here dispose() awaited the loop, so done is
    // settled; whenIdle resolves and done is observed resolved.
    await agent.whenIdle()
    expect(doneResolved).toBe(true)
  })

  it('contains a throwing agent/status listener on the running transition', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const agent = ctx.agentLoop.create(AgentId('a1'), { provider: 'mock', model: 'mock' })
    ctx.on('agent/status', (_subject, status) => {
      if (status === 'running') throw new Error('bad running listener')
    })

    send(agent, 'go')
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(agent.status).toBe('idle')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('agent event "agent/status" listener threw'))
    warn.mockRestore()
  })

  it('contains a throwing agent/status listener on the idle transition', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const agent = ctx.agentLoop.create(AgentId('a1'), { provider: 'mock', model: 'mock' })
    ctx.on('agent/status', (_subject, status) => {
      if (status === 'idle') throw new Error('bad idle listener')
    })

    send(agent, 'go')
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(agent.status).toBe('idle')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('agent event "agent/status" listener threw'))
    warn.mockRestore()
  })
})
