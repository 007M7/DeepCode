/**
 * The registration boundary between sandboxed mount code and the real runtime:
 * SchemaSpec validation with teaching errors, the marker-guarded
 * `harness.defineTool` / `harness.registerTool` pair, the guarded `ctx` proxy a
 * mounted plugin receives, and the plugin-shape helpers the mount lifecycle
 * narrows sandbox return values with.
 *
 * Two realm facts drive the design. Objects built inside the vm carry the vm
 * realm's `Object.prototype`, and the session log's append-time plainness check
 * (`dsh-session`'s `isJsonValue`, a prototype-identity comparison) rejects
 * foreign-realm data — so every dynamic tool's `execute` return is JSON
 * round-tripped into the host realm before it reaches the registry. And a
 * malformed tool schema must fail at REGISTRATION, not when a later request
 * assembles it — so dynamic `ctx.tools.register` calls accept only definitions
 * produced by the sandbox's `harness.defineTool`, which asserts the SchemaSpec
 * DSL up front.
 *
 * @module @deepseek-ai/dsh-tool-cordis/guard
 */

import type { Context, Plugin } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecuteReturn } from '@deepseek-ai/dsh-tools'

const DYNAMIC_TOOL = Symbol('tool-cordis.dynamic-tool')
const SCHEMA_TYPES = new Set<unknown>(['string', 'number', 'boolean', 'object', 'array'])

type DynamicToolDefinition = ToolDefinition & { [DYNAMIC_TOOL]: true }
type DynamicToolMarker = { [DYNAMIC_TOOL]?: unknown }

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]'
}

/** Assert a sandbox-provided `parameters` value is a SchemaSpec object, with a teaching error for the common JSON-Schema mistake. */
function assertSchemaSpec(value: unknown): void {
  if (!isPlainRecord(value)) {
    throw new Error('harness.defineTool parameters must be a SchemaSpec object')
  }
  if (value.type === 'object' && isPlainRecord(value.properties)) {
    throw new Error(
      'harness.defineTool parameters use the SchemaSpec DSL (NOT JSON Schema).\n'
      + '  ✗ { type: \'object\', properties: { name: { type: \'string\' } }, required: [\'name\'] }\n'
      + '  ✓ { name: { type: \'string\', required: true } }\n'
      + 'Remove the outer { type: \'object\', properties, required } wrapper; '
      + 'each key IS a property directly on the parameters object.',
    )
  }
  for (const [key, prop] of Object.entries(value)) {
    assertSchemaProp(prop, `parameters.${key}`)
  }
}

function assertSchemaProp(value: unknown, path: string): void {
  if (!isPlainRecord(value)) {
    throw new Error(`harness.defineTool ${path} must be a SchemaSpec property object`)
  }
  if (!SCHEMA_TYPES.has(value.type)) {
    throw new Error(`harness.defineTool ${path} must declare a valid type`)
  }
  if (value.required !== undefined && value.required !== true) {
    throw new Error(`harness.defineTool ${path}.required must be true when present`)
  }
  if (value.properties !== undefined) {
    if (value.type !== 'object') {
      throw new Error(`harness.defineTool ${path}.properties is only valid for type "object"`)
    }
    assertSchemaSpec(value.properties)
  }
  if (value.items !== undefined) {
    if (value.type !== 'array') {
      throw new Error(`harness.defineTool ${path}.items is only valid for type "array"`)
    }
    assertSchemaProp(value.items, `${path}.items`)
  }
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
 * The `harness.defineTool` handed into the sandbox: the real DSL, with the
 * tool's `execute` return normalized into the host realm via a JSON round-trip
 * (see the module doc). The round-trip also projects the return onto exactly
 * what the log would durably store, so a non-JSON-serializable return surfaces
 * as that one call's error instead of poisoning the turn.
 * @param options - the standard `defineTool` options, with `parameters` asserted against the SchemaSpec DSL before the DSL sees them.
 * @returns the marker-tagged definition `harness.registerTool` (and the guarded `ctx.tools.register`) accepts.
 */
export function sandboxDefineTool(options: Parameters<typeof defineTool>[0]): ToolDefinition {
  assertSchemaSpec((options as { parameters?: unknown }).parameters)
  const tool = defineTool(options)
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
