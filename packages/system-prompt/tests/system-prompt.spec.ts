import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import SystemPrompt, { PromptAssembly, renderPrompt } from '@deepseek-ai/dsh-system-prompt'

describe('SystemPrompt', () => {
  it('assembles sections in order with dynamic text and collected tools', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)

    ctx.systemPrompt.section({ name: 'persona', order: 0, text: 'You are DeepSeek Code.' })
    ctx.systemPrompt.section({ name: 'cwd', order: 20, text: () => 'cwd: /tmp' })
    ctx.systemPrompt.section({ name: 'rules', order: 10, text: 'Be precise.' })
    ctx.systemPrompt.tools(() => [{ name: 'echo', description: 'echo back', parameters: {} }])

    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.map(s => s.name)).toEqual(['persona', 'rules', 'cwd'])
    expect(assembly.tools).toEqual([{ name: 'echo', description: 'echo back', parameters: {} }])
    expect(renderPrompt(assembly)).toBe('You are DeepSeek Code.\n\nBe precise.\n\ncwd: /tmp')
  })

  it('removes contributions when the contributing fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)

    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.systemPrompt.section({ name: 'scoped', order: 0, text: 'scoped section' })
      inner.systemPrompt.tools(() => [{ name: 'scoped-tool', description: '', parameters: {} }])
    }, { inject: ['systemPrompt'] }))

    expect((await ctx.systemPrompt.assemble()).sections).toHaveLength(1)
    await fiber.dispose()
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections).toHaveLength(0)
    expect(assembly.tools).toHaveLength(0)
  })

  it('composes multiple system-prompt/assemble waterfall listeners in order', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    ctx.systemPrompt.section({ name: 'base', order: 0, text: 'base' })

    // Listener A appends a section, then delegates.
    ctx.on('system-prompt/assemble', async (assembly: PromptAssembly, next) => {
      assembly.sections.push({ name: 'from-a', order: 100, text: 'a' })
      return next()
    })
    // Listener B (registered later, runs after A) sees A's contribution.
    const seen: string[][] = []
    ctx.on('system-prompt/assemble', async (assembly: PromptAssembly, next) => {
      seen.push(assembly.sections.map(s => s.name))
      return next()
    })

    const assembly = await ctx.systemPrompt.assemble()
    expect(seen).toEqual([['base', 'from-a']])
    expect(assembly.sections.map(s => s.name)).toEqual(['base', 'from-a'])
  })

  it('lets a waterfall listener short-circuit by not calling next()', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    ctx.systemPrompt.section({ name: 'real', order: 0, text: 'real' })

    ctx.on('system-prompt/assemble', async () => {
      return { sections: [], tools: [] } satisfies PromptAssembly
    })

    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections).toHaveLength(0)
  })
})
