import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { apply as nodeApply } from '@deepseek-ai/dsh-client-i18n'
import { apply as clientApply, COMMON_NS, I18nService, inject } from '@deepseek-ai/dsh-client-i18n/client'
import * as I18nInvariant from '@deepseek-ai/dsh-client-i18n/invariant'
import InvariantService from '@deepseek-ai/dsh-invariants'

describe('invariant companion', () => {
  it('registers under the package name with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantService, { enabled: true })
    await expect(ctx.plugin(I18nInvariant).await()).resolves.toBeDefined()
  })

  it('node-half apply is a no-op host placeholder', () => {
    nodeApply()
    expect(true).toBe(true) // reaching here without throw is the contract
  })

  it('client apply provides ctx.i18n seeded with the zh/en common namespace', async () => {
    expect(inject).toEqual([])
    const ctx = new Context()
    await ctx.plugin({ inject, apply: clientApply }).await()
    const i18n = ctx.get('i18n')
    expect(i18n).toBeInstanceOf(I18nService)
    // Seeded dictionaries occupy the (ns, locale) seats even while empty.
    expect(() => (i18n as I18nService).register(COMMON_NS, 'zh', {})).toThrow('already has locale')
    expect(() => (i18n as I18nService).register(COMMON_NS, 'en', {})).toThrow('already has locale')
  })
})
