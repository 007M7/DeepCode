/**
 * Typed tool-parameter schema DSL.
 *
 * Plugin authors write per-property specs with `required: true` as a boolean
 * (the `SchemaSpec` type). A type-level helper (`InferArgs`) maps a SchemaSpec
 * to the TS argument type. At runtime, `schemaSpecToJsonSchema()` converts a
 * SchemaSpec to standard JSON Schema (`type: 'object'`, `properties`,
 * `required` array) for the wire format sent to the model.
 *
 * # Why a custom DSL and not schemastery?
 *
 * Schemastery is a validation/transformation library (StandardSchema v1) used
 * for plugin Config. Tool parameters need JSON Schema specifically (the LLM
 * wire format), not validation. A lightweight DSL focused on JSON Schema
 * generation, with type inference for the tool's `execute` args, gives plugin
 * authors the best DX with the smallest surface area. Schemastery would add
 * unnecessary indirection and wouldn't cleanly produce JSON Schema.
 *
 * @module dsh-tools/schema
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolExecution } from './index.ts'

// ---------------------------------------------------------------------------
// SchemaSpec — the author-facing per-property type
// ---------------------------------------------------------------------------

/** Valid JSON Schema primitive types for tool parameters. */
export type SchemaType = 'string' | 'number' | 'boolean' | 'object' | 'array'

/** One schema-spec property entry. */
export interface SchemaProp {
  type: SchemaType
  /** Per-property required flag (NOT the JSON Schema top-level required array). */
  required?: true
  /** Human-readable description, surfaced in the JSON Schema as well. */
  description?: string
  /** Enum of allowed values (strings only). */
  enum?: string[]
  /** Default value. */
  default?: unknown
  /** Nested properties for type: 'object'. */
  properties?: SchemaSpec
  /** Items schema for type: 'array'. */
  items?: SchemaProp
}

/**
 * The author-facing parameter schema: a shallow map of property name to
 * {@link SchemaProp}. Required-ness is a per-property boolean (`required:
 * true`), not a separate array.
 */
export type SchemaSpec = Record<string, SchemaProp>

// ---------------------------------------------------------------------------
// InferArgs — type-level mapping from SchemaSpec to TS argument type
// ---------------------------------------------------------------------------

/** Map a {@link SchemaType} to its TS primitive type. */
type TypeOf<T extends SchemaType> =
  T extends 'string' ? string :
  T extends 'number' ? number :
  T extends 'boolean' ? boolean :
  T extends 'object' ? Record<string, unknown> :
  T extends 'array' ? unknown[] :
  never

/** Flatten an intersection into one object type for readable hovers. */
type Simplify<T> = { [K in keyof T]: T[K] } & {}

/** Keys of `S` whose prop is marked `required: true`. */
type RequiredKeys<S extends SchemaSpec> =
  { [K in keyof S]: S[K] extends { required: true } ? K : never }[keyof S]

/**
 * The VALUE type of one {@link SchemaProp} — optionality is handled at the
 * key level by {@link InferArgs}, never here.
 * - `properties` on 'object' → recurse into the nested SchemaSpec
 * - `items` on 'array' → recurse into the item prop (arrays of objects work)
 * - otherwise → the primitive for `type`
 */
type InferPropValue<P extends SchemaProp> =
  P extends { type: 'object'; properties: infer Sub extends SchemaSpec } ? InferArgs<Sub> :
  P extends { type: 'array'; items: infer Item extends SchemaProp } ? InferPropValue<Item>[] :
  TypeOf<P['type']>

/**
 * Infer the TS argument type for a complete {@link SchemaSpec}.
 *
 * Properties marked `required: true` are required keys; all others are
 * genuinely optional keys (`?`), so callers may omit them entirely.
 *
 * Example:
 * ```ts
 * type Args = InferArgs<{ path: { type: 'string'; required: true }; limit: { type: 'number' } }>
 * // → { path: string; limit?: number }
 * ```
 */
export type InferArgs<S extends SchemaSpec> = Simplify<
  & { [K in RequiredKeys<S>]: InferPropValue<S[K]> }
  & { [K in Exclude<keyof S, RequiredKeys<S>>]?: InferPropValue<S[K]> }
>

// ---------------------------------------------------------------------------
// Runtime conversion: SchemaSpec → JSON Schema
// ---------------------------------------------------------------------------

/**
 * Convert a single {@link SchemaProp} to its JSON Schema `properties` entry.
 * The per-property `required` flag is collected; the caller builds the
 * top-level `required` array.
 */
function propToJsonSchema(prop: SchemaProp): { schema: Record<string, unknown>; required: boolean } {
  const result: Record<string, unknown> = { type: prop.type }
  if (prop.description) result.description = prop.description
  if (prop.enum) result.enum = prop.enum
  if (prop.default !== undefined) result.default = prop.default

  let required = prop.required === true

  if (prop.type === 'object' && prop.properties) {
    const nested = schemaSpecToJsonSchema(prop.properties)
    result.properties = nested.properties
    if (nested.required && nested.required.length > 0) {
      result.required = nested.required
    }
  }

  if (prop.type === 'array' && prop.items) {
    const { schema: itemsSchema } = propToJsonSchema(prop.items)
    result.items = itemsSchema
  }

  return { schema: result, required }
}

/** The return type of {@link schemaSpecToJsonSchema}. */
export interface JsonSchemaObject {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
}

/**
 * Convert a {@link SchemaSpec} to standard JSON Schema (`type: 'object'`,
 * `properties`, `required` array).
 *
 * This is a plain function — no schemastery or other framework dependency.
 */
export function schemaSpecToJsonSchema(spec: SchemaSpec): JsonSchemaObject {
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  for (const [key, prop] of Object.entries(spec)) {
    const { schema, required: isRequired } = propToJsonSchema(prop)
    properties[key] = schema
    if (isRequired) required.push(key)
  }

  const result: JsonSchemaObject = {
    type: 'object',
    properties,
  }
  if (required.length > 0) result.required = required

  return result
}

// ---------------------------------------------------------------------------
// defineTool — typed helper for first-party plugin authors
// ---------------------------------------------------------------------------

/** Options for {@link defineTool}. */
export interface DefineToolOptions<S extends SchemaSpec> {
  /** Tool name (must be unique). */
  name: string
  /** Human-readable description sent to the model. */
  description: string
  /**
   * Parameter schema using the per-property-required DSL. Converted to
   * standard JSON Schema at runtime.
   */
  parameters: S
  /**
   * Tool execution function. `args` is typed as {@link InferArgs<S>} — zero
   * casts needed.
   */
  execute(args: InferArgs<S>, exec: ToolExecution): Promise<ContentBlock[]>
  /** Whether the tool requires structured output (default false). */
  strict?: boolean
}

/**
 * Define a tool with a typed parameter schema.
 *
 * Use this instead of constructing a raw {@link ToolDefinition} for all
 * first-party tools. The `parameters` use the boolean-required style
 * (`required: true` as a per-property flag), and `execute` receives typed
 * args derived from the schema.
 *
 * ```ts
 * const tool = defineTool({
 *   name: 'read_file',
 *   description: 'Read a file from disk.',
 *   parameters: {
 *     path: { type: 'string', required: true, description: 'Absolute file path' },
 *     offset: { type: 'number' },
 *     limit: { type: 'number', description: 'Max lines to read' },
 *   },
 *   async execute(args) {
 *     // args: { path: string; offset?: number; limit?: number }
 *   },
 * })
 * ```
 *
 * Raw JSON-Schema tool definitions (from MCP servers) are still accepted
 * by `ToolRegistry.register()` directly — `defineTool` is sugar for
 * first-party plugin authors.
 */
export function defineTool<S extends SchemaSpec>(options: DefineToolOptions<S>): ToolDefinition {
  return {
    name: options.name,
    description: options.description,
    parameters: schemaSpecToJsonSchema(options.parameters) as unknown as Record<string, unknown>,
    strict: options.strict,
    execute: options.execute as ToolDefinition['execute'],
  }
}
