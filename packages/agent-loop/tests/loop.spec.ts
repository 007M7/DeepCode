import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LlmService, { CallId, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { TurnEndReason } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop, { LoopAgent } from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, maxTokensResponse, textResponse, toolCallResponse } from './mock-adapter.ts'

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
    // turn/start opens the turn, THEN the queued user message is recorded inside
    // it (every event is turn-enclosed), then assembled message + usage.
    expect(types[0]).toBe('turn/start')
    expect(types[1]).toBe('user/message')
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

  it('inject() while idle wraps context in a one-shot turn, visible to the next request', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

    agent.inject([{ type: 'text', text: 'file changed: a.ts' }], { source: { kind: 'plugin', plugin: 'watcher' } })
    // The idle inject records a self-contained turn (turn/start → context/message
    // → turn/end) so the event stays turn-enclosed, but does NOT run the model.
    await new Promise(r => setTimeout(r, 20))
    expect(agent.status).toBe('idle')
    expect(adapter.requests).toHaveLength(0)
    const injectedTurn = agent.session.events.filter(e => e.type === 'turn/start')
    expect(injectedTurn).toHaveLength(1)
    const it0 = injectedTurn[0]!
    expect(it0.type === 'turn/start' && it0.data.trigger.kind).toBe('injection')
    expect(agent.session.events.at(-1)!.type).toBe('turn/end') // turn-enclosed

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    const flat = JSON.stringify(adapter.requests[0]!.messages)
    expect(flat).toContain('file changed: a.ts')
    expect(flat).toContain('<context source=\\"plugin\\">')
  })

  it('inject() while running appends into the open turn (no extra synthetic turn)', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'noticer', {}, 'calling'),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })
    // A tool that injects mid-execution: at this point the agent is running, so
    // inject must append the context/message into the ALREADY-open turn rather
    // than wrap it in its own one-shot turn.
    ctx.tools.register(defineTool({
      name: 'noticer',
      description: 'injects a notice',
      parameters: {},
      async execute() {
        agent.inject([{ type: 'text', text: 'mid-turn notice' }], { source: { kind: 'plugin', plugin: 'x' } })
        return [{ type: 'text', text: 'ok' }]
      },
    }))

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    // Exactly ONE turn ran (no synthetic injection turn), and the mid-turn
    // context/message sits inside it.
    const turnStarts = agent.session.events.filter(e => e.type === 'turn/start')
    expect(turnStarts).toHaveLength(1)
    const ts0 = turnStarts[0]!
    expect(ts0.type === 'turn/start' && ts0.data.trigger.kind).toBe('message')
    expect(agent.session.events.some(e => e.type === 'context/message')).toBe(true)
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

  it('surfaces max-tokens as the turn-end reason when the last step is cut off', async () => {
    // A single step that ends with a max-tokens finish (no tool calls): the
    // turn stops by default and ends max-tokens, not completed.
    const adapter = new MockAdapter([maxTokensResponse('truncat')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

    const reasons: TurnEndReason[] = []
    ctx.on('agent/turn-end', (_agent, _turn, reason) => void reasons.push(reason))

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(1)
    expect(reasons).toEqual([{ kind: 'max-tokens' }])
    // and the reason is recorded in the log's turn/end event
    const turnEnd = agent.session.events.findLast(e => e.type === 'turn/end')
    expect(turnEnd!.data.reason).toEqual({ kind: 'max-tokens' })
  })

  it('a max-tokens step earlier in a turn still surfaces as max-tokens after a later completed step', async () => {
    // Step 1 is cut off (max-tokens, no tool calls → would stop by default), so
    // continuation must be FORCED to reach step 2 which finishes normally
    // (stop). The rule "any max-tokens step surfaces as max-tokens" means the
    // turn ends max-tokens even though the LAST step completed cleanly.
    const adapter = new MockAdapter([
      maxTokensResponse('first half'),
      textResponse('second half'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

    let steps = 0
    ctx.on('agent/step-end', () => void steps++)
    // Force exactly one continuation (step 1 → step 2), then defer to default
    // (step 2 is a plain stop with no tool calls → stops).
    ctx.on('agent/turn-continuation', async (_agent, _turn, _defaultDecision, next) => {
      if (steps < 2) return true
      return next()
    })

    const reasons: TurnEndReason[] = []
    ctx.on('agent/turn-end', (_agent, _turn, reason) => void reasons.push(reason))

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(steps).toBe(2)
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]!.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'first half' }] },
    ])
    expect(reasons).toEqual([{ kind: 'max-tokens' }])
  })

  it('a completed step after no max-tokens keeps the turn completed (max-tokens does not leak across turns)', async () => {
    // Two consecutive turns: turn 1 is cut off (max-tokens), turn 2 is a clean
    // stop. The per-turn reason must be independent — turn 2 ends completed.
    const adapter = new MockAdapter([maxTokensResponse('cut'), textResponse('clean')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

    const reasons: TurnEndReason[] = []
    ctx.on('agent/turn-end', (_agent, _turn, reason) => void reasons.push(reason))

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    send(agent, 'second')
    await waitForIdle(ctx, agent)

    expect(reasons).toEqual([{ kind: 'max-tokens' }, { kind: 'completed' }])
  })

  it('does not dispatch tool calls from a max-tokens-truncated step', async () => {
    const callId = CallId('c1')
    const adapter = new MockAdapter([[
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: callId, name: 'echo', argumentsDelta: '{"text":"x"}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'echo', arguments: '{"text":"x"}' } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ]])
    const ctx = await harness(adapter)
    let executions = 0
    ctx.tools.register(defineTool({
      name: 'echo',
      description: '',
      parameters: { text: { type: 'string' } },
      async execute() {
        executions += 1
        return [{ type: 'text', text: 'should not run' }]
      },
    }))
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

    const reasons: TurnEndReason[] = []
    ctx.on('agent/turn-end', (_agent, _turn, reason) => void reasons.push(reason))

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(executions).toBe(0)
    expect(agent.session.events.some(e => e.type === 'tool/call')).toBe(false)
    expect(agent.session.deriveMessages()).toEqual([{ role: 'user', content: [{ type: 'text', text: 'go' }] }])
    expect(reasons).toEqual([{ kind: 'max-tokens' }])
  })

  it('keeps safe max-tokens assistant content while dropping truncated tool calls', async () => {
    const callId = CallId('c1')
    const adapter = new MockAdapter([[
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'partial text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'partial text' } },
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 1, id: callId, name: 'echo', argumentsDelta: '{"text"' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ]])
    const ctx = await harness(adapter)
    let stepResults = 0
    ctx.on('agent/step-result', async (_agent, _turn, _step, message, next) => {
      stepResults += 1
      expect(message.content).toEqual([{ type: 'text', text: 'partial text' }])
      return next()
    })
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(stepResults).toBe(1)
    expect(agent.session.events.some(e => e.type === 'tool/call')).toBe(false)
    expect(agent.session.deriveMessages()).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'partial text' }] },
    ])
  })

  it('stops the turn when agent/step-end listener failure has recorded an error', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { text: 'x' }),
      textResponse('should not run'),
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
    let threw = false
    ctx.on('agent/step-end', () => {
      if (!threw) { threw = true; throw new Error('bad step-end listener') }
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(1)
    const turnEnd = agent.session.events.findLast(e => e.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason.kind).toBe('error')
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

    const replayed = ctx.sessions.create('replayed', { seed: [...agent.session.events] })
    expect(replayed.deriveMessages()).toEqual(agent.session.deriveMessages())
    // event-by-event identity of types
    expect(replayed.events.map(e => e.type)).toEqual(
      agent.session.events.map(e => e.type))
  })
})
