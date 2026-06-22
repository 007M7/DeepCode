/**
 * JSON-serializability validation for session event data.
 *
 * The session event log is the durable source of truth (the event-sourcing / session-persistence RFCs): every
 * `event.data` must round-trip losslessly through JSON so any persistence
 * backend can store and reload it byte-identically. This invariant belongs to
 * the log itself — `Session.append` enforces it at the source, so a
 * non-serializable event never enters `session.events` and the live log can
 * never diverge from what a backend can persist. Backends re-use the same
 * predicate to validate their own `append(events)` entry point (replay/fork
 * paths that do not go through a live `Session`).
 *
 * @module @deepseek-ai/dsh-session/json
 */

/**
 * Whether `value` is losslessly JSON-serializable: only `null`, finite numbers,
 * booleans, strings, plain arrays, and plain objects of such values. Rejects
 * `BigInt`, function, symbol, `undefined`, non-finite numbers (`NaN`/`Infinity`,
 * which `JSON.stringify` turns into `null`), and exotic objects (`Map`/`Set`/
 * `Date`/class instances) — anything `JSON.stringify` would drop, throw on, or
 * convert lossily. Sparse arrays are rejected too: a hole serializes to `null`,
 * so `[1, , 3]` would not round-trip. Detects circular references (which would
 * throw) and reports them as non-serializable rather than propagating the throw.
 *
 * Scope — matches `JSON.stringify` exactly: only an object's OWN ENUMERABLE
 * STRING-keyed properties are inspected (`Object.values`). Symbol-keyed and
 * non-enumerable properties are NOT examined, because `JSON.stringify` likewise
 * drops them — they never reach the durable form, so a non-serializable value
 * hiding under a symbol/non-enumerable key cannot make the round-trip lossy.
 * Getters are invoked during the check (again as `JSON.stringify` would), so the
 * contract is for plain data records, not objects with side-effecting accessors.
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
