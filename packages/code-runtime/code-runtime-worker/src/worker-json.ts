/** Lossless-JSON snapshots for the dependency-free source worker closure. @module @deepseek-ai/dsh-code-runtime-worker/worker-json */

import type { CodeJsonValue } from '@deepseek-ai/dsh-code-runtime'

/* jscpd:ignore-start -- the source worker mirrors session JSON helpers without workspace runtime imports */
/** Whether an array uses one realm's intrinsic `Array.prototype`, not a subclass or forged prototype. */
function hasPlainArrayPrototype(value: unknown[]): boolean {
  const prototype: unknown = Object.getPrototypeOf(value)
  if (!Array.isArray(prototype)) return false
  const objectPrototype: unknown = Object.getPrototypeOf(prototype)
  return objectPrototype !== null
    && !Array.isArray(objectPrototype)
    && Object.getPrototypeOf(objectPrototype) === null
}

/** Whether an object is a plain or null-prototype record from any JavaScript realm. */
function hasPlainObjectPrototype(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === null || Object.getPrototypeOf(prototype) === null
}

/** Return every JSON-visible object key, or reject own data JSON would discard. */
function enumerableStringKeys(value: object): string[] | undefined {
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(value, key))) return undefined
  return keys as string[]
}
/* jscpd:ignore-end */

/**
 * Validate and detach one worker-boundary value without loading another
 * workspace package at runtime. This mirrors the session-owned canonical
 * JSON boundary while remaining safe to import from the unbuilt worker.
 *
 * @param value - the candidate completion value.
 * @returns a detached lossless-JSON snapshot, or `undefined` when invalid.
 */
export function snapshotCodeJsonValue(value: unknown): CodeJsonValue | undefined {
  const active = new Set<object>()

  const within = <T extends CodeJsonValue>(source: object, build: () => T | undefined): T | undefined => {
    if (active.has(source)) return undefined
    active.add(source)
    try {
      return build()
    } finally {
      active.delete(source)
    }
  }

  const copy = (candidate: unknown): CodeJsonValue | undefined => {
    if (candidate === null) return null
    if (typeof candidate === 'boolean' || typeof candidate === 'string') return candidate
    if (typeof candidate === 'number') {
      return Number.isFinite(candidate) && !Object.is(candidate, -0) ? candidate : undefined
    }
    if (typeof candidate !== 'object') return undefined

    if (Array.isArray(candidate)) {
      if (!hasPlainArrayPrototype(candidate)) return undefined
      const length = candidate.length
      if (Reflect.ownKeys(candidate).length !== length + 1) return undefined
      return within(candidate, () => {
        const result: CodeJsonValue[] = []
        for (let index = 0; index < length; index++) {
          if (!Object.hasOwn(candidate, index)) return undefined
          const item = copy(candidate[index])
          if (item === undefined) return undefined
          result.push(item)
        }
        return result
      })
    }

    if (!hasPlainObjectPrototype(candidate)) return undefined
    const keys = enumerableStringKeys(candidate)
    if (keys === undefined) return undefined
    return within(candidate, () => {
      const result: Record<string, CodeJsonValue> = {}
      for (const key of keys) {
        const item = copy((candidate as Record<string, unknown>)[key])
        if (item === undefined) return undefined
        Object.defineProperty(result, key, {
          value: item,
          enumerable: true,
          configurable: true,
          writable: true,
        })
      }
      return result
    })
  }

  return copy(value)
}
