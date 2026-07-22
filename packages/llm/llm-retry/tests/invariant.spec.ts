import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import InvariantService from '@deepseek-ai/dsh-invariants'
import * as RetryInvariant from '@deepseek-ai/dsh-llm-retry/invariant'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantService)
  await ctx.plugin(RetryInvariant)
  return ctx
}

function closeStep(ctx: Context, id: string, turn = 1, step = 1) {
  const session = ctx.sessions.create(SessionId(id))
  session.append('turn/start', { turn, trigger: { kind: 'message', source: { kind: 'user' } } })
  session.append('step/start', { turn, step })
  session.append('step/end', { turn, step })
  return session
}

const failure = { message: 'provider busy', code: 'RATE_LIMIT', status: 429 }

describe('llm-retry invariants', () => {
  it('accepts increasing retry records for successive closed steps and ignores unrelated events', async () => {
    const ctx = await setup()
    const session = closeStep(ctx, 'retry-invariant-valid')
    expect(() => {
      session.append('llm/retry', {
        turn: 1, step: 1, retry: 1, maxRetries: 2, delayMs: 500, failure,
      })
      session.append('step/start', { turn: 1, step: 2 })
      session.append('step/end', { turn: 1, step: 2 })
      session.append('llm/retry', {
        turn: 1, step: 2, retry: 2, maxRetries: 2, delayMs: 1_000, failure,
      })
      const zeroDelay = closeStep(ctx, 'retry-invariant-zero-delay')
      zeroDelay.append('llm/retry', {
        turn: 1, step: 1, retry: 1, maxRetries: 1, delayMs: 0, failure,
      })
    }).not.toThrow()
    expect(() => { ctx.emit('tools/change') }).not.toThrow()
  })

  it.each([
    [{ retry: 0, maxRetries: 2, delayMs: 1 }, /positive safe integer/],
    [{ retry: 1.5, maxRetries: 2, delayMs: 1 }, /positive safe integer/],
    [{ retry: 1, maxRetries: 0, delayMs: 1 }, /positive safe maxRetries/],
    [{ retry: 1, maxRetries: 1.5, delayMs: 1 }, /positive safe maxRetries/],
    [{ retry: 3, maxRetries: 2, delayMs: 1 }, /must not exceed/],
    [{ retry: 1, maxRetries: 2, delayMs: -1 }, /delayMs/],
    [{ retry: 1, maxRetries: 2, delayMs: MAX_TIMER_DELAY_MS + 1 }, /delayMs/],
  ])('rejects invalid retry bounds %#', async (data, message) => {
    const ctx = await setup()
    const session = closeStep(ctx, `retry-invariant-bounds-${data.retry}-${data.maxRetries}-${data.delayMs}`)
    expect(() => {
      session.append('llm/retry', { turn: 1, step: 1, ...data, failure })
    }).toThrow(message)
  })

  it('rejects retry records outside the matching closed-step boundary', async () => {
    const ctx = await setup()
    const absent = ctx.sessions.create(SessionId('retry-invariant-no-turn'))
    expect(() => {
      absent.append('llm/retry', {
        turn: 1, step: 1, retry: 1, maxRetries: 2, delayMs: 1, failure,
      })
    }).toThrow(/inside an open turn/)

    const wrongTurn = closeStep(ctx, 'retry-invariant-wrong-turn')
    expect(() => {
      wrongTurn.append('llm/retry', {
        turn: 2, step: 1, retry: 1, maxRetries: 2, delayMs: 1, failure,
      })
    }).toThrow(/open turn is 1/)

    const openStep = ctx.sessions.create(SessionId('retry-invariant-open-step'))
    openStep.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    openStep.append('step/start', { turn: 1, step: 1 })
    expect(() => {
      openStep.append('llm/retry', {
        turn: 1, step: 1, retry: 1, maxRetries: 2, delayMs: 1, failure,
      })
    }).toThrow(/step 1 is still open/)

    const noStep = ctx.sessions.create(SessionId('retry-invariant-no-step'))
    noStep.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    expect(() => {
      noStep.append('llm/retry', {
        turn: 1, step: 1, retry: 1, maxRetries: 2, delayMs: 1, failure,
      })
    }).toThrow(/latest closed step is undefined/)

    const wrongStep = closeStep(ctx, 'retry-invariant-wrong-step')
    expect(() => {
      wrongStep.append('llm/retry', {
        turn: 1, step: 2, retry: 1, maxRetries: 2, delayMs: 1, failure,
      })
    }).toThrow(/latest closed step is 1/)

    const closedTurn = closeStep(ctx, 'retry-invariant-closed-turn')
    closedTurn.append('turn/end', { turn: 1, reason: { kind: 'aborted' } })
    expect(() => {
      closedTurn.append('llm/retry', {
        turn: 1, step: 1, retry: 1, maxRetries: 2, delayMs: 1, failure,
      })
    }).toThrow(/inside an open turn/)
  })

  it('rejects duplicate and non-increasing retry records', async () => {
    const ctx = await setup()
    const duplicate = closeStep(ctx, 'retry-invariant-duplicate')
    duplicate.append('llm/retry', {
      turn: 1, step: 1, retry: 1, maxRetries: 3, delayMs: 1, failure,
    })
    expect(() => {
      duplicate.append('llm/retry', {
        turn: 1, step: 1, retry: 2, maxRetries: 3, delayMs: 1, failure,
      })
    }).toThrow(/duplicates the retry record/)

    const nonIncreasing = closeStep(ctx, 'retry-invariant-non-increasing')
    nonIncreasing.append('llm/retry', {
      turn: 1, step: 1, retry: 1, maxRetries: 3, delayMs: 1, failure,
    })
    nonIncreasing.append('step/start', { turn: 1, step: 2 })
    nonIncreasing.append('step/end', { turn: 1, step: 2 })
    expect(() => {
      nonIncreasing.append('llm/retry', {
        turn: 1, step: 2, retry: 1, maxRetries: 3, delayMs: 1, failure,
      })
    }).toThrow(/must increase/)
  })

  it('validates existing histories on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('retry-invariant-late'))
    session.append('step/end', { turn: 1, step: 1 })
    session.append('llm/retry', {
      turn: 1, step: 1, retry: 1, maxRetries: 2, delayMs: 1, failure,
    })
    await ctx.plugin(InvariantService)
    await expect(ctx.plugin(RetryInvariant)).rejects.toThrow(/inside an open turn/)
  })
})
