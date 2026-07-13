/**
 * The registration boundary between sandboxed mount code and the real runtime:
 * SchemaSpec normalization + validation with teaching errors, the
 * marker-guarded `harness.defineTool` / `harness.registerTool` pair, the
 * SANDBOX CONTEXT FAÇADE a mounted plugin's `apply` receives in place of the
 * real `ctx`, and the plugin-shape helpers the mount lifecycle narrows sandbox
 * return values with.
 *
 * The façade is a WHITELIST, not a pass-through proxy. Mount code needs to do
 * exactly four things — register a tool, listen to an event, provide a service,
 * call an injected service (timers included) — so the façade exposes only those
 * verbs and the injected services, each object-valued service individually
 * wrapped (a primitive provided value passes through as-is — see
 * {@link sandboxContext}). Every framework plumbing member (`root`, `parent`, `scope`, `fiber`, `reflect`, `registry`,
 * `events`, `extend`, `isolate`, `intercept`, `plugin`, `set`, `mixin`, …) is
 * DENIED with a teaching error rather than passed through. This closes an
 * entire escape class at once: a pass-through proxy that only special-cased
 * `ctx.tools` still handed back the raw context through `ctx.root`,
 * `ctx.extend()`, or a service instance's `.ctx`, and mount code could then
 * `ctx.root.tools.register({…})` to bypass the marker check and host-realm
 * normalization — a raw vm-realm result then errors a real agent turn at the
 * session-log plainness check. The whitelist has no such hole: there is no
 * context-valued member to reach, and any injected-service method that returns
 * a `Context` is rejected (harness services never do — see {@link denyContext}).
 *
 * Two realm facts drive the tool path. Objects built inside the vm carry the vm
 * realm's `Object.prototype`, and the session log's append-time plainness check
 * (`dsh-session`'s `isJsonValue`, a prototype-identity comparison) rejects
 * foreign-realm data — so every dynamic tool's `execute` return is JSON
 * round-tripped into the host realm and shape-checked against the two
 * `ToolExecuteReturn` forms before it reaches the registry (the registry
 * trusts the shape blindly — it spreads `result.content`, so an unvalidated
 * `{ content: 'ok' }` would enter the session log as `['o','k']` and silently
 * corrupt the next model request), and the schema itself is rebuilt as fresh
 * host-realm objects. And a malformed tool
 * schema must fail at REGISTRATION, not when a later request assembles it — so
 * dynamic tool registration accepts only definitions produced by the sandbox's
 * `harness.defineTool`, which normalizes `parameters` up front.
 *
 * Normalize, don't lecture, where the input has exactly one meaning: models
 * write the JSON-Schema dialect by strong prior (the `{ type: 'object',
 * properties, required: […] }` wrapper, `type: 'integer'`, `required: false`),
 * and each rejection costs a model turn — so those convert to the SchemaSpec
 * DSL silently, and only genuinely meaningless input (an unknown type, a
 * non-boolean `required`) is rejected, with the error enumerating the valid
 * vocabulary.
 *
 * @module @deepseek-ai/dsh-tool-cordis/guard
 */

import { Context } from 'cordis'
import type { Plugin } from 'cordis'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecuteReturn } from '@deepseek-ai/dsh-tools'

const DYNAMIC_TOOL = Symbol('tool-cordis.dynamic-tool')
const SCHEMA_TYPES = new Set<unknown>(['string', 'number', 'boolean', 'object', 'array'])
const VALID_TYPES = '\'string\' | \'number\' | \'boolean\' | \'object\' | \'array\''

type DynamicToolDefinition = ToolDefinition & { [DYNAMIC_TOOL]: true }
type DynamicToolMarker = { [DYNAMIC_TOOL]?: unknown }

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]'
}

/**
 * Normalize a sandbox-provided `parameters` value into a fresh host-realm
 * SchemaSpec. Accepts the DSL directly, or the JSON-Schema-style
 * `{ type: 'object', properties, required: […] }` wrapper models write by
 * prior — the wrapper unwraps and its `required` array becomes per-property
 * flags (see the module doc).
 */
function normalizeSchemaSpec(value: unknown, path = 'parameters'): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new Error(`harness.defineTool ${path} must be a SchemaSpec object`)
  }
  let entries = value
  const requiredNames = new Set<unknown>()
  if (value.type === 'object' && isPlainRecord(value.properties)) {
    if (Array.isArray(value.required)) {
      for (const name of value.required) requiredNames.add(name)
    }
    entries = value.properties
  }
  const spec: Record<string, unknown> = {}
  for (const [key, prop] of Object.entries(entries)) {
    spec[key] = normalizeSchemaProp(prop, `${path}.${key}`, requiredNames.has(key))
  }
  return spec
}

/** Normalize one property: `integer` → `number`, `required: false` → absent, nested wrappers unwrapped recursively. */
function normalizeSchemaProp(value: unknown, path: string, forceRequired = false): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new Error(`harness.defineTool ${path} must be a SchemaSpec property object`)
  }
  const type = value.type === 'integer' ? 'number' : value.type
  if (!SCHEMA_TYPES.has(type)) {
    throw new Error(`harness.defineTool ${path} must declare a valid type: ${VALID_TYPES} (got ${JSON.stringify(value.type)})`)
  }
  // On an object property a JSON-Schema-style `required` ARRAY names required
  // children (handled by the nested unwrap below); everywhere else `required`
  // must be a boolean, and `false` simply reads as optional.
  const nestedRequiredArray = type === 'object' && Array.isArray(value.required)
  if (value.required !== undefined && typeof value.required !== 'boolean' && !nestedRequiredArray) {
    throw new Error(`harness.defineTool ${path}.required must be a boolean when present`)
  }
  const prop: Record<string, unknown> = { type }
  if (forceRequired || value.required === true) prop.required = true
  if (typeof value.description === 'string') prop.description = value.description
  if (Array.isArray(value.enum)) prop.enum = [...value.enum as unknown[]]
  if (value.default !== undefined) prop.default = value.default
  if (value.properties !== undefined) {
    if (type !== 'object') {
      throw new Error(`harness.defineTool ${path}.properties is only valid for type "object"`)
    }
    // Re-wrap so the nested unwrap applies a nested `required` array too.
    prop.properties = normalizeSchemaSpec(
      { type: 'object', properties: value.properties, required: value.required },
      `${path}.properties`,
    )
  }
  if (value.items !== undefined) {
    if (type !== 'array') {
      throw new Error(`harness.defineTool ${path}.items is only valid for type "array"`)
    }
    prop.items = normalizeSchemaProp(value.items, `${path}.items`)
  }
  return prop
}

function markDynamicTool(tool: ToolDefinition): DynamicToolDefinition {
  Object.defineProperty(tool, DYNAMIC_TOOL, { value: true })
  return tool as DynamicToolDefinition
}

function assertDynamicTool(tool: unknown): asserts tool is DynamicToolDefinition {
  if (!isPlainRecord(tool) || (tool as DynamicToolMarker)[DYNAMIC_TOOL] !== true) {
    throw new Error('dynamic tool registration must use a tool returned by harness.defineTool(...)')
  }
}

/**
 * Structurally a content block, checked AFTER the JSON round-trip: a plain
 * object carrying a string `type` tag. Deliberately nothing deeper — the
 * ContentBlock union is merge-extensible (an unknown tag must pass), and every
 * downstream consumer dispatches on `type` and falls through unknowns.
 */
function isContentBlockShape(value: unknown): boolean {
  return isPlainRecord(value) && typeof value.type === 'string'
}

/**
 * How much of an invalid execute return the teaching error echoes back — a
 * huge blob would burn the model turn the error is trying to save.
 */
const RETURN_PREVIEW_LIMIT = 120

/**
 * Compact JSON preview of an invalid execute return for the teaching error
 * (`String(…)` for the un-stringifiable undefined case), truncated to
 * {@link RETURN_PREVIEW_LIMIT}.
 */
function describeReturn(value: unknown): string {
  // JSON.stringify is TYPED as always returning string, but it yields
  // undefined for an undefined input (the routed forgot-return case) — the
  // assertion widens the type back to the runtime truth.
  const json = JSON.stringify(value) as string | undefined
  if (json === undefined) return String(value)
  return json.length > RETURN_PREVIEW_LIMIT ? `${json.slice(0, RETURN_PREVIEW_LIMIT)}…` : json
}

/**
 * Validate a round-tripped `execute` return against the two shapes
 * {@link ToolExecuteReturn} allows: an ARRAY of content blocks, or
 * `{ content: blocks, meta? }`. The registry trusts the shape blindly — it
 * spreads `result.content`, so an unvalidated `{ content: 'ok' }` would enter
 * the session log as `['o','k']` and silently corrupt the next model request —
 * so a wrong shape fails THIS call with a teaching error instead.
 */
function assertExecuteReturn(value: unknown): ToolExecuteReturn {
  if (Array.isArray(value) && value.every(isContentBlockShape)) {
    return value as ToolExecuteReturn
  }
  if (isPlainRecord(value) && Array.isArray(value.content) && value.content.every(isContentBlockShape)) {
    return value as ToolExecuteReturn
  }
  throw new Error(
    `execute returned ${describeReturn(value)} — a tool's execute must return an ARRAY of content blocks, never a bare string:\n`
    + '  ✓ return [{ type: \'text\', text: someString }]\n'
    + '  ✓ return { content: [{ type: \'text\', text: someString }], meta: anyJsonValue }',
  )
}

/**
 * The `harness.defineTool` handed into the sandbox: the real DSL, with
 * `parameters` normalized into a fresh host-realm SchemaSpec (JSON-Schema
 * wrapper unwrapped, `integer` mapped, `required: false` dropped) and the
 * tool's `execute` return normalized into the host realm via a JSON round-trip
 * (see the module doc). The round-trip projects the return onto exactly what
 * the log would durably store, and {@link assertExecuteReturn} then vets that
 * projection — so a non-JSON-serializable OR wrong-shape return surfaces as
 * that one call's teaching error instead of poisoning the turn.
 * @param options - the standard `defineTool` options; `parameters` may be the SchemaSpec DSL or a JSON-Schema-style wrapper.
 * @returns the marker-tagged definition `harness.registerTool` (and the guarded `ctx.tools.register`) accepts.
 */
export function sandboxDefineTool(options: Parameters<typeof defineTool>[0]): ToolDefinition {
  const parameters = normalizeSchemaSpec((options as { parameters?: unknown }).parameters)
  const tool = defineTool({ ...options, parameters } as Parameters<typeof defineTool>[0])
  const execute = tool.execute.bind(tool)
  return markDynamicTool({
    ...tool,
    async execute(args, exec) {
      // JSON.stringify yields NO JSON for an undefined (or function/symbol)
      // return despite its string-typed signature — route that into
      // assertExecuteReturn's teaching error rather than letting JSON.parse
      // throw its cryptic '"undefined" is not valid JSON'.
      const json = JSON.stringify(await execute(args, exec)) as string | undefined
      return assertExecuteReturn(json === undefined ? undefined : JSON.parse(json) as unknown)
    },
  })
}

/**
 * The `harness.registerTool` handed into the sandbox: registers a
 * marker-verified dynamic tool on the given context's registry.
 * @param ctx - the (guarded) context whose `tools` service receives the tool.
 * @param tool - a definition produced by {@link sandboxDefineTool}; anything else is rejected.
 * @returns the registry disposer for the registration.
 */
export function sandboxRegisterTool(ctx: Context, tool: unknown): () => void {
  assertDynamicTool(tool)
  return ctx.tools.register(tool)
}

/**
 * The verbs a mounted plugin may reach through the sandbox `ctx` façade,
 * beyond its injected services. `on`/`once` observe events, `provide` exposes
 * a service to other mounts, and the timer helpers schedule work — each a
 * fiber effect that unwinds on unmount. Everything else on a real cordis `ctx`
 * is framework plumbing and is denied. Forwarded LAZILY: the timer helpers are
 * mixin accessors that throw `without inject` when read on a plugin that did
 * not inject `timer`, so the façade reads `ctx[verb]` only at call time — the
 * plugin that never touches a timer never trips that, and one that does gets
 * cordis's own inject error at the call site.
 */
const CTX_VERBS = new Set(['on', 'once', 'provide', 'timeout', 'interval', 'setTimeout', 'setInterval', 'throttle', 'debounce'])

/**
 * The tool-registry façade: `register` (marker-guarded) plus READ-ONLY
 * metadata (`schemas`, and `get` returning a schema view, never the live
 * `ToolDefinition`). Exposing the raw definition would hand mount code the
 * tool's `execute` function, letting it call another tool directly and bypass
 * `ToolRegistry.execute` — identity protection, pre-policy, monotonic guards,
 * around dispatch, post-policy, final observation, and result normalization. So `get` returns the same
 * name/description/parameters view as `schemas()`, and nothing invocable.
 */
function sandboxTools(ctx: Context): Record<string, unknown> {
  // Reads resolve through the MOUNT's own scope (`scopeOf(ctx)`), mirroring
  // where the façade's `register` lands its writes (the calling context's
  // layer): mount code always sees the tools its own world sees — the global
  // view for today's global mounts, its agent's view if a mount ever runs
  // under an agent scope.
  return {
    register: (tool: unknown): (() => void) => sandboxRegisterTool(ctx, tool),
    schemas: () => ctx.tools.schemas(scopeOf(ctx)),
    get: (name: string) => ctx.tools.schemas(scopeOf(ctx)).find(schema => schema.name === name),
  }
}

/**
 * Reject any injected-service return that is a cordis `Context`. Harness
 * services return data, never a context; a value that is one would be a
 * fresh, unguarded handle back into the runtime — the exact escape the façade
 * exists to close — so it fails loud instead of reaching sandbox code.
 */
function denyContext(value: unknown, service: string): unknown {
  if (value instanceof Context) {
    throw new Error(
      `service "${service}" returned a cordis Context, which the sandbox does not expose. `
      + 'Operate through your own plugin ctx (ctx.on / ctx.provide / ctx.tools.register) '
      + 'and the services you inject — never another context.',
    )
  }
  return value
}

/**
 * Wrap an injected service so its methods forward to the real instance but
 * their return values pass through {@link denyContext}. Non-function members
 * (plain data) pass through as-is; a returned Promise is guarded on resolve.
 */
function guardedService(service: object, name: string): unknown {
  return new Proxy(service, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown
      if (typeof value !== 'function') return denyContext(value, name)
      return (...args: unknown[]): unknown => {
        const result = Reflect.apply(value, target, args) as unknown
        if (result instanceof Promise) return result.then(v => denyContext(v, name))
        return denyContext(result, name)
      }
    },
  })
}

/**
 * The service names a plugin declared in `inject`, as a lookup set. Whatever
 * declaration style the plugin used — an `inject: ['bash', 'tools']` array or
 * the `{ required, optional }` object form — cordis resolves it into a single
 * name-keyed map on the fiber before `apply` runs (`{ bash: null, tools: null }`),
 * so the gate just reads that map's keys. A mount may reach only the services
 * it declared — that is what lets cordis park the mount when a declared
 * provider unmounts.
 */
function declaredInjects(ctx: Context): Set<string> {
  return new Set(Object.keys(ctx.fiber.inject))
}

/**
 * The sandbox context façade handed to a mounted plugin's `apply` in place of
 * the real `ctx`. A whitelist (see the module doc): the registration/eventing
 * verbs, the timer helpers, a guarded `tools`, and injected services resolved
 * through a guarded `get` / property access. A service is reachable only if the
 * plugin DECLARED it in `inject` — an undeclared service is denied even when a
 * global provider exists, so cordis's activation/unload semantics (park the
 * mount when a declared provider goes away) actually bind. Every
 * framework-plumbing member is denied with a teaching error; there is no
 * context-valued member to reach.
 */
function sandboxContext(ctx: Context): Context {
  const tools = sandboxTools(ctx)
  const declared = declaredInjects(ctx)
  // A framework member or an undeclared service — distinguish the two so the
  // error teaches the right fix (declare it in inject vs it is withheld).
  const denyRead = (prop: string): never => {
    if (ctx.get(prop) !== undefined) {
      throw new Error(
        `service "${prop}" is not injected. Declare it: inject: ['${prop}', …] on your plugin, `
        + 'so cordis parks this mount if the provider is later unmounted.',
      )
    }
    throw new Error(
      `sandbox ctx does not expose "${prop}". Available: ctx.tools.register / ctx.on / ctx.provide / `
      + 'the timer helpers (ctx.setTimeout, ctx.interval, …) and any service you declared in inject. '
      + 'Framework internals (root, fiber, registry, extend, plugin, …) are withheld by design.',
    )
  }
  // Read a service for either access path (property or `get`). `tools` is the
  // façade's own surface. An UNDECLARED name is denied with the teaching
  // error; a DECLARED one resolves to the guarded service. A declared inject
  // is required in cordis (the fiber only activates once every declared
  // service is live), so at `apply`/`execute` time `ctx.get(name)` is present
  // for a declared name — no undefined case to handle here. `provide()`
  // accepts ANY value though (cross-mount composition advertises
  // `ctx.provide('name', value)`), so a primitive or null value passes
  // through unwrapped: Proxy throws on a non-object target, and only an
  // object can carry a method that hands back a Context.
  const readService = (name: string): unknown => {
    if (name === 'tools') return tools
    if (!declared.has(name)) return denyRead(name)
    const service = denyContext(ctx.get(name), name)
    if (service === null || (typeof service !== 'object' && typeof service !== 'function')) return service
    return guardedService(service, name)
  }
  const get = (name: string): unknown => readService(name)
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === 'tools') return tools
      if (prop === 'get') return get
      if (typeof prop !== 'string') return undefined
      // Lazy verb forwarder — reads `ctx[verb]` only when called, so a plugin
      // that never uses a timer never triggers the timer mixin's inject check
      // (cordis raises its own "without inject" error there for undeclared timer use).
      if (CTX_VERBS.has(prop)) {
        return (...args: unknown[]): unknown => {
          const method = ctx[prop as keyof Context]
          return Reflect.apply(method as (...a: unknown[]) => unknown, ctx, args)
        }
      }
      return readService(prop)
    },
    // A façade is not the real ctx; block writes rather than let mount code
    // stash state on a throwaway object and think it persisted.
    set(_target, prop) {
      throw new Error(`sandbox ctx is read-only; cannot assign "${String(prop)}"`)
    },
    // `in` reflects reachability: the façade surface plus DECLARED services
    // (whether or not currently live). Does not resolve/wrap — no throw.
    has: (_target, prop) => prop === 'tools' || prop === 'get'
      || (typeof prop === 'string' && (CTX_VERBS.has(prop) || declared.has(prop))),
  }) as unknown as Context
}

/**
 * Narrow an arbitrary sandbox return value to a mountable cordis plugin: a
 * function, or an object with an `apply` function. (A bare function passes the
 * first arm, so the object arm never sees `Function.prototype.apply`.)
 * @param value - whatever the mount code returned.
 * @returns whether the value is mountable via `ctx.plugin`.
 */
export function isPlugin(value: unknown): value is Plugin {
  if (typeof value === 'function') return true
  return typeof value === 'object' && value !== null
    && typeof (value as { apply?: unknown }).apply === 'function'
}

/**
 * Wrap a plugin so its `apply` receives the sandbox context façade instead of
 * the real `ctx` (see {@link sandboxContext} and the module doc). Both
 * function-form and object-form plugins go through the same wrap; the plugin's
 * own `inject` declaration is preserved (cordis reads it from the plugin
 * object, and pending/active gating happens on the real fiber before `apply`
 * runs), so cross-mount provide/inject works unmodified.
 *
 * `ctx.effect(customCleanup)` is deliberately absent from the façade for now —
 * `on` / `provide` / `tools.register` cover every mount seen so far, and each
 * is already a fiber effect. FIXME(sandbox-effect): expose a guarded `effect`
 * once a real mount needs a bespoke disposer.
 * @param plugin - the plugin the mount code returned.
 * @returns an equivalent plugin whose `apply` sees the sandbox context façade.
 */
export function guardedPlugin(plugin: Plugin): Plugin {
  if (typeof plugin === 'function') {
    const functionPlugin = plugin as (ctx: Context, config?: unknown) => unknown
    return {
      name: pluginName(plugin),
      apply(ctx: Context, config?: unknown) {
        return functionPlugin(sandboxContext(ctx), config)
      },
    }
  }
  const objectPlugin = plugin as { apply(ctx: Context, config?: unknown): unknown }
  return {
    ...plugin,
    apply(ctx: Context, config?: unknown) {
      return objectPlugin.apply(sandboxContext(ctx), config)
    },
  }
}

/**
 * Display name for a mounted plugin: its `name` property, else anonymous.
 * @param plugin - the plugin the mount code returned.
 * @returns the human-readable name used in mount results and inspect output.
 */
export function pluginName(plugin: Plugin): string {
  const named = (plugin as { name?: unknown }).name
  if (typeof named === 'string' && named.length > 0) return named
  return '<anonymous>'
}
