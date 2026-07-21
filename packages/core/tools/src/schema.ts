/** Unified JSON-value schema DSL, inference, compilation, and typed tool helper. @module dsh-tools/schema */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { ToolDefinition, ToolExecuteReturn, ToolRunContext, ToolResult } from './index.ts'
import { assertSupportedJsonSchema, isPlainJsonRecord, JsonSchemaError, validateJsonSchemaValue } from './json-schema.ts'
import type { JsonSchemaNode, JsonSchemaScalar, ObjectJsonSchema } from './json-schema.ts'
import type { ToolCallView, ToolResultView } from './presentation.ts'

/** Annotation keywords shared by every author-facing schema node. */
export interface ValueSchemaAnnotations {
  /** Human-readable description projected into JSON Schema and generated types. */
  description?: string
  /** Human-readable title projected into JSON Schema. */
  title?: string
  /** Non-validating default annotation; it must be lossless JSON data. */
  default?: JsonValue
  /** Non-validating examples annotation; it must be lossless JSON data. */
  examples?: JsonValue
}

/** String value schema with type-correct literal constraints. */
export interface StringValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'string'
  enum?: readonly string[]
  const?: string
}

/** Finite JSON-number schema with type-correct literal constraints. */
export interface NumberValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'number'
  enum?: readonly number[]
  const?: number
}

/** Integer schema with type-correct literal constraints. */
export interface IntegerValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'integer'
  enum?: readonly number[]
  const?: number
}

/** Boolean value schema with type-correct literal constraints. */
export interface BooleanValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'boolean'
  enum?: readonly boolean[]
  const?: boolean
}

/** Null value schema with type-correct literal constraints. */
export interface NullValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'null'
  enum?: readonly null[]
  const?: null
}

/** Array value schema; omitted `items` accepts any lossless JSON item. */
export interface ArrayValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'array'
  items?: ValueSchemaSpec
}

/**
 * Explicit object value schema. Openness is mandatory so a nested or output
 * object never acquires an accidental JSON Schema default.
 */
export interface ObjectValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'object'
  properties?: ParameterSchemaSpec
  additionalProperties: boolean
}

/** Author-only unconstrained lossless JSON node. */
export interface JsonValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'json'
}

/** Exact-one union schema; at least two branches are required. */
export interface OneOfValueSchemaSpec extends ValueSchemaAnnotations {
  oneOf: readonly [ValueSchemaSpec, ValueSchemaSpec, ...ValueSchemaSpec[]]
}

/** One author-facing schema for any lossless JSON value root. */
export type ValueSchemaSpec =
  | StringValueSchemaSpec
  | NumberValueSchemaSpec
  | IntegerValueSchemaSpec
  | BooleanValueSchemaSpec
  | NullValueSchemaSpec
  | ArrayValueSchemaSpec
  | ObjectValueSchemaSpec
  | JsonValueSchemaSpec
  | OneOfValueSchemaSpec

/** One implicit parameter-root property, optionally required. */
export type ParameterPropertySpec = ValueSchemaSpec & { required?: true }

/**
 * Tool parameter schema. The map itself is an implicit open object root;
 * requiredness remains a per-property `required: true` annotation.
 */
export type ParameterSchemaSpec = Record<string, ParameterPropertySpec>

/** Raw JSON Schema projection of the implicit parameter object. */
export interface ParameterJsonSchema extends ObjectJsonSchema {
  properties: Record<string, JsonSchemaNode>
}

/** Flatten an intersection into one object type for readable hovers. */
type Simplify<T> = { [K in keyof T]: T[K] } & {}

/** Keys of a property map marked `required: true`. */
type RequiredKeys<S extends ParameterSchemaSpec> = {
  [K in keyof S]: S[K] extends { required: true } ? K : never
}[keyof S]

/** Infer the declared value of one parameter property without key optionality. */
type InferProperty<P extends ParameterPropertySpec> = P extends ValueSchemaSpec ? InferValue<P> : never

/** Infer an implicit property map into required and optional object keys. */
type InferProperties<S extends ParameterSchemaSpec> = Simplify<
  & { [K in RequiredKeys<S>]: InferProperty<S[K]> }
  & { [K in Exclude<keyof S, RequiredKeys<S>>]?: InferProperty<S[K]> }
>

/** Infer an explicit object node, including its declared openness. */
type InferObject<S extends ObjectValueSchemaSpec> =
  S extends { properties: infer P extends ParameterSchemaSpec }
    ? S['additionalProperties'] extends true
      ? InferProperties<P> & Record<string, JsonValue>
      : InferProperties<P>
    : S['additionalProperties'] extends true
      ? Record<string, JsonValue>
      : Record<string, never>

/** Infer a scalar node's literal constraint before its broad primitive type. */
type InferScalar<S, Fallback> =
  S extends { const: infer C } ? C :
    S extends { enum: readonly (infer E)[] } ? E :
      Fallback

/**
 * Infer the TypeScript value accepted by an author-facing value schema.
 * Output schemas may therefore infer object, array, scalar, or null roots.
 */
export type InferValue<S extends ValueSchemaSpec> =
  S extends StringValueSchemaSpec ? InferScalar<S, string> :
    S extends NumberValueSchemaSpec | IntegerValueSchemaSpec ? InferScalar<S, number> :
      S extends BooleanValueSchemaSpec ? InferScalar<S, boolean> :
        S extends NullValueSchemaSpec ? null :
          S extends ArrayValueSchemaSpec
            ? S extends { items: infer I extends ValueSchemaSpec } ? InferValue<I>[] : JsonValue[]
            : S extends ObjectValueSchemaSpec ? InferObject<S> :
              S extends JsonValueSchemaSpec ? JsonValue :
                S extends OneOfValueSchemaSpec ? InferValue<S['oneOf'][number]> :
                  never

/** Infer the TypeScript argument object for an implicit parameter schema. */
export type InferArgs<S extends ParameterSchemaSpec> = InferProperties<S>

const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples'] as const

/** Throw one author-schema violation through the shared schema error type. */
function authorError(message: string): never {
  throw new JsonSchemaError([message])
}

/** Copy own annotation fields for validation by the raw-schema boundary. */
function copyAnnotations(source: Record<string, unknown>, target: JsonSchemaNode): void {
  if (Object.hasOwn(source, 'description')) target.description = source.description as string
  if (Object.hasOwn(source, 'title')) target.title = source.title as string
  if (Object.hasOwn(source, 'default')) target.default = source.default as JsonValue
  if (Object.hasOwn(source, 'examples')) target.examples = source.examples as JsonValue
}

/** Reject author-only keys outside one node's declared vocabulary. */
function assertAuthorKeys(source: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) authorError(`${path}.${key} is not supported by the value schema DSL`)
  }
}

/** Compile one implicit property map, collecting per-property requiredness. */
function compilePropertyMap(
  input: unknown,
  path: string,
  seen: Set<object>,
): { properties: Record<string, JsonSchemaNode>; required?: string[] } {
  if (!isPlainJsonRecord(input)) authorError(`${path} must be an object of value schemas`)
  if (seen.has(input)) authorError(`${path} is circular`)
  seen.add(input)
  try {
    const properties: Record<string, JsonSchemaNode> = {}
    const required: string[] = []
    for (const [key, property] of Object.entries(input)) {
      if (!isPlainJsonRecord(property)) authorError(`${path}.${key} must be a value schema object`)
      if (Object.hasOwn(property, 'required') && property.required !== true) {
        authorError(`${path}.${key}.required must be true when present`)
      }
      Object.defineProperty(properties, key, {
        value: compileValueSchema(property, `${path}.${key}`, seen, true),
        enumerable: true,
        configurable: true,
        writable: true,
      })
      if (property.required === true) required.push(key)
    }
    return required.length > 0 ? { properties, required } : { properties }
  } finally {
    seen.delete(input)
  }
}

/** Compile one author node without applying any consumer root restriction. */
function compileValueSchema(
  input: unknown,
  path: string,
  seen: Set<object>,
  allowRequired = false,
): JsonSchemaNode {
  if (!isPlainJsonRecord(input)) authorError(`${path} must be a value schema object`)
  if (seen.has(input)) authorError(`${path} is circular`)
  seen.add(input)
  try {
    const authorKeys = [...ANNOTATION_KEYS, ...(allowRequired ? ['required'] : [])]
    const node: JsonSchemaNode = {}

    if (Object.hasOwn(input, 'oneOf')) {
      assertAuthorKeys(input, path, [...authorKeys, 'oneOf', 'type'])
      if (Object.hasOwn(input, 'type')) authorError(`${path} cannot declare both type and oneOf`)
      if (!Array.isArray(input.oneOf)) authorError(`${path}.oneOf must be an array of at least two value schemas`)
      node.oneOf = input.oneOf.map((branch, index) => compileValueSchema(branch, `${path}.oneOf[${index}]`, seen))
      copyAnnotations(input, node)
      return node
    }

    switch (input.type) {
      case 'json':
        assertAuthorKeys(input, path, [...authorKeys, 'type'])
        copyAnnotations(input, node)
        return node
      case 'object': {
        assertAuthorKeys(input, path, [...authorKeys, 'type', 'properties', 'additionalProperties'])
        if (!Object.hasOwn(input, 'additionalProperties') || typeof input.additionalProperties !== 'boolean') {
          authorError(`${path}.additionalProperties must be explicitly true or false`)
        }
        node.type = 'object'
        copyAnnotations(input, node)
        node.additionalProperties = input.additionalProperties
        if (Object.hasOwn(input, 'properties')) {
          const compiled = compilePropertyMap(input.properties, `${path}.properties`, seen)
          node.properties = compiled.properties
          if (compiled.required !== undefined) node.required = compiled.required
        }
        return node
      }
      case 'array':
        assertAuthorKeys(input, path, [...authorKeys, 'type', 'items'])
        node.type = 'array'
        copyAnnotations(input, node)
        if (Object.hasOwn(input, 'items')) node.items = compileValueSchema(input.items, `${path}.items`, seen)
        return node
      case 'string':
      case 'number':
      case 'integer':
      case 'boolean':
      case 'null':
        assertAuthorKeys(input, path, [...authorKeys, 'type', 'enum', 'const'])
        node.type = input.type
        copyAnnotations(input, node)
        if (Object.hasOwn(input, 'enum')) {
          node.enum = Array.isArray(input.enum)
            ? Array.from(input.enum as unknown[], entry => entry as JsonSchemaScalar)
            : input.enum as JsonSchemaScalar[]
        }
        if (Object.hasOwn(input, 'const')) node.const = input.const as JsonSchemaScalar
        return node
      default:
        return authorError(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`)
    }
  } finally {
    seen.delete(input)
  }
}

/**
 * Compile one author-facing value schema to the enforced raw JSON Schema
 * subset. The author-only `json` node becomes an annotation-only schema.
 * @param spec - schema for any JSON-value root.
 * @returns The asserted raw schema projection.
 */
export function valueSchemaSpecToJsonSchema(spec: ValueSchemaSpec): JsonSchemaNode {
  const schema = compileValueSchema(spec, 'schema', new Set())
  assertSupportedJsonSchema(schema)
  return schema
}

/**
 * Compile the implicit open parameter object into raw JSON Schema.
 * @param spec - per-property parameter definitions.
 * @returns An object-rooted raw schema with no implicit-root openness override.
 */
export function parameterSchemaSpecToJsonSchema(spec: ParameterSchemaSpec): ParameterJsonSchema {
  const compiled = compilePropertyMap(spec, 'parameters', new Set())
  const schema: ParameterJsonSchema = {
    type: 'object',
    properties: compiled.properties,
    ...(compiled.required === undefined ? {} : { required: compiled.required }),
  }
  assertSupportedJsonSchema(schema)
  return schema
}

/** Invalid model-generated arguments for a typed tool. */
export class ToolArgsError extends HarnessError {
  /** Individual violations in schema-walk order. */
  readonly violations: string[]

  constructor(violations: string[]) {
    super(`invalid arguments: ${violations.join('; ')}`, 'INVALID_ARGS')
    this.name = 'ToolArgsError'
    this.violations = violations
  }
}

/**
 * Validate model-generated arguments against an implicit parameter schema.
 * @param spec - declared parameter schema.
 * @param args - candidate arguments, however malformed.
 * @returns Path-qualified violations; empty means valid.
 */
export function validateArgs(spec: ParameterSchemaSpec, args: unknown): string[] {
  return validateJsonSchemaValue(parameterSchemaSpecToJsonSchema(spec), args, '')
}

/** Options for {@link defineTool}. */
export interface DefineToolOptions<S extends ParameterSchemaSpec> {
  /** Tool name (must be unique). */
  readonly name: string
  /** Human-readable description sent to the model. */
  readonly description: string
  /** Per-property parameter schema compiled to an implicit open object root. */
  readonly parameters: S
  /** Optional positive cooperative timeout budget in milliseconds. */
  readonly timeoutMs?: number
  /**
   * Pure classifier for sibling overlap.
   * @param args - typed validated arguments.
   * @returns Whether the call may join a parallel group.
   */
  isConcurrencySafe?(args: InferArgs<S>): boolean
  /**
   * Execute the tool after argument validation.
   * @param args - typed validated arguments.
   * @param exec - execution identity, caller, cancellation, and nesting data.
   * @returns Model-facing content and optional presentation metadata.
   */
  execute(args: InferArgs<S>, exec: ToolRunContext): Promise<ToolExecuteReturn>
  /**
   * Pure pending-state presenter.
   * @param args - typed validated arguments.
   * @returns Tool-owned render intent, or `undefined` for the generic card.
   */
  presentCall?(args: InferArgs<S>): ToolCallView | undefined
  /**
   * Pure completed-state presenter.
   * @param args - typed validated arguments.
   * @param result - final model-facing tool result.
   * @returns Tool-owned render intent, or `undefined` for the generic card.
   */
  presentResult?(args: InferArgs<S>, result: ToolResult): ToolResultView | undefined
}

/**
 * Define a first-party tool with inferred arguments and strict execution
 * validation. Replay-only presenters validate softly and fall back to generic
 * rendering for obsolete logged arguments.
 * @param options - typed definition and optional presenters.
 * @returns A registry-ready definition.
 */
export function defineTool<const S extends ParameterSchemaSpec>(options: DefineToolOptions<S>): ToolDefinition {
  // Object-literal methods do not use `this`; retaining references is safe.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const userExecute = options.execute
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const userPresentCall = options.presentCall
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const userPresentResult = options.presentResult
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const userIsConcurrencySafe = options.isConcurrencySafe
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`)
  }
  const parameters = parameterSchemaSpecToJsonSchema(options.parameters)
  const validate = (args: unknown): string[] => validateJsonSchemaValue(parameters, args, '')
  const tool: ToolDefinition = {
    name: options.name,
    description: options.description,
    parameters: parameters as unknown as Record<string, unknown>,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    async execute(args: unknown, exec: ToolRunContext): Promise<ToolExecuteReturn> {
      const violations = validate(args)
      if (violations.length > 0) throw new ToolArgsError(violations)
      return userExecute(args as InferArgs<S>, exec)
    },
  }
  if (userPresentCall) {
    tool.presentCall = (args: unknown): ToolCallView | undefined => {
      if (validate(args).length > 0) return undefined
      return userPresentCall(args as InferArgs<S>)
    }
  }
  if (userPresentResult) {
    tool.presentResult = (args: unknown, result: ToolResult): ToolResultView | undefined => {
      if (validate(args).length > 0) return undefined
      return userPresentResult(args as InferArgs<S>, result)
    }
  }
  if (userIsConcurrencySafe) {
    tool.isConcurrencySafe = (args: unknown): boolean => {
      if (validate(args).length > 0) return false
      return userIsConcurrencySafe(args as InferArgs<S>)
    }
  }
  return tool
}
