import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LlmService, { CallId, LlmError, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'

import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

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

function send(agent: Agent, text: string) {
  agent.followup([{ type: 'text', text }])
}

describe('inbox acceptance', () => {
  it('rejects non-serializable content or source synchronously before notification or enqueue', async () => {
    const adapter = new MockAdapter([textResponse('turn 1')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    let queued = 0
    ctx.on('agent/inbox/enqueue', () => { queued += 1 })

    expect(() => {
      agent.followup([{ type: 'text', text: 'first', bad: 1n } as never])
    }).toThrow(/losslessly JSON-serializable/)
    expect(() => {
      agent.followup([{ type: 'text', text: 'first' }], { source: { kind: 'plugin', plugin: 'p', bad: 1n } as never })
    }).toThrow(/losslessly JSON-serializable/)
    expect(queued).toBe(0)
    expect(agent.session.events).toHaveLength(0)

    // The rejected value never woke or poisoned the loop; a valid message runs.
    send(agent, 'second')
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1)
  })
})

describe('tool JSON parse', () => {
  it('passes through non-JSON arguments string without crashing', async () => {
    const adapter = new MockAdapter([
      // model emits tool-call with malformed arguments (not valid JSON)
      [
        { type: 'block-start' as const, index: 0, blockType: 'tool-call' as const },
        { type: 'block-end' as const, index: 0, block: { type: 'tool-call' as const, id: CallId('c1'), name: 'echo', arguments: 'not json' } },
        { type: 'finish' as const, reason: { kind: 'tool-calls' as const } },
      ] satisfies StreamChunk[],
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'echo tool',
      parameters: { input: { type: 'string' } },
      async execute(args: unknown) {
        return [{ type: 'text', text: typeof args === 'string' ? `raw: ${args}` : JSON.stringify(args) }]
      },
    }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'use tool')
    await waitForIdle(ctx, agent)

    // tool/call event should have recorded the raw arguments string
    const callEvent = agent.session.events.find(e => e.type === 'tool/call')
    expect(callEvent).toBeDefined()
    if (callEvent!.type === 'tool/call') {
      expect(callEvent!.data.arguments).toBe('not json')
    }
    // the loop did not crash — a result was produced
    expect(agent.session.events.some(e => e.type === 'tool/result')).toBe(true)
  })

  it('uses empty object when tool-call arguments are empty string', async () => {
    const adapter = new MockAdapter([
      [
        { type: 'block-start' as const, index: 0, blockType: 'tool-call' as const },
        { type: 'block-end' as const, index: 0, block: { type: 'tool-call' as const, id: CallId('c1'), name: 'noarg', arguments: '' } },
        { type: 'finish' as const, reason: { kind: 'tool-calls' as const } },
      ] satisfies StreamChunk[],
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'noarg',
      description: 'no-arg tool',
      parameters: {},
      async execute() {
        return [{ type: 'text', text: 'ran with empty args' }]
      },
    }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'use tool')
    await waitForIdle(ctx, agent)

    expect(agent.session.events.some(e => e.type === 'tool/result')).toBe(true)
  })
})

describe('toError normalization', () => {
  it('normalizes non-Error throws from pre-commit dispatch validation via the runLoop backstop', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    let threwOnce = false
    ctx.on('internal/dispatch', (_mode, name, args) => {
      if (name !== 'session/event') return
      const event = args[1] as SessionEvent
      if (event.type === 'turn/start' && !threwOnce) {
        threwOnce = true
        throw 'naked string error' // non-Error throw, normalized via toError
      }
    })

    const errors: Error[] = []
    ctx.on('agent/error', (_agent, _turn, _step, error) => void errors.push(error))

    send(agent, 'fails before turn start')
    send(agent, 'survives as the next item')
    await waitForIdle(ctx, agent)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ message: 'naked string error', code: 'UNKNOWN' })
    expect(adapter.requests).toHaveLength(1)
    const starts = agent.session.events.filter(event => event.type === 'turn/start')
    const ends = agent.session.events.filter(event => event.type === 'turn/end')
    const messages = agent.session.events.filter(event => event.type === 'user/message')
    expect(starts).toHaveLength(1)
    expect(starts[0]?.type === 'turn/start' && starts[0].data.turn).toBe(1)
    expect(ends).toHaveLength(1)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.type === 'user/message' && messages[0].data.content).toEqual([
      { type: 'text', text: 'survives as the next item' },
    ])
  })

  it('normalizes non-Error throws from agent/request waterfall via inline toError in runStep catch', async () => {
    const adapter = new MockAdapter([textResponse('irrelevant')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    let threwOnce = false
    ctx.on('agent/request', async (_agent, _turn, _step, _options, _signal, _next) => {
      if (!threwOnce) {
        threwOnce = true
        throw { code: 500 } // non-Error throw, goes through runStep catch
      }
      return _next()
    })

    const errors: Error[] = []
    ctx.on('agent/error', (_agent, _turn, _step, error) => void errors.push(error))

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    expect(errors).toHaveLength(1)
    // String() of { code: 500 } is '[object Object]'
    expect(errors[0]!.message).toBe('[object Object]')
    const turnEnd = agent.session.events.find(e => e.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason.kind === 'error'
      && ('failure' in turnEnd.data.reason ? turnEnd.data.reason.failure.code : turnEnd.data.reason.code))
      .toBe('UNKNOWN')
  })
})

describe('coded error data emission', () => {
  it('errorData includes code when a coded error (LlmError) is thrown from a plugin', async () => {
    const adapter = new MockAdapter([textResponse('turn 1')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    let threwOnce = false
    ctx.on('agent/request', async (_agent, _turn, _step, _options, _signal, next) => {
      if (!threwOnce) {
        threwOnce = true
        throw new LlmError('server overloaded', 'RATE_LIMIT')
      }
      return next()
    })

    const errors: Error[] = []
    ctx.on('agent/error', (_agent, _turn, _step, error) => void errors.push(error))

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toBe('server overloaded')

    // turn-end error reason includes the code
    const turnEnd = agent.session.events.find(e => e.type === 'turn/end')
    expect(turnEnd).toBeDefined()
    if (turnEnd?.type === 'turn/end' && turnEnd.data.reason.kind === 'error') {
      expect('failure' in turnEnd.data.reason ? turnEnd.data.reason.failure.code : turnEnd.data.reason.code)
        .toBe('RATE_LIMIT')
    }
  })
})

describe('disposed vs aborted branching', () => {
  it('handles dispose during model streaming producing reason "disposed"', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)
    let agent!: Agent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create(SessionId('scoped'), { provider: 'mock', model: 'mock' })
    }, { inject: ['agentLoop'] }))

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    await fiber.dispose() // dispose during hang
    await driverDone(agent)

    // Disposal wins abort classification because the error path checks it first.
    expect(reasons).toContainEqual({ kind: 'disposed' })
  })
})

describe('structured tool error propagation (the runtime-validation Agent Note, part 2)', () => {
  it('forwards a tool HarnessError onto the tool/result session event', async () => {
    const { HarnessError } = await import('@deepseek-ai/dsh-llm')
    // First model turn calls the tool; second turn (after the tool result is
    // fed back) ends with plain text so the loop settles.
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'boom', {}),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    ctx.tools.register(defineContentToolFixture({
      name: 'boom',
      description: 'always fails',
      parameters: {},
      async execute() {
        throw new HarnessError('exploded', 'BOOM')
      },
    }))

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const toolResult = agent.session.events.find(e => e.type === 'tool/result')
    expect(toolResult?.type === 'tool/result' && toolResult.data.isError).toBe(true)
    expect(toolResult?.type === 'tool/result' && toolResult.data.error)
      .toEqual({ name: 'HarnessError', code: 'BOOM' })
  })
})
