/** Lossless-JSON snapshots for the dependency-free source worker closure. @module @deepseek-ai/dsh-code-runtime-worker/worker-json */

import type { CodeJsonValue } from '@deepseek-ai/dsh-code-runtime'

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
      if (Object.getPrototypeOf(candidate) !== Array.prototype) return undefined
      if (Reflect.ownKeys(candidate).length !== candidate.length + 1) return undefined
      return within(candidate, () => {
        const result: CodeJsonValue[] = []
        for (let index = 0; index < candidate.length; index++) {
          if (!Object.hasOwn(candidate, index)) return undefined
          const item = copy(candidate[index])
          if (item === undefined) return undefined
          result.push(item)
        }
        return result
      })
    }

    const prototype = Object.getPrototypeOf(candidate) as unknown
    if (prototype !== Object.prototype && prototype !== null) return undefined
    return within(candidate, () => {
      const result: Record<string, CodeJsonValue> = {}
      for (const key of Object.keys(candidate)) {
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
