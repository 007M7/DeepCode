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

interface ArrayWireToken {
  kind: 'array'
  length: number
}

interface ObjectWireToken {
  kind: 'object'
  keys: string[]
}

type WorkerJsonToken = null | boolean | number | string | ArrayWireToken | ObjectWireToken

/**
 * A pre-order, bounded-depth transport for one lossless JSON value. Container
 * markers and scalar leaves share one flat token array, so `worker_threads`
 * never has to structured-clone the value's application nesting.
 */
export type WorkerJsonWire = WorkerJsonToken[]

/**
 * Flatten one validated JSON value for the worker-thread message port.
 * @param value - the lossless JSON value to transport.
 * @returns a pre-order token stream whose own nesting is bounded.
 */
export function encodeWorkerJson(value: CodeJsonValue): WorkerJsonWire {
  const wire: WorkerJsonWire = []
  const pending: CodeJsonValue[] = [value]
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (current === null || typeof current === 'boolean' || typeof current === 'number' || typeof current === 'string') {
      wire.push(current)
      continue
    }
    if (Array.isArray(current)) {
      wire.push({ kind: 'array', length: current.length })
      for (let index = current.length - 1; index >= 0; index--) {
        const item = current[index]
        if (item === undefined) throw new Error('cannot encode a sparse JSON array')
        pending.push(item)
      }
      continue
    }
    const keys = Object.keys(current)
    wire.push({ kind: 'object', keys })
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]
      /* v8 ignore next -- the loop is bounded by the captured key count. */
      if (key === undefined) throw new Error('cannot encode a missing JSON object key')
      const item = current[key]
      if (item === undefined) throw new Error('cannot encode an undefined JSON object property')
      pending.push(item)
    }
  }
  return wire
}

type DecodeFrame =
  | { kind: 'array'; target: CodeJsonValue[]; length: number; index: number }
  | { kind: 'object'; target: Record<string, CodeJsonValue>; keys: string[]; index: number }

/** Whether an array contains exactly its dense indexed slots and `length`. */
function isDenseArray(value: unknown[]): boolean {
  if (!hasPlainArrayPrototype(value) || Reflect.ownKeys(value).length !== value.length + 1) return false
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) return false
  }
  return true
}

/** Return one exact container marker, or reject any extra/missing fields. */
function containerToken(value: object): ArrayWireToken | ObjectWireToken | undefined {
  if (Array.isArray(value) || !hasPlainObjectPrototype(value)) return undefined
  const keys = enumerableStringKeys(value)
  if (keys === undefined) return undefined
  const token = value as Record<string, unknown>
  if (token.kind === 'array') {
    if (keys.length !== 2 || !keys.includes('kind') || !keys.includes('length')) return undefined
    const length = token.length
    return typeof length === 'number' && Number.isSafeInteger(length) && length >= 0
      ? { kind: 'array', length }
      : undefined
  }
  if (token.kind === 'object') {
    if (keys.length !== 2 || !keys.includes('kind') || !keys.includes('keys')) return undefined
    const objectKeys = token.keys
    if (!Array.isArray(objectKeys) || !isDenseArray(objectKeys)) return undefined
    const unique = new Set<string>()
    const normalizedKeys: string[] = []
    for (const key of objectKeys as unknown[]) {
      if (typeof key !== 'string' || unique.has(key)) return undefined
      unique.add(key)
      normalizedKeys.push(key)
    }
    return { kind: 'object', keys: normalizedKeys }
  }
  return undefined
}

/**
 * Rebuild one lossless JSON value from the flat worker-thread wire format.
 * Malformed or incomplete traffic returns `undefined`; traversal is iterative
 * and therefore independent of the transported value's application depth.
 * @param input - untrusted message-port payload.
 * @returns the detached JSON value, or `undefined` when the wire is invalid.
 */
export function decodeWorkerJson(input: unknown): CodeJsonValue | undefined {
  try {
    if (!Array.isArray(input) || !isDenseArray(input) || input.length === 0) return undefined
    const wire = input as unknown[]
    const frames: DecodeFrame[] = []
    let root: CodeJsonValue | undefined
    let rootAssigned = false

    const attach = (value: CodeJsonValue): boolean => {
      const parent = frames.at(-1)
      if (!parent) {
        if (rootAssigned) return false
        root = value
        rootAssigned = true
        return true
      }
      /* v8 ignore next -- completed frames are popped before another token can attach. */
      if (parent.index >= (parent.kind === 'array' ? parent.length : parent.keys.length)) return false
      if (parent.kind === 'array') {
        parent.target.push(value)
      } else {
        const key = parent.keys[parent.index]
        /* v8 ignore next -- object frames are built from validated keys and their exact length. */
        if (key === undefined) return false
        Object.defineProperty(parent.target, key, {
          value,
          enumerable: true,
          configurable: true,
          writable: true,
        })
      }
      parent.index += 1
      return true
    }

    for (let tokenIndex = 0; tokenIndex < wire.length; tokenIndex++) {
      const token = wire[tokenIndex]
      let value: CodeJsonValue
      let frame: DecodeFrame | undefined
      if (token === null || typeof token === 'boolean' || typeof token === 'string') {
        value = token
      } else if (typeof token === 'number') {
        if (!Number.isFinite(token) || Object.is(token, -0)) return undefined
        value = token
      } else {
        if (typeof token !== 'object') return undefined
        const marker = containerToken(token)
        if (!marker) return undefined
        const remainingTokens = wire.length - tokenIndex - 1
        if (marker.kind === 'array') {
          if (marker.length > remainingTokens) return undefined
          const target: CodeJsonValue[] = []
          value = target
          if (marker.length > 0) frame = { kind: 'array', target, length: marker.length, index: 0 }
        } else {
          if (marker.keys.length > remainingTokens) return undefined
          const target: Record<string, CodeJsonValue> = {}
          value = target
          if (marker.keys.length > 0) frame = { kind: 'object', target, keys: marker.keys, index: 0 }
        }
      }
      if (!attach(value)) return undefined
      if (frame) frames.push(frame)
      while (frames.length > 0) {
        const current = frames.at(-1)
        /* v8 ignore next -- the loop condition guarantees a final frame. */
        if (current === undefined) break
        if (current.index < (current.kind === 'array' ? current.length : current.keys.length)) break
        frames.pop()
      }
    }
    return frames.length === 0 ? root : undefined
  } catch {
    return undefined
  }
}
/* jscpd:ignore-end */
