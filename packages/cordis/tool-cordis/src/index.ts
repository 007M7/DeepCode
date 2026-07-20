/**
 * Self-referential runtime tools: inspect live services/plugins/tools, mount a returned plugin
 * under an owned dynamic fiber, and unmount it to quiescence. Registrations are fiber effects,
 * so plugin disposal removes the entire dynamic subtree. The VM and context façade prevent
 * accidental misuse, not hostile code: an allowed service such as `ctx.bash` reaches the real
 * runtime. Named exports preserve loader injection metadata.
 * @module @deepseek-ai/dsh-tool-cordis
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { STATE_LABELS } from './fiber-state.ts'
import { isPlugin, pluginName } from './guard.ts'
import { EVENT_API, INHERITED_CTX_API, SERVICE_API, TYPE_API } from './api-catalog.ts'
import { describeApi, describeDynamic, describeEvents, describePlugins, describeServices, describeTools, providedServices } from './inspect.ts'
import { missingServices, mountDynamic, type DynamicMount } from './mount.ts'
import { presentInspectCall, presentMountCall, presentUnmountCall } from './present.ts'
import { createSandbox, evaluateMountCode } from './sandbox.ts'

export const name = 'tool-cordis'
export const inject = ['tools']

/** Config for the tool-cordis plugin: the sandbox evaluation bound. */
export interface Config {
  /**
   * Milliseconds the SYNCHRONOUS portion of mount code may run in the vm
   * before evaluation is aborted (default 5000). An async body escapes this
   * bound — see .agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md for the trust stance.
   */
  vmTimeoutMs?: number
}

/** Schemastery validator for {@link Config}: `vmTimeoutMs` must be at least 1 (defaults to 5000). */
export const Config: z<Config> = z.object({
  vmTimeoutMs: z.number().min(1).default(5000),
})

/** {@link Config} with every defaulted field present, as schemastery resolves it at load. */
type ResolvedConfig = Required<Config>

/**
 * Mount the three cordis tools on `ctx.tools` and create the `cordis-dynamic`
 * group fiber every dynamic mount hangs under.
 * @param ctx - the plugin context (`tools` injected).
 * @param config - the schemastery-resolved {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const { vmTimeoutMs } = config as ResolvedConfig
  // The one group fiber every dynamic mount hangs under.
  const group = ctx.plugin({ name: 'cordis-dynamic', apply: () => {} })

  const mounts = new Map<string, DynamicMount>()
  let nextId = 1

  ctx.tools.register(defineTool({
    name: 'cordis_inspect',
    description:
      'Inspect the live cordis runtime that is running THIS agent. Read-only. '
      + 'Sections: `services` (every provided ctx service and the plugin fiber that owns it), '
      + '`plugins` (a flat list of the loaded plugins with their lifecycle states), '
      + '`tools` (the model-facing tools currently registered, i.e. what you can call), '
      + '`dynamic` (plugins you mounted via cordis_mount: id, name, state, provided services, awaited services), '
      + '`api` (method signatures AND argument/return type shapes for every LIVE service — read this before writing plugin code that calls a service), '
      + '`events` (every harness event with its dispatch mode and exact signature — pick listener targets here). '
      + 'Omit `what` to get all six sections. With `what:"api"` or `what:"events"`, pass an exact `name` '
      + 'to narrow to one service/event and include its original source JSDoc.',
    parameters: {
      what: {
        type: 'string',
        enum: ['services', 'plugins', 'tools', 'dynamic', 'api', 'events'],
        description: 'Limit the report to one section. Omit for all sections.',
      },
      name: {
        type: 'string',
        description: 'Exact service key or event name whose original JSDoc to include; valid only with what:"api" or what:"events".',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute(args, exec): Promise<string> {
      if (args.name !== undefined && args.what !== 'api' && args.what !== 'events') {
        throw new Error('name is valid only with what:"api" or what:"events"')
      }
      const sections: [heading: string, body: () => string[]][] = [
        ['services', () => describeServices(ctx)],
        ['plugins', () => describePlugins(ctx)],
        // The calling agent's view: scoped/shadowed tools included, restricted
        // globals absent — "what you can call", not the global registry.
        ['tools', () => describeTools(ctx, exec.agent)],
        ['dynamic', () => describeDynamic(ctx, mounts)],
        ['api', () => describeApi(ctx, SERVICE_API, INHERITED_CTX_API, TYPE_API, args.name)],
        ['events', () => describeEvents(EVENT_API, args.name)],
      ]
      const selected = sections.filter(([heading]) => args.what === undefined || args.what === heading)
      const text = selected
        .map(([heading, body]) => `## ${heading}\n${body().join('\n')}`)
        .join('\n\n')
      return Promise.resolve(text)
    },
    presentCall: presentInspectCall,
  }))

  ctx.tools.register(defineTool({
    name: 'cordis_mount',
    description:
      'Mount a NEW cordis plugin into the live runtime that is running THIS agent '
      + '(self-modification). `code` runs as the body of an async JavaScript function '
      + 'in an isolated sandbox and MUST `return` a plugin. Two forms: '
      + 'FUNCTION form `return (ctx) => { … }` — declares no inject, so it can register '
      + 'tools, listen to events, and provide services, but reaching ANY service (e.g. '
      + 'ctx.bash) throws; use it only when you need no services. '
      + 'OBJECT form `return { name?, inject: [\'bash\', \'llm\', …], apply(ctx) { … } }` '
      + '— declares dependencies, and cordis activates the plugin only after the '
      + 'services exist; PREFER this form. You may reach ONLY the services you list in '
      + 'inject: an undeclared service throws even if it exists, because an undeclared '
      + 'dependency would not be cleaned up if its provider is unmounted. '
      + 'BEFORE calling a service from your code, read cordis_inspect what:"api" — it lists '
      + 'method signatures AND the type shapes of their arguments/returns (do not guess a '
      + 'field\'s type; e.g. a bash run\'s stdout is an object, not a string). '
      + 'Inside `apply`, use the standard cordis API: `ctx.on(event, listener)` to observe '
      + 'events (see cordis_inspect what:"events"), or call '
      + '`harness.registerTool(ctx, harness.defineTool({ name, description, parameters: '
      + '{ text: { type: \'string\', required: true } }, output: { schema: { type: \'string\' }, '
      + 'render(_args, value) { return [{ type: \'text\', text: value }] } }, async execute(args) { return args.text } }))` '
      + 'to give yourself a new tool — it becomes callable on your NEXT step. '
      + 'Tool parameters: each key IS a property — { type: \'string\'|\'number\'|\'integer\'|\'boolean\'|\'null\'|\'object\'|\'array\'|\'json\', '
      + 'required?: true, description?, enum?, const?, items?, properties? }; every direct DSL object declares additionalProperties: true|false, and '
      + 'oneOf: [schema, schema, ...] replaces type for an exact-one union. A raw JSON-Schema { type: \'object\', properties, required?: […] } wrapper is also accepted with open-by-default objects. A '
      + 'tool\'s `execute` MUST return the lossless JSON value declared by `output.schema`; '
      + '`output.render(args, value)` separately returns Native/model content blocks. '
      + 'Mounts can COMPOSE: one plugin may `ctx.provide(\'name\', value)` a service and '
      + 'another may declare `inject: [\'name\']` to consume it — the consumer stays pending '
      + 'until the provider exists and returns to pending when the provider is unmounted. '
      + 'Everything registered inside `apply` is cleaned up automatically on unmount. '
      + 'Sandbox globals: `console` (tagged `[cordis:<id>]`, writes through to the harness '
      + 'terminal), `harness.defineTool`, `harness.registerTool`, '
      + '`btoa`, `atob`, `TextEncoder`, `TextDecoder`. '
      + 'Node APIs are DISABLED — do filesystem/network/timer work through the cordis services, '
      + 'never Node built-ins: `require`, `setTimeout`/`setInterval`, and `fetch` throw redirect '
      + 'errors; `process` and `Buffer` are undefined. Instead use inject: [\'fs\'] + ctx.fs for '
      + 'files, inject: [\'web\'] + ctx.web for HTTP, inject: [\'bash\'] + ctx.bash for processes, '
      + 'and inject: [\'timer\'] + ctx.setTimeout/ctx.setInterval for timing (fiber effects, '
      + 'auto-cleaned on unmount) — cordis_inspect what:"api" shows what THIS runtime provides. '
      + 'Write PLAIN JavaScript, not TypeScript (no `as`, no type annotations). '
      + 'Cautions: (1) waterfall events (e.g. tools/pre-execute) hand the listener a '
      + 'trailing `next` callback which MUST be called — returning without `next()` '
      + 'VETOES the call; prefer plain notification events unless you intend to '
      + 'intercept. (2) Never await something that only resolves after the current '
      + 'turn (your code runs INSIDE a tool call of that turn — it would deadlock). '
      + '(3) Your `ctx` is a restricted façade: you can register tools, observe '
      + 'events, provide/consume services, and use timers, but framework internals '
      + '(ctx.root, ctx.fiber, ctx.extend, ctx.plugin, …) are withheld. It is not a '
      + 'security boundary though — the services you inject (e.g. ctx.bash) reach the '
      + 'real runtime.',
    parameters: {
      code: {
        type: 'string',
        required: true,
        description: 'Body of an async JS function; must `return` the plugin to mount.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          pluginName: { type: 'string', required: true },
          state: {
            type: 'string',
            required: true,
            enum: ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading'],
          },
          provides: { type: 'array', required: true, items: { type: 'string' } },
          waitingFor: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const note = value.waitingFor.length > 0
          ? ` — waiting for service(s): ${value.waitingFor.join(', ')} (activates when provided)`
          : ''
        return [{
          type: 'text',
          text: `mounted ${value.id} (plugin "${value.pluginName}", state: ${value.state}${note})`,
        }]
      },
    },
    async execute(args) {
      const id = `dyn-${nextId++}`
      const sandbox = createSandbox(id)
      const evaluated = await evaluateMountCode(sandbox, args.code, id, vmTimeoutMs)
      if (!isPlugin(evaluated)) {
        if (evaluated === undefined) {
          throw new Error(
            'mount code returned `undefined` — did you forget `return`?\n'
            + '  ✓ return (ctx) => { … }\n'
            + '  ✓ return { name: \'…\', inject: […], apply(ctx) { … } }',
          )
        }
        throw new Error(
          'mount code must `return` a plugin: a function, or an object with an `apply(ctx)` method',
        )
      }
      const fiber = await mountDynamic(group, evaluated)
      mounts.set(id, { fiber, pluginName: pluginName(evaluated) })
      // A settled fiber that is not ACTIVE is waiting on unsatisfied inject —
      // legal cordis semantics (it activates when the service appears), so keep
      // it mounted but tell the model what it is waiting for.
      const missing = missingServices(ctx, fiber)
      const state = STATE_LABELS[fiber.state]
      return {
        id,
        pluginName: pluginName(evaluated),
        state,
        provides: providedServices(ctx, fiber),
        waitingFor: missing,
      }
    },
    presentCall: presentMountCall,
  }))

  ctx.tools.register(defineTool({
    name: 'cordis_unmount',
    description:
      'Dispose a plugin previously mounted with cordis_mount, by id. All its '
      + 'registrations (event listeners, tools, services) are cleaned up through '
      + 'the cordis effect lifecycle. Returns only after disposal has fully '
      + 'completed (quiescence, not just a request to stop).',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'The dynamic mount id returned by cordis_mount (e.g. "dyn-1").',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          pluginName: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `unmounted ${value.id} (plugin "${value.pluginName}")` }],
    },
    async execute(args) {
      const mount = mounts.get(args.id)
      if (!mount) {
        throw new Error(`no dynamic plugin with id "${args.id}" (list mounts with cordis_inspect what:"dynamic")`)
      }
      await mount.fiber.dispose()
      mounts.delete(args.id)
      return { id: args.id, pluginName: mount.pluginName }
    },
    presentCall: presentUnmountCall,
  }))
}
