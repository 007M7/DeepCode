import { describe, expect, it } from 'vitest'
import {
  assertSupportedOutputSchema,
  OutputSchemaError,
  validateStructuredValue,
  type StructuredOutputSchema,
} from '../src/json-schema.ts'

/** Assert-and-narrow helper: the asserted schema, typed. */
function asserted(schema: unknown): StructuredOutputSchema {
  assertSupportedOutputSchema(schema)
  return schema
}

/** The violations OutputSchemaError carries for a bad schema (throws if it passes). */
function violationsOf(schema: unknown): string[] {
  try {
    assertSupportedOutputSchema(schema)
  } catch (error: unknown) {
    if (error instanceof OutputSchemaError) return error.violations
    throw error
  }
  throw new Error('expected the schema to be rejected')
}

describe('assertSupportedOutputSchema', () => {
  it('accepts a representative subset schema (all supported keywords)', () => {
    const schema = asserted({
      type: 'object',
      description: 'a finding',
      title: 'Finding',
      properties: {
        file: { type: 'string', description: 'path' },
        line: { type: 'integer' },
        severity: { type: 'string', enum: ['low', 'high'] },
        kind: { type: 'string', const: 'bug' },
        score: { type: 'number' },
        confirmed: { type: 'boolean' },
        parent: { type: 'null' },
        tags: { type: 'array', items: { type: 'string' } },
        nested: {
          type: 'object',
          properties: { x: { type: 'number', default: 3, examples: [1, 2] } },
          additionalProperties: false,
        },
        anything: { type: 'array' },
      },
      required: ['file', 'line'],
      additionalProperties: true,
    })
    expect(schema.type).toBe('object')
  })

  it('rejects a non-object root (scalar/array-rooted schemas)', () => {
    expect(violationsOf({ type: 'string' })).toEqual(['schema.type must be "object" (structured output is object-rooted)'])
    expect(violationsOf({ type: 'array', items: { type: 'string' } }))
      .toContain('schema.type must be "object" (structured output is object-rooted)')
  })

  it('rejects non-object schema nodes and missing/unknown type', () => {
    expect(violationsOf('nope')).toEqual(['schema must be a schema object'])
    expect(violationsOf(null)).toEqual(['schema must be a schema object'])
    expect(violationsOf([])).toEqual(['schema must be a schema object'])
    expect(violationsOf({})).toEqual(['schema.type must be one of object/array/string/number/integer/boolean/null'])
    expect(violationsOf({ type: 'tuple' })[0]).toMatch(/type must be one of/)
    expect(violationsOf({ type: 'object', properties: { a: 'str' } })).toEqual(['schema.properties.a must be a schema object'])
  })

  it('rejects type ARRAYS with a dedicated message', () => {
    expect(violationsOf({ type: ['string', 'null'] }))
      .toEqual(['schema.type must be a single type string (type arrays are not supported)'])
  })

  it('rejects unsupported constraint keywords loudly (never accepted-then-ignored)', () => {
    for (const keyword of ['oneOf', 'anyOf', 'allOf', 'not', 'pattern', 'minimum', 'maxLength', '$ref']) {
      const bad = violationsOf({ type: 'object', [keyword]: [] })
      expect(bad.some(v => v.includes(`schema.${keyword} is not a supported keyword`))).toBe(true)
    }
  })

  it('reports EVERY violation, not just the first', () => {
    const bad = violationsOf({
      type: 'object',
      pattern: 'x',
      properties: { a: { type: 'weird' }, b: { type: 'string', minimum: 1 } },
    })
    expect(bad.length).toBe(3)
  })

  it('rejects keywords on the wrong type (items on object, properties on string, enum on object)', () => {
    expect(violationsOf({ type: 'object', items: { type: 'string' } }))
      .toEqual(['schema.items is not supported on type "object"'])
    expect(violationsOf({ type: 'object', properties: { a: { type: 'string', properties: {} } } }))
      .toEqual(['schema.properties.a.properties is not supported on type "string"'])
    expect(violationsOf({ type: 'object', enum: [1] }))
      .toEqual(['schema.enum is not supported on type "object"'])
    expect(violationsOf({ type: 'object', properties: { a: { type: 'array', const: 1 } } }))
      .toEqual(['schema.properties.a.const is not supported on type "array"'])
  })

  it('validates required: must be string[] naming declared properties', () => {
    expect(violationsOf({ type: 'object', required: 'file' }))
      .toEqual(['schema.required must be an array of strings'])
    expect(violationsOf({ type: 'object', required: [1] }))
      .toEqual(['schema.required must be an array of strings'])
    expect(violationsOf({ type: 'object', properties: { a: { type: 'string' } }, required: ['b'] }))
      .toEqual(['schema.required names "b" which is not in properties'])
    expect(violationsOf({ type: 'object', required: ['a'] }))
      .toEqual(['schema.required names "a" which is not in properties'])
  })

  it('validates additionalProperties must be boolean and enum/const must be scalars', () => {
    expect(violationsOf({ type: 'object', additionalProperties: {} }))
      .toEqual(['schema.additionalProperties must be a boolean'])
    expect(violationsOf({ type: 'object', properties: { a: { type: 'string', enum: [] } } }))
      .toEqual(['schema.properties.a.enum must be a non-empty array of scalars'])
    expect(violationsOf({ type: 'object', properties: { a: { type: 'string', enum: [{}] } } }))
      .toEqual(['schema.properties.a.enum must be a non-empty array of scalars'])
    expect(violationsOf({ type: 'object', properties: { a: { type: 'string', enum: 'x' } } }))
      .toEqual(['schema.properties.a.enum must be a non-empty array of scalars'])
    expect(violationsOf({ type: 'object', properties: { a: { type: 'number', enum: [Number.NaN] } } }))
      .toEqual(['schema.properties.a.enum must be a non-empty array of scalars'])
    expect(violationsOf({ type: 'object', properties: { a: { type: 'string', const: {} } } }))
      .toEqual(['schema.properties.a.const must be a scalar'])
  })

  it('rejects non-string description/title and non-JSON annotation payloads', () => {
    expect(violationsOf({ type: 'object', description: 7 }))
      .toEqual(['schema.description must be a string'])
    expect(violationsOf({ type: 'object', title: 7 }))
      .toEqual(['schema.title must be a string'])
    expect(violationsOf({ type: 'object', default: () => 1 }))
      .toEqual(['schema.default annotation must be JSON data'])
    expect(violationsOf({ type: 'object', examples: [undefined] }))
      .toEqual(['schema.examples annotation must be JSON data'])
    expect(violationsOf({ type: 'object', examples: [Number.POSITIVE_INFINITY] }))
      .toEqual(['schema.examples annotation must be JSON data'])
    // A cyclic annotation payload is caught by the JSON-data walk.
    const cyclicAnnotation: Record<string, unknown> = {}
    cyclicAnnotation.self = cyclicAnnotation
    expect(violationsOf({ type: 'object', default: cyclicAnnotation }))
      .toEqual(['schema.default annotation must be JSON data'])
    // Object/array annotations that ARE JSON data pass.
    asserted({ type: 'object', default: { a: [1, 'x', null, true] } })
  })

  it('rejects a circular schema instead of recursing forever', () => {
    const node: Record<string, unknown> = { type: 'object' }
    node.properties = { self: node }
    expect(violationsOf(node)).toEqual(['schema.properties.self is circular'])
  })

  it('accepts the same subschema object reused in two SIBLING positions (a DAG, not a cycle)', () => {
    const leaf = { type: 'string' }
    asserted({ type: 'object', properties: { a: leaf, b: leaf } })
  })

  it('required cannot be satisfied by INHERITED names — `toString` is not a declared property', () => {
    // `'toString' in {}` is true via Object.prototype; the declared-property
    // contract must be an own-property check.
    expect(violationsOf({ type: 'object', properties: {}, required: ['toString'] }))
      .toEqual(['schema.required names "toString" which is not in properties'])
  })

  it('rejects exotic host objects where the subset expects plain JSON structure', () => {
    // A Map as `properties` has no own enumerable entries: structurally it
    // would read as "no properties" and serialize to {} — lossy, not loud.
    expect(violationsOf({ type: 'object', properties: new Map() }))
      .toEqual(['schema.properties must be an object of schemas'])
    // A Date node is not a schema object even though Object.values(date) is [].
    expect(violationsOf({ type: 'object', properties: { at: new Date(0) } }))
      .toEqual(['schema.properties.at must be a schema object'])
  })

  it('rejects exotic annotation payloads that would serialize lossily', () => {
    expect(violationsOf({ type: 'object', default: new Date(0) }))
      .toEqual(['schema.default annotation must be JSON data'])
    expect(violationsOf({ type: 'object', examples: [new Map()] }))
      .toEqual(['schema.examples annotation must be JSON data'])
  })
})

describe('validateStructuredValue', () => {
  const schema = asserted({
    type: 'object',
    properties: {
      file: { type: 'string' },
      line: { type: 'integer' },
      score: { type: 'number' },
      confirmed: { type: 'boolean' },
      parent: { type: 'null' },
      severity: { type: 'string', enum: ['low', 'high'] },
      kind: { type: 'string', const: 'bug' },
      tags: { type: 'array', items: { type: 'string' } },
      free: { type: 'array' },
      nested: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'], additionalProperties: false },
    },
    required: ['file'],
  })

  it('accepts a fully valid value (empty violations)', () => {
    expect(validateStructuredValue(schema, {
      file: 'a.ts', line: 3, score: 0.5, confirmed: true, parent: null,
      severity: 'high', kind: 'bug', tags: ['x'], free: [1, { any: true }], nested: { x: 1 },
    })).toEqual([])
  })

  it('reports missing required and wrong root type', () => {
    expect(validateStructuredValue(schema, {})).toEqual(['missing required property "value.file"'])
    expect(validateStructuredValue(schema, 'nope')).toEqual(['"value" must be an object'])
    expect(validateStructuredValue(schema, [])).toEqual(['"value" must be an object'])
  })

  it('type-checks every scalar branch with path-qualified messages', () => {
    expect(validateStructuredValue(schema, { file: 1 })).toEqual(['"value.file" must be a string'])
    expect(validateStructuredValue(schema, { file: 'a', line: 1.5 })).toEqual(['"value.line" must be an integer'])
    expect(validateStructuredValue(schema, { file: 'a', line: 'x' })).toEqual(['"value.line" must be an integer'])
    expect(validateStructuredValue(schema, { file: 'a', score: 'x' })).toEqual(['"value.score" must be a finite number'])
    expect(validateStructuredValue(schema, { file: 'a', score: Number.NaN })).toEqual(['"value.score" must be a finite number'])
    expect(validateStructuredValue(schema, { file: 'a', confirmed: 'yes' })).toEqual(['"value.confirmed" must be a boolean'])
    expect(validateStructuredValue(schema, { file: 'a', parent: 0 })).toEqual(['"value.parent" must be null'])
  })

  it('enforces enum membership and const equality', () => {
    expect(validateStructuredValue(schema, { file: 'a', severity: 'mid' }))
      .toEqual(['"value.severity" must be one of ["low","high"]'])
    expect(validateStructuredValue(schema, { file: 'a', kind: 'feature' }))
      .toEqual(['"value.kind" must be "bug"'])
  })

  it('checks arrays per index; an items-less array accepts anything', () => {
    expect(validateStructuredValue(schema, { file: 'a', tags: 'x' })).toEqual(['"value.tags" must be an array'])
    expect(validateStructuredValue(schema, { file: 'a', tags: ['ok', 2] })).toEqual(['"value.tags[1]" must be a string'])
    expect(validateStructuredValue(schema, { file: 'a', free: [{ deep: [1] }, null] })).toEqual([])
  })

  it('recurses into nested objects: required + additionalProperties: false', () => {
    expect(validateStructuredValue(schema, { file: 'a', nested: {} }))
      .toEqual(['missing required property "value.nested.x"'])
    expect(validateStructuredValue(schema, { file: 'a', nested: { x: 1, y: 2 } }))
      .toEqual(['"value.nested.y" is not a declared property (additionalProperties: false)'])
    expect(validateStructuredValue(schema, { file: 'a', nested: 3 }))
      .toEqual(['"value.nested" must be an object'])
  })

  it('a required key present-but-undefined counts as missing', () => {
    expect(validateStructuredValue(schema, { file: undefined })).toEqual(['missing required property "value.file"'])
  })

  it('inherited properties satisfy nothing: required, additionalProperties, and recursion are own-property only', () => {
    // required: ['toString'] must NOT be satisfied by Object.prototype.toString.
    expect(validateStructuredValue(
      asserted({ type: 'object', properties: { toString: { type: 'string' } }, required: ['toString'] }),
      {},
    )).toEqual(['missing required property "value.toString"'])
    // additionalProperties: false must flag an OWN `toString` key even though
    // `'toString' in properties` is true via the prototype.
    expect(validateStructuredValue(
      asserted({ type: 'object', additionalProperties: false }),
      { toString: 1 },
    )).toEqual(['"value.toString" is not a declared property (additionalProperties: false)'])
    // A declared property the value does NOT carry must not be validated
    // against the value's INHERITED member (constructor is a function on
    // every plain object's prototype, not a carried property).
    expect(validateStructuredValue(
      asserted({ type: 'object', properties: { constructor: { type: 'string' } } }),
      {},
    )).toEqual([])
  })

  it('a non-plain object value is not an object in the JSON sense', () => {
    expect(validateStructuredValue(asserted({ type: 'object' }), new Date(0)))
      .toEqual(['"value" must be an object'])
  })

  it('collects multiple violations across branches in one pass', () => {
    expect(validateStructuredValue(schema, { line: 'x', severity: 'mid' })).toEqual([
      'missing required property "value.file"',
      '"value.line" must be an integer',
      '"value.severity" must be one of ["low","high"]',
    ])
  })

  it('null-typed const/enum work through the scalar path', () => {
    const nullish = asserted({ type: 'object', properties: { a: { type: 'null', const: null } } })
    expect(validateStructuredValue(nullish, { a: null })).toEqual([])
  })

  it('rejects a non-object properties value in the schema walk', () => {
    expect(violationsOf({ type: 'object', properties: [] }))
      .toEqual(['schema.properties must be an object of schemas'])
  })

  it('an object schema without properties/required only type-checks its value', () => {
    const bare = asserted({ type: 'object' })
    expect(validateStructuredValue(bare, { any: ['thing'] })).toEqual([])
    expect(validateStructuredValue(bare, 7)).toEqual(['"value" must be an object'])
  })

  it('validateStructuredValue throws on a type the assert would never let through (assertNever backstop)', () => {
    const forged = { type: 'tuple' } as unknown as StructuredOutputSchema
    expect(() => validateStructuredValue(forged, 1)).toThrow(/tuple/)
  })
})
