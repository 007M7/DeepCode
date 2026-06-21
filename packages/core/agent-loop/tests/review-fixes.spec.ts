import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LlmService, { CallId, MessageSource, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionEvent, SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { AgentId } from '@deepseek-ai/dsh-agent'
import AgentLoop, { ReactLoopAgent } from '@deepseek-ai/dsh-agent-loop'
import * as Invariants from '@deepseek-ai/dsh-invariants'
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

    let agent!: ReactLoopAgent
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

    let agent!: ReactLoopAgent
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

    const seeded = ctx2.sessions.create('forked', { seed: [...agent.session.events] })
    const forked = new ReactLoopAgent(ctx2, AgentId('forked-agent'), { model: 'mock' }, seeded)
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
    // step/start event is already in the log (append-before-emit, the event-sourcing RFC).
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

describe('P1-5: a started turn (and any open step) is always closed on a boundary throw', () => {
  // Harness with the invariants plugin loaded as an oracle: it throws on
  // append if the log goes unbalanced (turn/end while a step is open,
  // turn/start while a turn is open, etc.), so a regression surfaces as an
  // InvariantError on the NEXT turn's append rather than a silent imbalance.
  async function balancedHarness(adapter: MockAdapter) {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Invariants, { freeze: false })
    ctx.llm.registerAdapter(['mock'], adapter)
    return ctx
  }

  /** Count turn/step boundary events for balance assertions. */
  function boundaryCounts(agent: ReactLoopAgent) {
    const e = [...agent.session.events]
    return {
      turnStart: e.filter(x => x.type === 'turn/start').length,
      turnEnd: e.filter(x => x.type === 'turn/end').length,
      stepStart: e.filter(x => x.type === 'step/start').length,
      stepEnd: e.filter(x => x.type === 'step/end').length,
      errors: e.filter(x => x.type === 'error').length,
      lastTurnEnd: e.findLast(x => x.type === 'turn/end'),
    }
  }

  it('a throwing agent/turn-start listener still closes the turn with exactly one error and one turn/end, no step', async () => {
    const adapter = new MockAdapter([textResponse('never reached')])
    const ctx = await balancedHarness(adapter)
    const agent = ctx.agentLoop.create('a-turnstart', { model: 'mock' })

    let threw = false
    ctx.on('agent/turn-start', () => { if (!threw) { threw = true; throw new Error('boom turn-start') } })
    const errors: Error[] = []
    ctx.on('agent/error', (_a, _t, _s, error) => void errors.push(error))

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const c = boundaryCounts(agent)
    // turn opened and closed; no step ran; exactly one error logged + emitted.
    expect(c).toMatchObject({ turnStart: 1, turnEnd: 1, stepStart: 0, stepEnd: 0, errors: 1 })
    expect(errors.map(e => e.message)).toEqual(['boom turn-start'])
    expect(c.lastTurnEnd?.type === 'turn/end' && c.lastTurnEnd.data.reason).toEqual({ kind: 'error', message: 'boom turn-start' })
    // model was never called (we threw before the step's request).
    expect(adapter.requests).toHaveLength(0)
  })

  it('a throwing agent/step-start listener closes the open step then the turn (step/end before turn/end)', async () => {
    const adapter = new MockAdapter([textResponse('never reached')])
    const ctx = await balancedHarness(adapter)
    const agent = ctx.agentLoop.create('a-stepstart', { model: 'mock' })

    let threw = false
    ctx.on('agent/step-start', () => { if (!threw) { threw = true; throw new Error('boom step-start') } })
    const errors: Error[] = []
    ctx.on('agent/error', (_a, _t, _s, error) => void errors.push(error))

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const e = [...agent.session.events]
    const c = boundaryCounts(agent)
    expect(c).toMatchObject({ turnStart: 1, turnEnd: 1, stepStart: 1, stepEnd: 1, errors: 1 })
    expect(errors.map(x => x.message)).toEqual(['boom step-start'])
    // step/end must precede turn/end (the invariants oracle would reject
    // turn/end-while-step-open, but assert the order explicitly too).
    const stepEndIdx = e.findIndex(x => x.type === 'step/end')
    const turnEndIdx = e.findIndex(x => x.type === 'turn/end')
    expect(stepEndIdx).toBeGreaterThanOrEqual(0)
    expect(stepEndIdx).toBeLessThan(turnEndIdx)
  })

  it('a throwing agent/error listener during a step-error path still balances the turn, loop survives', async () => {
    // First turn: model stream ends with a finish-error → step error path →
    // failTurn emits agent/error, whose listener throws. The turn must still
    // close balanced. Second turn proves the loop survived.
    const errorStream: StreamChunk[] = [{ type: 'finish', reason: { kind: 'error', message: 'provider 500' } }]
    const adapter = new MockAdapter([errorStream, textResponse('turn 2 ok')])
    const ctx = await balancedHarness(adapter)
    const agent = ctx.agentLoop.create('a-errorlistener', { model: 'mock' })

    let threw = false
    ctx.on('agent/error', () => { if (!threw) { threw = true; throw new Error('boom error-listener') } })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const c = boundaryCounts(agent)
    // turn 1 balanced despite the throwing agent/error listener.
    expect(c.turnStart).toBe(1)
    expect(c.turnEnd).toBe(1)
    expect(c.stepStart).toBe(c.stepEnd)
    expect(c.lastTurnEnd?.type === 'turn/end' && c.lastTurnEnd.data.reason).toMatchObject({ kind: 'error', message: 'provider 500' })

    // loop survives: a second turn runs to completion (invariants oracle would
    // throw on its turn/start if turn 1 had been left open).
    send(agent, 'again')
    await waitForIdle(ctx, agent)
    const c2 = boundaryCounts(agent)
    expect(c2.turnStart).toBe(2)
    expect(c2.turnEnd).toBe(2)
    expect(c2.stepStart).toBe(c2.stepEnd)
  })

  it('disposal during a running turn ends the turn with reason disposed (balanced)', async () => {
    // The 'hang' adapter blocks in stream() until the signal aborts; disposing
    // the agent's fiber mid-turn aborts the in-flight step. The turn must close
    // balanced with reason disposed (no error event for a disposal).
    const adapter = new MockAdapter(['hang'])
    const ctx = await balancedHarness(adapter)
    let agent!: ReactLoopAgent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create('a-dispose', { model: 'mock' })
    }, { inject: ['agentLoop'] }))

    const reasons: TurnEndReason[] = []
    ctx.on('agent/turn-end', (_a, _t, reason) => void reasons.push(reason))

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    await fiber.dispose() // dispose during the hanging step
    await agent.done

    const e = [...agent.session.events]
    const turnStarts = e.filter(x => x.type === 'turn/start').length
    const turnEnds = e.filter(x => x.type === 'turn/end').length
    expect(turnStarts).toBe(1)
    expect(turnEnds).toBe(1) // balanced — the turn was closed despite disposal
    expect(reasons).toEqual([{ kind: 'disposed' }])
    // no error event: disposal is not a failure.
    expect(e.some(x => x.type === 'error')).toBe(false)
  })

  it('preserves reason disposed when the turn-end emit throws during disposal (outer-catch disposed branch)', async () => {
    // Dispose mid-step → the step-error branch sets reason=disposed (no error
    // reported). closeTurn(true) then emits agent/turn-end, whose listener
    // throws → control reaches the outer catch with isDisposed() && !errorReported,
    // which must PRESERVE disposed rather than overwrite it with the listener's
    // throw. This is the only path that exercises that catch sub-branch.
    const adapter = new MockAdapter(['hang'])
    const ctx = await balancedHarness(adapter)
    let agent!: ReactLoopAgent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create('a-dispose-emit-throw', { model: 'mock' })
    }, { inject: ['agentLoop'] }))

    // The FIRST agent/turn-end emit throws (the disposal-driven turn end).
    let threw = false
    ctx.on('agent/turn-end', () => { if (!threw) { threw = true; throw new Error('boom turn-end during disposal') } })
    // Collect agent/error emissions to prove none is surfaced through that
    // channel either (the listener throw must be fully contained).
    const errorEmits: Error[] = []
    ctx.on('agent/error', (_a, _t, _s, error) => void errorEmits.push(error))

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    await fiber.dispose() // dispose during the hanging step
    await agent.done

    // The throwing turn-end listener actually fired — proving the outer-catch
    // path was exercised, not skipped.
    expect(threw).toBe(true)

    const e = [...agent.session.events]
    // Exactly one turn/start and one turn/end (balanced); the turn/end carries
    // the disposed reason, NOT an error reason from the throwing listener.
    expect(e.filter(x => x.type === 'turn/start')).toHaveLength(1)
    const turnEnd = e.findLast(x => x.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason).toEqual({ kind: 'disposed' })
    // The throwing turn-end listener is contained: no error event is logged and
    // no agent/error is emitted (disposal is not a failure; the throw is swallowed).
    expect(e.some(x => x.type === 'error')).toBe(false)
    expect(errorEmits).toHaveLength(0)
  })

  it('a throwing session/event listener on the turn/start append still balances the turn', async () => {
    // Session.append pushes the event BEFORE notifying session/event listeners,
    // so a listener throwing on turn/start leaves turn/start IN THE LOG. The
    // loop must therefore still owe (and append) a turn/end — deciding "owed"
    // from the log via isTurnOpen, not a "turn started" flag that the throw
    // skipped. Otherwise the turn stays permanently open and poisons the next
    // turn/replay (the turn-enclosure RFC). (Uses the plain harness — NOT the invariants
    // oracle — because the throwing listener is itself a session/event
    // subscriber.)
    const adapter = new MockAdapter([textResponse('turn 2')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a-preturn', { model: 'mock' })

    let threw = false
    ctx.on('session/event', (_session, event) => {
      if (!threw && event.type === 'turn/start') { threw = true; throw new Error('boom turn/start append') }
    })
    const errors: Error[] = []
    ctx.on('agent/error', (_a, _t, _s, error) => void errors.push(error))

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    // The error was surfaced exactly once via agent/error.
    expect(errors.map(e => e.message)).toEqual(['boom turn/start append'])
    // The turn is BALANCED: turn/start is in the log (it was pushed before the
    // listener threw), so a turn/end was owed and appended — no open turn. The
    // last turn-boundary event being turn/end is exactly the loop's isTurnOpen
    // check (no open turn remains).
    const types = [...agent.session.events].map(e => e.type)
    expect(types.filter(t => t === 'turn/start')).toHaveLength(1)
    expect(types.filter(t => t === 'turn/end')).toHaveLength(1)
    const lastBoundary = [...agent.session.events].reverse().find(e => e.type === 'turn/start' || e.type === 'turn/end')
    expect(lastBoundary?.type).toBe('turn/end')
    expect(agent.session.events.at(-1)?.type).toBe('turn/end')

    // loop survives: a second turn runs normally.
    send(agent, 'second')
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1)
  })

  it('a throwing turn-end listener on a SUCCESSFUL turn leaves no event after turn/end (loadable log)', async () => {
    // Regression: a normal turn completes, closeTurn(true) appends turn/end and
    // emits agent/turn-end whose listener throws. The error must NOT be appended
    // as a session event after turn/end — that would sit past the commit
    // boundary and be dropped as a crash tail on resume (the turn-enclosure RFC). It is
    // surfaced via agent/error instead, and the log's last event is turn/end.
    const adapter = new MockAdapter([textResponse('done'), textResponse('next ok')])
    const ctx = await balancedHarness(adapter)
    const agent = ctx.agentLoop.create('a-tend', { model: 'mock' })

    let threw = false
    ctx.on('agent/turn-end', () => { if (!threw) { threw = true; throw new Error('boom turn-end') } })
    const errors: Error[] = []
    ctx.on('agent/error', (_a, _t, _s, error) => void errors.push(error))

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const c = boundaryCounts(agent)
    expect(c.turnEnd).toBe(1)
    expect(c.errors).toBe(0) // NO session error event (it would be post-turn/end)
    expect(agent.session.events.at(-1)?.type).toBe('turn/end') // last event is the boundary
    expect(errors.map(e => e.message)).toEqual(['boom turn-end']) // surfaced via agent/error
    // The whole log is loadable (nothing dropped): a fresh replay sees the turn.
    const replay = new Session(SessionId('replay'), [...agent.session.events])
    expect(replay.deriveMessages().map(m => m.role)).toEqual(['user', 'assistant'])

    // loop survives.
    send(agent, 'again')
    await waitForIdle(ctx, agent)
    expect(boundaryCounts(agent).turnEnd).toBe(2)
  })

  it('a throwing agent/step-end listener during a successful step ends the turn as error, not completed', async () => {
    // closeStep() must surface a throwing step-end listener via failTurn so the
    // turn ends with reason error, not a silent "completed" with the throw
    // swallowed. Regression test for the closeStep() catch that previously
    // swallowed the throw in the normal (no-tool, no-steering) path.
    const adapter = new MockAdapter([textResponse('all good'), textResponse('turn 2 ok')])
    const ctx = await balancedHarness(adapter)
    const agent = ctx.agentLoop.create('a-stepend-throw', { model: 'mock' })

    let threw = false
    ctx.on('agent/step-end', () => { if (!threw) { threw = true; throw new Error('boom step-end') } })
    const errors: Error[] = []
    ctx.on('agent/error', (_a, _t, _s, error) => void errors.push(error))

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const c = boundaryCounts(agent)
    // step opened and closed; exactly one error; turn balanced; turn ends error.
    expect(c).toMatchObject({ turnStart: 1, turnEnd: 1, stepStart: 1, stepEnd: 1, errors: 1 })
    expect(errors.map(e => e.message)).toEqual(['boom step-end'])
    expect(c.lastTurnEnd?.type === 'turn/end' && c.lastTurnEnd.data.reason)
      .toEqual({ kind: 'error', message: 'boom step-end' })

    // step/end precedes turn/end (ordering contract)
    const e = [...agent.session.events]
    const stepEndIdx = e.findIndex(x => x.type === 'step/end')
    const turnEndIdx = e.findIndex(x => x.type === 'turn/end')
    expect(stepEndIdx).toBeGreaterThanOrEqual(0)
    expect(stepEndIdx).toBeLessThan(turnEndIdx)

    // loop survives: a subsequent turn runs to completion
    send(agent, 'again')
    await waitForIdle(ctx, agent)
    const c2 = boundaryCounts(agent)
    expect(c2.turnStart).toBe(2)
    expect(c2.turnEnd).toBe(2)
    expect(c2.stepStart).toBe(c2.stepEnd)
  })

  it('a step error followed by a throwing turn-end listener logs the error exactly once (no double-report)', async () => {
    // The step fails (finish-error) → failTurn records ONE error and sets the
    // error reason. closeTurn(true) then appends turn/end and emits
    // agent/turn-end, whose listener throws → the outer catch calls failTurn
    // again, but its errorReported guard makes it a no-op. Trap #1: exactly one
    // error, the turn stays balanced.
    const errorStream: StreamChunk[] = [{ type: 'finish', reason: { kind: 'error', message: 'provider down' } }]
    const adapter = new MockAdapter([errorStream, textResponse('turn 2 ok')])
    const ctx = await balancedHarness(adapter)
    const agent = ctx.agentLoop.create('a-double', { model: 'mock' })

    let threw = false
    ctx.on('agent/turn-end', () => { if (!threw) { threw = true; throw new Error('boom turn-end') } })
    const errors: Error[] = []
    ctx.on('agent/error', (_a, _t, _s, error) => void errors.push(error))

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const c = boundaryCounts(agent)
    // exactly one error event + one agent/error emit, despite two failTurn calls.
    expect(c.errors).toBe(1)
    expect(errors.map(e => e.message)).toEqual(['provider down'])
    expect(c.turnStart).toBe(1)
    expect(c.turnEnd).toBe(1) // single turn/end, balanced
    expect(c.lastTurnEnd?.type === 'turn/end' && c.lastTurnEnd.data.reason).toMatchObject({ kind: 'error', message: 'provider down' })

    // loop survives the compound failure.
    send(agent, 'again')
    await waitForIdle(ctx, agent)
    expect(boundaryCounts(agent).turnEnd).toBe(2)
  })

  it('a throwing session/event listener on the error event still closes the turn (finalizer containment)', async () => {
    // failTurn appends the `error` event; Session.append pushes it BEFORE
    // notifying session/event listeners, so a throwing listener leaves `error`
    // in the log but must NOT abort finalization — `reason` is set before the
    // append and the throw is contained, so closeTurn(false) still runs and
    // turn/end is appended (the turn is balanced, not left open).
    // Plain harness (no invariants oracle): the throwing listener is itself a
    // session/event subscriber. A finish-error drives the boundary-error path.
    const errorStream: StreamChunk[] = [{ type: 'finish', reason: { kind: 'error', message: 'provider down' } }]
    const adapter = new MockAdapter([errorStream, textResponse('turn 2 ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a-errthrow', { model: 'mock' })

    let threw = false
    ctx.on('session/event', (_s, event) => {
      if (!threw && event.type === 'error') { threw = true; throw new Error('boom error-event listener') }
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const e = [...agent.session.events]
    // The error event is in the log (pushed before the listener threw)…
    expect(e.some(x => x.type === 'error')).toBe(true)
    // …and the turn was still closed with the error reason (finalization did not
    // abort): the last event is turn/end carrying the error reason.
    const last = e.at(-1)
    expect(last?.type).toBe('turn/end')
    expect(last?.type === 'turn/end' && last.data.reason).toMatchObject({ kind: 'error', message: 'provider down' })

    // loop survives: a second turn runs normally.
    send(agent, 'again')
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(2)
  })

  it('a throwing session/event listener on step/end during finalization still appends turn/end', async () => {
    // A throwing agent/step-start listener drives the outer catch, which calls
    // closeStep() during finalization. closeStep appends step/end; a
    // session/event listener throwing on THAT must not abort the catch before
    // closeTurn(false) — step/end is already logged (balance holds) and the
    // throw is contained + surfaced via failTurn, so turn/end is still appended.
    const adapter = new MockAdapter([textResponse('never reached')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a-stependthrow', { model: 'mock' })

    // Open a step, then make the agent/step-start emit throw (boundary throw →
    // outer catch → closeStep during finalization).
    ctx.on('agent/step-start', () => { throw new Error('boom step-start') })
    let threw = false
    ctx.on('session/event', (_s, event) => {
      if (!threw && event.type === 'step/end') { threw = true; throw new Error('boom step/end listener') }
    })
    const errors: Error[] = []
    ctx.on('agent/error', (_a, _t, _s, error) => void errors.push(error))

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const e = [...agent.session.events]
    // Both step/end and turn/end are present — finalization ran to completion.
    expect(e.some(x => x.type === 'step/end')).toBe(true)
    expect(e.some(x => x.type === 'turn/end')).toBe(true)
    expect(e.at(-1)?.type).toBe('turn/end')
    expect(errors.length).toBeGreaterThanOrEqual(1) // surfaced via agent/error

    // loop survives.
    send(agent, 'again')
    await waitForIdle(ctx, agent)
    expect(e.filter(x => x.type === 'turn/start').length).toBeGreaterThanOrEqual(1)
  })

  it('a throwing session/event listener on turn/end is contained (turn still balanced, loop survives)', async () => {
    // closeTurn appends turn/end; Session.append pushes it BEFORE notifying
    // session/event listeners, so a throwing listener leaves turn/end in the log
    // (the turn is balanced) but must not escape — from the normal-path
    // closeTurn(true) it would otherwise propagate; the append is contained so
    // the turn/end emit + loop continue. (A throwing agent/turn-end LISTENER is
    // a separate, already-tested path; here the session/event append notify is
    // what throws.)
    const adapter = new MockAdapter([textResponse('turn 1'), textResponse('turn 2')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create('a-turnendappend', { model: 'mock' })

    let threw = false
    ctx.on('session/event', (_s, event) => {
      if (!threw && event.type === 'turn/end') { threw = true; throw new Error('boom turn/end listener') }
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    // turn 1 is balanced despite the throwing turn/end listener.
    const e1 = [...agent.session.events]
    expect(e1.filter(x => x.type === 'turn/start')).toHaveLength(1)
    expect(e1.filter(x => x.type === 'turn/end')).toHaveLength(1)
    expect(e1.at(-1)?.type).toBe('turn/end')

    // loop survives: a second turn runs to completion.
    send(agent, 'again')
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(2)
    expect([...agent.session.events].filter(x => x.type === 'turn/end')).toHaveLength(2)
  })
})

describe('P1-7: tool/result is logged under the originating call.id, not result.callId', () => {
  it('a tools/execute listener returning a mismatched callId cannot orphan the call↔result pairing', async () => {
    // Model emits a tool-call with id "c1", then a final text turn.
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { x: 1 }),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineTool({
      name: 'echo',
      description: 'echo',
      parameters: { x: { type: 'number' } },
      async execute() { return [{ type: 'text', text: 'ok' }] },
    }))

    // A waterfall listener short-circuits with a result carrying the WRONG
    // callId (a listener-internal/proxy id). The loop must still record the
    // tool/result under the model's authoritative call.id.
    ctx.on('tools/execute', (exec) => {
      expect(exec.callId).toBe(CallId('c1')) // the loop passed the real id in
      return Promise.resolve({ callId: CallId('wrong-proxy-id'), content: [{ type: 'text', text: 'ok' }], isError: false })
    }, { prepend: true })

    const agent = ctx.agentLoop.create('a-callid', { model: 'mock' })
    send(agent, 'use tool')
    await waitForIdle(ctx, agent)

    // The logged tool/result.callId is the originating call.id, NOT the
    // listener's wrong id.
    const resultEvent = [...agent.session.events].find(e => e.type === 'tool/result')
    expect(resultEvent?.type).toBe('tool/result')
    if (resultEvent?.type === 'tool/result') {
      expect(resultEvent.data.callId).toBe(CallId('c1'))
    }

    // And deriveMessages pairs the tool-result with the assistant tool-call:
    // the derived tool-result block's toolCallId equals the original call.id.
    const messages = agent.session.deriveMessages()
    const toolResultBlock = messages
      .flatMap(m => m.content)
      .find(b => b.type === 'tool-result')
    expect(toolResultBlock?.type).toBe('tool-result')
    if (toolResultBlock?.type === 'tool-result') {
      expect(toolResultBlock.toolCallId).toBe(CallId('c1'))
    }
  })
})
