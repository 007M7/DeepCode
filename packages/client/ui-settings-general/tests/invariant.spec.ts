import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import * as GeneralInvariant from '@deepseek-ai/dsh-client-ui-settings-general/invariant'
import InvariantService from '@deepseek-ai/dsh-invariants'

describe('invariant companion', () => {
  it('registers under the package name with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantService, { enabled: true })
    await expect(ctx.plugin(GeneralInvariant).await()).resolves.toBeDefined()
  })

  it('node-half apply is a no-op host placeholder', async () => {
    const { apply } = await import('@deepseek-ai/dsh-client-ui-settings-general')
    apply()
    expect(true).toBe(true) // reaching here without throw is the contract
  })
})
