import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import LlmService, {
  CallId,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  HarnessError,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmFailure, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineTool } from '@deepseek-ai/dsh-tools'
import type { PostToolDecision } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { maxTokensResponse, textResponse, toolCallResponse } from './mock-adapter.ts'

class FailureScriptAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []

  constructor(private readonly entries: (Error | StreamChunk[])[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.entries.shift()
    if (entry === undefined) throw new Error('failure script exhausted')
    if (entry instanceof Error) throw entry
    yield* entry
  }
}

class IteratorConstructionFailureAdapter extends LlmAdapter {
  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
        throw new LlmError('iterator construction failed', 'ITERATOR_CONSTRUCTION')
      },
    }
  }
}

class SynchronousDispatchFailureAdapter extends LlmAdapter {
  constructor(private readonly error: Error) {
    super()
  }

  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw this.error
  }
}

class IteratorResultGetterFailureAdapter extends LlmAdapter {
  constructor(
    private readonly field: 'done' | 'value',
    private readonly error: Error,
  ) {
    super()
  }

  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const result = this.field === 'done' ? {} : { done: false }
    Object.defineProperty(result, this.field, { get: () => { throw this.error } })
    return {
      [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
        return { next: () => Promise.resolve(result as unknown as IteratorResult<StreamChunk>) }
      },
    }
  }
}

const streamListenerFailureCases: readonly [string, (ctx: Context) => void][] = [
  ['synchronous listener throw', (ctx) => {
    ctx.on('llm/stream', () => { throw new Error('synchronous stream listener failed') })
  }],
  ['invalid listener iterable', (ctx) => {
    ctx.on('llm/stream', () => ({}) as AsyncIterable<StreamChunk>)
  }],
  ['listener wrapper iteration failure', (ctx) => {
    ctx.on('llm/stream', (_options, next) => (async function * () {
      for await (const chunk of next()) {
        yield chunk
        throw new Error('stream listener wrapper failed')
      }
    })())
  }],
]

async function harness(adapter?: LlmAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  if (adapter) ctx.llm.registerAdapter(['mock'], adapter)
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

function send(agent: Agent): void {
  agent.send([{ type: 'text', text: 'go' }])
}

function contextError(message = 'context too large'): LlmError {
  return new LlmError(message, CONTEXT_WINDOW_EXCEEDED_CODE)
}

describe('agent post-step and request-error lifecycle', () => {
  it('fires post-step after results, buffered context, and steering but before step/end', async () => {
    const twoCalls: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('call-1'), name: 'work', arguments: '{}' } },
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: CallId('call-2'), name: 'work', arguments: '{}' } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
    const adapter = new FailureScriptAdapter([twoCalls, textResponse('done')])
    const ctx = await harness(adapter)
    ctx.tools.register(defineTool({
      name: 'work',
      description: 'do work',
      parameters: {},
      async execute(_args, exec) {
        if (exec.callId === CallId('call-2')) {
          exec.agent?.steer([{ type: 'text', text: 'steered' }], { source: { kind: 'plugin', plugin: 'test' } })
        }
        return [{ type: 'text', text: 'worked' }]
      },
    }))
    ctx.on('tools/post-execute', async (exec, _result): Promise<PostToolDecision> => ({
      kind: 'accept',
      additionalContexts: [{
        content: [{ type: 'text', text: `context for ${exec.callId}` }],
        source: { kind: 'plugin', plugin: 'test' },
      }],
    }))
    const agent = ctx.agentLoop.create(SessionId('post-step-order'), { provider: 'mock', model: 'mock' })
    const order: string[] = []
    ctx.on('session/event', (_session, event) => {
      if (
        event.type === 'assistant/message' || event.type === 'tool/call'
        || event.type === 'tool/result' || event.type === 'context/message'
        || event.type === 'steering/message' || event.type === 'step/end'
      ) {
        if (!('step' in event.data) || event.data.step === 1) order.push(event.type)
      }
    })
    ctx.on('agent/post-step', (subject, turn, step, signal) => {
      if (subject !== agent || step !== 1) return
      expect({ turn, step, aborted: signal.aborted }).toEqual({ turn: 1, step: 1, aborted: false })
      subject.inject([{ type: 'text', text: 'listener mutation' }], { source: { kind: 'plugin', plugin: 'post-step' } })
      order.push('agent/post-step')
    })

    send(agent)
    await waitForIdle(ctx, agent)

    expect(order).toEqual([
      'assistant/message',
      'tool/call',
      'tool/result',
      'tool/call',
      'tool/result',
      'context/message',
      'context/message',
      'steering/message',
      'context/message',
      'agent/post-step',
      'step/end',
    ])
  })

  it('fires post-step for max-tokens and lets cancellation override that success', async () => {
    const adapter = new FailureScriptAdapter([maxTokensResponse('partial')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('cancel-post-step-max-tokens'), { provider: 'mock', model: 'mock' })
    let entered!: () => void
    const postStepEntered = new Promise<void>((resolve) => { entered = resolve })
    ctx.on('agent/post-step', async (_agent, turn, step, signal) => {
      expect({ turn, step }).toEqual({ turn: 1, step: 1 })
      entered()
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    })

    send(agent)
    const idle = waitForIdle(ctx, agent)
    await postStepEntered
    agent.cancel('cancelled during max-tokens post-step')
    await idle

    expect(agent.session.events.find(event => event.type === 'assistant/message')).toMatchObject({
      data: { usage: { inputTokens: 10, outputTokens: 7 } },
    })
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'aborted', reason: 'cancelled during max-tokens post-step' } },
    })
  })

  it('closes the successful step as disposed when disposal lands during post-step', async () => {
    const adapter = new FailureScriptAdapter([
      toolCallResponse('dispose-call', 'work', {}),
      textResponse('must not continue'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineTool({
      name: 'work',
      description: 'do work',
      parameters: {},
      async execute() { return [{ type: 'text', text: 'worked' }] },
    }))
    const agent = ctx.agentLoop.create(SessionId('dispose-post-step'), { provider: 'mock', model: 'mock' })
    let entered!: () => void
    const postStepEntered = new Promise<void>((resolve) => { entered = resolve })
    ctx.on('agent/post-step', async (_agent, turn, step, signal) => {
      expect({ turn, step }).toEqual({ turn: 1, step: 1 })
      entered()
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    })

    send(agent)
    await postStepEntered
    await ctx.fiber.dispose()

    expect(adapter.requests).toHaveLength(1)
    const boundaries = agent.session.events.filter(event =>
      event.type === 'step/start' || event.type === 'step/end',
    )
    expect(boundaries.map(event => event.type)).toEqual(['step/start', 'step/end'])
    expect(boundaries.map(event => event.data)).toEqual([
      { turn: 1, step: 1 },
      { turn: 1, step: 1 },
    ])
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'disposed' } },
    })
  })

  it.each([
    ['thrown', contextError()],
    ['in-band', [{ type: 'finish', reason: { kind: 'error', failure: { message: 'too large', code: CONTEXT_WINDOW_EXCEEDED_CODE, status: 400 } } }] satisfies StreamChunk[]],
  ] as const)('recovers a %s request failure in a new reconstructable step', async (_style, failure) => {
    const adapter = new FailureScriptAdapter([failure, textResponse('recovered')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId(`recover-${_style}`), { provider: 'mock', model: 'mock' })
    const attempts: number[] = []
    ctx.on('agent/request-error', async (subject, turn, step, error, facts, history) => {
      expect(subject).toBe(agent)
      expect({ turn, step, code: error.code }).toEqual({ turn: 1, step: 1, code: CONTEXT_WINDOW_EXCEEDED_CODE })
      expect(facts.code).toBe(CONTEXT_WINDOW_EXCEEDED_CODE)
      attempts.push(history.length)
      subject.session.append('context/message', {
        content: [{ type: 'text', text: 'RECOVERY SURFACE MUTATION' }],
        source: { kind: 'plugin', plugin: 'test-recovery' },
      }, { surfaceOp: 'append' })
      return { action: 'retry' }
    })

    send(agent)
    await waitForIdle(ctx, agent)

    expect(attempts).toEqual([0])
    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('RECOVERY SURFACE MUTATION')
    const starts = agent.session.events.filter(event => event.type === 'step/start')
    const ends = agent.session.events.filter(event => event.type === 'step/end')
    expect(starts.map(event => event.data.step)).toEqual([1, 2])
    expect(ends.map(event => event.data.step)).toEqual([1, 2])
    const recovery = agent.session.events.find(event => event.type === 'context/message')!
    expect(ends[0]!.seq).toBeLessThan(recovery.seq)
    expect(recovery.seq).toBeLessThan(starts[1]!.seq)
  })

  it.each(streamListenerFailureCases)('does not offer %s to request recovery', async (_name, install) => {
    const ctx = await harness(new FailureScriptAdapter([textResponse('unused')]))
    const agent = ctx.agentLoop.create(SessionId(`stream-plugin-${_name.replaceAll(' ', '-')}`), { provider: 'mock', model: 'mock' })
    let recoveries = 0
    install(ctx)
    ctx.on('agent/request-error', async (_agent, _turn, _step, _error, _failure, _history, _signal, next) => {
      recoveries += 1
      return next()
    })

    send(agent)
    await waitForIdle(ctx, agent)

    expect(recoveries).toBe(0)
    expect(agent.session.events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error' } } })
  })

  it('does not offer a nested model-call failure as the outer request failure', async () => {
    const outer = new FailureScriptAdapter([textResponse('outer adapter must not run')])
    const nested = new FailureScriptAdapter([contextError('nested overflow')])
    const ctx = await harness(outer)
    ctx.llm.registerAdapter(['nested'], nested)
    ctx.on('llm/stream', (options, next) => {
      if (options.provider !== 'mock') return next()
      return (async function* () {
        yield* ctx.llm.stream({
          provider: 'nested',
          model: 'nested',
          messages: [],
          ...options.signal === undefined ? {} : { signal: options.signal },
        })
        yield* next()
      })()
    })
    const agent = ctx.agentLoop.create(SessionId('nested-stream-not-recoverable'), { provider: 'mock', model: 'mock' })
    let recoveries = 0
    ctx.on('agent/request-error', async (_agent, _turn, _step, _error, _failure, _history, _signal, next) => {
      recoveries += 1
      return next()
    })

    send(agent)
    await waitForIdle(ctx, agent)

    expect(nested.requests).toHaveLength(1)
    expect(outer.requests).toHaveLength(0)
    expect(recoveries).toBe(0)
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', message: 'nested overflow', code: CONTEXT_WINDOW_EXCEEDED_CODE } },
    })
  })

  it.each(['prompt-submit', 'prompt-assembly', 'pre-step', 'request'] as const)(
    'does not offer %s middleware failures to request recovery',
    async (boundary) => {
      const adapter = new FailureScriptAdapter([textResponse('unused')])
      const ctx = await harness(adapter)
      if (boundary === 'prompt-submit') {
        ctx.on('agent/prompt-submit', () => { throw new Error('prompt submit failed') })
      } else if (boundary === 'prompt-assembly') {
        ctx.on('system-prompt/assemble', () => { throw new Error('prompt assembly failed') })
      } else if (boundary === 'pre-step') {
        ctx.on('agent/pre-step', () => { throw new Error('pre-step failed') })
      } else {
        ctx.on('agent/request', () => { throw new Error('request middleware failed') })
      }
      const agent = ctx.agentLoop.create(SessionId(`${boundary}-not-recoverable`), { provider: 'mock', model: 'mock' })
      let recoveries = 0
      ctx.on('agent/request-error', async (_agent, _turn, _step, _error, _failure, _history, _signal, next) => {
        recoveries += 1
        return next()
      })

      send(agent)
      await waitForIdle(ctx, agent)

      expect(recoveries).toBe(0)
      expect(adapter.requests).toHaveLength(0)
      expect(agent.session.events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error' } } })
    },
  )

  it('does not offer result, tool, or post-step plugin failures to request recovery', async () => {
    for (const failure of ['result', 'tool', 'post-step'] as const) {
      const adapter = new FailureScriptAdapter([
        failure === 'tool' ? toolCallResponse(`call-${failure}`, 'work', {}) : textResponse('done'),
        ...(failure === 'tool' ? [textResponse('done')] : []),
      ])
      const ctx = await harness(adapter)
      if (failure === 'result') ctx.on('agent/step-result', () => { throw new Error('result failed') })
      if (failure === 'post-step') ctx.on('agent/post-step', () => { throw new Error('post-step failed') })
      if (failure === 'tool') {
        vi.spyOn(ctx.tools, 'execute').mockRejectedValue(new Error('tool service failed'))
      }
      const agent = ctx.agentLoop.create(SessionId(`${failure}-not-recoverable`), { provider: 'mock', model: 'mock' })
      let recoveries = 0
      ctx.on('agent/request-error', async (_agent, _turn, _step, _error, _failure, _history, _signal, next) => {
        recoveries += 1
        return next()
      })
      send(agent)
      await waitForIdle(ctx, agent)
      expect(recoveries, failure).toBe(0)
    }
  })

  it.each([
    ['synchronous dispatch', (error: Error) => new SynchronousDispatchFailureAdapter(error)],
    ['done getter', (error: Error) => new IteratorResultGetterFailureAdapter('done', error)],
    ['value getter', (error: Error) => new IteratorResultGetterFailureAdapter('value', error)],
  ] as const)('preserves original Error identity for adapter %s', async (_name, makeAdapter) => {
    const original = contextError(`${_name} overflow`)
    const ctx = await harness(makeAdapter(original))
    const agent = ctx.agentLoop.create(SessionId(`identity-${_name.replaceAll(' ', '-')}`), { provider: 'mock', model: 'mock' })
    let seen: Error | undefined
    ctx.on('agent/request-error', async (_agent, _turn, _step, error, _failure, _history, _signal, next) => {
      seen = error
      return next()
    })

    send(agent)
    await waitForIdle(ctx, agent)

    expect(seen).toBe(original)
  })

  it('keeps an adapter error with a hostile message accessor on the recovery path', async () => {
    const original = Object.defineProperty(new HarnessError('provider failed', 'SERVER'), 'message', {
      get() { throw new Error('SDK message accessor trap') },
    })
    const ctx = await harness(new SynchronousDispatchFailureAdapter(original))
    const agent = ctx.agentLoop.create(SessionId('hostile-message-recovery'), { provider: 'mock', model: 'mock' })
    let seenError: Error | undefined
    let seenFailure: LlmFailure | undefined
    ctx.on('agent/request-error', async (_agent, _turn, _step, error, failure, _history, _signal, next) => {
      seenError = error
      seenFailure = failure
      return next()
    })

    send(agent)
    await waitForIdle(ctx, agent)

    expect(seenError).toBe(original)
    expect(seenFailure).toEqual({ message: 'LLM adapter failed', code: 'SERVER' })
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', failure: { message: 'LLM adapter failed', code: 'SERVER' } } },
    })
  })

  it('passes structured facts beside the original Error and records its cause chain on exhaustion', async () => {
    const original = new LlmError('provider busy', 'RATE_LIMIT', {
      cause: new Error('upstream connection reset'),
      status: 429,
      providerRetryAfterMs: 2_000,
      requestId: ProviderRequestId('req-9'),
    })
    Object.freeze(original)
    const ctx = await harness(new SynchronousDispatchFailureAdapter(original))
    const agent = ctx.agentLoop.create(SessionId('structured-request-failure'), { provider: 'mock', model: 'mock' })
    let seenError: Error | undefined
    let seenFailure: LlmFailure | undefined
    let seenHistory: readonly LlmFailure[] | undefined
    ctx.on('agent/request-error', async (
      _agent, _turn, _step, error, failure, history, _signal, next,
    ) => {
      seenError = error
      seenFailure = failure
      seenHistory = history
      return next()
    })

    send(agent)
    await waitForIdle(ctx, agent)

    expect(seenError).toBe(original)
    expect(seenFailure).toEqual({
      message: 'provider busy',
      code: 'RATE_LIMIT',
      status: 429,
      providerRetryAfterMs: 2_000,
      requestId: ProviderRequestId('req-9'),
    })
    expect(seenHistory).toEqual([])
    expect(Object.isFrozen(seenHistory)).toBe(true)
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: {
        reason: {
          kind: 'error',
          step: 1,
          failure: {
            message: 'provider busy: upstream connection reset',
            code: 'RATE_LIMIT',
            status: 429,
            providerRetryAfterMs: 2_000,
            requestId: ProviderRequestId('req-9'),
          },
        },
      },
    })
  })

  it('classifies iterator construction and explicit NO_ADAPTER as model-request failures', async () => {
    for (const scenario of ['iterator', 'no-adapter'] as const) {
      const ctx = scenario === 'iterator' ? await harness(new IteratorConstructionFailureAdapter()) : await harness()
      const agent = ctx.agentLoop.create(SessionId(`request-boundary-${scenario}`), { provider: 'mock', model: 'mock' })
      let seen = ''
      ctx.on('agent/request-error', async (_agent, _turn, _step, error, _failure, _history, _signal, next) => {
        seen = error.code ?? ''
        return next()
      })
      send(agent)
      await waitForIdle(ctx, agent)
      expect(seen).toBe(scenario === 'iterator' ? 'ITERATOR_CONSTRUCTION' : 'NO_ADAPTER')
    }
  })

  it('tracks consecutive retry attempts and resets after a successful request', async () => {
    const capped = new FailureScriptAdapter([contextError('first overflow'), contextError('second overflow')])
    const cappedCtx = await harness(capped)
    const cappedAgent = cappedCtx.agentLoop.create(SessionId('retry-cap'), { provider: 'mock', model: 'mock' })
    const cappedHistories: string[][] = []
    cappedCtx.on('agent/request-error', async (
      _agent, _turn, _step, _error, _failure, history, _signal, next,
    ) => {
      const codes = history.map(entry => entry.code)
      cappedHistories.push(codes)
      return codes.length < 1 ? { action: 'retry' } : next()
    })
    send(cappedAgent)
    await waitForIdle(cappedCtx, cappedAgent)
    expect(cappedHistories).toEqual([[], [CONTEXT_WINDOW_EXCEEDED_CODE]])

    const reset = new FailureScriptAdapter([
      contextError('first overflow'),
      toolCallResponse('retry-reset-call', 'work', {}),
      contextError('later overflow'),
    ])
    const resetCtx = await harness(reset)
    resetCtx.tools.register(defineTool({
      name: 'work',
      description: 'continue',
      parameters: {},
      async execute() { return [{ type: 'text', text: 'worked' }] },
    }))
    const resetAgent = resetCtx.agentLoop.create(SessionId('retry-reset'), { provider: 'mock', model: 'mock' })
    const resetHistories: { step: number; codes: string[] }[] = []
    resetCtx.on('agent/request-error', async (
      _agent, _turn, step, _error, _failure, history, _signal, next,
    ) => {
      resetHistories.push({ step, codes: history.map(entry => entry.code) })
      return resetHistories.length === 1 ? { action: 'retry' } : next()
    })
    send(resetAgent)
    await waitForIdle(resetCtx, resetAgent)
    expect(resetHistories).toEqual([{ step: 1, codes: [] }, { step: 3, codes: [] }])
  })

  it('preserves the original provider error when recovery throws', async () => {
    const adapter = new FailureScriptAdapter([contextError('original overflow')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('recovery-throws'), { provider: 'mock', model: 'mock' })
    ctx.on('agent/request-error', () => { throw new Error('recovery exploded') })

    send(agent)
    await waitForIdle(ctx, agent)

    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', failure: { message: 'original overflow', code: CONTEXT_WINDOW_EXCEEDED_CODE } } },
    })
  })

  it.each(['cancel', 'dispose'] as const)('keeps %s live through request recovery', async (action) => {
    const adapter = new FailureScriptAdapter([contextError()])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId(`${action}-recovery`), { provider: 'mock', model: 'mock' })
    let entered!: () => void
    const recoveryEntered = new Promise<void>((resolve) => { entered = resolve })
    ctx.on('agent/request-error', async (_agent, _turn, _step, _error, _failure, _history, signal) => {
      entered()
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
      return { action: 'retry' }
    })

    send(agent)
    const idle = waitForIdle(ctx, agent)
    await recoveryEntered
    if (action === 'cancel') {
      agent.cancel('cancelled during recovery')
      await idle
    } else {
      await ctx.fiber.dispose()
    }

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: action === 'cancel' ? { kind: 'aborted', reason: 'cancelled during recovery' } : { kind: 'disposed' } },
    })
  })
})
