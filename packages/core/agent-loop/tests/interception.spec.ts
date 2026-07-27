import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import LlmService, { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  SessionId,
  type SessionEvent,
  type TurnEndReason,
  type UserMessageData,
} from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineContentToolFixture, type PostToolDecision, type PreToolDecision } from '@deepseek-ai/dsh-tools'
import AgentRegistry, {
  type Agent,
  type AgentMessage,
  type InboxPlacement,
  type PromptDecision,
  type SessionStartSource,
} from '@deepseek-ai/dsh-agent'

import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

/**
 * The interception seams introduced by the hooks taxonomy: `agent/prompt-submit`,
 * `agent/session-start`, `agent/turn-stopping`, and the
 * `tools/pre-execute` / `tools/post-execute`
 * split with `additionalContexts` buffering. These verify the canonical event
 * surface a hook bridge (or a native plugin) programs against, WITHOUT any
 * external protocol — a native plugin uses the typed decisions directly.
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

function events(agent: Agent): SessionEvent[] {
  return [...agent.session.events]
}

describe('agent/prompt-submit', () => {
  it('allow (default via next) records the user/message unchanged', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    const seen: string[] = []
    ctx.on('agent/prompt-submit', async (_agent, content, _source, _signal, next) => {
      seen.push(content.map(b => (b.type === 'text' ? b.text : '')).join(''))
      return next()
    })

    send(agent, 'hello')
    await waitForIdle(ctx, agent)

    expect(seen).toEqual(['hello'])
    const userMsg = events(agent).find(e => e.type === 'user/message')
    expect(userMsg?.type === 'user/message' && userMsg.data.content).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('snapshots and freezes input before publishing or awaiting admission', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('owned-input'), { provider: 'mock', model: 'mock' })
    const entered = Promise.withResolvers<undefined>()
    const decision = Promise.withResolvers<PromptDecision>()
    const observed: AgentMessage[] = []
    ctx.on('agent/inbox/enqueue', (subject, message) => {
      if (subject !== agent) return
      expect(Object.isFrozen(message)).toBe(true)
      expect(Object.isFrozen(message.content)).toBe(true)
      expect(Object.isFrozen(message.content[0])).toBe(true)
      expect(Object.isFrozen(message.source)).toBe(true)
      expect(() => {
        const block = message.content[0]
        if (block?.type === 'text') block.text = 'listener mutation'
      }).toThrow()
    })
    ctx.on('agent/inbox/enqueue', (subject, message) => {
      if (subject === agent) observed.push(message)
    })
    ctx.on('agent/prompt-submit', async () => {
      entered.resolve(undefined)
      return decision.promise
    })
    const input: UserMessageData = {
      content: [{ type: 'text', text: 'accepted text' }],
      source: { kind: 'plugin', plugin: 'accepted source' },
    }

    const idle = waitForIdle(ctx, agent)
    agent.followup(input)
    await entered.promise
    const block = input.content[0]
    if (block?.type === 'text') block.text = 'caller mutation'
    if (input.source.kind === 'plugin') input.source.plugin = 'caller mutation'
    decision.resolve({ kind: 'allow' })
    await idle

    expect(observed).toHaveLength(1)
    expect(observed[0]).toMatchObject({
      content: [{ type: 'text', text: 'accepted text' }],
      source: { kind: 'plugin', plugin: 'accepted source' },
    })
    const userMsg = events(agent).find(event => event.type === 'user/message')
    expect(userMsg?.type === 'user/message' && userMsg.data).toEqual({
      content: [{ type: 'text', text: 'accepted text' }],
      source: { kind: 'plugin', plugin: 'accepted source' },
    })
  })

  it('allow with content REWRITES the prompt before it is recorded', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    ctx.on('agent/prompt-submit', async (): Promise<PromptDecision> =>
      ({ kind: 'allow', content: [{ type: 'text', text: 'REWRITTEN' }] }))

    send(agent, 'original')
    await waitForIdle(ctx, agent)

    const userMsg = events(agent).find(e => e.type === 'user/message')
    expect(userMsg?.type === 'user/message' && userMsg.data.content).toEqual([{ type: 'text', text: 'REWRITTEN' }])
    // the rewritten prompt is what reached the model
    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('REWRITTEN')
    expect(JSON.stringify(adapter.requests[0]!.messages)).not.toContain('original')
  })

  it('allow with additionalContexts injects separate injected-context user messages into the turn', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    ctx.on('agent/prompt-submit', async (): Promise<PromptDecision> =>
      ({
        kind: 'allow',
        additionalContexts: [{
          content: [{ type: 'text', text: '<system-reminder>extra ctx</system-reminder>' }],
          source: { kind: 'plugin', plugin: 'test' },
        }],
      }))

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const log = events(agent)
    const userMsg = log.find(e => e.type === 'user/message' && e.data.source.kind === 'user')
    const ctxMsg = log.find(e => e.type === 'user/message' && e.data.source.kind === 'plugin')
    expect(userMsg).toBeDefined()
    expect(ctxMsg?.type === 'user/message' && ctxMsg.data.content).toEqual([{ type: 'text', text: '<system-reminder>extra ctx</system-reminder>' }])
    expect(ctxMsg?.type === 'user/message' && ctxMsg.data.source).toEqual({ kind: 'plugin', plugin: 'test' })
    const sent = JSON.stringify(adapter.requests[0]!.messages)
    expect(sent).toContain('extra ctx')
  })

  it('runs pre-step after prompt rewrites and injected context become durable', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    ctx.on('agent/prompt-submit', async (): Promise<PromptDecision> =>
      ({
        kind: 'allow',
        content: [{ type: 'text', text: 'REWRITTEN prompt' }],
        additionalContexts: [{ content: [{ type: 'text', text: 'injected ctx' }], source: { kind: 'plugin', plugin: 'test' } }],
      }))

    let preStepDerived: string | undefined
    ctx.on('agent/step', (subject, _turn, step) => {
      if (subject === agent && step === 1) preStepDerived = JSON.stringify(subject.session.deriveMessages())
    })

    send(agent, 'ORIGINAL prompt')
    await waitForIdle(ctx, agent)

    expect(preStepDerived).toBeDefined()
    expect(preStepDerived).toContain('REWRITTEN prompt')
    expect(preStepDerived).toContain('injected ctx')
    expect(preStepDerived).not.toContain('ORIGINAL prompt')
  })

  it('block drops the claimed prompt before any turn or model call', async () => {
    const adapter = new MockAdapter([textResponse('should not run')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    ctx.on('agent/prompt-submit', async (): Promise<PromptDecision> =>
      ({ kind: 'block', reason: 'blocked by policy' }))

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event: SessionEvent) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    agent.followup({ content: [{ type: 'text', text: 'do something' }], source: { kind: 'user' } })
    await agent.whenIdle()

    // the model was never called
    expect(adapter.requests).toHaveLength(0)
    const log = events(agent)
    expect(log.some(e => e.type === 'turn/start')).toBe(false)
    expect(log.some(e => e.type === 'turn/end')).toBe(false)
    expect(log.some(e => e.type === 'user/message')).toBe(false)
    expect(log.some(e => e.type === 'step/start')).toBe(false)
    expect(reasons).toEqual([])
  })

  it('stages inject and steer during admission for the admitted turn', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('admission-outbox'), { provider: 'mock', model: 'mock' })
    const entered = Promise.withResolvers<undefined>()
    const decision = Promise.withResolvers<PromptDecision>()
    const placements: InboxPlacement[] = []
    ctx.on('agent/prompt-submit', async () => {
      entered.resolve(undefined)
      return decision.promise
    })
    ctx.on('agent/inbox/enqueue', (subject, _message, placement) => {
      if (subject === agent) placements.push(placement)
    })

    const idle = waitForIdle(ctx, agent)
    send(agent, 'admitted prompt')
    await entered.promise
    expect(agent.status).toBe('running')
    expect(agent.acceptsNextStep).toBe(true)
    expect(events(agent).some(event => event.type === 'turn/start')).toBe(false)

    agent.inject({
      content: [{ type: 'text', text: 'attached context' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    agent.steer({ content: [{ type: 'text', text: 'admission steering' }], source: { kind: 'user' } })
    expect(events(agent).some(event => event.type === 'user/message')).toBe(false)
    expect(placements).toEqual(['queued', 'steering'])

    decision.resolve({ kind: 'allow' })
    await idle
    expect(agent.acceptsNextStep).toBe(false)

    const staged = events(agent).filter(event =>
      event.type === 'turn/start' || event.type === 'user/message' || event.type === 'steering/message')
    expect(staged.map(event => event.type)).toEqual([
      'turn/start',
      'user/message',
      'user/message',
      'steering/message',
    ])
    expect(staged[1]?.type === 'user/message' && staged[1].data.content)
      .toEqual([{ type: 'text', text: 'admitted prompt' }])
    expect(staged[2]?.type === 'user/message' && staged[2].data.content)
      .toEqual([{ type: 'text', text: 'attached context' }])
    expect(staged[3]?.type === 'steering/message' && staged[3].data.content)
      .toEqual([{ type: 'text', text: 'admission steering' }])
    const request = JSON.stringify(adapter.requests[0]?.messages)
    expect(request).toContain('admitted prompt')
    expect(request).toContain('attached context')
    expect(request).toContain('admission steering')
  })

  it('keeps admission-time outbox input staged when admission is blocked', async () => {
    const adapter = new MockAdapter([textResponse('retried')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('blocked-admission-outbox'), { provider: 'mock', model: 'mock' })
    const entered = Promise.withResolvers<undefined>()
    const decision = Promise.withResolvers<PromptDecision>()
    const disposeBlock = ctx.on('agent/prompt-submit', async () => {
      entered.resolve(undefined)
      return decision.promise
    })

    const blockedIdle = waitForIdle(ctx, agent)
    send(agent, 'blocked prompt')
    await entered.promise
    expect(agent.acceptsNextStep).toBe(true)
    agent.inject({
      content: [{ type: 'text', text: 'staged context' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    agent.steer({ content: [{ type: 'text', text: 'staged steering' }], source: { kind: 'user' } })
    decision.resolve({ kind: 'block', reason: 'policy' })
    await blockedIdle

    expect(agent.acceptsNextStep).toBe(false)
    expect(events(agent)).toEqual([])
    expect(adapter.requests).toEqual([])

    disposeBlock()
    send(agent, 'resume')
    await waitForIdle(ctx, agent)

    const staged = events(agent).filter(event =>
      event.type === 'user/message' || event.type === 'steering/message')
    expect(staged.map(event => event.type)).toEqual([
      'user/message',
      'steering/message',
      'user/message',
    ])
    expect(JSON.stringify(adapter.requests[0]?.messages)).not.toContain('blocked prompt')
    expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('staged context')
    expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('staged steering')
  })

  it('orders rejected-admission outbox input before a later admitted prompt', async () => {
    const adapter = new MockAdapter([textResponse('continued')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('rejected-admission-order'), {
      provider: 'mock',
      model: 'mock',
    })
    ctx.on('agent/prompt-submit', async (_agent, content, _source, _signal, next) => {
      const decision = await next()
      return content.some(block => block.type === 'text' && block.text === 'blocked prompt')
        ? { kind: 'block', reason: 'policy' }
        : decision
    })
    ctx.on('agent/prompt-submit', async (subject, content, _source, _signal, next) => {
      if (content.some(block => block.type === 'text' && block.text === 'blocked prompt')) {
        subject.inject({
          content: [{ type: 'text', text: 'earlier state change' }],
          source: { kind: 'plugin', plugin: 'test' },
        })
        subject.steer({
          content: [{ type: 'text', text: 'earlier steering' }],
          source: { kind: 'user' },
        })
      }
      return next()
    })

    const idle = waitForIdle(ctx, agent)
    send(agent, 'blocked prompt')
    send(agent, 'later prompt')
    await idle

    const staged = events(agent).filter(event =>
      event.type === 'turn/start' || event.type === 'user/message' || event.type === 'steering/message')
    expect(staged.map(event => event.type)).toEqual([
      'turn/start',
      'user/message',
      'steering/message',
      'user/message',
    ])
    expect(staged[1]?.type === 'user/message' && staged[1].data.content)
      .toEqual([{ type: 'text', text: 'earlier state change' }])
    expect(staged[2]?.type === 'steering/message' && staged[2].data.content)
      .toEqual([{ type: 'text', text: 'earlier steering' }])
    expect(staged[3]?.type === 'user/message' && staged[3].data.content)
      .toEqual([{ type: 'text', text: 'later prompt' }])
  })

  it('commits context-only injection when admission closes without a turn', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('blocked-admission-context'), { provider: 'mock', model: 'mock' })
    const entered = Promise.withResolvers<undefined>()
    const decision = Promise.withResolvers<PromptDecision>()
    ctx.on('agent/prompt-submit', async () => {
      entered.resolve(undefined)
      return decision.promise
    })

    const idle = waitForIdle(ctx, agent)
    send(agent, 'blocked prompt')
    await entered.promise
    agent.inject({
      content: [{ type: 'text', text: 'independent context' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    decision.resolve({ kind: 'block', reason: 'policy' })
    await idle

    const log = events(agent)
    expect(log.map(event => event.type)).toEqual(['user/message'])
    expect(log[0]?.type === 'user/message' && log[0].data.content)
      .toEqual([{ type: 'text', text: 'independent context' }])
    expect(adapter.requests).toEqual([])
  })

  it('retains rejected-admission context when its idle append fails', async () => {
    const adapter = new MockAdapter([textResponse('retried')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('blocked-admission-append-failure'), {
      provider: 'mock',
      model: 'mock',
    })
    const warned = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    vi.spyOn(agent.session, 'append').mockImplementationOnce(() => {
      throw new Error('append unavailable')
    })
    const entered = Promise.withResolvers<undefined>()
    const decision = Promise.withResolvers<PromptDecision>()
    const disposeBlock = ctx.on('agent/prompt-submit', async () => {
      entered.resolve(undefined)
      return decision.promise
    })

    agent.followup({ content: [{ type: 'text', text: 'blocked prompt' }], source: { kind: 'user' } })
    await entered.promise
    agent.inject({
      content: [{ type: 'text', text: 'retained context' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    decision.resolve({ kind: 'block', reason: 'policy' })
    await agent.whenIdle()

    expect(events(agent)).toEqual([])
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('append unavailable'))

    disposeBlock()
    send(agent, 'resume')
    await waitForIdle(ctx, agent)

    expect(events(agent).some(event => event.type === 'user/message'
      && JSON.stringify(event.data.content).includes('retained context'))).toBe(true)
  })

  it('adjacent blocked and allowed prompts keep independent turn outcomes', async () => {
    const adapter = new MockAdapter([textResponse('ran once')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    ctx.on('agent/prompt-submit', async (_agent, content, _source, _signal, next): Promise<PromptDecision> => {
      const text = content.map(b => (b.type === 'text' ? b.text : '')).join('')
      return text === 'secret' ? { kind: 'block', reason: 'policy: no secrets' } : next()
    })

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event: SessionEvent) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    // The rejected admission is dropped; the allowed prompt owns the only turn.
    send(agent, 'secret')
    send(agent, 'safe')
    await waitForIdle(ctx, agent)

    const log = events(agent)
    // The allowed prompt became a user/message and drove exactly one model call.
    const userMsgs = log.filter(e => e.type === 'user/message')
    expect(userMsgs).toHaveLength(1)
    expect(userMsgs[0]?.type === 'user/message' && userMsgs[0].data.content).toEqual([{ type: 'text', text: 'safe' }])
    expect(adapter.requests.length).toBeGreaterThanOrEqual(1)
    expect(log.filter(e => e.type === 'turn/start')).toHaveLength(1)
    expect(reasons).toEqual([{ kind: 'completed' }])
  })

  it('a throwing prompt-submit listener drops that admission while an adjacent message survives', async () => {
    const adapter = new MockAdapter([textResponse('after')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    let threw = false
    ctx.on('agent/prompt-submit', async () => {
      if (!threw) { threw = true; throw new Error('prompt hook broke') }
      return { kind: 'allow' as const }
    })
    const errors: Error[] = []
    const reasons: TurnEndReason[] = []
    const statuses: string[] = []
    ctx.on('agent/error', (_a, _t, _s, error) => {
      if (error instanceof Error) errors.push(error)
    })
    ctx.on('agent/status', (subject, status) => { if (subject === agent) statuses.push(status) })
    ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'turn/end') reasons.push(event.data.reason)
    })

    const idle = waitForIdle(ctx, agent)
    send(agent, 'first')
    send(agent, 'second')
    await idle
    expect(errors).toEqual([])
    const log = events(agent)
    expect(log.filter(e => e.type === 'turn/start')).toHaveLength(1)
    expect(log.filter(e => e.type === 'turn/end')).toHaveLength(1)
    expect(reasons).toEqual([{ kind: 'completed' }])
    expect(statuses).toEqual(['running', 'idle'])
    expect(adapter.requests).toHaveLength(1)
    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('second')
  })
})

describe('agent/session-start', () => {
  it('fires once with source "startup" for a fresh create, before the first turn', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)

    const sources: SessionStartSource[] = []
    ctx.on('agent/session-start', (_agent, source) => void sources.push(source))

    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    // fires synchronously at create, before any turn
    expect(sources).toEqual(['startup'])
    expect(events(agent).some(e => e.type === 'turn/start')).toBe(false)

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    // still only one session-start
    expect(sources).toEqual(['startup'])
  })

  it('a session-start listener can inject context the first request sees', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)

    ctx.on('agent/session-start', (agent) => {
      agent.inject({ content: [{ type: 'text', text: 'session preamble' }], source: { kind: 'plugin', plugin: 'test' } })
    })

    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    send(agent, 'go')
    await waitForIdle(ctx, agent)

    // the injected context reached the model on the first (only) request
    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('session preamble')
    // and is recorded with the plugin source, never mislabeled as a user prompt
    const ctxMsg = events(agent).find(e => e.type === 'user/message' && e.data.source.kind === 'plugin')
    expect(ctxMsg?.type === 'user/message' && ctxMsg.data.source).toEqual({ kind: 'plugin', plugin: 'test' })
  })

  it('a throwing session-start listener does not abort agent construction', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)

    ctx.on('agent/session-start', () => { throw new Error('session-start hook broke') })

    // create must not throw — the listener error is contained/logged
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    expect(agent.id).toBe(SessionId('a1'))

    // and the agent still runs
    send(agent, 'go')
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1)
  })
})

describe('tool additionalContexts buffering across a step', () => {
  it('appends each call\'s contexts only AFTER all tool/results, preserving adjacency', async () => {
    // One assistant step with TWO tool calls; the second model response stops.
    const twoCalls = [
      { type: 'block-start' as const, index: 0, blockType: 'tool-call' as const },
      { type: 'block-end' as const, index: 0, block: { type: 'tool-call' as const, id: CallId('c1'), name: 'echo', arguments: '{"text":"a"}' } },
      { type: 'block-start' as const, index: 1, blockType: 'tool-call' as const },
      { type: 'block-end' as const, index: 1, block: { type: 'tool-call' as const, id: CallId('c2'), name: 'echo', arguments: '{"text":"b"}' } },
      { type: 'usage' as const, usage: { inputTokens: 5, outputTokens: 5 } },
      { type: 'finish' as const, reason: { kind: 'tool-calls' as const } },
    ]
    const adapter = new MockAdapter([twoCalls, textResponse('done')])
    const ctx = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'echo', description: 'echo', parameters: { text: { type: 'string' } },
      async execute(args) { return [{ type: 'text', text: String(args.text) }] },
    }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    // Each call attaches one context naming itself.
    ctx.on('tools/post-execute', async (exec, _result): Promise<PostToolDecision> =>
      ({
        kind: 'accept',
        additionalContexts: [{
          content: [{ type: 'text', text: `ctx-${exec.callId}` }],
          source: { kind: 'plugin', plugin: 'p' },
        }],
      }))

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    // Event order in the log: both tool/results, THEN both injected contexts —
    // never interleaved (which would break tool-call/result adjacency).
    const injected = events(agent).filter(e => e.type === 'user/message' && e.data.source.kind === 'plugin')
    const seqs = events(agent)
    const firstResult = seqs.findIndex(e => e.type === 'tool/result')
    const lastResult = seqs.map(e => e.type).lastIndexOf('tool/result')
    const firstCtx = seqs.findIndex(e => e === injected[0])
    expect(firstResult).toBeGreaterThanOrEqual(0)
    expect(lastResult).toBeGreaterThan(firstResult) // two results
    expect(firstCtx).toBeGreaterThan(lastResult)    // context only after ALL results
    // both contexts present
    const ctxTexts = injected
      .flatMap(e => (e.type === 'user/message' ? e.data.content : []))
      .map(b => (b.type === 'text' ? b.text : ''))
    expect(ctxTexts).toEqual(['ctx-c1', 'ctx-c2'])
  })

  it('appends multiple contexts deferred by one composite tool after its outer result', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'composite', {}), textResponse('done')])
    const ctx = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'composite', description: 'composite', parameters: {},
      async execute(_args, exec) {
        exec.deferContext({ content: [{ type: 'text', text: 'nested-a' }], source: { kind: 'plugin', plugin: 'a' } })
        exec.deferContext({ content: [{ type: 'text', text: 'nested-b' }], source: { kind: 'plugin', plugin: 'b' } })
        return [{ type: 'text', text: 'outer result' }]
      },
    }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const log = events(agent)
    const resultIndex = log.findIndex(event => event.type === 'tool/result')
    const contextEvents = log.filter(event => event.type === 'user/message' && event.data.source.kind === 'plugin')
    expect(resultIndex).toBeGreaterThanOrEqual(0)
    expect(log.findIndex(event => event === contextEvents[0])).toBeGreaterThan(resultIndex)
    expect(contextEvents.map(event => event.type === 'user/message' && event.data.source)).toEqual([
      { kind: 'plugin', plugin: 'a' },
      { kind: 'plugin', plugin: 'b' },
    ])
  })
})

describe('tools/pre-execute gate (native-plugin permission pattern, end-to-end through the loop)', () => {
  it('deny short-circuits dispatch into an isError result the model sees', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'danger', {}), textResponse('ok')])
    const ctx = await harness(adapter)
    let ran = false
    ctx.tools.register(defineContentToolFixture({
      name: 'danger', description: 'danger', parameters: {},
      async execute() { ran = true; return [{ type: 'text', text: 'should not run' }] },
    }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      if (exec.name === 'danger') return { kind: 'deny', reason: 'blocked dangerous tool' }
      return next()
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(ran).toBe(false)
    const result = events(agent).find(e => e.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.isError).toBe(true)
    expect(result?.type === 'tool/result'
      && result.data.content.some(b => b.type === 'text' && b.text.includes('blocked dangerous tool'))).toBe(true)
  })
})

describe('worked example: a native hook plugin is just a cordis plugin on the seams', () => {
  // The whole point of the interception taxonomy: a "native hook" needs no dsh-hook-protocol,
  // no external command, no hook/* log — it is an ordinary cordis plugin subscribing to the
  // canonical events and returning typed decisions.
  const NativeGuard = {
    name: 'native-guard',
    apply(ctx: Context) {
      // 1. SessionStart: seed a standing instruction.
      ctx.on('agent/session-start', (agent, source) => {
        agent.inject({ content: [{ type: 'text', text: `policy active (started: ${source})` }], source: { kind: 'plugin', plugin: 'native-guard' } })
      })
      // 2. PromptSubmit: block a forbidden prompt, annotate the rest.
      ctx.on('agent/prompt-submit', async (_agent, content, _source, _signal, next): Promise<PromptDecision> => {
        const text = content.map(b => (b.type === 'text' ? b.text : '')).join('')
        if (text.includes('rm -rf')) return { kind: 'block', reason: 'destructive prompt blocked' }
        return next()
      })
      // 3. PreToolUse: deny a dangerous tool by name.
      ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
        if (exec.name === 'danger') return { kind: 'deny', reason: 'danger tool denied' }
        return next()
      })
      // 4. PostToolUse: attach context after a tool runs.
      ctx.on('tools/post-execute', async (_exec, _result, next): Promise<PostToolDecision> => {
        const decision = await next()
        if (decision.kind === 'accept') {
          return { kind: 'accept', additionalContexts: [{ content: [{ type: 'text', text: 'audited' }], source: { kind: 'plugin', plugin: 'native-guard' } }] }
        }
        return decision
      })
    },
  }

  it('all four seams fire for a real allowed turn with a tool call', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', { text: 'hi' }), textResponse('done')])
    const ctx = await harness(adapter)
    await ctx.plugin(NativeGuard)
    ctx.tools.register(defineContentToolFixture({
      name: 'echo', description: 'echo', parameters: { text: { type: 'string' } },
      async execute(args) { return [{ type: 'text', text: String(args.text) }] },
    }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'please echo hi')
    await waitForIdle(ctx, agent)

    const log = events(agent)
    // session-start preamble injected
    expect(log.some(e => e.type === 'user/message' && e.data.source.kind === 'plugin'
      && e.data.content.some(b => b.type === 'text' && b.text.includes('policy active (started: startup)')))).toBe(true)
    // prompt allowed → user-sourced user/message recorded
    expect(log.some(e => e.type === 'user/message' && e.data.source.kind === 'user')).toBe(true)
    // tool ran (echo allowed) and post-execute attached "audited" context
    expect(log.some(e => e.type === 'tool/result' && !e.data.isError)).toBe(true)
    expect(log.some(e => e.type === 'user/message' && e.data.source.kind === 'plugin'
      && e.data.content.some(b => b.type === 'text' && b.text === 'audited'))).toBe(true)
    // NO hook/* events — a native plugin needs none
    expect(log.some(e => e.type.startsWith('hook/'))).toBe(false)
  })

  it('the same plugin blocks a destructive prompt before a turn or model call', async () => {
    const adapter = new MockAdapter([textResponse('should not run')])
    const ctx = await harness(adapter)
    await ctx.plugin(NativeGuard)
    const agent = ctx.agentLoop.create(SessionId('a2'), { provider: 'mock', model: 'mock' })

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event: SessionEvent) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'run rm -rf /')
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(0)
    expect(reasons).toEqual([])
  })

  it('HMR-safety: disposing the plugin fiber removes all four listeners', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const fiber = await ctx.plugin(NativeGuard)
    await fiber.dispose()

    // After disposal, a destructive prompt is NOT blocked (the listener is gone).
    const agent = ctx.agentLoop.create(SessionId('a3'), { provider: 'mock', model: 'mock' })
    send(agent, 'run rm -rf /')
    await waitForIdle(ctx, agent)
    // the prompt ran (not rejected) — proving the prompt-submit listener was disposed
    expect(adapter.requests).toHaveLength(1)
    expect(events(agent).some(e => e.type === 'user/message')).toBe(true)
  })
})
