import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LlmService, { CallId, LlmError, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { TurnEndReason } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop, { LoopAgent } from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

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

describe('turn boundary listener throws (handled in-turn, loop survives)', () => {
  it('a throwing agent/turn-start listener surfaces via agent/error and the loop survives', async () => {
    // The agent/turn-start emit happens AFTER turn/start is appended to the log,
    // so a throwing listener is handled inside runTurn (the turn is balanced and
    // closed via failTurn → agent/error), NOT rethrown to the runLoop backstop.
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
    // The turn is balanced: its turn/start was logged, so a turn/end was owed
    // and appended (decided from the log, not a flag).
    expect(agent.session.events.at(-1)?.type).toBe('turn/end')

    // loop survives: second turn works fine and makes the model call
    send(agent, 'second')
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]!.messages.some(m => m.content.some(b => 'text' in b && b.text === 'second'))).toBe(true)
  })

  it('a throwing agent/turn-end listener surfaces via agent/error and the loop survives', async () => {
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
    // request is consumed. turn/end is already in the log (append pushes before
    // notifying), so the turn is balanced; the error is surfaced via agent/error.
    expect(errors.map(e => e.message)).toEqual(['broken turn-end listener'])

    // loop survives: second turn works fine
    send(agent, 'second')
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(2)
  })

  it('a pre-push turn/start failure (non-serializable source) is rethrown to the runLoop backstop', async () => {
    // A non-serializable message source makes the turn/start append throw BEFORE
    // the event is pushed (Session.append validates before push), so turn/start
    // never enters the log. runTurn sees no logged turn/start and rethrows; the
    // runLoop backstop reports via agent/error (step 0) + the logger and the
    // driver survives. This is the ONLY path that reaches the backstop.
    const adapter = new MockAdapter([textResponse('turn 2')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

    const errors: { turn: number; step: number; message: string }[] = []
    ctx.on('agent/error', (_a, turn, step, error) => void errors.push({ turn, step, message: error.message }))

    // A non-serializable source (BigInt) on the queued message.
    agent.send([{ type: 'text', text: 'first' }], { source: { kind: 'plugin', plugin: 'p', bad: 1n } as never })
    await waitForIdle(ctx, agent)

    expect(errors).toHaveLength(1)
    expect(errors[0]!.step).toBe(0)
    expect(errors[0]!.message).toMatch(/non-JSON-serializable/)
    // No turn boundary was written (the turn/start append threw before push).
    expect(agent.session.events.some(e => e.type === 'turn/start')).toBe(false)

    // loop survives: a well-formed second turn runs normally.
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
  it('normalizes non-Error throws from turn-start listeners via toError', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

    let threwOnce = false
    ctx.on('agent/turn-start', () => {
      if (!threwOnce) {
        threwOnce = true
        throw 'naked string error' // non-Error throw, normalized via toError
      }
    })

    const errors: Error[] = []
    ctx.on('agent/error', (_agent, _turn, _step, error) => void errors.push(error))

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toBe('naked string error')
    // A non-Error throw is wrapped in a HarnessError with code UNKNOWN, so the
    // session error event carries a routable code instead of degrading.
    const errorEvent = agent.session.events.find(e => e.type === 'error')
    expect(errorEvent?.type === 'error' && errorEvent.data.code).toBe('UNKNOWN')
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
    const errorEvent = agent.session.events.find(e => e.type === 'error')
    expect(errorEvent?.type === 'error' && errorEvent.data.code).toBe('UNKNOWN')
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

describe('structured tool error propagation (RFC 005 pt 2)', () => {
  it('forwards a tool HarnessError onto the tool/result session event', async () => {
    const { HarnessError } = await import('@deepseek-ai/dsh-llm')
    // First model turn calls the tool; second turn (after the tool result is
    // fed back) ends with plain text so the loop settles.
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'boom', {}),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })
    ctx.tools.register(defineTool({
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
