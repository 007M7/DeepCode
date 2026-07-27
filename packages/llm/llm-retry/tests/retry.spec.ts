import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import type { Fiber } from 'cordis'
import LlmService, { CallId, EMPTY_RESPONSE_CODE, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as retry from '../src/index.ts'

type ScriptEntry = Error | Iterable<StreamChunk> | AsyncIterable<StreamChunk>

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

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

function toolResponse(callId: string, name: string): StreamChunk[] {
  const id = CallId(callId)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: '{}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: '{}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/**
 * A degenerate empty provider completion as an error finish chunk. Both
 * adapters emit this shape and the EMPTY_RESPONSE code (the field the policy
 * routes on); the message text here is the deepseek adapter's phrasing (pi-ai
 * qualifies it with the model name).
 */
function emptyCompletion(): StreamChunk[] {
  return [
    { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } },
    {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
      },
    },
  ]
}

async function harness(
  adapter: LlmAdapter,
  config: retry.Config = {},
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
  const resolvedConfig = Object.assign({
    maxTransientRetries: 2,
    initialDelayMs: 500,
    maxDelayMs: 10_000,
    jitterRatio: 0,
  }, config)
  const retryFiber = await ctx.plugin(Object.assign((inner: Context) => {
    retry.apply(inner, resolvedConfig, internals)
  }, { inject: retry.inject }))
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, retryFiber }
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

describe('config validation', () => {
  it.each([
    [{ maxTransientRetries: 1.5 }, /maxTransientRetries must be a non-negative integer/],
    [{ maxTransientRetries: -1 }, /maxTransientRetries must be a non-negative integer/],
    [{ initialDelayMs: 0 }, /initialDelayMs must be a positive finite number/],
    [{ initialDelayMs: Number.NaN }, /initialDelayMs must be a positive finite number/],
    [{ maxDelayMs: 0 }, /maxDelayMs must be a positive finite number/],
    [{ initialDelayMs: 600, maxDelayMs: 500 }, /initialDelayMs must be less than or equal to maxDelayMs/],
    [{ jitterRatio: Number.NaN }, /jitterRatio must be between 0 and 1/],
    [{ retryableCodes: [] }, /retryableCodes must not be empty/],
    [{ retryableCodes: ['SERVER', ''] }, /retryableCodes must contain only non-empty strings/],
    [{ retryableCodes: ['SERVER', 'SERVER'] }, /retryableCodes must not contain duplicates/],
  ] satisfies [retry.Config, RegExp][])('rejects invalid config %j at load', (config, message) => {
    expect(() => { retry.apply(new Context(), config) }).toThrow(message)
  })
})

describe('bounded transient retry policy', () => {
  it('records the scheduled delay before opening a fresh request attempt', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('busy', 'RATE_LIMIT', { status: 429 }),
      textResponse('done'),
    ])
    ;({ ctx: context } = await harness(adapter))
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

    agent.followup({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
    const event = await scheduled

    expect(event.data).toEqual({
      turn: 1,
      step: 1,
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
    expect(agent.session.events.filter(item => item.type === 'step/start').map(item => item.data))
      .toEqual([{ turn: 1, step: 1 }, { turn: 2, step: 1 }])
    expect(agent.session.deriveMessages().at(-1)).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      provenance: { provider: 'mock', model: 'mock' },
    })
  })

  it('retries an EMPTY_RESPONSE error finish under the default retryable codes', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      emptyCompletion(),
      textResponse('recovered'),
    ])
    // No retryableCodes override: this proves the default policy covers the
    // adapters' empty-completion classification end to end (finish-chunk error
    // delivery, not a thrown stream error).
    ;({ ctx: context } = await harness(adapter))
    const agent = context.agentLoop.create(SessionId('retry-empty-response'), { provider: 'mock', model: 'mock' })
    const scheduled = waitForRetry(context, agent, 1)

    agent.followup({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
    const event = await scheduled
    expect(event.data.failure).toEqual({
      message: 'model returned a completed response with no content',
      code: EMPTY_RESPONSE_CODE,
    })

    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(500)
    await idle

    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.events.filter(event => event.type === 'assistant/message')
      .map(event => [event.data.turn, event.data.step]))
      .toEqual([[2, 1]])
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'recovered' }],
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

    agent.followup({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
    await scheduled
    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(500)
    await idle

    const failedChunks = agent.session.events.filter(event =>
      event.type === 'assistant/chunk' && event.data.turn === 1,
    )
    expect(failedChunks).toHaveLength(6)
    expect(agent.session.events.filter(event => event.type === 'assistant/message').map(event => ({
      turn: event.data.turn,
      step: event.data.step,
    }))).toEqual([{ turn: 2, step: 1 }])
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
    ;({ ctx: context } = await harness(adapter, { jitterRatio: 0.1 }, undefined, {
      random: () => samples.shift() ?? 0.5,
    }))
    const agent = context.agentLoop.create(SessionId('retry-exhausted'), { provider: 'mock', model: 'mock' })
    const first = waitForRetry(context, agent, 1)

    agent.followup({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
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

  it('resets the retry budget for a later message', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('first busy', 'SERVER'),
      textResponse('first done'),
      new LlmError('second busy', 'SERVER'),
      textResponse('second done'),
    ])
    ;({ ctx: context } = await harness(adapter, { maxTransientRetries: 1 }))
    const agent = context.agentLoop.create(SessionId('retry-reset'), { provider: 'mock', model: 'mock' })

    const firstRetry = waitForRetry(context, agent, 1)
    agent.followup({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } })
    await firstRetry
    const firstIdle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(500)
    await firstIdle

    const secondRetry = waitForRetry(context, agent, 1)
    agent.followup({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } })
    await secondRetry
    const secondIdle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(500)
    await secondIdle

    expect(agent.session.events.filter(event => event.type === 'llm/retry').map(event => event.data.retry))
      .toEqual([1, 1])
    expect(adapter.requests).toHaveLength(4)
  })

  it('resets the retry budget after a successful tool-call response within the same drain', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('first busy', 'SERVER'),
      toolResponse('work-1', 'work'),
      new LlmError('second busy', 'SERVER'),
      textResponse('done'),
    ])
    ;({ ctx: context } = await harness(adapter, { maxTransientRetries: 1 }))
    context.tools.register(defineContentToolFixture({
      name: 'work',
      description: 'continue into another model step',
      parameters: {},
      async execute() {
        return [{ type: 'text', text: 'worked' }]
      },
    }))
    const agent = context.agentLoop.create(SessionId('retry-reset-after-success'), {
      provider: 'mock',
      model: 'mock',
    })

    const firstRetry = waitForRetry(context, agent, 1)
    agent.followup({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
    await firstRetry
    const secondRetry = waitForRetry(context, agent, 1)
    await vi.advanceTimersByTimeAsync(500)
    await secondRetry
    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(500)
    await idle

    expect(agent.session.events.filter(event => event.type === 'llm/retry').map(event => event.data.retry))
      .toEqual([1, 1])
    expect(adapter.requests).toHaveLength(4)
  })

  it('accepts the zero-delay lower jitter bound', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('busy', 'SERVER'),
      textResponse('done'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      initialDelayMs: 1,
      maxDelayMs: 1,
      jitterRatio: 1,
    }, undefined, { random: () => 0 }))
    const agent = context.agentLoop.create(SessionId('retry-zero-delay'), { provider: 'mock', model: 'mock' })
    const scheduled = waitForRetry(context, agent, 1)

    agent.followup({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
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
    ;({ ctx: context } = await harness(accepted, { jitterRatio: 1 }))
    const acceptedAgent = context.agentLoop.create(SessionId('retry-after-accepted'), { provider: 'mock', model: 'mock' })
    const scheduled = waitForRetry(context, acceptedAgent, 1)
    acceptedAgent.followup({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
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
    rejectedAgent.followup({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
    await rejectedIdle
    expect(rejected.requests).toHaveLength(1)
    expect(rejectedAgent.session.events.some(event => event.type === 'llm/retry')).toBe(false)
  })

  it('delegates non-transient failures without scheduling a timer', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([new LlmError('bad key', 'AUTH')])
    ;({ ctx: context } = await harness(adapter))
    const agent = context.agentLoop.create(SessionId('retry-auth'), { provider: 'mock', model: 'mock' })
    const idle = waitForIdle(context, agent)
    agent.followup({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
    await idle
    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.some(event => event.type === 'llm/retry')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the consumed budget when an unowned session logs an assistant message', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('busy one', 'SERVER'),
      new LlmError('busy two', 'SERVER'),
    ])
    ;({ ctx: context } = await harness(adapter, { maxTransientRetries: 1 }))
    const agent = context.agentLoop.create(SessionId('retry-foreign-session'), { provider: 'mock', model: 'mock' })
    const scheduled = waitForRetry(context, agent, 1)

    agent.followup({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
    await scheduled

    // A session no agent owns completes a response; the agent's consecutive-
    // failure sequence must not reset from that foreign success.
    const foreign = context.sessions.create(SessionId('retry-foreign-session-other'))
    foreign.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    foreign.append('step/start', { turn: 1, step: 1 })
    foreign.append('assistant/message', {
      turn: 1,
      step: 1,
      content: [{ type: 'text', text: 'foreign' }],
      provenance: { provider: 'mock', model: 'mock' },
    }, { surfaceOp: 'append' })

    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(500)
    await idle

    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.events.filter(event => event.type === 'llm/retry')).toHaveLength(1)
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', failure: { message: 'busy two', code: 'SERVER' } } },
    })
  })

  it('drops a scheduled retry when cancellation lands between its durable record and its wait', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('busy', 'SERVER'),
      textResponse('must not run'),
    ])
    ;({ ctx: context } = await harness(adapter))
    const agent = context.agentLoop.create(SessionId('retry-cancel-at-record'), { provider: 'mock', model: 'mock' })
    // The durable record commits synchronously before the cancellable wait; a
    // user cancel observed at that exact point must skip the wait entirely.
    const dispose = context.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'llm/retry') {
        dispose()
        agent.cancel({ kind: 'user' })
      }
    })
    const idle = waitForIdle(context, agent)

    agent.followup({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
    await idle
    await vi.advanceTimersByTimeAsync(60_000)

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'llm/retry')).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('schedules nothing when an upstream recovery listener already cancelled the turn', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('busy', 'SERVER'),
      textResponse('must not run'),
    ])
    ;({ ctx: context } = await harness(adapter, {}, (ctx) => {
      // Registered before the retry plugin, so it wraps the policy: it cancels
      // the turn, then delegates into a policy that sees an aborted signal.
      ctx.on('agent/request-error', (agent, _turn, _step, _error, _failure, _signal, next) => {
        agent.cancel({ kind: 'user' })
        return next()
      })
    }))
    const agent = context.agentLoop.create(SessionId('retry-upstream-cancel'), { provider: 'mock', model: 'mock' })
    const idle = waitForIdle(context, agent)

    agent.followup({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
    await idle
    await vi.advanceTimersByTimeAsync(60_000)

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.some(event => event.type === 'llm/retry')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does nothing when its captured listener resumes after plugin disposal', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('busy', 'SERVER'),
      textResponse('must not run'),
    ])
    const holder: { dispose?: () => Promise<void> } = {}
    const mounted = await harness(adapter, {}, (ctx) => {
      // An upstream listener captured in the same waterfall disposes the retry
      // plugin before delegating; the stale downstream callback must bail.
      ctx.on('agent/request-error', async (_agent, _turn, _step, _error, _failure, _signal, next) => {
        await holder.dispose?.()
        return next()
      })
    })
    context = mounted.ctx
    holder.dispose = () => mounted.retryFiber.dispose()
    const agent = context.agentLoop.create(SessionId('retry-stale-listener'), { provider: 'mock', model: 'mock' })
    const idle = waitForIdle(context, agent)

    agent.followup({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
    await idle
    await vi.advanceTimersByTimeAsync(60_000)

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.some(event => event.type === 'llm/retry')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts and drains a captured backoff before plugin disposal completes', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('temporary', 'TRANSPORT'),
      textResponse('must not run'),
    ])
    const mounted = await harness(adapter)
    context = mounted.ctx
    const agent = context.agentLoop.create(SessionId('retry-hmr'), { provider: 'mock', model: 'mock' })
    const scheduled = waitForRetry(context, agent, 1)
    agent.followup({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
    await scheduled
    const idle = waitForIdle(context, agent)
    await mounted.retryFiber.dispose()
    await idle
    await vi.advanceTimersByTimeAsync(60_000)

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'step/start')).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

})
