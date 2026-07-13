/**
 * Lossless-JSON validation and snapshot materialization for session data.
 *
 * The session event log is the durable source of truth (the event-sourcing / session-persistence RFCs): every
 * `event.data` must round-trip losslessly through JSON so any persistence
 * backend can store and reload it byte-identically. This invariant belongs to
 * the log itself — `Session.append` enforces it at the source, so a
 * non-serializable event never enters `session.events` and the live log can
 * never diverge from what a backend can persist. Other public boundaries use
 * {@link snapshotJsonValue} when they must validate and detach in one pass;
 * {@link isJsonValue} remains the non-copying structural predicate.
 *
 * @module @deepseek-ai/dsh-session/json
 */

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
 * Materialize one detached lossless-JSON snapshot in a SINGLE recursive pass.
 * Each array slot or own enumerable string-keyed object value is read exactly
 * once, validated, and copied immediately. This is intentionally not
 * `isJsonValue(value)` followed by `structuredClone(value)`: a stateful getter
 * could return plain JSON to the check and an exotic class instance to the
 * clone, whose prototype `structuredClone` would erase before a later check.
 *
 * Accepts the same scalar/object vocabulary as {@link isJsonValue}: arrays use
 * the ordinary `Array.prototype` (subclass instances are not plain JSON
 * containers), while null-prototype objects are accepted and normalized to
 * ordinary plain objects. Sparse arrays, cycles, negative zero, non-finite
 * numbers, unsupported scalar types, and exotic object or array shells return
 * `undefined`. A throwing getter is a caller failure and propagates unchanged.
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
 * Whether `value` is losslessly JSON-serializable: only `null`, finite numbers
 * other than negative zero, booleans, strings, plain arrays, and plain objects
 * of such values. Rejects `BigInt`, function, symbol, `undefined`, `-0` (which
 * JSON rewrites to `0`), non-finite numbers (`NaN`/`Infinity`, which JSON turns
 * into `null`), and exotic objects (`Map`/`Set`/`Date`/class instances) —
 * anything `JSON.stringify` would drop, throw on, or convert lossily. Sparse
 * arrays are rejected too: a hole serializes to `null`, so `[1, , 3]` would not
 * round-trip. Detects circular references (which would throw) and reports them
 * as non-serializable rather than propagating the throw.
 *
 * Scope — this is a structural plain-data predicate, not an invocation of
 * `JSON.stringify`: only an object's OWN ENUMERABLE STRING-keyed properties are
 * inspected (`Object.values`). Symbol-keyed and non-enumerable properties are
 * omitted from the durable data surface. Custom `toJSON` behavior is not
 * executed; boundaries that persist a value first materialize a new plain-data
 * record with {@link snapshotJsonValue}. Getters are invoked during this check,
 * so callers that need a stable detached value use that one-pass materializer
 * instead of checking and then rereading a side-effecting record.
 * @param value - the candidate event data to test.
 * @param seen - objects on the current descent path, for circular-reference
 *   detection; the recursion threads it — callers omit it.
 * @returns true when `value` survives a JSON round-trip losslessly.
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
