/**
 * ClientLoader implementation (shell-held machinery — the loader cannot load
 * itself, so the web shell imports this subpath statically and mounts the
 * instance as ctx.loader; the runtime package's own client bundle never
 * includes it).
 *
 * Load chain per plugin: fetch bundle text → execute (script injection) → the
 * bundle calls window.DSHClientProxy.loadPlugin({id, factory}) (single-slot
 * handoff, id reconciled) → factory(require) with require bound to the module
 * table → ctx.plugin(exports.apply) → the export surface is registered into
 * the module table under the plugin id (inject topology guarantees later
 * loaders can require earlier ones) → <style data-plugin> ownership recorded.
 *
 * start(): the `immediately` group is fetched in parallel and executed in
 * group-internal inject topology (execution is serial — the handoff slot is
 * single); a full-group barrier precedes the remaining plugins, which then
 * load one by one in inject topology.
 */
import type { Context } from 'cordis'
import { createSnapshotStore } from '../store/index.ts'
import type { BootPluginEntry, ClientLoader, LoaderStatus } from '../index.ts'

export type { BootPluginEntry, ClientLoader, LoaderStatus } from '../index.ts'

/** The shape a client bundle hands to window.DSHClientProxy.loadPlugin. */
export interface ClientPluginHandoff {
  /** Plugin id (package name) — must match the manifest row being loaded. */
  id: string
  /**
   * Closure factory: receives the DI require and returns the module's export
   * surface; an `apply` export is applied as a cordis plugin.
   */
  factory: (require: (spec: string) => unknown) => Record<string, unknown>
}

/** Window surface the loader owns (bundle side of the handoff protocol). */
interface DshWindow {
  __DSH_BOOT__?: { plugins: BootPluginEntry[] }
  DSHClientProxy?: { loadPlugin(handoff: ClientPluginHandoff): void }
}

/** Options for createClientLoader (assembled by the web shell at boot). */
export interface ClientLoaderOptions {
  /** Client root context: plugin applies mount under it. */
  ctx: Context
  /**
   * Seeded module table: pure-library entities (react, react-dom, cordis,
   * ui-slots, web-react, ui-primitives). The loader takes ownership and
   * registers loaded bundle export surfaces alongside them.
   */
  modules: Record<string, unknown>
  /**
   * Boot manifest; defaults to window.__DSH_BOOT__. Fixture pages inject the
   * same protocol shape.
   */
  boot?: { plugins: BootPluginEntry[] }
  /** Bundle fetch seam (parallelizable half). Defaults to same-origin fetch().text(). */
  fetchBundle?: (url: string) => Promise<string>
  /**
   * Bundle execution seam (serial half; execution synchronously performs the
   * loadPlugin handoff). Defaults to a <script> element carrying the code.
   */
  executeBundle?: (code: string, url: string) => void
}

/** Per-plugin bookkeeping across the load chain. */
interface PluginRecord {
  entry: BootPluginEntry
  state: 'idle' | 'loading' | 'active' | 'failed'
  fetch?: Promise<string>
  load?: Promise<void>
}

const NOT_LOADED = Symbol('dsh.loader.not-loaded')

/**
 * Build the client bundle loader.
 * @param options - ctx, seeded module table, boot manifest, fetch/execute seams.
 * @returns the ClientLoader the shell mounts as ctx.loader.
 */
export function createClientLoader(options: ClientLoaderOptions): ClientLoader {
  const { ctx } = options
  const win = globalThis as DshWindow
  const boot = options.boot ?? win.__DSH_BOOT__
  if (boot === undefined) throw new Error('client-loader: no boot manifest (window.__DSH_BOOT__ missing)')

  const modules = new Map<string, unknown>(Object.entries(options.modules))
  const records = new Map<string, PluginRecord>()
  for (const entry of boot.plugins) {
    if (records.has(entry.id)) throw new Error(`client-loader: duplicate manifest id "${entry.id}"`)
    records.set(entry.id, { entry, state: 'idle' })
  }

  const status = createSnapshotStore<LoaderStatus>({})
  const publish = (id: string, state: 'loading' | 'active' | 'failed'): void => {
    status.update((draft) => { draft[id] = state })
  }

  // Single-slot handoff: bundle execution synchronously calls loadPlugin;
  // doLoad arms the slot before executing and reconciles the id after.
  let slot: ClientPluginHandoff | typeof NOT_LOADED = NOT_LOADED
  if (win.DSHClientProxy !== undefined) throw new Error('client-loader: window.DSHClientProxy already installed (double boot?)')
  win.DSHClientProxy = {
    loadPlugin: (handoff: ClientPluginHandoff): void => {
      if (slot !== NOT_LOADED) {
        throw new Error(`client-loader: overlapping loadPlugin handoff (got "${handoff.id}" while a previous handoff is unclaimed)`)
      }
      slot = handoff
    },
  }

  const fetchBundle = options.fetchBundle ?? (async (url: string): Promise<string> => {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`client-loader: bundle fetch ${url} answered ${String(res.status)}`)
    return res.text()
  })

  const executeBundle = options.executeBundle ?? ((code: string, url: string): void => {
    const el = document.createElement('script')
    // Inline execution (not src) so the fetch half stays parallelizable; the
    // sourceURL comment keeps devtools stack frames attributed to the bundle.
    el.textContent = `${code}\n//# sourceURL=${url}`
    document.head.appendChild(el)
  })

  const requireModule = (spec: string): unknown => {
    if (!modules.has(spec)) {
      throw new Error(`client-loader: module "${spec}" is not available — not a seeded library and no loaded plugin registered it (check dshClient.inject ordering)`)
    }
    return modules.get(spec)
  }

  /** Tag styles the bundle injected during execution (unload bookkeeping; plugin CSS lands untagged). */
  const claimStyles = (id: string): void => {
    if (typeof document === 'undefined') return
    for (const el of document.querySelectorAll('style:not([data-plugin])')) {
      el.setAttribute('data-plugin', id)
    }
  }

  /** Start (or reuse) the parallelizable fetch half. */
  const prefetch = (record: PluginRecord): Promise<string> =>
    (record.fetch ??= fetchBundle(record.entry.url))

  async function doLoad(record: PluginRecord): Promise<void> {
    const { id } = record.entry
    record.state = 'loading'
    publish(id, 'loading')
    try {
      // Dependencies must already be active (start() sequences this; direct
      // load() callers get the same fail-loud check).
      for (const dep of record.entry.inject) {
        const depRecord = records.get(dep)
        if (depRecord === undefined) throw new Error(`client-loader: "${id}" injects unknown plugin "${dep}"`)
        if (depRecord.state !== 'active') throw new Error(`client-loader: "${id}" loaded before its dependency "${dep}" is active`)
      }
      const code = await prefetch(record)
      executeBundle(code, record.entry.url)
      if (slot === NOT_LOADED) throw new Error(`client-loader: bundle ${record.entry.url} executed without calling DSHClientProxy.loadPlugin`)
      const handoff = slot
      slot = NOT_LOADED
      if (handoff.id !== id) throw new Error(`client-loader: bundle id mismatch — manifest "${id}" vs handoff "${handoff.id}"`)
      const exports = handoff.factory(requireModule)
      if (typeof exports.apply !== 'function') throw new Error(`client-loader: plugin "${id}" exports no apply function`)
      // The whole export surface is the plugin: cordis object-plugin form
      // keeps the bundle's exported `inject`/`name` (an apply-only pass would
      // silently drop the dependency declaration — postmortem 0001).
      const fiber = ctx.plugin(exports as { apply: (ctx: Context) => void })
      await fiber.await()
      // Register under both specifier forms bundles emit: the bare package
      // name (deep-import rewrites) and the /client subpath (CLIENT_EXTERNALS
      // form) — the loaded surface IS the client half either way.
      modules.set(id, exports)
      modules.set(`${id}/client`, exports)
      claimStyles(id)
      record.state = 'active'
      publish(id, 'active')
    } catch (error) {
      record.state = 'failed'
      publish(id, 'failed')
      throw error
    }
  }

  const load = (id: string): Promise<void> => {
    const record = records.get(id)
    if (record === undefined) return Promise.reject(new Error(`client-loader: unknown plugin "${id}"`))
    record.load ??= doLoad(record)
    return record.load
  }

  /** Topologically order `ids` by inject (edges inside the set only — an early-group member never waits on a later-group one). */
  const topo = (ids: string[]): string[] => {
    const pool = new Set(ids)
    const ordered: string[] = []
    const done = new Set<string>()
    const visiting = new Set<string>()
    const visit = (id: string): void => {
      if (done.has(id)) return
      if (visiting.has(id)) throw new Error(`client-loader: inject cycle through "${id}"`)
      visiting.add(id)
      const record = records.get(id)
      /* v8 ignore next -- ids come from records; unknown ids are caught per-dep below. */
      if (record === undefined) throw new Error(`client-loader: manifest references unknown plugin "${id}"`)
      for (const dep of record.entry.inject) {
        if (!records.has(dep)) throw new Error(`client-loader: "${id}" injects unknown plugin "${dep}"`)
        if (pool.has(dep)) visit(dep)
      }
      visiting.delete(id)
      done.add(id)
      ordered.push(id)
    }
    for (const id of ids) visit(id)
    return ordered
  }

  let settledPromise: Promise<void> | undefined

  async function run(): Promise<void> {
    const all = [...records.values()]
    const early = all.filter(r => r.entry.immediately === true)
    const rest = all.filter(r => r.entry.immediately !== true)
    // Early group: parallel fetch (all requests in flight at once), serial
    // inject-topology execution, full-group barrier before anything else.
    const earlyOrder = topo(early.map(r => r.entry.id))
    for (const record of early) void prefetch(record).catch(() => {}) // surfaced by the awaited load below
    for (const id of earlyOrder) await load(id)
    // Remaining plugins: one by one in inject topology.
    for (const id of topo(rest.map(r => r.entry.id))) await load(id)
  }

  return {
    start: () => {
      settledPromise ??= run()
      // Failures surface through settled()/status — start() itself is fire-and-forget.
      settledPromise.catch(() => {})
    },
    load,
    unload: (id: string) => Promise.reject(new Error(`client-loader: unload("${id}") is not implemented (lands with HMR)`)),
    settled: () => {
      if (settledPromise === undefined) throw new Error('client-loader: settled() before start()')
      return settledPromise
    },
    requireModule,
    status,
  }
}
