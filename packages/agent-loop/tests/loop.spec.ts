import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LlmService, { StreamChunk } from '@deepseek-ai/dsh-llm'
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

/**
 * Wait for the agent's NEXT transition to idle. Always event-based: callers
 * invoke this right after send(), when the loop hasn't woken yet (status is
 * still 'idle' synchronously), so polling the current status would lie.
 */
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

describe('agent loop', () => {
  it('runs a simple turn: queued message → model → idle, with ordered events', async () => {
    const adapter = new MockAdapter([textResponse('hello there')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

    const order: string[] = []
    for (const name of ['agent/turn-start', 'agent/step-start', 'agent/step-end', 'agent/turn-end'] as const) {
      ctx.on(name, () => void order.push(name))
    }

    send(agent, 'hi')
    await waitForIdle(ctx, agent)

    expect(order).toEqual(['agent/turn-start', 'agent/step-start', 'agent/step-end', 'agent/turn-end'])

    const types = agent.session.events.map(e => e.type)
    // user message recorded before turn/start, assembled message + usage present
    expect(types[0]).toBe('user/message')
    expect(types[1]).toBe('turn/start')
    expect(types).toContain('assistant/message')
    expect(types).toContain('usage')
    expect(types.at(-1)).toBe('turn/end')

    // derived history: user + assistant
    const messages = agent.session.deriveMessages()
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(messages[1]!.content).toEqual([{ type: 'text', text: 'hello there' }])
  })

  it('round-trips tool calls: model requests tool → executes → result in next request', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { text: 'ping' }, 'calling echo'),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineTool({
      name: 'echo',
      description: 'echo back',
      parameters: { text: { type: 'string' } },
      async execute(args) {
        return [{ type: 'text', text: `echo: ${args.text}` }]
      },
    }))
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

    send(agent, 'use the tool')
    await waitForIdle(ctx, agent)

    // two model calls happened (tool-call step, then final step)
    expect(adapter.requests).toHaveLength(2)

    // the second request's derived history contains the tool result
    const secondMessages = adapter.requests[1]!.messages
    const toolResultMessage = secondMessages.find(m =>
      m.content.some(b => b.type === 'tool-result'))
    expect(toolResultMessage).toBeDefined()
    const block = toolResultMessage!.content.find(b => b.type === 'tool-result')!
    expect(block).toMatchObject({ toolCallId: 'c1', isError: false })
    expect((block).content).toEqual([{ type: 'text', text: 'echo: ping' }])

    // session log records call + result
    const types = agent.session.events.map(e => e.type)
    expect(types).toContain('tool/call')
    expect(types).toContain('tool/result')
  })

  it('passes assembled system prompt and tool schemas into the request', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    ctx.systemPrompt.section({ name: 'persona', order: 0, text: 'You are a test agent.' })
    ctx.tools.register(defineTool({
      name: 'noop',
      description: 'does nothing',
      parameters: {},
      async execute() {
        return []
      },
    }))
    const agent = ctx.agentLoop.create('a1', { model: 'mock', systemPrompt: 'Agent-specific suffix.' })

    send(agent, 'hi')
    await waitForIdle(ctx, agent)

    const request = adapter.requests[0]
    expect(request!.system).toBe('You are a test agent.\n\nAgent-specific suffix.')
    expect(request!.tools?.map(t => t.name)).toEqual(['noop'])
  })

  it('records raw chunks for replay and emits agent/stream-chunk', async () => {
    const adapter = new MockAdapter([textResponse('abc')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

    const streamed: StreamChunk[] = []
    ctx.on('agent/stream-chunk', (_agent, _turn, _step, chunk) => void streamed.push(chunk))

    send(agent, 'hi')
    await waitForIdle(ctx, agent)

    const chunkEvents = agent.session.events.filter(e => e.type === 'assistant/chunk')
    // textResponse('abc') = block-start + 3 deltas + block-end + usage + finish = 7
    expect(chunkEvents).toHaveLength(7)
    expect(streamed).toHaveLength(7)
    // replay: chunk events alone re-assemble to the recorded assistant message
    const deltaText = chunkEvents
      .flatMap(e => e.type === 'assistant/chunk' ? [e.data.chunk] : [])
      .filter((c: StreamChunk): c is Extract<StreamChunk, { type: 'text-delta' }> => c.type === 'text-delta')
      .map(c => c.text)
      .join('')
    expect(deltaText).toBe('abc')
  })

  it('injects steering between steps and continues the turn', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'slow', {}),
      textResponse('addressed the steering'),
    ])
    const ctx = await harness(adapter)

    const agent = ctx.agentLoop.create('a1', { model: 'mock' })
    ctx.tools.register(defineTool({
      name: 'slow',
      description: '',
      parameters: {},
      async execute() {
        // steer while the turn is running (during tool execution)
        agent.steer([{ type: 'text', text: 'change of plans' }])
        return [{ type: 'text', text: 'tool done' }]
      },
    }))

    send(agent, 'start')
    await waitForIdle(ctx, agent)

    const types = agent.session.events.map(e => e.type)
    expect(types).toContain('steering/message')
    // steering recorded before the second step's request derived its history
    const steeringSeq = agent.session.events.find(e => e.type === 'steering/message')!.seq
    const secondStepStart = agent.session.events.filter(e => e.type === 'step/start')[1]
    expect(secondStepStart).toBeDefined()
    expect(steeringSeq).toBeLessThan(secondStepStart!.seq)

    // the second model request saw the steering content
    const secondRequest = adapter.requests[1]
    const flat = JSON.stringify(secondRequest!.messages)
    expect(flat).toContain('change of plans')
  })

  it('steering while idle behaves like send (starts a turn)', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

    agent.steer([{ type: 'text', text: 'hello' }])
    await waitForIdle(ctx, agent)
    expect(agent.session.events.some(e => e.type === 'user/message')).toBe(true)
  })

  it('inject() appends context visible to the next request without starting a turn', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

    agent.inject([{ type: 'text', text: 'file changed: a.ts' }], { source: { kind: 'plugin', plugin: 'watcher' } })
    // no turn started
    await new Promise(r => setTimeout(r, 20))
    expect(agent.status).toBe('idle')
    expect(adapter.requests).toHaveLength(0)

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    const flat = JSON.stringify(adapter.requests[0]!.messages)
    expect(flat).toContain('file changed: a.ts')
    expect(flat).toContain('<context source=\\"plugin\\">')
  })

  it('agent/turn-continuation can force-continue (/loop pattern) and force-stop', async () => {
    // force-continue: model never calls tools, but a plugin forces 3 steps
    const adapter = new MockAdapter([
      textResponse('step 1'),
      textResponse('step 2'),
      textResponse('step 3'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

    let steps = 0
    ctx.on('agent/step-end', () => void steps++)
    ctx.on('agent/turn-continuation', async (_agent, _turn, _defaultDecision, next) => {
      if (steps < 3) return true
      return next()
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    expect(steps).toBe(3)
    expect(adapter.requests).toHaveLength(3)
  })

  it('agent/turn-continuation can veto continuation despite tool calls (budget-guard pattern)', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', { text: 'x' })])
    const ctx = await harness(adapter)
    ctx.tools.register(defineTool({
      name: 'echo',
      description: '',
      parameters: { text: { type: 'string' } },
      async execute(args) {
        return [{ type: 'text', text: String(args.text) }]
      },
    }))
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

    ctx.on('agent/turn-continuation', async () => false as const)

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    // only one model call despite the tool call requesting a follow-up
    expect(adapter.requests).toHaveLength(1)
    // tool still executed before the decision
    expect(agent.session.events.some(e => e.type === 'tool/result')).toBe(true)
  })

  it('agent/request waterfall can rewrite the request (model-switch pattern)', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    ctx.llm.registerAdapter(['other-model'], adapter)
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

    ctx.on('agent/request', async (_agent, _turn, _step, options, next) => {
      options.model = 'other-model'
      return next()
    })

    send(agent, 'hi')
    await waitForIdle(ctx, agent)
    expect(adapter.requests[0]!.model).toBe('other-model')
  })

  it('abort() mid-stream ends the turn with reason aborted', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

    const reasons: TurnEndReason[] = []
    ctx.on('agent/turn-end', (_agent, _turn, reason) => void reasons.push(reason))

    send(agent, 'go')
    // wait until the stream is hanging, then abort
    await new Promise(r => setTimeout(r, 30))
    expect(agent.status).toBe('running')
    agent.abort('user interrupt')
    await waitForIdle(ctx, agent)

    expect(reasons).toEqual([{ kind: 'aborted', reason: 'user interrupt' }])
  })

  it('chains queued messages into consecutive turns', async () => {
    const adapter = new MockAdapter([textResponse('first'), textResponse('second')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

    const turns: number[] = []
    ctx.on('agent/turn-start', (_agent, turn) => void turns.push(turn))

    // queue two messages while idle — first starts turn 1 immediately;
    // queue the second during turn 1 via a stream-chunk hook
    let queued = false
    ctx.on('agent/stream-chunk', () => {
      if (!queued) {
        queued = true
        send(agent, 'second message')
      }
    })

    send(agent, 'first message')
    await waitForIdle(ctx, agent)

    expect(turns).toEqual([1, 2])
    expect(adapter.requests).toHaveLength(2)
  })

  it('awaits session/flush at turn end (persistence checkpoint)', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

    let flushed = 0
    let flushedBeforeIdle = false
    ctx.on('session/flush', async (session) => {
      await new Promise(r => setTimeout(r, 10))
      flushed++
      flushedBeforeIdle = agent.status !== 'idle'
      void session
    })

    send(agent, 'hi')
    await waitForIdle(ctx, agent)
    expect(flushed).toBe(1)
    expect(flushedBeforeIdle).toBe(true)
  })

  it('errors from the model surface as agent/error and end the turn', async () => {
    const adapter = new MockAdapter([]) // script exhausted → throws
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

    const errors: Error[] = []
    const reasons: TurnEndReason[] = []
    ctx.on('agent/error', (_agent, _turn, _step, error) => void errors.push(error))
    ctx.on('agent/turn-end', (_agent, _turn, reason) => void reasons.push(reason))

    send(agent, 'hi')
    await waitForIdle(ctx, agent)

    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toContain('script exhausted')
    expect(reasons[0]).toMatchObject({ kind: 'error' })
    expect(agent.session.events.some(e => e.type === 'error')).toBe(true)
  })

  it('disposing the loop fiber mid-turn stops the loop (HMR safety)', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)

    let agent!: LoopAgent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create('scoped', { model: 'mock' })
    }, { inject: ['agentLoop'] }))

    expect(ctx.agents.get('scoped')).toBe(agent)
    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    expect(agent.status).toBe('running')

    await fiber.dispose()
    await agent.done

    expect(agent.status).toBe('disposed')
    expect(ctx.agents.get('scoped')).toBeUndefined()
    expect(() => { send(agent, 'too late') }).toThrow('disposed')
  })

  it('creates agents from config on startup', async () => {
    const adapter = new MockAdapter([textResponse('from config')])
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, {
      agents: [{ id: 'config-agent', model: 'mock', systemPrompt: 'Config prompt' }],
    })
    ctx.llm.registerAdapter(['mock'], adapter)

    const agent = ctx.agents.get('config-agent')! as LoopAgent
    expect(agent).toBeDefined()
    expect(agent.id).toBe('config-agent')
    expect(agent.options.model).toBe('mock')

    // the agent is alive: send triggers a turn
    send(agent, 'hi')
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1)
  })

  it('replays a session log into an identical derived history', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { text: 'x' }),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineTool({
      name: 'echo',
      description: '',
      parameters: { text: { type: 'string' } },
      async execute(args) {
        return [{ type: 'text', text: String(args.text) }]
      },
    }))
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })
    send(agent, 'run')
    await waitForIdle(ctx, agent)

    const replayed = ctx.sessions.create('replayed', [...agent.session.events])
    expect(replayed.deriveMessages()).toEqual(agent.session.deriveMessages())
    // event-by-event identity of types
    expect(replayed.events.map(e => e.type)).toEqual(
      agent.session.events.map(e => e.type))
  })
})
