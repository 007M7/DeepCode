import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { createUserMessage, CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import AgentRegistry, { agentEvents, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as timeContext from '@deepseek-ai/dsh-time-context'
import type { Config } from '@deepseek-ai/dsh-time-context'

const BASE = Date.parse('2026-07-14T00:00:00.000Z')
const ORIGINAL_TIME_ZONE = process.env['TZ']
const SIGNAL = new AbortController().signal

beforeEach(() => {
  process.env['TZ'] = 'UTC'
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(BASE)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  if (ORIGINAL_TIME_ZONE === undefined) delete process.env['TZ']
  else process.env['TZ'] = ORIGINAL_TIME_ZONE
})

async function mount(config: Config = {}) {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  const fiber = await ctx.plugin(timeContext, config)
  return { ctx, fiber }
}

function sessionAgent(session: Session, id = 'agent'): Agent {
  return {
    id: SessionId(id),
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('time-context must append directly to the open step') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function openMessageTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `turn ${turn}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function contextTexts(session: Session): string[] {
  const texts: string[] = []
  for (const event of session.events) {
    if (event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'time-context') {
      texts.push(event.data.content.find(block => block.type === 'text')?.text ?? '')
    }
  }
  return texts
}

async function fire(
  ctx: Context,
  agent: Agent,
  turn: number,
  step: number,
  signal: AbortSignal = SIGNAL,
  messages: UserMessage[] = [],
): Promise<void> {
  const fallback = messages.length === 0
    ? createUserMessage({
      content: [],
      source: { kind: 'plugin', plugin: 'time-context-test-proposal' },
    })
    : undefined
  const proposal = fallback === undefined ? messages : [fallback]
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: proposal, turn, step, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: proposal }),
  )
  if (decision.kind === 'enter') {
    for (const message of decision.messages) {
      if (message.id === fallback?.id) continue
      agent.session.append('user/message', message, { surfaceOp: 'append' })
    }
  }
}

function rpcMessage(text: string, clientTimeZone: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user', rpcId: `rpc-${text}`, clientTimeZone } as never,
  })
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallResponse(): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: CallId('tick-1'), name: 'tick', arguments: '{}' },
    },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: StreamChunk[][]) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const chunks = this.script.shift()
    if (chunks === undefined) throw new Error('ScriptedAdapter: script exhausted')
    for (const chunk of chunks) yield chunk
  }
}

async function loopHarness(adapter: ScriptedAdapter, config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(timeContext, config)
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function requestText(request: GenerateOptions): string {
  return request.messages
    .flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

describe('durable step context', () => {
  it('uses the immutable Session zone and the current request message zone', async () => {
    const { ctx } = await mount()
    const id = SessionId('session-zone')
    const session = Session.create(id, [], {
      version: 0,
      id,
      createdAt: BASE,
      timeZone: 'Asia/Shanghai',
    })
    session.append('turn/start', { turn: 1 })
    const agent = sessionAgent(session)

    await fire(ctx, agent, 1, 1, SIGNAL, [
      rpcMessage('local request', 'Asia/Shanghai'),
    ])

    expect(contextTexts(session)[0]).toContain(
      '2026-07-14T08:00:00+08:00[Asia/Shanghai]',
    )
    expect(contextTexts(session)[0]).toContain('Session time zone: Asia/Shanghai.')
    expect(contextTexts(session)[0]).toContain('Client time zone for this request: Asia/Shanghai.')
    const reading = session.events.at(-1)
    expect(reading).toMatchObject({
      type: 'user/message',
      data: {
        source: { kind: 'plugin', plugin: 'time-context' },
      },
    })

    await fire(ctx, agent, 1, 2, SIGNAL, [
      rpcMessage('same zone again', 'Asia/Shanghai'),
    ])
    expect(contextTexts(session)).toHaveLength(2)
  })

  it('reports sorted mixed zones from the current request chain without changing the Session zone', async () => {
    const { ctx } = await mount()
    const id = SessionId('mixed-zone')
    const session = Session.create(id, [], {
      version: 0,
      id,
      createdAt: BASE,
      timeZone: 'Asia/Shanghai',
    })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', rpcMessage('first tab', 'Asia/Shanghai'), {
      surfaceOp: 'append',
    })

    await fire(ctx, sessionAgent(session), 1, 1, SIGNAL, [
      rpcMessage('second tab', 'America/New_York'),
    ])

    expect(contextTexts(session)[0]).toContain('Session time zone: Asia/Shanghai.')
    expect(contextTexts(session)[0]).toContain(
      'Client time zone for this request: mixed ["America/New_York","Asia/Shanghai"].',
    )
  })

  it('records turn, step, zoned time, and the preceding model-visible message baseline', async () => {
    const { ctx } = await mount({ timeZone: 'Asia/Shanghai' })
    const session = Session.create(SessionId('first'))
    openMessageTurn(session, 1)
    vi.setSystemTime(BASE + 90_061_000)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(contextTexts(session)).toEqual([
      'Time sampled while preparing turn 1, step 1: 2026-07-15T09:01:01+08:00[Asia/Shanghai]\n'
      + 'Session time zone: unavailable.\n'
      + 'Client time zone for this request: missing.\n'
      + 'Elapsed since the preceding model-visible message: 1d 1h 1m 1s.',
    ])
    const event = session.events.at(-1)
    expect(event?.type).toBe('user/message')
    if (event?.type !== 'user/message') throw new Error('missing time context')
    expect(event.data.source).toEqual({
      kind: 'plugin',
      plugin: 'time-context',
    })
    expect(event.surfaceOp).toBe('append')
  })

  it('reports an unavailable first-step baseline when no model-visible message precedes it', async () => {
    const { ctx } = await mount()
    const session = Session.create(SessionId('unavailable'))
    session.append('turn/start', { turn: 1 })

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(contextTexts(session)[0]).toContain(
      'Elapsed since the preceding model-visible message: unavailable.',
    )
  })

  it.each([
    ['omitted interval', {}],
    ['zero interval', { refreshIntervalMs: 0 }],
  ] as const)('uses the preceding durable step-context timestamp after step one with %s', async (_label, config) => {
    const { ctx } = await mount(config)
    const session = Session.create(SessionId('later-step'))
    const agent = sessionAgent(session)
    openMessageTurn(session, 3)
    await fire(ctx, agent, 3, 1)
    vi.setSystemTime(BASE + 61_000)

    await fire(ctx, agent, 3, 2)

    expect(contextTexts(session)[1]).toBe(
      'Time sampled while preparing turn 3, step 2: 2026-07-14T00:01:01+00:00[UTC]\n'
      + 'Session time zone: unavailable.\n'
      + 'Client time zone for this request: missing.\n'
      + 'Elapsed since the preceding step context: 1m 1s.',
    )
  })

  it('reports an unavailable later-step baseline at the matching turn boundary', async () => {
    const { ctx } = await mount()
    const session = Session.create(SessionId('later-step-boundary'))
    openMessageTurn(session, 4)

    await fire(ctx, sessionAgent(session), 4, 2)

    expect(contextTexts(session)[0]).toContain(
      'Elapsed since the preceding step context: unavailable.',
    )
  })

  it('reports an unavailable later-step baseline when event lookup is exhausted', async () => {
    const { ctx } = await mount()
    const session = Session.create(SessionId('later-step-exhausted'))

    await fire(ctx, sessionAgent(session), 1, 2)

    expect(contextTexts(session)[0]).toContain(
      'Elapsed since the preceding step context: unavailable.',
    )
  })

  it('injects after backward wall-clock movement and clamps elapsed time to zero', async () => {
    const { ctx } = await mount({ refreshIntervalMs: 60_000 })
    const session = Session.create(SessionId('backward'))
    const agent = sessionAgent(session)
    openMessageTurn(session, 1)
    await fire(ctx, agent, 1, 1)
    vi.setSystemTime(BASE - 5_000)

    await fire(ctx, agent, 1, 2)

    expect(contextTexts(session)).toHaveLength(2)
    expect(contextTexts(session)[1]).toContain('Elapsed since the preceding step context: 0s.')
  })

  it('uses a shadowed durable injection after resume and injects at the exact threshold', async () => {
    const { ctx } = await mount({ refreshIntervalMs: 1_000 })
    const original = Session.create(SessionId('seed-source'))
    openMessageTurn(original, 1)
    await fire(ctx, sessionAgent(original), 1, 1)
    const user = original.events.find(event => event.type === 'user/message' && event.data.source.kind === 'user')
    const reading = original.events.find(event => event.type === 'user/message' && event.data.source.kind === 'plugin')
    if (user === undefined || reading === undefined) throw new Error('missing source surface events')
    original.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'compacted history' }],
      source: { kind: 'plugin', plugin: 'compact-basic' },
    }), {
      surfaceOp: { op: 'replace', start: user.seq, end: reading.seq },
      sourceEventSeqs: [user.seq, reading.seq],
    })
    original.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(JSON.stringify(original.deriveMessages())).not.toContain('Time sampled while preparing')

    const resumed = Session.create(SessionId('resumed'), [...original.events])
    const resumedAgent = sessionAgent(resumed)
    vi.setSystemTime(BASE + 999)
    openMessageTurn(resumed, 2)
    const beforeSkip = resumed.events.length

    await fire(ctx, resumedAgent, 2, 1)

    expect(resumed.events).toHaveLength(beforeSkip)
    expect(contextTexts(resumed)).toHaveLength(1)

    vi.setSystemTime(BASE + 1_000)
    await fire(ctx, resumedAgent, 2, 2)

    expect(contextTexts(resumed)).toHaveLength(2)
    expect(contextTexts(resumed)[1]).toContain(
      'Elapsed since the preceding step context: unavailable.',
    )
  })

  it('applies a positive interval across turns without sharing state between sessions', async () => {
    const { ctx } = await mount({ refreshIntervalMs: 1_000 })
    const first = Session.create(SessionId('interval-first'))
    const firstAgent = sessionAgent(first, 'first-agent')
    openMessageTurn(first, 1)
    await fire(ctx, firstAgent, 1, 1)
    first.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    vi.setSystemTime(BASE + 500)
    openMessageTurn(first, 2)
    const beforeSkip = first.events.length
    await fire(ctx, firstAgent, 2, 1)

    const independent = Session.create(SessionId('interval-independent'))
    openMessageTurn(independent, 1)
    await fire(ctx, sessionAgent(independent, 'independent-agent'), 1, 1)

    expect(first.events).toHaveLength(beforeSkip)
    expect(contextTexts(first)).toHaveLength(1)
    expect(contextTexts(independent)).toHaveLength(1)
  })

  it('skips an already-aborted prompt submission', async () => {
    const { ctx } = await mount()
    const session = Session.create(SessionId('ordering'))
    const agent = sessionAgent(session)
    openMessageTurn(session, 1)

    await fire(ctx, agent, 1, 1)
    const abort = new AbortController()
    abort.abort()
    await fire(ctx, agent, 1, 2, abort.signal)

    expect(contextTexts(session)).toHaveLength(1)
  })
})

describe('configuration and lifecycle', () => {
  it('defaults to the process system zone and retains the zone resolved at plugin load', async () => {
    process.env['TZ'] = 'Asia/Shanghai'
    const { ctx } = await mount()
    process.env['TZ'] = 'America/New_York'
    const session = Session.create(SessionId('system-zone'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(contextTexts(session)[0]).toContain('2026-07-14T08:00:00+08:00[Asia/Shanghai]')
  })

  it('fails loud for an invalid explicit zone or an unavailable process zone', async () => {
    const invalid = new Context()
    await invalid.plugin(AgentRegistry)
    await expect(invalid.plugin(timeContext, { timeZone: 'Not/A_Real_Zone' })).rejects.toThrow(
      /invalid IANA timeZone/,
    )

    vi.spyOn(Intl, 'DateTimeFormat').mockImplementationOnce(() => {
      throw new RangeError('system zone unavailable')
    })
    const unresolved = new Context()
    await unresolved.plugin(AgentRegistry)
    await expect(unresolved.plugin(timeContext, {})).rejects.toThrow(/failed to resolve the system time zone/)
  })

  it('fails loud when a persisted Session names an invalid zone', async () => {
    const { ctx } = await mount()
    const id = SessionId('invalid-session-zone')
    const session = Session.create(id, [], {
      version: 0,
      id,
      createdAt: BASE,
      timeZone: 'Not/A_Real_Zone',
    })
    openMessageTurn(session, 1)

    await expect(fire(ctx, sessionAgent(session), 1, 1)).rejects.toThrow(/invalid Session time zone/)
  })

  it('rejects invalid refresh intervals at plugin load with one diagnostic', async () => {
    const invalid = [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, Number.NaN]
    for (const refreshIntervalMs of invalid) {
      await expect(mount({ refreshIntervalMs })).rejects.toThrow(
        'time-context: refreshIntervalMs must be a non-negative safe integer',
      )
    }
  })

  it('removes its listener when the plugin fiber disposes', async () => {
    const { ctx, fiber } = await mount()
    const session = Session.create(SessionId('dispose'))
    const agent = sessionAgent(session)
    openMessageTurn(session, 1)
    await fire(ctx, agent, 1, 1)

    await fiber.dispose()
    await fire(ctx, agent, 1, 2)

    expect(contextTexts(session)).toHaveLength(1)
  })

  it('lets an already-stopped direct registration delegate without contributing', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const stop = timeContext.apply(ctx, {})
    stop()
    const session = Session.create(SessionId('stopped-direct-registration'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(contextTexts(session)).toEqual([])
  })
})

describe('real agent-loop request history', () => {
  it.each([
    ['throws', 0],
    ['cancels', 0],
  ] as const)('does not persist context when a downstream pre-step listener %s', async (mode, expectedContexts) => {
    const adapter = new ScriptedAdapter([textResponse('unused')])
    const ctx = await loopHarness(adapter)
    ctx.on('agent/pre-step', ({ agent: subject }, next) => {
      if (mode === 'throws') throw new Error('later pre-step failure')
      subject.cancel({ kind: 'user' })
      return next()
    })
    const agent = ctx.agentLoop.create(SessionId(`late-${mode}`), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(contextTexts(agent.session)).toHaveLength(expectedContexts)
    expect(adapter.requests).toHaveLength(0)
    expect(agent.session.events.some(event => event.type === 'step/start')).toBe(false)
    await ctx.fiber.dispose()
  })

  it('leaves steering that arrives after claim for the next step and derives fresh context', async () => {
    const adapter = new ScriptedAdapter([textResponse('first'), textResponse('second')])
    const ctx = await loopHarness(adapter)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let blocked = true
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      if (blocked && context.agent !== undefined) {
        entered.resolve(undefined)
        await release.promise
      }
      return next()
    })
    const agent = ctx.agentLoop.create(SessionId('late-steering'), { provider: 'mock', model: 'mock' })

    agent.followup(rpcMessage('start in Shanghai', 'Asia/Shanghai'))
    await entered.promise
    agent.steer(rpcMessage('switch to New York', 'America/New_York'))
    blocked = false
    release.resolve(undefined)
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect(agent.inbox.hasPending).toBe(false)
    expect(requestText(adapter.requests[0]!)).toContain('start in Shanghai')
    expect(requestText(adapter.requests[0]!)).not.toContain('switch to New York')
    expect(requestText(adapter.requests[0]!)).toContain('Client time zone for this request: Asia/Shanghai.')
    expect(requestText(adapter.requests[1]!)).toContain('switch to New York')
    expect(requestText(adapter.requests[1]!)).toContain(
      'Client time zone for this request: mixed ["America/New_York","Asia/Shanghai"].',
    )
    expect(contextTexts(agent.session)).toHaveLength(2)
    await ctx.fiber.dispose()
  })

  it('does not let time context create an initial step after downstream suppression', async () => {
    const adapter = new ScriptedAdapter([textResponse('unused')])
    const ctx = await loopHarness(adapter)
    ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      return decision.kind === 'reject' ? decision : { kind: 'enter', messages: [] }
    })
    const agent = ctx.agentLoop.create(SessionId('suppressed-preparation'), {
      provider: 'mock',
      model: 'mock',
    })

    agent.followup(rpcMessage('suppress this prompt', 'Asia/Shanghai'))
    await agent.whenIdle()

    expect(adapter.requests).toEqual([])
    expect(agent.session.events.some(event => event.type === 'step/start')).toBe(false)
    expect(contextTexts(agent.session)).toEqual([])
    expect(agent.inbox.hasPending).toBe(false)
    await ctx.fiber.dispose()
  })

  it('does not revive an empty continuation after a completed step', async () => {
    const adapter = new ScriptedAdapter([textResponse('done')])
    const ctx = await loopHarness(adapter)
    ctx.on('agent/turn-stopping', (subject) => {
      subject.inject(createUserMessage({
        content: [{ type: 'text', text: 'pending context' }],
        source: { kind: 'plugin', plugin: 'test' },
      }))
    })
    ctx.on('agent/pre-step', async (_agent, _messages, context, next) => {
      const decision = await next()
      return context.step === 1 || decision.kind === 'reject'
        ? decision
        : { kind: 'enter', messages: [] }
    })
    const agent = ctx.agentLoop.create(SessionId('empty-completed-continuation'), {
      provider: 'mock',
      model: 'mock',
    })

    agent.followup(rpcMessage('finish once', 'Asia/Shanghai'))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'step/start')).toHaveLength(1)
    expect(contextTexts(agent.session)).toHaveLength(1)
    expect(agent.inbox.hasPending).toBe(false)
    await ctx.fiber.dispose()
  })

  it('preserves post-claim steering without persisting failed-turn context', async () => {
    const adapter = new ScriptedAdapter([textResponse('resumed')])
    const ctx = await loopHarness(adapter)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let blocked = true
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      if (blocked && context.agent !== undefined) {
        entered.resolve(undefined)
        await release.promise
      }
      return next()
    })
    const agent = ctx.agentLoop.create(SessionId('cancelled-assembly'), { provider: 'mock', model: 'mock' })
    const steering = rpcMessage('preserve this steering', 'America/New_York')

    agent.followup(rpcMessage('start', 'Asia/Shanghai'))
    await entered.promise
    agent.steer(steering)
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    blocked = false
    release.resolve(undefined)
    await agent.whenIdle()

    expect(agent.session.events.some(event => event.type === 'step/start')).toBe(false)
    expect(contextTexts(agent.session)).toHaveLength(0)
    expect(agent.inbox.nextStep).toEqual([steering])
    expect(agent.inbox.nextStep.some(message =>
      message.source.kind === 'plugin' && message.source.plugin === 'time-context')).toBe(false)

    agent.followup(rpcMessage('wake', 'America/New_York'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(requestText(adapter.requests[0]!)).toContain('preserve this steering')
    expect(requestText(adapter.requests[0]!)).toContain('Time sampled while preparing turn 2, step 1:')
    await ctx.fiber.dispose()
  })

  it('does not contribute after its disposer wins an in-flight pre-step', async () => {
    const adapter = new ScriptedAdapter([textResponse('done')])
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    const stopTimeContext = timeContext.apply(ctx, {})
    ctx.llm.registerAdapter(['mock'], adapter)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    ctx.on('agent/pre-step', async (_payload, next) => {
      entered.resolve(undefined)
      await release.promise
      return next()
    })
    const agent = ctx.agentLoop.create(SessionId('dispose-inflight-pre-step'), {
      provider: 'mock',
      model: 'mock',
    })

    agent.followup(rpcMessage('continue without disposed context', 'Asia/Shanghai'))
    await entered.promise
    stopTimeContext()
    release.resolve(undefined)
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(requestText(adapter.requests[0]!)).not.toContain('Time sampled while preparing')
    expect(contextTexts(agent.session)).toEqual([])
    expect(agent.inbox.nextStep).toEqual([])
    await ctx.fiber.dispose()
  })

  it('does not add a reading to an empty tool continuation and leaves system headers unchanged', async () => {
    const adapter = new ScriptedAdapter([toolCallResponse(), textResponse('done')])
    const ctx = await loopHarness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'tick',
      description: 'advance fake time',
      parameters: {},
      async execute() {
        vi.setSystemTime(BASE + 61_000)
        return [{ type: 'text' as const, text: 'advanced' }]
      },
    }))
    const agent = ctx.agentLoop.create(SessionId('loop'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    const contexts = agent.session.events.filter(
      (event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.data.source.kind === 'plugin')
    const starts = agent.session.events.filter(event => event.type === 'step/start')
    expect(contexts).toHaveLength(1)
    expect(starts).toHaveLength(adapter.requests.length)
    expect(contexts[0]!.seq).toBeGreaterThan(starts[0]!.seq)
    expect(contexts.every(event => event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'time-context'
      && event.surfaceOp === 'append')).toBe(true)

    const firstRequestText = requestText(adapter.requests[0]!)
    const secondRequestText = requestText(adapter.requests[1]!)
    expect(firstRequestText).toContain('Time sampled while preparing turn 1, step 1:')
    expect(firstRequestText).toContain('Elapsed since the preceding model-visible message: unavailable.')
    expect(firstRequestText).not.toContain('Time sampled while preparing turn 1, step 2:')
    expect(secondRequestText).toContain('Time sampled while preparing turn 1, step 1:')
    expect(secondRequestText).not.toContain('Time sampled while preparing turn 1, step 2:')

    for (const request of adapter.requests) expect(request.system).not.toContain('Time sampled while preparing')
    const headers = agent.session.events.filter(event => event.type === 'request/header')
    expect(JSON.stringify(headers)).not.toContain('Time sampled while preparing')
    await ctx.fiber.dispose()
  })
})

describe('real Loader export path', () => {
  it('keeps namespace metadata and boots the agent listener through unwrapExports', async () => {
    expect('default' in timeContext).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(timeContext) as Record<string, unknown>
    expect(unwrapped).toBe(timeContext)
    expect(unwrapped.name).toBe('time-context')
    expect(unwrapped.inject).toEqual(['agents'])
    expect(unwrapped.Config).toBeDefined()
    expect(typeof unwrapped.apply).toBe('function')

    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const plugin = loader.unwrapExports(timeContext) as Parameters<Context['plugin']>[0]
    await ctx.plugin(plugin)
    const session = Session.create(SessionId('loader'))
    openMessageTurn(session, 1)
    await fire(ctx, sessionAgent(session), 1, 1)
    expect(contextTexts(session)[0]).toContain('Time sampled while preparing turn 1, step 1:')
  })
})
