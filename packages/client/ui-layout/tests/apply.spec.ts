// @vitest-environment jsdom
// Client apply wiring under the terminal register form: ctx.layout provided,
// ONE register() call declares the four child slots + seats the store factory
// + wires the panel actions through the inject hook; teardown cascades
// (service unprovided + declarations gone + registration cleared). Node half
// and the invariant companion ride along — one-line surfaces the aggregate
// coverage gate still requires exercised.

import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject, LayoutService } from '@deepseek-ai/dsh-client-ui-layout/client'
import { apply as nodeApply } from '@deepseek-ai/dsh-client-ui-layout'
import * as invariant from '@deepseek-ai/dsh-client-ui-layout/invariant'

async function bench() {
  const ctx = new Context()
  const slotsFiber = ctx.plugin(SlotsService)
  await slotsFiber.await()
  return { ctx, slots: ctx.get('slots') as SlotsService }
}

describe('ui-layout client apply', () => {
  it('declares its service dependencies', () => {
    expect(inject).toContain('slots')
  })

  it('provides ctx.layout and registers AppFrame into root with the four child declarations', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: ['slots'], apply })
    await fiber.await()
    expect(ctx.get('layout')).toBeInstanceOf(LayoutService)
    // The one register() call occupied 'root'…
    expect(slots.entries('root')).toHaveLength(1)
    // …and declared the four children in the ledger.
    expect(slots.spec('sidebar')).toEqual({ kind: 'single', scope: 'root' })
    expect(slots.spec('conversation')).toEqual({ kind: 'single', scope: 'session' })
    expect(slots.spec('details')).toEqual({ kind: 'single', scope: 'session' })
    expect(slots.spec('conversation.empty')).toEqual({ kind: 'single', scope: 'root' })
  })

  it('teardown unwinds the service, the root registration, and the child declarations', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: ['slots'], apply })
    await fiber.await()
    await fiber.dispose()
    expect(ctx.get('layout')).toBeUndefined()
    expect(slots.entries('root')).toHaveLength(0)
    expect(slots.spec('sidebar')).toBeUndefined()
    expect(slots.spec('conversation.empty')).toBeUndefined()
    // The built-in root declaration survives entry teardown (runtime-owned).
    expect(slots.spec('root')).toEqual({ kind: 'single', scope: 'root' })
  })
})

describe('node half + invariant companion', () => {
  it('node apply is an intentional no-op (loader-managed lifecycle only)', () => {
    nodeApply()
    expect(true).toBe(true) // reaching here without throw is the contract
  })

  it('invariant companion registers under the package name', async () => {
    const register = vi.fn().mockReturnValue(() => {})
    const ctx = { invariants: { register } } as never
    // The /invariant subpath types live in lib/types (build product); assert
    // the surface so the call stays typed where lint runs without a build.
    const dispose = await (invariant as { apply: (ctx: never) => Promise<() => void> }).apply(ctx)
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-client-ui-layout', expect.any(Function))
    // The installer is the declared no-op — calling it must not throw.
    expect(() => { (register.mock.calls[0]![1] as (c: never) => void)(undefined as never) }).not.toThrow()
    expect(dispose).toBeTypeOf('function')
  })
})
