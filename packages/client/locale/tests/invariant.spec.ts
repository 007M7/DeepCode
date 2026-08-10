// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { apply as nodeApply } from '@deepseek-ai/dsh-client-locale'
import { apply as clientApply, COMMON_NS, LocaleService, inject } from '@deepseek-ai/dsh-client-locale/client'
import * as LocaleInvariant from '@deepseek-ai/dsh-client-locale/invariant'
import { SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import InvariantService from '@deepseek-ai/dsh-invariants'

describe('invariant companion', () => {
  it('registers under the package name with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantService, { enabled: true })
    await expect(ctx.plugin(LocaleInvariant).await()).resolves.toBeDefined()
  })

  it('node-half apply tolerates a Host without settings', () => {
    nodeApply(new Context())
  })

  it('client apply provides ctx.locale seeded with the zh/en common namespace', async () => {
    // The feature registers its own Language settings row, hence the slots edge.
    expect(inject).toEqual(['slots', 'connection'])
    const ctx = new Context()
    new SlotsService(ctx)
    ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
    await ctx.plugin({ inject, apply: clientApply }).await()
    const locale = ctx.get('locale')
    expect(locale).toBeInstanceOf(LocaleService)
    // Seeded dictionaries occupy the (ns, locale) seats even while empty.
    expect(() => (locale as LocaleService).register(COMMON_NS, 'zh', {})).toThrow('already has locale')
    expect(() => (locale as LocaleService).register(COMMON_NS, 'en', {})).toThrow('already has locale')
  })
})
