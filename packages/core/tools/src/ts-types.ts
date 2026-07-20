/**
 * Code Mode codegen: the pure projection from registered tool schemas to the TypeScript SDK
 * text the model programs against (the `tools:sdk` prompt section). Sibling of
 * `json-schema.ts` — `schemas()` (native function calling) and this module (the generated
 * `declare const tools` surface) are two projections of the same store.
 * @module @deepseek-ai/dsh-tools/src/ts-types
 */

import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { assertSupportedJsonSchema } from './json-schema.ts'
import type { JsonSchemaScalar } from './json-schema.ts'

/** Property names that are valid bare TS identifiers; anything else is quoted. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** Render an object key: bare when it is a valid identifier, quoted otherwise (every name stays reachable, no aliasing). */
function renderKey(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name)
}

/** One `indent`-deep line prefix (two spaces per level). */
function pad(indent: number): string {
  return '  '.repeat(indent)
}

/** A one-line JSDoc block for a schema `description`, or no lines when there is none. */
function docLines(description: unknown, indent: number): string[] {
  if (typeof description !== 'string' || description.length === 0) return []
  // Collapse prose to stable one-line docs and escape comment closers so a
  // schema description cannot terminate generated JSDoc.
  const collapsed = description.replace(/\s+/g, ' ').trim()
  return [`${pad(indent)}/** ${collapsed.replaceAll('*/', String.raw`*\/`)} */`]
}

/** Render one scalar already validated by the unified schema boundary. */
function renderScalar(value: JsonSchemaScalar): string {
  return JSON.stringify(value)
}

/** Render a validated scalar `const`/`enum`, falling back to the broad type. */
function renderConstrainedScalar(node: Record<string, unknown>, type: string): string {
  const broad = type === 'integer' ? 'number' : type
  if (Object.hasOwn(node, 'const')) return renderScalar(node.const as JsonSchemaScalar)
  if (Object.hasOwn(node, 'enum')) {
    return (node.enum as JsonSchemaScalar[]).map(renderScalar).join(' | ')
  }
  return broad
}

/** Parenthesize a union or object intersection before applying `[]`. */
function arrayItem(type: string): string {
  return type.includes('|') || type.includes('&') ? `(${type})[]` : `${type}[]`
}

/**
 * Map one enforced JSON-Schema node to a TypeScript type literal. Supports
 * every unified schema construct and returns `unknown` for malformed or
 * unsupported inputs without throwing.
 * @param schema - the JSON-Schema node (any shape; hostile inputs degrade).
 * @param indent - the indentation level for nested object members.
 * @returns the TS type text (multi-line for objects with properties).
 */
export function jsonSchemaToTs(schema: unknown, indent = 0): string {
  try {
    assertSupportedJsonSchema(schema)
  } catch {
    return 'unknown'
  }
  const node = schema as Record<string, unknown>
  if (Object.hasOwn(node, 'oneOf')) {
    return (node.oneOf as unknown[]).map(branch => jsonSchemaToTs(branch, indent)).join(' | ')
  }
  if (!Object.hasOwn(node, 'type')) return 'JsonValue'
  switch (node.type) {
    case 'string': return renderConstrainedScalar(node, 'string')
    case 'number': return renderConstrainedScalar(node, 'number')
    case 'integer': return renderConstrainedScalar(node, 'integer')
    case 'boolean': return renderConstrainedScalar(node, 'boolean')
    case 'null': return renderConstrainedScalar(node, 'null')
    case 'array': {
      return arrayItem(Object.hasOwn(node, 'items') ? jsonSchemaToTs(node.items, indent) : 'JsonValue')
    }
    case 'object': {
      const properties = node.properties
      const open = node.additionalProperties !== false
      if (properties === undefined) return open ? 'Record<string, JsonValue>' : 'Record<string, never>'
      const entries = Object.entries(properties as Record<string, unknown>)
      if (entries.length === 0) return open ? 'Record<string, JsonValue>' : 'Record<string, never>'
      const required = new Set(node.required as string[] | undefined)
      const lines: string[] = ['{']
      for (const [name, prop] of entries) {
        const description = (prop as Record<string, unknown>).description
        lines.push(...docLines(description, indent + 1))
        lines.push(`${pad(indent + 1)}${renderKey(name)}${required.has(name) ? '' : '?'}: ${jsonSchemaToTs(prop, indent + 1)};`)
      }
      lines.push(`${pad(indent)}}`)
      const declared = lines.join('\n')
      return open ? `${declared} & Record<string, JsonValue>` : declared
    }
    /* v8 ignore next -- assertSupportedJsonSchema narrowed this closed type union. */
    default: return 'unknown'
  }
}

/** The fixed model-facing usage contract rendered above the declarations (see the Code Mode Agent Note's "What the model sees"). */
const SDK_INSTRUCTIONS = `## Writing code for run_code

Pass \`run_code\` the body of an async TypeScript function (erasable syntax only — no \`enum\` or namespaces; type annotations are advisory, the code runs type-stripped). Inside the program:

- Call tools as \`await tools.name(args)\` — quoted access for exotic names: \`tools["my-tool"](args)\`. Every call resolves to the tool's text output as a string. Tool arguments must be JSON-serializable.
- A FAILED tool call rejects with an \`Error\` carrying the tool's error text — \`try/catch\` it to handle and continue.
- Calls execute sequentially, even under \`Promise.all\`.
- Emit results with \`return\` and/or \`console.log(...)\`. ONLY what you print or return comes back to you — intermediate tool results never enter the conversation, so extract just what you need.

The available tools:`

/**
 * Render the full `tools:sdk` prompt section: the fixed usage instructions
 * plus one `declare const tools` interface covering every given tool.
 * Deterministic — tools are emitted in lexicographic name order, so an
 * unchanged tool set produces byte-identical text across assemblies.
 * @param schemas - the tool schemas to declare (the caller excludes
 *   `run_code` itself).
 * @returns the complete section text.
 */
export function renderToolsSdk(schemas: ToolSchema[]): string {
  const sorted = [...schemas].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const members: string[] = []
  for (const schema of sorted) {
    members.push(...docLines(schema.description, 1))
    members.push(`${pad(1)}${renderKey(schema.name)}(args: ${jsonSchemaToTs(schema.parameters, 1)}): Promise<string>;`)
  }
  const declaration = members.length > 0
    ? `declare const tools: {\n${members.join('\n')}\n}`
    : 'declare const tools: {}'
  const jsonValue = 'type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }'
  return `${SDK_INSTRUCTIONS}\n\n\`\`\`ts\n${jsonValue}\n\n${declaration}\n\`\`\``
}
