import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { RpcId } from '@deepseek-ai/dsh-client-connection/client'
import type { PendingInteraction, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '../src/client/index.ts'

type QuestionInteraction = Extract<PendingInteraction, { kind: 'question' }>

function interaction(): QuestionInteraction {
  return {
    kind: 'question', rpcId: RpcId('question-1'),
    questions: [{ id: 'mode', question: 'Choose?', options: [{ label: 'Fast' }] }],
  }
}

/** Declare the conversation-owned composer slot the way production does: a
 *  parent entry's children table (register is the single declaration API). */
function declareComposerSlot(slots: SlotsService): void {
  slots.register({
    name: 'root',
    children: { 'conversation.composer': { kind: 'keyed', scope: 'session' } },
  } as never, (() => null) as never)
}

describe('ui-question browser plugin', () => {
  it('declares its services and fails loud without them', () => {
    expect(inject).toEqual(['slots', 'sessions'])
    expect(() => { apply(new Context()) }).toThrow(/slots and sessions services are required/)
  })

  it('registers scoped answer and cancel actions, including rejected receipts', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotsService).await()
    const answerQuestion = vi.fn()
      .mockResolvedValueOnce({ accepted: true })
      .mockResolvedValueOnce({ accepted: false, reason: 'not-pending' })
    const cancelQuestion = vi.fn()
      .mockResolvedValueOnce({ accepted: true })
      .mockResolvedValueOnce({ accepted: false, reason: 'bad-response' })
    ctx.provide('sessions', {
      manager: { get: vi.fn(() => ({ answerQuestion, cancelQuestion })) },
    })
    const slots = ctx.get('slots') as SlotsService
    declareComposerSlot(slots)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const entry = slots.entries('conversation.composer')[0] as unknown as {
      options: { key: string }
      inject(sessionId: SessionId): { actions: {
        answer: (item: QuestionInteraction, answer: { answers: { id: string; selected: string[] }[] }) => Promise<void>
        cancel: (item: QuestionInteraction) => Promise<void>
      } }
    }
    expect(entry.options.key).toBe('question')
    const actions = entry.inject('session-1' as SessionId).actions
    const item = interaction()
    const answer = { answers: [{ id: 'mode', selected: ['Fast'] }] }

    await expect(actions.answer(item, answer)).resolves.toBeUndefined()
    await expect(actions.answer(item, answer)).rejects.toThrow(/not-pending/)
    await expect(actions.cancel(item)).resolves.toBeUndefined()
    await expect(actions.cancel(item)).rejects.toThrow(/bad-response/)
    expect(answerQuestion).toHaveBeenCalledWith(item.rpcId, answer)
    expect(cancelQuestion).toHaveBeenCalledWith(item.rpcId)
    await ctx.fiber.dispose()
  })
})
