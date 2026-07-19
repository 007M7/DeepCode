import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import type { BashExecutor } from '@deepseek-ai/dsh-bash'

describe('Codex hook package invariant', () => {
  it('rejects a partially installed hook listener set', async () => {
    const ctx = new Context()
    await ctx.plugin({
      name: 'codex-invariant-bash',
      apply(child: Context) {
        child.provide('bash', {
          resolve() {},
          async run() {},
          start() {},
        } as unknown as BashExecutor)
      },
    })
    await expect(ctx.plugin({
      name: 'hooks-codex',
      inject: ['bash'],
      apply(child: Context) {
        child.effect(() => () => {}, 'ctx.on("agent/session-start")')
      },
    })).rejects.toThrow(/must install its complete listener set atomically/)
  })
})
