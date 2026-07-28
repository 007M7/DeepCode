import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import type { Agent, AgentLlmTarget } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { affectsSessionMetrics, SessionMetricsProjector } from '../src/session-metrics.ts'

function assistant(
  session: Session,
  turn: number,
  step: number,
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  },
): void {
  session.append('assistant/chunk', {
    turn,
    step,
    chunk: { type: 'usage', usage },
  })
  session.append('assistant/message', {
    turn,
    step,
    content: [{ type: 'text', text: `answer-${turn}-${step}` }],
    provenance: { provider: 'test', model: 'alpha' },
    usage,
  }, { surfaceOp: 'append' })
}

function agent(session: Session): Agent {
  return { id: session.id, session } as Agent
}

function settleAsyncWork(): Promise<void> {
  return new Promise<void>((resolve) => { setImmediate(resolve) })
}

describe('SessionMetricsProjector', () => {
  it('filters text/reasoning stream deltas while retaining usage, headers, and surface mutations', () => {
    const session = new Session(SessionId('metrics-filter'))
    const text = session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'x' },
    })
    const usage = session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    })
    const header = session.append('request/header', {
      header: { config: { provider: 'test', model: 'alpha' } },
      reason: 'initial',
    })
    const surface = session.append('user/message', {
      content: [{ type: 'text', text: 'question' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    expect(affectsSessionMetrics(text)).toBe(false)
    expect(affectsSessionMetrics(usage)).toBe(true)
    expect(affectsSessionMetrics(header)).toBe(true)
    expect(affectsSessionMetrics(surface)).toBe(true)
  })

  it('reconciles usage by turn:step, keeps cache writes disjoint, and survives a surface replacement', () => {
    const ctx = new Context()
    ctx.provide('tokenMeter', {
      measure(session: Session) {
        return { totalTokens: session.surface.nodes.length * 100 }
      },
    })
    const session = new Session(SessionId('metrics-fold'))
    const first = session.append('user/message', {
      content: [{ type: 'text', text: 'large old surface' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    assistant(session, 1, 1, {
      inputTokens: 11,
      outputTokens: 3,
      cacheReadTokens: 89,
      cacheWriteTokens: 8,
    })

    const current: AgentLlmTarget = { provider: 'test', model: 'alpha' }
    const projector = new SessionMetricsProjector(ctx, () => current, () => {})
    const attached = agent(session)
    const before = projector.snapshot(session, attached)
    expect(before).toMatchObject({
      uncachedInputTokens: 11,
      outputTokens: 3,
      cacheReadTokens: 89,
      cacheWriteTokens: 8,
      contextTokens: 200,
    })

    const assistantSeq = session.surface.nodes.at(-1)
    if (assistantSeq === undefined) throw new Error('assistant surface missing')
    session.append('user/message', {
      content: [{ type: 'text', text: 'compact summary' }],
      source: { kind: 'plugin', plugin: 'test' },
    }, {
      surfaceOp: { op: 'replace', start: first.seq, end: assistantSeq },
      sourceEventSeqs: [first.seq, assistantSeq],
    })
    const compacted = projector.snapshot(session, attached)
    expect(compacted).toMatchObject({
      uncachedInputTokens: 11,
      outputTokens: 3,
      cacheReadTokens: 89,
      cacheWriteTokens: 8,
      contextTokens: 100,
    })

    // A replayed usage event for the same step replaces the settled value.
    session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: {
        type: 'usage',
        usage: {
          inputTokens: 12,
          outputTokens: 4,
          cacheReadTokens: 88,
          cacheWriteTokens: 9,
        },
      },
    })
    const replayed = projector.snapshot(session, attached)
    expect(replayed).toMatchObject({
      uncachedInputTokens: 12,
      outputTokens: 4,
      cacheReadTokens: 88,
      cacheWriteTokens: 9,
      contextTokens: 100,
    })
    assistant(session, 1, 2, {
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadTokens: 2_000,
      cacheWriteTokens: 3_000,
    })

    const after = projector.snapshot(session, attached)
    expect(after).toMatchObject({
      logRevision: session.events.length,
      projectionRevision: 3,
      uncachedInputTokens: 1_012,
      outputTokens: 504,
      cacheReadTokens: 2_088,
      cacheWriteTokens: 3_009,
      contextTokens: 200,
    })
    expect(after.uncachedInputTokens).not.toBe(
      after.uncachedInputTokens + after.cacheReadTokens + after.cacheWriteTokens,
    )
  })

  it('publishes only the selected route capacity when asynchronous resolutions race', async () => {
    const ctx = new Context()
    const resolutions = new Map<string, (contextWindow: number) => void>()
    ctx.provide('tokenMeter', { measure: () => ({ totalTokens: 35_000 }) })
    ctx.provide('llm', {
      resolveModelInfo(_provider: string, model: string) {
        return new Promise<{ context: { contextWindow: number } }>((resolve) => {
          resolutions.set(model, (contextWindow) => { resolve({ context: { contextWindow } }) })
        })
      },
    })
    const session = new Session(SessionId('capacity-race'))
    const attached = agent(session)
    let current: AgentLlmTarget = { provider: 'test', model: 'alpha' }
    const resolved = vi.fn()
    const projector = new SessionMetricsProjector(ctx, () => current, resolved)

    expect(projector.snapshot(session, attached).contextWindow).toBeUndefined()
    await vi.waitFor(() => { expect(resolutions.has('alpha')).toBe(true) })
    current = { provider: 'test', model: 'beta' }
    expect(projector.snapshot(session, attached).contextWindow).toBeUndefined()
    await vi.waitFor(() => { expect(resolutions.has('beta')).toBe(true) })

    resolutions.get('alpha')?.(64_000)
    await Promise.resolve()
    expect(resolved).not.toHaveBeenCalled()
    resolutions.get('beta')?.(128_000)
    await vi.waitFor(() => { expect(resolved).toHaveBeenCalledOnce() })
    expect(projector.snapshot(session, attached)).toMatchObject({
      contextTokens: 35_000,
      contextWindow: 128_000,
    })
  })

  it('retries a failed same-route capacity lookup only on the next snapshot', async () => {
    const ctx = new Context()
    const attempts: PromiseWithResolvers<{ context: { contextWindow: number } }>[] = []
    ctx.provide('llm', {
      resolveModelInfo() {
        const attempt = Promise.withResolvers<{ context: { contextWindow: number } }>()
        attempts.push(attempt)
        return attempt.promise
      },
    })
    const session = new Session(SessionId('capacity-retry'))
    const attached = agent(session)
    const resolved = vi.fn()
    const projector = new SessionMetricsProjector(
      ctx,
      () => ({ provider: 'test', model: 'alpha' }),
      resolved,
    )

    expect(projector.snapshot(session, attached).contextWindow).toBeUndefined()
    await vi.waitFor(() => { expect(attempts).toHaveLength(1) })
    attempts[0]?.reject(new Error('metadata temporarily unavailable'))
    await settleAsyncWork()
    expect(attempts).toHaveLength(1)
    expect(resolved).not.toHaveBeenCalled()

    expect(projector.snapshot(session, attached).contextWindow).toBeUndefined()
    await settleAsyncWork()
    expect(attempts).toHaveLength(2)
    attempts[1]?.resolve({ context: { contextWindow: 128_000 } })
    await vi.waitFor(() => { expect(resolved).toHaveBeenCalledOnce() })
    expect(projector.snapshot(session, attached).contextWindow).toBe(128_000)
  })

  it('invalidates same-route capacity and fences the prior epoch in flight', async () => {
    const ctx = new Context()
    const attempts: PromiseWithResolvers<{ context: { contextWindow: number } }>[] = []
    ctx.provide('llm', {
      resolveModelInfo() {
        const attempt = Promise.withResolvers<{ context: { contextWindow: number } }>()
        attempts.push(attempt)
        return attempt.promise
      },
    })
    const session = new Session(SessionId('capacity-invalidation'))
    const attached = agent(session)
    const resolved = vi.fn()
    const projector = new SessionMetricsProjector(
      ctx,
      () => ({ provider: 'test', model: 'alpha' }),
      resolved,
    )

    expect(projector.snapshot(session, attached).contextWindow).toBeUndefined()
    await vi.waitFor(() => { expect(attempts).toHaveLength(1) })
    projector.invalidateCapacities()
    attempts[0]?.resolve({ context: { contextWindow: 64_000 } })
    await settleAsyncWork()
    expect(resolved).not.toHaveBeenCalled()

    expect(projector.snapshot(session, attached).contextWindow).toBeUndefined()
    await vi.waitFor(() => { expect(attempts).toHaveLength(2) })
    attempts[1]?.resolve({ context: { contextWindow: 128_000 } })
    await vi.waitFor(() => { expect(resolved).toHaveBeenCalledOnce() })
    expect(projector.snapshot(session, attached).contextWindow).toBe(128_000)
  })

  it('starts a fresh capacity generation when an unavailable route returns', async () => {
    const ctx = new Context()
    const resolutions: ((contextWindow: number) => void)[] = []
    ctx.provide('llm', {
      resolveModelInfo() {
        return new Promise<{ context: { contextWindow: number } }>((resolve) => {
          resolutions.push((contextWindow) => { resolve({ context: { contextWindow } }) })
        })
      },
    })
    const session = new Session(SessionId('capacity-route-return'))
    const attached = agent(session)
    let current: AgentLlmTarget | undefined = { provider: 'test', model: 'alpha' }
    const resolved = vi.fn()
    const targetFor = vi.fn(() => current)
    const projector = new SessionMetricsProjector(ctx, targetFor, resolved)

    expect(projector.snapshot(session, attached).contextWindow).toBeUndefined()
    await vi.waitFor(() => { expect(resolutions).toHaveLength(1) })
    current = undefined
    resolutions[0]?.(64_000)
    await vi.waitFor(() => { expect(targetFor).toHaveBeenCalledTimes(2) })
    expect(resolved).not.toHaveBeenCalled()
    current = { provider: 'test', model: 'alpha' }
    expect(projector.snapshot(session, attached).contextWindow).toBeUndefined()
    await vi.waitFor(() => { expect(resolutions).toHaveLength(2) })
    resolutions[1]?.(128_000)
    await vi.waitFor(() => { expect(resolved).toHaveBeenCalledOnce() })
    expect(projector.snapshot(session, attached).contextWindow).toBe(128_000)
  })

  it('omits current context fields when measurement or model metadata is unavailable', async () => {
    const ctx = new Context()
    ctx.provide('tokenMeter', { measure: () => { throw new Error('unmeasurable') } })
    ctx.provide('llm', { resolveModelInfo: () => Promise.reject(new Error('metadata unavailable')) })
    const session = new Session(SessionId('missing-metrics'))
    const attached = agent(session)
    const projector = new SessionMetricsProjector(
      ctx,
      () => ({ provider: 'test', model: 'missing' }),
      () => {},
    )
    const metrics = projector.snapshot(session, attached)
    expect(metrics.contextTokens).toBeUndefined()
    expect(metrics.contextWindow).toBeUndefined()
    await vi.waitFor(() => {
      expect(projector.snapshot(session, attached).contextWindow).toBeUndefined()
    })
  })

  it('keeps optional usage buckets at zero and tolerates absent host services or detached agents', async () => {
    const ctx = new Context()
    const session = new Session(SessionId('optional-metrics'))
    assistant(session, 1, 0, { inputTokens: 7, outputTokens: 2 })
    const attached = agent(session)
    const selected: { current?: AgentLlmTarget } = {}
    const projector = new SessionMetricsProjector(
      ctx,
      () => selected.current,
      () => {},
    )

    expect(projector.snapshot(session)).toMatchObject({
      uncachedInputTokens: 7,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(projector.snapshot(session, attached).contextWindow).toBeUndefined()
    selected.current = { provider: 'test', model: 'no-service' }
    expect(projector.snapshot(session, attached).contextWindow).toBeUndefined()
    await Promise.resolve()
  })

  it('publishes a resolved route with no advertised capacity as unknown', async () => {
    const ctx = new Context()
    ctx.provide('llm', { resolveModelInfo: () => Promise.resolve({}) })
    const session = new Session(SessionId('no-capacity'))
    const attached = agent(session)
    const resolved = vi.fn()
    const projector = new SessionMetricsProjector(
      ctx,
      () => ({ provider: 'test', model: 'metadata-without-context' }),
      resolved,
    )

    expect(projector.snapshot(session, attached).contextWindow).toBeUndefined()
    await vi.waitFor(() => { expect(resolved).toHaveBeenCalledOnce() })
    expect(projector.snapshot(session, attached).contextWindow).toBeUndefined()
  })

  it('ignores stale resolution failures and route metadata after the target moves', async () => {
    const ctx = new Context()
    const resolutions = new Map<string, {
      resolve(value: { context: { contextWindow: number } }): void
      reject(error: Error): void
    }>()
    ctx.provide('llm', {
      resolveModelInfo(_provider: string, model: string) {
        return new Promise<{ context: { contextWindow: number } }>((resolve, reject) => {
          resolutions.set(model, { resolve, reject })
        })
      },
    })
    const session = new Session(SessionId('stale-capacity'))
    const attached = agent(session)
    let current: AgentLlmTarget = { provider: 'test', model: 'alpha' }
    const resolved = vi.fn()
    const targetFor = vi.fn(() => current)
    const projector = new SessionMetricsProjector(ctx, targetFor, resolved)

    projector.snapshot(session, attached)
    await vi.waitFor(() => { expect(resolutions.has('alpha')).toBe(true) })
    current = { provider: 'test', model: 'route-moved-before-snapshot' }
    resolutions.get('alpha')?.resolve({ context: { contextWindow: 64_000 } })
    await vi.waitFor(() => { expect(targetFor).toHaveBeenCalledTimes(2) })
    expect(resolved).not.toHaveBeenCalled()

    projector.snapshot(session, attached)
    await vi.waitFor(() => { expect(resolutions.has('route-moved-before-snapshot')).toBe(true) })
    current = { provider: 'test', model: 'beta' }
    projector.snapshot(session, attached)
    await vi.waitFor(() => { expect(resolutions.has('beta')).toBe(true) })
    resolutions.get('route-moved-before-snapshot')?.reject(new Error('stale failure'))
    await Promise.resolve()
    resolutions.get('beta')?.resolve({ context: { contextWindow: 128_000 } })
    await vi.waitFor(() => { expect(resolved).toHaveBeenCalledOnce() })
    expect(projector.snapshot(session, attached).contextWindow).toBe(128_000)
  })
})
