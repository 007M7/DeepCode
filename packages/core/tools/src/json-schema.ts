/**
 * Structured-output JSON Schema subset for subagents and workflows. It supports
 * one scalar `type`; object `properties`/`required`/boolean
 * `additionalProperties`; array `items`; scalar `enum`/`const`; and JSON-valued
 * annotations. Unsupported or misplaced keywords reject rather than being
 * accepted without enforcement, and structured-output roots must be objects.
 * @module dsh-tools/json-schema
 */

import { assertNever, HarnessError } from '@deepseek-ai/dsh-llm'

/** The scalar values `enum`/`const` may carry (finite numbers only). */
export type StructuredScalar = string | number | boolean | null

/** The `type` keywords the subset accepts. */
export type StructuredSchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'

/**
 * One node of the structured-output schema subset. Recursive via `properties`
 * and `items`; see the module doc for the exact keyword semantics.
 */
export interface StructuredSchemaNode {
  type: StructuredSchemaType
  /** Nested property schemas (`type: 'object'` only). */
  properties?: Record<string, StructuredSchemaNode>
  /** Required property names; each must appear in `properties`. */
  required?: string[]
  /** `false` rejects undeclared keys; absent/`true` allows them (JSON Schema default). */
  additionalProperties?: boolean
  /** Item schema (`type: 'array'` only); absent ⇒ any JSON items. */
  items?: StructuredSchemaNode
  /** Allowed values (scalar types only). */
  enum?: StructuredScalar[]
  /** The single allowed value (scalar types only). */
  const?: StructuredScalar
  /** Annotation, ignored for validation. */
  description?: string
  /** Annotation, ignored for validation. */
  title?: string
  /** Annotation, ignored for validation (must still be JSON data). */
  default?: unknown
  /** Annotation, ignored for validation (must still be JSON data). */
  examples?: unknown
}

/** A structured-output schema: an OBJECT-rooted {@link StructuredSchemaNode}. */
export type StructuredOutputSchema = StructuredSchemaNode & { type: 'object' }

/**
 * Thrown by {@link assertSupportedOutputSchema} when a schema falls outside the
 * supported subset. Extends {@link HarnessError} (`code: 'UNSUPPORTED_SCHEMA'`)
 * so seam code and tool results can route on it; `violations` lists every
 * offending path, not just the first.
 */
export class OutputSchemaError extends HarnessError {
  /** The individual violation messages, in walk order. */
  readonly violations: string[]

  constructor(violations: string[]) {
    super(`unsupported output schema: ${violations.join('; ')}`, 'UNSUPPORTED_SCHEMA')
    this.name = 'OutputSchemaError'
    this.violations = violations
  }
}

/** The keywords the subset accepts, checked (`constraint`) or ignored (`annotation`). */
const CONSTRAINT_KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])

const SCHEMA_TYPES: readonly StructuredSchemaType[] = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']

/**
 * Whether a value is a PLAIN JSON object — non-null, non-array, and with a
 * prototype chain of at most one link (`null`-proto, or any realm's
 * `Object.prototype`, whose own prototype is `null`). Realm-agnostic on
 * purpose: a schema materialized in another realm carries THAT realm's
 * `Object.prototype`, which an identity check would wrongly reject. Exotic
 * hosts (`Date`, `Map`, class instances) have longer chains and are rejected —
 * they would serialize lossily (`Date` → string, `Map` → `{}`) instead of
 * failing loud.
 */
function isObjectLike(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === null || Object.getPrototypeOf(proto) === null
}

/** Whether a value is a supported scalar (`enum`/`const` member): string, finite number, boolean, or null. */
function isStructuredScalar(value: unknown): value is StructuredScalar {
  return value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
}

/**
 * Whether a value is JSON data (annotation payloads only): scalars, arrays, and
 * object-likes of such values. Realm-agnostic on purpose (no prototype check) —
 * the schema may have been materialized from another realm; structural JSON-ness
 * is what the wire needs. Cycles are rejected via `seen`.
 */
function isJsonData(value: unknown, seen: Set<object>): boolean {
  if (isStructuredScalar(value)) return true
  // The scalar check above already returned for null, so `object` here is a real object.
  if (typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.every(entry => isJsonData(entry, seen))
    // A non-plain object (Date, Map, class instance) is NOT JSON data even when
    // it has no enumerable values — it would serialize lossily, not loudly.
    if (!isObjectLike(value)) return false
    return Object.values(value).every(entry => isJsonData(entry, seen))
  } finally {
    seen.delete(value)
  }
}

/** Collect subset violations for one schema node (recursive walk). */
function checkSchemaNode(node: unknown, path: string, violations: string[], seen: Set<object>): void {
  if (!isObjectLike(node)) {
    violations.push(`${path} must be a schema object`)
    return
  }
  if (seen.has(node)) {
    violations.push(`${path} is circular`)
    return
  }
  seen.add(node)

  for (const key of Object.keys(node)) {
    if (CONSTRAINT_KEYWORDS.has(key)) continue
    if (ANNOTATION_KEYWORDS.has(key)) {
      if (!isJsonData(node[key], new Set())) violations.push(`${path}.${key} annotation must be JSON data`)
      continue
    }
    violations.push(`${path}.${key} is not a supported keyword (subset: type/properties/required/additionalProperties/items/enum/const + annotations)`)
  }
  if (typeof node.description !== 'undefined' && typeof node.description !== 'string') {
    violations.push(`${path}.description must be a string`)
  }
  if (typeof node.title !== 'undefined' && typeof node.title !== 'string') {
    violations.push(`${path}.title must be a string`)
  }

  const type = node.type
  if (typeof type !== 'string' || !(SCHEMA_TYPES as readonly unknown[]).includes(type)) {
    violations.push(Array.isArray(type)
      ? `${path}.type must be a single type string (type arrays are not supported)`
      : `${path}.type must be one of ${SCHEMA_TYPES.join('/')}`)
    seen.delete(node)
    return
  }
  const schemaType = type as StructuredSchemaType

  // Keywords that only make sense on one type are rejected elsewhere — an
  // `items` on an object (or `properties` on a string) is a schema-author bug
  // the subset surfaces rather than ignores.
  const allowedFor: Record<string, StructuredSchemaType[]> = {
    properties: ['object'],
    required: ['object'],
    additionalProperties: ['object'],
    items: ['array'],
    enum: ['string', 'number', 'integer', 'boolean', 'null'],
    const: ['string', 'number', 'integer', 'boolean', 'null'],
  }
  for (const [key, types] of Object.entries(allowedFor)) {
    if (key in node && !types.includes(schemaType)) {
      violations.push(`${path}.${key} is not supported on type "${schemaType}"`)
    }
  }

  switch (schemaType) {
    case 'object': {
      const properties = node.properties
      if (properties !== undefined) {
        if (!isObjectLike(properties)) {
          violations.push(`${path}.properties must be an object of schemas`)
        } else {
          for (const [key, child] of Object.entries(properties)) {
            checkSchemaNode(child, `${path}.properties.${key}`, violations, seen)
          }
        }
      }
      const required = node.required
      if (required !== undefined) {
        if (!Array.isArray(required) || required.some(entry => typeof entry !== 'string')) {
          violations.push(`${path}.required must be an array of strings`)
        } else {
          const declared = isObjectLike(properties) ? properties : {}
          // The guard above proved every entry is a string.
          for (const key of required as string[]) {
            // Own-property check: `in` would let inherited names (`toString`)
            // satisfy the declared-in-properties contract via the prototype.
            if (!Object.hasOwn(declared, key)) violations.push(`${path}.required names "${key}" which is not in properties`)
          }
        }
      }
      if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') {
        violations.push(`${path}.additionalProperties must be a boolean`)
      }
      break
    }
    case 'array': {
      if (node.items !== undefined) checkSchemaNode(node.items, `${path}.items`, violations, seen)
      break
    }
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null': {
      const allowed = node.enum
      if (allowed !== undefined) {
        if (!Array.isArray(allowed) || allowed.length === 0 || !allowed.every(entry => isStructuredScalar(entry))) {
          violations.push(`${path}.enum must be a non-empty array of scalars`)
        }
      }
      if ('const' in node && !isStructuredScalar(node.const)) {
        violations.push(`${path}.const must be a scalar`)
      }
      break
    }
    /* v8 ignore start -- defensive: schemaType was membership-checked against SCHEMA_TYPES above, so no runtime value reaches here */
    default:
      assertNever(schemaType, 'assertSupportedOutputSchema')
    /* v8 ignore stop */
  }

  seen.delete(node)
}

/**
 * Assert `schema` is a supported {@link StructuredOutputSchema} — object-rooted
 * and entirely within the enforced subset. Throws {@link OutputSchemaError}
 * (`UNSUPPORTED_SCHEMA`) listing EVERY violation; returns (and narrows) on
 * success. Call this at the seam boundary, before any child is created.
 * @param schema - the caller-supplied schema (unknown until asserted).
 * @returns nothing — the assertion signature narrows `schema` to
 * {@link StructuredOutputSchema} in the caller's scope on normal return.
 */
export function assertSupportedOutputSchema(schema: unknown): asserts schema is StructuredOutputSchema {
  const violations: string[] = []
  checkSchemaNode(schema, 'schema', violations, new Set())
  if (violations.length === 0 && (schema as StructuredSchemaNode).type !== 'object') {
    violations.push('schema.type must be "object" (structured output is object-rooted)')
  }
  if (violations.length > 0) throw new OutputSchemaError(violations)
}

/** Collect violations for one value against an (already asserted) schema node. */
function checkValue(node: StructuredSchemaNode, value: unknown, path: string): string[] {
  switch (node.type) {
    case 'object': {
      if (!isObjectLike(value)) return [`"${path}" must be an object`]
      const violations: string[] = []
      const properties = node.properties ?? {}
      // Own-property discipline throughout: JSON carries own enumerable
      // properties only, so an inherited `toString` must not satisfy
      // `required`, dodge `additionalProperties: false`, or be validated as if
      // the value carried it.
      for (const key of node.required ?? []) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) violations.push(`missing required property "${path}.${key}"`)
      }
      for (const [key, child] of Object.entries(properties)) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) continue
        violations.push(...checkValue(child, value[key], `${path}.${key}`))
      }
      if (node.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(properties, key)) violations.push(`"${path}.${key}" is not a declared property (additionalProperties: false)`)
        }
      }
      return violations
    }
    case 'array': {
      if (!Array.isArray(value)) return [`"${path}" must be an array`]
      if (!node.items) return []
      const items = node.items
      return value.flatMap((entry, index) => checkValue(items, entry, `${path}[${index}]`))
    }
    case 'string': {
      if (typeof value !== 'string') return [`"${path}" must be a string`]
      break
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return [`"${path}" must be a finite number`]
      break
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) return [`"${path}" must be an integer`]
      break
    }
    case 'boolean': {
      if (typeof value !== 'boolean') return [`"${path}" must be a boolean`]
      break
    }
    case 'null': {
      if (value !== null) return [`"${path}" must be null`]
      break
    }
    default:
      return assertNever(node.type, 'validateStructuredValue')
  }
  // Scalar constraint checks, shared by every scalar branch above.
  if (node.enum && !node.enum.includes(value)) {
    return [`"${path}" must be one of ${JSON.stringify(node.enum)}`]
  }
  if ('const' in node && value !== node.const) {
    return [`"${path}" must be ${JSON.stringify(node.const)}`]
  }
  return []
}

/**
 * Validate a value against an (already {@link assertSupportedOutputSchema}-
 * asserted) schema. Returns human-readable, path-qualified violation messages
 * — empty means valid. Total: never throws, however malformed the value.
 * @param schema - the asserted schema to check against.
 * @param value - the candidate value (e.g. parsed tool-call arguments).
 * @returns every violation found, in walk order (empty = valid).
 */
export function validateStructuredValue(schema: StructuredOutputSchema, value: unknown): string[] {
  return checkValue(schema, value, 'value')
}
