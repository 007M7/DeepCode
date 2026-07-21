import { describe, expect, it } from 'vitest'
import { truncateJsonStringBytes } from '../src/output-json.ts'

describe('truncateJsonStringBytes', () => {
  it('returns a fitting string whole and rejects budgets without JSON quotes', () => {
    expect(truncateJsonStringBytes('fits', 6)).toBe('fits')
    expect(truncateJsonStringBytes('x', 1)).toBe('')
  })

  it('accounts every JSON escape and cuts only between complete code points', () => {
    const prefix = '"\\\b\t\n\f\r\u0000😀\ud800€a'
    const text = `${prefix}z`
    const budget = Buffer.byteLength(JSON.stringify(prefix), 'utf8')

    expect(truncateJsonStringBytes(text, budget)).toBe(prefix)
    expect(Buffer.byteLength(JSON.stringify(truncateJsonStringBytes(text, budget)), 'utf8')).toBe(budget)
  })
})
