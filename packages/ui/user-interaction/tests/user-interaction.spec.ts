import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import UserInteractionService, {
  UserInteractionError,
  type AskUserQuestionRequest,
  type UserInteractionProvider,
} from '@deepseek-ai/dsh-user-interaction'

function provider(answer = 'approved'): UserInteractionProvider & { seen: AskUserQuestionRequest[] } {
  const seen: AskUserQuestionRequest[] = []
  return {
    seen,
    async ask(request) {
      seen.push(request)
      return { answers: [{ id: request.questions[0]?.id ?? 'missing', selected: [answer] }] }
    },
  }
}

describe('UserInteractionService', () => {
  it('delegates ask requests to the registered provider', async () => {
    const ctx = new Context()
    await ctx.plugin(UserInteractionService)
    const p = provider('yes')
    ctx.userInteraction.registerProvider(p)

    const result = await ctx.userInteraction.ask({ questions: [{ id: 'confirm', question: 'Proceed?' }] })

    expect(result).toEqual({ answers: [{ id: 'confirm', selected: ['yes'] }] })
    expect(p.seen).toEqual([{ questions: [{ id: 'confirm', question: 'Proceed?' }] }])
  })

  it('rejects ask requests when no provider is registered', async () => {
    const ctx = new Context()
    await ctx.plugin(UserInteractionService)

    await expect(ctx.userInteraction.ask({ questions: [{ id: 'confirm', question: 'Proceed?' }] }))
      .rejects.toMatchObject({ name: 'UserInteractionError', code: 'NO_PROVIDER' })
  })

  it('registers providers with HMR-safe disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(UserInteractionService)
    const p = provider()
    const dispose = ctx.userInteraction.registerProvider(p)

    dispose()
    dispose()

    await expect(ctx.userInteraction.ask({ questions: [{ id: 'confirm', question: 'Proceed?' }] }))
      .rejects.toMatchObject({ code: 'NO_PROVIDER' })
  })

  it('rejects duplicate providers instead of replacing the active UI', async () => {
    const ctx = new Context()
    await ctx.plugin(UserInteractionService)
    ctx.userInteraction.registerProvider(provider('first'))

    expect(() => ctx.userInteraction.registerProvider(provider('second')))
      .toThrow(UserInteractionError)
  })

  it('fails before reaching the provider when the signal is already aborted', async () => {
    const ctx = new Context()
    await ctx.plugin(UserInteractionService)
    const p = { ask: vi.fn(async () => ({ answers: [{ id: 'confirm', selected: ['too late'] }] })) }
    ctx.userInteraction.registerProvider(p)
    const controller = new AbortController()
    controller.abort()

    await expect(ctx.userInteraction.ask({ questions: [{ id: 'confirm', question: 'Proceed?' }], signal: controller.signal }))
      .rejects.toMatchObject({ code: 'ASK_ABORTED' })
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('rejects empty question batches before reaching the provider', async () => {
    const ctx = new Context()
    await ctx.plugin(UserInteractionService)
    const p = { ask: vi.fn(async () => ({ answers: [] })) }
    ctx.userInteraction.registerProvider(p)

    await expect(ctx.userInteraction.ask({ questions: [] }))
      .rejects.toMatchObject({ name: 'UserInteractionError', code: 'EMPTY_QUESTIONS' })
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('rejects an intent whose approve label names none of its own options', async () => {
    const ctx = new Context()
    await ctx.plugin(UserInteractionService)
    const p = { ask: vi.fn(async () => ({ answers: [] })) }
    ctx.userInteraction.registerProvider(p)
    const question = { id: 'plan-review', question: 'Approve?', detail: '# Plan' }

    // A wrong label among offered options, and no options offered at all.
    for (const options of [[{ label: 'Approve' }], undefined]) {
      await expect(ctx.userInteraction.ask({
        questions: [{
          ...question,
          ...(options === undefined ? {} : { options }),
          intent: { kind: 'plan-review', approve: 'Ship it' },
        }],
      })).rejects.toMatchObject({ name: 'UserInteractionError', code: 'BAD_INTENT' })
    }
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('rejects a plan-review intent on a question carrying no plan to review', async () => {
    const ctx = new Context()
    await ctx.plugin(UserInteractionService)
    const p = { ask: vi.fn(async () => ({ answers: [] })) }
    ctx.userInteraction.registerProvider(p)

    // Detail IS the plan for this intent, so a UI honouring it would ask the
    // user to approve something they cannot see.
    await expect(ctx.userInteraction.ask({
      questions: [{
        id: 'plan-review', question: 'Approve?',
        options: [{ label: 'Approve' }, { label: 'Keep planning' }],
        intent: { kind: 'plan-review', approve: 'Approve' },
      }],
    })).rejects.toMatchObject({ name: 'UserInteractionError', code: 'BAD_INTENT' })
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('passes an intent through once its approve label names an offered option', async () => {
    const ctx = new Context()
    await ctx.plugin(UserInteractionService)
    const p = provider('Approve')
    ctx.userInteraction.registerProvider(p)
    const intent = { kind: 'plan-review', approve: 'Approve' } as const

    const result = await ctx.userInteraction.ask({
      questions: [
        { id: 'plain', question: 'Proceed?' },
        {
          id: 'plan-review', question: 'Approve?', detail: '# Plan',
          options: [{ label: 'Approve' }, { label: 'Keep planning' }], intent,
        },
      ],
    })

    expect(result.answers).toEqual([{ id: 'plain', selected: ['Approve'] }])
    expect(p.seen[0]?.questions[1]?.intent).toEqual(intent)
  })
})
