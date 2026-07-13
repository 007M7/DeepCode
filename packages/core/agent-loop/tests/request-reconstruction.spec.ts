/**
 * Loop-level reconstructability: every request the loop sends is a pure function of the
 * session log — messages are the derivation at the step/start boundary, the header is the fold
 * of request/header* events — and every request is an append-extension of its predecessor
 * unless a logged event (compaction replace, header change) explains the difference. Mock-adapter
 * requests are the observable, and the final offline rebuild states the full contract end to end.
 */

import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LlmService from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, foldRequestHeader } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { AgentId } from '@deepseek-ai/dsh-agent'
import AgentLoop, { ReactLoopAgent } from '@deepseek-ai/dsh-agent-loop'
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

/** Assert `previous` is a strict value-prefix of `current`. */
function expectPrefixExtension(previous: GenerateOptions, current: GenerateOptions) {
  expect(current.messages.length).toBeGreaterThan(previous.messages.length)
  expect(current.messages.slice(0, previous.messages.length)).toEqual([...previous.messages])
  expect(current.system).toEqual(previous.system)
  expect(current.tools).toEqual(previous.tools)
}

function registerEcho(ctx: Context) {
  ctx.tools.register(defineTool({
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
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

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
    const headerEvents = agent.session.events.filter(e => e.type === 'request/header' || e.type === 'request/header-delta')
    expect(headerEvents).toHaveLength(1)
    expect(headerEvents[0]?.type === 'request/header' && headerEvents[0].data.reason).toBe('initial')
  })

  it('a later turn append-extends the previous turn (one conversation, one log)', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    send(agent, 'second')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(2)
    expectPrefixExtension(adapter.requests[0]!, adapter.requests[1]!)
  })

  it('a compaction replace rewrites the resend, and the log explains it', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    send(agent, 'first')
    await waitForIdle(ctx, agent)

    // A pre-step listener compacts turn 1's history before turn 2's step —
    // the sanctioned surface rewrite, landing OUTSIDE the step.
    const preStep = ctx.on('agent/pre-step', () => {
      preStep()
      const session = agent.session
      const nodes = session.surface.nodes
      session.append('context/message', {
        content: [{ type: 'text', text: '[summary of turn 1]' }],
        source: { kind: 'plugin', plugin: 'test-compact' },
      }, {
        surfaceOp: { op: 'replace', start: nodes[0]!.seq, end: nodes[1]!.seq },
        sourceEventSeqs: [nodes[0]!.seq, nodes[1]!.seq],
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

  it('a real system-prompt change is a logged header delta; a stable prompt logs nothing', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two'), textResponse('three')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    send(agent, 'second')
    await waitForIdle(ctx, agent)
    // Identical assembly re-rendered per step is NOT a change.
    expect(agent.session.events.filter(e => e.type === 'request/header-delta')).toHaveLength(0)

    ctx.systemPrompt.section({ name: 'extra', order: 2, text: 'new guidance' })
    send(agent, 'third')
    await waitForIdle(ctx, agent)

    const deltas = agent.session.events.filter(e => e.type === 'request/header-delta')
    expect(deltas).toHaveLength(1)
    expect(adapter.requests[2]!.system).toContain('new guidance')
    // History is preserved across the change — only the header moved.
    expect(adapter.requests[2]!.messages.length).toBeGreaterThan(adapter.requests[1]!.messages.length)
  })

  it('an inject() during the agent/request waterfall joins the NEXT request (the step/start boundary)', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    let injected = false
    ctx.on('agent/request', async (_agent, _turn, _step, _config, next) => {
      if (!injected) {
        injected = true
        agent.inject([{ type: 'text', text: '[late context]' }], { source: { kind: 'plugin', plugin: 'test' } })
      }
      return next()
    })

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    const first = adapter.requests[0]!
    // The inject landed in the log after the boundary: not in THIS request…
    expect(first.messages.some(m => m.content.some(b => b.type === 'text' && b.text.includes('[late context]')))).toBe(false)
    expect(agent.session.events.some(e => e.type === 'context/message')).toBe(true)

    send(agent, 'second')
    await waitForIdle(ctx, agent)
    // …but in the next one, at its logged position.
    const second = adapter.requests[1]!
    expect(second.messages.some(m => m.content.some(b => b.type === 'text' && b.text.includes('[late context]')))).toBe(true)
  })

  it('a mutation attempt on the frozen request content throws into the step (loud, not silent)', async () => {
    const adapter = new MockAdapter([textResponse('one')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    const errors: Error[] = []
    ctx.on('agent/error', (_agent, _turn, _step, error) => void errors.push(error))
    ctx.on('llm/stream', (options, next) => {
      // The historical failure mode this design kills: a listener rewriting
      // request content in place. The freeze turns it into a loud error.
      options.messages.push({ role: 'user', content: [{ type: 'text', text: 'sneaky' }] })
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
    const agent = ctx.agentLoop.create(AgentId('gen1'), { model: 'mock' })
    send(agent, 'first')
    await waitForIdle(ctx, agent)

    // Second generation: a new agent whose session is seeded with the first
    // one's full log (the resume/fork path).
    const adapter2 = new MockAdapter([textResponse('two')])
    const ctx2 = await harness(adapter2)
    const handle = await ctx2.agents.create({
      agentId: AgentId('gen2'),
      sessionId: SessionId('gen2-session'),
      seed: [...agent.session.events],
      agentOptions: { model: 'mock' },
    })
    const agent2 = handle.agent as ReactLoopAgent
    send(agent2, 'second')
    await waitForIdle(ctx2, agent2)

    const snapshots = agent2.session.events.filter(e => e.type === 'request/header')
    expect(snapshots).toHaveLength(2)
    expect(snapshots[1]?.type === 'request/header' && snapshots[1].data.reason).toBe('resume')
    // Identical header across the restart: byte-identical continuation.
    expect(adapter2.requests[0]!.system).toEqual(adapter.requests[0]!.system)
    expectPrefixExtension(adapter.requests[0]!, adapter2.requests[0]!)
  })

  it('a delegating listener cannot mutate the seed through next() — the fold stays log-true', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    ctx.on('agent/request', async (_agent, _turn, _step, _config, next) => {
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

    // No delta was logged (nothing really changed), and the session's own
    // fold is immutable state.
    expect(agent.session.events.filter(e => e.type === 'request/header-delta')).toHaveLength(0)
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
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    ctx.systemPrompt.section({ name: 'extra', order: 2, text: 'now with guidance' })
    ctx.on('agent/request', async (_agent, _turn, _step, config, _next) => ({ ...config, temperature: 0.5, maxTokens: 99, stop: ['<END>'] }))
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

      // Header: the fold of request/header* events up to this step's dispatch
      // (its header event sits between step/start and the first chunk).
      const firstChunk = events.find(e => e.type === 'assistant/chunk' && e.seq > stepStart.seq)!
      const header = foldRequestHeader(events.slice(0, firstChunk.seq))!
      expect(request.model).toBe(header.config.model)
      expect(request.system).toEqual(header.system)
      expect(structuredClone(request.tools ?? [])).toEqual(structuredClone(header.tools ?? []))
      expect(request.temperature).toBe(header.config.temperature)
      expect(request.maxTokens).toBe(header.config.maxTokens)
      expect(request.stop).toEqual(header.config.stop)
    })
  })
})
