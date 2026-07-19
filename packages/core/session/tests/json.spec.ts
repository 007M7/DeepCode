import { describe, expect, it } from 'vitest'
import { isJsonValue, snapshotJsonValue } from '@deepseek-ai/dsh-session'

describe('snapshotJsonValue', () => {
  it('copies the complete JSON scalar vocabulary and rejects unsupported scalars', () => {
    const unsupportedFunction = (): void => {}

    expect(snapshotJsonValue(null)).toBeNull()
    expect(snapshotJsonValue(true)).toBe(true)
    expect(snapshotJsonValue('text')).toBe('text')
    expect(snapshotJsonValue(1.25)).toBe(1.25)
    expect(snapshotJsonValue(-0)).toBeUndefined()
    expect(isJsonValue(-0)).toBe(false)
    expect(snapshotJsonValue(Number.NaN)).toBeUndefined()
    expect(snapshotJsonValue(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(snapshotJsonValue(1n)).toBeUndefined()
    expect(snapshotJsonValue(unsupportedFunction)).toBeUndefined()
    expect(snapshotJsonValue(Symbol('value'))).toBeUndefined()
    const unsupportedUndefined: unknown = undefined
    expect(snapshotJsonValue(unsupportedUndefined)).toBeUndefined()
  })

  it('recursively detaches dense arrays and plain or null-prototype objects', () => {
    const shared = { value: 1 }
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, { shared })
    const source = { list: [nullPrototype, shared], alias: shared }

    const snapshot = snapshotJsonValue(source)!
    shared.value = 2

    expect(snapshot).toEqual({ list: [{ shared: { value: 1 } }, { value: 1 }], alias: { value: 1 } })
    expect(snapshot).not.toBe(source)
    expect(snapshot.list).not.toBe(source.list)
    expect(snapshot.alias).not.toBe(shared)
    expect(snapshot.list[0]).not.toBe(nullPrototype)
    expect(Object.getPrototypeOf(snapshot.list[0])).toBe(Object.prototype)
  })

  it('reads each object value and array slot once while materializing', () => {
    class Exotic {
      readonly accepted = false
    }
    let objectReads = 0
    let arrayReads = 0
    const nested = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => {
        objectReads += 1
        return objectReads === 1 ? { accepted: true } : new Exotic()
      },
    })
    const array = new Array<unknown>(1)
    Object.defineProperty(array, 0, {
      enumerable: true,
      get: () => {
        arrayReads += 1
        return arrayReads === 1 ? nested : new Exotic()
      },
    })

    expect(snapshotJsonValue(array)).toEqual([{ value: { accepted: true } }])
    expect(objectReads).toBe(1)
    expect(arrayReads).toBe(1)
  })

  it('rejects exotic containers, sparse arrays, cycles, and invalid children', () => {
    class ExoticObject {
      readonly value = 1
    }
    class ExoticArray extends Array<number> {}
    const sparse = new Array<number>(1)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    expect(snapshotJsonValue(new ExoticObject())).toBeUndefined()
    expect(snapshotJsonValue(new Map([['value', 1]]))).toBeUndefined()
    expect(snapshotJsonValue(new ExoticArray(1))).toBeUndefined()
    expect(snapshotJsonValue(sparse)).toBeUndefined()
    expect(snapshotJsonValue(cyclic)).toBeUndefined()
    expect(snapshotJsonValue([undefined])).toBeUndefined()
    expect(snapshotJsonValue({ value: undefined })).toBeUndefined()
  })

  it('preserves a literal __proto__ JSON key without changing the snapshot prototype', () => {
    const source = Object.create(null) as Record<string, unknown>
    source.__proto__ = { safe: true }

    const snapshot = snapshotJsonValue(source)!

    expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(snapshot, '__proto__')).toBe(true)
    expect(snapshot.__proto__).toEqual({ safe: true })
  })

  it('propagates a throwing getter after reading it once', () => {
    const failure = new Error('getter failed')
    let reads = 0
    const source = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => {
        reads += 1
        throw failure
      },
    })

    expect(() => snapshotJsonValue(source)).toThrow(failure)
    expect(reads).toBe(1)
  })
})

describe('isJsonValue', () => {
  it('recognizes supported scalars and rejects every lossy scalar case', () => {
    const unsupportedFunction = (): void => {}
    const unsupportedUndefined: unknown = undefined

    expect(isJsonValue(null)).toBe(true)
    expect(isJsonValue(false)).toBe(true)
    expect(isJsonValue('text')).toBe(true)
    expect(isJsonValue(1.25)).toBe(true)
    expect(isJsonValue(-0)).toBe(false)
    expect(isJsonValue(Number.NaN)).toBe(false)
    expect(isJsonValue(1n)).toBe(false)
    expect(isJsonValue(unsupportedFunction)).toBe(false)
    expect(isJsonValue(Symbol('value'))).toBe(false)
    expect(isJsonValue(unsupportedUndefined)).toBe(false)
  })

  it('accepts dense arrays and plain objects, including null-prototype records', () => {
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, { value: true })

    expect(isJsonValue([1, { nested: null }, nullPrototype])).toBe(true)
    expect(isJsonValue({ value: [1, 2] })).toBe(true)
    expect(isJsonValue(nullPrototype)).toBe(true)
  })

  it('rejects sparse arrays, invalid children, exotic objects, and cycles', () => {
    class Exotic {
      readonly value = 1
    }
    class ExoticArray extends Array<number> {}
    const sparse = new Array<number>(1)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    expect(isJsonValue(sparse)).toBe(false)
    expect(isJsonValue(new ExoticArray(1))).toBe(false)
    expect(isJsonValue([undefined])).toBe(false)
    expect(isJsonValue({ value: undefined })).toBe(false)
    expect(isJsonValue(new Exotic())).toBe(false)
    expect(isJsonValue(cyclic)).toBe(false)
  })
})
