/** Lossless-JSON validation and detached snapshots for durable session data. @module @deepseek-ai/dsh-session/json */

/**
 * A value that round-trips losslessly through JSON: `null`, a boolean, a finite
 * number other than negative zero, a string, an array of such values, or a
 * plain object whose values are such values. TypeScript cannot distinguish
 * `-0` from `number`, so {@link isJsonValue} and {@link snapshotJsonValue}
 * enforce that last numeric detail at runtime. Use this type for a payload that
 * must survive session-log persistence and replay byte-identically — e.g. a
 * tool's private presentation `meta`.
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/**
 * Validate and detach lossless JSON in one read per property, so a stateful
 * getter cannot change between validation and copying. Accepts ordinary arrays,
 * plain or null-prototype objects, and JSON scalars; rejects sparse, cyclic,
 * exotic, negative-zero, and non-finite values. Getter throws propagate.
 *
 * @param value - the candidate value to validate and detach.
 * @returns the detached snapshot, or `undefined` when the value is not
 *   losslessly JSON-serializable.
 */
export function snapshotJsonValue<T>(value: T): T | undefined {
  const ancestors = new Set<object>()

  const visit = (current: unknown): JsonValue | undefined => {
    if (current === null) return null
    switch (typeof current) {
      case 'boolean':
      case 'string':
        return current
      case 'number':
        return Number.isFinite(current) && !Object.is(current, -0) ? current : undefined
      case 'bigint':
      case 'function':
      case 'symbol':
      case 'undefined':
        return undefined
      case 'object':
        break
    }

    if (ancestors.has(current)) return undefined
    ancestors.add(current)
    try {
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype) return undefined
        const length = current.length
        const snapshot: JsonValue[] = []
        for (let index = 0; index < length; index++) {
          if (!Object.prototype.hasOwnProperty.call(current, index)) return undefined
          const item = visit(current[index])
          if (item === undefined) return undefined
          snapshot.push(item)
        }
        return snapshot
      }

      const prototype = Object.getPrototypeOf(current) as unknown
      if (prototype !== Object.prototype && prototype !== null) return undefined
      const snapshot: { [key: string]: JsonValue } = {}
      for (const key of Object.keys(current)) {
        const item = visit((current as Record<string, unknown>)[key])
        if (item === undefined) return undefined
        // Define the key as data so a JSON field literally named "__proto__"
        // cannot mutate the snapshot's prototype through ordinary assignment.
        Object.defineProperty(snapshot, key, {
          value: item,
          enumerable: true,
          configurable: true,
          writable: true,
        })
      }
      return snapshot
    } finally {
      ancestors.delete(current)
    }
  }

  return visit(value) as T | undefined
}

/**
 * Test the same lossless JSON boundary as {@link snapshotJsonValue} without
 * detaching it. Only own enumerable string properties participate; `toJSON`
 * is ignored and getters run, so persistence boundaries use the snapshotter.
 * @param value - the candidate event data to test.
 * @param seen - current recursion path; callers omit it.
 * @returns whether `value` survives JSON round-trip losslessly.
 */
export function isJsonValue(value: unknown, seen: Set<object> = new Set()): boolean {
  if (value === null) return true
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return true
    case 'number':
      return Number.isFinite(value) && !Object.is(value, -0)
    case 'bigint':
    case 'function':
    case 'symbol':
    case 'undefined':
      return false
    case 'object':
      break // handled below
  }
  // object
  if (seen.has(value)) return false // circular
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return false
      // Reject sparse arrays: a hole is skipped by `every`/`forEach` but
      // JSON.stringify writes it as `null`, so `[1, , 3]` would round-trip
      // lossily. Require every index 0..length-1 to be an OWN property.
      for (let i = 0; i < value.length; i++) {
        if (!Object.prototype.hasOwnProperty.call(value, i)) return false
        if (!isJsonValue(value[i], seen)) return false
      }
      return true
    }
    // Plain object only (reject Map/Set/Date/class instances).
    const proto = Object.getPrototypeOf(value) as unknown
    if (proto !== Object.prototype && proto !== null) return false
    return Object.values(value).every(v => isJsonValue(v, seen))
  } finally {
    seen.delete(value)
  }
}
