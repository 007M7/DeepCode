/**
 * SessionProjectionRegistry behavior: registration surfaces through entries(),
 * duplicate keys fail loud, and both the returned disposer and the owning
 * fiber's disposal remove the key (HMR safety).
 */

import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { z } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionProvider } from '@deepseek-ai/dsh-session-projection'

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionMap {
    'test/alpha': { value: string }
    'test/beta': number
  }
}

const alphaProvider = (value: string): ProjectionProvider<'test/alpha'> => ({
  key: 'test/alpha',
  schema: z.object({ value: z.string() }),
  get: () => ({ value }),
})

async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  return ctx
}

describe('SessionProjectionRegistry', () => {
  it('registers a provider, walks it via entries(), and serves get()', async () => {
    const ctx = await harness()
    ctx.sessionProjections.register(alphaProvider('a'))
    const entries = ctx.sessionProjections.entries()
    expect(entries.map(entry => entry.key)).toEqual(['test/alpha'])
    const provider = entries[0] as ProjectionProvider<'test/alpha'>
    expect(provider.get({} as Agent)).toEqual({ value: 'a' })
    expect(provider.schema.parse({ value: 'a' })).toEqual({ value: 'a' })
  })

  it('preserves registration order across keys', async () => {
    const ctx = await harness()
    ctx.sessionProjections.register(alphaProvider('a'))
    ctx.sessionProjections.register({
      key: 'test/beta',
      schema: z.number(),
      get: () => 1,
    })
    expect(ctx.sessionProjections.entries().map(entry => entry.key)).toEqual(['test/alpha', 'test/beta'])
  })

  it('throws on a duplicate key and keeps the first registration', async () => {
    const ctx = await harness()
    ctx.sessionProjections.register(alphaProvider('first'))
    expect(() => ctx.sessionProjections.register(alphaProvider('second')))
      .toThrow(/"test\/alpha" is already registered/)
    const entries = ctx.sessionProjections.entries()
    expect(entries).toHaveLength(1)
    expect((entries[0] as ProjectionProvider<'test/alpha'>).get({} as Agent)).toEqual({ value: 'first' })
  })

  it('register() returns a disposer that removes the key and frees it for re-registration', async () => {
    const ctx = await harness()
    const dispose = ctx.sessionProjections.register(alphaProvider('a'))
    dispose()
    expect(ctx.sessionProjections.entries()).toEqual([])
    ctx.sessionProjections.register(alphaProvider('again'))
    expect(ctx.sessionProjections.entries()).toHaveLength(1)
  })

  it('removes a registration when its owning fiber unloads (HMR safety)', async () => {
    const ctx = await harness()
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.sessionProjections.register(alphaProvider('scoped'))
    }, { inject: ['sessionProjections'] }))
    expect(ctx.sessionProjections.entries()).toHaveLength(1)
    await fiber.dispose()
    expect(ctx.sessionProjections.entries()).toEqual([])
  })
})
