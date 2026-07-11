/**
 * JSON-serializability validation for session event data.
 * @module @deepseek-ai/dsh-session/json
 */

/**
 * A value that round-trips losslessly through JSON: `null`, a boolean, a finite
 * number, a string, an array of such values, or a plain object whose values are
 * such values. The static type companion to {@link isJsonValue} (which validates
 * the same shape at runtime). Use it to type a payload that must survive
 * session-log persistence and replay byte-identically — e.g. a tool's private
 * presentation `meta`.
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/**
 * Whether `value` is losslessly JSON-serializable: only `null`, finite numbers, booleans,
 * strings, plain arrays, and plain objects of such values.
 *
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
      return Number.isFinite(value)
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
