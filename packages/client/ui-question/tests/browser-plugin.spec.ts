/**
 * apply wiring on a real cordis Context + SlotsService (terminal register
 * form): QuestionComposer registered as the `question` entry of the
 * conversation-declared keyed composer slot, the thin inject surface (two
 * receipt-checked session callbacks closed over the plugin ctx — no hooks, no
 * store lines), load-order fail-loud, and fiber-teardown unregistration.
 * Component behavior is covered props-direct in question-composer.spec.tsx;
 * no renderer machinery here.
 */
import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { RpcId } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import type { QuestionComposerInjected, QuestionInteraction } from '../src/client/contract/slots.ts'
import { apply, inject } from '../src/client/index.ts'

function interaction(): QuestionInteraction {
  return {
    kind: 'question', rpcId: RpcId('question-1'),
    questions: [{ id: 'mode', question: 'Choose?', options: [{ label: 'Fast' }] }],
  }
}

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotsService).await()
  const answerQuestion = vi.fn()
    .mockResolvedValueOnce({ accepted: true })
    .mockResolvedValueOnce({ accepted: false, reason: 'not-pending' })
  const cancelQuestion = vi.fn()
    .mockResolvedValueOnce({ accepted: true })
    .mockResolvedValueOnce({ accepted: false, reason: 'bad-response' })
  const get = vi.fn(() => ({ answerQuestion, cancelQuestion }))
  ctx.provide('sessions', { manager: { get } })
  const slots = ctx.get('slots') as SlotsService
  // Stand-in for ui-conversation's conversation entry: the composer slot only
  // exists while a live entry declares it in children (declaration account:
  // design §2.2).
  slots.register(
    { name: 'root', children: { 'conversation.composer': { kind: 'keyed', scope: 'session' } } } as never,
    () => null,
  )
  return { ctx, slots, get, answerQuestion, cancelQuestion }
}

/** The question entry's injected share, resolved for one session id. */
function injectedOf(slots: SlotsService, sessionId: SessionId): QuestionComposerInjected {
  const entries = slots.entries('conversation.composer')
  expect(entries).toHaveLength(1)
  // The typed StoredEntry.inject is declaration-derived ((...args: never[])
  // shape); the question factory takes the framework-resolved sessionId.
  const inject = entries[0]!.inject as ((id: SessionId) => QuestionComposerInjected) | undefined
  return inject!(sessionId)
}

describe('apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'sessions'])
  })

  it('fails loud when its services are missing', () => {
    // apply resolves both services through the strict need() reader (the
    // program's host-side Context merge shadows typed property access).
    expect(() => { apply(new Context()) }).toThrow(/slots service unavailable/)
  })

  it('fails loud when no live entry has declared the composer slot', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotsService).await()
    ctx.provide('sessions', {})
    await expect(ctx.plugin({ inject: [...inject], apply }))
      .rejects.toThrow(/slot "conversation.composer" is not declared/)
  })

  it('registers the question entry with the thin two-callback inject surface', async () => {
    const { ctx, slots, get } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    expect(slots.entries('conversation.composer')[0]!.options.key).toBe('question')
    const injected = injectedOf(slots, 'session-1' as SessionId)
    // The whole business face: two plain callbacks, no hooks, no store lines.
    expect(Object.keys(injected).sort()).toEqual(['answer', 'cancel'])
    expect(get).toHaveBeenCalledWith('session-1')
  })

  it('routes answer/cancel through the session and surfaces rejected receipts', async () => {
    const { ctx, slots, answerQuestion, cancelQuestion } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    const { answer, cancel } = injectedOf(slots, 'session-1' as SessionId)
    const item = interaction()
    const batch = { answers: [{ id: 'mode', selected: ['Fast'] }] }

    await expect(answer(item, batch)).resolves.toBeUndefined()
    await expect(answer(item, batch)).rejects.toThrow(/not-pending/)
    await expect(cancel(item)).resolves.toBeUndefined()
    await expect(cancel(item)).rejects.toThrow(/bad-response/)
    expect(answerQuestion).toHaveBeenCalledWith(item.rpcId, batch)
    expect(cancelQuestion).toHaveBeenCalledWith(item.rpcId)
  })

  it('teardown unregisters the slot entry', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('conversation.composer')).toHaveLength(1)
    await fiber.dispose()
    expect(slots.entries('conversation.composer')).toHaveLength(0)
  })
})
