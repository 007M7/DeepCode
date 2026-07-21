import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import { snapshotCodeJsonValue } from '../src/worker-json.ts'

describe('snapshotCodeJsonValue', () => {
  it('matches the canonical scalar boundary', () => {
    const unsupported = [undefined, 1n, Symbol('value'), () => 1]
    for (const value of [null, false, 'text', 1.25, -0, Number.NaN, Number.POSITIVE_INFINITY, ...unsupported]) {
      expect(snapshotCodeJsonValue(value)).toEqual(snapshotJsonValue(value))
    }
  })

  it('detaches dense arrays and plain or null-prototype records', () => {
    const shared = { value: 1 }
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, { shared })
    const source = { list: [nullPrototype, shared], alias: shared }

    const snapshot = snapshotCodeJsonValue(source) as Record<string, unknown>
    shared.value = 2

    expect(snapshot).toEqual({ list: [{ shared: { value: 1 } }, { value: 1 }], alias: { value: 1 } })
    expect(snapshot).not.toBe(source)
    expect((snapshot.list as unknown[])[0]).not.toBe(nullPrototype)
    expect(snapshot.alias).not.toBe(shared)
  })

  it('accepts intrinsic plain containers from another JavaScript realm', () => {
    const foreign = runInNewContext('({ object: { nested: [1] }, array: [2, { ok: true }] })') as {
      object: unknown
      array: unknown
    }

    expect(snapshotCodeJsonValue(foreign.object)).toEqual({ nested: [1] })
    expect(snapshotCodeJsonValue(foreign.array)).toEqual([2, { ok: true }])
  })

  it('reads each accepted slot once and preserves a literal __proto__ key', () => {
    let objectReads = 0
    let arrayReads = 0
    const source = Object.create(null) as Record<string, unknown>
    Object.defineProperty(source, '__proto__', {
      enumerable: true,
      get: () => {
        objectReads += 1
        return { safe: true }
      },
    })
    const array = new Array<unknown>(1)
    Object.defineProperty(array, 0, {
      enumerable: true,
      get: () => {
        arrayReads += 1
        return arrayReads === 1 ? source : undefined
      },
    })

    const snapshot = snapshotCodeJsonValue(array) as Record<string, unknown>[]

    expect(objectReads).toBe(1)
    expect(arrayReads).toBe(1)
    expect(Object.getPrototypeOf(snapshot[0])).toBe(Object.prototype)
    expect(Object.hasOwn(snapshot[0]!, '__proto__')).toBe(true)
    expect(snapshot[0]?.['__proto__']).toEqual({ safe: true })
  })

  it('accepts deeply nested valid JSON without using the JavaScript call stack', () => {
    let value: unknown = 'leaf'
    for (let depth = 0; depth < 5_000; depth++) value = [value]

    let cursor = snapshotCodeJsonValue(value)
    for (let depth = 0; depth < 5_000; depth++) {
      expect(Array.isArray(cursor)).toBe(true)
      cursor = Array.isArray(cursor) ? cursor[0] : undefined
    }
    expect(cursor).toBe('leaf')
  })

  it('rejects exotic containers, sparse arrays, cycles, and invalid children', () => {
    class ExoticObject {
      readonly value = 1
    }
    class ExoticArray extends Array<number> {}
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const decorated = [1]
    Object.defineProperty(decorated, 'extra', { value: true })
    const compensatedSparse = new Array(1)
    Object.defineProperty(compensatedSparse, 'extra', { value: true })
    const symbolDecorated = [1]
    Object.defineProperty(symbolDecorated, Symbol('extra'), { value: true })
    const hiddenObject = Object.defineProperty({}, 'hidden', { value: true })
    const symbolObject = { [Symbol('extra')]: true }
    const customPrototype = Object.create(null) as Record<string, unknown>
    const customPrototypeObject = Object.assign(Object.create(customPrototype) as Record<string, unknown>, { value: 1 })
    const forgedPrototype: unknown[] = []
    Object.setPrototypeOf(forgedPrototype, null)
    const forgedArray = [1]
    Object.setPrototypeOf(forgedArray, forgedPrototype)

    for (const value of [
      new ExoticObject(),
      new Map([['value', 1]]),
      new ExoticArray(1),
      new Array(1),
      decorated,
      compensatedSparse,
      symbolDecorated,
      hiddenObject,
      symbolObject,
      customPrototypeObject,
      forgedArray,
      cyclic,
      [undefined],
      { value: undefined },
    ]) {
      expect(snapshotCodeJsonValue(value)).toBeUndefined()
    }
  })

  it('rejects an array whose getter mutates the validated length', () => {
    const array = [0, 2]
    Object.defineProperty(array, 0, {
      enumerable: true,
      get: () => {
        array.length = 1
        return 1
      },
    })

    expect(snapshotCodeJsonValue(array)).toBeUndefined()
  })

  it('propagates a throwing getter and releases its recursion guard', () => {
    const failure = new Error('getter failed')
    const source = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => { throw failure },
    })

    expect(() => snapshotCodeJsonValue(source)).toThrow(failure)
    expect(snapshotCodeJsonValue({ after: true })).toEqual({ after: true })
  })
})
