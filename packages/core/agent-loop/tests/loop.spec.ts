import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LlmService, { CallId, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { AgentId } from '@deepseek-ai/dsh-agent'
import AgentLoop, { ReactLoopAgent } from '@deepseek-ai/dsh-agent-loop'
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

function send(agent: ReactLoopAgent, text: string) {
  agent.send([{ type: 'text', text }])
}

describe('agent loop', () => {
  it('runs a simple turn: queued message → model → idle, with ordered events', async () => {
    const adapter = new MockAdapter([textResponse('hello there')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

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
    ctx.tools.register(defineTool({
      name: 'echo',
      description: 'echo back',
      parameters: { text: { type: 'string' } },
      async execute(args) {
        return [{ type: 'text', text: `echo: ${args.text}` }]
      },
    }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

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

  it('threads a tool-attached meta (execute object return) onto the tool/result event', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'writer', { path: 'a.txt' }, 'writing'),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    // A tool that returns the { content, meta } object form: the loop must
    // persist `meta` on the tool/result event so a UI reproduces the card on replay.
    ctx.tools.register(defineTool({
      name: 'writer',
      description: 'writes a file',
      parameters: { path: { type: 'string' } },
      async execute() {
        return { content: [{ type: 'text', text: 'ok' }], meta: { diffs: [{ path: 'a.txt', oldText: null, newText: 'x' }] } }
      },
    }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    send(agent, 'use the tool')
    await waitForIdle(ctx, agent)

    const toolResult = agent.session.events.find(e => e.type === 'tool/result')
    expect(toolResult?.type === 'tool/result' && toolResult.data.meta)
      .toEqual({ diffs: [{ path: 'a.txt', oldText: null, newText: 'x' }] })
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
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock', systemPrompt: 'Agent-specific suffix.' })

    send(agent, 'hi')
    await waitForIdle(ctx, agent)

    const request = adapter.requests[0]
    expect(request!.system).toBe('You are a test agent.\n\nAgent-specific suffix.')
    expect(request!.tools?.map(t => t.name)).toEqual(['noop'])
  })

  it('records raw chunks for replay as assistant/chunk session events', async () => {
    const adapter = new MockAdapter([textResponse('abc')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

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

    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
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
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    agent.steer([{ type: 'text', text: 'hello' }])
    await waitForIdle(ctx, agent)
    expect(agent.session.events.some(e => e.type === 'user/message')).toBe(true)
  })

  it('inject() while idle wraps context in a one-shot turn, visible to the next request', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

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
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
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
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    let steps = 0
    ctx.on('session/event', (_session, event) => { if (event.type === 'step/end') steps++ })
    ctx.on('agent/turn-continuation', async (_agent, _turn, _defaultDecision, next) => {
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
    ctx.tools.register(defineTool({
      name: 'echo',
      description: '',
      parameters: { text: { type: 'string' } },
      async execute(args) {
        return [{ type: 'text', text: String(args.text) }]
      },
    }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    ctx.on('agent/turn-continuation', async () => ({ action: 'stop' }) as const)

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
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    ctx.on('agent/request', async (_agent, _turn, _step, options, next) => {
      options.model = 'other-model'
      return next()
    })

    send(agent, 'hi')
    await waitForIdle(ctx, agent)
    expect(adapter.requests[0]!.model).toBe('other-model')
  })

  it('agent/pre-step fires once per step before the step is opened', async () => {
    // Two steps (a tool call, then a final text turn) → two model calls → two
    // pre-step fires, each carrying the assembled full system prompt, BEFORE
    // the step is opened and its request is derived (the request the adapter
    // sees reflects any surface state at fire time).
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', {}, 'calling echo'),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineTool({
      name: 'echo', description: 'echo', parameters: {},
      async execute() { return [{ type: 'text', text: 'echoed' }] },
    }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    const fires: { turn: number; step: number; fullSystemPrompt: string }[] = []
    ctx.on('agent/pre-step', (subject, turn, step, fullSystemPrompt) => {
      if (subject === agent) fires.push({ turn, step, fullSystemPrompt })
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    // One fire per step, in order, each with the assembled system prompt.
    expect(fires).toEqual([
      { turn: 1, step: 1, fullSystemPrompt: '' },
      { turn: 1, step: 2, fullSystemPrompt: '' },
    ])
  })

  it('agent/pre-step fires BEFORE the step it precedes opens (events land outside the step)', async () => {
    // A listener appending a surface node in pre-step lands it BEFORE step/start
    // in the log — proving the seam fires outside the step. The node is still in
    // the derived request for that step (derive happens after step/start).
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

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
    // The seam fires before step/start, so a throw escapes to runTurn's outer
    // catch: the not-yet-open step closes as a no-op, the failure surfaces via
    // agent/error, and the turn ends `error` (recorded on the durable turn/end).
    // The loop survives and a follow-up prompt still runs.
    const adapter = new MockAdapter([textResponse('second turn ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

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
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    // wait until the stream is hanging, then cancel
    await new Promise(r => setTimeout(r, 30))
    expect(agent.status).toBe('running')
    agent.cancel('user interrupt')
    await waitForIdle(ctx, agent)

    expect(reasons).toEqual([{ kind: 'aborted', reason: 'user interrupt' }])
  })

  it('surfaces max-tokens as the turn-end reason when the last step is cut off', async () => {
    // A single step that ends with a max-tokens finish (no tool calls): the
    // turn stops by default and ends max-tokens, not completed.
    const adapter = new MockAdapter([maxTokensResponse('truncat')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

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
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    let steps = 0
    ctx.on('session/event', (_session, event) => { if (event.type === 'step/end') steps++ })
    // Force exactly one continuation (step 1 → step 2), then defer to default
    // (step 2 is a plain stop with no tool calls → stops).
    ctx.on('agent/turn-continuation', async (_agent, _turn, _defaultDecision, next) => {
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
      { role: 'assistant', content: [{ type: 'text', text: 'first half' }] },
    ])
    expect(reasons).toEqual([{ kind: 'max-tokens' }])
  })

  it('a completed step after no max-tokens keeps the turn completed (max-tokens does not leak across turns)', async () => {
    // Two consecutive turns: turn 1 is cut off (max-tokens), turn 2 is a clean
    // stop. The per-turn reason must be independent — turn 2 ends completed.
    const adapter = new MockAdapter([maxTokensResponse('cut'), textResponse('clean')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

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
    ctx.tools.register(defineTool({
      name: 'echo',
      description: '',
      parameters: { text: { type: 'string' } },
      async execute() {
        executions += 1
        return [{ type: 'text', text: 'should not run' }]
      },
    }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(executions).toBe(0)
    expect(agent.session.events.some(e => e.type === 'tool/call')).toBe(false)
    expect(agent.session.deriveMessages()).toEqual([{ role: 'user', content: [{ type: 'text', text: 'go' }] }])
    expect(reasons).toEqual([{ kind: 'max-tokens' }])
    // No-data-loss: a max-tokens step whose only content was a dropped tool call
    // has EMPTY assistant content, but its usage must still be represented. It
    // rides on an (empty-content) assistant/message — there is no standalone
    // usage event — and that empty message is skipped by deriveMessages(), so
    // the derived history above is NOT corrupted by a spurious assistant turn.
    const assistantMessage = agent.session.events.find(e => e.type === 'assistant/message')
    expect(assistantMessage?.type === 'assistant/message' && assistantMessage.data).toEqual({
      turn: 1, step: 1, content: [], usage: { inputTokens: 10, outputTokens: 5 },
    })
  })

  it('appends no assistant/message for a max-tokens step with empty content and no usage', async () => {
    // A max-tokens step truncated to a dropped tool call AND with no usage chunk
    // has nothing to record: empty content and no accounting → no assistant/message
    // (the empty-content host exists only to carry usage). The turn still ends
    // max-tokens.
    const callId = CallId('c1')
    const adapter = new MockAdapter([[
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: callId, name: 'echo', argumentsDelta: '{"text":"x"}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'echo', arguments: '{"text":"x"}' } },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ]])
    const ctx = await harness(adapter)
    ctx.tools.register(defineTool({
      name: 'echo',
      description: '',
      parameters: { text: { type: 'string' } },
      async execute() { return [{ type: 'text', text: 'should not run' }] },
    }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(reasons).toEqual([{ kind: 'max-tokens' }])
    expect(agent.session.events.some(e => e.type === 'assistant/message')).toBe(false)
    expect(agent.session.deriveMessages()).toEqual([{ role: 'user', content: [{ type: 'text', text: 'go' }] }])
  })

  it('appends no assistant/message for a normal stop finish with empty content and no usage', async () => {
    // A clean `stop` finish that streamed nothing assembled (no blocks) and
    // carried no usage chunk has nothing to record: the content-or-usage guard
    // on the normal step path suppresses a pure trace-only empty assistant/message.
    const adapter = new MockAdapter([[{ type: 'finish', reason: { kind: 'stop' } }]])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(reasons).toEqual([{ kind: 'completed' }])
    expect(agent.session.events.some(e => e.type === 'assistant/message')).toBe(false)
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
    ctx.on('agent/step-result', async (_agent, _turn, _step, message, next) => {
      stepResults += 1
      expect(message.content).toEqual([{ type: 'text', text: 'partial text' }])
      return next()
    })
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(stepResults).toBe(1)
    expect(agent.session.events.some(e => e.type === 'tool/call')).toBe(false)
    expect(agent.session.deriveMessages()).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'partial text' }] },
    ])
  })

  it('stops the turn when a step/end session-event listener failure has recorded an error', async () => {
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
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    let threw = false
    // A throwing step/end session-event listener is the surviving boundary-listener
    // failure path (step boundaries have no agent/* mirror): closeStep contains it
    // and surfaces it as a turn error rather than stranding the turn open.
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'step/end' && !threw) { threw = true; throw new Error('bad step/end listener') }
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
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

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
  })

  it('awaits session/flush at turn end (persistence checkpoint)', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

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
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

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

    let agent!: ReactLoopAgent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create(AgentId('scoped'), { model: 'mock' })
    }, { inject: ['agentLoop'] }))

    expect(ctx.agents.get(AgentId('scoped'))).toBe(agent)
    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    expect(agent.status).toBe('running')

    await fiber.dispose()
    await agent.done

    expect(agent.status).toBe('disposed')
    expect(ctx.agents.get(AgentId('scoped'))).toBeUndefined()
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
      agents: [{ id: AgentId('config-agent'), model: 'mock', systemPrompt: 'Config prompt' }],
    })
    ctx.llm.registerAdapter(['mock'], adapter)

    const agent = ctx.agents.get(AgentId('config-agent'))! as ReactLoopAgent
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
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    send(agent, 'run')
    await waitForIdle(ctx, agent)

    const replayed = ctx.sessions.create(SessionId('replayed'), { seed: [...agent.session.events] })
    expect(replayed.deriveMessages()).toEqual(agent.session.deriveMessages())
    // event-by-event identity of types
    expect(replayed.events.map(e => e.type)).toEqual(
      agent.session.events.map(e => e.type))
  })
})
