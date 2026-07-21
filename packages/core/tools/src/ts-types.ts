/**
 * Code Mode codegen: the pure projection from registered tool schemas to the TypeScript SDK
 * text the model programs against (the `tools:sdk` prompt section). Sibling of
 * `json-schema.ts` — `schemas()` (native function calling) and this module (the generated
 * `declare const tools` surface) are two projections of the same store.
 * @module @deepseek-ai/dsh-tools/src/ts-types
 */

import type { ToolSchema } from '@deepseek-ai/dsh-llm'

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

/**
 * Map one JSON-Schema node to a TypeScript type literal. Handles exactly the
 * subset the `defineTool` DSL emits — `object` (`properties` + `required`),
 * `string` (with `enum` → a literal union), `number`, `boolean`, `array`
 * (`items`) — and returns `unknown` for anything else, without throwing.
 * @param schema - the JSON-Schema node (any shape; hostile inputs degrade).
 * @param indent - the indentation level for nested object members.
 * @returns the TS type text (multi-line for objects with properties).
 */
export function jsonSchemaToTs(schema: unknown, indent = 0): string {
  if (typeof schema !== 'object' || schema === null) return 'unknown'
  const node = schema as Record<string, unknown>
  switch (node.type) {
    case 'string': {
      if (Array.isArray(node.enum) && node.enum.length > 0 && node.enum.every(value => typeof value === 'string')) {
        return node.enum.map(value => JSON.stringify(value)).join(' | ')
      }
      return 'string'
    }
    case 'number': return 'number'
    case 'boolean': return 'boolean'
    case 'array': {
      const item = jsonSchemaToTs(node.items, indent)
      // Parenthesize a union item type so `('a' | 'b')[]` parses as intended.
      return item.includes('|') ? `(${item})[]` : `${item}[]`
    }
    case 'object': {
      const properties = node.properties
      if (typeof properties !== 'object' || properties === null) return 'Record<string, unknown>'
      const entries = Object.entries(properties as Record<string, unknown>)
      if (entries.length === 0) return 'Record<string, unknown>'
      const required = new Set(Array.isArray(node.required) ? node.required.filter(name => typeof name === 'string') : [])
      const lines: string[] = ['{']
      for (const [name, prop] of entries) {
        const description = typeof prop === 'object' && prop !== null ? (prop as Record<string, unknown>).description : undefined
        lines.push(...docLines(description, indent + 1))
        lines.push(`${pad(indent + 1)}${renderKey(name)}${required.has(name) ? '' : '?'}: ${jsonSchemaToTs(prop, indent + 1)};`)
      }
      lines.push(`${pad(indent)}}`)
      return lines.join('\n')
    }
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
  return `${SDK_INSTRUCTIONS}\n\n\`\`\`ts\n${declaration}\n\`\`\``
}
