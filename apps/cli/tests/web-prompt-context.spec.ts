import { sep } from 'node:path'
import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { HARNESS_SOURCE_SECTION } from '@deepseek-ai/dsh-app-boot'
import { prepareWebPromptContext } from '../src/web.ts'

describe('prepareWebPromptContext', () => {
  it('installs both sections before a later systemPrompt consumer activates', async () => {
    const ctx = new Context()
    const sourceRoot = `${sep}opt${sep}harness-src`
    let observedNames: string[] | undefined
    try {
      prepareWebPromptContext(ctx, sourceRoot)
      const consumer = ctx.inject(['systemPrompt'], async (promptCtx) => {
        const assembly = await promptCtx.systemPrompt.assemble()
        observedNames = assembly.sections.map(section => section.name)
      })

      await ctx.plugin(SystemPrompt, { persona: 'You are a coding agent.' })
      await consumer

      expect(observedNames).toContain(HARNESS_SOURCE_SECTION)
      expect(observedNames).toContain('app:web-surface')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
