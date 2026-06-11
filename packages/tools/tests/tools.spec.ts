import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  return ctx
}

const echoTool = {
  name: 'echo',
  description: 'echo arguments back',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
  async execute(args: any) {
    return [{ type: 'text' as const, text: String(args?.text ?? '') }]
  },
}

describe('ToolRegistry', () => {
  it('registers tools, exposes schemas, and feeds the system-prompt assembly', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)

    expect(ctx.tools.schemas()).toEqual([{
      name: 'echo',
      description: 'echo arguments back',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
    }])
    // schemas() result must not leak execute
    expect((ctx.tools.schemas()[0] as any).execute).toBeUndefined()

    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.tools.map(t => t.name)).toEqual(['echo'])
  })

  it('executes a tool and returns its content', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)
    const result = await ctx.tools.execute({ callId: 'c1', name: 'echo', arguments: { text: 'hi' } })
    expect(result).toEqual({ callId: 'c1', content: [{ type: 'text', text: 'hi' }], isError: false })
  })

  it('returns isError results for unknown tools and throwing tools', async () => {
    const ctx = await setup()
    ctx.tools.register({
      ...echoTool,
      name: 'boom',
      async execute() {
        throw new Error('exploded')
      },
    })

    const unknown = await ctx.tools.execute({ callId: 'c1', name: 'nope', arguments: {} })
    expect(unknown.isError).toBe(true)

    const thrown = await ctx.tools.execute({ callId: 'c2', name: 'boom', arguments: {} })
    expect(thrown.isError).toBe(true)
    expect(thrown.content[0]).toMatchObject({ text: 'Error: exploded' })
  })

  it('lets tools/execute waterfall listeners veto a call (permission pattern)', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)

    ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
      if (exec.name === 'echo') {
        return {
          callId: exec.callId,
          content: [{ type: 'text', text: 'denied by policy' }],
          isError: true,
        }
      }
      return next()
    })

    const result = await ctx.tools.execute({ callId: 'c1', name: 'echo', arguments: { text: 'hi' } })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: 'denied by policy' })
  })

  it('composes multiple tools/execute listeners (sandbox-wrap pattern)', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)

    const order: string[] = []
    ctx.on('tools/execute', async (exec, next) => {
      order.push('first:before')
      const result = await next()
      order.push('first:after')
      return result
    })
    ctx.on('tools/execute', async (exec, next) => {
      order.push('second:before')
      const result = await next()
      order.push('second:after')
      return result
    })

    const result = await ctx.tools.execute({ callId: 'c1', name: 'echo', arguments: { text: 'x' } })
    expect(result.isError).toBe(false)
    expect(order).toEqual(['first:before', 'second:before', 'second:after', 'first:after'])
  })

  it('rejects duplicate names and unregisters on fiber dispose (HMR safety)', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)
    expect(() => ctx.tools.register(echoTool)).toThrow('already registered')

    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.tools.register({ ...echoTool, name: 'scoped' })
    }, { inject: ['tools'] }))
    expect(ctx.tools.schemas().map(t => t.name)).toEqual(['echo', 'scoped'])

    await fiber.dispose()
    expect(ctx.tools.schemas().map(t => t.name)).toEqual(['echo'])
  })
})
