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
 * {@link REALM_THROWN_RENDERER_SOURCE}, {@link thrownRendering}, and
 * {@link describeThrown} are the same discipline for the one place realm
 * values reach the host WITHOUT materialization: a thrown value crossing into
 * a host catch block. The renderer runs INSIDE the realm's own execution
 * window (compiled into the script wrapper), so reading a hostile
 * accessor/`toString` there is subject to the vm sync-slice timeout exactly
 * like any other script code; the host side only descriptor-reads the
 * pre-rendered string, or falls back to {@link describeThrown}, which invokes
 * no getter whose function identity is not the host realm's own native stack
 * getter.
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
 * Realm-SOURCE text (an arrow-function expression) the engine compiles into
 * its script wrappers: `throw (RENDERER)(e)` inside a catch around the whole
 * body/literal. It renders the thrown value to a string INSIDE the realm's
 * own execution window — a hostile `stack`/`message` accessor or `toString`
 * invoked here is subject to the vm sync-slice timeout like any other script
 * code (and post-await it is the engine's accepted spin limitation, identical
 * to a script reading `e.stack` in its own catch). Host `WorkflowError`s
 * thrown by hooks pass through unwrapped (duck-checked by name — a realm
 * forgery fails the host's `instanceof` and merely renders data-only);
 * everything else becomes `{ __wfThrown: <string> }`, whose only consumer is
 * {@link thrownRendering}. Every read is individually contained, so the
 * renderer itself never throws.
 */
export const REALM_THROWN_RENDERER_SOURCE = `(e) => {
  try { if (e && e.name === 'WorkflowError') return e } catch { /* hostile name getter: fall through to rendering */ }
  const rendered = (() => {
    try { if (e && typeof e.stack === 'string' && e.stack.length > 0) return e.stack } catch { /* hostile stack getter */ }
    try { if (e && typeof e.message === 'string') return e.message } catch { /* hostile message getter */ }
    try { return String(e) } catch { /* hostile toString/Symbol.toPrimitive */ }
    return '[unrenderable thrown value]'
  })()
  return { __wfThrown: rendered }
}`

/**
 * The pre-rendered failure text carried by a realm-catch wrapper object
 * (`{ __wfThrown: string }` from {@link REALM_THROWN_RENDERER_SOURCE}), or
 * `undefined` when `error` is not such a wrapper. Descriptor-read and
 * proxy-guarded: never invokes user code.
 * @param error - the value a host catch received from script execution.
 * @returns the realm-rendered string, or `undefined` to fall back to
 *   {@link describeThrown}.
 */
export function thrownRendering(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || types.isProxy(error)) return undefined
  const value = ownDataProperty(error, '__wfThrown')
  return typeof value === 'string' ? value : undefined
}

/**
 * The host realm's own native `stack` getter (modern V8 makes `stack` an own
 * ACCESSOR on Errors); `undefined` where it is a data property. Typed through
 * a structural view of the descriptor — it is only ever identity-compared or
 * `.call`ed on an explicit receiver, never invoked unbound.
 */
const HOST_STACK_GETTER: unknown = (Object.getOwnPropertyDescriptor(new Error(), 'stack') as { get?: unknown } | undefined)?.get

/**
 * Render a thrown value HOST-SIDE without ever throwing and without running
 * any code the host does not own: proxies become a fixed label (trap-free
 * `isProxy` before any inspection); `stack` is read as an own data descriptor,
 * or through its getter ONLY when that getter's function identity is the host
 * realm's own native stack getter (an unforgeable check — realm code cannot
 * hold that identity, and the host realm's `prepareStackTrace` is the host's
 * own trust domain); `message` is an own-data read; anything else
 * object-shaped renders as `[object Object]` untouched; only primitives
 * (which cannot carry code) reach `String()`. Used for host-thrown errors
 * (vm timeouts, `WorkflowError`s) and as the fallback for adversarial values
 * that bypassed the realm-side renderer (e.g. a hostile thenable rejection);
 * ordinary script failures arrive pre-rendered via {@link thrownRendering}.
 * @param error - the thrown value, of any shape and any realm.
 * @returns human-readable text for the failure report; prefers the stack.
 */
export function describeThrown(error: unknown): string {
  switch (typeof error) {
    case 'object':
      break
    case 'function':
      return '[thrown function]'
    default:
      // Primitives (string/number/boolean/bigint/symbol/undefined): String()
      // cannot reach user code on these.
      return String(error)
  }
  if (error === null) return 'null'
  if (types.isProxy(error)) return '[thrown proxy]'
  const stack = readStack(error)
  if (typeof stack === 'string' && stack.length > 0) return stack
  const message = ownDataProperty(error, 'message')
  if (typeof message === 'string') return message
  return '[object Object]'
}

/**
 * Read `error.stack` without running foreign code: an own DATA descriptor is
 * read directly; an accessor is invoked only on function identity with
 * {@link HOST_STACK_GETTER} (never a realm or user function). The native
 * getter returns `undefined` on a non-Error receiver rather than throwing.
 */
function readStack(error: object): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(error, 'stack')
  if (descriptor === undefined) return undefined
  if ('value' in descriptor) return descriptor.value
  if (typeof descriptor.get !== 'function') return undefined
  if (descriptor.get !== HOST_STACK_GETTER) return undefined
  return descriptor.get.call(error)
}

/** An own DATA property's value (`undefined` for absent or accessor); never invokes user code on a non-proxy object. */
function ownDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
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
