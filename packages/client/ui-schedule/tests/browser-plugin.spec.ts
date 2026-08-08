import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import { LocaleService } from '@deepseek-ai/dsh-client-locale/client'
import { SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '../src/client/index.ts'
import { ReminderRow } from '../src/client/ReminderRow.tsx'
import { apply as nodeApply } from '../src/index.ts'
import {
  apply as invariantApply,
  inject as invariantInject,
  name as invariantName,
} from '../src/invariant.ts'

async function bench(declareBeforeApply = true) {
  const ctx = new Context()
  await ctx.plugin(SlotsService)
  const slots = ctx.slots as unknown as {
    register: (options: object, component: unknown) => () => void
  }
  const declareHost = () => slots.register({
    name: 'root',
    children: { 'conversation.chat.eventview': { kind: 'keyed', scope: 'session' } },
  }, () => null)
  const initialHost = declareBeforeApply ? declareHost() : undefined
  ctx.provide('locale', new LocaleService(ctx))
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return {
    ctx,
    fiber,
    declareHost,
    initialHost,
    entry: () => ctx.slots.entries('conversation.chat.eventview')[0],
  }
}

describe('ui-schedule browser plugin', () => {
  it('registers the keyed reminder renderer and unloads it with the fiber', async () => {
    const b = await bench()
    expect(b.entry()?.options).toEqual({ key: 'schedule/change' })
    expect(b.entry()?.locale).toBe('schedule')
    expect(b.entry()?.component).toBe(ReminderRow)

    await b.fiber.dispose()
    expect(b.entry()).toBeUndefined()
    b.initialHost?.()
  })

  it('follows delayed declaration, collapse, and redeclaration until contributor disposal', async () => {
    const b = await bench(false)
    expect(b.entry()).toBeUndefined()

    const firstHost = b.declareHost()
    expect(b.entry()?.component).toBe(ReminderRow)
    firstHost()
    expect(b.entry()).toBeUndefined()

    const secondHost = b.declareHost()
    expect(b.entry()?.component).toBe(ReminderRow)
    await b.fiber.dispose()
    expect(b.entry()).toBeUndefined()
    secondHost()
  })
})

describe('ui-schedule node and invariant companions', () => {
  it('keeps the node half inert', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })

  it('registers exact package ownership and returns its disposer', async () => {
    const ctx = new Context()
    let owner: string | undefined
    let disposed = false
    ctx.provide('invariants', {
      register(packageName: string, install: unknown) {
        expect(install).toBeTypeOf('function')
        owner = packageName
        return () => { disposed = true }
      },
    })

    expect(invariantName).toBe('client-ui-schedule-invariant')
    expect(invariantInject).toEqual(['invariants'])
    const dispose = await invariantApply(ctx)
    expect(owner).toBe('@deepseek-ai/dsh-client-ui-schedule')
    dispose()
    expect(disposed).toBe(true)
  })
})
