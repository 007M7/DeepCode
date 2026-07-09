import { describe, expect, it } from 'vitest'
import { jsonSchemaToTs, renderToolsSdk } from '@deepseek-ai/dsh-tools/src/ts-types.ts'
import { schemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

describe('jsonSchemaToTs', () => {
  it('maps the defineTool DSL subset', () => {
    const cases: [unknown, string][] = [
      [{ type: 'string' }, 'string'],
      [{ type: 'number' }, 'number'],
      [{ type: 'boolean' }, 'boolean'],
      [{ type: 'string', enum: ['a', 'b'] }, '"a" | "b"'],
      [{ type: 'array', items: { type: 'number' } }, 'number[]'],
      [{ type: 'array', items: { type: 'string', enum: ['x', 'y'] } }, '("x" | "y")[]'],
      [{ type: 'array' }, 'unknown[]'],
      [{ type: 'object' }, 'Record<string, unknown>'],
      [{ type: 'object', properties: {} }, 'Record<string, unknown>'],
    ]
    for (const [schema, expected] of cases) {
      expect(jsonSchemaToTs(schema), JSON.stringify(schema)).toBe(expected)
    }
  })

  it('renders objects with required/optional keys, nested shapes, and per-property docs', () => {
    const schema = schemaSpecToJsonSchema({
      path: { type: 'string', required: true, description: 'Absolute file path' },
      limit: { type: 'number' },
      opts: {
        type: 'object',
        properties: { deep: { type: 'boolean', required: true } },
      },
    })
    expect(jsonSchemaToTs(schema)).toBe([
      '{',
      '  /** Absolute file path */',
      '  path: string;',
      '  limit?: number;',
      '  opts?: {',
      '    deep: boolean;',
      '  };',
      '}',
    ].join('\n'))
  })

  it('is total: unsupported or hostile constructs degrade to unknown, never throw', () => {
    const cases: unknown[] = [
      undefined,
      null,
      42,
      'string-schema',
      {},
      { type: 'integer' },
      { type: 'null' },
      { oneOf: [{ type: 'string' }] },
      { $ref: '#/defs/x' },
      { type: 'object', properties: 7 },
      { type: 'object', properties: { bad: { $ref: 'x' } } },
      { type: 'string', enum: [1, 2] },
      { type: 'string', enum: [] },
    ]
    for (const schema of cases) {
      expect(() => jsonSchemaToTs(schema), JSON.stringify(schema)).not.toThrow()
    }
    expect(jsonSchemaToTs({ type: 'integer' })).toBe('unknown')
    expect(jsonSchemaToTs({ oneOf: [] })).toBe('unknown')
    expect(jsonSchemaToTs({ type: 'object', properties: 7 })).toBe('Record<string, unknown>')
    expect(jsonSchemaToTs({ type: 'object', properties: { bad: { $ref: 'x' } }, required: ['bad'] })).toContain('bad: unknown;')
    // A non-string-only enum degrades to plain string; an empty one too.
    expect(jsonSchemaToTs({ type: 'string', enum: [1, 2] })).toBe('string')
    expect(jsonSchemaToTs({ type: 'string', enum: [] })).toBe('string')
    // A hostile required list only accepts string members.
    expect(jsonSchemaToTs({ type: 'object', properties: { a: { type: 'string' } }, required: [7] })).toContain('a?: string;')
    // A property VALUE that is not an object degrades to unknown (and can
    // carry no description).
    expect(jsonSchemaToTs({ type: 'object', properties: { weird: 42 } })).toContain('weird?: unknown;')
  })

  it('escapes a comment-closer inside a description so the generated JSDoc cannot end early', () => {
    const rendered = jsonSchemaToTs({
      type: 'object',
      properties: { glob: { type: 'string', description: 'a pattern like packages/*/tool-*/ over here' } },
    })
    expect(rendered).not.toContain('tool-*/ over')
    expect(rendered).toContain(String.raw`tool-*\/ over`)
  })
})

describe('renderToolsSdk', () => {
  const bash: ToolSchema = {
    name: 'bash',
    description: 'Run a shell command.',
    parameters: schemaSpecToJsonSchema({ command: { type: 'string', required: true } }) as unknown as Record<string, unknown>,
  }
  const exotic: ToolSchema = {
    name: 'my-mcp.tool',
    description: 'Exotic name.',
    parameters: schemaSpecToJsonSchema({}) as unknown as Record<string, unknown>,
  }

  it('declares every tool in lexicographic order with quoted keys for exotic names', () => {
    const text = renderToolsSdk([exotic, bash])
    expect(text).toContain('declare const tools: {')
    expect(text.indexOf('bash(args:')).toBeGreaterThan(0)
    expect(text).toContain('"my-mcp.tool"(args:')
    expect(text.indexOf('bash(args:')).toBeLessThan(text.indexOf('"my-mcp.tool"(args:'))
    expect(text).toContain('): Promise<string>;')
    expect(text).toContain('/** Run a shell command. */')
    // The fixed instruction lines the model relies on.
    expect(text).toContain('erasable syntax only')
    expect(text).toContain('rejects with an `Error`')
    expect(text).toContain('sequentially, even under `Promise.all`')
    expect(text).toContain('JSON-serializable')
  })

  it('is deterministic: same tool set, byte-identical text regardless of input order', () => {
    expect(renderToolsSdk([bash, exotic])).toBe(renderToolsSdk([exotic, bash]))
    // Equal names sort stably (the comparator's equal arm).
    expect(renderToolsSdk([bash, bash])).toBe(renderToolsSdk([bash, bash]))
  })

  it('renders an empty declaration for an empty tool set', () => {
    expect(renderToolsSdk([])).toContain('declare const tools: {}')
  })
})
