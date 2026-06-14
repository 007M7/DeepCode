import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LlmService, { CallId, ContentBlock, MessageSource, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionEvent, SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { AgentId } from '@deepseek-ai/dsh-agent'
import AgentLoop, { LoopAgent } from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

/**
 * Regression tests for the findings of the first architecture review
 * (Codex + sub-agent, post phase-1). Each describe block names the finding.
 */

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

describe('HIGH: session log records what agent/step-result actually produced', () => {
  it('a step-result rewrite is what the log, derived history, and tool dispatch all see', async () => {
    const adapter = new MockAdapter([textResponse('original'), textResponse('done')])
    const ctx = await harness(adapter)
    const executed: string[] = []
    ctx.tools.register(defineTool({
      name: 'injected-tool',
      description: '',
      parameters: {},
      async execute() {
        executed.push('injected-tool')
        return [{ type: 'text', text: 'ran' }]
      },
    }))
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

    // Plugin rewrites the message: replaces the text AND adds a tool call.
    let rewritten = false
    ctx.on('agent/step-result', async (_agent, _turn, _step, _message, next) => {
      if (rewritten) return next()
      rewritten = true
      return {
        role: 'assistant' as const,
        content: [
          { type: 'text' as const, text: 'rewritten' },
          { type: 'tool-call' as const, id: CallId('c-injected'), name: 'injected-tool', arguments: '{}' },
        ],
      }
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    // the injected tool call was dispatched…
    expect(executed).toEqual(['injected-tool'])
    // …and the session log recorded the REWRITTEN message, not the original
    const recorded = agent.session.events.find(e => e.type === 'assistant/message')!
    expect(JSON.stringify(recorded.data)).toContain('rewritten')
    expect(JSON.stringify(recorded.data)).not.toContain('original')
    // tool/call + tool/result correlate with the injected call id
    const callEvent = agent.session.events.find(e => e.type === 'tool/call')!
    if (callEvent.type !== 'tool/call') throw new Error('wrong event type')
    expect(callEvent.data.callId).toBe('c-injected')
    // derived history shows the rewritten message (replay-correct)
    const derived = agent.session.deriveMessages()
    expect(JSON.stringify(derived)).toContain('rewritten')
    expect(JSON.stringify(derived)).not.toContain('original')
  })
})

describe('HIGH: abort during tool execution ends the turn', () => {
  it('abort() inside a tool prevents both remaining tools and the next model step', async () => {
    const adapter = new MockAdapter([
      // model asks for two tool calls in one step
      [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('c1'), name: 'aborter', arguments: '{}' } },
        { type: 'block-start', index: 1, blockType: 'tool-call' },
        { type: 'block-end', index: 1, block: { type: 'tool-call', id: CallId('c2'), name: 'second', arguments: '{}' } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ] satisfies StreamChunk[],
      textResponse('should never be requested'),
    ])
    const ctx = await harness(adapter)
    const executed: string[] = []
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })
    ctx.tools.register(defineTool({
      name: 'aborter',
      description: '',
      parameters: {},
      async execute() {
        executed.push('aborter')
        agent.abort('user interrupt')
        return [{ type: 'text', text: 'done' }]
      },
    }))
    ctx.tools.register(defineTool({
      name: 'second',
      description: '',
      parameters: {},
      async execute() {
        executed.push('second')
        return [{ type: 'text', text: 'done' }]
      },
    }))

    const reasons: TurnEndReason[] = []
    ctx.on('agent/turn-end', (_agent, _turn, reason) => void reasons.push(reason))

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(executed).toEqual(['aborter'])           // second tool never ran
    expect(adapter.requests).toHaveLength(1)        // no follow-up model call
    expect(reasons).toEqual([{ kind: 'aborted', reason: 'user interrupt' }])
  })
})

describe('HIGH: steering from late extension points is never stranded', () => {
  it('steer() from an agent/step-end listener reaches the next request (/goal pattern)', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { text: 'x' }),
      textResponse('after steering'),
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

    let steeredOnce = false
    ctx.on('agent/step-end', () => {
      if (steeredOnce) return
      steeredOnce = true
      agent.steer([{ type: 'text', text: 'goal reminder from step-end' }])
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('goal reminder from step-end')
  })

  it('steer() from an agent/turn-continuation listener overrides a stop decision', async () => {
    const adapter = new MockAdapter([
      textResponse('no tools, would stop here'),
      textResponse('continued because of steering'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

    let steeredOnce = false
    ctx.on('agent/turn-continuation', async (_agent, _turn, _decision, next) => {
      if (!steeredOnce) {
        steeredOnce = true
        agent.steer([{ type: 'text', text: 'one more thing' }])
      }
      return next()
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    // the default decision was false (no tools), but steering forced step 2
    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('one more thing')
  })

  it('steer() from an agent/turn-end listener becomes a queued message for the next turn', async () => {
    const adapter = new MockAdapter([textResponse('turn 1'), textResponse('turn 2')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

    let steeredOnce = false
    ctx.on('agent/turn-end', () => {
      if (steeredOnce) return
      steeredOnce = true
      agent.steer([{ type: 'text', text: 'too late for this turn' }])
    })

    const turns: number[] = []
    ctx.on('agent/turn-start', (_agent, turn) => void turns.push(turn))

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    // the loop chains directly into turn 2 (status never returns to idle in
    // between), so the first idle transition means both turns are complete

    expect(turns).toEqual([1, 2])
    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('too late for this turn')
  })

  it('steering queued during an aborted step is re-delivered, not silently consumed', async () => {
    const adapter = new MockAdapter(['hang', textResponse('recovered')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    agent.steer([{ type: 'text', text: 'redirect' }])
    agent.abort('user interrupt')
    await waitForIdle(ctx, agent)

    // a new turn ran with the steering content delivered as a message
    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('redirect')
  })
})

describe('HIGH: plugin exceptions are contained', () => {
  it('a throwing agent/turn-continuation listener ends the turn with an error, loop survives', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

    let threwOnce = false
    ctx.on('agent/turn-continuation', async (): Promise<boolean> => {
      if (!threwOnce) {
        threwOnce = true
        throw new Error('broken continuation plugin')
      }
      return false
    })

    const errors: Error[] = []
    ctx.on('agent/error', (_agent, _turn, _step, error) => void errors.push(error))

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    expect(errors.map(e => e.message)).toEqual(['broken continuation plugin'])

    // the loop is still alive: a second send works normally
    send(agent, 'second')
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(2)
    expect(agent.status).toBe('idle')
  })

  it('a rejecting session/flush listener is reported but does not kill the agent', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })

    let rejectedOnce = false
    ctx.on('session/flush', async () => {
      if (!rejectedOnce) {
        rejectedOnce = true
        throw new Error('disk full')
      }
    })

    const errors: Error[] = []
    ctx.on('agent/error', (_agent, _turn, _step, error) => void errors.push(error))

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    expect(errors.map(e => e.message)).toEqual(['disk full'])

    send(agent, 'second')
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(2)
  })
})

describe('MEDIUM: disposed status is part of the agent/status contract', () => {
  it('disposing the fiber emits agent/status(disposed) and ends the turn with reason disposed', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)

    let agent!: LoopAgent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create('scoped', { model: 'mock' })
    }, { inject: ['agentLoop'] }))

    const statuses: string[] = []
    const reasons: TurnEndReason[] = []
    ctx.on('agent/status', (_agent, status) => void statuses.push(status))
    ctx.on('agent/turn-end', (_agent, _turn, reason) => void reasons.push(reason))

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    await fiber.dispose()
    await agent.done

    expect(statuses).toEqual(['running', 'disposed'])
    expect(reasons).toEqual([{ kind: 'disposed' }])
  })

  it('a throwing agent/status listener cannot break disposal or leak the registry entry', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)

    let agent!: LoopAgent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create('scoped', { model: 'mock' })
    }, { inject: ['agentLoop'] }))

    ctx.on('agent/status', (_agent, status) => {
      if (status === 'disposed') throw new Error('broken status listener')
    })

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    await fiber.dispose()
    await agent.done // must not hang

    expect(agent.status).toBe('disposed')
    expect(ctx.agents.get('scoped')).toBeUndefined() // unregistered despite the throw
  })
})

describe('MEDIUM: misc registry and config fixes', () => {
  it('duplicate adapter registration is rejected', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    const adapter = new MockAdapter([])
    ctx.llm.registerAdapter(['m1'], adapter)
    expect(() => ctx.llm.registerAdapter(['m1'], new MockAdapter([])))
      .toThrow('already registered')
    // the original registration survives the failed attempt
    expect(ctx.llm.models()).toEqual(['m1'])
  })

  it('an agent without a model fails the step with a clear error (not NO_ADAPTER for "default")', async () => {
    const adapter = new MockAdapter([textResponse('never')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a1', {}) // no model

    const errors: Error[] = []
    ctx.on('agent/error', (_agent, _turn, _step, error) => void errors.push(error))

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toContain('has no model')
    expect(errors[0]!.message).toContain('agent/request')
  })

  it('the agent/request waterfall can supply the model for a model-less agent', async () => {
    const adapter = new MockAdapter([textResponse('routed')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a1', {}) // no model — router plugin decides

    ctx.on('agent/request', async (_agent, _turn, _step, options, next) => {
      options.model = 'mock'
      return next()
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.deriveMessages().at(-1)?.content).toEqual([{ type: 'text', text: 'routed' }])
  })

  it('agent/queued carries the resolved source; agent/steering carries its source', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'noop', {}), textResponse('done')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })
    ctx.tools.register(defineTool({
      name: 'noop',
      description: '',
      parameters: {},
      async execute() {
        agent.steer([{ type: 'text', text: 's' }], { source: { kind: 'plugin', plugin: 'goal' } })
        return []
      },
    }))

    const queuedSources: { source: MessageSource; steering: boolean }[] = []
    const steeringSources: MessageSource[] = []
    ctx.on('agent/queued', (_agent, _content, info) => void queuedSources.push(info))
    ctx.on('agent/steering', (_agent, _turn, _content, source) => void steeringSources.push(source))

    send(agent, 'go') // no explicit source → default {kind:'user'} must be visible
    await waitForIdle(ctx, agent)

    expect(queuedSources[0]).toEqual({ source: { kind: 'user' }, steering: false })
    expect(queuedSources[1]).toEqual({ source: { kind: 'plugin', plugin: 'goal' }, steering: true })
    expect(steeringSources).toEqual([{ kind: 'plugin', plugin: 'goal' }])
  })
})

describe('MEDIUM: turn numbering continues across seeded (forked) sessions', () => {
  it('a forked agent continues turn numbers after the seed log', async () => {
    const first = new MockAdapter([textResponse('turn one')])
    const ctx = await harness(first)
    const agent = ctx.agentLoop.create('a1', { model: 'mock' })
    send(agent, 'first')
    await waitForIdle(ctx, agent)

    // fork: seed a second context's agent with the first session's log
    const second = new MockAdapter([textResponse('turn two')])
    const ctx2 = new Context()
    await ctx2.plugin(LlmService)
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SystemPrompt)
    await ctx2.plugin(ToolRegistry)
    await ctx2.plugin(AgentRegistry)
    await ctx2.plugin(AgentLoop, { agents: [] })
    ctx2.llm.registerAdapter(['mock'], second)

    const seeded = ctx2.sessions.create('forked', [...agent.session.events])
    const forked = new LoopAgent(ctx2, AgentId('forked-agent'), { model: 'mock' }, seeded)
    ctx2.effect(() => forked.start())

    const turns: number[] = []
    ctx2.on('agent/turn-start', (_agent, turn) => void turns.push(turn))
    forked.send([{ type: 'text', text: 'continue' }])
    await new Promise<void>((resolve) => {
      ctx2.on('agent/status', (subject, status) => {
        if (subject === forked && status === 'idle') resolve()
      })
    })

    expect(turns).toEqual([2])
  })
})

describe('LOW: BlockAssembler and streamBlocks edge cases', () => {
  it('ignores deltas arriving after block-end for the same index (malformed stream)', async () => {
    const { BlockAssembler } = await import('@deepseek-ai/dsh-llm')
    const assembler = new BlockAssembler()
    assembler.push({ type: 'block-start', index: 0, blockType: 'text' })
    assembler.push({ type: 'text-delta', index: 0, text: 'good' })
    assembler.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'good' } })
    assembler.push({ type: 'text-delta', index: 0, text: ' straggler' })
    expect(assembler.blocks()).toEqual([{ type: 'text', text: 'good' }])
  })

  it('assembles tool-call blocks from deltas without block-end', async () => {
    const { BlockAssembler } = await import('@deepseek-ai/dsh-llm')
    const assembler = new BlockAssembler()
    assembler.push({ type: 'tool-call-delta', index: 0, id: CallId('c9'), name: 'echo', argumentsDelta: '{"a"' })
    assembler.push({ type: 'tool-call-delta', index: 0, id: CallId('c9'), argumentsDelta: ':1}' })
    expect(assembler.blocks()).toEqual([
      { type: 'tool-call', id: CallId('c9'), name: 'echo', arguments: '{"a":1}' },
    ])
  })

  it('streamBlocks flushes delta-only blocks at end of stream (matches generate())', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    const deltaOnly: StreamChunk[] = [
      { type: 'text-delta', index: 0, text: 'no ' },
      { type: 'text-delta', index: 0, text: 'block-end' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    ctx.llm.registerAdapter(['m'], new MockAdapter([deltaOnly, deltaOnly]))

    const blocks: ContentBlock[] = []
    for await (const block of ctx.llm.streamBlocks({ model: 'm', messages: [] })) blocks.push(block)
    expect(blocks).toEqual([{ type: 'text', text: 'no block-end' }])

    const generated = await ctx.llm.generate({ model: 'm', messages: [] })
    expect(generated.message.content).toEqual(blocks)
  })

  it('streamBlocks preserves stream order when an open block precedes a closed one', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    // index 0 never gets block-end (delta-only); index 1 closes mid-stream.
    const interleaved: StreamChunk[] = [
      { type: 'text-delta', index: 0, text: 'first, open' },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'second, closed' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'second, closed' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    ctx.llm.registerAdapter(['m'], new MockAdapter([interleaved, interleaved]))

    const blocks: ContentBlock[] = []
    for await (const block of ctx.llm.streamBlocks({ model: 'm', messages: [] })) blocks.push(block)
    expect(blocks).toEqual([
      { type: 'text', text: 'first, open' },
      { type: 'text', text: 'second, closed' },
    ])

    // identical to generate()'s assembled order
    const generated = await ctx.llm.generate({ model: 'm', messages: [] })
    expect(generated.message.content).toEqual(blocks)
  })

  it('streamBlocks yields closed blocks incrementally once preceding blocks close', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    const script: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'a' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'a' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'b' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'b' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    ctx.llm.registerAdapter(['m'], new MockAdapter([script]))

    const blocks: ContentBlock[] = []
    for await (const block of ctx.llm.streamBlocks({ model: 'm', messages: [] })) blocks.push(block)
    expect(blocks).toEqual([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])
  })
})

describe('LOW: discriminated SessionEvent narrows without casts', () => {
  it('narrows event.data from event.type', () => {
    const session = new Session(SessionId('s'))
    const appended: SessionEvent = session.append('tool/call', {
      turn: 1, step: 1, callId: CallId('c1'), name: 'echo', arguments: '{}',
    })
    // compile-time: this switch narrows; runtime: values flow through
    switch (appended.type) {
      case 'tool/call': {
        expect(appended.data.callId).toBe('c1')
        expect(appended.data.name).toBe('echo')
        break
      }
      default: throw new Error('wrong narrow')
    }
  })
})

describe('HIGH: a finish-error stream chunk ends the turn as error, not completed', () => {
  it('translates finish {kind:error} into a turn error with a logged error event', async () => {
    // The second sanctioned adapter error path (besides throwing): an
    // adapter that cannot throw mid-stream ends the stream with a
    // finish-error chunk (e.g. the pi-ai adapter mapping a provider 401).
    // The loop must NOT log a normal assistant/message + completed turn.
    const errorStream: StreamChunk[] = [
      { type: 'finish', reason: { kind: 'error', message: 'provider 401', code: 'AUTH' } },
    ]
    const adapter = new MockAdapter([errorStream])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a-finish-error', { model: 'mock' })

    const reasons: TurnEndReason[] = []
    ctx.on('agent/turn-end', (_agent, _turn, reason) => void reasons.push(reason))

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(reasons).toEqual([{ kind: 'error', message: 'provider 401', code: 'AUTH' }])

    const events = [...agent.session.events]
    expect(events.some(event => event.type === 'error'
      && event.data.message === 'provider 401' && event.data.code === 'AUTH')).toBe(true)
    // Crucially: no assistant/message was logged for the failed step.
    expect(events.some(event => event.type === 'assistant/message')).toBe(false)
  })

  it('translates finish {kind:aborted} into a turn error coded ABORTED', async () => {
    const abortedStream: StreamChunk[] = [
      { type: 'finish', reason: { kind: 'aborted' } },
    ]
    const adapter = new MockAdapter([abortedStream])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a-finish-aborted', { model: 'mock' })

    const reasons: TurnEndReason[] = []
    ctx.on('agent/turn-end', (_agent, _turn, reason) => void reasons.push(reason))

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(reasons).toEqual([{ kind: 'error', message: 'model stream aborted', code: 'ABORTED' }])
    expect([...agent.session.events].some(event => event.type === 'assistant/message')).toBe(false)
  })

  it('handles a finish error without a code (code key omitted)', async () => {
    const errorStream: StreamChunk[] = [
      { type: 'finish', reason: { kind: 'error', message: 'codeless failure' } },
    ]
    const adapter = new MockAdapter([errorStream])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a-finish-error-nocode', { model: 'mock' })

    const reasons: TurnEndReason[] = []
    ctx.on('agent/turn-end', (_agent, _turn, reason) => void reasons.push(reason))

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(reasons).toEqual([{ kind: 'error', message: 'codeless failure' }])
  })
})

describe('P1-6: step/start is appended before agent/step-start is emitted', () => {
  it('a step-start listener sees the step/start event already in session.events', async () => {
    const adapter = new MockAdapter([textResponse('done')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a-step-order', { model: 'mock' })

    // Capture, at the moment agent/step-start fires, whether the matching
    // step/start event is already in the log (append-before-emit, ADR 0003).
    const observed: { turn: number; step: number; lastEventType: string | undefined; sawStepStart: boolean }[] = []
    ctx.on('agent/step-start', (subject, turn, step) => {
      if (subject !== agent) return
      const events = [...subject.session.events]
      const last = events.at(-1)
      observed.push({
        turn,
        step,
        lastEventType: last?.type,
        sawStepStart: events.some(e => e.type === 'step/start' && e.data.turn === turn && e.data.step === step),
      })
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(observed).toHaveLength(1)
    expect(observed[0]).toMatchObject({ turn: 1, step: 1, lastEventType: 'step/start', sawStepStart: true })
  })
})
