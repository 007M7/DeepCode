import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { BackendRegistry, Storage, apply } from '../src/index.ts'
import type { StorageBackend } from '../src/index.ts'

const fakeBackend = (): StorageBackend => ({ close: async () => {} })

describe('BackendRegistry', () => {
  it('registers, resolves, and disposes names', () => {
    const registry = new BackendRegistry()
    const backend = fakeBackend()
    const dispose = registry.register('json', backend)
    expect(registry.get('json')).toBe(backend)
    expect(registry.names()).toEqual(['json'])
    dispose()
    expect(registry.names()).toEqual([])
    expect(() => registry.get('json')).toThrowMatchingObject({ code: 'backend-not-found' })
  })

  it('rejects duplicate names', () => {
    const registry = new BackendRegistry()
    registry.register('json', fakeBackend())
    expect(() => registry.register('json', fakeBackend())).toThrowMatchingObject({ code: 'duplicate-backend' })
  })
})

describe('Storage service', () => {
  it('mounts on the context and exposes registry plus form mounting', async () => {
    const ctx = new Context()
    await ctx.plugin({ apply })
    expect(ctx.storage).toBeInstanceOf(Storage)

    const facility = { marker: true }
    const dispose = ctx.storage.mount('domain' as never, facility as never)
    expect(ctx.storage.form('domain' as never)).toBe(facility)
    expect(() => ctx.storage.mount('domain' as never, facility as never)).toThrowMatchingObject({
      code: 'duplicate-mount',
    })
    dispose()
    expect(() => ctx.storage.form('domain' as never)).toThrowMatchingObject({ code: 'form-not-mounted' })
  })
})

expect.extend({
  toThrowMatchingObject(received: () => unknown, expected: object) {
    try {
      received()
    } catch (error) {
      const pass = Object.entries(expected).every(
        (entry) => (error as Record<string, unknown>)[entry[0]] === entry[1],
      )
      return { pass, message: () => `expected thrown error to match ${JSON.stringify(expected)}, got ${String(error)}` }
    }
    return { pass: false, message: () => 'expected function to throw' }
  },
})

declare module 'vitest' {
  interface Assertion<T> {
    toThrowMatchingObject(expected: object): T
  }
}
