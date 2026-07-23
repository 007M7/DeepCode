import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LlmService, { CallId, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, TurnEndReason, type JsonValue } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineContentToolFixture, defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'

import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, maxTokensResponse, textResponse, toolCallResponse } from './mock-adapter.ts'

function driverDone(agent: Agent): Promise<void> {
  return (agent as Agent & { done: Promise<void> }).done
}

async function harness(adapter: MockAdapter, persona = '') {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona })
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
  agent.send([{ type: 'text', text }])
}

describe('agent loop', () => {
  it('runs a simple turn: queued message → model → idle, with ordered events', async () => {
    const adapter = new MockAdapter([textResponse('hello there')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    // All boundaries — turn and step — are durable session events on the
    // session/event feed (no agent/* mirror). Record them in fire order to
    // assert the full boundary nesting.
    const order: string[] = []
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'turn/start' || event.type === 'step/start' || event.type === 'step/end' || event.type === 'turn/end') {
        order.push(event.type)
      }
    })

    send(agent, 'hi')
    await waitForIdle(ctx, agent)

    expect(order).toEqual(['turn/start', 'step/start', 'step/end', 'turn/end'])

    const types = agent.session.events.map(e => e.type)
    // turn/start opens the turn, THEN the queued user message is recorded inside
    // it (every event is turn-enclosed), then the assembled message (carrying the
    // step's usage).
    expect(types[0]).toBe('turn/start')
    expect(types[1]).toBe('user/message')
    expect(types).toContain('assistant/message')
    const assistantMessage = agent.session.events.find(e => e.type === 'assistant/message')
    expect(assistantMessage?.type === 'assistant/message' && assistantMessage.data.usage).toEqual({ inputTokens: 10, outputTokens: 'hello there'.length })
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
    ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'echo back',
      parameters: { text: { type: 'string' } },
      async execute(args) {
        return [{ type: 'text', text: `echo: ${args.text}` }]
      },
    }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

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
    const durableResult = agent.session.events.find(event => event.type === 'tool/result')
    expect(durableResult?.type === 'tool/result' && 'value' in durableResult.data).toBe(false)
  })

  it('persists presentation metadata projected from the canonical value', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'writer', { path: 'a.txt' }, 'writing'),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineTool({
      name: 'writer',
      description: 'writes a file',
      parameters: { path: { type: 'string' } },
      output: {
        schema: { type: 'string' },
        render: () => [{ type: 'text', text: 'ok' }],
        presentationMeta: (_args, value) => ({ diffs: [{ path: value, oldText: null, newText: 'x' }] }),
      },
      async execute() {
        return 'a.txt'
      },
    }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'use the tool')
    await waitForIdle(ctx, agent)

    const toolResult = agent.session.events.find(e => e.type === 'tool/result')
    expect(toolResult?.type === 'tool/result' && toolResult.data.meta)
      .toEqual({ diffs: [{ path: 'a.txt', oldText: null, newText: 'x' }] })
  })

  it('renders harness identity, then the persona, then tool guidance — with {{variables}} resolved', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    // The persona is a TEMPLATE: {{model}} is the loop-registered variable
    // projecting this agent's configured model, so the model knows its own name.
    const ctx = await harness(adapter, 'You are a test agent on {{model}}.')
    ctx.systemPrompt.section({ name: 'tool:noop', order: 100, text: 'Use the noop tool wisely.' })
    ctx.tools.register(defineContentToolFixture({
      name: 'noop',
      description: 'does nothing',
      parameters: {},
      async execute() {
        return []
      },
    }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'hi')
    await waitForIdle(ctx, agent)

    const request = adapter.requests[0]
    expect(request!.system).toBe('You are an AI agent powered by the DeepSeek Harness SDK.\n\nYou are a test agent on mock.\n\nUse the noop tool wisely.')
    expect(request!.tools?.map(t => t.name)).toEqual(['noop'])
  })

  it('resolves {{cwd}} from the agent session workspace (factory create with meta.cwd)', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter, 'Working in {{cwd}}.')
    const handle = await ctx.agents.create({
      sessionId: SessionId('s-cwd'),
      meta: { cwd: '/work/space' },
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    const agent = handle.agent
    send(agent, 'hi')
    await waitForIdle(ctx, agent)

    expect(adapter.requests[0]!.system).toBe('You are an AI agent powered by the DeepSeek Harness SDK.\n\nWorking in /work/space.')
  })

  it('contains a strict-variable render failure: the turn errors, the loop keeps serving turns', async () => {
    // A missing cwd variable must fail one turn without preventing a later valid turn.
    const adapter = new MockAdapter([textResponse('ok after rescue')])
    const ctx = await harness(adapter, 'In {{cwd}}.')
    const errors: Error[] = []
    ctx.on('agent/error', (_agent, _turn, _step, error) => void errors.push(error))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'hi')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(0) // the request was never sent
    expect(errors.some(e => e.message.includes('no value for this assembly'))).toBe(true)
    const turnEnd = agent.session.events.find(e => e.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason.kind).toBe('error')

    // The loop survived: a waterfall listener rescues {{cwd}} and the SAME
    // agent completes a real model turn.
    ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      assembly.variables['cwd'] = '/rescued'
      return next()
    })
    send(agent, 'again')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]!.system).toBe('You are an AI agent powered by the DeepSeek Harness SDK.\n\nIn /rescued.')
    const turnEnds = agent.session.events.filter(e => e.type === 'turn/end')
    expect(turnEnds).toHaveLength(2)
    expect(turnEnds[1]?.type === 'turn/end' && turnEnds[1].data.reason.kind).toBe('completed')
  })

  it('supports the model-via-agent/request path with a {{model}} persona: the supplier states it via the assemble waterfall', async () => {
    // AgentOptions.model unset: the model arrives in the agent/request
    // waterfall (the loop's documented fallback — see runStep's no-model
    // error). {{model}} renders BEFORE that waterfall, so the SAME plugin
    // states the fact early on system-prompt/assemble — the owner of a
    // late-bound fact owns stating it wherever it is claimed.
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter, 'You run on {{model}}.')
    ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      assembly.variables['provider'] = 'mock'
      assembly.variables['model'] = 'mock'
      return next()
    })
    ctx.on('agent/request', async (_agent, _turn, _step, config, _signal, _next) => {
      return { ...config, provider: 'mock', model: 'mock' }
    })
    const agent = ctx.agentLoop.create(SessionId('a-late-model'), {})

    send(agent, 'hi')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]!.model).toBe('mock')
    expect(adapter.requests[0]!.system).toBe('You are an AI agent powered by the DeepSeek Harness SDK.\n\nYou run on mock.')
  })

  it.each([
    ['BigInt', { n: 1n }],
    ['Map', new Map([['key', 'value']])],
    ['class instance', new (class ResultMeta { x = 1 })()],
  ])('rejects non-JSON presentation metadata (%s) before the durable result commit', async (_kind, meta) => {
    const adapter = new MockAdapter([
      toolCallResponse('bad-meta-call', 'bad-meta', {}, 'calling'),
      textResponse('recovered'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineTool({
      name: 'bad-meta',
      description: 'returns invalid durable metadata',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
        presentationMeta: () => meta as unknown as JsonValue,
      },
      execute: () => Promise.resolve('apparent success'),
    }))
    const agent = ctx.agentLoop.create(SessionId('bad-meta-agent'), { provider: 'mock', model: 'mock' })

    send(agent, 'use the tool')
    await waitForIdle(ctx, agent)

    const result = agent.session.events.find(event => event.type === 'tool/result')
    expect(result?.type).toBe('tool/result')
    if (result?.type === 'tool/result') {
      expect(result.data.callId).toBe('bad-meta-call')
      expect(result.data.isError).toBe(true)
      expect(result.data.meta).toBeUndefined()
      expect(result.data.error).toEqual({ name: 'ToolOutputError', code: 'INVALID_TOOL_OUTPUT' })
      expect(result.data.content).toEqual([{
        type: 'text',
        text: 'Error: tool "bad-meta" returned invalid output: output.presentationMeta returned non-lossless JSON',
      }])
    }
    // The normalized failure was durably logged and fed back to the model; the
    // turn continued normally instead of failing after an apparent success.
    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('output.presentationMeta returned non-lossless JSON')
  })

  it('omits the system field when a system-prompt/assemble veto empties the assembly', async () => {
    // The documented escape valve: a deployment that must drop the harness
    // openers short-circuits the assemble waterfall; the request then carries
    // NO system field at all (not an empty string).
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    ctx.on('system-prompt/assemble', async () => ({ sections: [], tools: [], variables: {} }))
    const agent = ctx.agentLoop.create(SessionId('a-no-system'), { provider: 'mock', model: 'mock' })

    send(agent, 'hi')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(1)
    expect('system' in adapter.requests[0]!).toBe(false)
  })

  it('records raw chunks for replay as assistant/chunk session events', async () => {
    const adapter = new MockAdapter([textResponse('abc')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'hi')
    await waitForIdle(ctx, agent)

    const chunkEvents = agent.session.events.filter(e => e.type === 'assistant/chunk')
    // textResponse('abc') = block-start + 3 deltas + block-end + usage + finish = 7
    expect(chunkEvents).toHaveLength(7)
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

    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    ctx.tools.register(defineContentToolFixture({
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

  it('same-tick idle steering inherits one-send-one-turn FIFO behavior', async () => {
    const adapter = new MockAdapter([textResponse('first'), textResponse('second')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    const idle = waitForIdle(ctx, agent)
    agent.steer([{ type: 'text', text: 'first idle steer' }])
    agent.steer([{ type: 'text', text: 'second idle steer' }])
    await idle

    expect(agent.session.events.filter(event => event.type === 'turn/start')).toHaveLength(2)
    expect(agent.session.events
      .filter(event => event.type === 'user/message')
      .map(event => event.data.content)).toEqual([
      [{ type: 'text', text: 'first idle steer' }],
      [{ type: 'text', text: 'second idle steer' }],
    ])
    expect(adapter.requests).toHaveLength(2)
  })

  it('inject() while idle wraps context in a one-shot turn, visible to the next request', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

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
    expect(flat).not.toContain('<context source=')
  })

  it('inject() persists structured context content verbatim with durable hidden meta', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('raw-context'), { provider: 'mock', model: 'mock' })
    const text = '<system-reminder>Additional instructions from: pkg/AGENTS.md</system-reminder>'
    const meta = {
      kind: 'workspace-instructions',
      version: 1,
      changes: [{ action: 'set', scope: 'pkg', path: 'pkg/AGENTS.md', digest: 'abc123' }],
    }

    agent.inject([{ type: 'text', text }], {
      source: { kind: 'plugin', plugin: 'workspace-context' },
      meta,
    })
    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const contextEvent = agent.session.events.find(event => event.type === 'context/message')
    expect(contextEvent?.type === 'context/message' && contextEvent.data).toMatchObject({ meta })
    const requestText = JSON.stringify(adapter.requests[0]!.messages)
    expect(requestText).toContain('Additional instructions from: pkg/AGENTS.md')
    expect(requestText).not.toContain('<context source=')
  })

  it('defers inject() during tool execution until after the tool result', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'noticer', {}, 'calling'),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    let visibleDuringTool = false
    const meta = { kind: 'deferred-test', version: 1 }
    ctx.tools.register(defineContentToolFixture({
      name: 'noticer',
      description: 'injects a notice',
      parameters: {},
      async execute() {
        await Promise.resolve()
        const first = { type: 'text' as const, text: 'mid-turn notice' }
        agent.inject([first], {
          source: { kind: 'plugin', plugin: 'x' },
          meta,
        })
        first.text = 'mutated after inject'
        agent.inject([{ type: 'text', text: 'second notice' }], { source: { kind: 'plugin', plugin: 'x' } })
        visibleDuringTool = agent.session.events.some(e => e.type === 'context/message')
        return [{ type: 'text', text: 'ok' }]
      },
    }))

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(visibleDuringTool).toBe(false)

    // The injection stays in the open turn, but its user-role context cannot
    // split the assistant tool call from the provider's tool-result message.
    const turnStarts = agent.session.events.filter(e => e.type === 'turn/start')
    expect(turnStarts).toHaveLength(1)
    const ts0 = turnStarts[0]!
    expect(ts0.type === 'turn/start' && ts0.data.trigger.kind).toBe('message')
    const result = agent.session.events.find(e => e.type === 'tool/result')!
    const contexts = agent.session.events.filter(e => e.type === 'context/message')
    expect(contexts).toHaveLength(2)
    expect(result.seq).toBeLessThan(contexts[0]!.seq)
    expect(contexts[0]?.type === 'context/message' && contexts[0].data).toMatchObject({
      meta,
    })
    expect(contexts.flatMap(event => event.type === 'context/message' ? event.data.content : []))
      .toEqual([
        { type: 'text', text: 'mid-turn notice' },
        { type: 'text', text: 'second notice' },
      ])

    const secondRequest = adapter.requests[1]!.messages
    const resultIndex = secondRequest.findIndex(message =>
      message.content.some(block => block.type === 'tool-result'))
    const contextIndexes = secondRequest.flatMap((message, index) =>
      message.content.some(block => block.type === 'text'
        && (block.text.includes('mid-turn notice') || block.text.includes('second notice')))
        ? [index]
        : [])
    expect(resultIndex).toBeGreaterThanOrEqual(0)
    expect(contextIndexes).toHaveLength(2)
    expect(contextIndexes.every(index => index > resultIndex)).toBe(true)
  })

  it('rejects non-JSON context before it enters the active tool-batch FIFO', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'invalid-injector', {}, 'calling'),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('invalid-context'), { provider: 'mock', model: 'mock' })
    ctx.tools.register(defineContentToolFixture({
      name: 'invalid-injector',
      description: 'attempts an invalid context injection',
      parameters: {},
      async execute() {
        expect(() => {
          agent.inject([{ type: 'text', text: 'invalid' }], {
            source: { kind: 'plugin', plugin: 'test' },
            meta: { bigint: 1n } as never,
          })
        }).toThrow('agent context must be losslessly JSON-serializable')
        return [{ type: 'text', text: 'rejected invalid context' }]
      },
    }))

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(agent.session.events.some(event => event.type === 'context/message')).toBe(false)
  })

  it('agent/turn-continuation can force-continue (/loop pattern) and force-stop', async () => {
    // force-continue: model never calls tools, but a plugin forces 3 steps
    const adapter = new MockAdapter([
      textResponse('step 1'),
      textResponse('step 2'),
      textResponse('step 3'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    let steps = 0
    ctx.on('session/event', (_session, event) => { if (event.type === 'step/end') steps++ })
    ctx.on('agent/turn-continuation', async (_agent, _turn, _defaultDecision, _signal, next) => {
      if (steps < 3) return { action: 'continue' as const }
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
    ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: '',
      parameters: { text: { type: 'string' } },
      async execute(args) {
        return [{ type: 'text', text: String(args.text) }]
      },
    }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    ctx.on('agent/turn-continuation', async () => ({ action: 'stop' }) as const)

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    // only one model call despite the tool call requesting a follow-up
    expect(adapter.requests).toHaveLength(1)
    // tool still executed before the decision
    expect(agent.session.events.some(e => e.type === 'tool/result')).toBe(true)
  })

  it('agent/request waterfall switches models by returning a replacement config; the switch is logged', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    ctx.on('agent/request', async (_agent, _turn, _step, config, _signal, _next) => {
      // The seed is frozen — config is not a mutable per-call knob; a switch
      // is proposed by returning a replacement, and the loop logs it.
      expect(Object.isFrozen(config)).toBe(true)
      expect(() => { (config as { model: string }).model = 'other-model' }).toThrow(TypeError)
      return { ...config, model: 'other-model' }
    })

    send(agent, 'hi')
    await waitForIdle(ctx, agent)
    expect(adapter.requests[0]!.model).toBe('other-model')
    // The header event records what the request ACTUALLY used — the switch is
    // a reconstructable fact, not silent drift.
    const headerEvent = agent.session.events.find(e => e.type === 'request/header')
    expect(headerEvent?.type === 'request/header' && headerEvent.data.header.config.model).toBe('other-model')
  })

  it('agent/pre-step fires once per step before the step is opened', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', {}, 'calling echo'),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'echo', description: 'echo', parameters: {},
      async execute() { return [{ type: 'text', text: 'echoed' }] },
    }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    const fires: { turn: number; step: number; signal: AbortSignal }[] = []
    ctx.on('agent/pre-step', (subject, turn, step, signal) => {
      if (subject === agent) fires.push({ turn, step, signal })
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(fires.map(({ turn, step }) => ({ turn, step }))).toEqual([
      { turn: 1, step: 1 },
      { turn: 1, step: 2 },
    ])
    expect(fires.every(({ signal }) => signal instanceof AbortSignal)).toBe(true)
  })

  it('agent/pre-step fires BEFORE the step it precedes opens (events land outside the step)', async () => {
    // The append lands before step/start, yet derive happens afterwards and the
    // same step's request must include it.
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    let injected = false
    ctx.on('agent/pre-step', (subject) => {
      if (subject === agent && !injected) {
        injected = true
        subject.session.append('context/message', {
          content: [{ type: 'text', text: 'INJECTED-IN-PRE-STEP' }],
          source: { kind: 'plugin', plugin: 'test' },
        }, { surfaceOp: 'append' })
      }
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    // The adapter's request includes the node injected during pre-step (derive
    // reflects it).
    const text = JSON.stringify(adapter.requests[0]!.messages)
    expect(text).toContain('INJECTED-IN-PRE-STEP')

    // And the injected event sits BEFORE the first step/start in the log —
    // the seam fired outside the step.
    const events = agent.session.events
    const injectedSeq = events.find(e => e.type === 'context/message')!.seq
    const firstStepStartSeq = events.find(e => e.type === 'step/start')!.seq
    expect(injectedSeq).toBeLessThan(firstStepStartSeq)
  })

  it('a throwing agent/pre-step listener ends the turn (error), not the loop', async () => {
    // Before step/start, a pre-step throw reaches the turn catch: no step needs
    // closing, the turn records error, and the loop remains available.
    const adapter = new MockAdapter([textResponse('second turn ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    let throwOnce = true
    ctx.on('agent/pre-step', () => {
      if (throwOnce) { throwOnce = false; throw new Error('boom in pre-step') }
    })

    const errors: Error[] = []
    ctx.on('agent/error', (_a, _t, _s, error) => void errors.push(error))

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    // The first turn failed at step 1 (no model call happened), surfaced via
    // agent/error, with the durable failure on turn/end.reason.
    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toContain('boom in pre-step')
    expect(adapter.requests.length).toBe(0)
    const firstTurnEnd = agent.session.events.find(e => e.type === 'turn/end')
    expect(firstTurnEnd?.type === 'turn/end' && firstTurnEnd.data.reason).toMatchObject({ kind: 'error', step: 1 })
    // The step opened-and-closed count stays balanced even though it never ran.
    const types = agent.session.events.map(e => e.type)
    expect(types.filter(t => t === 'step/start').length).toBe(types.filter(t => t === 'step/end').length)

    // The loop survived: a second prompt runs a normal completed turn.
    send(agent, 'second')
    await waitForIdle(ctx, agent)
    expect(adapter.requests.length).toBe(1)
    const lastTurnEnd = agent.session.events.findLast(e => e.type === 'turn/end')
    expect(lastTurnEnd?.type === 'turn/end' && lastTurnEnd.data.reason).toEqual({ kind: 'completed' })
  })

  it('cancel() mid-stream ends the turn with reason aborted', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    // wait until the stream is hanging, then cancel
    await new Promise(r => setTimeout(r, 30))
    expect(agent.status).toBe('running')
    agent.cancel({ kind: 'user' })
    await waitForIdle(ctx, agent)

    expect(reasons).toEqual([{ kind: 'aborted' }])
  })

  it('surfaces max-tokens as the turn-end reason when the last step is cut off', async () => {
    // A single step that ends with a max-tokens finish (no tool calls): the
    // turn stops by default and ends max-tokens, not completed.
    const adapter = new MockAdapter([maxTokensResponse('truncat')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(1)
    expect(reasons).toEqual([{ kind: 'max-tokens' }])
    // Assert the durable row, not only the live listener.
    const turnEnd = agent.session.events.findLast(e => e.type === 'turn/end')
    expect(turnEnd!.data.reason).toEqual({ kind: 'max-tokens' })
  })

  it('a max-tokens step earlier in a turn still surfaces as max-tokens after a later completed step', async () => {
    // Step 1 is cut off (max-tokens, no tool calls → would stop by default), so continuation
    // must be FORCED to reach step 2 which finishes normally (stop).
    const adapter = new MockAdapter([
      maxTokensResponse('first half'),
      textResponse('second half'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    let steps = 0
    ctx.on('session/event', (_session, event) => { if (event.type === 'step/end') steps++ })
    // Force exactly one continuation (step 1 → step 2), then defer to default
    // (step 2 is a plain stop with no tool calls → stops).
    ctx.on('agent/turn-continuation', async (_agent, _turn, _defaultDecision, _signal, next) => {
      if (steps < 2) return { action: 'continue' as const }
      return next()
    })

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(steps).toBe(2)
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]!.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'first half' }], provenance: { provider: 'mock', model: 'mock' } },
    ])
    expect(reasons).toEqual([{ kind: 'max-tokens' }])
  })

  it('a completed step after no max-tokens keeps the turn completed (max-tokens does not leak across turns)', async () => {
    // Two consecutive turns: turn 1 is cut off (max-tokens), turn 2 is a clean
    // stop. The per-turn reason must be independent — turn 2 ends completed.
    const adapter = new MockAdapter([maxTokensResponse('cut'), textResponse('clean')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

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
    ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: '',
      parameters: { text: { type: 'string' } },
      async execute() {
        executions += 1
        return [{ type: 'text', text: 'should not run' }]
      },
    }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(executions).toBe(0)
    expect(agent.session.events.some(e => e.type === 'tool/call')).toBe(false)
    expect(agent.session.deriveMessages()).toEqual([{ role: 'user', content: [{ type: 'text', text: 'go' }] }])
    expect(reasons).toEqual([{ kind: 'max-tokens' }])
    // Empty content still needs an assistant/message to carry usage; derivation
    // skips that host so it does not create a spurious assistant turn.
    const assistantMessage = agent.session.events.find(e => e.type === 'assistant/message')
    expect(assistantMessage?.type === 'assistant/message' && assistantMessage.data).toEqual({
      turn: 1, step: 1, content: [], provenance: { provider: 'mock', model: 'mock' }, usage: { inputTokens: 10, outputTokens: 5 },
    })
  })

  it('appends an empty completion anchor for a max-tokens step with no usage', async () => {
    // The truncated tool call is dropped from durable content, while the
    // successful provider call still needs an exact replay anchor.
    const callId = CallId('c1')
    const adapter = new MockAdapter([[
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: callId, name: 'echo', argumentsDelta: '{"text":"x"}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'echo', arguments: '{"text":"x"}' } },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ]])
    const ctx = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: '',
      parameters: { text: { type: 'string' } },
      async execute() { return [{ type: 'text', text: 'should not run' }] },
    }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(reasons).toEqual([{ kind: 'max-tokens' }])
    const assistant = agent.session.events.find(e => e.type === 'assistant/message')!
    expect(assistant.type === 'assistant/message' && assistant.data).toEqual({
      turn: 1,
      step: 1,
      content: [],
      provenance: { provider: 'mock', model: 'mock' },
    })
    expect(assistant.sourceEventSeqs?.length).toBeGreaterThan(0)
    expect(agent.session.deriveMessages()).toEqual([{ role: 'user', content: [{ type: 'text', text: 'go' }] }])
  })

  it('appends an empty completion anchor for a normal stop with no usage', async () => {
    // A clean content-less call stays absent from derived messages but remains
    // a durable successful-call boundary for replay consumers.
    const adapter = new MockAdapter([[{ type: 'finish', reason: { kind: 'stop' } }]])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(reasons).toEqual([{ kind: 'completed' }])
    const assistant = agent.session.events.find(e => e.type === 'assistant/message')!
    expect(assistant.type === 'assistant/message' && assistant.data).toEqual({
      turn: 1,
      step: 1,
      content: [],
      provenance: { provider: 'mock', model: 'mock' },
    })
    expect(assistant.sourceEventSeqs?.length).toBe(1)
    expect(agent.session.deriveMessages()).toEqual([{ role: 'user', content: [{ type: 'text', text: 'go' }] }])
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
    ctx.on('agent/step-result', async (_agent, _turn, _step, message, _signal, next) => {
      stepResults += 1
      expect(message.content).toEqual([{ type: 'text', text: 'partial text' }])
      return next()
    })
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(stepResults).toBe(1)
    expect(agent.session.events.some(e => e.type === 'tool/call')).toBe(false)
    expect(agent.session.deriveMessages()).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'partial text' }], provenance: { provider: 'mock', model: 'mock' } },
    ])
  })

  it('contains a step/end observer failure without changing continuation', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { text: 'x' }),
      textResponse('continued after tool call'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: '',
      parameters: { text: { type: 'string' } },
      async execute(args) {
        return [{ type: 'text', text: String(args.text) }]
      },
    }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    let threw = false
    // Post-commit session observers cannot control the loop. The tool call still
    // drives the second model request, and the turn completes normally.
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'step/end' && !threw) { threw = true; throw new Error('bad step/end listener') }
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(2)
    const turnEnd = agent.session.events.findLast(e => e.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason.kind).toBe('completed')
  })

  it('keeps same-tick sends in separate turns and checkpoints before the next starts', async () => {
    const adapter = new MockAdapter([textResponse('first answer'), textResponse('second answer')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    const firstFlush = Promise.withResolvers<undefined>()
    const releaseFirstFlush = Promise.withResolvers<undefined>()
    let flushes = 0
    ctx.on('session/flush', async (session) => {
      if (session !== agent.session) return
      flushes += 1
      if (flushes === 1) {
        firstFlush.resolve(undefined)
        await releaseFirstFlush.promise
      }
    })

    const turns: number[] = []
    ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'turn/start') turns.push(event.data.turn)
    })

    const idle = waitForIdle(ctx, agent)
    send(agent, 'first message')
    send(agent, 'second message')

    await firstFlush.promise
    expect(turns).toEqual([1])
    expect(adapter.requests).toHaveLength(1)

    releaseFirstFlush.resolve(undefined)
    await idle

    expect(turns).toEqual([1, 2])
    expect(flushes).toBe(2)
    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('first answer')
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('second message')
  })

  it('holds a turn-end listener send behind the closing turn checkpoint', async () => {
    const adapter = new MockAdapter([textResponse('first answer'), textResponse('second answer')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    const firstFlush = Promise.withResolvers<undefined>()
    const releaseFirstFlush = Promise.withResolvers<undefined>()
    let flushes = 0
    ctx.on('session/flush', async (session) => {
      if (session !== agent.session) return
      flushes += 1
      if (flushes === 1) {
        firstFlush.resolve(undefined)
        await releaseFirstFlush.promise
      }
    })

    const turns: number[] = []
    const statuses: string[] = []
    ctx.on('agent/status', (subject, status) => {
      if (subject === agent) statuses.push(status)
    })
    ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return
      if (event.type === 'turn/start') turns.push(event.data.turn)
      if (event.type === 'turn/end' && event.data.turn === 1) send(agent, 'turn-end listener message')
    })

    const idle = waitForIdle(ctx, agent)
    send(agent, 'first message')
    await firstFlush.promise

    expect(turns).toEqual([1])
    expect(adapter.requests).toHaveLength(1)

    releaseFirstFlush.resolve(undefined)
    await idle

    expect(turns).toEqual([1, 2])
    expect(statuses).toEqual(['running', 'idle'])
    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('first answer')
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('turn-end listener message')
  })

  it('keeps a reentrant agent/queued send as the next independent turn', async () => {
    const adapter = new MockAdapter([textResponse('first'), textResponse('second')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    let nested = false
    ctx.on('agent/queued', (subject) => {
      if (subject !== agent || nested) return
      nested = true
      send(agent, 'queued listener message')
    })

    const idle = waitForIdle(ctx, agent)
    send(agent, 'outer message')
    await idle

    const turns = agent.session.events.filter(event => event.type === 'turn/start')
    const messages = agent.session.events
      .filter(event => event.type === 'user/message')
      .map(event => event.data.content)
    expect(turns).toHaveLength(2)
    expect(messages).toEqual([
      [{ type: 'text', text: 'outer message' }],
      [{ type: 'text', text: 'queued listener message' }],
    ])
  })

  it('preserves independent turn sources across an adjacent microtask send', async () => {
    const adapter = new MockAdapter([textResponse('first'), textResponse('second')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    const idle = waitForIdle(ctx, agent)
    agent.send([{ type: 'text', text: 'user message' }])
    await Promise.resolve()
    agent.send(
      [{ type: 'text', text: 'plugin message' }],
      { source: { kind: 'plugin', plugin: 'test' } },
    )
    await idle

    const triggers = agent.session.events
      .filter(event => event.type === 'turn/start')
      .map(event => event.data.trigger)
    const sources = agent.session.events
      .filter(event => event.type === 'user/message')
      .map(event => event.data.source)
    expect(triggers).toEqual([
      { kind: 'message', source: { kind: 'user' } },
      { kind: 'message', source: { kind: 'plugin', plugin: 'test' } },
    ])
    expect(sources).toEqual([
      { kind: 'user' },
      { kind: 'plugin', plugin: 'test' },
    ])
  })

  it('keeps a session-listener send after dequeue in the following turn', async () => {
    const adapter = new MockAdapter([textResponse('first'), textResponse('second')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    const turns: number[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/start') turns.push(event.data.turn) })

    // queue two messages while idle — first starts turn 1 immediately;
    // queue the second during turn 1 when the first assistant chunk streams
    let queued = false
    ctx.on('session/event', (_s, event) => {
      if (event.type === 'assistant/chunk' && !queued) {
        queued = true
        send(agent, 'second message')
      }
    })

    send(agent, 'first message')
    await waitForIdle(ctx, agent)

    expect(turns).toEqual([1, 2])
    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('first')
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('second message')
  })

  it('keeps a model-adapter callback send in the following turn', async () => {
    const agentRef: { current?: Agent } = {}
    const adapter = new MockAdapter([
      () => {
        const agent = agentRef.current
        if (agent === undefined) throw new Error('model callback ran before agent setup')
        send(agent, 'model callback message')
        return textResponse('first')
      },
      textResponse('second'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agentRef.current = agent

    const idle = waitForIdle(ctx, agent)
    send(agent, 'outer message')
    await idle

    const messages = agent.session.events
      .filter(event => event.type === 'user/message')
      .map(event => event.data.content)
    expect(agent.session.events.filter(event => event.type === 'turn/start')).toHaveLength(2)
    expect(messages).toEqual([
      [{ type: 'text', text: 'outer message' }],
      [{ type: 'text', text: 'model callback message' }],
    ])
  })

  it('awaits session/flush at turn end (persistence checkpoint)', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

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
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    const errors: Error[] = []
    const reasons: TurnEndReason[] = []
    ctx.on('agent/error', (_agent, _turn, _step, error) => void errors.push(error))
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'hi')
    await waitForIdle(ctx, agent)

    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toContain('script exhausted')
    expect(reasons[0]).toMatchObject({ kind: 'error' })
    // The durable failure lives entirely on turn/end.reason (with the failing
    // step), not a standalone error event.
    const turnEnd = agent.session.events.find(e => e.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason).toMatchObject({ kind: 'error', step: 1 })
  })

  it('disposing the loop fiber mid-turn stops the loop (HMR safety)', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)

    let agent!: Agent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create(SessionId('scoped'), { provider: 'mock', model: 'mock' })
    }, { inject: ['agentLoop'] }))

    expect(ctx.agents.get(SessionId('scoped'))).toBe(agent)
    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    expect(agent.status).toBe('running')

    await fiber.dispose()
    await driverDone(agent)

    expect(agent.status).toBe('disposed')
    expect(ctx.agents.get(SessionId('scoped'))).toBeUndefined()
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
      agents: [{ id: SessionId('config-agent'), provider: 'mock', model: 'mock' }],
    })
    ctx.llm.registerAdapter(['mock'], adapter)

    const agent = ctx.agents.list()[0]!
    expect(agent).toBeDefined()
    expect(agent.id).toBe(agent.session.id)
    expect(agent.id).toMatch(/^config-agent-session-/)
    expect(agent.options.model).toBe('mock')

    // the agent is alive: send triggers a turn
    send(agent, 'hi')
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1)
  })

  it('attaches config agent cwd to the fresh session header', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, {
      agents: [{ id: SessionId('config-agent'), provider: 'mock', model: 'mock', cwd: '/work/project' }],
    })

    const agent = ctx.agents.list()[0]!
    expect(agent.session.header.cwd).toBe('/work/project')
  })

  it('replays a session log into an identical derived history', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { text: 'x' }),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: '',
      parameters: { text: { type: 'string' } },
      async execute(args) {
        return [{ type: 'text', text: String(args.text) }]
      },
    }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    send(agent, 'run')
    await waitForIdle(ctx, agent)

    const replayed = ctx.sessions.create(SessionId('replayed'), { seed: [...agent.session.events] })
    expect(replayed.deriveMessages()).toEqual(agent.session.deriveMessages())
    // event-by-event identity of types
    expect(replayed.events.map(e => e.type)).toEqual(
      agent.session.events.map(e => e.type))
  })
})
