/** Lossless-JSON snapshots for the dependency-free source worker closure. @module @deepseek-ai/dsh-code-runtime-worker/worker-json */

import type { CodeJsonValue } from '@deepseek-ai/dsh-code-runtime'

/* jscpd:ignore-start -- the source worker mirrors session JSON helpers without workspace runtime imports */
/** Whether a realm-owned intrinsic prototype names and points back to its constructor. */
function hasIntrinsicConstructor(prototype: object, name: 'Array' | 'Object'): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'constructor')
  const constructor: unknown = descriptor?.value
  return typeof constructor === 'function'
    && constructor.name === name
    && constructor.prototype === prototype
}

/** Whether a candidate is one realm's intrinsic `Object.prototype`. */
function isIntrinsicObjectPrototype(value: object): boolean {
  return Object.getPrototypeOf(value) === null && hasIntrinsicConstructor(value, 'Object')
}

/** Whether an array uses one realm's intrinsic `Array.prototype`, not a subclass or forged prototype. */
function hasPlainArrayPrototype(value: unknown[]): boolean {
  const prototype: unknown = Object.getPrototypeOf(value)
  if (!Array.isArray(prototype) || !hasIntrinsicConstructor(prototype, 'Array')) return false
  const objectPrototype: unknown = Object.getPrototypeOf(prototype)
  return typeof objectPrototype === 'object'
    && objectPrototype !== null
    && isIntrinsicObjectPrototype(objectPrototype)
}

/** Whether an object is a plain or null-prototype record from any JavaScript realm. */
function hasPlainObjectPrototype(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === null
    || typeof prototype === 'object' && isIntrinsicObjectPrototype(prototype)
}

/** Return every JSON-visible object key, or reject own data JSON would discard. */
function enumerableStringKeys(value: object): string[] | undefined {
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(value, key))) return undefined
  return keys as string[]
}

type SnapshotDestination =
  | { kind: 'root' }
  | { kind: 'array'; target: CodeJsonValue[]; index: number }
  | { kind: 'object'; target: Record<string, CodeJsonValue>; key: string }

type SnapshotTask =
  | { kind: 'visit'; value: unknown; destination: SnapshotDestination }
  | { kind: 'array-item'; source: unknown[]; index: number; target: CodeJsonValue[] }
  | { kind: 'object-property'; source: Record<string, unknown>; key: string; target: Record<string, CodeJsonValue> }
  | { kind: 'leave'; source: object }

/**
 * Validate and detach one worker-boundary value without loading another
 * workspace package at runtime. This mirrors the session-owned canonical
 * JSON boundary while remaining safe to import from the unbuilt worker.
 * Its iterative traversal adds no JavaScript call-stack depth limit.
 *
 * @param value - the candidate completion value.
 * @returns a detached lossless-JSON snapshot, or `undefined` when invalid.
 */
export function snapshotCodeJsonValue(value: unknown): CodeJsonValue | undefined {
  const active = new Set<object>()
  let root: CodeJsonValue | undefined
  const assign = (destination: SnapshotDestination, item: CodeJsonValue): void => {
    if (destination.kind === 'root') {
      root = item
    } else if (destination.kind === 'array') {
      destination.target[destination.index] = item
    } else {
      Object.defineProperty(destination.target, destination.key, {
        value: item,
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
  }

  const tasks: SnapshotTask[] = [{ kind: 'visit', value, destination: { kind: 'root' } }]
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.kind === 'leave') {
      active.delete(task.source)
      continue
    }
    if (task.kind === 'array-item') {
      if (!Object.hasOwn(task.source, task.index)) return undefined
      tasks.push({
        kind: 'visit',
        value: task.source[task.index],
        destination: { kind: 'array', target: task.target, index: task.index },
      })
      continue
    }
    if (task.kind === 'object-property') {
      tasks.push({
        kind: 'visit',
        value: task.source[task.key],
        destination: { kind: 'object', target: task.target, key: task.key },
      })
      continue
    }

    const candidate = task.value
    if (candidate === null) {
      assign(task.destination, null)
      continue
    }
    if (typeof candidate === 'boolean' || typeof candidate === 'string') {
      assign(task.destination, candidate)
      continue
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate) || Object.is(candidate, -0)) return undefined
      assign(task.destination, candidate)
      continue
    }
    if (typeof candidate !== 'object') return undefined
    if (active.has(candidate)) return undefined

    if (Array.isArray(candidate)) {
      if (!hasPlainArrayPrototype(candidate)) return undefined
      const length = candidate.length
      if (Reflect.ownKeys(candidate).length !== length + 1) return undefined
      const target: CodeJsonValue[] = []
      assign(task.destination, target)
      active.add(candidate)
      tasks.push({ kind: 'leave', source: candidate })
      for (let index = length - 1; index >= 0; index--) {
        tasks.push({ kind: 'array-item', source: candidate, index, target })
      }
      continue
    }

    if (!hasPlainObjectPrototype(candidate)) return undefined
    const keys = enumerableStringKeys(candidate)
    if (keys === undefined) return undefined
    const target: Record<string, CodeJsonValue> = {}
    assign(task.destination, target)
    active.add(candidate)
    tasks.push({ kind: 'leave', source: candidate })
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]
      /* v8 ignore next -- the loop is bounded by the captured key count. */
      if (key === undefined) return undefined
      tasks.push({ kind: 'object-property', source: candidate as Record<string, unknown>, key, target })
    }
  }
  return root
}
/* jscpd:ignore-end */
