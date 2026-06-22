import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import SystemPrompt, { PromptAssembly, PromptSection, renderPrompt } from '@deepseek-ai/dsh-system-prompt'

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

  it('rolls back a section when a system-prompt/change listener throws (P1-1)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)

    // Throw on the first emit only. Note the rollback path itself emits
    // system-prompt/change, so a multi-shot guard would also fire on rollback;
    // a single-shot guard isolates the register's own emit.
    let threw = false
    const off = ctx.on('system-prompt/change', () => {
      if (!threw) { threw = true; throw new Error('boom change listener') }
    })

    expect(() => ctx.systemPrompt.section({ name: 'p', order: 0, text: 'persona' })).toThrow('boom change listener')
    expect((await ctx.systemPrompt.assemble()).sections).toHaveLength(0) // nothing leaked

    // Subsequent listener-free register contributes exactly once.
    off()
    ctx.systemPrompt.section({ name: 'p', order: 0, text: 'persona' })
    expect((await ctx.systemPrompt.assemble()).sections.map(s => s.name)).toEqual(['p'])
  })

  it('rolls back a tool provider when a system-prompt/change listener throws (P1-1)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)

    let threw = false
    const off = ctx.on('system-prompt/change', () => {
      if (!threw) { threw = true; throw new Error('boom change listener') }
    })

    expect(() => ctx.systemPrompt.tools(() => [{ name: 't', description: '', parameters: {} }])).toThrow('boom change listener')
    expect((await ctx.systemPrompt.assemble()).tools).toHaveLength(0) // nothing leaked

    off()
    ctx.systemPrompt.tools(() => [{ name: 't', description: '', parameters: {} }])
    expect((await ctx.systemPrompt.assemble()).tools.map(t => t.name)).toEqual(['t'])
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

  it('assembles snapshots so one-step mutations do not leak into future assemblies', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    ctx.systemPrompt.section({ name: 'base', order: 0, text: 'base' })
    ctx.systemPrompt.tools(() => [{ name: 't', description: 'tool', parameters: { type: 'object', properties: {} } }])

    const first = await ctx.systemPrompt.assemble()
    first.sections[0]!.name = 'mutated'
    first.tools[0]!.description = 'mutated'
    const firstParameters = first.tools[0]!.parameters as { properties: Record<string, unknown> }
    firstParameters.properties['leak'] = { type: 'string' }

    const second = await ctx.systemPrompt.assemble()
    expect(second.sections.map(section => section.name)).toEqual(['base'])
    expect(second.tools).toEqual([{ name: 't', description: 'tool', parameters: { type: 'object', properties: {} } }])
  })

  it('filters out empty section text from renderPrompt', () => {
    // Direct test of renderPrompt: function returning empty string, and empty static text
    const result = renderPrompt({
      sections: [
        { name: 'empty-fn', order: 0, text: () => '' },
        { name: 'real', order: 1, text: 'content' },
        { name: 'empty-static', order: 2, text: '' },
      ],
      tools: [],
    })
    expect(result).toBe('content')
  })

  it('evaluates dynamic function-text sections at each renderPrompt call', () => {
    let counter = 0
    const section: PromptSection = { name: 'dynamic', order: 0, text: () => `call ${++counter}` }
    expect(renderPrompt({ sections: [section], tools: [] })).toBe('call 1')
    expect(renderPrompt({ sections: [section], tools: [] })).toBe('call 2')
  })

  it('emits system-prompt/change when a tool provider is registered and disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)

    const changes: number = 0
    let changeCount = 0
    ctx.on('system-prompt/change', () => void changeCount++)

    const dispose = ctx.systemPrompt.tools(() => [])
    // registration emits change
    expect(changeCount).toBe(1)

    dispose()
    // disposal emits change again
    expect(changeCount).toBe(2)
    void changes // silence unused
  })

  it('cleans up tool providers on fiber dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)

    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.systemPrompt.tools(() => [{ name: 'fiber-tool', description: '', parameters: {} }])
    }, { inject: ['systemPrompt'] }))

    expect((await ctx.systemPrompt.assemble()).tools).toHaveLength(1)
    await fiber.dispose()
    expect((await ctx.systemPrompt.assemble()).tools).toHaveLength(0)
  })

  it('removes section when returned disposer is called directly', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)

    const dispose = ctx.systemPrompt.section({ name: 'direct', order: 0, text: 'direct section' })
    expect((await ctx.systemPrompt.assemble()).sections).toHaveLength(1)

    dispose()
    expect((await ctx.systemPrompt.assemble()).sections).toHaveLength(0)
  })

  it('removes tool provider when returned disposer is called directly', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)

    const dispose = ctx.systemPrompt.tools(() => [{ name: 'direct-tool', description: '', parameters: {} }])
    expect((await ctx.systemPrompt.assemble()).tools).toHaveLength(1)

    dispose()
    expect((await ctx.systemPrompt.assemble()).tools).toHaveLength(0)
  })
})
