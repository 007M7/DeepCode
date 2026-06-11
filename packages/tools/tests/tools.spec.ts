import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineTool, schemaSpecToJsonSchema, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  return ctx
}

const echoTool = defineTool({
  name: 'echo',
  description: 'echo arguments back',
  parameters: { text: { type: 'string' } },
  async execute(args) {
    return [{ type: 'text' as const, text: String(args.text ?? '') }]
  },
})

describe('ToolRegistry', () => {
  it('registers tools, exposes schemas, and feeds the system-prompt assembly', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)

    expect(ctx.tools.schemas()).toEqual([{
      name: 'echo',
      description: 'echo arguments back',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
    }])
    // schemas() result must not leak execute — as any intentional: 'execute'
    // is deliberately absent from ToolSchema, we're testing it's not there
    expect((ctx.tools.schemas()[0] as Record<string, unknown>).execute).toBeUndefined()

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

describe('defineTool / schema DSL', () => {
  it('converts SchemaSpec to standard JSON Schema with required array', () => {
    const spec = {
      path: { type: 'string', required: true as const, description: 'Absolute path' },
      offset: { type: 'number' },
      limit: { type: 'number', description: 'Max lines' },
    }
    const jsonSchema = schemaSpecToJsonSchema(spec)
    expect(jsonSchema).toEqual({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path' },
        offset: { type: 'number' },
        limit: { type: 'number', description: 'Max lines' },
      },
      required: ['path'],
    })
  })

  it('handles empty spec (no properties, no required)', () => {
    expect(schemaSpecToJsonSchema({})).toEqual({
      type: 'object',
      properties: {},
    })
  })

  it('handles nested object spec', () => {
    const spec = {
      config: {
        type: 'object' as const,
        required: true as const,
        properties: {
          host: { type: 'string', required: true as const },
          port: { type: 'number' },
        },
      },
    }
    const jsonSchema = schemaSpecToJsonSchema(spec)
    expect(jsonSchema).toEqual({
      type: 'object',
      properties: {
        config: {
          type: 'object',
          properties: {
            host: { type: 'string' },
            port: { type: 'number' },
          },
          required: ['host'],
        },
      },
      required: ['config'],
    })
  })

  it('defineTool returns a valid ToolDefinition with typed execute', async () => {
    const ctx = await setup()
    const tool = defineTool({
      name: 'typed-echo',
      description: 'A typed echo tool',
      parameters: {
        text: { type: 'string', required: true },
        uppercase: { type: 'boolean' },
      },
      async execute(args) {
        // args is typed: { text: string; uppercase?: boolean }
        const result = args.uppercase ? args.text.toUpperCase() : args.text
        return [{ type: 'text', text: result }]
      },
    })

    ctx.tools.register(tool)
    expect(ctx.tools.schemas()).toEqual([{
      name: 'typed-echo',
      description: 'A typed echo tool',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          uppercase: { type: 'boolean' },
        },
        required: ['text'],
      },
    }])

    const result = await ctx.tools.execute({
      callId: 'c1',
      name: 'typed-echo',
      arguments: { text: 'hello', uppercase: true },
    })
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: 'HELLO' }])
  })

  it('type-level: InferArgs maps required properties to non-optional', () => {
    // Compile-time check: if this compiles, InferArgs is correct.
    // args.a is string (required), args.b is number|undefined (optional).
    const tool = defineTool({
      name: 'type-check',
      description: '',
      parameters: { a: { type: 'string' as const, required: true as const }, b: { type: 'number' as const } },
      async execute(args) {
        // Verify types at runtime via typeof
        expect(typeof args.a).toBe('string')
        // args.b should be undefined when not provided
        void args
        return [{ type: 'text', text: args.a }]
      },
    })
    void tool
  })

  it('registry round-trips a defineTool definition (register→schemas→execute)', async () => {
    const ctx = await setup()
    ctx.tools.register(defineTool({
      name: 'roundtrip',
      description: 'Round-trip test',
      parameters: {
        req: { type: 'string', required: true },
        opt: { type: 'number', description: 'Optional number' },
      },
      async execute(args) {
        return [{ type: 'text', text: `${args.req}:${args.opt ?? 'none'}` }]
      },
    }))

    // Schema round-trip: schemas() returns standard JSON Schema
    const schemas = ctx.tools.schemas()
    expect(schemas).toHaveLength(1)
    expect(schemas[0].parameters).toEqual({
      type: 'object',
      properties: {
        req: { type: 'string' },
        opt: { type: 'number', description: 'Optional number' },
      },
      required: ['req'],
    })

    // Execution round-trip
    const result = await ctx.tools.execute({
      callId: 'c1',
      name: 'roundtrip',
      arguments: { req: 'hello' },
    })
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: 'hello:none' }])
  })

  it('still accepts raw JSON-Schema ToolDefinition directly (MCP interop)', async () => {
    const ctx = await setup()
    ctx.tools.register({
      name: 'raw-tool',
      description: 'Raw JSON Schema tool (like an MCP adapter would register)',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      async execute(args: unknown) {
        const p = args as { path: string }
        return [{ type: 'text', text: p.path }]
      },
    })

    const schemas = ctx.tools.schemas()
    expect(schemas[0].parameters).toEqual({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    })

    const result = await ctx.tools.execute({
      callId: 'c1',
      name: 'raw-tool',
      arguments: { path: '/tmp' },
    })
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: '/tmp' }])
  })
})
