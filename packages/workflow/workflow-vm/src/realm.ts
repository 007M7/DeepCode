/**
 * Realm-boundary materialization for the vm engine.
 *
 * Values produced INSIDE the script realm (the meta literal, hook arguments,
 * the script's return value) must become plain host-realm JSON data before the
 * host touches them. The repo's `isJsonValue` guard cannot run first: it is
 * prototype-strict (any cross-realm object fails it) and it INVOKES getters
 * (letting realm code run outside the vm's timed window). So this module walks
 * own-property DESCRIPTORS — never invoking accessors — and copies data into
 * host containers, rejecting loud everything JSON cannot carry:
 * accessor properties, non-plain prototypes, functions, symbols (keys or
 * values), bigints, non-finite numbers, `undefined` values, cycles, sparse
 * arrays, arrays with non-index own properties, and proxies. Proxies are
 * rejected via the trap-free native `util.types.isProxy` check BEFORE any
 * other inspection — a descriptor walk over a proxy would otherwise run its
 * realm-side traps (`ownKeys`, `getOwnPropertyDescriptor`, `getPrototypeOf`)
 * on the host stack, outside the vm's timed window, and a throwing trap would
 * escape as a raw realm error instead of a {@link MaterializeError}. The same
 * check guards the PROTOTYPE position (an object whose prototype is a proxy).
 *
 * Host objects are built with `Object.defineProperty` into a fresh `{}` —
 * never plain `target[key] =` assignment, which a `"__proto__"` key would turn
 * into prototype mutation instead of a data property.
 *
 * The host→realm direction deliberately does NOT live here: a host object
 * handed into the realm would expose host intrinsics through its prototype
 * chain, so the engine rebuilds inbound values INSIDE the realm via the
 * context's own `JSON.parse` (see the runtime).
 *
 * @module @deepseek-ai/dsh-workflow-vm/realm
 */

import { types } from 'node:util'

/** Thrown by {@link materializeFromRealm}; the caller wraps it into the right `WorkflowError` code. */
export class MaterializeError extends Error {
  constructor(public readonly path: string, public readonly reason: string) {
    super(`${path}: ${reason}`)
    this.name = 'MaterializeError'
  }
}

/**
 * Whether an object's prototype chain is data-shaped: `null`, or a prototype
 * whose own prototype is `null` (the realm's `Object.prototype` — which we
 * cannot compare by identity across realms). A `Date`/`Map`/class instance
 * has a longer chain and is rejected, as is a proxy sitting in the prototype
 * position (checked trap-free BEFORE its own prototype is dereferenced).
 */
function hasPlainPrototype(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value)
  if (proto === null) return true
  if (types.isProxy(proto)) return false
  return Object.getPrototypeOf(proto) === null
}

/**
 * Copy `value` (typically from the vm realm) into plain host JSON data.
 * Throws {@link MaterializeError} naming the offending path for anything JSON
 * cannot carry losslessly. Accessors are detected via descriptors and NEVER
 * invoked. `undefined` is accepted only at the ROOT (a script with no
 * `return` value) — the caller decides what it means; an `undefined` nested
 * INSIDE a container is a violation.
 * @param value - the realm value to materialize.
 * @param root - the path label for the root value (error messages).
 * @returns the host-realm copy (plain objects/arrays/scalars only).
 */
export function materializeFromRealm(value: unknown, root = 'value'): unknown {
  if (value === undefined) return undefined
  return materialize(value, root, new Set())
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
      throw new MaterializeError(path, 'functions cannot cross the workflow realm boundary')
    case 'symbol':
      throw new MaterializeError(path, 'symbols cannot cross the workflow realm boundary')
    case 'undefined':
      throw new MaterializeError(path, 'undefined is not JSON data')
    case 'object':
      break
  }
  if (value === null) return null
  // BEFORE anything else touches the object: every inspection below —
  // Array.isArray aside — can trigger a proxy trap, running realm code on the
  // host stack (module doc). isProxy is a native internal-slot check (no
  // traps, catches revoked proxies, realm-agnostic).
  if (types.isProxy(value)) throw new MaterializeError(path, 'proxies cannot cross the workflow realm boundary')
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
    const descriptor = Object.getOwnPropertyDescriptor(value, index)
    if (descriptor === undefined) throw new MaterializeError(`${path}[${index}]`, 'sparse arrays are not JSON data')
    if (!('value' in descriptor)) throw new MaterializeError(`${path}[${index}]`, 'accessor properties cannot cross the workflow realm boundary')
    out.push(materialize(descriptor.value, `${path}[${index}]`, seen))
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
    throw new MaterializeError(path, 'symbol-keyed properties cannot cross the workflow realm boundary')
  }
  return out
}

function materializeObject(value: object, path: string, seen: Set<object>): Record<string, unknown> {
  if (!hasPlainPrototype(value)) {
    throw new MaterializeError(path, 'only plain objects and arrays are JSON data (exotic prototype)')
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new MaterializeError(path, 'symbol-keyed properties cannot cross the workflow realm boundary')
  }
  const out: Record<string, unknown> = {}
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    // Non-enumerable own props never reach JSON output — skip them, matching
    // JSON.stringify's contract exactly (documented in the module doc).
    if (!descriptor.enumerable) continue
    if (!('value' in descriptor)) {
      throw new MaterializeError(`${path}.${key}`, 'accessor properties cannot cross the workflow realm boundary')
    }
    // defineProperty, never assignment: a "__proto__" key must become an OWN
    // data property of the copy, not a prototype mutation.
    Object.defineProperty(out, key, {
      value: materialize(descriptor.value, `${path}.${key}`, seen),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return out
}
