/**
 * Read-only renderers over the live runtime for `cordis_inspect`: the service
 * list, the flat plugin list, the registered tools, the dynamic-mount
 * table (with per-mount provides/waits), and the catalog-backed `api` /
 * `events` sections. Every renderer is a pure function of the runtime handles
 * it receives — no session state, no clock — so inspect output is exactly the
 * runtime it describes.
 *
 * @module @deepseek-ai/dsh-tool-cordis/inspect
 */

import type { Context, Fiber } from 'cordis'
import { EVENT_API, INHERITED_CTX_API, SERVICE_API, TYPE_API } from './api-catalog.ts'
import type { EventApiEntry, InheritedApiEntry, ServiceApiEntry, TypeApiEntry } from './api-catalog.ts'
import { FiberState, STATE_LABELS } from './fiber-state.ts'
import { missingServices } from './mount.ts'
import type { DynamicMount } from './mount.ts'

/** The live service registrations from `ctx.reflect.store` (map + filter keeps the possibly-undefined index read branch-free). */
function liveImpls(ctx: Context): { name: string; fiber: Fiber }[] {
  const store = ctx.reflect.store
  return Object.getOwnPropertySymbols(store)
    .map(key => store[key])
    .filter((impl): impl is NonNullable<typeof impl> => impl !== undefined)
}

/** Whether `fiber` is `root` itself or mounted anywhere inside `root`'s subtree. */
function withinFiber(fiber: Fiber, root: Fiber): boolean {
  let current = fiber
  while (true) {
    if (current === root) return true
    const parent = current.parent.fiber
    if (parent === current) return false
    current = parent
  }
}

/** The service names provided by a mount's fiber subtree, sorted. */
function providedBy(ctx: Context, fiber: Fiber): string[] {
  return liveImpls(ctx)
    .filter(impl => withinFiber(impl.fiber, fiber))
    .map(impl => impl.name)
    .sort()
}

/**
 * The `services` section: every provided ctx service with its owning fiber,
 * annotating non-active owners with their lifecycle state.
 * @param ctx - the runtime to enumerate.
 * @returns one line per service, or a single placeholder line when none are provided.
 */
export function describeServices(ctx: Context): string[] {
  const lines = liveImpls(ctx).map((impl) => {
    const active = impl.fiber.state === FiberState.ACTIVE
    return `- ${impl.name} (provided by ${impl.fiber.name}${active ? '' : `, ${STATE_LABELS[impl.fiber.state]}`})`
  })
  return lines.length > 0 ? lines : ['(no services provided)']
}

/**
 * The `plugins` section: a flat list of every fiber the registry knows, one
 * line per fiber with its lifecycle state, sorted by plugin name (a plugin
 * mounted more than once repeats — one line per instance). Dynamic mounts are
 * listed like any other plugin; their ids live in the `dynamic` section.
 * @param ctx - the runtime whose registry is enumerated.
 * @returns one line per loaded plugin fiber.
 */
export function describePlugins(ctx: Context): string[] {
  const fibers: Fiber[] = []
  for (const runtime of ctx.registry.values()) {
    for (const fiber of runtime.fibers) fibers.push(fiber)
  }
  return fibers
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(fiber => `- ${fiber.name} [${STATE_LABELS[fiber.state]}]`)
}

/**
 * The `tools` section: the model-facing tool names currently registered.
 * @param ctx - the runtime whose tool registry is read.
 * @returns one line per registered tool.
 */
export function describeTools(ctx: Context): string[] {
  return ctx.tools.schemas().map(schema => `- ${schema.name}`)
}

/**
 * The `dynamic` section: one line per mount with id, plugin name, lifecycle
 * state, the services its subtree provides, and — for a pending mount — the
 * services it waits for.
 * @param ctx - the runtime the mounts live in.
 * @param mounts - the tracked mounts, in mount order.
 * @returns one line per mount, or a single placeholder line when none exist.
 */
export function describeDynamic(ctx: Context, mounts: ReadonlyMap<string, DynamicMount>): string[] {
  if (mounts.size === 0) return ['(no dynamic plugins mounted)']
  return [...mounts].map(([id, mount]) => {
    const provides = providedBy(ctx, mount.fiber)
    const waiting = missingServices(ctx, mount.fiber)
    const providesNote = provides.length > 0 ? ` — provides: ${provides.join(', ')}` : ''
    const waitingNote = waiting.length > 0 ? ` — waiting for: ${waiting.join(', ')}` : ''
    return `- ${id}: ${mount.pluginName} [${STATE_LABELS[mount.fiber.state]}]${providesNote}${waitingNote}`
  })
}

/**
 * The transitive closure of catalogued type shapes referenced (word-bounded)
 * by the seed texts — the runtime scoping that keeps the `api` section to the
 * shapes the LIVE signatures actually mention.
 */
function typeClosure(seeds: string[], types: readonly TypeApiEntry[]): TypeApiEntry[] {
  const included = new Map<string, TypeApiEntry>()
  let frontier = seeds
  while (frontier.length > 0) {
    const next: string[] = []
    for (const entry of types) {
      if (included.has(entry.name)) continue
      const pattern = new RegExp(`\\b${entry.name}\\b`)
      if (frontier.some(text => pattern.test(text))) {
        included.set(entry.name, entry)
        next.push(entry.declaration)
      }
    }
    frontier = next
  }
  return [...included.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The `api` section: the generated service catalog intersected with the LIVE
 * runtime — catalogued live services render summary + method signatures, live
 * services without a catalog entry (e.g. ones another mount provides) render
 * name + owning fiber, catalog services that are not running are listed
 * tersely, the type shapes the live signatures reference follow, and the
 * inherited `ctx` surface closes the section.
 * @param ctx - the runtime to intersect the catalog with.
 * @param api - the service catalog (the generated one by default; injectable for tests).
 * @param inherited - the inherited `ctx` surface lines (generated by default; injectable for tests).
 * @param types - the type-shape catalog (generated by default; injectable for tests).
 * @returns the section lines.
 */
export function describeApi(
  ctx: Context,
  api: readonly ServiceApiEntry[] = SERVICE_API,
  inherited: readonly InheritedApiEntry[] = INHERITED_CTX_API,
  types: readonly TypeApiEntry[] = TYPE_API,
): string[] {
  const live = new Map<string, string>()
  for (const impl of liveImpls(ctx)) live.set(impl.name, impl.fiber.name)
  const lines: string[] = []
  const liveMethodTexts: string[] = []
  for (const entry of api) {
    if (!live.has(entry.key)) continue
    lines.push(`- ${entry.key} — ${entry.summary}`)
    for (const method of entry.methods) {
      lines.push(`    ${method}`)
      liveMethodTexts.push(method)
    }
  }
  const catalogued = new Set(api.map(entry => entry.key))
  for (const [name, fiber] of [...live].sort(([a], [b]) => a.localeCompare(b))) {
    if (!catalogued.has(name)) lines.push(`- ${name} (provided by ${fiber}, no catalog entry)`)
  }
  const notRunning = api.filter(entry => !live.has(entry.key)).map(entry => entry.key)
  if (notRunning.length > 0) lines.push(`not running (loadable services with no live provider): ${notRunning.join(', ')}`)
  const shapes = typeClosure(liveMethodTexts, types)
  if (shapes.length > 0) {
    lines.push('type shapes (referenced by the signatures above — read these before assuming a field is a string):')
    for (const shape of shapes) {
      for (const declLine of shape.declaration.split('\n')) lines.push(`    ${declLine}`)
    }
  }
  lines.push('inherited ctx API:')
  for (const entry of inherited) lines.push(`- ${entry.name} — ${entry.summary}`)
  return lines
}

/**
 * The `events` section: every harness event with its dispatch mode, one-line
 * summary, and exact signature, closed by the waterfall caution.
 * @param events - the event catalog (the generated one by default; injectable for tests).
 * @returns the section lines.
 */
export function describeEvents(events: readonly EventApiEntry[] = EVENT_API): string[] {
  const lines = events.flatMap(event => [
    `- ${event.name} [${event.mode}] — ${event.summary}`,
    `    ${event.signature}`,
  ])
  lines.push('waterfall listeners receive a trailing next() and MUST call it to delegate — returning without next() vetoes the chain.')
  return lines
}
