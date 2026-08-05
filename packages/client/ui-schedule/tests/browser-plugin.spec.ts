import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import { LocaleService } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import { ReminderRow } from '../src/client/ReminderRow.tsx'
import { apply as nodeApply } from '../src/index.ts'
import {
  apply as invariantApply,
  inject as invariantInject,
  name as invariantName,
} from '../src/invariant.ts'

interface CapturedEntry {
  name: string
  key?: string
  locale?: string
  component: unknown
}

function bench() {
  const ctx = new Context()
  let entry: CapturedEntry | undefined
  ctx.provide('slots', {
    register(options: Omit<CapturedEntry, 'component'>, component: unknown) {
      entry = { ...options, component }
      return () => { entry = undefined }
    },
  })
  ctx.provide('conversation', {})
  ctx.provide('locale', new LocaleService(ctx))
  const fiber = ctx.plugin({ inject: [...inject], apply })
  return { ctx, fiber, entry: () => entry }
}

describe('ui-schedule browser plugin', () => {
  it('registers the keyed reminder renderer and unloads it with the fiber', async () => {
    const b = bench()
    await b.fiber.await()
    expect(b.entry()).toEqual({
      name: 'conversation.chat.eventview',
      key: 'schedule/reminder',
      locale: 'schedule',
      component: ReminderRow,
    })

    await b.fiber.dispose()
    expect(b.entry()).toBeUndefined()
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
