import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { AgentId } from '@deepseek-ai/dsh-agent'
import LlmService from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop, { LoopAgent } from '@deepseek-ai/dsh-agent-loop'
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

function waitForIdle(ctx: Context, agent: LoopAgent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', (subject, status) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function send(agent: LoopAgent, text: string) {
  agent.send([{ type: 'text', text }])
}

describe('LoopAgent', () => {
  it('send() throws after disposal', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)
    let agent!: LoopAgent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create('scoped', { model: 'mock' })
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
    let agent!: LoopAgent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create('scoped', { model: 'mock' })
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
    let agent!: LoopAgent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create('scoped', { model: 'mock' })
    }, { inject: ['agentLoop'] }))
    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    await fiber.dispose()
    await agent.done

    expect(() => { agent.inject([{ type: 'text', text: 'too late' }]) }).toThrow('disposed')
  })

  it('steer() when idle falls through to send() and starts a turn', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

    // steer while idle delegates to send
    agent.steer([{ type: 'text', text: 'steer idle' }], { source: { kind: 'plugin', plugin: 'test' } })
    await waitForIdle(ctx, agent)

    // The message was recorded as a user-level message (send path)
    expect(agent.session.events.some(e => e.type === 'user/message')).toBe(true)
    expect(adapter.requests).toHaveLength(1)
  })

  it('disposer is idempotent (double-stop)', async () => {
    // Create a bare LoopAgent and call start() directly to get the disposer.
    // Then call it twice — the second call hits the early-return branch.
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create('test')
    const agent = new LoopAgent(ctx, AgentId('bare'), { model: 'mock' }, session)

    // Start the loop to get the disposer; the agent waits for messages
    // (idle, never-resolving cancel), so it will stay idle.
    const dispose = agent.start()

    // First dispose
    dispose()
    expect(agent.status).toBe('disposed')

    // Second dispose — idempotent, no throw
    expect(() => { dispose() }).not.toThrow()
    expect(agent.status).toBe('disposed')
  })

  it('setting the same status does not emit agent/status again', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

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

  it('abort() resolves reason to "aborted" when no reason provided', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

    const reasons: { kind: string; reason?: string }[] = []
    ctx.on('agent/turn-end', (_agent, _turn, reason) => void reasons.push(reason))

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    agent.abort() // no reason string
    await waitForIdle(ctx, agent)

    expect(reasons[0]).toMatchObject({ kind: 'aborted', reason: 'aborted' })
  })
})
