/**
 * apply wiring on a real cordis Context + SlotsService + LocaleService:
 * QuestionComposer registered as the `question` entry of the
 * conversation-declared composer slot, bilingual dictionaries registered
 * under the `question` namespace, the locale share handed through the inject
 * face, load-order fail-loud, and fiber-teardown unregistration. Component
 * and domain-face behavior is covered props-direct in
 * question-composer.spec.tsx; no renderer machinery here.
 */
import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleService } from '@deepseek-ai/dsh-client-locale/client'
import type { QuestionComposerInjected } from '../src/client/contract/slots.ts'
import { QuestionComposer } from '../src/client/QuestionComposer.tsx'
import { apply, inject, QUESTION_NS } from '../src/client/index.ts'

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
  const locale = new LocaleService(ctx)
  ctx.provide('locale', locale)
  return { ctx, slots, locale }
}

describe('apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'conversation', 'locale'])
  })

  it('fails loud when no live entry has declared the composer slot', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotsService).await()
    // Satisfy the ordering inject without declaring the chain: apply must
    // then hit the undeclared-slot throw, not sit waiting on the service.
    ctx.provide('conversation', {})
    ctx.provide('locale', new LocaleService(ctx))
    await expect(ctx.plugin({ inject: [...inject], apply }))
      .rejects.toThrow(/slot "conversation.composer" is not declared/)
  })

  it('registers the question entry: routing selector plus the locale share face', async () => {
    const { ctx, slots, locale } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    const entry = slots.entries('conversation.composer')[0]!
    expect(entry.component).toBe(QuestionComposer)
    // The selector narrows the chain currency: question wait in → that wait; none → null.
    const select = entry.select as (owner: { interactions: readonly { kind: string }[] }) => unknown
    const question = { kind: 'question' }
    expect(select({ interactions: [{ kind: 'approval' }, question] })).toBe(question)
    expect(select({ interactions: [{ kind: 'approval' }] })).toBeNull()
    expect(select({ interactions: [] })).toBeNull()
    // The inject face carries the namespace-bound translator and the live
    // locale snapshot source (subscription rides locale/change).
    const face = (entry.inject as unknown as () => QuestionComposerInjected)()
    expect(face.t('action.submit')).toBe('提交')
    expect(face.hooks.locale.getSnapshot()).toBe(locale.getLocale())
    const changed = vi.fn()
    const off = face.hooks.locale.subscribe(changed)
    locale.setLocale('en')
    expect(changed).toHaveBeenCalledTimes(1)
    expect(face.t('action.submit')).toBe('Submit')
    off()
    locale.setLocale('zh')
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('teardown unregisters the slot entry and the dictionaries', async () => {
    const { ctx, slots, locale } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('conversation.composer')).toHaveLength(1)
    expect(locale.bind(QUESTION_NS)('action.submit')).toBe('提交')
    await fiber.dispose()
    expect(slots.entries('conversation.composer')).toHaveLength(0)
    // Unregistered namespace: the lookup chain bottoms out at the key itself.
    expect(locale.bind(QUESTION_NS)('action.submit')).toBe('action.submit')
  })
})
