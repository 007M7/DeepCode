import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import type { Fiber } from 'cordis'
import LlmService, { CallId, LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type {
  AlwaysRetryPolicyConfig,
  BackoffConfig,
  GenerateOptions,
  NormalRetryPolicyConfig,
  ResolvedRetryPolicy,
  RetryPolicyConfig,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, RequestErrorDecision } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as retry from '../src/index.ts'

type ScriptEntry = Error | Iterable<StreamChunk> | AsyncIterable<StreamChunk>

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private retryPolicies: Readonly<Record<string, ResolvedRetryPolicy | undefined>> = {}

  constructor(private readonly entries: ScriptEntry[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.entries.shift()
    if (entry === undefined) throw new Error('retry test script exhausted')
    if (entry instanceof Error) throw entry
    yield* entry
  }

  configureRetryPolicies(
    policies: Readonly<Record<string, RetryPolicyConfig | undefined>>,
  ): void {
    this.retryPolicies = Object.fromEntries(Object.entries(policies).map(([provider, policy]) => [
      provider,
      policy === undefined
        ? undefined
        : resolveRetryPolicy(policy, `retry test provider "${provider}" retryPolicy`),
    ]))
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.retryPolicies[provider]
  }
}

async function* partialToolFailure(error: Error): AsyncGenerator<StreamChunk> {
  const id = CallId('discarded-call')
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: 'discarded partial output' }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: 'discarded partial output' } }
  yield { type: 'block-start', index: 1, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 1, id, name: 'danger', argumentsDelta: '{}' }
  yield { type: 'block-end', index: 1, block: { type: 'tool-call', id, name: 'danger', arguments: '{}' } }
  throw error
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

async function harness(
  adapter: ScriptedAdapter,
  policies: Readonly<Record<string, RetryPolicyConfig | undefined>> = { mock: normalConfig() },
  beforeRetry?: (ctx: Context) => void,
  internals: retry.RetryInternals = {},
): Promise<{ ctx: Context; retryFiber: Fiber }> {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  beforeRetry?.(ctx)
  adapter.configureRetryPolicies(policies)
  const retryFiber = await ctx.plugin(Object.assign((inner: Context) => {
    retry.apply(inner, {}, internals)
  }, { inject: retry.inject }))
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock', 'other'], adapter)
  return { ctx, retryFiber }
}

function normalConfig(
  overrides: Partial<Omit<NormalRetryPolicyConfig, 'mode'>> = {},
): NormalRetryPolicyConfig {
  const { backoff, ...policy } = overrides
  return {
    mode: 'normal',
    maxRetries: 2,
    ...policy,
    backoff: {
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0,
      ...backoff,
    },
  }
}

function alwaysConfig(backoff: BackoffConfig = {}): AlwaysRetryPolicyConfig {
  return {
    mode: 'always',
    backoff: {
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0,
      ...backoff,
    },
  }
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

function waitForRetry(ctx: Context, agent: Agent, retryNumber: number): Promise<Extract<SessionEvent, { type: 'llm/retry' }>> {
  return new Promise((resolve) => {
    const dispose = ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'llm/retry' && event.data.retry === retryNumber) {
        dispose()
        resolve(event)
      }
    })
  })
}

let context: Context | undefined

afterEach(async () => {
  vi.useRealTimers()
  await context?.fiber.dispose()
  context = undefined
})

describe('provider-routed retry policy', () => {
  it('records the scheduled delay before opening a fresh request attempt', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('busy', 'RATE_LIMIT', { status: 429 }),
      textResponse('done'),
    ])
    ;({ ctx: context } = await harness(adapter, {}, undefined, { random: () => 0.5 }))
    const agent = context.agentLoop.create(SessionId('retry-success'), {
      provider: 'mock',
      model: 'mock',
    })
    const scheduled = new Promise<Extract<(typeof agent.session.events)[number], { type: 'llm/retry' }>>((resolve) => {
      const dispose = context?.on('session/event', (session, event) => {
        if (session === agent.session && event.type === 'llm/retry') {
          dispose?.()
          resolve(event)
        }
      })
    })

    agent.send([{ type: 'text', text: 'go' }])
    const event = await scheduled

    expect(event.data).toEqual({
      turn: 1,
      step: 1,
      provider: 'mock',
      mode: 'normal',
      retry: 1,
      maxRetries: 2,
      delayMs: 500,
      failure: { message: 'busy', code: 'RATE_LIMIT', status: 429 },
    })
    expect(adapter.requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(499)
    expect(adapter.requests).toHaveLength(1)

    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(1)
    await idle

    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.events.filter(item => item.type === 'step/start').map(item => item.data.step))
      .toEqual([1, 2])
    expect(agent.session.deriveMessages().at(-1)).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      provenance: { provider: 'mock', model: 'mock' },
    })
  })

  it('leaves partial failed chunks on their step without committing a message or tool side effect', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      partialToolFailure(new LlmError('stream interrupted', 'TRANSPORT')),
      textResponse('recovered'),
    ])
    ;({ ctx: context } = await harness(adapter))
    let toolExecutions = 0
    context.tools.register(defineContentToolFixture({
      name: 'danger',
      description: 'must not run for a failed provider attempt',
      parameters: {},
      async execute() {
        toolExecutions += 1
        return [{ type: 'text', text: 'unexpected' }]
      },
    }))
    const agent = context.agentLoop.create(SessionId('retry-partial'), { provider: 'mock', model: 'mock' })
    const scheduled = waitForRetry(context, agent, 1)

    agent.send([{ type: 'text', text: 'go' }])
    await scheduled
    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(500)
    await idle

    const failedChunks = agent.session.events.filter(event =>
      event.type === 'assistant/chunk' && event.data.step === 1,
    )
    expect(failedChunks).toHaveLength(6)
    expect(agent.session.events.filter(event => event.type === 'assistant/message').map(event => event.data.step))
      .toEqual([2])
    expect(agent.session.events.some(event => event.type === 'tool/call')).toBe(false)
    expect(toolExecutions).toBe(0)
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'recovered' }],
      provenance: { provider: 'mock', model: 'mock' },
    })
  })

  it('applies bounded exponential jitter and stops after the configured budget', async () => {
    vi.useFakeTimers()
    const samples = [0, 1]
    const adapter = new ScriptedAdapter([
      new LlmError('busy one', 'SERVER'),
      new LlmError('busy two', 'SERVER'),
      new LlmError('busy three', 'SERVER'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: normalConfig({
      backoff: { jitterRatio: 0.1 },
    }) }, undefined, {
      random: () => samples.shift() ?? 0.5,
    }))
    const agent = context.agentLoop.create(SessionId('retry-exhausted'), { provider: 'mock', model: 'mock' })
    const first = waitForRetry(context, agent, 1)

    agent.send([{ type: 'text', text: 'go' }])
    expect((await first).data.delayMs).toBe(450)

    const second = waitForRetry(context, agent, 2)
    await vi.advanceTimersByTimeAsync(450)
    expect((await second).data.delayMs).toBe(1_100)

    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(1_100)
    await idle

    expect(adapter.requests).toHaveLength(3)
    expect(agent.session.events.filter(event => event.type === 'llm/retry')).toHaveLength(2)
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', failure: { message: 'busy three', code: 'SERVER' } } },
    })
  })

  it('accepts the zero-delay lower jitter bound', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('busy', 'SERVER'),
      textResponse('done'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: normalConfig({
      backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 1 },
    }) }, undefined, { random: () => 0 }))
    const agent = context.agentLoop.create(SessionId('retry-zero-delay'), { provider: 'mock', model: 'mock' })
    const scheduled = waitForRetry(context, agent, 1)

    agent.send([{ type: 'text', text: 'go' }])
    expect((await scheduled).data.delayMs).toBe(0)

    const idle = waitForIdle(context, agent)
    await vi.runAllTimersAsync()
    await idle
    expect(adapter.requests).toHaveLength(2)
  })

  it('uses a bounded provider Retry-After verbatim and delegates an over-cap instruction', async () => {
    vi.useFakeTimers()
    const accepted = new ScriptedAdapter([
      new LlmError('wait', 'RATE_LIMIT', { providerRetryAfterMs: 2_000 }),
      textResponse('done'),
    ])
    ;({ ctx: context } = await harness(accepted, { mock: normalConfig({
      backoff: { jitterRatio: 1 },
    }) }))
    const acceptedAgent = context.agentLoop.create(SessionId('retry-after-accepted'), { provider: 'mock', model: 'mock' })
    const scheduled = waitForRetry(context, acceptedAgent, 1)
    acceptedAgent.send([{ type: 'text', text: 'go' }])
    expect((await scheduled).data.delayMs).toBe(2_000)
    const acceptedIdle = waitForIdle(context, acceptedAgent)
    await vi.advanceTimersByTimeAsync(2_000)
    await acceptedIdle
    expect(accepted.requests).toHaveLength(2)

    await context.fiber.dispose()
    const rejected = new ScriptedAdapter([
      new LlmError('wait too long', 'RATE_LIMIT', { providerRetryAfterMs: 10_001 }),
    ])
    ;({ ctx: context } = await harness(rejected))
    const rejectedAgent = context.agentLoop.create(SessionId('retry-after-rejected'), { provider: 'mock', model: 'mock' })
    const rejectedIdle = waitForIdle(context, rejectedAgent)
    rejectedAgent.send([{ type: 'text', text: 'go' }])
    await rejectedIdle
    expect(rejected.requests).toHaveLength(1)
    expect(rejectedAgent.session.events.some(event => event.type === 'llm/retry')).toBe(false)
  })

  it('uses local jittered backoff when always mode receives an over-cap Retry-After', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('wait too long', 'AUTH', { providerRetryAfterMs: 10 }),
      textResponse('done'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: alwaysConfig({
      initialDelayMs: 2,
      maxDelayMs: 4,
      jitterRatio: 0.5,
    }) }, undefined, { random: () => 1 }))
    const agent = context.agentLoop.create(SessionId('retry-always-over-cap'), {
      provider: 'mock',
      model: 'mock',
    })
    const scheduled = waitForRetry(context, agent, 1)

    agent.send([{ type: 'text', text: 'go' }])
    expect((await scheduled).data.delayMs).toBe(3)
    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(3)
    await idle

    expect(adapter.requests).toHaveLength(2)
  })

  it('delegates non-transient failures without scheduling a timer', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([new LlmError('bad key', 'AUTH')])
    ;({ ctx: context } = await harness(adapter))
    const agent = context.agentLoop.create(SessionId('retry-auth'), { provider: 'mock', model: 'mock' })
    const idle = waitForIdle(context, agent)
    agent.send([{ type: 'text', text: 'go' }])
    await idle
    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.some(event => event.type === 'llm/retry')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('selects policy by the failed request provider', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('mock auth failed', 'AUTH'),
      new LlmError('other auth failed', 'AUTH'),
      textResponse('other recovered'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      other: alwaysConfig({ initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }),
    }))

    const normalAgent = context.agentLoop.create(SessionId('retry-provider-normal'), {
      provider: 'mock',
      model: 'mock',
    })
    const normalIdle = waitForIdle(context, normalAgent)
    normalAgent.send([{ type: 'text', text: 'normal' }])
    await normalIdle
    expect(normalAgent.session.events.some(event => event.type === 'llm/retry')).toBe(false)

    const alwaysAgent = context.agentLoop.create(SessionId('retry-provider-always'), {
      provider: 'other',
      model: 'mock',
    })
    const scheduled = waitForRetry(context, alwaysAgent, 1)
    alwaysAgent.send([{ type: 'text', text: 'always' }])
    expect((await scheduled).data).toMatchObject({
      provider: 'other',
      mode: 'always',
      retry: 1,
      delayMs: 1,
    })
    const alwaysIdle = waitForIdle(context, alwaysAgent)
    await vi.advanceTimersByTimeAsync(1)
    await alwaysIdle

    expect(adapter.requests.map(request => request.provider)).toEqual(['mock', 'other', 'other'])
  })

  it('selects an always policy from the provider chosen by agent/request', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('rerouted auth failed', 'AUTH'),
      textResponse('rerouted recovery'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      other: alwaysConfig({ initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }),
    }, (ctx) => {
      ctx.on('agent/request', async (_agent, _turn, _step, config) => ({
        ...config,
        provider: 'other',
      }))
    }))
    const agent = context.agentLoop.create(SessionId('retry-provider-rerouted'), {
      provider: 'mock',
      model: 'mock',
    })
    const scheduled = waitForRetry(context, agent, 1)

    agent.send([{ type: 'text', text: 'reroute' }])
    expect((await scheduled).data).toMatchObject({ provider: 'other', mode: 'always' })
    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(1)
    await idle

    expect(adapter.requests.map(request => request.provider)).toEqual(['other', 'other'])
  })

  it('keeps always mode unbounded while preserving cancellable jittered backoff', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('auth one', 'AUTH'),
      new LlmError('auth two', 'AUTH'),
      new LlmError('auth three', 'AUTH'),
      new LlmError('auth four', 'AUTH'),
      textResponse('eventually recovered'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: alwaysConfig({
      initialDelayMs: 1,
      maxDelayMs: 4,
      jitterRatio: 0.1,
    }) }, undefined, { random: () => 1 }))
    const agent = context.agentLoop.create(SessionId('retry-always-unbounded'), {
      provider: 'mock',
      model: 'mock',
    })
    const idle = waitForIdle(context, agent)

    agent.send([{ type: 'text', text: 'keep trying' }])
    await vi.runAllTimersAsync()
    await idle

    const events = agent.session.events.filter(event => event.type === 'llm/retry')
    expect(adapter.requests).toHaveLength(5)
    expect(events.map(event => ({
      provider: event.data.provider,
      mode: event.data.mode,
      retry: event.data.retry,
      delayMs: event.data.delayMs,
      hasMax: 'maxRetries' in event.data,
    }))).toEqual([
      { provider: 'mock', mode: 'always', retry: 1, delayMs: 1.1, hasMax: false },
      { provider: 'mock', mode: 'always', retry: 2, delayMs: 2.2, hasMax: false },
      { provider: 'mock', mode: 'always', retry: 3, delayMs: 4, hasMax: false },
      { provider: 'mock', mode: 'always', retry: 4, delayMs: 4, hasMax: false },
    ])
  })

  it('keeps failed error text and partial output out of every retried model context', async () => {
    vi.useFakeTimers()
    const diagnostic = 'private provider diagnostic must not enter context'
    const adapter = new ScriptedAdapter([
      partialToolFailure(new LlmError(diagnostic, 'AUTH')),
      textResponse('recovered without leaked context'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: alwaysConfig({
      initialDelayMs: 1,
      maxDelayMs: 1,
    }) }))
    const agent = context.agentLoop.create(SessionId('retry-always-context-isolation'), {
      provider: 'mock',
      model: 'mock',
    })
    const scheduled = waitForRetry(context, agent, 1)

    agent.send([{ type: 'text', text: 'safe input' }])
    await scheduled
    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(1)
    await idle

    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]?.messages).toEqual(adapter.requests[0]?.messages)
    const retriedContext = JSON.stringify(adapter.requests[1]?.messages)
    expect(retriedContext).not.toContain(diagnostic)
    expect(retriedContext).not.toContain('discarded partial output')
    expect(agent.session.events.some(event =>
      event.type === 'llm/retry' && event.data.failure.message === diagnostic,
    )).toBe(true)
  })

  it('lets downstream specialized recovery run before always fallback', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('requires specialized recovery', 'AUTH'),
      textResponse('specialized recovery won'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: alwaysConfig() }))
    context.on('agent/request-error', async () => ({ action: 'retry' }))
    const agent = context.agentLoop.create(SessionId('retry-always-composition'), {
      provider: 'mock',
      model: 'mock',
    })
    const idle = waitForIdle(context, agent)

    agent.send([{ type: 'text', text: 'recover' }])
    await idle

    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.events.some(event => event.type === 'llm/retry')).toBe(false)
  })

  it.each([
    ['synchronously', () => { throw new Error('downstream recovery failed') }],
    ['asynchronously', async () => { throw new Error('downstream recovery failed') }],
  ])('falls back to always retry when downstream recovery throws %s', async (_kind, failDownstream) => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('requires fallback', 'AUTH'),
      textResponse('always recovered'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: alwaysConfig({
      initialDelayMs: 1,
      maxDelayMs: 1,
    }) }))
    context.on('agent/request-error', failDownstream)
    const agent = context.agentLoop.create(SessionId('retry-always-downstream-error'), {
      provider: 'mock',
      model: 'mock',
    })
    const scheduled = waitForRetry(context, agent, 1)

    agent.send([{ type: 'text', text: 'recover' }])
    await scheduled
    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(1)
    await idle

    expect(adapter.requests).toHaveLength(2)
  })

  it('aborts and drains a captured backoff before plugin disposal completes', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('temporary', 'TRANSPORT'),
      textResponse('must not run'),
    ])
    const mounted = await harness(adapter, { mock: alwaysConfig() })
    context = mounted.ctx
    const agent = context.agentLoop.create(SessionId('retry-hmr'), { provider: 'mock', model: 'mock' })
    const scheduled = waitForRetry(context, agent, 1)
    agent.send([{ type: 'text', text: 'go' }])
    await scheduled
    const idle = waitForIdle(context, agent)

    await mounted.retryFiber.dispose()
    await idle
    await vi.advanceTimersByTimeAsync(60_000)

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'step/start')).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not make plugin disposal wait for a delegated recovery policy', async () => {
    const adapter = new ScriptedAdapter([new LlmError('bad key', 'AUTH')])
    const mounted = await harness(adapter, { mock: alwaysConfig() })
    context = mounted.ctx
    const downstream = Promise.withResolvers<RequestErrorDecision>()
    const entered = Promise.withResolvers<undefined>()
    context.on('agent/request-error', () => {
      entered.resolve(undefined)
      return downstream.promise
    })
    const agent = context.agentLoop.create(SessionId('retry-delegated-disposal'), {
      provider: 'mock',
      model: 'mock',
    })
    const idle = waitForIdle(context, agent)
    agent.send([{ type: 'text', text: 'go' }])
    await entered.promise

    const disposing = mounted.retryFiber.dispose()
    let timer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      disposing.then(() => 'disposed' as const),
      new Promise<'blocked'>((resolve) => { timer = setTimeout(() => { resolve('blocked') }, 100) }),
    ])
    if (timer !== undefined) clearTimeout(timer)
    downstream.resolve({ action: 'fail' })
    await disposing
    await idle

    expect(outcome).toBe('disposed')
    expect(adapter.requests).toHaveLength(1)
  })

  it('lets turn cancellation interrupt a delegated recovery policy', async () => {
    const adapter = new ScriptedAdapter([new LlmError('bad key', 'AUTH')])
    const mounted = await harness(adapter, { mock: alwaysConfig() })
    context = mounted.ctx
    const downstream = Promise.withResolvers<RequestErrorDecision>()
    const entered = Promise.withResolvers<undefined>()
    context.on('agent/request-error', () => {
      entered.resolve(undefined)
      return downstream.promise
    })
    const agent = context.agentLoop.create(SessionId('retry-delegated-cancel'), {
      provider: 'mock',
      model: 'mock',
    })
    const idle = waitForIdle(context, agent)
    agent.send([{ type: 'text', text: 'go' }])
    await entered.promise

    agent.cancel({ kind: 'user' })
    await idle
    downstream.resolve({ action: 'fail' })

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'aborted' } },
    })
  })

  it('handles synchronous cancellation while entering delegated recovery', async () => {
    const adapter = new ScriptedAdapter([new LlmError('bad key', 'AUTH')])
    const mounted = await harness(adapter, { mock: alwaysConfig() })
    context = mounted.ctx
    const downstream = Promise.withResolvers<RequestErrorDecision>()
    context.on('agent/request-error', (agent) => {
      agent.cancel({ kind: 'user' })
      return downstream.promise
    })
    const agent = context.agentLoop.create(SessionId('retry-delegated-sync-cancel'), {
      provider: 'mock',
      model: 'mock',
    })
    const idle = waitForIdle(context, agent)

    agent.send([{ type: 'text', text: 'go' }])
    await idle
    downstream.resolve({ action: 'fail' })

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'aborted' } },
    })
  })

  it('fails a captured callback after disposal without entering downstream policy', async () => {
    const adapter = new ScriptedAdapter([new LlmError('bad key', 'AUTH')])
    const captured = Promise.withResolvers<undefined>()
    let invokeCaptured: (() => Promise<void>) | undefined
    const mounted = await harness(adapter, {}, (ctx) => {
      ctx.on('agent/request-error', (_agent, _turn, _step, _error, _failure, _history, _signal, next) => {
        return new Promise<RequestErrorDecision>((resolve) => {
          invokeCaptured = async () => { resolve(await next()) }
          captured.resolve(undefined)
        })
      })
    })
    context = mounted.ctx
    let downstreamCalls = 0
    context.on('agent/request-error', async (_agent, _turn, _step, _error, _failure, _history, _signal, next) => {
      downstreamCalls += 1
      return next()
    })
    const agent = context.agentLoop.create(SessionId('retry-captured-disposal'), {
      provider: 'mock',
      model: 'mock',
    })
    const idle = waitForIdle(context, agent)
    agent.send([{ type: 'text', text: 'go' }])
    await captured.promise

    await mounted.retryFiber.dispose()
    if (invokeCaptured === undefined) throw new Error('request-error waterfall did not capture retry callback')
    await invokeCaptured()
    await idle

    expect(downstreamCalls).toBe(0)
    expect(adapter.requests).toHaveLength(1)
  })

  it('lets turn cancellation win during backoff without opening another step', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('permanent', 'AUTH'),
      textResponse('must not run'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: alwaysConfig() }))
    const agent = context.agentLoop.create(SessionId('retry-cancel'), { provider: 'mock', model: 'mock' })
    const scheduled = waitForRetry(context, agent, 1)
    agent.send([{ type: 'text', text: 'go' }])
    await scheduled
    const idle = waitForIdle(context, agent)
    agent.cancel({ kind: 'user' })
    await idle

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'aborted' } },
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    ['normal', normalConfig()],
    ['always', alwaysConfig()],
  ])('lets an earlier recovery listener cancel before %s retry policy runs', async (_mode, policy) => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('temporary', 'SERVER'),
      textResponse('must not run'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: policy }, (ctx) => {
      ctx.on('agent/request-error', async (agent, _turn, _step, _error, _failure, _history, _signal, next) => {
        agent.cancel({ kind: 'user' })
        return next()
      })
    }))
    const agent = context.agentLoop.create(SessionId('retry-pre-cancel'), { provider: 'mock', model: 'mock' })
    const idle = waitForIdle(context, agent)

    agent.send([{ type: 'text', text: 'go' }])
    await idle

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.some(event => event.type === 'llm/retry')).toBe(false)
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'aborted' } },
    })
  })

  it('handles synchronous cancellation from the retry status event', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('temporary', 'SERVER'),
      textResponse('must not run'),
    ])
    ;({ ctx: context } = await harness(adapter))
    const agent = context.agentLoop.create(SessionId('retry-event-cancel'), { provider: 'mock', model: 'mock' })
    context.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'llm/retry') agent.cancel({ kind: 'user' })
    })
    const idle = waitForIdle(context, agent)

    agent.send([{ type: 'text', text: 'go' }])
    await idle

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'llm/retry')).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects retry policy configured on the executor instead of a provider', () => {
    expect(() => {
      retry.apply(new Context(), { retryPolicy: { mode: 'always' } })
    }).toThrow(/retryPolicy belongs under each provider/)
  })

  it('rejects unknown executor config', () => {
    expect(() => {
      retry.apply(new Context(), { retryPolciy: {} })
    }).toThrow(/unknown key "retryPolciy"/)
  })
})
