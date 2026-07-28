import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { createUserMessage, ProviderRequestId , createMessage } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import InvariantService from '@deepseek-ai/dsh-invariants'
import * as RetryInvariant from '@deepseek-ai/dsh-llm-retry/invariant'
import { providerForClosedStep } from '../src/history.ts'

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
  session.append('request/header', {
    header: { config: { provider: 'mock', model: 'mock' } },
    reason: 'initial',
  })
  session.append('step/end', { turn, step })
  return session
}

function appendRetryTurn(session: Session, turn: number) {
  session.append('turn/start', { turn, trigger: { kind: 'retry' } })
  session.append('step/start', { turn, step: 1 })
  session.append('request/header', {
    header: { config: { provider: 'mock', model: 'mock' } },
    reason: 'initial',
  })
  session.append('step/end', { turn, step: 1 })
  session.append('llm/retry', { turn, step: 1, ...normal })
}

const failure = { message: 'provider busy', code: 'RATE_LIMIT', status: 429 }
const normal = {
  provider: 'mock',
  mode: 'normal' as const,
  policyKey: 'normal-policy',
  retry: 1,
  maxRetries: 2,
  delayMs: 1,
  failure,
}
const always = {
  provider: 'mock',
  mode: 'always' as const,
  policyKey: 'always-policy',
  retry: 1,
  delayMs: 1,
  failure,
}

describe('llm-retry invariants', () => {
  it('has no provider without the requested closed step or a route marker', () => {
    expect(providerForClosedStep([], 1, 1)).toBeUndefined()
    expect(providerForClosedStep([{
      type: 'step/end',
      data: { turn: 1, step: 1 },
    }] as never, 1, 1)).toBeUndefined()
  })

  it('accepts bounded and unbounded records after successive closed steps', async () => {
    const ctx = await setup()
    const session = closeStep(ctx, 'retry-invariant-valid')

    expect(() => {
      session.append('llm/retry', { turn: 1, step: 1, ...normal })
      session.append('turn/end', { turn: 1, reason: { kind: 'error', step: 1, failure } })
      session.append('turn/start', { turn: 2, trigger: { kind: 'retry' } })
      session.append('step/start', { turn: 2, step: 1 })
      session.append('step/end', { turn: 2, step: 1 })
      session.append('llm/retry', {
        turn: 2, step: 1, ...normal, retry: 2, delayMs: 0,
      })
      const unbounded = closeStep(ctx, 'retry-invariant-always')
      unbounded.append('llm/retry', { turn: 1, step: 1, ...always })
    }).not.toThrow()
    expect(() => { ctx.emit('tools/change') }).not.toThrow()
  })

  it('validates the complete durable failure payload', async () => {
    const ctx = await setup()
    const complete = closeStep(ctx, 'retry-invariant-complete-failure')
    expect(() => {
      complete.append('llm/retry', {
        turn: 1,
        step: 1,
        ...always,
        failure: {
          message: 'provider busy',
          code: 'RATE_LIMIT',
          status: 429,
          providerRetryAfterMs: 25,
          requestId: ProviderRequestId('request-1'),
        },
      })
    }).not.toThrow()

    const invalidFailures: readonly [string, unknown, RegExp][] = [
      ['null', null, /failure must be an object/],
      ['message-type', { message: 1, code: 'RATE_LIMIT' }, /failure\.message/],
      ['message-empty', { message: '', code: 'RATE_LIMIT' }, /failure\.message/],
      ['code-type', { message: 'failed', code: 1 }, /failure\.code/],
      ['code-empty', { message: 'failed', code: '' }, /failure\.code/],
      ['status-type', { message: 'failed', code: 'RATE_LIMIT', status: 429.5 }, /failure\.status/],
      ['status-low', { message: 'failed', code: 'RATE_LIMIT', status: 99 }, /failure\.status/],
      ['status-high', { message: 'failed', code: 'RATE_LIMIT', status: 600 }, /failure\.status/],
      [
        'retry-after-type',
        { message: 'failed', code: 'RATE_LIMIT', providerRetryAfterMs: '25' },
        /failure\.providerRetryAfterMs/,
      ],
      [
        'retry-after-zero',
        { message: 'failed', code: 'RATE_LIMIT', providerRetryAfterMs: 0 },
        /failure\.providerRetryAfterMs/,
      ],
      ['request-id-type', { message: 'failed', code: 'RATE_LIMIT', requestId: 1 }, /failure\.requestId/],
      ['request-id-empty', { message: 'failed', code: 'RATE_LIMIT', requestId: '' }, /failure\.requestId/],
    ]
    for (const [name, invalidFailure, message] of invalidFailures) {
      const session = closeStep(ctx, `retry-invariant-failure-${name}`)
      expect(() => {
        session.append('llm/retry', {
          turn: 1, step: 1, ...always, failure: invalidFailure,
        } as never)
      }).toThrow(message)
    }
  })

  it.each([
    ['retry-zero', { ...normal, retry: 0 }, /positive safe integer/],
    ['retry-fraction', { ...normal, retry: 1.5 }, /positive safe integer/],
    ['max-zero', { ...normal, maxRetries: 0 }, /positive safe maxRetries/],
    ['max-fraction', { ...normal, maxRetries: 1.5 }, /positive safe maxRetries/],
    ['over-budget', { ...normal, retry: 3 }, /must not exceed/],
    ['always-maximum', { ...always, maxRetries: 2 }, /always mode must omit maxRetries/],
    ['unknown-mode', { ...always, mode: 'sometimes' }, /mode must be normal or always/],
    ['empty-provider', { ...always, provider: '' }, /provider must be a non-empty string/],
    ['empty-policy-key', { ...always, policyKey: '' }, /policyKey must be a non-empty string/],
    ['delay-negative', { ...normal, delayMs: -1 }, /delayMs/],
    ['delay-overflow', { ...normal, delayMs: MAX_TIMER_DELAY_MS + 1 }, /delayMs/],
    ['delay-type', { ...normal, delayMs: '1' }, /delayMs/],
  ])('rejects invalid retry data: %s', async (name, data, message) => {
    const ctx = await setup()
    const session = closeStep(ctx, `retry-invariant-${name}`)
    expect(() => {
      session.append('llm/retry', { turn: 1, step: 1, ...data } as never)
    }).toThrow(message)
  })

  it('rejects records outside the latest closed step of an open turn', async () => {
    const ctx = await setup()
    const absent = ctx.sessions.create(SessionId('retry-invariant-no-turn'))
    expect(() => {
      absent.append('llm/retry', { turn: 1, step: 1, ...normal })
    }).toThrow(/inside an open turn/)

    const wrongTurn = closeStep(ctx, 'retry-invariant-wrong-turn')
    expect(() => {
      wrongTurn.append('llm/retry', { turn: 2, step: 1, ...normal })
    }).toThrow(/open turn is 1/)

    const openStep = ctx.sessions.create(SessionId('retry-invariant-open-step'))
    openStep.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    openStep.append('step/start', { turn: 1, step: 1 })
    expect(() => {
      openStep.append('llm/retry', { turn: 1, step: 1, ...normal })
    }).toThrow(/step 1 is still open/)

    const noStep = ctx.sessions.create(SessionId('retry-invariant-no-step'))
    noStep.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    expect(() => {
      noStep.append('llm/retry', { turn: 1, step: 1, ...normal })
    }).toThrow(/latest closed step is undefined/)

    const wrongStep = closeStep(ctx, 'retry-invariant-wrong-step')
    expect(() => {
      wrongStep.append('llm/retry', { turn: 1, step: 2, ...normal })
    }).toThrow(/latest closed step is 1/)

    const closedTurn = closeStep(ctx, 'retry-invariant-closed-turn')
    closedTurn.append('turn/end', { turn: 1, reason: { kind: 'aborted' } })
    expect(() => {
      closedTurn.append('llm/retry', { turn: 1, step: 1, ...normal })
    }).toThrow(/inside an open turn/)
  })

  it('rejects a second retry record for the same step', async () => {
    const ctx = await setup()
    const session = closeStep(ctx, 'retry-invariant-duplicate')
    session.append('llm/retry', { turn: 1, step: 1, ...normal })

    expect(() => {
      session.append('llm/retry', { turn: 1, step: 1, ...normal, retry: 2 })
    }).toThrow(/duplicates the retry record/)
  })

  it('binds retry numbering to the provider policy and resets it after success', async () => {
    const ctx = await setup()
    const mismatch = closeStep(ctx, 'retry-invariant-numbering')
    mismatch.append('llm/retry', { turn: 1, step: 1, ...normal })
    mismatch.append('turn/end', { turn: 1, reason: { kind: 'error', step: 1, failure } })
    mismatch.append('turn/start', { turn: 2, trigger: { kind: 'retry' } })
    mismatch.append('step/start', { turn: 2, step: 1 })
    mismatch.append('step/end', { turn: 2, step: 1 })
    expect(() => {
      mismatch.append('llm/retry', { turn: 2, step: 1, ...normal, retry: 1 })
    }).toThrow(/must equal provider policy retry 2/)

    const reset = closeStep(ctx, 'retry-invariant-reset')
    reset.append('llm/retry', { turn: 1, step: 1, ...normal })
    reset.append('turn/end', { turn: 1, reason: { kind: 'error', step: 1, failure } })
    reset.append('turn/start', { turn: 2, trigger: { kind: 'retry' } })
    reset.append('step/start', { turn: 2, step: 1 })
    reset.append('assistant/message', {
      turn: 2,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'success' }],
        source: {
          kind: 'model',
          ...{ provider: 'mock', model: 'mock' },
        },
      }),
    }, { surfaceOp: 'append' })
    reset.append('step/end', { turn: 2, step: 1 })
    reset.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    reset.append('turn/start', { turn: 3, trigger: { kind: 'message', source: { kind: 'user' } } })
    reset.append('step/start', { turn: 3, step: 1 })
    reset.append('step/end', { turn: 3, step: 1 })
    expect(() => {
      reset.append('llm/retry', { turn: 3, step: 1, ...normal })
    }).not.toThrow()
  })

  it('starts a fresh retry chain after incomplete predecessor boundaries', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)

    const missingEnd = ctx.sessions.create(SessionId('retry-invariant-missing-end'))
    missingEnd.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'idle context' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    appendRetryTurn(missingEnd, 2)

    const nonFailureEnd = ctx.sessions.create(SessionId('retry-invariant-non-failure-end'))
    nonFailureEnd.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    nonFailureEnd.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'idle context' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    appendRetryTurn(nonFailureEnd, 2)

    const missingStart = ctx.sessions.create(SessionId('retry-invariant-missing-start'))
    missingStart.append('turn/end', {
      turn: 1,
      reason: { kind: 'error', step: 1, failure },
    })
    appendRetryTurn(missingStart, 2)

    await ctx.plugin(InvariantService)
    await expect(ctx.plugin(RetryInvariant)).resolves.toBeDefined()
  })

  it('rejects a provider that does not match the failed request route', async () => {
    const ctx = await setup()
    const session = closeStep(ctx, 'retry-invariant-provider')
    expect(() => {
      session.append('llm/retry', { turn: 1, step: 1, ...always, provider: 'other' })
    }).toThrow(/does not match the failed request provider mock/)
  })

  it('validates existing histories on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('retry-invariant-late'))
    session.append('step/end', { turn: 1, step: 1 })
    session.append('llm/retry', { turn: 1, step: 1, ...normal })
    await ctx.plugin(InvariantService)
    await expect(ctx.plugin(RetryInvariant)).rejects.toThrow(/inside an open turn/)
  })
})
