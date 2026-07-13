/**
 * Per-call concurrency classification: `ToolDefinition.isConcurrencySafe`,
 * `defineTool()`'s soft-validated forwarding of it, and the registry's
 * `executionMode(exec)` decision. Also proves the classifier never leaks into
 * the model-facing `schemas()` projection.
 */

import { describe, expect, expectTypeOf, it } from 'vitest'
import { Context } from 'cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, {
  defineTool,
  type ToolDefinition,
  type ToolExecutionInput,
  type ToolExecutionMode,
} from '@deepseek-ai/dsh-tools'

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  return ctx
}

function exec(name: string, args: unknown): ToolExecutionInput {
  return { callId: CallId('c1'), name, arguments: args }
}

describe('ToolRegistry.executionMode', () => {
  it('returns parallel only when the registered tool declares isConcurrencySafe → true', async () => {
    const ctx = await setup()
    ctx.tools.register(defineTool({
      name: 'safe',
      description: 'parallel-safe',
      parameters: {},
      isConcurrencySafe: () => true,
      async execute() { return [] },
    }))
    expect(ctx.tools.executionMode(exec('safe', {}))).toEqual({ kind: 'parallel' })
  })

  it('defaults to exclusive for a tool with no isConcurrencySafe declaration', async () => {
    const ctx = await setup()
    ctx.tools.register(defineTool({
      name: 'plain',
      description: 'no declaration',
      parameters: {},
      async execute() { return [] },
    }))
    expect(ctx.tools.executionMode(exec('plain', {}))).toEqual({ kind: 'exclusive' })
  })

  it('returns exclusive for an unknown tool', async () => {
    const ctx = await setup()
    expect(ctx.tools.executionMode(exec('nonexistent', {}))).toEqual({ kind: 'exclusive' })
  })

  it('returns exclusive when the classifier returns false for these args', async () => {
    const ctx = await setup()
    // Input-sensitive: safe to read, unsafe to write — the same tool differs by args.
    ctx.tools.register(defineTool({
      name: 'rw',
      description: 'read or write',
      parameters: { mode: { type: 'string', required: true } },
      isConcurrencySafe: args => args.mode === 'read',
      async execute() { return [] },
    }))
    expect(ctx.tools.executionMode(exec('rw', { mode: 'read' }))).toEqual({ kind: 'parallel' })
    expect(ctx.tools.executionMode(exec('rw', { mode: 'write' }))).toEqual({ kind: 'exclusive' })
  })

  it('a defineTool classifier soft-fails to exclusive on invalid args (no ToolArgsError)', async () => {
    const ctx = await setup()
    // The typed classifier would read args.mode, but the required arg is missing:
    // soft validation returns false (exclusive) rather than throwing, matching the
    // presenter pattern. Executing the same bad args WOULD raise ToolArgsError.
    ctx.tools.register(defineTool({
      name: 'needs-mode',
      description: 'requires mode',
      parameters: { mode: { type: 'string', required: true } },
      isConcurrencySafe: () => true,
      async execute() { return [] },
    }))
    expect(ctx.tools.executionMode(exec('needs-mode', {}))).toEqual({ kind: 'exclusive' })
  })

  it('a thrown classifier fails closed to exclusive (raw definition)', async () => {
    const ctx = await setup()
    // A hand-rolled ToolDefinition (not via defineTool) whose check throws.
    const raw: ToolDefinition = {
      name: 'thrower',
      description: 'classifier throws',
      parameters: { type: 'object', properties: {} },
      isConcurrencySafe() { throw new Error('boom') },
      async execute() { return [] },
    }
    ctx.tools.register(raw)
    expect(ctx.tools.executionMode(exec('thrower', {}))).toEqual({ kind: 'exclusive' })
  })

  it('a truthy non-boolean classifier result fails closed to exclusive (raw definition)', async () => {
    const ctx = await setup()
    const raw = {
      name: 'truthy',
      description: 'classifier returns a truthy string',
      parameters: { type: 'object', properties: {} },
      isConcurrencySafe() { return 'yes' },
      async execute() { return [] },
    } as unknown as ToolDefinition
    ctx.tools.register(raw)
    expect(ctx.tools.executionMode(exec('truthy', {}))).toEqual({ kind: 'exclusive' })
  })

  it('a raw definition (no defineTool) receives the raw parsed value', async () => {
    const ctx = await setup()
    let seen: unknown
    ctx.tools.register({
      name: 'raw-safe',
      description: 'raw',
      parameters: { type: 'object', properties: {} },
      isConcurrencySafe(args) { seen = args; return true },
      async execute() { return [] },
    })
    expect(ctx.tools.executionMode(exec('raw-safe', { anything: 1 }))).toEqual({ kind: 'parallel' })
    expect(seen).toEqual({ anything: 1 })
  })

  it('isConcurrencySafe never reaches the model-facing schemas() projection', async () => {
    const ctx = await setup()
    ctx.tools.register(defineTool({
      name: 'safe',
      description: 'parallel-safe',
      parameters: { x: { type: 'string', required: true } },
      isConcurrencySafe: () => true,
      async execute() { return [] },
    }))
    const schema = ctx.tools.schemas()[0] as unknown as Record<string, unknown>
    expect(Object.keys(schema).sort()).toEqual(['description', 'name', 'parameters'])
    expect(schema.isConcurrencySafe).toBeUndefined()
  })

  it('ToolExecutionMode is the object-tagged union', () => {
    expectTypeOf<ToolExecutionMode>().toEqualTypeOf<{ kind: 'parallel' } | { kind: 'exclusive' }>()
  })
})
