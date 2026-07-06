import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LlmService, { CallId, MessageSource, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionEvent, SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { AgentId, type ContinuationDecision } from '@deepseek-ai/dsh-agent'
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
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

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
  it('aborting the in-flight step inside a tool prevents both remaining tools and the next model step', async () => {
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
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    ctx.tools.register(defineTool({
      name: 'aborter',
      description: '',
      parameters: {},
      async execute() {
        executed.push('aborter')
        // Fire the in-flight step's AbortController directly (the loop registers
        // it on the agent). This is the bare step-abort path — distinct from
        // cancel(), which would also clear the inbox; here the subject is the
        // loop's response to its running step being aborted mid-tool.
        ;(agent as unknown as { currentAbort?: AbortController }).currentAbort?.abort('user interrupt')
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
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(executed).toEqual(['aborter'])           // second tool never ran
    expect(adapter.requests).toHaveLength(1)        // no follow-up model call
    expect(reasons).toEqual([{ kind: 'aborted', reason: 'user interrupt' }])
  })
})

describe('HIGH: steering from late extension points is never stranded', () => {
  it('steer() from an agent/turn-continuation listener overrides a stop decision', async () => {
    const adapter = new MockAdapter([
      textResponse('no tools, would stop here'),
      textResponse('continued because of steering'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

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

  it('steer() from a step/end session-event listener forces a SAME-TURN next step (/goal pattern)', async () => {
    // The /goal pattern steers from a step boundary so the model addresses a
    // standing goal before stopping. Step boundaries have no agent/* mirror, so
    // the surviving hook point is the durable step/end session event. With a
    // no-tools first step the default continuation is stop; the steering queued
    // here must force the `!shouldContinue && hasSteering` override so the SAME
    // turn runs another step.
    //
    // The override is what this test guards, so it asserts the same-turn shape —
    // NOT merely that the content reaches requests[1]. Without the override the
    // turn would stop, and leftover steering is re-enqueued as a next-turn queued
    // message, which ALSO lands in requests[1] (just one turn later). So a
    // content-only assertion passes with the override disabled and guards
    // nothing. The discriminator is the turn/step shape: override ⇒ ONE turn with
    // TWO steps and the steering recorded as a `steering/message` BEFORE step 2;
    // re-enqueue fallback ⇒ TWO turns.
    const adapter = new MockAdapter([
      textResponse('no tools, would stop'),
      textResponse('after goal reminder'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    let steeredOnce = false
    ctx.on('session/event', (subject, event) => {
      if (subject !== agent.session || event.type !== 'step/end' || steeredOnce) return
      steeredOnce = true
      agent.steer([{ type: 'text', text: 'goal reminder from step/end' }])
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    // Same-turn continuation: the steering forced step 2 within turn 1.
    const events = [...agent.session.events]
    expect(events.filter(e => e.type === 'turn/start')).toHaveLength(1)
    expect(events.filter(e => e.type === 'step/start')).toHaveLength(2)
    // The steered content is recorded as steering (same turn), BEFORE step 2 —
    // not as a fresh turn's user/message. This is the mechanism the override uses.
    const steeringIdx = events.findIndex(e => e.type === 'steering/message')
    const step2Idx = events.map(e => e.type).lastIndexOf('step/start')
    expect(steeringIdx).toBeGreaterThanOrEqual(0)
    expect(steeringIdx).toBeLessThan(step2Idx)
    // and it reached the next model request.
    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('goal reminder from step/end')
  })

  it('steer() from a turn/end session-event listener becomes a queued message for the next turn', async () => {
    const adapter = new MockAdapter([textResponse('turn 1'), textResponse('turn 2')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    const turns: number[] = []
    let steeredOnce = false
    ctx.on('session/event', (subject, event) => {
      if (subject !== agent.session) return
      if (event.type === 'turn/start') turns.push(event.data.turn)
      if (event.type === 'turn/end' && !steeredOnce) {
        steeredOnce = true
        agent.steer([{ type: 'text', text: 'too late for this turn' }])
      }
    })

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
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    agent.steer([{ type: 'text', text: 'redirect' }])
    // Abort ONLY the in-flight step, via its AbortController directly — NOT
    // cancel(), which clears the inbox and would drop the queued steering this
    // test proves survives a step abort. There is no public step-only abort
    // verb (cancel() is the only public stop primitive), so reach the private
    // controller the loop registered.
    ;(agent as unknown as { currentAbort?: AbortController }).currentAbort?.abort('user interrupt')
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
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    let threwOnce = false
    ctx.on('agent/turn-continuation', async (): Promise<ContinuationDecision> => {
      if (!threwOnce) {
        threwOnce = true
        throw new Error('broken continuation plugin')
      }
      return { action: 'stop' }
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
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

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
      agent = inner.agentLoop.create(AgentId('scoped'), { model: 'mock' })
    }, { inject: ['agentLoop'] }))

    const statuses: string[] = []
    const reasons: TurnEndReason[] = []
    ctx.on('agent/status', (_agent, status) => void statuses.push(status))
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

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
      agent = inner.agentLoop.create(AgentId('scoped'), { model: 'mock' })
    }, { inject: ['agentLoop'] }))

    ctx.on('agent/status', (_agent, status) => {
      if (status === 'disposed') throw new Error('broken status listener')
    })

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    await fiber.dispose()
    await agent.done // must not hang

    expect(agent.status).toBe('disposed')
    expect(ctx.agents.get(AgentId('scoped'))).toBeUndefined() // unregistered despite the throw
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
    const agent = ctx.agentLoop.create(AgentId('a1'), {}) // no model

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
    const agent = ctx.agentLoop.create(AgentId('a1'), {}) // no model — router plugin decides

    ctx.on('agent/request', async (_agent, _turn, _step, config, _next) => {
      return { ...config, model: 'mock' }
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.deriveMessages().at(-1)?.content).toEqual([{ type: 'text', text: 'routed' }])
  })

  it('agent/queued carries the resolved source; steering/message records its source', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'noop', {}), textResponse('done')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
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
    ctx.on('agent/queued', (_agent, _content, info) => void queuedSources.push(info))

    send(agent, 'go') // no explicit source → default {kind:'user'} must be visible
    await waitForIdle(ctx, agent)

    expect(queuedSources[0]).toEqual({ source: { kind: 'user' }, steering: false })
    expect(queuedSources[1]).toEqual({ source: { kind: 'plugin', plugin: 'goal' }, steering: true })
    // The drain appends the durable steering/message with the caller's source
    // intact — the log, not a transient emit, is where consumers read it.
    const steeringSources = agent.session.events.flatMap(e => e.type === 'steering/message' ? [e.data.source] : [])
    expect(steeringSources).toEqual([{ kind: 'plugin', plugin: 'goal' }])
  })
})

describe('MEDIUM: turn numbering continues across seeded (forked) sessions', () => {
  it('a forked agent continues turn numbers after the seed log', async () => {
    const first = new MockAdapter([textResponse('turn one')])
    const ctx = await harness(first)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
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

    const seeded = ctx2.sessions.create(SessionId('forked'), { seed: [...agent.session.events] })
    const forked = new ReactLoopAgent(ctx2, AgentId('forked-agent'), { model: 'mock' }, seeded)
    ctx2.effect(() => forked.start())

    const turns: number[] = []
    ctx2.on('session/event', (_s, event) => { if (event.type === 'turn/start') turns.push(event.data.turn) })
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
    const agent = ctx.agentLoop.create(AgentId('a-finish-error'), { model: 'mock' })

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(reasons).toEqual([{ kind: 'error', step: 1, message: 'provider 401', code: 'AUTH' }])

    const events = [...agent.session.events]
    // The durable failure lives on turn/end.reason (with the failing step), not
    // a standalone error event.
    const turnEnd = events.find(event => event.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason).toEqual({ kind: 'error', step: 1, message: 'provider 401', code: 'AUTH' })
    // Crucially: no assistant/message was logged for the failed step.
    expect(events.some(event => event.type === 'assistant/message')).toBe(false)
  })

  it('translates finish {kind:aborted} into a turn error coded ABORTED', async () => {
    const abortedStream: StreamChunk[] = [
      { type: 'finish', reason: { kind: 'aborted' } },
    ]
    const adapter = new MockAdapter([abortedStream])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a-finish-aborted'), { model: 'mock' })

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(reasons).toEqual([{ kind: 'error', step: 1, message: 'model stream aborted', code: 'ABORTED' }])
    expect([...agent.session.events].some(event => event.type === 'assistant/message')).toBe(false)
  })

  it('handles a finish error without a code (code key omitted)', async () => {
    const errorStream: StreamChunk[] = [
      { type: 'finish', reason: { kind: 'error', message: 'codeless failure' } },
    ]
    const adapter = new MockAdapter([errorStream])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a-finish-error-nocode'), { model: 'mock' })

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(reasons).toEqual([{ kind: 'error', step: 1, message: 'codeless failure' }])
  })
})

describe('P1-6: a step/start session-event listener sees the event already in the log', () => {
  it('the step/start event is in session.events when its session/event listener fires', async () => {
    const adapter = new MockAdapter([textResponse('done')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a-step-order'), { model: 'mock' })

    // Session.append pushes the event BEFORE notifying session/event listeners,
    // so a step/start listener always finds the matching event already in the
    // log. (Step boundaries have no agent/* mirror — the session log is the live
    // feed.)
    const observed: { turn: number; step: number; lastEventType: string | undefined; sawStepStart: boolean }[] = []
    ctx.on('session/event', (subject, event) => {
      if (subject !== agent.session || event.type !== 'step/start') return
      const events = [...subject.events]
      const last = events.at(-1)
      observed.push({
        turn: event.data.turn,
        step: event.data.step,
        lastEventType: last?.type,
        sawStepStart: events.some(e => e.type === 'step/start' && e.data.turn === event.data.turn && e.data.step === event.data.step),
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
      errors: e.filter(x => x.type === 'turn/end' && x.data.reason.kind === 'error').length,
      lastTurnEnd: e.findLast(x => x.type === 'turn/end'),
    }
  }

  it('a throwing step/start session-event listener closes the open step then the turn (step/end before turn/end)', async () => {
    const adapter = new MockAdapter([textResponse('never reached')])
    const ctx = await balancedHarness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a-stepstart'), { model: 'mock' })

    // Step boundaries have no agent/* mirror; a throwing step/start session-event
    // listener is the surviving step-boundary-listener failure. The loop marks
    // the step open BEFORE appending step/start (Session.append pushes before
    // notifying, so a post-push listener throw still leaves stepOpen=true), so
    // the outer catch's closeStep() appends the balancing step/end — the turn
    // stays enclosed. The invariants oracle (balancedHarness) rejects any
    // imbalance, so a green run proves turn/start → step/start → step/end →
    // turn/end nesting holds.
    let threw = false
    ctx.on('session/event', (_s, event) => {
      if (event.type === 'step/start' && !threw) { threw = true; throw new Error('boom step-start') }
    })
    const errors: Error[] = []
    ctx.on('agent/error', (_a, _t, _s, error) => void errors.push(error))

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const e = [...agent.session.events]
    const c = boundaryCounts(agent)
    expect(c).toMatchObject({ turnStart: 1, turnEnd: 1, stepStart: 1, stepEnd: 1, errors: 1 })
    expect(errors.map(x => x.message)).toEqual(['boom step-start'])
    // step/end precedes turn/end (the invariants oracle would reject
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
    const agent = ctx.agentLoop.create(AgentId('a-errorlistener'), { model: 'mock' })

    let threw = false
    ctx.on('agent/error', () => { if (!threw) { threw = true; throw new Error('boom error-listener') } })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const c = boundaryCounts(agent)
    // turn 1 balanced despite the throwing agent/error listener.
    expect(c.turnStart).toBe(1)
    expect(c.turnEnd).toBe(1)
    expect(c.stepStart).toBe(c.stepEnd)
    expect(c.lastTurnEnd?.type === 'turn/end' && c.lastTurnEnd.data.reason).toMatchObject({ kind: 'error', step: 1, message: 'provider 500' })

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
      agent = inner.agentLoop.create(AgentId('a-dispose'), { model: 'mock' })
    }, { inject: ['agentLoop'] }))

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

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
    // no error reason: disposal is not a failure.
    expect(e.some(x => x.type === 'turn/end' && x.data.reason.kind === 'error')).toBe(false)
  })

  it('preserves reason disposed when a pre-step listener disposes then throws (outer-catch disposed branch)', async () => {
    // Reach the OUTER catch while disposed: an `agent/pre-step` listener requests
    // disposal AND throws. The throw escapes the pre-step `await` (line ~419) to
    // the loop's outer catch — BEFORE the post-pre-step disposal check at ~422
    // gets to run — so the catch sees `isDisposed() && !errorReported` and must
    // PRESERVE reason=disposed rather than overwrite it with the listener's throw
    // (disposal is not a failure). This is the surviving path to that sub-branch
    // now that there is no turn-boundary emit to throw from.
    const adapter = new MockAdapter([textResponse('never reached')])
    const ctx = await balancedHarness(adapter)
    let agent!: ReactLoopAgent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create(AgentId('a-prestep-dispose-throw'), { model: 'mock' })
    }, { inject: ['agentLoop'] }))

    let threw = false
    ctx.on('agent/pre-step', () => {
      if (threw) return
      threw = true
      // Request disposal, then throw in the same synchronous tick: status flips
      // to 'disposed' (the disposer aborts the step controller) and the throw
      // drives control into the outer catch with isDisposed() already true.
      void fiber.dispose()
      throw new Error('boom pre-step during disposal')
    })
    const errorEmits: Error[] = []
    ctx.on('agent/error', (_a, _t, _s, error) => void errorEmits.push(error))

    send(agent, 'go')
    await agent.done

    const e = [...agent.session.events]
    // Balanced: one turn/start, one turn/end carrying disposed (NOT error).
    expect(e.filter(x => x.type === 'turn/start')).toHaveLength(1)
    const turnEnd = e.findLast(x => x.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason).toEqual({ kind: 'disposed' })
    expect(e.some(x => x.type === 'turn/end' && x.data.reason.kind === 'error')).toBe(false)
    // No step opened (the throw was before step/start) and disposal is not a
    // failure, so no agent/error for the contained throw.
    expect(e.some(x => x.type === 'step/start')).toBe(false)
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
    const agent = ctx.agentLoop.create(AgentId('a-preturn'), { model: 'mock' })

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

  it('a throwing step/end session-event listener during a successful step ends the turn as error, not completed', async () => {
    // closeStep() must surface a throwing step/end listener via failTurn so the
    // turn ends with reason error, not a silent "completed" with the throw
    // swallowed. Regression test for the closeStep() catch that previously
    // swallowed the throw in the normal (no-tool, no-steering) path. (Step
    // boundaries have no agent/* mirror; the session-event listener is the path.)
    const adapter = new MockAdapter([textResponse('all good'), textResponse('turn 2 ok')])
    const ctx = await balancedHarness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a-stepend-throw'), { model: 'mock' })

    let threw = false
    ctx.on('session/event', (_s, event) => {
      if (event.type === 'step/end' && !threw) { threw = true; throw new Error('boom step-end') }
    })
    const errors: Error[] = []
    ctx.on('agent/error', (_a, _t, _s, error) => void errors.push(error))

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const c = boundaryCounts(agent)
    // step opened and closed; exactly one error turn-end; turn balanced.
    expect(c).toMatchObject({ turnStart: 1, turnEnd: 1, stepStart: 1, stepEnd: 1, errors: 1 })
    expect(errors.map(e => e.message)).toEqual(['boom step-end'])
    expect(c.lastTurnEnd?.type === 'turn/end' && c.lastTurnEnd.data.reason)
      .toEqual({ kind: 'error', step: 1, message: 'boom step-end' })

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

  it('a throwing session/event listener on step/end during finalization still appends turn/end', async () => {
    // A finish-error stream opens a step then fails it, driving finalization
    // through closeStep() with the step open. closeStep appends step/end; a
    // session/event listener throwing on THAT must not abort the catch before
    // closeTurn — step/end is already logged (balance holds) and the throw is
    // contained + surfaced via failTurn, so turn/end is still appended. (The
    // failed step itself also routes through failTurn; the step/end-listener
    // throw is the second, contained, failure.)
    const errorStream: StreamChunk[] = [{ type: 'finish', reason: { kind: 'error', message: 'provider 500' } }]
    const adapter = new MockAdapter([errorStream, textResponse('turn 2 ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a-stependthrow'), { model: 'mock' })

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
    // (the turn is balanced) but must not escape — from the normal-path closeTurn
    // it would otherwise propagate; the append is contained so the loop continues.
    // Turn boundaries are durable session events only (no agent/* mirror), so this
    // session/event append-notify throw is the sole turn-end-listener failure path.
    const adapter = new MockAdapter([textResponse('turn 1'), textResponse('turn 2')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a-turnendappend'), { model: 'mock' })

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
  it('the loop records tool/result under the model call.id even when a post-execute listener replaces content', async () => {
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

    // A post-execute listener transforms the result (accept-with-replacement).
    // The loop must still record the tool/result under the model's authoritative
    // call.id (the loop ignores result.callId — which the registry always sets to
    // exec.callId anyway — and uses call.id, the model-transcript id).
    ctx.on('tools/post-execute', (exec, _result) => {
      expect(exec.callId).toBe(CallId('c1')) // the loop passed the real id in
      return Promise.resolve({ kind: 'accept', content: [{ type: 'text', text: 'ok' }] })
    }, { prepend: true })

    const agent = ctx.agentLoop.create(AgentId('a-callid'), { model: 'mock' })
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

describe('surface: assistant/message omits sourceEventSeqs when no chunks streamed', () => {
  it('a step-result listener injecting content over an empty stream appends with surfaceOp but no sourceEventSeqs', async () => {
    // An empty stream yields zero assistant/chunk events (finish defaults to
    // `stop`), so chunkSeqs is empty. A step-result listener injects content, so
    // the content-or-usage guard fires and an assistant/message is appended. Its
    // sourceEventSeqs MUST be omitted (not `[]`) — the surface invariant rejects
    // an empty sourceEventSeqs, and the dev invariants plugin would throw on it.
    const adapter = new MockAdapter([[]])
    const ctx = await harness(adapter)
    await ctx.plugin(Invariants)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    ctx.on('agent/step-result', async (_agent, _turn, _step, _message, _next) => ({
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'injected' }],
    }))

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const recorded = agent.session.events.find(e => e.type === 'assistant/message')!
    expect(recorded.type).toBe('assistant/message')
    expect(recorded.surfaceOp).toBe('append')
    expect(recorded.sourceEventSeqs).toBeUndefined()
    // The injected content reaches derived history.
    expect(JSON.stringify(agent.session.deriveMessages())).toContain('injected')
  })
})



describe('disposal/cancel honored during pre-step assembly (P1-1)', () => {
  it('disposal during system-prompt assembly drops the about-to-start step as disposed', { timeout: 30000 }, async () => {
    // Block `system-prompt/assemble` on a promise. Start disposal (which
    // calls stop() synchronously, setting status=disposed), then release the
    // block. The loop must check isDisposed() after assembly and end the turn
    // `disposed` — no LLM call. Don't await fiber.dispose() before releasing
    // the blocker: the dispose chain awaits agent.done, which hangs until the
    // loop unblocks.
    const adapter = new MockAdapter(['hang'])
    let releaseAssemble!: () => void
    const blocked = new Promise<void>(r => void (releaseAssemble = r))

    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Invariants, { freeze: false })
    ctx.llm.registerAdapter(['mock'], adapter)

    // Blocking listener on the parent context (survives fiber disposal).
    const unlisten = ctx.on('system-prompt/assemble', async function (_assembly, _context, next) {
      await blocked
      return next()
    })

    let agent!: ReactLoopAgent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create(AgentId('a-dispose-assemble'), { model: 'mock' })
    }, { inject: ['agentLoop'] }))

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    // Give the loop time to enter the step and reach assemble().
    await new Promise(r => setTimeout(r, 50))

    // Start disposal — stop() sets status=disposed synchronously, then the
    // disposer's await agent.done hangs because the loop is blocked in the
    // waterfall. Do NOT await yet; release the blocker first.
    const disposalDone = fiber.dispose()

    // Now release the blocked waterfall — the loop unblocks, checks
    // isDisposed(), and exits, which resolves agent.done and disposalDone.
    releaseAssemble()
    await disposalDone
    await agent.done
    unlisten()

    const e = [...agent.session.events]
    expect(e.filter(x => x.type === 'turn/start')).toHaveLength(1)
    expect(e.filter(x => x.type === 'turn/end')).toHaveLength(1)
    const turnEnd = e.findLast(x => x.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason).toEqual({ kind: 'disposed' })
    // No step was opened, no LLM call was made.
    expect(e.some(x => x.type === 'step/start')).toBe(false)
    expect(e.some(x => x.type === 'assistant/chunk')).toBe(false)
    // The durable turn/end record is the authoritative turn-boundary signal
    // (turn boundaries have no agent/* mirror), so this asserts on the log.
  })

  it('cancel during system-prompt assembly drops the about-to-start step as aborted', { timeout: 30000 }, async () => {
    const adapter = new MockAdapter([textResponse('should not appear')])
    let releaseAssemble!: () => void
    const blocker = new Promise<void>(r => void (releaseAssemble = r))

    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Invariants, { freeze: false })
    ctx.llm.registerAdapter(['mock'], adapter)

    const unlisten = ctx.on('system-prompt/assemble', async function (_assembly, _context, next) {
      await blocker
      return next()
    })

    let agent!: ReactLoopAgent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create(AgentId('a-cancel-assemble'), { model: 'mock' })
    }, { inject: ['agentLoop'] }))

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 50))
    agent.cancel('user cancelled during assembly')

    releaseAssemble()
    await waitForIdle(ctx, agent)
    await fiber.dispose()
    await agent.done
    unlisten()

    const e = [...agent.session.events]
    expect(e.filter(x => x.type === 'turn/start')).toHaveLength(1)
    expect(e.filter(x => x.type === 'turn/end')).toHaveLength(1)
    const turnEnd = e.findLast(x => x.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason).toEqual({
      kind: 'aborted',
      reason: 'user cancelled during assembly',
    })
    expect(e.some(x => x.type === 'step/start')).toBe(false)
    expect(e.some(x => x.type === 'assistant/chunk')).toBe(false)
    expect(e.some(x => x.type === 'assistant/message')).toBe(false)
    expect(adapter.requests).toHaveLength(0)
    expect(reasons).toEqual([{ kind: 'aborted', reason: 'user cancelled during assembly' }])
  })

  it('disposal during agent/pre-step seam ends the turn disposed', { timeout: 15000 }, async () => {
    // Block the `agent/pre-step` serial seam on a promise we control, then
    // dispose the agent's fiber. When the block releases, the loop must see
    // isDisposed() at the post-seam check and end the turn disposed.
    const adapter = new MockAdapter(['hang'])
    let releasePreStep!: () => void
    const blocker = new Promise<void>(r => void (releasePreStep = r))

    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Invariants, { freeze: false })
    ctx.llm.registerAdapter(['mock'], adapter)

    ctx.on('agent/pre-step', async () => {
      await blocker
    })

    let agent!: ReactLoopAgent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create(AgentId('a-dispose-prestep'), { model: 'mock' })
    }, { inject: ['agentLoop'] }))

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 50))

    // Start disposal, then release the block, then await disposal.
    const disposalDone = fiber.dispose()
    releasePreStep()
    await disposalDone
    await agent.done

    // After the pre-step seam finishes, the post-seam cancel/dispose check
    // catches disposal. The step was never opened, no LLM call was made.
    const e = [...agent.session.events]
    expect(e.filter(x => x.type === 'turn/start')).toHaveLength(1)
    expect(e.filter(x => x.type === 'turn/end')).toHaveLength(1)
    const turnEnd = e.findLast(x => x.type === 'turn/end')
    // Disposal wins the post-seam check — reason is `disposed`.
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason).toEqual({ kind: 'disposed' })
    expect(e.some(x => x.type === 'step/start')).toBe(false)
    expect(e.some(x => x.type === 'assistant/chunk')).toBe(false)
    // The durable turn/end record is the authoritative turn-boundary signal
    // (turn boundaries have no agent/* mirror).
  })

  it('cancel during agent/pre-step seam ends the turn aborted', { timeout: 15000 }, async () => {
    // Block `agent/pre-step`, then cancel() the agent. When the block releases,
    // the post-seam check catches cancellation and ends the turn aborted.
    const adapter = new MockAdapter(['hang'])
    let releasePreStep!: () => void
    const blocker = new Promise<void>(r => void (releasePreStep = r))

    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Invariants, { freeze: false })
    ctx.llm.registerAdapter(['mock'], adapter)

    ctx.on('agent/pre-step', async () => {
      await blocker
    })

    let agent!: ReactLoopAgent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create(AgentId('a-cancel-prestep'), { model: 'mock' })
    }, { inject: ['agentLoop'] }))

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    agent.cancel('user cancelled')

    releasePreStep()
    await waitForIdle(ctx, agent)
    await fiber.dispose()
    await agent.done

    const e = [...agent.session.events]
    expect(e.filter(x => x.type === 'turn/start')).toHaveLength(1)
    expect(e.filter(x => x.type === 'turn/end')).toHaveLength(1)
    const turnEnd = e.findLast(x => x.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason).toEqual({ kind: 'aborted', reason: 'user cancelled' })
    expect(e.some(x => x.type === 'step/start')).toBe(false)
    expect(e.some(x => x.type === 'assistant/chunk')).toBe(false)
    expect(reasons).toEqual([{ kind: 'aborted', reason: 'user cancelled' }])
  })

  it('disposal during assembly does not leak an LLM call or append assistant/chunk', { timeout: 15000 }, async () => {
    // The key assertion from the original bug report: after disposal, no
    // assistant/chunk or assistant/message appears — the turn ends disposed
    // before any model interaction.
    const adapter = new MockAdapter([textResponse('should not appear')])
    let releaseAssemble!: () => void
    const blocker = new Promise<void>(r => void (releaseAssemble = r))

    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Invariants, { freeze: false })
    ctx.llm.registerAdapter(['mock'], adapter)

    ctx.on('system-prompt/assemble', async function (_assembly, _context, next) {
      await blocker
      return next()
    })

    let agent!: ReactLoopAgent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create(AgentId('a-dispose-no-leak'), { model: 'mock' })
    }, { inject: ['agentLoop'] }))

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 50))

    const disposalDone = fiber.dispose()
    releaseAssemble()
    await disposalDone
    await agent.done

    const e = [...agent.session.events]
    expect(e.filter(x => x.type === 'turn/start')).toHaveLength(1)
    expect(e.filter(x => x.type === 'turn/end')).toHaveLength(1)
    // The critical assertions: after disposal, the turn has no assistant
    // artifacts — the turn ended disposed before the model was invoked.
    expect(e.some(x => x.type === 'assistant/chunk')).toBe(false)
    expect(e.some(x => x.type === 'assistant/message')).toBe(false)
    expect(adapter.requests).toHaveLength(0)
    // The durable turn/end reason is the authoritative turn-boundary record
    // (turn boundaries have no agent/* mirror).
  })
})
