import { sep } from 'node:path'
import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import Loader from '@cordisjs/plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { HARNESS_SOURCE_SECTION } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { prepareWebRuntimeContext } from '../src/web.ts'

describe('prepareWebRuntimeContext', () => {
  it('registers the config-tree builtin that installs both prompt sections', async () => {
    const ctx = new Context()
    const sourceRoot = `${sep}opt${sep}harness-src`
    let observedSections: { name: string; text: string }[] | undefined
    try {
      await ctx.plugin(Loader)
      prepareWebRuntimeContext(ctx, sourceRoot, 'production')
      expect(() => {
        prepareWebRuntimeContext(ctx, sourceRoot, 'production')
      }).toThrow(
        'Loader builtin "web-runtime-context" is already registered',
      )
      await ctx.loader.create({ name: 'cordis:web-runtime-context' })
      ctx.provide('httpServer', { port: 3080 } as Context['httpServer'])
      const consumer = ctx.inject(['systemPrompt'], async (promptCtx) => {
        const assembly = await promptCtx.systemPrompt.assemble()
        observedSections = assembly.sections
      })

      await ctx.plugin(SystemPrompt, { persona: 'You are a coding agent.' })
      await consumer

      expect(observedSections?.map(section => section.name)).toContain(HARNESS_SOURCE_SECTION)
      expect(observedSections?.find(section => section.name === 'app:web-surface')?.text)
        .toContain('http://127.0.0.1:3080')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
