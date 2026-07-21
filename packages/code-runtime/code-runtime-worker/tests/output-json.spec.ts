import { describe, expect, it, vi } from 'vitest'
import { jsonStringBytesUpTo, jsonValueBytesUpTo, truncateJsonStringBytes } from '../src/output-json.ts'

describe('truncateJsonStringBytes', () => {
  it('returns a fitting string whole and rejects budgets without JSON quotes', () => {
    expect(truncateJsonStringBytes('fits', 6)).toBe('fits')
    expect(truncateJsonStringBytes('x', 1)).toBe('')
    expect(jsonStringBytesUpTo('fits', 6)).toBe(6)
    expect(jsonStringBytesUpTo('fits', 5)).toBeUndefined()
  })

  it('accounts every JSON escape and cuts only between complete code points', () => {
    const prefix = '"\\\b\t\n\f\r\u0000😀\ud800€a'
    const text = `${prefix}z`
    const budget = Buffer.byteLength(JSON.stringify(prefix), 'utf8')

    expect(truncateJsonStringBytes(text, budget)).toBe(prefix)
    expect(Buffer.byteLength(JSON.stringify(truncateJsonStringBytes(text, budget)), 'utf8')).toBe(budget)
  })

  it('bounds hostile strings without materializing their complete escaped form', () => {
    const stringify = vi.spyOn(JSON, 'stringify').mockImplementation(() => { throw new Error('must not stringify') })
    try {
      expect(jsonStringBytesUpTo('"'.repeat(10_000), 32)).toBeUndefined()
      expect(truncateJsonStringBytes('"'.repeat(10_000), 32)).toBe('"'.repeat(15))
    } finally {
      stringify.mockRestore()
    }
  })
})

describe('jsonValueBytesUpTo', () => {
  it('matches JSON serialization for every lossless value branch and stops at the cap', () => {
    const value = {
      empty: {},
      nil: null,
      yes: true,
      no: false,
      number: 1.5,
      text: '"\n😀',
      array: [1, 'x'],
    }
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')

    expect(jsonValueBytesUpTo(value, bytes)).toBe(bytes)
    expect(jsonValueBytesUpTo(value, bytes - 1)).toBeUndefined()
    expect(jsonValueBytesUpTo({}, 1)).toBeUndefined()
    expect(jsonValueBytesUpTo(null, 3)).toBeUndefined()
    expect(jsonValueBytesUpTo(10, 1)).toBeUndefined()
    expect(jsonValueBytesUpTo(false, 4)).toBeUndefined()
    expect(jsonValueBytesUpTo(new Array<never>(1), 10)).toBeUndefined()
    expect(jsonValueBytesUpTo([null], 5)).toBeUndefined()
    expect(jsonValueBytesUpTo([0, 0], 3)).toBeUndefined()
    expect(jsonValueBytesUpTo({ a: null, b: null }, 10)).toBeUndefined()
    expect(jsonValueBytesUpTo({ long: null }, 2)).toBeUndefined()
    expect(jsonValueBytesUpTo({ '': null }, 4)).toBeUndefined()
    expect(jsonValueBytesUpTo({ a: null }, 9)).toBeUndefined()
  })
})
