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
})
