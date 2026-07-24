import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import LlmService from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { bindReactLoopAgentContext, prepareReactLoopAgent } from '../src/agent.ts'
import { MockAdapter, textResponse } from './mock-adapter.ts'

function driverDone(agent: Agent): Promise<void> {
  return (agent as Agent & { done: Promise<void> }).done
}

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

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', (subject, status) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function waitForStatus(ctx: Context, agent: Agent, expected: Agent['status']): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', (subject, status) => {
      if (subject === agent && status === expected) {
        dispose()
        resolve()
      }
    })
  })
}

function send(agent: Agent, text: string) {
  agent.followup([{ type: 'text', text }])
}

describe('Agent', () => {
  it('rejects access before context binding and a second driver for one session', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('exclusive-driver'))
    const prepared = prepareReactLoopAgent(
      ctx, SessionId('first-driver'), { provider: 'mock', model: 'mock' }, session,
    )

    expect(() => prepared.agent.ctx).toThrow('context is not bound')
    expect(() => prepareReactLoopAgent(
      ctx, SessionId('second-driver'), { provider: 'mock', model: 'mock' }, session,
    ))
      .toThrow('already has a concrete agent driver')

    await prepared.dispose()
    await ctx.fiber.dispose()
  })

  it('borrows caller options and binds its scoped context exactly once', async () => {
    const ctx = await harness(new MockAdapter([textResponse('unused')]))
    const options = { provider: 'mock', model: 'mock' }
    const agent = ctx.agentLoop.create(SessionId('owned-bindings'), options)

    expect(agent.options).toBe(options)
    expect(agent.id).toBe('owned-bindings')
    expect(agent.session.id).toBe(agent.id)
    expect(() => { bindReactLoopAgentContext(agent, new Context()) }).toThrow(/context is already bound/)

    await ctx.fiber.dispose()
  })

  it('idle inject() appends context without opening a turn or requesting a flush', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    let flushes = 0
    ctx.on('session/flush', () => { flushes += 1 })

    agent.inject([{ type: 'text', text: 'context' }], { source: { kind: 'plugin', plugin: 'p' } })
    expect(agent.session.events.map(event => event.type)).toEqual(['user/message'])
    expect(agent.status).toBe('idle')
    expect(adapter.requests).toHaveLength(0)
    await agent.whenIdle()
    expect(flushes).toBe(0)
  })

  it('inject() defaults its source to an empty plugin, never user', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.inject([{ type: 'text', text: 'no explicit source' }])
    const injected = agent.session.events.at(-1)!
    expect(injected.type === 'user/message' && injected.data.source).toEqual({ kind: 'plugin', plugin: '' })
    await agent.whenIdle()
  })

  it('idle inject() rejects invalid input before append', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    expect(() => {
      agent.inject([{ type: 'text', text: 'x', bad: 1n } as never], { source: { kind: 'plugin', plugin: 'p' } })
    }).toThrow(/non-JSON-serializable/)
    expect(agent.session.events).toHaveLength(0)
  })

  it('steer() when idle falls through to send() and starts a turn', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    // steer while idle delegates to send
    agent.steer([{ type: 'text', text: 'steer idle' }], { source: { kind: 'plugin', plugin: 'test' } })
    await waitForIdle(ctx, agent)

    // The message was recorded as a user-level message (send path)
    expect(agent.session.events.some(e => e.type === 'user/message')).toBe(true)
    expect(adapter.requests).toHaveLength(1)
  })

  it('disposer is idempotent (double-stop)', async () => {
    // Create a bare Agent and start it through the package-internal
    // test seam. Then call its disposer twice — the second call hits the
    // early-return branch.
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const session = ctx.sessions.create(SessionId('test'))
    const prepared = prepareReactLoopAgent(
      ctx, SessionId('bare'), { provider: 'mock', model: 'mock' }, session,
    )
    const { agent } = prepared

    // Start the loop to get the disposer; the agent waits for messages
    // (idle, never-resolving cancel), so it will stay idle.
    prepared.markPublished()
    prepared.start()
    const dispose = prepared.dispose

    // First dispose
    const firstDisposal = dispose()
    expect(agent.status).toBe('disposed')
    await firstDisposal

    // Second dispose — idempotent, no throw
    await expect(dispose()).resolves.toBeUndefined()
    expect(agent.status).toBe('disposed')
  })

  it('a pre-start disposal makes a later driver-start attempt inert', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('pre-start-dispose'))
    const prepared = prepareReactLoopAgent(
      ctx, SessionId('pre-start-dispose'), { provider: 'mock', model: 'mock' }, session,
    )

    await prepared.dispose()
    expect(prepared.agent.status).toBe('disposed')
    prepared.start()
    const dispose = prepared.dispose
    await dispose()
    await expect(prepared.agent.done).resolves.toBeUndefined()
    expect(prepared.agent.session.events).toEqual([])
    await ctx.fiber.dispose()
  })

  it('setting the same status does not emit agent/status again', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

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
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    // Fresh agent is idle — whenIdle() takes the not-running fast path and
    // resolves without subscribing. await must not hang.
    await agent.whenIdle()
    expect(agent.status).not.toBe('running')
  })

  it('whenIdle() waits for queued work that has not flipped status yet', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'queued')
    let settled = false
    const idle = agent.whenIdle().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    await waitForStatus(ctx, agent, 'running')
    agent.cancel({ kind: 'user' })
    await idle
    expect(settled).toBe(true)
    expect(agent.status).toBe('idle')
  })

  it('whenIdle() awaits the running→idle transition, ignoring other subjects/running events', async () => {
    const adapter = new MockAdapter([textResponse('ok'), textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    const other = ctx.agentLoop.create(SessionId('a2'), { provider: 'mock', model: 'mock' })

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
    // Covers the waiter's disposed arm: whenIdle() queues an internal waiter
    // while running (not the fast path), then the disposer settles it and chains
    // `done` (loop exit), not an eager resolve. A bare Agent + direct
    // internal driver disposer keeps the emit synchronous.
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
      ctx, SessionId('bare'), { provider: 'mock', model: 'mock' }, session,
    )
    const { agent } = prepared
    prepared.markPublished()
    prepared.start()
    const dispose = prepared.dispose
    agent.followup([{ type: 'text', text: 'go' }])
    await new Promise(r => setTimeout(r, 30))
    expect(agent.status).toBe('running')

    const idle = agent.whenIdle() // queues an internal waiter (running)
    const disposal = dispose() // settles the waiter synchronously; whenIdle chains done
    await idle
    expect(agent.status).toBe('disposed')
    await disposal
  })

  it('whenIdle() subscribed while running survives a FIBER dispose (no hung promise)', async () => {
    // The waiter is internal agent state, NOT an effect-scoped ctx.on listener:
    // disposing the OWNING fiber runs the agent's listener disposers, which would
    // have dropped a ctx.on-based waiter before the 'disposed' transition and
    // hung the promise. With internal waiters, the fiber disposer still settles it.
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)
    let agent!: Agent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create(SessionId('scoped'), { provider: 'mock', model: 'mock' })
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
    // The disposer emits agent/status('disposed') BEFORE the driver loop
    // unwinds, so whenIdle() must chain `done` (true quiescence) on the
    // disposed path. Dispose a running agent, then assert whenIdle() resolves
    // only after `done` — i.e. the loop has actually exited.
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)
    let agent!: Agent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create(SessionId('scoped'), { provider: 'mock', model: 'mock' })
    }, { inject: ['agentLoop'] }))
    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))

    let doneResolved = false
    void driverDone(agent).then(() => { doneResolved = true })
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
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
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
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
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
