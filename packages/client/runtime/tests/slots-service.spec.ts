/**
 * SlotsService: cordis Service wrapper semantics — core delegation, the
 * 'slots/changed' event bridge, and fiber-scoped registration disposal.
 */
import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import type { FC } from 'react'
import { SlotsService } from '../src/client/slots.ts'

// Test-only slot keys (SlotMap is empty in this package; the service is generic over it).
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    't-single': { kind: 'single'; scope: 'root'; props: object }
    't-list': { kind: 'list'; scope: 'root'; props: object }
  }
}

const C: FC<object> = () => null

async function boot(): Promise<Context> {
  const ctx = new Context()
  ctx.plugin(SlotsService)
  await ctx.fiber.await()
  return ctx
}

describe('SlotsService', () => {
  it('proxies define/register/entries/spec/getVersion to the core', async () => {
    const ctx = await boot()
    ctx.slots.define('t-single', { kind: 'single', scope: 'root' })
    expect(ctx.slots.spec('t-single')).toEqual({ kind: 'single', scope: 'root' })
    const v0 = ctx.slots.getVersion('t-single')
    ctx.slots.register('t-single', C)
    expect(ctx.slots.entries('t-single')).toHaveLength(1)
    expect(ctx.slots.getVersion('t-single')).toBeGreaterThan(v0)
    expect(ctx.slots.core.spec('t-single')).toBeDefined()
  })

  it("re-emits every mutation as 'slots/changed' with the key", async () => {
    const ctx = await boot()
    const seen: string[] = []
    ctx.on('slots/changed', (key) => { seen.push(key) })
    ctx.slots.define('t-list', { kind: 'list', scope: 'root' })
    ctx.slots.register('t-list', C, { id: 'a' })
    expect(seen).toEqual(['t-list', 't-list'])
  })

  it('collects a plugin fiber\'s registrations when the fiber unloads (cascade)', async () => {
    const ctx = await boot()
    ctx.slots.define('t-single', { kind: 'single', scope: 'root' })
    const fiber = ctx.plugin({
      name: 'occupant',
      inject: ['slots'],
      apply: (pluginCtx: Context) => {
        pluginCtx.slots.register('t-single', C)
      },
    })
    await fiber.await()
    expect(ctx.slots.entries('t-single')).toHaveLength(1)
    await fiber.dispose()
    expect(ctx.slots.entries('t-single')).toHaveLength(0)
    // The slot definition (registered from root) survives; a new occupant may register.
    expect(() => ctx.slots.register('t-single', C)).not.toThrow()
  })

  it('proxies specDynamic/subscribe/getVersion through the core', async () => {
    const ctx = await boot()
    ctx.slots.define('t-list', { kind: 'list', scope: 'root' })
    expect(ctx.slots.specDynamic('t-list')).toEqual({ kind: 'list', scope: 'root' })
    expect(ctx.slots.specDynamic('never-defined')).toBeUndefined()
    let notified = 0
    const unsubscribe = ctx.slots.subscribe('t-list', () => { notified += 1 })
    ctx.slots.register('t-list', C, { id: 'row' })
    await new Promise(resolve => setTimeout(resolve, 0)) // microtask-batched flush
    expect(notified).toBeGreaterThan(0)
    expect(ctx.slots.getVersion('t-list')).toBeGreaterThan(0)
    unsubscribe()
  })

})
