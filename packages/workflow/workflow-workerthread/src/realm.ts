/**
 * The engine's value boundary: copy script-realm values into plain JSON data — loud about
 * everything JSON cannot carry — and render thrown script values to failure text.
 * @module @deepseek-ai/dsh-workflow-workerthread/realm
 */

/** Thrown by {@link materializeFromRealm}; the caller wraps it into the right `WorkflowError` code. */
export class MaterializeError extends Error {
  constructor(public readonly path: string, public readonly reason: string) {
    super(`${path}: ${reason}`)
    this.name = 'MaterializeError'
  }
}

/**
 * Render a thrown value to failure text without ever throwing: prefer the
 * `stack` (host or realm — a realm error's `stack` is a plain string read),
 * fall back to `message`, then `String()`. Reading those properties MAY run
 * script code (a getter, `toString`) — accepted under the module's trust
 * premise; if that code itself throws, a fixed label is returned instead.
 * @param error - the thrown value, of any shape and any realm.
 * @returns human-readable text for the failure report; prefers the stack.
 */
export function renderThrown(error: unknown): string {
  try {
    const stack = (error as { stack?: unknown } | null | undefined)?.stack
    if (typeof stack === 'string' && stack.length > 0) return stack
    const message = (error as { message?: unknown } | null | undefined)?.message
    if (typeof message === 'string' && message.length > 0) return message
    return String(error)
  } catch {
    // A throwing accessor/toString on the thrown value — rendering must be
    // total (drive()'s never-reject contract), so fall back to a fixed label.
    return '[unrenderable thrown value]'
  }
}

/**
 * Whether an object's prototype chain is data-shaped: `null`, or a prototype
 * whose own prototype is `null` (the realm's `Object.prototype` — which we
 * cannot compare by identity across realms). A `Date`/`Map`/class instance
 * has a longer chain and is rejected.
 */
function hasPlainPrototype(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value)
  if (proto === null) return true
  return Object.getPrototypeOf(proto) === null
}

/**
 * Copy `value` (typically from the vm realm) into plain host JSON data.
 *
 * @param value - the realm value to materialize.
 * @param root - the path label for the root value (error messages).
 * @returns the host-realm copy (plain objects/arrays/scalars only).
 */
export function materializeFromRealm(value: unknown, root = 'value'): unknown {
  if (value === undefined) return undefined
  try {
    return materialize(value, root, new Set())
  } catch (error: unknown) {
    if (error instanceof MaterializeError) throw error
    // A property read ran script code that threw; total-ize it so callers can
    // keep the narrow MaterializeError contract.
    throw new MaterializeError(root, `reading the value threw: ${renderThrown(error)}`)
  }
}

function materialize(value: unknown, path: string, seen: Set<object>): unknown {
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return value
    case 'number': {
      if (!Number.isFinite(value)) throw new MaterializeError(path, 'non-finite numbers are not JSON data')
      return value
    }
    case 'bigint':
      throw new MaterializeError(path, 'bigints are not JSON data')
    case 'function':
      throw new MaterializeError(path, 'functions cannot cross the workflow value boundary')
    case 'symbol':
      throw new MaterializeError(path, 'symbols cannot cross the workflow value boundary')
    case 'undefined':
      throw new MaterializeError(path, 'undefined is not JSON data')
    case 'object':
      break
  }
  if (value === null) return null
  const objectValue: object = value
  if (seen.has(objectValue)) throw new MaterializeError(path, 'circular references are not JSON data')
  seen.add(objectValue)
  try {
    if (Array.isArray(objectValue)) return materializeArray(objectValue, path, seen)
    return materializeObject(objectValue, path, seen)
  } finally {
    seen.delete(objectValue)
  }
}

function materializeArray(value: unknown[], path: string, seen: Set<object>): unknown[] {
  const out: unknown[] = []
  for (let index = 0; index < value.length; index++) {
    if (!(index in value)) throw new MaterializeError(`${path}[${index}]`, 'sparse arrays are not JSON data')
    out.push(materialize(value[index], `${path}[${index}]`, seen))
  }
  // Own enumerable props beyond the indices (e.g. `arr.total = 3`) would be
  // silently dropped by JSON — reject them instead.
  for (const key of Object.keys(value)) {
    const index = Number(key)
    if (!Number.isInteger(index) || index < 0 || index >= value.length) {
      throw new MaterializeError(`${path}.${key}`, 'arrays with non-index properties are not JSON data')
    }
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new MaterializeError(path, 'symbol-keyed properties cannot cross the workflow value boundary')
  }
  return out
}

function materializeObject(value: object, path: string, seen: Set<object>): Record<string, unknown> {
  if (!hasPlainPrototype(value)) {
    throw new MaterializeError(path, 'only plain objects and arrays are JSON data (exotic prototype)')
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new MaterializeError(path, 'symbol-keyed properties cannot cross the workflow value boundary')
  }
  const out: Record<string, unknown> = {}
  // Object.keys = own enumerable string keys, matching JSON.stringify's
  // property selection exactly (non-enumerable props never reach JSON output).
  for (const key of Object.keys(value)) {
    // defineProperty, never assignment: a "__proto__" key must become an OWN
    // data property of the copy, not a prototype mutation.
    Object.defineProperty(out, key, {
      value: materialize((value as Record<string, unknown>)[key], `${path}.${key}`, seen),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return out
}
