/**
 * The self-referential cordis toolset: three model-facing tools that let the
 * agent inspect and MODIFY the live cordis runtime it is running inside.
 *
 * - `cordis_inspect` — read-only: provided services, the flat plugin list
 *   with lifecycle states, registered tools, the dynamic mounts, and the
 *   catalog-backed `api` / `events` references.
 * - `cordis_mount` — evaluate model-written code in a `node:vm` sandbox; the
 *   code returns a cordis plugin, which is mounted as a child of a dedicated
 *   `cordis-dynamic` group fiber and tracked under an id (`dyn-1`, `dyn-2`, …).
 * - `cordis_unmount` — dispose one dynamic mount by id, awaiting quiescence.
 *
 * Everything the model's plugin registers (listeners via `ctx.on`, tools via
 * `harness.registerTool`, services via `ctx.provide`) is an effect on the
 * dynamic fiber, so unmounting — or disposing this plugin itself (HMR) — cleans
 * it all up through the ordinary cordis lifecycle. The group fiber exists
 * exactly so the dynamic mounts form ONE subtree, disposed as a unit with
 * this plugin. Design home:
 * docs/rfc/implemented/feature/2026-07-08-self-referential-cordis-toolset.md.
 *
 * The vm sandbox guards against ACCIDENTAL global pollution only, and the `ctx`
 * a mounted plugin's `apply` receives is a WHITELIST façade (register a tool,
 * observe events, provide/consume services, use timers — framework internals
 * withheld; see the guard module). Neither is a security boundary: the verbs
 * the façade DOES expose reach the real runtime unsandboxed (a mounted tool can
 * shell out through `ctx.bash`), so a deployment loads this plugin as
 * deliberately as it grants a bash tool. Design home:
 * docs/rfc/implemented/feature/2026-07-08-self-referential-cordis-toolset.md.
 *
 * Plugin export shape: named exports, NO default. The cordis Loader's
 * `unwrapExports` does `exports.default ?? exports`, so a stray default would
 * collapse the module to the bare `apply` and drop `inject`, crashing at load
 * (see docs/postmortem/0001).
 *
 * @module @deepseek-ai/dsh-tool-cordis
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { STATE_LABELS } from './fiber-state.ts'
import { isPlugin, pluginName } from './guard.ts'
import { describeApi, describeDynamic, describeEvents, describePlugins, describeServices, describeTools } from './inspect.ts'
import { missingServices, mountDynamic } from './mount.ts'
import type { DynamicMount } from './mount.ts'
import { presentInspectCall, presentMountCall, presentUnmountCall } from './present.ts'
import { createSandbox, evaluateMountCode } from './sandbox.ts'

export const name = 'tool-cordis'
export const inject = ['tools']

/** Config for the tool-cordis plugin: the sandbox evaluation bound. */
export interface Config {
  /**
   * Milliseconds the SYNCHRONOUS portion of mount code may run in the vm
   * before evaluation is aborted (default 5000). An async body escapes this
   * bound — see docs/rfc/implemented/feature/2026-07-08-self-referential-cordis-toolset.md for the trust stance.
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
  // The one group fiber every dynamic mount hangs under. Mounted here (a child
  // of this plugin's fiber) so disposing tool-cordis cascades over the whole
  // dynamic subtree — the ordinary parent→child fiber lifecycle, nothing extra.
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
      + 'Omit `what` to get all six sections.',
    parameters: {
      what: {
        type: 'string',
        enum: ['services', 'plugins', 'tools', 'dynamic', 'api', 'events'],
        description: 'Limit the report to one section. Omit for all sections.',
      },
    },
    execute(args): Promise<{ type: 'text'; text: string }[]> {
      const sections: [heading: string, body: () => string[]][] = [
        ['services', () => describeServices(ctx)],
        ['plugins', () => describePlugins(ctx)],
        ['tools', () => describeTools(ctx)],
        ['dynamic', () => describeDynamic(ctx, mounts)],
        ['api', () => describeApi(ctx)],
        ['events', () => describeEvents()],
      ]
      const selected = sections.filter(([heading]) => args.what === undefined || args.what === heading)
      const text = selected
        .map(([heading, body]) => `## ${heading}\n${body().join('\n')}`)
        .join('\n\n')
      return Promise.resolve([{ type: 'text', text }])
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
      + '{ text: { type: \'string\', required: true } }, async execute(args) { … } }))` '
      + 'to give yourself a new tool — it becomes callable on your NEXT step. '
      + 'Tool parameters: each key IS a property — { type: \'string\'|\'number\'|\'boolean\'|\'object\'|\'array\', '
      + 'required?: true, description?, enum?, items?, properties? }; a JSON-Schema-style '
      + '{ type: \'object\', properties, required: […] } wrapper and type \'integer\' are also accepted and normalized. A '
      + 'tool\'s `execute` MUST return an ARRAY of content blocks, e.g. `return '
      + '[{ type: \'text\', text: someString }]` — never a bare string. '
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
      const note = missing.length > 0
        ? ` — waiting for service(s): ${missing.join(', ')} (activates when provided)`
        : ''
      return [{ type: 'text', text: `mounted ${id} (plugin "${pluginName(evaluated)}", state: ${state}${note})` }]
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
    async execute(args) {
      const mount = mounts.get(args.id)
      if (!mount) {
        throw new Error(`no dynamic plugin with id "${args.id}" (list mounts with cordis_inspect what:"dynamic")`)
      }
      await mount.fiber.dispose()
      mounts.delete(args.id)
      return [{ type: 'text', text: `unmounted ${args.id} (plugin "${mount.pluginName}")` }]
    },
    presentCall: presentUnmountCall,
  }))
}
