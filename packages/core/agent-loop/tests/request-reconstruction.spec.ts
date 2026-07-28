/**
 * Loop-level reconstructability: every request the loop sends is a pure function of the
 * session log — messages derive at the step/start boundary and the header is the latest
 * request/header snapshot. Each request extends its predecessor unless a logged compaction
 * replacement or header change explains the difference.
 */

import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LlmService, { createUserMessage, LlmError, ReasoningEffortId  } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelReasoningInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, foldRequestHeader } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'

import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter, persona = 'stable base') {
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
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

/** Assert `previous` is a strict value-prefix of `current`. */
function expectPrefixExtension(previous: GenerateOptions, current: GenerateOptions) {
  expect(current.messages.length).toBeGreaterThan(previous.messages.length)
  expect(current.messages.slice(0, previous.messages.length)).toEqual([...previous.messages])
  expect(current.system).toEqual(previous.system)
  expect(current.tools).toEqual(previous.tools)
}

function registerEcho(ctx: Context) {
  ctx.tools.register(defineContentToolFixture({
    name: 'echo',
    description: 'echo back',
    parameters: { text: { type: 'string' } },
    async execute(args) {
      return [{ type: 'text', text: `echo: ${String(args.text)}` }]
    },
  }))
}

describe('request stability across the loop', () => {
  it('each step request within a turn append-extends the previous, frozen end to end', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { text: 'one' }, 'first'),
      toolCallResponse('c2', 'echo', { text: 'two' }, 'second'),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    registerEcho(ctx)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(3)
    expectPrefixExtension(adapter.requests[0]!, adapter.requests[1]!)
    expectPrefixExtension(adapter.requests[1]!, adapter.requests[2]!)
    for (const request of adapter.requests) {
      expect(Object.isFrozen(request)).toBe(true)
      expect(Object.isFrozen(request.messages)).toBe(true)
    }
    // One anchoring header snapshot; no further header events (nothing changed).
    const headerEvents = agent.session.events.filter(e => e.type === 'request/header')
    expect(headerEvents).toHaveLength(1)
    expect(headerEvents[0]?.type === 'request/header' && headerEvents[0].data.reason).toBe('initial')
  })

  it('a later turn append-extends the previous turn (one conversation, one log)', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    send(agent, 'second')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(2)
    expectPrefixExtension(adapter.requests[0]!, adapter.requests[1]!)
  })

  it('logs adapter defaults, supports per-turn effort changes, and restores the effective value', async () => {
    const reasoning = {
      efforts: [
        { id: ReasoningEffortId('high'), name: 'High' },
        { id: ReasoningEffortId('max'), name: 'Max' },
      ],
      defaultEffort: ReasoningEffortId('high'),
    }
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')], reasoning)
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('effort'), { provider: 'mock', model: 'mock' })
    ctx.on('agent/request', async (_agent, turn, _step, _signal, next) => {
      const config = await next()
      return turn === 2 ? { ...config, reasoningEffort: ReasoningEffortId('max') } : config
    })

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    send(agent, 'second')
    await waitForIdle(ctx, agent)

    expect(adapter.requests.map(request => request.reasoningEffort)).toEqual([
      ReasoningEffortId('high'),
      ReasoningEffortId('max'),
    ])
    const headers = agent.session.events.filter(event => event.type === 'request/header')
    expect(headers.map(event => event.data.header.config.reasoningEffort)).toEqual([
      ReasoningEffortId('high'),
      ReasoningEffortId('max'),
    ])
    expect(headers.map(event => event.data.reason)).toEqual(['initial', 'change'])

    for (const [model, effort] of [
      ['mock', ReasoningEffortId('max')],
      ['replacement', ReasoningEffortId('high')],
    ] as const) {
      const resumedAdapter = new MockAdapter([textResponse('resumed')], reasoning)
      const resumedCtx = await harness(resumedAdapter)
      const resumedHandle = await resumedCtx.agents.create({
        sessionId: SessionId(`effort-${model}`),
        seed: structuredClone(agent.session.events),
        agentOptions: { provider: 'mock', model },
      })
      send(resumedHandle.agent, 'resumed')
      await waitForIdle(resumedCtx, resumedHandle.agent)

      expect(resumedAdapter.requests[0]?.model).toBe(model)
      expect(resumedAdapter.requests[0]?.reasoningEffort).toBe(effort)
      const resumedHeaders = resumedHandle.agent.session.events.filter(event => event.type === 'request/header')
      expect(resumedHeaders.at(-1)?.data.header.config.reasoningEffort).toBe(effort)
      expect(resumedHeaders.at(-1)?.data.reason).toBe('resume')
    }
  })

  it('keeps exact-model resolution, request logging, and dispatch on one adapter registration', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: 'stable base' })
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    const started = Promise.withResolvers<undefined>()
    const reasoning = Promise.withResolvers<LlmModelReasoningInfo>()
    const first = new class extends MockAdapter {
      override async resolveModel(
        provider: string,
        model: string,
        _signal?: AbortSignal,
      ): Promise<LlmResolvedModelInfo> {
        started.resolve(undefined)
        return {
          provider,
          id: model,
          name: model,
          reasoning: await reasoning.promise,
        }
      }
    }([textResponse('first')])
    const second = new MockAdapter([textResponse('second')], {
      efforts: [{ id: ReasoningEffortId('max'), name: 'Max' }],
      defaultEffort: ReasoningEffortId('max'),
    })
    const disposeFirst = ctx.llm.registerAdapter(['mock'], first)
    const agent = ctx.agentLoop.create(SessionId('effort-hmr'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await started.promise
    disposeFirst()
    ctx.llm.registerAdapter(['mock'], second)
    reasoning.resolve({
      efforts: [{ id: ReasoningEffortId('high'), name: 'High' }],
      defaultEffort: ReasoningEffortId('high'),
    })
    await waitForIdle(ctx, agent)

    expect(first.requests.map(request => request.reasoningEffort)).toEqual([
      ReasoningEffortId('high'),
    ])
    expect(second.requests).toHaveLength(0)
    const headers = agent.session.events.filter(event => event.type === 'request/header')
    expect(headers.at(-1)?.data.header.config.reasoningEffort).toBe(ReasoningEffortId('high'))
  })

  it('aborts a blocked reasoning lookup before quiescent disposal completes', async () => {
    const started = Promise.withResolvers<AbortSignal>()
    const adapter = new class extends MockAdapter {
      override resolveModel(
        _provider: string,
        _model: string,
        signal?: AbortSignal,
      ): Promise<never> {
        if (signal === undefined) return Promise.reject(new Error('missing reasoning signal'))
        started.resolve(signal)
        return new Promise((_resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason instanceof Error ? signal.reason : new Error('reasoning aborted'))
            return
          }
          signal.addEventListener('abort', () => {
            reject(signal.reason instanceof Error ? signal.reason : new Error('reasoning aborted'))
          }, { once: true })
        })
      }
    }([])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('reasoning-dispose'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    send(handle.agent, 'go')
    const signal = await started.promise
    await handle.dispose()

    expect(signal.aborted).toBe(true)
    expect(handle.agent.status).toBe('idle')
    expect(adapter.requests).toHaveLength(0)
    expect(handle.agent.session.events.some(event => event.type === 'request/header')).toBe(false)
  })

  it.each(['plain error', 'LLM error'] as const)(
    'does not swallow a %s from exact-model resolution',
    async (kind) => {
      const failure = kind === 'plain error'
        ? new Error('reasoning metadata failed')
        : new LlmError('unsupported effort', 'UNSUPPORTED_REASONING_EFFORT')
      const adapter = new class extends MockAdapter {
        override resolveModel(): Promise<never> {
          return Promise.reject(failure)
        }
      }([])
      const ctx = await harness(adapter)
      const errors: Error[] = []
      ctx.on('agent/error', (_agent, _turn, _step, error) => {
        if (error instanceof Error) errors.push(error)
      })
      const agent = ctx.agentLoop.create(SessionId(`reasoning-${kind}`), {
        provider: 'mock',
        model: 'mock',
      })

      send(agent, 'go')
      await waitForIdle(ctx, agent)

      expect(errors).toContain(failure)
      expect(adapter.requests).toHaveLength(0)
    },
  )

  it('lets a short-circuiting llm/stream listener own an unregistered route', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: 'stable base' })
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    let observed: GenerateOptions | undefined
    ctx.on('llm/stream', (options) => {
      observed = options
      return (async function* () {
        yield* textResponse('owned')
      })()
    })
    const agent = ctx.agentLoop.create(SessionId('listener-owned'), {
      provider: 'listener',
      model: 'virtual',
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(observed).toMatchObject({ provider: 'listener', model: 'virtual' })
    expect(agent.session.requestHeader()?.config).toEqual({
      provider: 'listener',
      model: 'virtual',
    })
    expect(agent.session.deriveMessages().at(-1)?.content).toContainEqual({
      type: 'text',
      text: 'owned',
    })
  })

  it('a compaction replace rewrites the resend, and the log explains it', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'first')
    await waitForIdle(ctx, agent)

    // A pre-step listener compacts turn 1's history before turn 2's step —
    // the sanctioned surface rewrite, landing OUTSIDE the step.
    const preStep = ctx.on('agent/step', () => {
      preStep()
      const session = agent.session
      const nodes = session.surface.nodes
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: '[summary of turn 1]' }],
        source: { kind: 'plugin', plugin: 'test-compact' },
      }), {
        surfaceOp: { op: 'replace', start: nodes[0]!, end: nodes[1]! },
        sourceEventSeqs: [nodes[0]!, nodes[1]!],
      })
    })

    send(agent, 'second')
    await waitForIdle(ctx, agent)

    const second = adapter.requests[1]!
    // The rewritten history: summary replaces turn 1's user+assistant pair.
    expect(second.messages[0]!.content.some(b => b.type === 'text' && b.text.includes('[summary of turn 1]'))).toBe(true)
    // No header event beyond the anchor: the replace is itself in the log.
    expect(agent.session.events.filter(e => e.type === 'request/header')).toHaveLength(1)
  })

  it('a real system-prompt change is a full changed-header snapshot; a stable prompt logs nothing', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two'), textResponse('three')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    send(agent, 'second')
    await waitForIdle(ctx, agent)
    // Identical assembly re-rendered per step is NOT a change.
    expect(agent.session.events.filter(e => e.type === 'request/header')).toHaveLength(1)

    ctx.systemPrompt.section({ name: 'extra', order: 2, text: 'new guidance' })
    send(agent, 'third')
    await waitForIdle(ctx, agent)

    const snapshots = agent.session.events.filter(e => e.type === 'request/header')
    expect(snapshots).toHaveLength(2)
    expect(snapshots[1]?.data.reason).toBe('change')
    expect(adapter.requests[2]!.system).toContain('new guidance')
    // History is preserved across the change — only the header moved.
    expect(adapter.requests[2]!.messages.length).toBeGreaterThan(adapter.requests[1]!.messages.length)
  })

  it('an inject() during the agent/request waterfall joins the NEXT request (the step/start boundary)', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    let injected = false
    ctx.on('agent/request', async (_agent, _turn, _step, _signal, next) => {
      if (!injected) {
        injected = true
        agent.inject(createUserMessage({ content: [{ type: 'text', text: '[late context]' }], source: { kind: 'plugin', plugin: 'test' } }))
      }
      return next()
    })

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    const first = adapter.requests[0]!
    // The inject landed in the log after the boundary: not in THIS request…
    expect(first.messages.some(m => m.content.some(b => b.type === 'text' && b.text.includes('[late context]')))).toBe(false)
    expect(agent.session.events.some(e => e.type === 'user/message' && e.data.source.kind === 'plugin')).toBe(true)

    send(agent, 'second')
    await waitForIdle(ctx, agent)
    // …but in the next one, at its logged position.
    const second = adapter.requests[1]!
    expect(second.messages.some(m => m.content.some(b => b.type === 'text' && b.text.includes('[late context]')))).toBe(true)
  })

  it('a mutation attempt on the frozen request content throws into the step (loud, not silent)', async () => {
    const adapter = new MockAdapter([textResponse('one')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    const errors: Error[] = []
    ctx.on('agent/error', (_agent, _turn, _step, error) => {
      if (error instanceof Error) errors.push(error)
    })
    ctx.on('llm/stream', (options, next) => {
      // The historical failure mode this design kills: a listener rewriting
      // request content in place. The freeze turns it into a loud error.
      options.messages.push(createUserMessage({
        content: [{ type: 'text', text: 'sneaky' }],
        source: { kind: 'plugin', plugin: 'test' },
      }))
      return next()
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toMatch(/not extensible|frozen|read only|readonly/i)
  })

  it('a fresh loop instance over a seeded log anchors with a resume snapshot and stays cache-aligned', async () => {
    const adapter = new MockAdapter([textResponse('one')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('gen1'), { provider: 'mock', model: 'mock' })
    send(agent, 'first')
    await waitForIdle(ctx, agent)

    // Second generation: a new agent whose session is seeded with the first
    // one's full log (the resume/fork path).
    const adapter2 = new MockAdapter([textResponse('two')])
    const ctx2 = await harness(adapter2)
    const handle = await ctx2.agents.create({
      sessionId: SessionId('gen2-session'),
      seed: [...agent.session.events],
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const agent2 = handle.agent
    send(agent2, 'second')
    await waitForIdle(ctx2, agent2)

    const snapshots = agent2.session.events.filter(e => e.type === 'request/header')
    expect(snapshots).toHaveLength(2)
    expect(snapshots[1]?.data.reason).toBe('resume')
    // Identical header across the restart: byte-identical continuation.
    expect(adapter2.requests[0]!.system).toEqual(adapter.requests[0]!.system)
    expectPrefixExtension(adapter.requests[0]!, adapter2.requests[0]!)
  })

  it('a delegating listener cannot mutate the seed through next() — the fold stays log-true', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    ctx.on('agent/request', async (_agent, _turn, _step, _signal, next) => {
      const config = await next()
      // next() resolves the SAME frozen seed — in-place shaping after
      // delegation is unrepresentable, so a "mutate what next() returned"
      // listener cannot desync the log from the request (nor reach the
      // session's cached header fold, which is deep-cloned away and itself
      // frozen).
      expect(Object.isFrozen(config)).toBe(true)
      expect(() => { (config as { temperature?: number }).temperature = 0.9 }).toThrow(TypeError)
      return config
    })

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    send(agent, 'second')
    await waitForIdle(ctx, agent)

    // No changed snapshot was logged (nothing really changed), and the session's own
    // fold is immutable state.
    expect(agent.session.events.filter(e => e.type === 'request/header')).toHaveLength(1)
    expect(Object.isFrozen(agent.session.requestHeader())).toBe(true)
    expect(adapter.requests[1]!.temperature).toBeUndefined()
  })

  it('THEOREM: every request rebuilds byte-equal from the session log alone', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { text: 'one' }, 'calling'),
      textResponse('done'),
      textResponse('after change'),
    ])
    const ctx = await harness(adapter)
    registerEcho(ctx)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    ctx.systemPrompt.section({ name: 'extra', order: 2, text: 'now with guidance' })
    ctx.on('agent/request', async (_agent, _turn, _step, _signal, next) => ({
      ...await next(), temperature: 0.5, maxTokens: 99, stop: ['<END>'],
    }))
    send(agent, 'again')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(3)
    const events = agent.session.events
    const stepStarts = events.filter(e => e.type === 'step/start')
    expect(stepStarts).toHaveLength(3)

    adapter.requests.forEach((request, index) => {
      const stepStart = stepStarts[index]!
      // Messages: the derivation over the log prefix strictly before this
      // step's step/start — rebuilt here through a completely fresh Session.
      const rebuilt = new Session(SessionId(`rebuild-${index}`), structuredClone(events.slice(0, stepStart.seq)))
      expect(structuredClone(request.messages)).toEqual(rebuilt.deriveMessages())

      // Header: the latest request/header snapshot up to this step's dispatch
      // (its header event sits between step/start and the first chunk).
      const firstChunk = events.find(e => e.type === 'assistant/chunk' && e.seq > stepStart.seq)!
      const header = foldRequestHeader(events.slice(0, firstChunk.seq))!
      expect(request.model).toBe(header.config.model)
      expect(request.reasoningEffort).toBe(header.config.reasoningEffort)
      expect(request.system).toEqual(header.system)
      expect(structuredClone(request.tools ?? [])).toEqual(structuredClone(header.tools ?? []))
      expect(request.temperature).toBe(header.config.temperature)
      expect(request.maxTokens).toBe(header.config.maxTokens)
      expect(request.stop).toEqual(header.config.stop)
    })
  })
})
