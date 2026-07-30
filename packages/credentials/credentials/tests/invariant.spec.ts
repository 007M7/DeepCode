import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import InvariantService from '@deepseek-ai/dsh-invariants'
import * as CredentialsInvariant from '../src/invariant.ts'

describe('credentials invariant companion', () => {
  it('reserves the package name against duplicate registration', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantService)
    await ctx.plugin(CredentialsInvariant)

    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-credentials', () => {})
    }).toThrow(/already registered/)
  })
})
