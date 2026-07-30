import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeterService from '@deepseek-ai/dsh-token-meter'
import type { ContextPressureProjection, TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'

const ZERO: TokenUsageProjection = {
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

async function harness(): Promise<{
  ctx: Context
  session: Session
  meterFiber: Awaited<ReturnType<Context['plugin']>>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const meterFiber = await ctx.plugin(TokenMeterService)
  return { ctx, session: ctx.sessions.create(), meterFiber }
}

function startStep(session: Session, turn: number, step: number): void {
  session.append('step/start', { turn, step })
}

function usageChunk(
  session: Session,
  usage: TokenUsage,
  turn: number,
  step: number,
): number {
  return session.append('assistant/chunk', {
    turn,
    step,
    chunk: { type: 'usage', usage },
  }).seq
}

function finalUsage(
  session: Session,
  usage: TokenUsage,
  turn: number,
  step: number,
  sourceSeqs: number[],
): void {
  session.append('assistant/message', {
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content: [],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
    usage,
  }, { surfaceOp: 'append', sourceEventSeqs: sourceSeqs })
  session.append('step/end', { turn, step })
}

const projected = (ctx: Context, session: Session): TokenUsageProjection => {
  const value = ctx.sessionProjections.snapshot(session).values.tokenUsage
  if (value === undefined) throw new Error('tokenUsage projection is not registered')
  return value
}

describe('tokenUsage session projection', () => {
  it('serves zero buckets for an empty log', async () => {
    const { ctx, session } = await harness()
    expect(projected(ctx, session)).toEqual(ZERO)
  })

  it('does not count a usage chunk and identical final usage twice', async () => {
    const { ctx, session } = await harness()
    const changes: unknown[] = []
    ctx.sessionProjections.onChanged((_session, key, value) => {
      if (key === 'tokenUsage') changes.push(value)
    })
    const usage = {
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 7,
      cacheWriteTokens: 2,
      reasoningTokens: 3,
    }
    startStep(session, 1, 1)
    const source = usageChunk(session, usage, 1, 1)
    finalUsage(session, usage, 1, 1, [source])

    expect(projected(ctx, session)).toEqual({
      uncachedInputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 7,
      cacheWriteTokens: 2,
    })
    expect(changes).toHaveLength(1)
  })

  it('replaces an earlier same-step chunk sample with the final usage', async () => {
    const { ctx, session } = await harness()
    startStep(session, 1, 1)
    const source = usageChunk(session, {
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 3,
    }, 1, 1)
    finalUsage(session, {
      inputTokens: 14,
      outputTokens: 5,
      cacheReadTokens: 8,
      cacheWriteTokens: 1,
    }, 1, 1, [source])

    expect(projected(ctx, session)).toEqual({
      uncachedInputTokens: 14,
      outputTokens: 5,
      cacheReadTokens: 8,
      cacheWriteTokens: 1,
    })
  })

  it('accumulates disjoint buckets across steps without adding reasoning twice', async () => {
    const { ctx, session } = await harness()
    startStep(session, 1, 1)
    const first = usageChunk(session, {
      inputTokens: 10,
      outputTokens: 6,
      reasoningTokens: 5,
      cacheReadTokens: 2,
    }, 1, 1)
    finalUsage(session, {
      inputTokens: 10,
      outputTokens: 6,
      reasoningTokens: 5,
      cacheReadTokens: 2,
    }, 1, 1, [first])
    startStep(session, 1, 2)
    const second = usageChunk(session, {
      inputTokens: 20,
      outputTokens: 9,
      reasoningTokens: 7,
      cacheWriteTokens: 4,
    }, 1, 2)
    finalUsage(session, {
      inputTokens: 20,
      outputTokens: 9,
      reasoningTokens: 7,
      cacheWriteTokens: 4,
    }, 1, 2, [second])

    expect(projected(ctx, session)).toEqual({
      uncachedInputTokens: 30,
      outputTokens: 15,
      cacheReadTokens: 2,
      cacheWriteTokens: 4,
    })
  })

  it('retains a usage chunk when the request produces no final assistant message', async () => {
    const { ctx, session } = await harness()
    startStep(session, 1, 1)
    usageChunk(session, { inputTokens: 9, outputTokens: 1 }, 1, 1)
    session.append('step/end', { turn: 1, step: 1 })
    expect(projected(ctx, session)).toEqual({
      uncachedInputTokens: 9,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  })

  it('does not erase historical billing when the visible surface is replaced', async () => {
    const { ctx, session } = await harness()
    startStep(session, 1, 1)
    const source = usageChunk(session, { inputTokens: 12, outputTokens: 3 }, 1, 1)
    finalUsage(session, { inputTokens: 12, outputTokens: 3 }, 1, 1, [source])
    const before = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'before compaction' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'compacted' }],
      source: { kind: 'plugin', plugin: 'test' },
    }), {
      surfaceOp: { op: 'replace', start: before.seq, end: before.seq },
      sourceEventSeqs: [before.seq],
    })

    expect(projected(ctx, session)).toEqual({
      uncachedInputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  })

  it('unregisters with the token-meter fiber and restores from a JSON checkpoint', async () => {
    const { ctx, session, meterFiber } = await harness()
    startStep(session, 1, 1)
    usageChunk(session, { inputTokens: 8, outputTokens: 2, cacheReadTokens: 5 }, 1, 1)
    const checkpoint = JSON.parse(JSON.stringify(
      ctx.sessionProjections.checkpoint(session),
    )) as ReturnType<typeof ctx.sessionProjections.checkpoint>

    await meterFiber.dispose()
    expect(ctx.sessionProjections.snapshot(session).values).not.toHaveProperty('tokenUsage')

    await ctx.plugin(TokenMeterService)
    expect(ctx.sessionProjections.viewCheckpoint(checkpoint).tokenUsage).toEqual({
      uncachedInputTokens: 8,
      outputTokens: 2,
      cacheReadTokens: 5,
      cacheWriteTokens: 0,
    })
  })
})

const pressure = (ctx: Context, session: Session): ContextPressureProjection => {
  const value = ctx.sessionProjections.snapshot(session).values.contextPressure
  if (value === undefined) throw new Error('contextPressure projection is not registered')
  return value
}

function recordContext(session: Session, model: string, contextWindow?: number): void {
  session.append('request/context', {
    provider: 'mock',
    model,
    ...contextWindow === undefined ? {} : { contextWindow },
  })
}

describe('contextPressure session projection', () => {
  it('serves no pressure or capacity for an empty log', async () => {
    const { ctx, session } = await harness()
    expect(pressure(ctx, session)).toEqual({})
  })

  it('does not synthesize zero pressure before a provider usage sample', async () => {
    const { ctx, session } = await harness()
    startStep(session, 1, 1)
    recordContext(session, 'small', 64_000)
    expect(pressure(ctx, session)).toEqual({ contextWindow: 64_000 })
  })

  it('sums prompt-side buckets and excludes response output', async () => {
    const { ctx, session } = await harness()
    startStep(session, 1, 1)
    usageChunk(session, {
      inputTokens: 100,
      outputTokens: 4_000,
      cacheReadTokens: 20,
      cacheWriteTokens: 5,
    }, 1, 1)
    // Output is deliberately absent: occupancy describes the prompt that was
    // sent, so it holds still while the response streams.
    expect(pressure(ctx, session).pressureTokens).toBe(125)
  })

  it('replaces pressure with the newest request rather than accumulating', async () => {
    const { ctx, session } = await harness()
    startStep(session, 1, 1)
    const first = usageChunk(session, { inputTokens: 100, outputTokens: 10 }, 1, 1)
    finalUsage(session, { inputTokens: 100, outputTokens: 10 }, 1, 1, [first])
    startStep(session, 2, 1)
    usageChunk(session, { inputTokens: 250, outputTokens: 10 }, 2, 1)
    expect(pressure(ctx, session).pressureTokens).toBe(250)
  })

  it('carries the newest recorded capacity and replaces it on a model switch', async () => {
    const { ctx, session } = await harness()
    startStep(session, 1, 1)
    recordContext(session, 'small', 64_000)
    usageChunk(session, { inputTokens: 100, outputTokens: 10 }, 1, 1)
    expect(pressure(ctx, session)).toEqual({ pressureTokens: 100, contextWindow: 64_000 })
    recordContext(session, 'large', 256_000)
    expect(pressure(ctx, session)).toEqual({ pressureTokens: 100, contextWindow: 256_000 })
  })

  it('removes an older capacity when the newest route advertises none', async () => {
    const { ctx, session } = await harness()
    startStep(session, 1, 1)
    recordContext(session, 'small', 64_000)
    usageChunk(session, { inputTokens: 100, outputTokens: 10 }, 1, 1)
    recordContext(session, 'unknown')
    expect(pressure(ctx, session)).toEqual({ pressureTokens: 100 })
  })

  it('pushes no change for unrelated events or a restated capacity', async () => {
    // The registry gates its change feed on Object.is, so a unit that rebuilt
    // state for an event it does not care about would push phantom updates.
    const { ctx, session } = await harness()
    startStep(session, 1, 1)
    recordContext(session, 'small', 64_000)
    usageChunk(session, { inputTokens: 100, outputTokens: 10 }, 1, 1)
    const changed: string[] = []
    ctx.sessionProjections.onChanged((_session, key) => { changed.push(key) })

    session.append('todo/write', { todos: [] })
    expect(changed).not.toContain('contextPressure')
    // A repeated capacity record for the same window is also a no-op.
    recordContext(session, 'small', 64_000)
    expect(changed).not.toContain('contextPressure')
    // A real capacity change still reports.
    recordContext(session, 'large', 256_000)
    expect(changed).toContain('contextPressure')
  })

  it('restores from a JSON checkpoint and unregisters with the token-meter fiber', async () => {
    const { ctx, session, meterFiber } = await harness()
    startStep(session, 1, 1)
    recordContext(session, 'small', 64_000)
    usageChunk(session, { inputTokens: 42, outputTokens: 2 }, 1, 1)
    const checkpoint = JSON.parse(JSON.stringify(
      ctx.sessionProjections.checkpoint(session),
    )) as ReturnType<typeof ctx.sessionProjections.checkpoint>
    expect(checkpoint.contextPressure?.ver).toBe(2)

    await meterFiber.dispose()
    expect(ctx.sessionProjections.snapshot(session).values).not.toHaveProperty('contextPressure')

    await ctx.plugin(TokenMeterService)
    expect(ctx.sessionProjections.viewCheckpoint(checkpoint).contextPressure).toEqual({
      pressureTokens: 42,
      contextWindow: 64_000,
    })
  })
})
