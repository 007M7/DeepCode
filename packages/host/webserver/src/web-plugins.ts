/**
 * HostWebPluginRegistry: composes the client entry graph served as
 * `window.__DSH_BOOT__` ({rev, entries}). Every row is discovered among the
 * host Loader's loaded entries by its package.json `dshClient` declaration
 * (all client plugin packages arrive by fetch — one uniform bundle shape),
 * resolving each one's client bundle path from `exports["./client"]` and
 * hashing the bundle content into a `rev` (cache busting + HMR diff anchor).
 * `inject` edges and the `immediately` prefetch mark come from the manifest
 * (dshClient — the package owns its dependency edges and its boot tier); the
 * composition layer contributes only the roster. The webserver consumes the
 * table to emit the boot graph and to serve `GET /plugins/<id>/client.js`;
 * in dev mode the registry additionally stat-polls each scanned bundle file
 * and re-hashes + notifies `onRebuilt` subscribers on change (the rebuild
 * signal is the registry's own observation — no builder protocol exists).
 *
 * The vendored loader emits no "entry loaded" event (only `loader/entry-init`,
 * which fires at Entry construction before import/apply), so the registry
 * scans `loader.entries()` and rescans on cordis `internal/plugin` (fiber
 * create/dispose), microtask-debounced. Plugin-set changes take effect on
 * restart per the config-source ruling; the subscription only keeps the table
 * fresh within a process lifetime.
 */

import { createHash } from 'node:crypto'
import { readFileSync, unwatchFile, watchFile } from 'node:fs'
import type { Stats } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from 'cordis'

/** One composed client entry (`window.__DSH_BOOT__.entries` row). */
export interface WebBootEntry {
  /** Entry name == package name. */
  id: string
  /** Bundle URL served by this webserver (`/plugins/<id>/client.js?rev=<rev>`). */
  url: string
  /** Bundle content hash (sha1, shortened). */
  rev: string
  /** Package-name dependency edges from the manifest (dshClient.inject), informational (preflight/HMR display). */
  inject?: string[]
  /** Boot phase-one prefetch tier: the shell fetches these bundles in parallel before creating entries. */
  immediately?: boolean
}

/** The composed entry graph: injected into index.html and pushed on /plugins/events connect. */
export interface WebBootGraph {
  /** Consistency anchor over all rows: changes whenever any entry row changes. */
  rev: string
  /** All composed entries (order carries no semantics; governance ordering is the client Loader's job). */
  entries: WebBootEntry[]
}

/** The web plugin table consumed by the boot injection, the bundle endpoint, and the rebuild channel. */
export interface HostWebPluginRegistry {
  /** Current composed entry graph (stable object between changes). */
  graph(): WebBootGraph
  /**
   * Absolute path of an entry's client bundle.
   * @param id - entry id (package name).
   * @returns the path, or undefined for an unknown id.
   */
  clientPath(id: string): string | undefined
  /**
   * Re-hash one entry's bundle: updates the row's rev/url and the graph rev.
   * The dev bundle watch calls this on every observed file change.
   * @param id - entry id (package name).
   * @returns the new bundle rev, or undefined for an unknown id.
   */
  rebuilt(id: string): string | undefined
  /**
   * Subscribe to bundle rebuilds observed by the dev watch (only fires when
   * the re-hash produced a different rev — an unchanged bundle is silent).
   * @param listener - receives the entry id and its new bundle rev.
   * @returns the unsubscriber.
   */
  onRebuilt(listener: (id: string, rev: string) => void): () => void
  /** Remove the loader subscription, all bundle watches, and all rebuild listeners. */
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
  /**
   * Dev-mode bundle watching: stat-poll every scanned row's client bundle
   * (fs.watchFile — polling by design: network mounts deliver no inotify
   * events) and re-hash + notify onRebuilt subscribers on change. Absent =
   * no watching (prod composition).
   */
  watch?: {
    /** Stat-poll interval in milliseconds; default 500 (the build-side watcher's polling default). */
    intervalMs?: number
  }
}

/** package.json `dshClient` declaration shape (file boundary — validated field by field). */
interface DshClientDeclaration {
  inject?: string[]
  platform: string
  /** Boot phase-one prefetch mark; absent means lazy (fetched on demand). */
  immediately?: boolean
}

interface WebPluginRecord {
  entry: WebBootEntry
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

/** sha1 content hash shortened to 12 hex chars (bundle rev / graph rev). */
function shortHash(input: string | Buffer): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12)
}

/** Graph row for one bundle rev (url carries the rev as its cache-busting query). */
function graphRow(id: string, rev: string, inject: string[] | undefined, immediately: boolean): WebBootEntry {
  return {
    id,
    url: `/plugins/${id}/client.js?rev=${rev}`,
    rev,
    ...(inject !== undefined ? { inject } : {}),
    ...(immediately ? { immediately: true } : {}),
  }
}

/** Compose the graph value from the current table. */
function composeGraph(table: Map<string, WebPluginRecord>): WebBootGraph {
  const entries = [...table.values()].map(record => record.entry)
  return { rev: shortHash(JSON.stringify(entries)), entries }
}

/**
 * Build the web plugin registry: scan once synchronously (a malformed
 * declaration, an unbuilt bundle, or an invalid watch interval throws here —
 * load-time fail loud), then rescan on `internal/plugin`, microtask-debounced
 * (failures go to `deps.onError`). With `deps.watch`, every scanned bundle
 * file is stat-polled and a content change re-hashes the row and notifies
 * `onRebuilt` subscribers.
 * @param deps - loader view, resolution hook, error sink, and optional dev watch (see {@link WebPluginRegistryDeps}).
 * @returns the registry handle.
 */
export function createHostWebPluginRegistry(deps: WebPluginRegistryDeps): HostWebPluginRegistry {
  const watchInterval = deps.watch === undefined ? undefined : deps.watch.intervalMs ?? 500
  if (watchInterval !== undefined && (!Number.isInteger(watchInterval) || watchInterval <= 0)) {
    throw new Error(`web-plugins: watch.intervalMs must be a positive integer (got ${String(deps.watch?.intervalMs)})`)
  }

  let table = scan(deps)
  let graph = composeGraph(table)
  const rebuildListeners = new Set<(id: string, rev: string) => void>()

  const rebuilt = (id: string): string | undefined => {
    const record = table.get(id)
    if (record === undefined) return undefined
    const rev = shortHash(readFileSync(record.clientPath))
    record.entry = graphRow(id, rev, record.entry.inject, record.entry.immediately === true)
    graph = composeGraph(table)
    return rev
  }

  // Dev bundle watch: one fs.watchFile stat poll per table row. A torn read
  // of a half-written bundle self-heals — the ongoing write keeps changing
  // the stats, so the next poll tick re-hashes the completed file.
  const watched = new Map<string, { path: string; listener: (curr: Stats, prev: Stats) => void }>()
  const syncWatches = (): void => {
    if (watchInterval === undefined) return
    for (const [id, watch] of watched) {
      if (table.get(id)?.clientPath === watch.path) continue
      unwatchFile(watch.path, watch.listener)
      watched.delete(id)
    }
    for (const [id, record] of table) {
      if (watched.has(id)) continue
      const listener = (curr: Stats, prev: Stats): void => {
        // fs.watchFile fires on any stat delta (atime included); only content
        // signals count. An all-zero curr means the file vanished mid-rebuild
        // — the completing write fires the next tick, so skipping is safe.
        if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return
        if (curr.mtimeMs === 0) return
        const before = table.get(id)?.entry.rev
        let rev: string | undefined
        try {
          rev = rebuilt(id)
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'ENOENT') return // mid-rename window; the completed write fires the next poll tick
          deps.onError(error instanceof Error ? error : new Error(String(error)))
          return
        }
        if (rev === undefined || rev === before) return
        for (const notify of rebuildListeners) {
          // A throwing subscriber must not escape the fs.watchFile callback
          // (that would skip later subscribers and can kill the process).
          try {
            notify(id, rev)
          } catch (error) {
            deps.onError(error instanceof Error ? error : new Error(String(error)))
          }
        }
      }
      watchFile(record.clientPath, { interval: watchInterval, persistent: false }, listener)
      watched.set(id, { path: record.clientPath, listener })
    }
  }
  syncWatches()

  let pending = false
  const unsubscribe = deps.ctx.on('internal/plugin', () => {
    if (pending) return
    pending = true
    queueMicrotask(() => {
      pending = false
      try {
        table = scan(deps)
        graph = composeGraph(table)
        syncWatches()
      } catch (error) {
        // Keep serving the previous graph: a mid-flight rescan failure must not
        // take down the boot manifest for plugins that were fine.
        deps.onError(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })

  return {
    graph: () => graph,
    clientPath: id => table.get(id)?.clientPath,
    rebuilt,
    onRebuilt: (listener) => {
      rebuildListeners.add(listener)
      return () => { rebuildListeners.delete(listener) }
    },
    dispose: () => {
      unsubscribe()
      for (const { path, listener } of watched.values()) unwatchFile(path, listener)
      watched.clear()
      rebuildListeners.clear()
    },
  }
}

/** One full table build from the loader's current entries (bundle content is hashed here — an unreadable bundle throws). */
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
    const clientPath = join(dirname(pkgPath), clientRel)
    const rev = shortHash(readFileSync(clientPath))
    table.set(name, { entry: graphRow(name, rev, decl.inject, decl.immediately === true), clientPath })
  }
  return table
}
