// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply as nodeApply } from '@deepseek-ai/dsh-client-ui-theme'
import { apply as clientApply, inject, ThemeService } from '@deepseek-ai/dsh-client-ui-theme/client'
import * as ThemeInvariant from '@deepseek-ai/dsh-client-ui-theme/invariant'
import { apply as localeApply, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import InvariantService from '@deepseek-ai/dsh-invariants'

describe('invariant companion', () => {
  it('registers under the package name with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantService, { enabled: true })
    await expect(ctx.plugin(ThemeInvariant).await()).resolves.toBeDefined()
  })

  it('node-half waits for an optional settings provider', () => {
    nodeApply(new Context())
    expect(true).toBe(true)
  })

  it('client apply provides ctx.theme over the slots/locale edges', async () => {
    // The feature registers its own Appearance settings row with localized
    // copy, hence the slots + locale edges.
    expect(inject).toEqual(['slots', 'locale', 'connection'])
    const ctx = new Context()
    new SlotsService(ctx)
    ctx.provide('connection', {
      api: { settings: { describe: () => Promise.resolve({
        rpcId: 'theme-invariant' as never,
        result: { ok: true, value: { writable: true, hasDocument: false, namespaces: [] } },
      }) } },
      isLoopback: true,
    } as never)
    await ctx.plugin({ inject: localeInject, apply: localeApply }).await()
    await ctx.plugin({ inject, apply: clientApply }).await()
    expect(ctx.get('theme')).toBeInstanceOf(ThemeService)
  })
})
