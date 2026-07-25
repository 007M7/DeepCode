/**
 * apply wiring on a real cordis Context + SlotsService: QuestionComposer
 * registered as the `question` entry of the conversation-declared composer
 * slot with ZERO business face (data and verbs ride the dispatched carrier),
 * load-order fail-loud, and fiber-teardown unregistration. Component and
 * domain-face behavior is covered props-direct in question-composer.spec.tsx;
 * no renderer machinery here.
 */
import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import { SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import { QuestionComposer } from '../src/client/QuestionComposer.tsx'
import { apply, inject } from '../src/client/index.ts'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotsService).await()
  const slots = ctx.get('slots') as SlotsService
  // The composer slot exists only while its declaring entry is live.
  slots.register(
    { name: 'root', children: { 'conversation.composer': { kind: 'chain', scope: 'session' } } } as never,
    () => null,
  )
  // 'conversation' inject is an ordering edge (the declaring plugin provides
  // it after declaring the chain); the bench declares the chain itself.
  ctx.provide('conversation', {})
  return { ctx, slots }
}

describe('apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'conversation'])
  })

  it('fails loud when no live entry has declared the composer slot', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotsService).await()
    // Satisfy the ordering inject without declaring the chain: apply must
    // then hit the undeclared-slot throw, not sit waiting on the service.
    ctx.provide('conversation', {})
    await expect(ctx.plugin({ inject: [...inject], apply }))
      .rejects.toThrow(/slot "conversation.composer" is not declared/)
  })

  it('registers the question entry: routing selector, no inject face', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    const entry = slots.entries('conversation.composer')[0]!
    expect(entry.component).toBe(QuestionComposer)
    // The whole behavior surface rides the matched carrier: no business face.
    expect(entry.inject).toBeUndefined()
    // The selector narrows the chain currency: question wait in → that wait; none → null.
    const select = entry.select as (owner: { interactions: readonly { kind: string }[] }) => unknown
    const question = { kind: 'question' }
    expect(select({ interactions: [{ kind: 'approval' }, question] })).toBe(question)
    expect(select({ interactions: [{ kind: 'approval' }] })).toBeNull()
    expect(select({ interactions: [] })).toBeNull()
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
