/**
 * HostWebPluginRegistry: discovers web-client plugins among the host Loader's
 * loaded entries by their package.json `dshClient` declaration and resolves
 * each one's client bundle path from `exports["./client"]`. The webserver
 * consumes the table to emit `window.__DSH_BOOT__` and to serve
 * `GET /plugins/<id>/client.js`. Discovery is declaration-only: plugin authors
 * write package.json; no serve() call surface exists.
 *
 * The vendored loader emits no "entry loaded" event (only `loader/entry-init`,
 * which fires at Entry construction before import/apply), so the registry
 * scans `loader.entries()` and rescans on cordis `internal/plugin` (fiber
 * create/dispose), microtask-debounced. Plugin-set changes take effect on
 * restart per the config-source ruling; the subscription only keeps the table
 * fresh within a process lifetime.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from 'cordis'

/** One `window.__DSH_BOOT__.plugins` row (wire shape of api-contracts v3 §9.2). */
export interface WebPluginBootEntry {
  /** Plugin id = package name (may contain a scope slash). */
  id: string
  /** Bundle URL served by this webserver (`/plugins/<id>/client.js`). */
  url: string
  /** Client-half load dependencies (plugin ids), topologically ordered by the client loader. */
  inject: string[]
  /** Marks the early-load group: fetched in parallel and applied before all other plugins. */
  immediately?: boolean
}

/** The web plugin table consumed by the boot injection and the bundle endpoint. */
export interface HostWebPluginRegistry {
  /** Current manifest rows (stable order: loader entry order). */
  snapshot(): WebPluginBootEntry[]
  /**
   * Absolute path of a plugin's client bundle.
   * @param id - plugin id (package name).
   * @returns the path, or undefined for an unknown id.
   */
  clientPath(id: string): string | undefined
  /** Remove the loader subscription. */
  dispose(): void
}

/** Structural view of a loader entry (webserver keeps zero workspace dependencies; cordis stays a type-only peer). */
export interface LoaderEntryView {
  options: { name: string }
  /** Present once the entry's plugin fiber exists (import succeeded and apply ran/started). */
  fiber?: unknown
  /** True when the entry or an owning group is disabled. */
  disabled: boolean
}

/** Structural view of the host Loader (entry enumeration is all the registry needs). */
export interface LoaderView {
  entries(): Iterable<LoaderEntryView>
}

/** Dependencies injected by the assembly layer. */
export interface WebPluginRegistryDeps {
  /** Host root context; used only to subscribe `internal/plugin` for rescans. */
  ctx: Context
  /** The host Loader owning the plugin entries. */
  loader: LoaderView
  /**
   * Resolve a package specifier to its package.json absolute path (assembly
   * passes `createRequire(...).resolve(`${name}/package.json`)`); injected so
   * the registry makes no module-resolution assumptions of its own.
   */
  resolvePkgJson: (name: string) => string
  /** Sink for rescan failures (the initial scan throws instead — misconfiguration fails loud at load). */
  onError: (err: Error) => void
}

/** package.json `dshClient` declaration shape (file boundary — validated field by field). */
interface DshClientDeclaration {
  inject?: string[]
  platform: string
  immediately?: boolean
}

interface WebPluginRecord {
  entry: WebPluginBootEntry
  clientPath: string
}

/** Narrow an unknown parsed JSON value to the dshClient declaration, throwing on malformed fields. */
function parseDshClient(name: string, value: unknown): DshClientDeclaration | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) {
    throw new Error(`web-plugins: ${name} has a non-object dshClient declaration`)
  }
  const decl = value as Record<string, unknown>
  if (typeof decl.platform !== 'string') {
    throw new Error(`web-plugins: ${name} dshClient.platform must be a string`)
  }
  if (decl.inject !== undefined && (!Array.isArray(decl.inject) || decl.inject.some(i => typeof i !== 'string'))) {
    throw new Error(`web-plugins: ${name} dshClient.inject must be a string array`)
  }
  if (decl.immediately !== undefined && typeof decl.immediately !== 'boolean') {
    throw new Error(`web-plugins: ${name} dshClient.immediately must be a boolean`)
  }
  return {
    platform: decl.platform,
    ...(decl.inject !== undefined ? { inject: decl.inject as string[] } : {}),
    ...(decl.immediately !== undefined ? { immediately: decl.immediately } : {}),
  }
}

/** Resolve `exports["./client"]` to a relative path, accepting the string and one-level conditional forms. */
function clientExportOf(name: string, exportsField: unknown): string | undefined {
  if (typeof exportsField !== 'object' || exportsField === null) return undefined
  const client = (exportsField as Record<string, unknown>)['./client']
  if (client === undefined) return undefined
  if (typeof client === 'string') return client
  if (typeof client === 'object' && client !== null) {
    const fallback = (client as Record<string, unknown>).default
    if (typeof fallback === 'string') return fallback
  }
  throw new Error(`web-plugins: ${name} exports["./client"] has an unsupported shape`)
}

/**
 * Build the web plugin registry: scan once synchronously (a malformed
 * declaration throws here — load-time fail loud), then rescan on
 * `internal/plugin`, microtask-debounced (failures go to `deps.onError`).
 * @param deps - loader view, resolution hook, and error sink (see {@link WebPluginRegistryDeps}).
 * @returns the registry handle.
 */
export function createHostWebPluginRegistry(deps: WebPluginRegistryDeps): HostWebPluginRegistry {
  let table = scan(deps)

  let pending = false
  const unsubscribe = deps.ctx.on('internal/plugin', () => {
    if (pending) return
    pending = true
    queueMicrotask(() => {
      pending = false
      try {
        table = scan(deps)
      } catch (error) {
        // Keep serving the previous table: a mid-flight rescan failure must not
        // take down the boot manifest for plugins that were fine.
        deps.onError(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })

  return {
    snapshot: () => [...table.values()].map(record => record.entry),
    clientPath: id => table.get(id)?.clientPath,
    dispose: () => { unsubscribe() },
  }
}

/** One full table build from the loader's current entries. */
function scan(deps: WebPluginRegistryDeps): Map<string, WebPluginRecord> {
  const table = new Map<string, WebPluginRecord>()
  for (const entry of deps.loader.entries()) {
    if (entry.fiber === undefined || entry.disabled) continue
    const name = entry.options.name
    if (table.has(name)) continue
    const pkgPath = deps.resolvePkgJson(name)
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
    const decl = parseDshClient(name, pkg.dshClient)
    if (decl === undefined || decl.platform !== 'web') continue
    const clientRel = clientExportOf(name, pkg.exports)
    if (clientRel === undefined) {
      throw new Error(`web-plugins: ${name} declares dshClient but exports no "./client" bundle`)
    }
    table.set(name, {
      entry: {
        id: name,
        url: `/plugins/${name}/client.js`,
        inject: decl.inject ?? [],
        ...(decl.immediately === true ? { immediately: true } : {}),
      },
      clientPath: join(dirname(pkgPath), clientRel),
    })
  }
  return table
}
