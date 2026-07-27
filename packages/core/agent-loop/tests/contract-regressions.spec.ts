import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LlmService, { CallId, MessageSource, ProviderRequestId, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionEvent, SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineContentToolFixture, type PostToolDecision } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent, type InboxPlacement } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { ReactLoopAgent } from '../src/agent.ts'
import InvariantService from '@deepseek-ai/dsh-invariants'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import * as AgentInvariant from '@deepseek-ai/dsh-agent/invariant'
import * as AgentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

async function mountInvariants(ctx: Context): Promise<void> {
  await ctx.plugin(InvariantService)
  await ctx.plugin(SessionInvariant)
  await ctx.plugin(AgentInvariant)
  await ctx.plugin(AgentLoopInvariant)
}

function driverDone(agent: Agent): Promise<void> {
  return (agent as Agent & { done: Promise<void> }).done
}

/** Regression tests for agent-loop boundary, identity, and lifecycle contracts. */

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
  agent.followup({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

describe('assistant replay provenance', () => {
  it('records adapter replay state with the assembled assistant content', async () => {
    const response = textResponse('unchanged')
    const replayState = { private: 'state' }
    response[response.length - 1] = { type: 'finish', reason: { kind: 'stop' }, replayState }
    const adapter = new MockAdapter([response])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('replay-state'), { provider: 'mock', model: 'next-model' })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const recorded = agent.session.events.find(event => event.type === 'assistant/message')
    expect(recorded?.type === 'assistant/message' && recorded.data.provenance).toEqual({
      provider: 'mock', model: 'next-model', replayState,
    })
    expect(agent.session.deriveMessages().at(-1)?.provenance).toEqual({
      provider: 'mock', model: 'next-model', replayState,
    })
  })
})

describe('abort during tool execution ends the turn', () => {
  it('records context accepted before a tool-step abort in the same turn', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'aborter', {})])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a-abort-injection'), { provider: 'mock', model: 'mock' })
    ctx.tools.register(defineContentToolFixture({
      name: 'aborter',
      description: '',
      parameters: {},
      async execute() {
        agent.inject({ content: [{ type: 'text', text: 'accepted before abort' }], source: { kind: 'plugin', plugin: 'test' } })
        agent.cancel({ kind: 'user' })
        return [{ type: 'text', text: 'done' }]
      },
    }))
    ctx.on('tools/post-execute', async (): Promise<PostToolDecision> => ({
      kind: 'accept',
      additionalContexts: [{
        content: [{ type: 'text', text: 'accepted result context after abort' }],
        source: { kind: 'plugin', plugin: 'test' },
      }],
    }))

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const events = [...agent.session.events]
    expect(events
      .filter(event => event.type === 'tool/result'
        || (event.type === 'user/message' && event.data.source.kind === 'plugin')
        || event.type === 'step/end' || event.type === 'turn/end')
      .map(event => event.type))
      .toEqual(['tool/result', 'user/message', 'step/end', 'turn/end'])
    expect(events
      .flatMap(event => event.type === 'user/message' && event.data.source.kind === 'plugin'
        ? [event.data.content]
        : []))
      .toEqual([
        [{ type: 'text', text: 'accepted result context after abort' }],
      ])
  })

  it('records post-tool context when a later call aborts the batch', async () => {
    const adapter = new MockAdapter([[
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('c1'), name: 'first', arguments: '{}' } },
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: CallId('c2'), name: 'aborter', arguments: '{}' } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] satisfies StreamChunk[]])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a-later-abort-context'), { provider: 'mock', model: 'mock' })
    ctx.tools.register(defineContentToolFixture({
      name: 'first',
      description: '',
      parameters: {},
      async execute() {
        return [{ type: 'text', text: 'first done' }]
      },
    }))
    ctx.tools.register(defineContentToolFixture({
      name: 'aborter',
      description: '',
      parameters: {},
      async execute() {
        agent.cancel({ kind: 'user' })
        return [{ type: 'text', text: 'aborted' }]
      },
    }))
    ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
      if (exec.callId !== CallId('c1')) return next()
      return {
        kind: 'accept',
        additionalContexts: [{
          content: [{ type: 'text', text: 'accepted after first result' }],
          source: { kind: 'plugin', plugin: 'test' },
        }],
      }
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const events = [...agent.session.events]
    expect(events
      .filter(event => event.type === 'tool/result'
        || (event.type === 'user/message' && event.data.source.kind === 'plugin')
        || event.type === 'step/end' || event.type === 'turn/end')
      .map(event => event.type))
      .toEqual(['tool/result', 'tool/result', 'step/end', 'turn/end'])
    expect(events.flatMap(event =>
      event.type === 'user/message' && event.data.source.kind === 'plugin'
        ? [event.data.content]
        : [])[0])
      .toBeUndefined()
  })

  it('records result context finalized after disposal cancellation', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'waiter', {})])
    const ctx = await harness(adapter)
    const started = Promise.withResolvers<undefined>()
    let agent!: Agent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create(SessionId('a-dispose-injection'), { provider: 'mock', model: 'mock' })
    }, { inject: ['agentLoop'] }))
    ctx.tools.register(defineContentToolFixture({
      name: 'waiter',
      description: '',
      parameters: {},
      async execute(_args, exec) {
        agent.inject({ content: [{ type: 'text', text: 'accepted before disposal' }], source: { kind: 'plugin', plugin: 'test' } })
        started.resolve(undefined)
        const signal = exec.signal
        if (!signal) throw new Error('tool execution signal is missing')
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
        return [{ type: 'text', text: 'done' }]
      },
    }))
    ctx.on('tools/post-execute', async (): Promise<PostToolDecision> => ({
      kind: 'accept',
      additionalContexts: [{
        content: [{ type: 'text', text: 'accepted result context during disposal' }],
        source: { kind: 'plugin', plugin: 'test' },
      }],
    }))

    send(agent, 'go')
    await started.promise
    await fiber.dispose()

    expect(agent.session.events
      .flatMap(event => event.type === 'user/message' && event.data.source.kind === 'plugin'
        ? [event.data.content]
        : []))
      .toEqual([
        [{ type: 'text', text: 'accepted result context during disposal' }],
      ])
    expect(agent.session.events.find(event => event.type === 'turn/end')?.data.reason)
      .toEqual({ kind: 'disposed' })
  })

  it('limits injection deferral to the current tool batch', async () => {
    const adapter = new MockAdapter([
      [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('c1'), name: 'aborter', arguments: '{}' } },
        { type: 'block-start', index: 1, blockType: 'tool-call' },
        { type: 'block-end', index: 1, block: { type: 'tool-call', id: CallId('c2'), name: 'second', arguments: '{}' } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ] satisfies StreamChunk[],
      textResponse('later turn'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a-historical-tool-pair'), { provider: 'mock', model: 'mock' })
    ctx.tools.register(defineContentToolFixture({
      name: 'aborter',
      description: '',
      parameters: {},
      async execute() {
        agent.cancel({ kind: 'user' })
        return [{ type: 'text', text: 'done' }]
      },
    }))
    ctx.tools.register(defineContentToolFixture({
      name: 'second',
      description: '',
      parameters: {},
      async execute() {
        return [{ type: 'text', text: 'must not run' }]
      },
    }))

    send(agent, 'leave an unmatched historical call')
    await waitForIdle(ctx, agent)
    ctx.on('agent/step', (subject, turn) => {
      if (subject === agent && turn === 2) {
        agent.inject({ content: [{ type: 'text', text: 'new turn context' }], source: { kind: 'plugin', plugin: 'test' } })
      }
    })
    send(agent, 'start a text-only turn')
    await waitForIdle(ctx, agent)

    expect(agent.session.events.flatMap(event =>
      event.type === 'user/message' && event.data.source.kind === 'plugin'
        ? [event.data.content]
        : [])[0])
      .toEqual([{ type: 'text', text: 'new turn context' }])
    expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('new turn context')
  })
})

describe('steering from late extension points is never stranded', () => {
  it('steer() from an agent/turn-stopping listener continues the same turn', async () => {
    const adapter = new MockAdapter([
      textResponse('no tools, would stop here'),
      textResponse('continued because of steering'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    let steeredOnce = false
    ctx.on('agent/turn-stopping', () => {
      if (!steeredOnce) {
        steeredOnce = true
        agent.steer({ content: [{ type: 'text', text: 'one more thing' }], source: { kind: 'user' } })
      }
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    // the default decision was false (no tools), but steering forced step 2
    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('one more thing')
  })

  it('steer() from a step/end session-event listener forces a SAME-TURN next step', async () => {
    // Assert the same-turn shape; content alone cannot distinguish re-enqueue.
    const adapter = new MockAdapter([
      textResponse('no tools, would stop'),
      textResponse('after goal reminder'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    let steeredOnce = false
    ctx.on('session/event', (subject, event) => {
      if (subject !== agent.session || event.type !== 'step/end' || steeredOnce) return
      steeredOnce = true
      agent.steer({ content: [{ type: 'text', text: 'goal reminder from step/end' }], source: { kind: 'user' } })
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const events = [...agent.session.events]
    expect(events.filter(e => e.type === 'turn/start')).toHaveLength(1)
    expect(events.filter(e => e.type === 'step/start')).toHaveLength(2)
    // Same-turn steering precedes the second step.
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
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    const turns: number[] = []
    let steeredOnce = false
    ctx.on('session/event', (subject, event) => {
      if (subject !== agent.session) return
      if (event.type === 'turn/start') turns.push(event.data.turn)
      if (event.type === 'turn/end' && !steeredOnce) {
        steeredOnce = true
        expect(agent.acceptsNextStep).toBe(false)
        agent.steer({ content: [{ type: 'text', text: 'too late for this turn' }], source: { kind: 'user' } })
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

})

describe('plugin exceptions are contained', () => {
  it('a throwing agent/turn-stopping listener ends the turn with an error, loop survives', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    let threwOnce = false
    ctx.on('agent/turn-stopping', async () => {
      if (!threwOnce) {
        threwOnce = true
        throw new Error('broken continuation plugin')
      }
    })

    const errors: Error[] = []
    ctx.on('agent/error', (_agent, _turn, _step, error) => {
      if (error instanceof Error) errors.push(error)
    })

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    expect(errors.map(e => e.message)).toEqual(['broken continuation plugin'])

    // the loop is still alive: a second send works normally
    send(agent, 'second')
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(2)
    expect(agent.status).toBe('idle')
  })

})

describe('disposal leaves the two-state status contract balanced', () => {
  it('disposing the fiber ends the active turn and never starts its queued tail', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)

    let agent!: Agent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create(SessionId('scoped'), { provider: 'mock', model: 'mock' })
    }, { inject: ['agentLoop'] }))

    const statuses: string[] = []
    const reasons: TurnEndReason[] = []
    ctx.on('agent/status', (_agent, status) => void statuses.push(status))
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    send(agent, 'queued tail')
    await fiber.dispose()
    await driverDone(agent)

    expect(statuses).toEqual(['running', 'idle'])
    expect(reasons).toEqual([{ kind: 'disposed' }])
    expect(agent.session.events.filter(event => event.type === 'turn/start')).toHaveLength(1)
    const messages = agent.session.events
      .filter(event => event.type === 'user/message')
      .flatMap(event => event.data.content)
      .flatMap(block => block.type === 'text' ? [block.text] : [])
    expect(messages).toEqual(['go'])
    expect(adapter.requests).toHaveLength(1)
  })

  it('a throwing agent/status listener cannot break disposal or leak the registry entry', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)

    let agent!: Agent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create(SessionId('scoped'), { provider: 'mock', model: 'mock' })
    }, { inject: ['agentLoop'] }))

    ctx.on('agent/status', (_agent, status) => {
      if (status === 'idle') throw new Error('broken status listener')
    })

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    await fiber.dispose()
    await driverDone(agent) // must not hang

    expect(ctx.agents.get(SessionId('scoped'))).toBeUndefined()
  })
})

describe('adapter registration, routing, and accepted-input ownership', () => {
  it('duplicate adapter registration is rejected', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    const adapter = new MockAdapter([])
    ctx.llm.registerAdapter(['m1'], adapter)
    expect(() => ctx.llm.registerAdapter(['m1'], new MockAdapter([])))
      .toThrow('already registered')
    // the original registration survives the failed attempt
    expect(ctx.llm.listProviders()).toEqual([{ id: 'm1', name: 'm1' }])
  })

  it('an agent without a model fails the step with a clear error (not NO_ADAPTER for "default")', async () => {
    const adapter = new MockAdapter([textResponse('never')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), {}) // no model

    const errors: Error[] = []
    ctx.on('agent/error', (_agent, _turn, _step, error) => {
      if (error instanceof Error) errors.push(error)
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toContain('has no provider/model')
    expect(errors[0]!.message).toContain('agent/request')
  })

  it('the agent/request waterfall can supply the model for a model-less agent', async () => {
    const adapter = new MockAdapter([textResponse('routed')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), {}) // no model — router plugin decides

    ctx.on('agent/request', async (_agent, _turn, _step, _signal, next) => {
      return { ...await next(), provider: 'mock', model: 'mock' }
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.deriveMessages().at(-1)?.content).toEqual([{ type: 'text', text: 'routed' }])
  })

  it('agent/inbox/enqueue carries the exact message; steering/message records its source', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'noop', {}), textResponse('done')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    ctx.tools.register(defineContentToolFixture({
      name: 'noop',
      description: '',
      parameters: {},
      async execute() {
        agent.steer({ content: [{ type: 'text', text: 's' }], source: { kind: 'plugin', plugin: 'goal' } })
        return []
      },
    }))

    const queuedSources: MessageSource[] = []
    const queuedShapes: string[][] = []
    const placements: InboxPlacement[] = []
    ctx.on('agent/inbox/enqueue', (_agent, message, placement) => {
      queuedSources.push(message.source)
      queuedShapes.push(Object.keys(message).sort())
      placements.push(placement)
    })

    send(agent, 'go') // no explicit source → default {kind:'user'} must be visible
    await waitForIdle(ctx, agent)

    expect(queuedSources).toEqual([
      { kind: 'user' },
      { kind: 'plugin', plugin: 'goal' },
    ])
    expect(queuedShapes).toEqual([
      ['content', 'id', 'source'],
      ['content', 'id', 'source'],
    ])
    expect(placements).toEqual(['queued', 'steering'])
    // The drain appends the durable steering/message with the caller's source
    // intact — the log, not a transient emit, is where consumers read it.
    const steeringSources = agent.session.events.flatMap(e => e.type === 'steering/message' ? [e.data.source] : [])
    expect(steeringSources).toEqual([{ kind: 'plugin', plugin: 'goal' }])
  })

})

describe('turn numbering continues across seeded sessions', () => {
  it('a forked agent continues turn numbers after the seed log', async () => {
    const first = new MockAdapter([textResponse('turn one')])
    const ctx = await harness(first)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
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
    const forked = new ReactLoopAgent(
      ctx2, SessionId('forked-agent'), { provider: 'mock', model: 'mock' }, seeded,
    )

    const turns: number[] = []
    ctx2.on('session/event', (_s, event) => { if (event.type === 'turn/start') turns.push(event.data.turn) })
    forked.followup({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } })
    await new Promise<void>((resolve) => {
      ctx2.on('agent/status', (subject, status) => {
        if (subject === forked && status === 'idle') resolve()
      })
    })

    expect(turns).toEqual([2])
  })
})

describe('discriminated SessionEvent narrows without casts', () => {
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

describe('a finish-error stream chunk ends the turn as error, not completed', () => {
  it('translates finish {kind:error} into a turn error with a logged error event', async () => {
    // A finish-error chunk must not produce a completed assistant turn.
    const failure = {
      message: 'provider 401',
      code: 'AUTH',
      status: 401,
      providerRetryAfterMs: 2_000,
      requestId: ProviderRequestId('finish-request-1'),
    }
    const errorStream: StreamChunk[] = [
      { type: 'finish', reason: { kind: 'error', failure } },
    ]
    const adapter = new MockAdapter([errorStream])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a-finish-error'), { provider: 'mock', model: 'mock' })

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(reasons).toEqual([{ kind: 'error', step: 1, failure }])

    const events = [...agent.session.events]
    // The durable failure lives on turn/end.reason (with the failing step), not
    // a standalone error event.
    const turnEnd = events.find(event => event.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason).toEqual({ kind: 'error', step: 1, failure })
    // A failed step must not synthesize an assistant message.
    expect(events.some(event => event.type === 'assistant/message')).toBe(false)
  })

  it('translates finish {kind:aborted} into a turn error coded ABORTED', async () => {
    const abortedStream: StreamChunk[] = [
      { type: 'finish', reason: { kind: 'aborted', failure: { message: 'model stream aborted', code: 'ABORTED' } } },
    ]
    const adapter = new MockAdapter([abortedStream])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a-finish-aborted'), { provider: 'mock', model: 'mock' })

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(reasons).toEqual([{ kind: 'error', step: 1, failure: { message: 'model stream aborted', code: 'ABORTED' } }])
    expect([...agent.session.events].some(event => event.type === 'assistant/message')).toBe(false)
  })

  it('handles a finish error without a code (code key omitted)', async () => {
    const errorStream: StreamChunk[] = [
      { type: 'finish', reason: { kind: 'error', failure: { message: 'codeless failure', code: 'UNKNOWN' } } },
    ]
    const adapter = new MockAdapter([errorStream])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a-finish-error-nocode'), { provider: 'mock', model: 'mock' })

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(reasons).toEqual([{ kind: 'error', step: 1, failure: { message: 'codeless failure', code: 'UNKNOWN' } }])
  })
})

describe('step boundary publication order', () => {
  it('the step/start event is in session.events when its session/event listener fires', async () => {
    const adapter = new MockAdapter([textResponse('done')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a-step-order'), { provider: 'mock', model: 'mock' })

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

describe('turn and step boundary recovery', () => {
  // The session invariant companion makes an unbalanced log fail the test.
  async function balancedHarness(adapter: MockAdapter) {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountInvariants(ctx)
    ctx.llm.registerAdapter(['mock'], adapter)
    return ctx
  }

  /** Count turn/step boundary events for balance assertions. */
  function boundaryCounts(agent: Agent) {
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

  it('a throwing step/start observer cannot change a successful turn', async () => {
    const adapter = new MockAdapter([textResponse('request completed')])
    const ctx = await balancedHarness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a-stepstart'), { provider: 'mock', model: 'mock' })

    // Session owns post-commit containment. The loop sees a successful append,
    // runs the request, and balances the ordinary step and turn boundaries.
    let threw = false
    ctx.on('session/event', (_s, event) => {
      if (event.type === 'step/start' && !threw) { threw = true; throw new Error('boom step-start') }
    })
    const errors: Error[] = []
    ctx.on('agent/error', (_a, _t, _s, error) => {
      if (error instanceof Error) errors.push(error)
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const e = [...agent.session.events]
    const c = boundaryCounts(agent)
    expect(c).toMatchObject({ turnStart: 1, turnEnd: 1, stepStart: 1, stepEnd: 1, errors: 0 })
    expect(errors).toEqual([])
    // step/end precedes turn/end (the invariants oracle would reject
    // turn/end-while-step-open, but assert the order explicitly too).
    const stepEndIdx = e.findIndex(x => x.type === 'step/end')
    const turnEndIdx = e.findIndex(x => x.type === 'turn/end')
    expect(stepEndIdx).toBeGreaterThanOrEqual(0)
    expect(stepEndIdx).toBeLessThan(turnEndIdx)
  })

  it('a pre-commit turn/start rejection leaves no turn state for the next prompt', async () => {
    const adapter = new MockAdapter([textResponse('after recovery')])
    const ctx = await balancedHarness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a-turnstart-veto'), { provider: 'mock', model: 'mock' })
    let rejected = false
    ctx.on('internal/dispatch', (_mode, name, args) => {
      if (name !== 'session/event') return
      const event = args[1] as SessionEvent
      if (event.type === 'turn/start' && !rejected) {
        rejected = true
        throw new Error('reject turn-start before commit')
      }
    })
    const errors: Error[] = []
    ctx.on('agent/error', (_agent, _turn, _step, error) => {
      if (error instanceof Error) errors.push(error)
    })

    send(agent, 'rejected')
    await waitForIdle(ctx, agent)

    // The rejected turn left nothing behind: no events, no admitted prompt.
    expect(agent.session.events).toEqual([])
    expect(errors.map(error => error.message)).toEqual(['reject turn-start before commit'])

    // The next prompt reuses the never-committed turn number and carries only
    // its own admitted content — invariants (mounted) accept the log.
    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(boundaryCounts(agent)).toMatchObject({ turnStart: 1, turnEnd: 1, stepStart: 1, stepEnd: 1 })
    const turnStart = agent.session.events.find(event => event.type === 'turn/start')
    expect(turnStart?.type === 'turn/start' && turnStart.data.turn).toBe(1)
    const prompts = agent.session.events.filter(event => event.type === 'user/message')
    expect(prompts.map(event => event.type === 'user/message' && event.data.content)).toEqual([
      [{ type: 'text', text: 'go' }],
    ])
    expect(adapter.requests).toHaveLength(1)
  })

  it('a pre-commit step/start validation failure does not invent a step boundary', async () => {
    const adapter = new MockAdapter([textResponse('never reached')])
    const ctx = await balancedHarness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a-stepstart-veto'), { provider: 'mock', model: 'mock' })
    let rejected = false
    ctx.on('internal/dispatch', (_mode, name, args) => {
      if (name !== 'session/event') return
      const event = args[1] as SessionEvent
      if (event.type === 'step/start' && !rejected) {
        rejected = true
        throw new Error('reject step-start before commit')
      }
    })
    const errors: Error[] = []
    ctx.on('agent/error', (_agent, _turn, _step, error) => {
      if (error instanceof Error) errors.push(error)
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toEqual([])
    expect(boundaryCounts(agent)).toMatchObject({
      turnStart: 1,
      turnEnd: 1,
      stepStart: 0,
      stepEnd: 0,
      errors: 1,
    })
    expect(errors.map(error => error.message)).toEqual(['reject step-start before commit'])
  })

  it('a one-shot step/end validation failure keeps the step open until retry succeeds', async () => {
    const adapter = new MockAdapter([textResponse('completed before close validation')])
    const ctx = await balancedHarness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a-stepend-veto'), { provider: 'mock', model: 'mock' })
    let rejected = false
    ctx.on('internal/dispatch', (_mode, name, args) => {
      if (name !== 'session/event') return
      const event = args[1] as SessionEvent
      if (event.type === 'step/end' && !rejected) {
        rejected = true
        throw new Error('reject first step-end')
      }
    })
    const errors: Error[] = []
    ctx.on('agent/error', (_agent, _turn, _step, error) => {
      if (error instanceof Error) errors.push(error)
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(1)
    expect(errors.map(error => error.message)).toEqual(['reject first step-end'])
    expect(boundaryCounts(agent)).toMatchObject({
      turnStart: 1,
      turnEnd: 1,
      stepStart: 1,
      stepEnd: 1,
      errors: 1,
    })
  })

  it('a throwing agent/error listener during a step-error path still balances the turn, loop survives', async () => {
    // Listener failure cannot interrupt error finalization or the next turn.
    const errorStream: StreamChunk[] = [{ type: 'finish', reason: { kind: 'error', failure: { message: 'provider 500', code: 'SERVER' } } }]
    const adapter = new MockAdapter([errorStream, textResponse('turn 2 ok')])
    const ctx = await balancedHarness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a-errorlistener'), { provider: 'mock', model: 'mock' })

    let threw = false
    ctx.on('agent/error', () => { if (!threw) { threw = true; throw new Error('boom error-listener') } })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const c = boundaryCounts(agent)
    // turn 1 balanced despite the throwing agent/error listener.
    expect(c.turnStart).toBe(1)
    expect(c.turnEnd).toBe(1)
    expect(c.stepStart).toBe(c.stepEnd)
    expect(c.lastTurnEnd?.type === 'turn/end' && c.lastTurnEnd.data.reason).toMatchObject({
      kind: 'error',
      step: 1,
      failure: { message: 'provider 500', code: 'SERVER' },
    })

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
    let agent!: Agent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create(SessionId('a-dispose'), { provider: 'mock', model: 'mock' })
    }, { inject: ['agentLoop'] }))

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    await fiber.dispose() // dispose during the hanging step
    await driverDone(agent)

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
    // Disposal remains authoritative when the listener also throws.
    const adapter = new MockAdapter([textResponse('never reached')])
    const ctx = await balancedHarness(adapter)
    let agent!: Agent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create(SessionId('a-prestep-dispose-throw'), { provider: 'mock', model: 'mock' })
    }, { inject: ['agentLoop'] }))

    let threw = false
    ctx.on('agent/step', () => {
      if (threw) return
      threw = true
      void fiber.dispose()
      throw new Error('boom pre-step during disposal')
    })
    const errorEmits: Error[] = []
    ctx.on('agent/error', (_a, _t, _s, error) => {
      if (error instanceof Error) errorEmits.push(error)
    })

    send(agent, 'go')
    await agent.whenIdle()

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

  it('a throwing turn/start observer cannot starve the loop or later turns', async () => {
    const adapter = new MockAdapter([textResponse('turn 1'), textResponse('turn 2')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a-preturn'), { provider: 'mock', model: 'mock' })

    let threw = false
    ctx.on('session/event', (_session, event) => {
      if (!threw && event.type === 'turn/start') { threw = true; throw new Error('boom turn/start append') }
    })
    const errors: Error[] = []
    ctx.on('agent/error', (_a, _t, _s, error) => {
      if (error instanceof Error) errors.push(error)
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(errors).toEqual([])
    // Session contains the observer failure per listener, so the committed turn
    // remains visible to later observers and executes normally.
    const types = [...agent.session.events].map(e => e.type)
    expect(types.filter(t => t === 'turn/start')).toHaveLength(1)
    expect(types.filter(t => t === 'turn/end')).toHaveLength(1)
    const lastBoundary = [...agent.session.events].reverse().find(e => e.type === 'turn/start' || e.type === 'turn/end')
    expect(lastBoundary?.type).toBe('turn/end')
    expect(agent.session.events.at(-1)?.type).toBe('turn/end')

    // loop survives: a second turn runs normally.
    send(agent, 'second')
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(2)
  })

  it('a throwing step/end observer cannot rewrite the turn outcome', async () => {
    const adapter = new MockAdapter([textResponse('all good'), textResponse('turn 2 ok')])
    const ctx = await balancedHarness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a-stepend-throw'), { provider: 'mock', model: 'mock' })

    let threw = false
    ctx.on('session/event', (_s, event) => {
      if (event.type === 'step/end' && !threw) { threw = true; throw new Error('boom step-end') }
    })
    const errors: Error[] = []
    ctx.on('agent/error', (_a, _t, _s, error) => {
      if (error instanceof Error) errors.push(error)
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const c = boundaryCounts(agent)
    expect(c).toMatchObject({ turnStart: 1, turnEnd: 1, stepStart: 1, stepEnd: 1, errors: 0 })
    expect(errors).toEqual([])
    expect(c.lastTurnEnd?.type === 'turn/end' && c.lastTurnEnd.data.reason)
      .toEqual({ kind: 'completed' })

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

  it('a throwing step/end observer cannot interrupt error finalization', async () => {
    // Observer failure after step/end commit cannot interrupt turn finalization.
    const errorStream: StreamChunk[] = [{ type: 'finish', reason: { kind: 'error', failure: { message: 'provider 500', code: 'SERVER' } } }]
    const adapter = new MockAdapter([errorStream, textResponse('turn 2 ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a-stependthrow'), { provider: 'mock', model: 'mock' })

    let threw = false
    ctx.on('session/event', (_s, event) => {
      if (!threw && event.type === 'step/end') { threw = true; throw new Error('boom step/end listener') }
    })
    const errors: Error[] = []
    ctx.on('agent/error', (_a, _t, _s, error) => {
      if (error instanceof Error) errors.push(error)
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const e = [...agent.session.events]
    // Both step/end and turn/end are present — finalization ran to completion.
    expect(e.some(x => x.type === 'step/end')).toBe(true)
    expect(e.some(x => x.type === 'turn/end')).toBe(true)
    expect(e.at(-1)?.type).toBe('turn/end')
    expect(errors.map(error => error.message)).toEqual(['provider 500'])

    // loop survives.
    send(agent, 'again')
    await waitForIdle(ctx, agent)
    expect(e.filter(x => x.type === 'turn/start').length).toBeGreaterThanOrEqual(1)
  })

  it('a throwing session/event listener on turn/end is contained (turn still balanced, loop survives)', async () => {
    // Session contains the observer failure after committing turn/end, so the
    // boundary stays authoritative and the loop continues normally.
    const adapter = new MockAdapter([textResponse('turn 1'), textResponse('turn 2')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a-turnendappend'), { provider: 'mock', model: 'mock' })

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

describe('tool result call identity', () => {
  it('the loop records tool/result under the model call.id even when a post-execute listener replaces content', async () => {
    // Model emits a tool-call with id "c1", then a final text turn.
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { x: 1 }),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'echo',
      parameters: { x: { type: 'number' } },
      async execute() { return [{ type: 'text', text: 'ok' }] },
    }))

    // A post-execute listener transforms the result (accept-with-replacement).
    // The loop must still record the tool/result under the model's authoritative
    // call.id, which is the immutable identity carried by the execution input.
    ctx.on('tools/post-execute', (exec, _result) => {
      expect(exec.callId).toBe(CallId('c1')) // the loop passed the real id in
      return Promise.resolve({ kind: 'accept', content: [{ type: 'text', text: 'ok' }] })
    }, { prepend: true })

    const agent = ctx.agentLoop.create(SessionId('a-callid'), { provider: 'mock', model: 'mock' })
    send(agent, 'use tool')
    await waitForIdle(ctx, agent)

    // The logged tool/result.callId is the originating call.id.
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

describe('disposal and cancellation during pre-step assembly', () => {
  it('disposal during system-prompt assembly drops the about-to-start step as disposed', { timeout: 30000 }, async () => {
    // Start disposal, then release assembly. Do not await disposal first: it
    // waits for the blocked driver to exit.
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
    await mountInvariants(ctx)
    ctx.llm.registerAdapter(['mock'], adapter)

    // Parent-owned listener survives agent-fiber disposal.
    const unlisten = ctx.on('system-prompt/assemble', async function (_assembly, _context, next) {
      await blocked
      return next()
    })

    let agent!: Agent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create(SessionId('a-dispose-assemble'), { provider: 'mock', model: 'mock' })
    }, { inject: ['agentLoop'] }))

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    // Give the loop time to enter the step and reach assemble().
    await new Promise(r => setTimeout(r, 50))

    // Release assembly before awaiting disposal because disposal joins the blocked driver.
    const disposalDone = fiber.dispose()

    releaseAssemble()
    await disposalDone
    await driverDone(agent)
    unlisten()

    // Turn boundaries are durable rows; there is no `agent/*` mirror to assert.
    const e = [...agent.session.events]
    expect(e.filter(x => x.type === 'turn/start')).toHaveLength(1)
    expect(e.filter(x => x.type === 'turn/end')).toHaveLength(1)
    const turnEnd = e.findLast(x => x.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason).toEqual({ kind: 'disposed' })
    expect(e.some(x => x.type === 'step/start')).toBe(false)
    expect(e.some(x => x.type === 'assistant/chunk')).toBe(false)
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
    await mountInvariants(ctx)
    ctx.llm.registerAdapter(['mock'], adapter)

    const unlisten = ctx.on('system-prompt/assemble', async function (_assembly, _context, next) {
      await blocker
      return next()
    })

    let agent!: Agent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create(SessionId('a-cancel-assemble'), { provider: 'mock', model: 'mock' })
    }, { inject: ['agentLoop'] }))

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 50))
    agent.cancel({ kind: 'user' })

    releaseAssemble()
    await waitForIdle(ctx, agent)
    await fiber.dispose()
    await driverDone(agent)
    unlisten()

    const e = [...agent.session.events]
    expect(e.filter(x => x.type === 'turn/start')).toHaveLength(1)
    expect(e.filter(x => x.type === 'turn/end')).toHaveLength(1)
    const turnEnd = e.findLast(x => x.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason).toEqual({ kind: 'aborted' })
    expect(e.some(x => x.type === 'step/start')).toBe(false)
    expect(e.some(x => x.type === 'assistant/chunk')).toBe(false)
    expect(e.some(x => x.type === 'assistant/message')).toBe(false)
    expect(adapter.requests).toHaveLength(0)
    expect(reasons).toEqual([{ kind: 'aborted' }])
  })

  it('disposal during agent/step listeners ends the turn disposed', { timeout: 15000 }, async () => {
    // Start disposal, then release pre-step; awaiting disposal first would
    // deadlock on the blocked driver.
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
    await mountInvariants(ctx)
    ctx.llm.registerAdapter(['mock'], adapter)

    ctx.on('agent/step', async () => {
      await blocker
    })

    let agent!: Agent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create(SessionId('a-dispose-prestep'), { provider: 'mock', model: 'mock' })
    }, { inject: ['agentLoop'] }))

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 50))

    const disposalDone = fiber.dispose()
    releasePreStep()
    await disposalDone
    await driverDone(agent)

    // After the agent/step listeners finish, the post-listener cancel/dispose check
    // catches disposal. The step was never opened, no LLM call was made.
    const e = [...agent.session.events]
    expect(e.filter(x => x.type === 'turn/start')).toHaveLength(1)
    expect(e.filter(x => x.type === 'turn/end')).toHaveLength(1)
    const turnEnd = e.findLast(x => x.type === 'turn/end')
    // Disposal wins the post-listener check — reason is `disposed`.
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason).toEqual({ kind: 'disposed' })
    expect(e.some(x => x.type === 'step/start')).toBe(false)
    expect(e.some(x => x.type === 'assistant/chunk')).toBe(false)
    // The durable turn/end record is the authoritative turn-boundary signal
    // (turn boundaries have no agent/* mirror).
  })

  it('cancel during agent/step listeners ends the turn aborted', { timeout: 15000 }, async () => {
    // Release agent/step after cancellation to exercise the post-listener check.
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
    await mountInvariants(ctx)
    ctx.llm.registerAdapter(['mock'], adapter)

    ctx.on('agent/step', async () => {
      await blocker
    })

    let agent!: Agent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create(SessionId('a-cancel-prestep'), { provider: 'mock', model: 'mock' })
    }, { inject: ['agentLoop'] }))

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    agent.cancel({ kind: 'user' })

    releasePreStep()
    await waitForIdle(ctx, agent)
    await fiber.dispose()
    await driverDone(agent)

    const e = [...agent.session.events]
    expect(e.filter(x => x.type === 'turn/start')).toHaveLength(1)
    expect(e.filter(x => x.type === 'turn/end')).toHaveLength(1)
    const turnEnd = e.findLast(x => x.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason).toEqual({ kind: 'aborted' })
    expect(e.some(x => x.type === 'step/start')).toBe(false)
    expect(e.some(x => x.type === 'assistant/chunk')).toBe(false)
    expect(reasons).toEqual([{ kind: 'aborted' }])
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
    await mountInvariants(ctx)
    ctx.llm.registerAdapter(['mock'], adapter)

    ctx.on('system-prompt/assemble', async function (_assembly, _context, next) {
      await blocker
      return next()
    })

    let agent!: Agent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create(SessionId('a-dispose-no-leak'), { provider: 'mock', model: 'mock' })
    }, { inject: ['agentLoop'] }))

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 50))

    const disposalDone = fiber.dispose()
    releaseAssemble()
    await disposalDone
    await driverDone(agent)

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
