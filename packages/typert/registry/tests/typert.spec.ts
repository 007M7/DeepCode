import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { z } from 'zod'
import TypertRegistry, {
  typertKey,
  typertPackageKey,
  type TypertContribution,
} from '@deepseek-ai/dsh-typert-registry'

async function makeCtx(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  return ctx
}

function toolsContribution(schema: z.ZodType = z.object({ name: z.string() })): TypertContribution {
  return {
    package: '@deepseek-ai/dsh-tools',
    face: 'host',
    schemas: [{ name: 'ToolInput', schema }],
    model: {
      services: [{
        key: 'tools',
        exportName: 'ToolRegistry',
        summary: 'Tool registry and execution pipeline.',
        tags: [],
        members: [{
          kind: 'method',
          name: 'register',
          signature: 'register(definition: ToolDefinition): () => void',
        }],
        types: [{ name: 'ToolDefinition', declaration: 'export interface ToolDefinition {}' }],
      }],
      events: [{
        name: 'tools/change',
        mode: 'emit',
        signature: "'tools/change'(): void",
        tags: [],
      }],
      objects: [],
    },
  }
}

describe('TypertRegistry', () => {
  it('registers and queries generated schemas separately from package reflection', async () => {
    const ctx = await makeCtx()
    const contribution = toolsContribution()
    ctx.typert.register(contribution)

    expect(typertKey('@deepseek-ai/dsh-tools', 'ToolInput')).toBe('@deepseek-ai/dsh-tools#ToolInput')
    expect(typertPackageKey('@deepseek-ai/dsh-tools', 'host')).toBe('@deepseek-ai/dsh-tools#host')
    expect(ctx.typert.get('@deepseek-ai/dsh-tools#ToolInput')).toMatchObject({
      package: '@deepseek-ai/dsh-tools',
      face: 'host',
      name: 'ToolInput',
    })
    expect(ctx.typert.get('@deepseek-ai/dsh-tools#ToolInput')?.schema).toBe(contribution.schemas[0]?.schema)
    expect(ctx.typert.getPackage('@deepseek-ai/dsh-tools', 'host')).toMatchObject({
      key: '@deepseek-ai/dsh-tools#host',
      model: { services: [{ key: 'tools' }] },
    })
    expect(ctx.typert.list()).toHaveLength(1)
    expect(ctx.typert.listPackages({ face: 'host' })).toHaveLength(1)
  })

  it('withdraws schemas and package metadata through the exact contribution disposer', async () => {
    const ctx = await makeCtx()
    const dispose = ctx.typert.register(toolsContribution())
    expect(ctx.typert.getPackage('@deepseek-ai/dsh-tools')).toBeDefined()

    dispose()

    expect(ctx.typert.get('@deepseek-ai/dsh-tools#ToolInput')).toBeUndefined()
    expect(ctx.typert.getPackage('@deepseek-ai/dsh-tools')).toBeUndefined()
    expect(ctx.typert.listPackages()).toEqual([])
  })

  it('follows the registering plugin fiber lifecycle', async () => {
    const ctx = await makeCtx()
    const fiber = ctx.plugin(Object.assign(
      (child: Context) => { child.typert.register(toolsContribution()) },
      { inject: ['typert'] },
    ))
    await fiber
    expect(ctx.typert.getPackage('@deepseek-ai/dsh-tools')).toBeDefined()

    await fiber.dispose()

    expect(ctx.typert.getPackage('@deepseek-ai/dsh-tools')).toBeUndefined()
    expect(ctx.typert.list()).toEqual([])
  })

  it('rejects duplicate package faces and schema keys before committing', async () => {
    const ctx = await makeCtx()
    const original = toolsContribution()
    ctx.typert.register(original)

    expect(() => ctx.typert.register(toolsContribution(z.never()))).toThrow('package face')
    expect(ctx.typert.get('@deepseek-ai/dsh-tools#ToolInput')?.schema).toBe(original.schemas[0]?.schema)

    const duplicateBatch: TypertContribution = {
      ...toolsContribution(),
      package: '@fixture/duplicate',
      schemas: [
        { name: 'Same', schema: z.string() },
        { name: 'Same', schema: z.number() },
      ],
    }
    expect(() => ctx.typert.register(duplicateBatch)).toThrow('schema "@fixture/duplicate#Same" is already registered')
    expect(ctx.typert.getPackage('@fixture/duplicate')).toBeUndefined()
  })

  it('rejects malformed contribution identities and filters both registry views', async () => {
    const ctx = await makeCtx()
    ctx.typert.register(toolsContribution())

    expect(() => ctx.typert.register({ ...toolsContribution(), package: '' }))
      .toThrow('invalid package name')
    expect(() => ctx.typert.register({ ...toolsContribution(), package: 'bad#package' }))
      .toThrow('invalid package name')
    expect(() => ctx.typert.register({ ...toolsContribution(), face: 'worker' as 'host' }))
      .toThrow('invalid face')
    expect(() => ctx.typert.register({
      ...toolsContribution(),
      package: '@fixture/schema-name',
      schemas: [{ name: 'bad#name', schema: z.string() }],
    })).toThrow('invalid schema name')

    expect(ctx.typert.list({ package: '@fixture/absent' })).toEqual([])
    expect(ctx.typert.list({ face: 'client' })).toEqual([])
    expect(ctx.typert.listPackages({ package: '@fixture/absent' })).toEqual([])
    expect(ctx.typert.listPackages({ face: 'client' })).toEqual([])
  })

  it('resolves required schemas and projects fresh JSON Schema documents', async () => {
    const ctx = await makeCtx()
    ctx.typert.register(toolsContribution())

    expect(ctx.typert.resolve('@deepseek-ai/dsh-tools#ToolInput').name).toBe('ToolInput')
    expect(() => ctx.typert.resolve('@deepseek-ai/dsh-tools#Missing')).toThrow('contributes no schema named "Missing"')
    expect(() => ctx.typert.resolve('@fixture/absent#Value')).toThrow('has no registered contribution')
    expect(() => ctx.typert.resolve('invalid')).toThrow('expected "<package>#<name>"')
    const projected = ctx.typert.toJSONSchema('@deepseek-ai/dsh-tools#ToolInput')
    expect(projected).toMatchObject({ type: 'object', properties: { name: { type: 'string' } } })
    expect(ctx.typert.toJSONSchema('@deepseek-ai/dsh-tools#ToolInput')).not.toBe(projected)
  })
})
