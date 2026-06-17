/**
 * Property-based tests for the tool-schema DSL (the property-testing RFC), including
 * the the property-testing ↔ runtime-validation composition composition: generated args that satisfy a SchemaSpec must
 * pass validateArgs, and targeted corruptions must be rejected. This closes the
 * validator/InferArgs drift risk noted in the arg-validation RFC.
 */

import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { schemaSpecToJsonSchema, validateArgs } from '@deepseek-ai/dsh-tools'
import type { SchemaProp, SchemaSpec } from '@deepseek-ai/dsh-tools'

// A leaf prop arbitrary (no nesting) with optional required/enum.
function leafPropArb(): fc.Arbitrary<SchemaProp> {
  return fc.oneof(
    fc.record({ required: fc.boolean() }).map(({ required }): SchemaProp => ({ type: 'string', ...required ? { required: true } : {} })),
    fc.record({ required: fc.boolean() }).map(({ required }): SchemaProp => ({ type: 'number', ...required ? { required: true } : {} })),
    fc.record({ required: fc.boolean() }).map(({ required }): SchemaProp => ({ type: 'boolean', ...required ? { required: true } : {} })),
    fc.record({ values: fc.uniqueArray(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 3 }), required: fc.boolean() })
      .map(({ values, required }): SchemaProp => ({ type: 'string', enum: values, ...required ? { required: true } : {} })),
  )
}

/** A prop arbitrary up to `depth` levels of nesting (objects and arrays). */
function propArb(depth: number): fc.Arbitrary<SchemaProp> {
  if (depth <= 0) return leafPropArb()
  return fc.oneof(
    { weight: 3, arbitrary: leafPropArb() },
    {
      weight: 1,
      arbitrary: fc.record({ properties: specArb(depth - 1), required: fc.boolean() })
        .map(({ properties, required }): SchemaProp => ({ type: 'object', properties, ...required ? { required: true } : {} })),
    },
    {
      weight: 1,
      arbitrary: fc.record({ items: propArb(depth - 1), required: fc.boolean() })
        .map(({ items, required }): SchemaProp => ({ type: 'array', items, ...required ? { required: true } : {} })),
    },
  )
}

function specArb(depth: number): fc.Arbitrary<SchemaSpec> {
  return fc.dictionary(fc.string({ minLength: 1, maxLength: 6 }), propArb(depth), { maxKeys: 4 })
}

/** Generate a value that satisfies a prop (used to build valid args). */
function valueForProp(prop: SchemaProp): fc.Arbitrary<unknown> {
  switch (prop.type) {
    case 'string': return prop.enum ? fc.constantFrom(...prop.enum) : fc.string()
    case 'number': return fc.double({ noNaN: true, noDefaultInfinity: true })
    case 'boolean': return fc.boolean()
    case 'object': return prop.properties ? validArgsForSpec(prop.properties) : fc.constant({})
    case 'array': return prop.items ? fc.array(valueForProp(prop.items), { maxLength: 3 }) : fc.constant([])
  }
}

/** Generate args satisfying every required key of a spec (optionals included randomly). */
function validArgsForSpec(spec: SchemaSpec): fc.Arbitrary<Record<string, unknown>> {
  const entries = Object.entries(spec)
  return fc.tuple(...entries.map(([key, prop]) =>
    fc.tuple(
      fc.constant(key),
      // required keys are always present; optional keys are present ~half the time
      prop.required === true
        ? valueForProp(prop).map(v => ({ include: true, value: v }))
        : fc.oneof(
          valueForProp(prop).map(v => ({ include: true, value: v })),
          fc.constant({ include: false, value: undefined }),
        ),
    ),
  )).map((pairs) => {
    const out: Record<string, unknown> = {}
    for (const [key, { include, value }] of pairs) if (include) out[key] = value
    return out
  })
}

/** Collect the `required: true` keys at the top level of a spec. */
function requiredKeys(spec: SchemaSpec): string[] {
  return Object.entries(spec).filter(([, p]) => p.required === true).map(([k]) => k)
}

describe('schema DSL properties', () => {
  it('JSON Schema `required` equals the required:true keys at every level', () => {
    fc.assert(fc.property(specArb(2), (spec) => {
      const checkLevel = (s: SchemaSpec, json: { required?: string[]; properties: Record<string, unknown> }) => {
        expect(new Set(json.required ?? [])).toEqual(new Set(requiredKeys(s)))
        for (const [key, prop] of Object.entries(s)) {
          const propJson = json.properties[key] as Record<string, unknown>
          if (prop.type === 'object' && prop.properties) {
            checkLevel(prop.properties, propJson as { required?: string[]; properties: Record<string, unknown> })
          }
        }
      }
      checkLevel(spec, schemaSpecToJsonSchema(spec))
    }))
  })

  it('conversion is total (never throws) for any spec', () => {
    fc.assert(fc.property(specArb(3), (spec) => {
      expect(() => schemaSpecToJsonSchema(spec)).not.toThrow()
    }))
  })

  it('validateArgs is total (never throws) for any spec and any input', () => {
    fc.assert(fc.property(specArb(2), fc.anything(), (spec, args) => {
      expect(() => validateArgs(spec, args)).not.toThrow()
    }))
  })

  it('the property-testing ↔ runtime-validation composition: args satisfying the spec pass validateArgs', () => {
    fc.assert(fc.property(
      specArb(2).chain(spec => fc.tuple(fc.constant(spec), validArgsForSpec(spec))),
      ([spec, args]) => {
        expect(validateArgs(spec, args)).toEqual([])
      },
    ))
  })

  it('the property-testing ↔ runtime-validation composition: dropping a required key is always rejected', () => {
    fc.assert(fc.property(
      specArb(1)
        .filter(spec => requiredKeys(spec).length > 0)
        .chain(spec => fc.tuple(fc.constant(spec), validArgsForSpec(spec))),
      ([spec, args]) => {
        const required = requiredKeys(spec)
        const victim = required[0]!
        const broken = Object.fromEntries(Object.entries(args).filter(([k]) => k !== victim))
        const violations = validateArgs(spec, broken)
        expect(violations.some(v => v.includes(`"${victim}"`))).toBe(true)
      },
    ))
  })

  it('the property-testing ↔ runtime-validation composition: a non-object top level is always rejected', () => {
    fc.assert(fc.property(
      specArb(1),
      fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null), fc.array(fc.anything())),
      (spec, notAnObject) => {
        expect(validateArgs(spec, notAnObject).length).toBeGreaterThan(0)
      },
    ))
  })
})
