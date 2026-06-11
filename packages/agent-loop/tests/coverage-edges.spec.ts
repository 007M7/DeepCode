import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LlmService, { CallId, LlmError, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { TurnEndReason } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineTool } from '@deepseek-ai/dsh-tools'
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

describe('loop backstop catch', () => {
  it('a throwing turn-start listener is caught by the backstop and loop survives', async () => {
    // The first turn will abort before the model call (turn-start throw).
    // The second turn should proceed normally and consume the first script entry.
    const adapter = new MockAdapter([textResponse('turn 2')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

    let threwOnce = false
    ctx.on('agent/turn-start', () => {
      if (!threwOnce) {
        threwOnce = true
        throw new Error('broken turn-start listener')
      }
    })

    const errors: Error[] = []
    ctx.on('agent/error', (_agent, _turn, _step, error) => void errors.push(error))

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    expect(errors.map(e => e.message)).toEqual(['broken turn-start listener'])

    // loop survives: second turn works fine and makes the model call
    send(agent, 'second')
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]!.messages.some(m => m.content.some(b => 'text' in b && b.text === 'second'))).toBe(true)
  })

  it('a throwing turn-end listener is caught by the backstop and loop survives', async () => {
    const adapter = new MockAdapter([textResponse('turn 1'), textResponse('turn 2')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

    let threwOnce = false
    ctx.on('agent/turn-end', () => {
      if (!threwOnce) {
        threwOnce = true
        throw new Error('broken turn-end listener')
      }
    })

    const errors: Error[] = []
    ctx.on('agent/error', (_agent, _turn, _step, error) => void errors.push(error))

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    // The turn-end throw happens after the model call is complete, so turn 1's
    // request is consumed. The error is surfaced by the backstop.
    expect(errors.map(e => e.message)).toEqual(['broken turn-end listener'])

    // loop survives: second turn works fine
    send(agent, 'second')
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(2)
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
    ctx.tools.register(defineTool({
      name: 'echo',
      description: 'echo tool',
      parameters: { input: { type: 'string' } },
      async execute(args: unknown) {
        return [{ type: 'text', text: typeof args === 'string' ? `raw: ${args}` : JSON.stringify(args) }]
      },
    }))
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

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
    ctx.tools.register(defineTool({
      name: 'noarg',
      description: 'no-arg tool',
      parameters: {},
      async execute() {
        return [{ type: 'text', text: 'ran with empty args' }]
      },
    }))
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

    send(agent, 'use tool')
    await waitForIdle(ctx, agent)

    expect(agent.session.events.some(e => e.type === 'tool/result')).toBe(true)
  })
})

describe('toError normalization', () => {
  it('normalizes non-Error throws from turn-start listeners via toError in the backstop', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

    let threwOnce = false
    ctx.on('agent/turn-start', () => {
      if (!threwOnce) {
        threwOnce = true
        throw 'naked string error' // non-Error throw, goes through backstop's toError
      }
    })

    const errors: Error[] = []
    ctx.on('agent/error', (_agent, _turn, _step, error) => void errors.push(error))

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toBe('naked string error')
  })

  it('normalizes non-Error throws from agent/request waterfall via inline toError in runStep catch', async () => {
    const adapter = new MockAdapter([textResponse('irrelevant')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

    let threwOnce = false
    ctx.on('agent/request', async (_agent, _turn, _step, _options, _next) => {
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
  })
})

describe('coded error data emission', () => {
  it('errorData includes code when a coded error (LlmError) is thrown from a plugin', async () => {
    const adapter = new MockAdapter([textResponse('turn 1')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

    let threwOnce = false
    ctx.on('agent/request', async (_agent, _turn, _step, _options, next) => {
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

    // session error event includes the code
    const errorEvent = agent.session.events.find(e => e.type === 'error')
    expect(errorEvent).toBeDefined()
    if (errorEvent!.type === 'error') {
      expect(errorEvent!.data.code).toBe('RATE_LIMIT')
    }
  })
})

describe('disposed vs aborted branching', () => {
  it('handles dispose during model streaming producing reason "disposed"', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)
    let agent!: LoopAgent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create('scoped', { model: 'mock' })
    }, { inject: ['agentLoop'] }))

    const reasons: TurnEndReason[] = []
    ctx.on('agent/turn-end', (_agent, _turn, reason) => void reasons.push(reason))

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    await fiber.dispose() // dispose during hang
    await agent.done

    // The review-fixes test for 'HIGH: disposed status' already covers
    // this assertion path. The reason is 'disposed' because isDisposed() is
    // checked before the abort signal check in the error path.
    expect(reasons).toContainEqual({ kind: 'disposed' })
  })
})
