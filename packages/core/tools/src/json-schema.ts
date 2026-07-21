/**
 * Enforced JSON Schema subset shared by tool outputs, generated Code Mode
 * types, subagents, and workflows. The subset accepts any JSON root, an
 * annotation-only schema for unconstrained JSON, one scalar `type`, object
 * `properties`/`required`/boolean `additionalProperties`, array `items`,
 * type-correct scalar `enum`/`const`, and exact-one `oneOf`.
 *
 * Unsupported or misplaced keywords reject rather than being accepted without
 * enforcement. Consumers that require an object root apply
 * {@link assertObjectJsonSchema} at their own boundary.
 * @module dsh-tools/json-schema
 */

import { assertNever, HarnessError } from '@deepseek-ai/dsh-llm'
import { isJsonValue, type JsonValue } from '@deepseek-ai/dsh-session'

/** Scalar JSON values supported by `enum` and `const`. */
export type JsonSchemaScalar = string | number | boolean | null

/** Single-type keywords accepted by the enforced subset. */
export type JsonSchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'

/** Scalar-only schema types accepted by literal constraints. */
type JsonSchemaScalarType = Exclude<JsonSchemaType, 'object' | 'array'>

/**
 * One raw JSON Schema node in the enforced subset. The optional fields express
 * the external wire shape; {@link assertSupportedJsonSchema} rejects invalid
 * combinations before a caller treats the node as trusted.
 */
export interface JsonSchemaNode {
  /** Omit with no constraints for any JSON value, or use `oneOf`. */
  type?: JsonSchemaType
  /** Exactly one branch must validate; at least two branches are required. */
  oneOf?: JsonSchemaNode[]
  /** Nested property schemas (`type: 'object'` only). */
  properties?: Record<string, JsonSchemaNode>
  /** Required property names; each must appear in `properties`. */
  required?: string[]
  /** `false` rejects undeclared keys; absent/`true` follows JSON Schema's open default. */
  additionalProperties?: boolean
  /** Item schema (`type: 'array'` only); absent accepts any JSON item. */
  items?: JsonSchemaNode
  /** Allowed values for a scalar node. */
  enum?: JsonSchemaScalar[]
  /** The single allowed value for a scalar node. */
  const?: JsonSchemaScalar
  /** Annotation, ignored for validation. */
  description?: string
  /** Annotation, ignored for validation. */
  title?: string
  /** Annotation, ignored for validation but required to be lossless JSON. */
  default?: JsonValue
  /** Annotation, ignored for validation but required to be lossless JSON. */
  examples?: JsonValue
}

/** A consumer-constrained object-rooted schema. */
export type ObjectJsonSchema = JsonSchemaNode & { type: 'object' }

/**
 * Thrown when a raw schema falls outside the enforced subset. `violations`
 * lists every offending path instead of stopping at the first author error.
 */
export class JsonSchemaError extends HarnessError {
  /** Individual schema violations in walk order. */
  readonly violations: string[]

  constructor(violations: string[]) {
    super(`unsupported JSON schema: ${violations.join('; ')}`, 'UNSUPPORTED_SCHEMA')
    this.name = 'JsonSchemaError'
    this.violations = violations
  }
}

const CONSTRAINT_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
])
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])
const SCHEMA_TYPES: readonly JsonSchemaType[] = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']

/**
 * Test for a realm-agnostic plain JSON record without accepting arrays or
 * exotic objects.
 * @param value - candidate record from any JavaScript realm.
 * @returns Whether the value has a plain-object prototype chain.
 */
export function isPlainJsonRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === null || Object.getPrototypeOf(proto) === null
}

/** Lossless finite JSON number, excluding negative zero. */
function isJsonNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)
}

/** Whether a scalar is valid for one declared schema type. */
function scalarMatches(type: JsonSchemaScalarType, value: unknown): value is JsonSchemaScalar {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return isJsonNumber(value)
    case 'integer': return isJsonNumber(value) && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    /* v8 ignore next -- JsonSchemaScalarType is closed; this retains compile-time exhaustiveness. */
    default: return assertNever(type, 'JsonSchemaType')
  }
}

/** Collect every violation for one raw schema node. */
function checkSchemaNode(node: unknown, path: string, violations: string[], seen: Set<object>): void {
  if (!isPlainJsonRecord(node)) {
    violations.push(`${path} must be a schema object`)
    return
  }
  if (seen.has(node)) {
    violations.push(`${path} is circular`)
    return
  }
  seen.add(node)
  try {
    for (const key of Object.keys(node)) {
      if (CONSTRAINT_KEYWORDS.has(key)) continue
      if (ANNOTATION_KEYWORDS.has(key)) {
        try {
          if (!isJsonValue(node[key])) violations.push(`${path}.${key} annotation must be lossless JSON data`)
        } catch {
          violations.push(`${path}.${key} annotation must be lossless JSON data`)
        }
        continue
      }
      violations.push(`${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`)
    }
    if (node.description !== undefined && typeof node.description !== 'string') {
      violations.push(`${path}.description must be a string`)
    }
    if (node.title !== undefined && typeof node.title !== 'string') {
      violations.push(`${path}.title must be a string`)
    }

    const hasType = Object.hasOwn(node, 'type')
    const hasOneOf = Object.hasOwn(node, 'oneOf')
    if (hasType && hasOneOf) {
      violations.push(`${path} cannot declare both type and oneOf`)
      return
    }
    if (!hasType && !hasOneOf) {
      for (const key of ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']) {
        if (Object.hasOwn(node, key)) violations.push(`${path}.${key} requires type or oneOf`)
      }
      return
    }

    if (hasOneOf) {
      const oneOf = node.oneOf
      if (!Array.isArray(oneOf) || oneOf.length < 2) {
        violations.push(`${path}.oneOf must be an array of at least two schemas`)
      } else {
        for (let index = 0; index < oneOf.length; index++) {
          checkSchemaNode(oneOf[index], `${path}.oneOf[${index}]`, violations, seen)
        }
      }
      for (const key of ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']) {
        if (Object.hasOwn(node, key)) violations.push(`${path}.${key} is not supported beside oneOf`)
      }
      return
    }

    const type = node.type
    if (typeof type !== 'string' || !(SCHEMA_TYPES as readonly unknown[]).includes(type)) {
      violations.push(Array.isArray(type)
        ? `${path}.type must be a single type string (type arrays are not supported)`
        : `${path}.type must be one of ${SCHEMA_TYPES.join('/')}`)
      return
    }
    const schemaType = type as JsonSchemaType
    const allowedFor: Record<string, JsonSchemaType[]> = {
      properties: ['object'],
      required: ['object'],
      additionalProperties: ['object'],
      items: ['array'],
      enum: ['string', 'number', 'integer', 'boolean', 'null'],
      const: ['string', 'number', 'integer', 'boolean', 'null'],
    }
    for (const [key, types] of Object.entries(allowedFor)) {
      if (Object.hasOwn(node, key) && !types.includes(schemaType)) {
        violations.push(`${path}.${key} is not supported on type "${schemaType}"`)
      }
    }

    switch (schemaType) {
      case 'object': {
        const properties = node.properties
        if (Object.hasOwn(node, 'properties')) {
          if (!isPlainJsonRecord(properties)) {
            violations.push(`${path}.properties must be an object of schemas`)
          } else {
            for (const [key, child] of Object.entries(properties)) {
              checkSchemaNode(child, `${path}.properties.${key}`, violations, seen)
            }
          }
        }
        const required = node.required
        if (Object.hasOwn(node, 'required')) {
          if (!Array.isArray(required) || required.some(entry => typeof entry !== 'string')) {
            violations.push(`${path}.required must be an array of strings`)
          } else {
            const declared = isPlainJsonRecord(properties) ? properties : {}
            for (const key of required as string[]) {
              if (!Object.hasOwn(declared, key)) violations.push(`${path}.required names "${key}" which is not in properties`)
            }
          }
        }
        if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
          violations.push(`${path}.additionalProperties must be a boolean`)
        }
        break
      }
      case 'array': {
        if (Object.hasOwn(node, 'items')) checkSchemaNode(node.items, `${path}.items`, violations, seen)
        break
      }
      case 'string':
      case 'number':
      case 'integer':
      case 'boolean':
      case 'null': {
        const allowed = node.enum
        const enumValid = Array.isArray(allowed)
          && allowed.length > 0
          && allowed.every(entry => scalarMatches(schemaType, entry))
        if (Object.hasOwn(node, 'enum')) {
          if (!enumValid) {
            violations.push(`${path}.enum must be a non-empty array of ${schemaType} values`)
          }
        }
        const constValid = scalarMatches(schemaType, node.const)
        if (Object.hasOwn(node, 'const')) {
          if (!constValid) {
            violations.push(`${path}.const must be a ${schemaType} value`)
          } else if (enumValid && !allowed.includes(node.const as JsonSchemaScalar)) {
            violations.push(`${path}.const must be one of ${path}.enum when both are declared`)
          }
        }
        break
      }
      /* v8 ignore next -- schemaType was narrowed from the closed SCHEMA_TYPES table above. */
      default: assertNever(schemaType, 'JsonSchemaType')
    }
  } finally {
    seen.delete(node)
  }
}

/**
 * Assert that an arbitrary raw schema uses only the enforced subset.
 * Annotation-only schemas are accepted as the standard unconstrained-JSON
 * form; callers that require an object root use {@link assertObjectJsonSchema}.
 * @param schema - untrusted raw JSON Schema.
 * @returns Assertion that the schema belongs to the supported subset.
 */
export function assertSupportedJsonSchema(schema: unknown): asserts schema is JsonSchemaNode {
  const violations: string[] = []
  checkSchemaNode(schema, 'schema', violations, new Set())
  if (violations.length > 0) throw new JsonSchemaError(violations)
}

/**
 * Assert the enforced subset plus the object-root constraint retained by
 * subagent and workflow structured outputs.
 * @param schema - untrusted caller-supplied schema.
 * @returns Assertion that the schema belongs to the supported subset and has an object root.
 */
export function assertObjectJsonSchema(schema: unknown): asserts schema is ObjectJsonSchema {
  const violations: string[] = []
  checkSchemaNode(schema, 'schema', violations, new Set())
  if (violations.length === 0 && (schema as JsonSchemaNode).type !== 'object') {
    violations.push('schema.type must be "object" (structured output is object-rooted)')
  }
  if (violations.length > 0) throw new JsonSchemaError(violations)
}

/** Safely test the lossless JSON boundary when a getter may throw. */
function safelyIsJsonValue(value: unknown): boolean {
  try {
    return isJsonValue(value)
  } catch {
    return false
  }
}

/** Root-aware diagnostic path for the parameter validator's empty sentinel. */
function diagnosticPath(path: string): string {
  return path === '' ? 'arguments' : path
}

/** Append one object property without a leading dot at an implicit root. */
function propertyPath(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`
}

/** Contain hostile getters/proxies so validation remains total for arbitrary values. */
function checkValue(node: JsonSchemaNode, value: unknown, path: string): string[] {
  if (node.type !== undefined && !(SCHEMA_TYPES as readonly unknown[]).includes(node.type)) {
    return checkValueUnchecked(node, value, path)
  }
  try {
    return checkValueUnchecked(node, value, path)
  } catch {
    return [`"${diagnosticPath(path)}" must be a lossless JSON value`]
  }
}

/** Collect value violations for one trusted schema node after the exception boundary. */
function checkValueUnchecked(node: JsonSchemaNode, value: unknown, path: string): string[] {
  if (node.oneOf !== undefined) {
    const matches = node.oneOf.filter(branch => checkValue(branch, value, path).length === 0).length
    return matches === 1 ? [] : [`"${diagnosticPath(path)}" must match exactly one oneOf branch (matched ${matches})`]
  }
  if (node.type === undefined) {
    return safelyIsJsonValue(value) ? [] : [`"${diagnosticPath(path)}" must be a lossless JSON value`]
  }

  switch (node.type) {
    case 'object': {
      if (!isPlainJsonRecord(value)) return [`"${diagnosticPath(path)}" must be an object`]
      const violations: string[] = []
      const properties = node.properties ?? {}
      for (const key of node.required ?? []) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) violations.push(`missing required property "${propertyPath(path, key)}"`)
      }
      for (const [key, child] of Object.entries(properties)) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) continue
        violations.push(...checkValue(child, value[key], propertyPath(path, key)))
      }
      if (node.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(properties, key)) violations.push(`"${propertyPath(path, key)}" is not a declared property (additionalProperties: false)`)
        }
      }
      if (violations.length > 0) return violations
      return safelyIsJsonValue(value) ? [] : [`"${diagnosticPath(path)}" must be a lossless JSON object`]
    }
    case 'array': {
      if (!Array.isArray(value)) return [`"${diagnosticPath(path)}" must be an array`]
      const items = node.items
      const violations = items === undefined
        ? []
        : value.flatMap((entry, index) => checkValue(items, entry, `${path}[${index}]`))
      if (violations.length > 0) return violations
      return safelyIsJsonValue(value) ? [] : [`"${diagnosticPath(path)}" must be a dense lossless JSON array`]
    }
    case 'string': {
      if (typeof value !== 'string') return [`"${diagnosticPath(path)}" must be a string`]
      break
    }
    case 'number': {
      if (typeof value !== 'number') return [`"${diagnosticPath(path)}" must be a number`]
      if (!isJsonNumber(value)) return [`"${diagnosticPath(path)}" must be a finite JSON number`]
      break
    }
    case 'integer': {
      if (!isJsonNumber(value) || !Number.isInteger(value)) return [`"${diagnosticPath(path)}" must be an integer`]
      break
    }
    case 'boolean': {
      if (typeof value !== 'boolean') return [`"${diagnosticPath(path)}" must be a boolean`]
      break
    }
    case 'null': {
      if (value !== null) return [`"${diagnosticPath(path)}" must be null`]
      break
    }
    default: return assertNever(node.type, 'JsonSchemaType')
  }
  if (node.enum !== undefined && !node.enum.includes(value)) {
    return [`"${diagnosticPath(path)}" must be one of ${JSON.stringify(node.enum)}`]
  }
  if (Object.hasOwn(node, 'const') && value !== node.const) {
    return [`"${diagnosticPath(path)}" must be ${JSON.stringify(node.const)}`]
  }
  return []
}

/**
 * Validate a candidate value against an asserted raw schema. The function is
 * total for arbitrary values and returns path-qualified violations.
 * @param schema - a schema accepted by {@link assertSupportedJsonSchema}.
 * @param value - the candidate JSON value.
 * @param path - root label used in diagnostics.
 * @returns All violations in walk order; empty means valid.
 */
export function validateJsonSchemaValue(schema: JsonSchemaNode, value: unknown, path = 'value'): string[] {
  return checkValue(schema, value, path)
}
