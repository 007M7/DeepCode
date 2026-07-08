/**
 * The registration boundary between sandboxed mount code and the real runtime:
 * SchemaSpec normalization + validation with teaching errors, the
 * marker-guarded `harness.defineTool` / `harness.registerTool` pair, the
 * guarded `ctx` proxy a mounted plugin receives, and the plugin-shape helpers
 * the mount lifecycle narrows sandbox return values with.
 *
 * Two realm facts drive the design. Objects built inside the vm carry the vm
 * realm's `Object.prototype`, and the session log's append-time plainness check
 * (`dsh-session`'s `isJsonValue`, a prototype-identity comparison) rejects
 * foreign-realm data — so every dynamic tool's `execute` return is JSON
 * round-tripped into the host realm before it reaches the registry, and the
 * schema itself is rebuilt as fresh host-realm objects. And a malformed tool
 * schema must fail at REGISTRATION, not when a later request assembles it — so
 * dynamic `ctx.tools.register` calls accept only definitions produced by the
 * sandbox's `harness.defineTool`, which normalizes `parameters` up front.
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

import type { Context, Plugin } from 'cordis'
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
 * The `harness.defineTool` handed into the sandbox: the real DSL, with
 * `parameters` normalized into a fresh host-realm SchemaSpec (JSON-Schema
 * wrapper unwrapped, `integer` mapped, `required: false` dropped) and the
 * tool's `execute` return normalized into the host realm via a JSON round-trip
 * (see the module doc). The round-trip also projects the return onto exactly
 * what the log would durably store, so a non-JSON-serializable return surfaces
 * as that one call's error instead of poisoning the turn.
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
      return JSON.parse(JSON.stringify(await execute(args, exec))) as ToolExecuteReturn
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

function bindMethod(value: unknown, target: object): unknown {
  if (typeof value !== 'function') return value
  return (...args: unknown[]): unknown => Reflect.apply(value, target, args) as unknown
}

function guardedContext(ctx: Context): Context {
  const tools = new Proxy(ctx.tools, {
    get(target, prop) {
      if (prop === 'register') {
        return (tool: unknown): () => void => sandboxRegisterTool(ctx, tool)
      }
      const value = Reflect.get(target, prop, target) as unknown
      return bindMethod(value, target)
    },
  })
  return new Proxy(ctx, {
    get(target, prop) {
      if (prop === 'tools') return tools
      if (prop === 'get') {
        return (service: string): unknown => service === 'tools' ? tools : target.get(service)
      }
      const value = Reflect.get(target, prop, target) as unknown
      return bindMethod(value, target)
    },
  })
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
 * Wrap a plugin so its `apply` receives a guarded context (`tools.register`
 * only accepts tools from `harness.defineTool`). Both function-form and
 * object-form plugins go through the same guard; everything else on the
 * context — `on`, `provide`, `inject` resolution — passes through with correct
 * `this` binding, so cross-mount provide/inject works unmodified.
 * @param plugin - the plugin the mount code returned.
 * @returns an equivalent plugin whose `apply` sees the guarded context.
 */
export function guardedPlugin(plugin: Plugin): Plugin {
  if (typeof plugin === 'function') {
    const functionPlugin = plugin as (ctx: Context, config?: unknown) => unknown
    return {
      name: pluginName(plugin),
      apply(ctx: Context, config?: unknown) {
        return functionPlugin(guardedContext(ctx), config)
      },
    }
  }
  const objectPlugin = plugin as { apply(ctx: Context, config?: unknown): unknown }
  return {
    ...plugin,
    apply(ctx: Context, config?: unknown) {
      return objectPlugin.apply(guardedContext(ctx), config)
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
