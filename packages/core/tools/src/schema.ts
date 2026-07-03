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
import { assertNever, HarnessError } from '@deepseek-ai/dsh-llm'
import type { ToolCallView, ToolDefinition, ToolExecution, ToolResult, ToolResultView } from './index.ts'

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
  /**
   * Default value, emitted into the JSON Schema only (validation never applies
   * it — see the validator note below).
   *
   * XXX(unused-default): no tool definition in the repo sets `default`; it rides
   * into the wire schema for a model that no tool surfaces it to. Drop the field
   * and its converter line unless a real tool needs a model-visible default.
   */
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

  const required = prop.required === true

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
// Runtime validation: model-generated args ↔ SchemaSpec
// ---------------------------------------------------------------------------

/**
 * Thrown by a {@link defineTool} tool when the model-generated arguments don't
 * match the declared {@link SchemaSpec}. Extends {@link HarnessError}
 * (`code: 'INVALID_ARGS'`); the registry's execute waterfall catches it and
 * returns an `isError` ToolExecutionResult carrying the structured error, so
 * the model can self-correct and downstream plugins can route on the code.
 */
export class ToolArgsError extends HarnessError {
  /** The individual violation messages, in declaration order. */
  readonly violations: string[]

  constructor(violations: string[]) {
    super(`invalid arguments: ${violations.join('; ')}`, 'INVALID_ARGS')
    this.name = 'ToolArgsError'
    this.violations = violations
  }
}

/** Whether a value is a non-null, non-array object (a JSON Schema `object`). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Collect violations for one property value against its {@link SchemaProp}. */
function checkValue(prop: SchemaProp, value: unknown, path: string): string[] {
  switch (prop.type) {
    case 'string': {
      if (typeof value !== 'string') return [`"${path}" must be a string`]
      break
    }
    case 'number': {
      if (typeof value !== 'number') return [`"${path}" must be a number`]
      break
    }
    case 'boolean': {
      if (typeof value !== 'boolean') return [`"${path}" must be a boolean`]
      break
    }
    case 'object': {
      if (!isPlainObject(value)) return [`"${path}" must be an object`]
      // Mirror the converter: an object without `properties` only type-checks.
      return prop.properties ? checkSpec(prop.properties, value, path) : []
    }
    case 'array': {
      if (!Array.isArray(value)) return [`"${path}" must be an array`]
      // Mirror the converter: an array without `items` only type-checks.
      if (!prop.items) return []
      const items = prop.items
      return value.flatMap((el, i) => checkValue(items, el, `${path}[${i}]`))
    }
    default: return assertNever(prop.type, 'validateArgs')
  }
  // Enum membership, checked uniformly: the converter emits `enum` for any
  // type ([prop.enum]), so the validator must too. `enum` is `string[]`, so a
  // non-string value can never be a member — it falls out here, consistent
  // with the schema the model was given.
  if (prop.enum && !(prop.enum as unknown[]).includes(value)) {
    return [`"${path}" must be one of ${JSON.stringify(prop.enum)}`]
  }
  return []
}

/** Collect violations for an object value against a {@link SchemaSpec}. */
function checkSpec(spec: SchemaSpec, value: unknown, path: string): string[] {
  if (!isPlainObject(value)) return [`"${path || 'arguments'}" must be an object`]
  const violations: string[] = []
  for (const [key, prop] of Object.entries(spec)) {
    const propPath = path ? `${path}.${key}` : key
    const v = value[key]
    if (v === undefined) {
      // A required key absent OR present-but-undefined is a violation; an
      // optional absent key is fine. `default` is NOT applied (validation only).
      if (prop.required === true) violations.push(`missing required property "${propPath}"`)
      continue
    }
    violations.push(...checkValue(prop, v, propPath))
  }
  return violations
}

/**
 * Validate model-generated `args` against a {@link SchemaSpec}, returning a
 * list of human-readable violation messages (empty = valid). Total — never
 * throws, regardless of how malformed `args` is.
 *
 * Semantics mirror {@link schemaSpecToJsonSchema} exactly: the top level must
 * be a non-array object; required keys come only from `required: true`; extra
 * keys are allowed (no `additionalProperties: false`); `default` is not
 * applied; an `object`/`array` prop without `properties`/`items` only
 * type-checks; `enum` is membership (strings only).
 */
export function validateArgs(spec: SchemaSpec, args: unknown): string[] {
  return checkSpec(spec, args, '')
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
  /**
   * Optional: how to present the PENDING state of one call in a UI (an editor
   * tool-call card, a CLI log line). `args` is the typed, schema-validated
   * argument shape — zero casts. Pure and side-effect-free: a UI may call it
   * during live streaming AND a session-log replay, so depend only on `args`.
   * The tool owns its presentation so a UI never special-cases tool names. See
   * {@link ToolCallView}.
   */
  presentCall?(args: InferArgs<S>): ToolCallView | undefined
  /**
   * Optional: how to present the COMPLETED state, given the typed `args` and the
   * `result`. Use it to reformat result content for a UI distinctly from the
   * model-facing text (e.g. a fenced ```console block). Pure and side-effect-
   * free for the same replay reason. See {@link ToolResultView}.
   */
  presentResult?(args: InferArgs<S>, result: ToolResult): ToolResultView | undefined
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
  // Object-literal execute methods don't use `this`; the reference is safe.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const userExecute = options.execute
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const userPresentCall = options.presentCall
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const userPresentResult = options.presentResult
  const tool: ToolDefinition = {
    name: options.name,
    description: options.description,
    parameters: schemaSpecToJsonSchema(options.parameters) as unknown as Record<string, unknown>,
    ...options.strict !== undefined ? { strict: options.strict } : {},
    async execute(args: unknown, exec: ToolExecution): Promise<ContentBlock[]> {
      // Validate the model-generated args before the typed body runs. On
      // mismatch we throw ToolArgsError; the registry turns it into an
      // isError result so the model can self-correct. After this guard, the
      // cast to InferArgs<S> reflects the validated shape.
      const violations = validateArgs(options.parameters, args)
      if (violations.length > 0) throw new ToolArgsError(violations)
      return userExecute(args as InferArgs<S>, exec)
    },
  }
  // Presentation is display-only and may run on REPLAY of arbitrary logged args
  // (possibly from an older schema), so it must never throw: validate softly and
  // fall back to `undefined` (a generic UI presentation) on any mismatch, rather
  // than the hard `ToolArgsError` the execute path raises.
  if (userPresentCall) {
    tool.presentCall = (args: unknown): ToolCallView | undefined => {
      if (validateArgs(options.parameters, args).length > 0) return undefined
      return userPresentCall(args as InferArgs<S>)
    }
  }
  if (userPresentResult) {
    tool.presentResult = (args: unknown, result: ToolResult): ToolResultView | undefined => {
      if (validateArgs(options.parameters, args).length > 0) return undefined
      return userPresentResult(args as InferArgs<S>, result)
    }
  }
  return tool
}
