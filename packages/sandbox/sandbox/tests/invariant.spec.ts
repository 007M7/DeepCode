import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { InvariantError } from '@deepseek-ai/dsh-invariants'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

class StubSandboxProvider extends SandboxProvider {
  confine(argv: readonly string[], _policy: SandboxPolicy): ConfinedArgv {
    return {
      argv: [...argv],
      enforcement: 'full',
      denialSignatures: [],
      runnerFailureSignatures: [],
    }
  }
}

describe('sandbox package invariant', () => {
  it('accepts a provider that exposes the confinement seam', async () => {
    const ctx = new Context()
    await ctx.plugin(StubSandboxProvider)
    expect(ctx.sandbox).toBeInstanceOf(StubSandboxProvider)
  })

  it('rejects a service binding without confine()', async () => {
    const ctx = new Context()
    const invalidSandbox = {
      name: 'invalid-sandbox',
      apply(child: Context) {
        child.provide('sandbox', {} as SandboxProvider)
      },
    }
    let caught: unknown
    try {
      await ctx.plugin(invalidSandbox)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(InvariantError)
    expect(caught).toHaveProperty('packageName', '@deepseek-ai/dsh-sandbox')
    expect((caught as Error).message).toMatch(/must expose method "confine"/)
  })
})
