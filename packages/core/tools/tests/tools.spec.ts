import { describe, expect, expectTypeOf, it } from 'vitest'
import { Context } from 'cordis'
import { CallId, HarnessError } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, {
  defineTool, schemaSpecToJsonSchema, validateArgs, ToolArgsError, ToolNotFoundError,
  type InferArgs, type SchemaSpec, type ToolExecutionResult,
} from '@deepseek-ai/dsh-tools'

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
    return [{ type: 'text' as const, text: args.text ?? '' }]
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
    // schemas() result must not leak execute — ToolSchema deliberately has no
    // 'execute' key, so widen through unknown to probe for the absent property
    expect((ctx.tools.schemas()[0] as unknown as Record<string, unknown>).execute).toBeUndefined()

    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.tools.map(t => t.name)).toEqual(['echo'])
  })

  it('schemas() drops the UI presentation callbacks — they must never reach the model', async () => {
    const ctx = await setup()
    // A tool that declares presentCall/presentResult (functions). schemas() feeds
    // the system-prompt assembly → the model request, so those callbacks (and
    // `execute`) must be stripped: a function in the JSON tool schema would
    // corrupt the request. schemas() is an explicit allowlist, so it can't leak.
    ctx.tools.register(defineTool({
      name: 'present',
      description: 'has presenters',
      parameters: { x: { type: 'string', required: true } },
      async execute() { return [] },
      presentCall: args => ({ card: 'generic', title: args.x }),
      presentResult: (args, result) => ({ card: 'generic', title: args.x, content: result.content }),
    }))
    const schema = ctx.tools.schemas()[0] as unknown as Record<string, unknown>
    expect(Object.keys(schema).sort()).toEqual(['description', 'name', 'parameters'])
    expect(schema.presentCall).toBeUndefined()
    expect(schema.presentResult).toBeUndefined()
    expect(schema.execute).toBeUndefined()
  })

  it('schemas() preserves `strict` when set (allowlist keeps the model-facing fields)', async () => {
    const ctx = await setup()
    ctx.tools.register(defineTool({
      name: 'strict-tool',
      description: 'd',
      parameters: { x: { type: 'string', required: true } },
      strict: true,
      async execute() { return [] },
    }))
    expect(ctx.tools.schemas()[0]).toMatchObject({ name: 'strict-tool', strict: true })
  })

  it('executes a tool and returns its content', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'echo', arguments: { text: 'hi' } })
    expect(result).toEqual({ callId: CallId('c1'), content: [{ type: 'text', text: 'hi' }], isError: false })
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

    const unknown = await ctx.tools.execute({ callId: CallId('c1'), name: 'nope', arguments: {} })
    expect(unknown.isError).toBe(true)
    expect(unknown.content[0]).toMatchObject({ text: 'Error: unknown tool "nope"' })
    // An unknown tool is a routable failure class, same as a tool-thrown one.
    expect(unknown.error).toEqual({ name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' })

    const thrown = await ctx.tools.execute({ callId: CallId('c2'), name: 'boom', arguments: {} })
    expect(thrown.isError).toBe(true)
    expect(thrown.content[0]).toMatchObject({ text: 'Error: exploded' })
  })

  it('ToolNotFoundError carries the tool name and a stable code', async () => {
    const { HarnessError } = await import('@deepseek-ai/dsh-llm')
    const err = new ToolNotFoundError('ghost')
    expect(err).toBeInstanceOf(HarnessError)
    expect(err.name).toBe('ToolNotFoundError')
    expect(err.code).toBe('UNKNOWN_TOOL')
    expect(err.toolName).toBe('ghost')
    expect(err.message).toBe('unknown tool "ghost"')
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

    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'echo', arguments: { text: 'hi' } })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: 'denied by policy' })
  })

  it('composes multiple tools/execute listeners (sandbox-wrap pattern)', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)

    const order: string[] = []
    ctx.on('tools/execute', async (_exec, next) => {
      order.push('first:before')
      const result = await next()
      order.push('first:after')
      return result
    })
    ctx.on('tools/execute', async (_exec, next) => {
      order.push('second:before')
      const result = await next()
      order.push('second:after')
      return result
    })

    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'echo', arguments: { text: 'x' } })
    expect(result.isError).toBe(false)
    expect(order).toEqual(['first:before', 'second:before', 'second:after', 'first:after'])
  })

  it('returns an isError result when a tools/execute listener throws', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)
    ctx.on('tools/execute', async () => {
      throw new Error('permission hook broke')
    })

    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'echo', arguments: { text: 'hi' } })

    expect(result).toEqual({
      callId: CallId('c1'),
      content: [{ type: 'text', text: 'Error: permission hook broke' }],
      isError: true,
    })
  })

  it('preserves structured error info when a tools/execute listener throws HarnessError', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)
    ctx.on('tools/execute', async () => {
      throw new HarnessError('denied', 'DENIED')
    })

    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'echo', arguments: { text: 'hi' } })

    expect(result).toMatchObject({
      callId: CallId('c1'),
      isError: true,
      error: { name: 'HarnessError', code: 'DENIED' },
    })
  })

  it('schemas() snapshots tool schemas instead of exposing registry objects', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)

    const first = ctx.tools.schemas()
    const firstParameters = first[0]!.parameters as { properties: Record<string, unknown> }
    firstParameters.properties['mutated'] = { type: 'string' }
    first[0]!.description = 'mutated'

    expect(ctx.tools.schemas()).toEqual([{
      name: 'echo',
      description: 'echo arguments back',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
    }])
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

  it('returns a callable disposer from register() that unregisters the tool', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)

    // Register a second tool and call its returned disposer directly
    const dispose = ctx.tools.register({ ...echoTool, name: 'disposable' })
    expect(ctx.tools.schemas().map(t => t.name)).toEqual(['echo', 'disposable'])

    dispose()
    expect(ctx.tools.schemas().map(t => t.name)).toEqual(['echo'])
  })

  it('rolls back the tool entry when a tools/change listener throws (P1-1)', async () => {
    const ctx = await setup()

    let threw = false
    ctx.on('tools/change', () => {
      if (!threw) { threw = true; throw new Error('boom change listener') }
    })

    // The throwing emit must roll the entry back, not leak it.
    expect(() => ctx.tools.register(echoTool)).toThrow('boom change listener')
    expect(ctx.tools.get('echo')).toBeUndefined() // rolled back, not leaked
    expect(ctx.tools.schemas()).toHaveLength(0)

    // A subsequent listener-free register of the SAME name succeeds and is
    // exposed exactly once (the duplicate-name check is not wedged).
    const dispose = ctx.tools.register(echoTool)
    expect(ctx.tools.schemas().map(t => t.name)).toEqual(['echo'])
    dispose()
    expect(ctx.tools.get('echo')).toBeUndefined()
  })
})

describe('defineTool / schema DSL', () => {
  it('converts SchemaSpec to standard JSON Schema with required array', () => {
    const spec = {
      path: { type: 'string', required: true, description: 'Absolute path' },
      offset: { type: 'number' },
      limit: { type: 'number', description: 'Max lines' },
    } satisfies SchemaSpec
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
        type: 'object',
        required: true,
        properties: {
          host: { type: 'string', required: true },
          port: { type: 'number' },
        },
      },
    } satisfies SchemaSpec
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
      callId: CallId('c1'),
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
    expect(schemas[0]!.parameters).toEqual({
      type: 'object',
      properties: {
        req: { type: 'string' },
        opt: { type: 'number', description: 'Optional number' },
      },
      required: ['req'],
    })

    // Execution round-trip
    const result = await ctx.tools.execute({
      callId: CallId('c1'),
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
    expect(schemas[0]!.parameters).toEqual({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    })

    const result = await ctx.tools.execute({
      callId: CallId('c1'),
      name: 'raw-tool',
      arguments: { path: '/tmp' },
    })
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: '/tmp' }])
  })
})

describe('schema DSL edge cases', () => {
  it('emits enum values in JSON Schema property', () => {
    const spec = {
      color: { type: 'string', enum: ['red', 'green', 'blue'], description: 'Color choice' },
    } satisfies SchemaSpec
    const jsonSchema = schemaSpecToJsonSchema(spec)
    expect(jsonSchema.properties['color']).toMatchObject({
      type: 'string',
      enum: ['red', 'green', 'blue'],
      description: 'Color choice',
    })
  })

  it('emits default value in JSON Schema property', () => {
    const spec = {
      limit: { type: 'number', default: 25 },
    } satisfies SchemaSpec
    const jsonSchema = schemaSpecToJsonSchema(spec)
    expect(jsonSchema.properties['limit']).toMatchObject({
      type: 'number',
      default: 25,
    })
  })

  it('handles array items without nested properties (plain type array)', () => {
    const spec = {
      tags: { type: 'array', items: { type: 'string' } },
    } satisfies SchemaSpec
    const jsonSchema = schemaSpecToJsonSchema(spec)
    expect(jsonSchema.properties['tags']).toEqual({
      type: 'array',
      items: { type: 'string' },
    })
  })

  it('defineTool passes through strict flag when set to true', () => {
    const tool = defineTool({
      name: 'strict-tool',
      description: 'A strict tool',
      parameters: { input: { type: 'string' } },
      strict: true,
      async execute(args) {
        return [{ type: 'text' as const, text: args.input ?? '' }]
      },
    })
    expect(tool.strict).toBe(true)
  })

  it('defineTool omits strict when not provided', () => {
    const tool = defineTool({
      name: 'non-strict-tool',
      description: 'A non-strict tool',
      parameters: { input: { type: 'string' } },
      async execute(args) {
        return [{ type: 'text' as const, text: args.input ?? '' }]
      },
    })
    expect('strict' in tool).toBe(false)
  })

  it('defineTool strict=false is included', () => {
    const tool = defineTool({
      name: 'explicitly-non-strict',
      description: 'Explicitly non-strict',
      parameters: { input: { type: 'string' } },
      strict: false,
      async execute(args) {
        return [{ type: 'text' as const, text: args.input ?? '' }]
      },
    })
    expect(tool.strict).toBe(false)
  })

  it('handles enum and default together in one property', () => {
    const spec = {
      level: { type: 'string', enum: ['low', 'high'], default: 'low' },
    } satisfies SchemaSpec
    const jsonSchema = schemaSpecToJsonSchema(spec)
    expect(jsonSchema.properties['level']).toMatchObject({
      type: 'string',
      enum: ['low', 'high'],
      default: 'low',
    })
  })

  it('omits description, enum, default keys when not specified', () => {
    const spec = {
      bare: { type: 'string' },
    } satisfies SchemaSpec
    const jsonSchema = schemaSpecToJsonSchema(spec)
    const prop = jsonSchema.properties['bare'] as Record<string, unknown>
    expect(prop).toEqual({ type: 'string' })
    expect('description' in prop).toBe(false)
    expect('enum' in prop).toBe(false)
    expect('default' in prop).toBe(false)
  })

  it('handles array with no items (items omitted)', () => {
    const spec = {
      raw: { type: 'array' },
    } satisfies SchemaSpec
    const jsonSchema = schemaSpecToJsonSchema(spec)
    expect(jsonSchema.properties['raw']).toEqual({
      type: 'array',
    })
  })

  it('handles nested object with all-optional properties (no required array)', () => {
    const spec = {
      config: {
        type: 'object',
        properties: {
          host: { type: 'string' },
          port: { type: 'number' },
        },
      },
    } satisfies SchemaSpec
    const jsonSchema = schemaSpecToJsonSchema(spec)
    expect(jsonSchema.properties['config']).toMatchObject({
      type: 'object',
      properties: {
        host: { type: 'string' },
        port: { type: 'number' },
      },
    })
    // no 'required' key in the nested object because nothing is required
    const config = jsonSchema.properties['config'] as Record<string, unknown>
    expect('required' in config).toBe(false)
  })
})

describe('schema DSL regressions (Codex review round 2)', () => {
  it('InferArgs makes non-required keys genuinely optional (omittable)', () => {
    type Args = InferArgs<{
      path: { type: 'string'; required: true }
      limit: { type: 'number' }
    }>
    expectTypeOf<Args>().toEqualTypeOf<{ path: string; limit?: number }>()
    // omitting the optional key is assignable — the actual regression
    const omitted: Args = { path: '/tmp' }
    expect(omitted.limit).toBeUndefined()
  })

  it('InferArgs recurses into array items, including arrays of objects', () => {
    type Args = InferArgs<{
      names: { type: 'array'; required: true; items: { type: 'string' } }
      servers: {
        type: 'array'
        items: {
          type: 'object'
          properties: {
            host: { type: 'string'; required: true }
            port: { type: 'number' }
          }
        }
      }
    }>
    expectTypeOf<Args>().toEqualTypeOf<{
      names: string[]
      servers?: { host: string; port?: number }[]
    }>()
  })

  it('runtime JSON Schema matches the array-of-objects inference', () => {
    const spec = {
      servers: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            host: { type: 'string', required: true },
            port: { type: 'number' },
          },
        },
      },
    } satisfies SchemaSpec
    expect(schemaSpecToJsonSchema(spec)).toEqual({
      type: 'object',
      properties: {
        servers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              host: { type: 'string' },
              port: { type: 'number' },
            },
            required: ['host'],
          },
        },
      },
    })
  })

  it('reports messages from non-Error throws (throw { message })', async () => {
    const ctx = await setup()
    ctx.tools.register({
      ...echoTool,
      name: 'object-thrower',
      async execute() {
        // testing non-Error throws on purpose
        throw { message: 'denied by object' }
      },
    })
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'object-thrower', arguments: {} })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: 'Error: denied by object' })
  })

  it('reports messages from throws of non-objects (throw "string")', async () => {
    const ctx = await setup()
    ctx.tools.register({
      ...echoTool,
      name: 'string-thrower',
      async execute() {
        // testing primitive throws on purpose
        throw 'kaboom'
      },
    })
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'string-thrower', arguments: {} })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: 'Error: kaboom' })
  })

  it('reports messages from throws of objects without message property', async () => {
    const ctx = await setup()
    ctx.tools.register({
      ...echoTool,
      name: 'object-no-message',
      async execute() {
        // testing object throw without .message
        throw { code: 500 }
      },
    })
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'object-no-message', arguments: {} })
    expect(result.isError).toBe(true)
    const firstContent = result.content[0]!
    expect(firstContent.type).toBe('text')
    if (firstContent.type === 'text') {
      expect(firstContent.text).toBe('Error: [object Object]')
    }
  })
})

describe('ToolRegistry.get', () => {
  it('get() returns the registered tool definition', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)
    const tool = ctx.tools.get('echo')
    expect(tool).toBeDefined()
    expect(tool!.name).toBe('echo')
  })

  it('get() returns undefined for unknown tool names', async () => {
    const ctx = await setup()
    expect(ctx.tools.get('nope')).toBeUndefined()
  })
})

describe('validateArgs (the runtime-validation RFC, part 1)', () => {
  it('returns [] for valid args and is total over malformed input', () => {
    const spec = {
      path: { type: 'string', required: true },
      limit: { type: 'number' },
    } satisfies SchemaSpec
    expect(validateArgs(spec, { path: '/tmp' })).toEqual([])
    expect(validateArgs(spec, { path: '/tmp', limit: 5 })).toEqual([])
    // never throws regardless of shape
    expect(validateArgs(spec, null)).toHaveLength(1)
    expect(validateArgs(spec, 'nope')).toHaveLength(1)
    expect(validateArgs(spec, [])).toHaveLength(1)
  })

  it('flags a missing required key and a required key present as undefined', () => {
    const spec = { path: { type: 'string', required: true } } satisfies SchemaSpec
    expect(validateArgs(spec, {})).toEqual(['missing required property "path"'])
    expect(validateArgs(spec, { path: undefined })).toEqual(['missing required property "path"'])
  })

  it('allows extra keys (no additionalProperties:false) and omitted optionals', () => {
    const spec = { path: { type: 'string', required: true } } satisfies SchemaSpec
    expect(validateArgs(spec, { path: '/tmp', extra: 1 })).toEqual([])
  })

  it('does not apply defaults (validation only)', () => {
    const spec = { limit: { type: 'number', default: 25 } } satisfies SchemaSpec
    // absent optional is valid, and validation does not synthesize the default
    expect(validateArgs(spec, {})).toEqual([])
  })

  it('type-checks primitives', () => {
    const spec = {
      s: { type: 'string' },
      n: { type: 'number' },
      b: { type: 'boolean' },
    } satisfies SchemaSpec
    expect(validateArgs(spec, { s: 1 })).toEqual(['"s" must be a string'])
    expect(validateArgs(spec, { n: 'x' })).toEqual(['"n" must be a number'])
    expect(validateArgs(spec, { b: 'x' })).toEqual(['"b" must be a boolean'])
  })

  it('checks enum membership', () => {
    const spec = { color: { type: 'string', enum: ['red', 'green'] } } satisfies SchemaSpec
    expect(validateArgs(spec, { color: 'red' })).toEqual([])
    expect(validateArgs(spec, { color: 'blue' })).toEqual(['"color" must be one of ["red","green"]'])
  })

  it('checks enum uniformly with the converter (enum on a non-string prop)', () => {
    // The converter emits `enum` regardless of type; the validator must agree.
    // `enum` is string[], so a number value can never be a member.
    const spec = { n: { type: 'number', enum: ['1', '2'] } } as unknown as SchemaSpec
    expect(validateArgs(spec, { n: 1 })).toEqual(['"n" must be one of ["1","2"]'])
  })

  it('rejects an unknown SchemaType at runtime (assertNever guard)', () => {
    const spec = { x: { type: 'weird' } } as unknown as SchemaSpec
    expect(() => validateArgs(spec, { x: 1 })).toThrow(/unreachable variant.*validateArgs/)
  })

  it('recurses into nested objects (and an object without properties only type-checks)', () => {
    const spec = {
      config: {
        type: 'object',
        required: true,
        properties: { host: { type: 'string', required: true }, port: { type: 'number' } },
      },
      bag: { type: 'object' },
    } satisfies SchemaSpec
    expect(validateArgs(spec, { config: { host: 'h' }, bag: { anything: true } })).toEqual([])
    expect(validateArgs(spec, { config: { port: 9 }, bag: 5 })).toEqual([
      'missing required property "config.host"',
      '"bag" must be an object',
    ])
  })

  it('recurses into array items (and an array without items only type-checks)', () => {
    const spec = {
      tags: { type: 'array', items: { type: 'string' } },
      raw: { type: 'array' },
    } satisfies SchemaSpec
    expect(validateArgs(spec, { tags: ['a', 'b'], raw: [1, {}, 'x'] })).toEqual([])
    expect(validateArgs(spec, { tags: ['a', 2] })).toEqual(['"tags[1]" must be a string'])
    // a non-array value for an array-typed prop
    expect(validateArgs(spec, { tags: 'nope' })).toEqual(['"tags" must be an array'])
  })

  it('validates arrays of objects element-wise', () => {
    const spec = {
      servers: {
        type: 'array',
        items: { type: 'object', properties: { host: { type: 'string', required: true } } },
      },
    } satisfies SchemaSpec
    expect(validateArgs(spec, { servers: [{ host: 'a' }, {}] })).toEqual([
      'missing required property "servers[1].host"',
    ])
  })
})

describe('defineTool validation (the runtime-validation RFC, part 1)', () => {
  it('returns an isError result with the violations when the model sends bad args', async () => {
    const ctx = await setup()
    ctx.tools.register(defineTool({
      name: 'reader',
      description: 'reads a path',
      parameters: { path: { type: 'string', required: true } },
      async execute(args) {
        return [{ type: 'text', text: args.path }]
      },
    }))

    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'reader', arguments: {} })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({
      text: 'Error: invalid arguments: missing required property "path"',
    })
  })

  it('runs execute normally when args are valid', async () => {
    const ctx = await setup()
    ctx.tools.register(defineTool({
      name: 'reader',
      description: 'reads a path',
      parameters: { path: { type: 'string', required: true } },
      async execute(args) {
        return [{ type: 'text', text: `read ${args.path}` }]
      },
    }))
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'reader', arguments: { path: '/x' } })
    expect(result).toEqual({ callId: CallId('c1'), content: [{ type: 'text', text: 'read /x' }], isError: false })
  })

  it('ToolArgsError carries a stable code and the violation list', () => {
    const err = new ToolArgsError(['missing required property "a"', '"b" must be a number'])
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('ToolArgsError')
    expect(err.code).toBe('INVALID_ARGS')
    expect(err.violations).toEqual(['missing required property "a"', '"b" must be a number'])
    expect(err.message).toBe('invalid arguments: missing required property "a"; "b" must be a number')
  })

  it('a schema-invalid call surfaces the structured error on the result', async () => {
    const ctx = await setup()
    ctx.tools.register(defineTool({
      name: 'reader',
      description: 'reads a path',
      parameters: { path: { type: 'string', required: true } },
      async execute(args) {
        return [{ type: 'text', text: args.path }]
      },
    }))
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'reader', arguments: {} })
    expect(result.isError).toBe(true)
    expect(result.error).toEqual({ name: 'ToolArgsError', code: 'INVALID_ARGS' })
  })

  it('a tool throwing a HarnessError surfaces its name and code', async () => {
    const { HarnessError } = await import('@deepseek-ai/dsh-llm')
    const ctx = await setup()
    ctx.tools.register({
      ...echoTool,
      name: 'coded',
      async execute() {
        throw new HarnessError('disk full', 'ENOSPC')
      },
    })
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'coded', arguments: {} })
    expect(result.isError).toBe(true)
    expect(result.error).toEqual({ name: 'HarnessError', code: 'ENOSPC' })
    expect(result.content[0]).toMatchObject({ text: 'Error: disk full' })
  })

  it('a non-HarnessError throw has no structured error (only the text)', async () => {
    const ctx = await setup()
    ctx.tools.register({
      ...echoTool,
      name: 'plain',
      async execute() {
        throw new Error('just a message')
      },
    })
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'plain', arguments: {} })
    expect(result.isError).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.content[0]).toMatchObject({ text: 'Error: just a message' })
  })

  it('raw-registered tools are NOT validated by defineTool (MCP keeps its own)', async () => {
    const ctx = await setup()
    // A raw ToolDefinition: no defineTool wrapping, so no validateArgs guard.
    ctx.tools.register({
      name: 'raw',
      description: 'raw tool',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      async execute(args: unknown) {
        return [{ type: 'text', text: typeof args }]
      },
    })
    // Missing the "required" path — but raw tools validate their own input, so
    // this reaches execute rather than being rejected by the harness.
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'raw', arguments: {} })
    expect(result.isError).toBe(false)
  })
})

describe('defineTool presentation (presentCall / presentResult)', () => {
  it('threads presentCall/presentResult onto the ToolDefinition with typed args', () => {
    const tool = defineTool({
      name: 'demo',
      description: 'demo',
      parameters: { path: { type: 'string', required: true }, n: { type: 'number' } },
      async execute() { return [{ type: 'text', text: 'ok' }] },
      presentCall(args) {
        // args is typed { path: string; n?: number } — zero casts.
        expectTypeOf(args).toEqualTypeOf<{ path: string; n?: number }>()
        return { card: 'generic', title: `Open ${args.path}`, kind: 'read', rawInput: args.path }
      },
      presentResult(args, result) {
        return { card: 'generic', title: `Opened ${args.path}`, content: result.content }
      },
    })
    expect(tool.presentCall!({ path: '/a', n: 2 })).toEqual({ card: 'generic', title: 'Open /a', kind: 'read', rawInput: '/a' })
    expect(tool.presentResult!({ path: '/a' }, { content: [{ type: 'text', text: 'x' }], isError: false }))
      .toEqual({ card: 'generic', title: 'Opened /a', content: [{ type: 'text', text: 'x' }] })
  })

  it('a tool without presentCall/presentResult leaves them undefined (UI falls back generically)', () => {
    const tool = defineTool({
      name: 'plain',
      description: 'plain',
      parameters: { x: { type: 'string', required: true } },
      async execute() { return [] },
    })
    expect(typeof tool.presentCall).toBe('undefined')
    expect(typeof tool.presentResult).toBe('undefined')
  })

  it('presentCall/presentResult validate softly: malformed args return undefined, never throw (display runs on replay)', () => {
    const tool = defineTool({
      name: 'demo',
      description: 'demo',
      parameters: { path: { type: 'string', required: true } },
      async execute() { return [] },
      presentCall: args => ({ card: 'generic', title: args.path }),
      presentResult: (args, result) => ({ card: 'generic', title: args.path, content: result.content }),
    })
    // Unlike execute (which throws ToolArgsError on a mismatch), the display
    // methods soft-validate and fall back to undefined so a UI never crashes
    // replaying an old/foreign log entry. The ToolDefinition methods take
    // `unknown`, so malformed shapes pass without a cast.
    expect(tool.presentCall?.({})).toBeUndefined()
    expect(tool.presentResult?.({ wrong: 1 }, { content: [], isError: false })).toBeUndefined()
  })
})
