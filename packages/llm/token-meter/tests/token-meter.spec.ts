import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message, TokenUsage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, canonicalHeader } from '@deepseek-ai/dsh-session'
import type { EpochHeader } from '@deepseek-ai/dsh-session'
import TokenMeterService, {
  TOKEN_METER_INVALID_CONFIG,
  TOKEN_METER_MODEL_UNCONFIGURED,
  TokenMeterError,
} from '@deepseek-ai/dsh-token-meter'
import type { ModelTokenMeter, TokenMeterConfig } from '@deepseek-ai/dsh-token-meter'

function header(model: string, extras: Omit<EpochHeader, 'config'> = {}): EpochHeader {
  return canonicalHeader({ config: { model }, ...extras })
}

function textMessage(text: string, role: Message['role'] = 'user'): Message {
  return { role, content: [{ type: 'text', text }] }
}

function appendHeader(session: Session, value: EpochHeader): void {
  session.append('request/header', { header: value, reason: 'initial' })
}

interface SuccessfulCallOptions {
  turn?: number
  step?: number
  providerText?: string
  durableText?: string
  usage?: TokenUsage
  provenance?: 'exact' | 'empty' | 'absent'
}

function appendSuccessfulCall(
  session: Session,
  value: EpochHeader,
  options: SuccessfulCallOptions = {},
): void {
  const turn = options.turn ?? 1
  const step = options.step ?? 1
  const providerText = options.providerText ?? 'provider answer'
  const durableText = options.durableText ?? providerText
  const provenance = options.provenance ?? 'exact'
  session.append('step/start', { turn, step })
  appendHeader(session, value)

  const sources: number[] = []
  if (provenance === 'exact') {
    const chunks = [
      { type: 'block-start' as const, index: 0, blockType: 'text' as const },
      { type: 'text-delta' as const, index: 0, text: providerText },
      { type: 'block-end' as const, index: 0, block: { type: 'text' as const, text: providerText } },
      ...options.usage === undefined ? [] : [{ type: 'usage' as const, usage: options.usage }],
      { type: 'finish' as const, reason: { kind: 'stop' as const } },
    ]
    for (const chunk of chunks) {
      sources.push(session.append('assistant/chunk', { turn, step, chunk }).seq)
    }
  }

  const intent = provenance === 'absent'
    ? { surfaceOp: 'append' as const }
    : { surfaceOp: 'append' as const, sourceEventSeqs: provenance === 'empty' ? [] : sources }
  session.append('assistant/message', {
    turn,
    step,
    content: durableText.length === 0 ? [] : [{ type: 'text', text: durableText }],
    ...options.usage === undefined ? {} : { usage: options.usage },
  }, intent)
  session.append('step/end', { turn, step })
}

function meter(config: TokenMeterConfig = {}): TokenMeterService {
  return new TokenMeterService(new Context(), config)
}

describe('TokenMeterService configuration and registration', () => {
  it('provides immutable zero-config DeepSeek profiles', () => {
    const service = meter()
    expect(service.resolve('deepseek-v4-flash')).toMatchObject({
      model: 'deepseek-v4-flash',
      contextWindow: 128_000,
      charsPerToken: 4,
    })
    expect(service.resolve('deepseek-v4-pro')).toMatchObject({
      model: 'deepseek-v4-pro',
      contextWindow: 128_000,
      charsPerToken: 4,
    })
  })

  it('merges built-in overrides field-wise and defaults custom density', () => {
    const service = meter({
      models: {
        'deepseek-v4-flash': { charsPerToken: 2 },
        custom: { contextWindow: 32_000 },
      },
    })
    expect(service.resolve('deepseek-v4-flash')).toMatchObject({ contextWindow: 128_000, charsPerToken: 2 })
    expect(service.resolve('deepseek-v4-pro')).toMatchObject({ contextWindow: 128_000, charsPerToken: 4 })
    expect(service.resolve('custom')).toMatchObject({ contextWindow: 32_000, charsPerToken: 4 })
  })

  it('throws a typed exact-code error for unknown models', () => {
    const service = meter()
    let thrown: unknown
    try {
      service.resolve('unconfigured-model')
    } catch (error: unknown) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(TokenMeterError)
    expect(thrown).toMatchObject({
      code: TOKEN_METER_MODEL_UNCONFIGURED,
      model: 'unconfigured-model',
    })
    expect((thrown as Error).message).toContain('unconfigured-model')
  })

  it.each([
    [{ models: null }, /models must be an object/],
    [{ models: [] }, /models must be an object/],
    [{ models: { custom: {} } }, /requires contextWindow/],
    [{ models: { '': { contextWindow: 1 } } }, /must not be empty/],
    [{ models: { custom: { contextWindow: 0 } } }, /positive integer/],
    [{ models: { custom: { contextWindow: 1.5 } } }, /positive integer/],
    [{ models: { custom: { contextWindow: 1, charsPerToken: 0 } } }, /positive finite/],
    [{ models: { custom: { contextWindow: 1, charsPerToken: Number.NaN } } }, /positive finite/],
    [{ models: { custom: null } }, /must be an object/],
    [{ models: { custom: [] } }, /must be an object/],
  ] as unknown as Array<[TokenMeterConfig, RegExp]>)('rejects invalid profile config %#', (config, pattern) => {
    let thrown: unknown
    try {
      meter(config)
    } catch (error: unknown) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(TokenMeterError)
    expect(thrown).toMatchObject({ code: TOKEN_METER_INVALID_CONFIG })
    expect((thrown as Error).message).toMatch(pattern)
  })

  it('registers and unregisters ctx.tokenMeter with its plugin fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(TokenMeterService)
    expect(ctx.get('tokenMeter')).toBeInstanceOf(TokenMeterService)
    await fiber.dispose()
    expect(ctx.get('tokenMeter')).toBeUndefined()
  })
})

describe('ModelTokenMeter pricing', () => {
  it('prices every built-in content shape and merge-extended blocks', () => {
    const handle = meter({ models: { custom: { contextWindow: 100, charsPerToken: 2 } } }).resolve('custom')
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'abcd' },
      { type: 'reasoning', text: 'ab' },
      { type: 'tool-call', id: CallId('c'), name: 'read', arguments: '{"x":1}' },
      {
        type: 'tool-result',
        toolCallId: CallId('c'),
        content: [{ type: 'text', text: 'xy' }],
        isError: false,
      },
      { type: 'future-block', payload: 'abcd' } as unknown as ContentBlock,
    ]
    const estimated = handle.estimateMessage({ role: 'assistant', content: blocks })
    expect(estimated).toBeGreaterThan(30)
    expect(handle.estimateMessage(textMessage('abcd'))).toBe(10)
  })

  it('returns a detached deeply immutable empty measurement', () => {
    const handle = meter().resolve('deepseek-v4-flash')
    const session = new Session(SessionId('empty'))
    const result = handle.measure(session)
    expect(result).toEqual({
      model: 'deepseek-v4-flash',
      logRevision: 0,
      baseline: { kind: 'none', tokens: 0 },
      surfaceDeltaTokens: 0,
      totalTokens: 0,
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.baseline)).toBe(true)
    expect(() => {
      ;(result as { totalTokens: number }).totalTokens = 1
    }).toThrow(TypeError)
  })

  it('keeps earlier scalar and surface snapshots detached from later replay', () => {
    const handle = meter().resolve('deepseek-v4-flash')
    const session = new Session(SessionId('detached'))
    session.append('user/message', {
      content: [{ type: 'text', text: 'first' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    const scalar = handle.measure(session)
    const surface = handle.measureSurface(session)
    const scalarCopy = structuredClone(scalar)
    const surfaceCopy = structuredClone(surface)

    session.append('user/message', {
      content: [{ type: 'text', text: 'second' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    expect(handle.measure(session).logRevision).toBe(2)
    expect(handle.measureSurface(session).nodes).toHaveLength(2)
    expect(scalar).toEqual(scalarCopy)
    expect(surface).toEqual(surfaceCopy)
    expect(scalar.logRevision).toBe(1)
    expect(surface.nodes).toHaveLength(1)
  })

  it('prices header, prefix, tools, and surface when no reusable usage exists', () => {
    const handle = meter().resolve('deepseek-v4-flash')
    const session = new Session(SessionId('heuristic'))
    session.append('user/message', {
      content: [{ type: 'text', text: 'question' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    appendHeader(session, header('deepseek-v4-flash', {
      system: 'system',
      messagePrefix: [textMessage('prefix')],
      tools: [{ name: 'read', description: 'read', parameters: { type: 'object' } }],
    }))
    const result = handle.measure(session)
    expect(result.baseline.kind).toBe('estimated')
    expect(result.totalTokens).toBeGreaterThan(handle.measureSurface(session).totalTokens)
    expect(result.logRevision).toBe(session.events.length)
  })
})

describe('replay anchors and surface folds', () => {
  const USAGE: TokenUsage = {
    inputTokens: 20,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    outputTokens: 7,
    reasoningTokens: 6,
  }

  it('uses disjoint provider usage and signed durable-output rewrites', () => {
    const handle = meter().resolve('deepseek-v4-flash')
    const session = new Session(SessionId('usage'))
    session.append('user/message', {
      content: [{ type: 'text', text: 'before' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    appendSuccessfulCall(session, header('deepseek-v4-flash'), {
      providerText: 'short',
      durableText: 'a much longer rewritten durable assistant answer',
      usage: USAGE,
    })
    const result = handle.measure(session)
    expect(result.baseline).toMatchObject({ kind: 'usage', tokens: 34, usage: USAGE })
    expect(result.surfaceDeltaTokens).toBeGreaterThan(0)
    expect(result.totalTokens).toBe(34 + result.surfaceDeltaTokens)
    expect(() => {
      ;((result.baseline as { usage: { inputTokens: number } }).usage.inputTokens) = 1
    }).toThrow(TypeError)
  })

  it('uses an estimated anchor when provider usage is absent', () => {
    const handle = meter().resolve('deepseek-v4-flash')
    const session = new Session(SessionId('missing-usage'))
    appendSuccessfulCall(session, header('deepseek-v4-flash', { system: 's' }), {
      providerText: 'provider',
      durableText: 'rewritten',
    })
    const anchored = handle.measure(session)
    expect(anchored.baseline.kind).toBe('estimated')
    expect(anchored.surfaceDeltaTokens).toBe(0)
    session.append('user/message', {
      content: [{ type: 'text', text: 'later' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    const advanced = handle.measure(session)
    expect(advanced.surfaceDeltaTokens).toBeGreaterThan(0)
  })

  it('distinguishes explicit empty provenance from absent legacy provenance', () => {
    const explicit = new Session(SessionId('explicit-empty'))
    const legacy = new Session(SessionId('legacy-absent'))
    appendSuccessfulCall(explicit, header('deepseek-v4-flash'), {
      durableText: 'listener injected text',
      providerText: '',
      usage: USAGE,
      provenance: 'empty',
    })
    appendSuccessfulCall(legacy, header('deepseek-v4-flash'), {
      durableText: 'listener injected text',
      providerText: '',
      usage: USAGE,
      provenance: 'absent',
    })
    const handle = meter().resolve('deepseek-v4-flash')
    expect(handle.measure(explicit).surfaceDeltaTokens).toBeGreaterThan(0)
    expect(handle.measure(legacy).surfaceDeltaTokens).toBe(0)
  })

  it('preserves one model anchor across another model success and reuses it after switching back', () => {
    const service = meter({
      models: {
        alpha: { contextWindow: 1000 },
        beta: { contextWindow: 1000, charsPerToken: 2 },
      },
    })
    const alpha = service.resolve('alpha')
    const beta = service.resolve('beta')
    const session = new Session(SessionId('switch'))
    const alphaHeader = header('alpha', { system: 'same envelope' })
    appendSuccessfulCall(session, alphaHeader, { usage: USAGE, providerText: 'alpha' })
    expect(alpha.measure(session).baseline.kind).toBe('usage')

    appendSuccessfulCall(session, header('beta'), {
      turn: 1,
      step: 2,
      usage: { inputTokens: 100, outputTokens: 50 },
      providerText: 'beta response',
    })
    expect(alpha.measure(session).baseline.kind).toBe('estimated')
    expect(beta.measure(session).baseline).toMatchObject({ kind: 'usage', tokens: 150 })

    appendHeader(session, alphaHeader)
    const switchedBack = alpha.measure(session)
    expect(switchedBack.baseline).toMatchObject({ kind: 'usage', tokens: 34 })
    expect(switchedBack.surfaceDeltaTokens).toBeGreaterThan(0)
  })

  it('invalidates usage for any canonical envelope change or explicit override', () => {
    const handle = meter().resolve('deepseek-v4-flash')
    const session = new Session(SessionId('envelope'))
    const anchoredHeader = header('deepseek-v4-flash', { system: 'one' })
    appendSuccessfulCall(session, anchoredHeader, { usage: USAGE })
    expect(handle.measure(session, { ...anchoredHeader, tools: [] }).baseline.kind).toBe('usage')
    expect(handle.measure(session, header('deepseek-v4-flash', { system: 'two' })).baseline.kind)
      .toBe('estimated')
    expect(handle.measure(session, header('deepseek-v4-pro', { system: 'one' })).baseline.kind)
      .toBe('estimated')
    expect(handle.measure(session, {
      ...anchoredHeader,
      config: { ...anchoredHeader.config, temperature: 0.2 },
    }).baseline.kind).toBe('estimated')
    expect(handle.measure(session, {
      ...anchoredHeader,
      messagePrefix: [textMessage('prefix')],
    }).baseline.kind).toBe('estimated')
    expect(handle.measure(session, {
      ...anchoredHeader,
      tools: [{ name: 'read', description: 'read', parameters: { type: 'object' } }],
    }).baseline.kind).toBe('estimated')
  })

  it('folds valid header deltas into the effective envelope', () => {
    const session = new Session(SessionId('header-delta'))
    appendHeader(session, header('deepseek-v4-flash'))
    session.append('request/header-delta', { config: { model: 'deepseek-v4-pro' } })
    const result = meter().resolve('deepseek-v4-flash').measure(session)
    expect(result.baseline.kind).toBe('estimated')
    expect(result.logRevision).toBe(2)
  })

  it('replays seeded append and replace operations with signed deltas', () => {
    const service = meter()
    const original = new Session(SessionId('surface-original'))
    appendSuccessfulCall(original, header('deepseek-v4-flash'), {
      usage: USAGE,
      providerText: 'long provider answer '.repeat(100),
    })
    original.append('user/message', {
      content: [{ type: 'text', text: 'new tail' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    const seeded = new Session(SessionId('surface-seeded'), original.events)
    const handle = service.resolve('deepseek-v4-flash')
    const before = handle.measureSurface(seeded)
    const beforeScalar = handle.measure(seeded)
    expect(before.nodes).toHaveLength(2)
    expect(beforeScalar.surfaceDeltaTokens).toBeGreaterThan(0)

    const first = seeded.surface.nodes[0]!.seq
    seeded.append('user/message', {
      content: [{ type: 'text', text: 'replacement' }],
      source: { kind: 'plugin', plugin: 'test' },
    }, { surfaceOp: { op: 'replace', start: first, end: first }, sourceEventSeqs: [first] })
    const after = handle.measureSurface(seeded)
    const afterScalar = handle.measure(seeded)
    expect(after.nodes).toHaveLength(2)
    expect(after.nodes[0]!.seq).toBe(seeded.events.length - 1)
    expect(after.logRevision).toBe(seeded.events.length)
    expect(Object.isFrozen(after.nodes)).toBe(true)
    expect(Object.isFrozen(after.nodes[0])).toBe(true)
    expect(afterScalar.surfaceDeltaTokens).toBeLessThan(0)
    expect(before.nodes).toHaveLength(2)
    expect(before.logRevision).toBe(original.events.length)
    expect(beforeScalar.surfaceDeltaTokens).toBeGreaterThan(0)
  })

  it('prices an empty assistant surface anchor as zero', () => {
    const session = new Session(SessionId('empty-assistant'))
    appendSuccessfulCall(session, header('deepseek-v4-flash'), {
      providerText: '',
      durableText: '',
      provenance: 'empty',
    })
    const surface = meter().resolve('deepseek-v4-flash').measureSurface(session)
    const assistant = session.events.find(event => event.type === 'assistant/message')!
    expect(surface.nodes).toEqual([{ seq: assistant.seq, tokens: 0 }])
    expect(surface.totalTokens).toBe(0)
  })
})

describe('malformed replay and listener lifecycle', () => {
  function expectRepeatedFailure(handle: ModelTokenMeter, session: Session, pattern: RegExp): void {
    expect(() => handle.measure(session)).toThrow(pattern)
    expect(() => handle.measure(session)).toThrow(pattern)
  }

  it('rejects a header delta before any snapshot transactionally', () => {
    const session = new Session(SessionId('bad-delta'))
    session.append('request/header-delta', { config: { model: 'deepseek-v4-flash' } })
    expectRepeatedFailure(meter().resolve('deepseek-v4-flash'), session, /no preceding header/)
  })

  it('rejects a matching-model assistant without its step boundary transactionally', () => {
    const session = new Session(SessionId('bad-step'))
    appendHeader(session, header('deepseek-v4-flash'))
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      content: [{ type: 'text', text: 'bad' }],
    }, { surfaceOp: 'append', sourceEventSeqs: [] })
    expectRepeatedFailure(meter().resolve('deepseek-v4-flash'), session, /no matching step\/start/)
  })

  it('clears completed step boundaries and rejects overlapping or late step events', () => {
    const overlapping = new Session(SessionId('overlapping-step'))
    overlapping.append('step/start', { turn: 1, step: 1 })
    overlapping.append('step/start', { turn: 1, step: 2 })
    expectRepeatedFailure(
      meter().resolve('deepseek-v4-flash'),
      overlapping,
      /arrived before turn 1\/step 1 ended/,
    )

    const late = new Session(SessionId('late-assistant'))
    late.append('step/start', { turn: 1, step: 1 })
    appendHeader(late, header('deepseek-v4-flash'))
    late.append('step/end', { turn: 1, step: 1 })
    late.append('assistant/message', {
      turn: 1,
      step: 1,
      content: [],
    }, { surfaceOp: 'append', sourceEventSeqs: [] })
    expectRepeatedFailure(
      meter().resolve('deepseek-v4-flash'),
      late,
      /no matching step\/start/,
    )

    const mismatchedEnd = new Session(SessionId('mismatched-end'))
    mismatchedEnd.append('step/start', { turn: 1, step: 1 })
    mismatchedEnd.append('step/end', { turn: 1, step: 2 })
    expectRepeatedFailure(
      meter().resolve('deepseek-v4-flash'),
      mismatchedEnd,
      /step\/end .* no matching step\/start/,
    )
  })

  it('rejects invalid assistant provenance', () => {
    const cases: Array<{
      name: string
      appendSource(session: Session): number[]
      pattern: RegExp
    }> = [
      {
        name: 'non-chunk',
        appendSource(session) {
          return [session.append('user/message', {
            content: [{ type: 'text', text: 'x' }],
            source: { kind: 'user' },
          }, { surfaceOp: 'append' }).seq]
        },
        pattern: /is not assistant\/chunk/,
      },
      {
        name: 'wrong-step',
        appendSource(session) {
          return [session.append('assistant/chunk', {
            turn: 1,
            step: 2,
            chunk: { type: 'finish', reason: { kind: 'stop' } },
          }).seq]
        },
        pattern: /belongs to another step/,
      },
    ]
    for (const testCase of cases) {
      const session = new Session(SessionId(`bad-source-${testCase.name}`))
      session.append('step/start', { turn: 1, step: 1 })
      appendHeader(session, header('deepseek-v4-flash'))
      const sourceEventSeqs = testCase.appendSource(session)
      session.append('assistant/message', {
        turn: 1,
        step: 1,
        content: [{ type: 'text', text: 'bad' }],
        usage: { inputTokens: 1, outputTokens: 1 },
      }, { surfaceOp: 'append', sourceEventSeqs })
      expect(() => meter().resolve('deepseek-v4-flash').measure(session)).toThrow(testCase.pattern)
    }
  })

  it('rejects repeated and non-earlier assistant provenance', () => {
    const duplicate = new Session(SessionId('duplicate-source'))
    duplicate.append('step/start', { turn: 1, step: 1 })
    appendHeader(duplicate, header('deepseek-v4-flash'))
    const source = duplicate.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'finish', reason: { kind: 'stop' } },
    }).seq
    duplicate.append('assistant/message', {
      turn: 1,
      step: 1,
      content: [],
      usage: { inputTokens: 1, outputTokens: 0 },
    }, { surfaceOp: 'append', sourceEventSeqs: [source, source] })
    expect(() => meter().resolve('deepseek-v4-flash').measure(duplicate)).toThrow(/repeats source seq/)

    const future = new Session(SessionId('future-source'))
    future.append('step/start', { turn: 1, step: 1 })
    appendHeader(future, header('deepseek-v4-flash'))
    future.append('assistant/message', {
      turn: 1,
      step: 1,
      content: [],
      usage: { inputTokens: 1, outputTokens: 0 },
    }, { surfaceOp: 'append', sourceEventSeqs: [99] })
    expect(() => meter().resolve('deepseek-v4-flash').measure(future)).toThrow(/is not earlier/)
  })

  it('does not partially apply a malformed assistant replacement', () => {
    const session = new Session(SessionId('transactional-replace'))
    session.append('user/message', {
      content: [{ type: 'text', text: 'head' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    appendHeader(session, header('deepseek-v4-flash'))
    const head = session.events[0]!.seq
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      content: [{ type: 'text', text: 'replacement' }],
    }, { surfaceOp: { op: 'replace', start: head, end: head }, sourceEventSeqs: [head] })
    expectRepeatedFailure(
      meter().resolve('deepseek-v4-flash'),
      session,
      /no matching step\/start/,
    )
  })

  it('rejects corrupt replacement ranges without advancing the replay cursor', () => {
    const session = new Session(SessionId('bad-replace'))
    session.append('user/message', {
      content: [{ type: 'text', text: 'head' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    session.append('user/message', {
      content: [{ type: 'text', text: 'bad' }],
      source: { kind: 'user' },
    }, { surfaceOp: { op: 'replace', start: 99, end: 99 }, sourceEventSeqs: [0] })
    expectRepeatedFailure(meter().resolve('deepseek-v4-flash'), session, /invalid current range/)
  })

  it('handles earlier-reader catch-up, eager observation, and service reload', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    let handle: ModelTokenMeter | undefined
    const revisions: number[] = []
    ctx.on('session/event', (session) => {
      if (handle !== undefined) revisions.push(handle.measure(session).logRevision)
    })
    const firstFiber = await ctx.plugin(TokenMeterService)
    handle = ctx.tokenMeter.resolve('deepseek-v4-flash')
    const session = ctx.sessions.create(SessionId('listener-order'))
    handle.measure(session)
    session.append('user/message', {
      content: [{ type: 'text', text: 'one' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    expect(revisions).toEqual([1])
    expect(handle.measure(session).logRevision).toBe(1)

    await firstFiber.dispose()
    const secondFiber = await ctx.plugin(TokenMeterService)
    handle = ctx.tokenMeter.resolve('deepseek-v4-flash')
    expect(handle.measure(session).logRevision).toBe(1)
    await secondFiber.dispose()
  })
})
