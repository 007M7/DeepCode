import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { PlanModeControl } from '../src/client/PlanModeControl.tsx'
import type { PlanModeControlInjected } from '../src/client/index.ts'
import { apply, inject } from '../src/client/index.ts'

const SID = 's-plan' as SessionId

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotsService).await()
  const slots = ctx.get('slots') as SlotsService
  slots.register({
    name: 'root',
    children: { 'conversation.composer.controls': { kind: 'list', scope: 'session' } },
  } as never, () => null)
  const setPlanMode = vi.fn(() => Promise.resolve({ ok: true, value: { active: false, pending: true } }))
  ctx.provide('sessions', { manager: { get: () => ({ setPlanMode }) } })
  ctx.provide('conversation', {})
  return { ctx, slots, setPlanMode }
}

describe('ui-plan browser apply', () => {
  it('declares every service it binds', () => {
    expect(inject).toEqual(['slots', 'sessions', 'conversation'])
  })

  it('fails loud when conversation did not declare the controls slot', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotsService).await()
    ctx.provide('sessions', {})
    ctx.provide('conversation', {})
    await expect(ctx.plugin({ inject: [...inject], apply }))
      .rejects.toThrow(/slot "conversation.composer.controls" is not declared/)
  })

  it('registers the control, bridges host results, and unregisters on teardown', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = b.slots.entries('conversation.composer.controls')[0]!
    expect(entry.component).toBe(PlanModeControl)
    expect(entry.options).toMatchObject({ id: 'plan-mode', order: 10 })
    const injected = (entry.inject as unknown as (id: SessionId) => PlanModeControlInjected)(SID)
    await expect(injected.setPlanMode(true)).resolves.toBeNull()
    expect(b.setPlanMode).toHaveBeenCalledWith(true)

    b.setPlanMode.mockResolvedValueOnce({
      ok: false, error: { code: 'session-not-found', message: 'gone', details: {} },
    } as never)
    await expect(injected.setPlanMode(false)).resolves.toBe('gone（session-not-found）')

    await fiber.dispose()
    expect(b.slots.entries('conversation.composer.controls')).toHaveLength(0)
  })
})
