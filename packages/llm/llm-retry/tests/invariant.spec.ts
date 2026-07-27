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

const failure = { message: 'provider busy', code: 'RATE_LIMIT', status: 429 }

function closeStep(ctx: Context, id: string, turn = 1, step = 1) {
  const session = ctx.sessions.create(SessionId(id))
  session.append('turn/start', {
    turn,
    trigger: turn === 1
      ? { kind: 'message', source: { kind: 'user' } }
      : { kind: 'retry' },
  })
  session.append('step/start', { turn, step })
  session.append('step/end', { turn, step })
  return session
}

describe('llm-retry invariants', () => {
  it('accepts increasing retry schedules for successive failed turns', async () => {
    const ctx = await setup()
    const session = closeStep(ctx, 'retry-invariant-valid')
    expect(() => {
      session.append('llm/retry', {
        turn: 1, step: 1, retry: 1, maxRetries: 2, delayMs: 500, failure,
      })
      session.append('turn/end', { turn: 1, reason: { kind: 'error', step: 1, failure } })
      session.append('turn/start', { turn: 2, trigger: { kind: 'retry' } })
      session.append('step/start', { turn: 2, step: 1 })
      session.append('step/end', { turn: 2, step: 1 })
      session.append('llm/retry', {
        turn: 2, step: 1, retry: 2, maxRetries: 2, delayMs: 0, failure,
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

  it('rejects a retry record appended after its turn already closed', async () => {
    const ctx = await setup()
    const closed = closeStep(ctx, 'retry-invariant-closed-turn')
    closed.append('turn/end', { turn: 1, reason: { kind: 'error', step: 1, failure } })
    expect(() => {
      closed.append('llm/retry', {
        turn: 1, step: 1, retry: 1, maxRetries: 2, delayMs: 1, failure,
      })
    }).toThrow(/inside an open turn/)
  })

  it('starts a fresh chain when the turn before a retry trigger did not fail structurally', async () => {
    const ctx = await setup()
    const session = closeStep(ctx, 'retry-invariant-completed-predecessor')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2, trigger: { kind: 'retry' } })
    session.append('step/start', { turn: 2, step: 1 })
    session.append('step/end', { turn: 2, step: 1 })
    expect(() => {
      session.append('llm/retry', {
        turn: 2, step: 1, retry: 1, maxRetries: 2, delayMs: 1, failure,
      })
    }).not.toThrow()
  })

  it('walks the chain across non-boundary events and stops at an unmatched turn start', async () => {
    const ctx = await setup()
    // The failed predecessor's turn/start is outside this log prefix (e.g. a
    // truncated replay): the chain walk must stop rather than loop or throw.
    const session = ctx.sessions.create(SessionId('retry-invariant-unmatched-start'))
    session.append('turn/end', { turn: 1, reason: { kind: 'error', step: 1, failure } })
    // A durable non-boundary record between the turns exercises the walk over
    // non-turn/end events.
    session.append('todo/write', { todos: [] })
    session.append('turn/start', { turn: 2, trigger: { kind: 'retry' } })
    session.append('step/start', { turn: 2, step: 1 })
    session.append('step/end', { turn: 2, step: 1 })
    expect(() => {
      session.append('llm/retry', {
        turn: 2, step: 1, retry: 1, maxRetries: 2, delayMs: 1, failure,
      })
    }).not.toThrow()
  })

  it('requires an open turn and its latest closed step', async () => {
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

    const wrongStep = closeStep(ctx, 'retry-invariant-wrong-step')
    expect(() => {
      wrongStep.append('llm/retry', {
        turn: 1, step: 2, retry: 1, maxRetries: 2, delayMs: 1, failure,
      })
    }).toThrow(/latest closed step is 1/)
  })

  it('rejects duplicate and out-of-sequence retry schedules', async () => {
    const ctx = await setup()
    const duplicate = closeStep(ctx, 'retry-invariant-duplicate')
    duplicate.append('llm/retry', {
      turn: 1, step: 1, retry: 1, maxRetries: 3, delayMs: 1, failure,
    })
    expect(() => {
      duplicate.append('llm/retry', {
        turn: 1, step: 1, retry: 2, maxRetries: 3, delayMs: 1, failure,
      })
    }).toThrow(/duplicates/)

    const nonIncreasing = closeStep(ctx, 'retry-invariant-non-increasing')
    nonIncreasing.append('llm/retry', {
      turn: 1, step: 1, retry: 1, maxRetries: 3, delayMs: 1, failure,
    })
    nonIncreasing.append('turn/end', { turn: 1, reason: { kind: 'error', step: 1, failure } })
    nonIncreasing.append('turn/start', { turn: 2, trigger: { kind: 'retry' } })
    nonIncreasing.append('step/start', { turn: 2, step: 1 })
    nonIncreasing.append('step/end', { turn: 2, step: 1 })
    expect(() => {
      nonIncreasing.append('llm/retry', {
        turn: 2, step: 1, retry: 1, maxRetries: 3, delayMs: 1, failure,
      })
    }).toThrow(/retry-chain position 2/)
  })

  it('resets retry numbering after a completed chain', async () => {
    const ctx = await setup()
    const session = closeStep(ctx, 'retry-invariant-reset')
    session.append('llm/retry', {
      turn: 1, step: 1, retry: 1, maxRetries: 2, delayMs: 1, failure,
    })
    session.append('turn/end', { turn: 1, reason: { kind: 'error', step: 1, failure } })
    session.append('turn/start', { turn: 2, trigger: { kind: 'retry' } })
    session.append('step/start', { turn: 2, step: 1 })
    session.append('step/end', { turn: 2, step: 1 })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    session.append('turn/start', {
      turn: 3,
      trigger: { kind: 'message', source: { kind: 'user' } },
    })
    session.append('step/start', { turn: 3, step: 1 })
    session.append('step/end', { turn: 3, step: 1 })

    expect(() => {
      session.append('llm/retry', {
        turn: 3, step: 1, retry: 1, maxRetries: 2, delayMs: 1, failure,
      })
    }).not.toThrow()
  })

  it('validates existing histories on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('retry-invariant-late'))
    session.append('llm/retry', {
      turn: 1, step: 1, retry: 1, maxRetries: 2, delayMs: 1, failure,
    })
    await ctx.plugin(InvariantService)
    await expect(ctx.plugin(RetryInvariant)).rejects.toThrow(/inside an open turn/)
  })

  it('accepts a valid mixed pre-existing history on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('retry-invariant-late-valid'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('llm/retry', {
      turn: 1, step: 1, retry: 1, maxRetries: 2, delayMs: 1, failure,
    })
    await ctx.plugin(InvariantService)
    await expect(ctx.plugin(RetryInvariant)).resolves.toBeDefined()
  })
})
