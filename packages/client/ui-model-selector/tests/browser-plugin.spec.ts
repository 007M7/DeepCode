/**
 * Browser-plugin assembly: the selector occupies the conversation-declared
 * composer-control slot, injects only Session object actions, fails loud when
 * the slot is undeclared, and unregisters with its plugin fiber.
 */

import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { ModelSelector } from '../src/client/ModelSelector.tsx'
import { apply, inject } from '../src/client/index.ts'

const SID = 'selector-session' as SessionId

async function bench(hasBinding = true) {
  const ctx = new Context()
  await ctx.plugin(SlotsService).await()
  const slots = ctx.get('slots') as SlotsService
  slots.register({
    name: 'root',
    children: {
      'conversation.composer.control': { kind: 'single', scope: 'session' },
    },
  } as never, (_props: { renderSlot?: unknown }) => null)
  const session = {
    refreshModels: vi.fn(() => Promise.resolve({ ok: true })),
    retryModelOperation: vi.fn(() => Promise.resolve(true)),
    selectModel: vi.fn((target: { provider: string; model: string }) => Promise.resolve({
      ok: target.model !== 'rejected',
      value: { selected: target },
    })),
  }
  ctx.provide('sessions', { binding: () => hasBinding ? { session } : undefined })
  ctx.provide('conversation', {})
  return { ctx, slots, session }
}

describe('model-selector browser plugin', () => {
  it('declares its ordering and service dependencies', () => {
    expect(inject).toEqual(['slots', 'sessions', 'conversation'])
  })

  it('fails loud when the conversation control slot is not declared', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotsService).await()
    ctx.provide('sessions', { binding: vi.fn() })
    ctx.provide('conversation', {})
    await expect(ctx.plugin({ inject: [...inject], apply }))
      .rejects.toThrow(/slot "conversation\.composer\.control" is not declared/)
  })

  it('registers the singleton and injects Session-owned refresh/select actions', async () => {
    const { ctx, slots, session } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    const entries = slots.entries('conversation.composer.control')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.component).toBe(ModelSelector)
    const injected = (entries[0]?.inject as (sessionId: SessionId) => {
      refreshModels(): void
      retryModelOperation(): Promise<boolean>
      selectModel(target: { provider: string; model: string }): Promise<boolean>
    })(SID)

    injected.refreshModels()
    expect(session.refreshModels).toHaveBeenCalledTimes(1)
    await expect(injected.retryModelOperation()).resolves.toBe(true)
    expect(session.retryModelOperation).toHaveBeenCalledTimes(1)
    await expect(injected.selectModel({ provider: 'deepseek', model: 'deepseek-chat' }))
      .resolves.toBe(true)
    await expect(injected.selectModel({ provider: 'deepseek', model: 'rejected' }))
      .resolves.toBe(false)
  })

  it('fails loud when slot injection resolves no Session binding', async () => {
    const { ctx, slots } = await bench(false)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const entry = slots.entries('conversation.composer.control')[0]
    expect(() => (entry?.inject as (sessionId: SessionId) => unknown)(SID))
      .toThrow(`ui-model-selector: session "${SID}" resolved no binding`)
  })

  it('unregisters the occupant when its plugin fiber is disposed', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('conversation.composer.control')).toHaveLength(1)
    await fiber.dispose()
    expect(slots.entries('conversation.composer.control')).toHaveLength(0)
  })
})
