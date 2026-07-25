import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { ProviderRequestId } from '@deepseek-ai/dsh-llm'
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

const failure = { message: 'provider busy', code: 'RATE_LIMIT', status: 429 }
const normalPolicyKey = (maxRetries: number): string =>
  `["normal",${maxRetries},["RATE_LIMIT"],1,10000,0]`
const alwaysPolicyKey = '["always",1,10000,0]'
const normal = { provider: 'mock', mode: 'normal' as const, policyKey: normalPolicyKey(2) }

describe('llm-retry invariants', () => {
  it('has no provider without the requested closed step', () => {
    expect(providerForClosedStep([], 1, 1)).toBeUndefined()
    expect(providerForClosedStep([{
      type: 'step/end',
      data: { turn: 1, step: 1 },
    }] as never, 1, 1)).toBeUndefined()
  })

  it('inherits the latest provider across a turn boundary when the header is unchanged', () => {
    expect(providerForClosedStep([
      { type: 'turn/start', data: { turn: 1 } },
      {
        type: 'request/header',
        data: { header: { config: { provider: 'prior' } } },
      },
      { type: 'turn/end', data: { turn: 1 } },
      { type: 'turn/start', data: { turn: 2 } },
      { type: 'step/end', data: { turn: 2, step: 1 } },
    ] as never, 2, 1)).toBe('prior')
  })

  it('accepts increasing retry records for successive closed steps and ignores unrelated events', async () => {
    const ctx = await setup()
    const session = closeStep(ctx, 'retry-invariant-valid')
    expect(() => {
      session.append('llm/retry', {
        turn: 1, step: 1, ...normal, retry: 1, maxRetries: 2, delayMs: 500, failure,
      })
      session.append('step/start', { turn: 1, step: 2 })
      session.append('step/end', { turn: 1, step: 2 })
      session.append('llm/retry', {
        turn: 1, step: 2, ...normal, retry: 2, maxRetries: 2, delayMs: 1_000, failure,
      })
      const zeroDelay = closeStep(ctx, 'retry-invariant-zero-delay')
      zeroDelay.append('llm/retry', {
        turn: 1, step: 1, ...normal, policyKey: normalPolicyKey(1),
        retry: 1, maxRetries: 1, delayMs: 0, failure,
      })
    }).not.toThrow()
    expect(() => { ctx.emit('tools/change') }).not.toThrow()
  })

  it('accepts unbounded always records without serializing an infinite maximum', async () => {
    const ctx = await setup()
    const session = closeStep(ctx, 'retry-invariant-always')
    expect(() => {
      session.append('llm/retry', {
        turn: 1,
        step: 1,
        provider: 'mock',
        mode: 'always',
        policyKey: alwaysPolicyKey,
        retry: 1,
        delayMs: 500,
        failure,
      })
    }).not.toThrow()
    expect(() => {
      session.append('llm/retry', {
        turn: 1,
        step: 1,
        provider: 'mock',
        mode: 'always',
        policyKey: alwaysPolicyKey,
        retry: 1,
        maxRetries: 2,
        delayMs: 500,
        failure,
      } as never)
    }).toThrow(/always mode must omit maxRetries/)
  })

  it('validates complete durable failures before either retry mode uses them', async () => {
    const ctx = await setup()
    const complete = closeStep(ctx, 'retry-invariant-complete-failure')
    expect(() => {
      complete.append('llm/retry', {
        turn: 1,
        step: 1,
        provider: 'mock',
        mode: 'always',
        policyKey: alwaysPolicyKey,
        retry: 1,
        delayMs: 1,
        failure: {
          message: 'provider busy',
          code: 'RATE_LIMIT',
          status: 429,
          providerRetryAfterMs: 25,
          requestId: ProviderRequestId('request-1'),
        },
      })
    }).not.toThrow()

    const normalNull = closeStep(ctx, 'retry-invariant-normal-null-failure')
    expect(() => {
      normalNull.append('llm/retry', {
        turn: 1, step: 1, ...normal,
        retry: 1, maxRetries: 2, delayMs: 1, failure: null,
      } as never)
    }).toThrow(/failure must be an object/)

    const invalidFailures: readonly [string, unknown, RegExp][] = [
      ['always-null', null, /failure must be an object/],
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
      const session = closeStep(ctx, `retry-invariant-${name}`)
      expect(() => {
        session.append('llm/retry', {
          turn: 1,
          step: 1,
          provider: 'mock',
          mode: 'always',
          policyKey: alwaysPolicyKey,
          retry: 1,
          delayMs: 1,
          failure: invalidFailure,
        } as never)
      }).toThrow(message)
    }
  })

  it('binds event mode and finite budget to the canonical policy key', async () => {
    const ctx = await setup()
    const normalModeMismatch = closeStep(ctx, 'retry-invariant-normal-mode-key')
    expect(() => {
      normalModeMismatch.append('llm/retry', {
        turn: 1, step: 1, ...normal, policyKey: alwaysPolicyKey,
        retry: 1, maxRetries: 2, delayMs: 1, failure,
      })
    }).toThrow(/mode normal must match policyKey mode always/)

    const alwaysModeMismatch = closeStep(ctx, 'retry-invariant-always-mode-key')
    expect(() => {
      alwaysModeMismatch.append('llm/retry', {
        turn: 1,
        step: 1,
        provider: 'mock',
        mode: 'always',
        policyKey: normalPolicyKey(2),
        retry: 1,
        delayMs: 1,
        failure,
      })
    }).toThrow(/mode always must match policyKey mode normal/)

    const budgetMismatch = closeStep(ctx, 'retry-invariant-budget-key')
    expect(() => {
      budgetMismatch.append('llm/retry', {
        turn: 1, step: 1, ...normal, policyKey: normalPolicyKey(3),
        retry: 1, maxRetries: 2, delayMs: 1, failure,
      })
    }).toThrow(/maxRetries 2 must match policyKey/)
  })

  it('binds the failure code and scheduled delay to the canonical policy key', async () => {
    const ctx = await setup()
    const ineligibleFailure = closeStep(ctx, 'retry-invariant-failure-code-key')
    expect(() => {
      ineligibleFailure.append('llm/retry', {
        turn: 1, step: 1, ...normal,
        retry: 1, maxRetries: 2, delayMs: 1,
        failure: { message: 'authentication failed', code: 'AUTH', status: 401 },
      })
    }).toThrow(/failure code AUTH must be eligible under policyKey/)

    const overPolicyDelay = closeStep(ctx, 'retry-invariant-delay-key')
    expect(() => {
      overPolicyDelay.append('llm/retry', {
        turn: 1,
        step: 1,
        provider: 'mock',
        mode: 'always',
        policyKey: '["always",1,1,0]',
        retry: 1,
        delayMs: 2,
        failure,
      })
    }).toThrow(/within policyKey range 0\.\.1/)
  })

  it('rejects empty providers and unknown modes from hostile durable input', async () => {
    const ctx = await setup()
    const emptyProvider = closeStep(ctx, 'retry-invariant-empty-provider')
    expect(() => {
      emptyProvider.append('llm/retry', {
        turn: 1,
        step: 1,
        provider: '',
        mode: 'always',
        policyKey: alwaysPolicyKey,
        retry: 1,
        delayMs: 1,
        failure,
      })
    }).toThrow(/provider must be non-empty/)

    const unknownMode = closeStep(ctx, 'retry-invariant-unknown-mode')
    expect(() => {
      unknownMode.append('llm/retry', {
        turn: 1,
        step: 1,
        provider: 'mock',
        mode: 'sometimes',
        policyKey: alwaysPolicyKey,
        retry: 1,
        delayMs: 1,
        failure,
      } as never)
    }).toThrow(/mode must be normal or always/)

    const emptyPolicyKey = closeStep(ctx, 'retry-invariant-empty-policy-key')
    expect(() => {
      emptyPolicyKey.append('llm/retry', {
        turn: 1,
        step: 1,
        provider: 'mock',
        mode: 'always',
        policyKey: '',
        retry: 1,
        delayMs: 1,
        failure,
      })
    }).toThrow(/policyKey must encode a canonical resolved policy/)
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
      session.append('llm/retry', { turn: 1, step: 1, ...normal, ...data, failure })
    }).toThrow(message)
  })

  it('rejects retry records outside the matching closed-step boundary', async () => {
    const ctx = await setup()
    const absent = ctx.sessions.create(SessionId('retry-invariant-no-turn'))
    expect(() => {
      absent.append('llm/retry', {
        turn: 1, step: 1, ...normal, retry: 1, maxRetries: 2, delayMs: 1, failure,
      })
    }).toThrow(/inside an open turn/)

    const wrongTurn = closeStep(ctx, 'retry-invariant-wrong-turn')
    expect(() => {
      wrongTurn.append('llm/retry', {
        turn: 2, step: 1, ...normal, retry: 1, maxRetries: 2, delayMs: 1, failure,
      })
    }).toThrow(/open turn is 1/)

    const openStep = ctx.sessions.create(SessionId('retry-invariant-open-step'))
    openStep.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    openStep.append('step/start', { turn: 1, step: 1 })
    expect(() => {
      openStep.append('llm/retry', {
        turn: 1, step: 1, ...normal, retry: 1, maxRetries: 2, delayMs: 1, failure,
      })
    }).toThrow(/step 1 is still open/)

    const noStep = ctx.sessions.create(SessionId('retry-invariant-no-step'))
    noStep.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    expect(() => {
      noStep.append('llm/retry', {
        turn: 1, step: 1, ...normal, retry: 1, maxRetries: 2, delayMs: 1, failure,
      })
    }).toThrow(/latest closed step is undefined/)

    const wrongStep = closeStep(ctx, 'retry-invariant-wrong-step')
    expect(() => {
      wrongStep.append('llm/retry', {
        turn: 1, step: 2, ...normal, retry: 1, maxRetries: 2, delayMs: 1, failure,
      })
    }).toThrow(/latest closed step is 1/)

    const closedTurn = closeStep(ctx, 'retry-invariant-closed-turn')
    closedTurn.append('turn/end', { turn: 1, reason: { kind: 'aborted' } })
    expect(() => {
      closedTurn.append('llm/retry', {
        turn: 1, step: 1, ...normal, retry: 1, maxRetries: 2, delayMs: 1, failure,
      })
    }).toThrow(/inside an open turn/)
  })

  it('binds the policy provider to the failed step rather than a later header', async () => {
    const ctx = await setup()
    const session = closeStep(ctx, 'retry-invariant-provider')
    session.append('request/header', {
      header: { config: { provider: 'other', model: 'mock' } },
      reason: 'change',
    })
    expect(() => {
      session.append('llm/retry', {
        turn: 1,
        step: 1,
        provider: 'mock',
        mode: 'always',
        policyKey: alwaysPolicyKey,
        retry: 1,
        delayMs: 1,
        failure,
      })
    }).not.toThrow()

    const mismatch = closeStep(ctx, 'retry-invariant-provider-mismatch')
    expect(() => {
      mismatch.append('llm/retry', {
        turn: 1,
        step: 1,
        provider: 'other',
        mode: 'always',
        policyKey: alwaysPolicyKey,
        retry: 1,
        delayMs: 1,
        failure,
      })
    }).toThrow(/does not match the failed request provider mock/)
  })

  it('accepts a current-turn retry under an unchanged prior provider route', async () => {
    const ctx = await setup()
    const session = closeStep(ctx, 'retry-invariant-prior-route')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 2, step: 1 })
    session.append('step/end', { turn: 2, step: 1 })
    expect(() => {
      session.append('llm/retry', {
        turn: 2,
        step: 1,
        provider: 'mock',
        mode: 'always',
        policyKey: alwaysPolicyKey,
        retry: 1,
        delayMs: 1,
        failure,
      })
    }).not.toThrow()
  })

  it('rejects non-numeric durable delays', async () => {
    const ctx = await setup()
    const session = closeStep(ctx, 'retry-invariant-delay-type')
    expect(() => {
      session.append('llm/retry', {
        turn: 1, step: 1, ...normal, retry: 1, maxRetries: 2, delayMs: '1', failure,
      } as never)
    }).toThrow(/delayMs must be a finite number/)
  })

  it('rejects duplicate and non-increasing retry records', async () => {
    const ctx = await setup()
    const duplicate = closeStep(ctx, 'retry-invariant-duplicate')
    duplicate.append('llm/retry', {
      turn: 1, step: 1, ...normal, policyKey: normalPolicyKey(3),
      retry: 1, maxRetries: 3, delayMs: 1, failure,
    })
    expect(() => {
      duplicate.append('llm/retry', {
        turn: 1, step: 1, ...normal, policyKey: normalPolicyKey(3),
        retry: 2, maxRetries: 3, delayMs: 1, failure,
      })
    }).toThrow(/duplicates the retry record/)

    const nonIncreasing = closeStep(ctx, 'retry-invariant-non-increasing')
    nonIncreasing.append('llm/retry', {
      turn: 1, step: 1, ...normal, policyKey: normalPolicyKey(3),
      retry: 1, maxRetries: 3, delayMs: 1, failure,
    })
    nonIncreasing.append('step/start', { turn: 1, step: 2 })
    nonIncreasing.append('step/end', { turn: 1, step: 2 })
    expect(() => {
      nonIncreasing.append('llm/retry', {
        turn: 1, step: 2, ...normal, policyKey: normalPolicyKey(3),
        retry: 1, maxRetries: 3, delayMs: 1, failure,
      })
    }).toThrow(/must equal provider policy retry 2/)
  })

  it('validates existing histories on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('retry-invariant-late'))
    session.append('step/end', { turn: 1, step: 1 })
    session.append('llm/retry', {
      turn: 1, step: 1, ...normal, retry: 1, maxRetries: 2, delayMs: 1, failure,
    })
    await ctx.plugin(InvariantService)
    await expect(ctx.plugin(RetryInvariant)).rejects.toThrow(/inside an open turn/)
  })
})
