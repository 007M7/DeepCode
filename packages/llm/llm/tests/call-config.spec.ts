/**
 * call-config unit tests: field-wise LlmCallConfig equality (the real-change
 * detector behind logged header deltas) and the deepFreeze ownership helper
 * the loop applies to every built request.
 */

import { describe, expect, it } from 'vitest'
import { callConfigEquals, deepFreeze } from '../src/call-config.ts'

describe('callConfigEquals', () => {
  it('compares every field, including the stop list element-wise', () => {
    const base = { provider: 'p', model: 'm' }
    expect(callConfigEquals(base, base)).toBe(true)
    expect(callConfigEquals(base, { provider: 'x', model: 'm' })).toBe(false)
    expect(callConfigEquals(base, { provider: 'p', model: 'x' })).toBe(false)
    expect(callConfigEquals({ ...base, temperature: 0.5 }, base)).toBe(false)
    expect(callConfigEquals({ ...base, maxTokens: 1 }, { ...base, maxTokens: 2 })).toBe(false)
    expect(callConfigEquals({ ...base, stop: ['a'] }, base)).toBe(false)
    expect(callConfigEquals({ ...base, stop: ['a'] }, { ...base, stop: ['a', 'b'] })).toBe(false)
    expect(callConfigEquals({ ...base, stop: ['a'] }, { ...base, stop: ['b'] })).toBe(false)
    expect(callConfigEquals({ ...base, stop: ['a', 'b'] }, { ...base, stop: ['a', 'b'] })).toBe(true)
  })
})

describe('deepFreeze', () => {
  it('freezes nested structure in place and returns the same reference', () => {
    const value = { a: { b: [1, { c: 'x' }] } }
    const frozen = deepFreeze(value)
    expect(frozen).toBe(value)
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen(value.a)).toBe(true)
    expect(Object.isFrozen(value.a.b)).toBe(true)
    expect(Object.isFrozen(value.a.b[1])).toBe(true)
    // ESM runs in strict mode: mutation throws rather than silently failing.
    expect(() => { (value.a.b[1] as { c: string }).c = 'y' }).toThrow(TypeError)
  })

  it('never freezes an AbortSignal: the live cancellation channel keeps working', () => {
    const controller = new AbortController()
    const request = deepFreeze({ model: 'm', signal: controller.signal })
    expect(Object.isFrozen(request)).toBe(true)
    expect(Object.isFrozen(controller.signal)).toBe(false)
    let fired = false
    controller.signal.addEventListener('abort', () => { fired = true }, { once: true })
    controller.abort('stop')
    expect(fired).toBe(true)
    expect(controller.signal.aborted).toBe(true)
  })

  it('passes primitives through and terminates on cycles', () => {
    expect(deepFreeze(42)).toBe(42)
    expect(deepFreeze(null)).toBeNull()
    const cyclic = { self: undefined as unknown }
    cyclic.self = cyclic
    deepFreeze(cyclic)
    expect(Object.isFrozen(cyclic)).toBe(true)
  })
})
