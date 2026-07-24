/**
 * ClientModuleLoaderImpl — the implementation behind the {@link ClientModuleLoader}
 * seam. The conceptual contract (lazy CJS model, resolution branch order) is
 * documented on the package module and the public interfaces in `./index.ts`;
 * this file owns the state tables and the fetch/execute/materialize machinery.
 */
import type {
  ClientModuleLoader, ClientModuleLoaderOptions, ClientModuleRecord,
  ClientPluginHandoff, DshWindow, WebBootEntry,
} from './index.ts'

/** A registered-but-unmaterialized bundle: the factory plus its source URL (diagnostics). */
interface RegisteredFactory {
  factory: ClientPluginHandoff['factory']
  url: string
}

/** Default bundle fetch seam: same-origin fetch().text(). */
const defaultFetchBundle = async (url: string): Promise<string> => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`client-modules: bundle fetch ${url} answered ${String(res.status)}`)
  return res.text()
}

/** Default bundle execution seam: a <script> element carrying the code. */
const defaultExecuteBundle = (code: string, url: string): void => {
  const el = document.createElement('script')
  // Inline execution (not src) so the fetch half stays parallelizable; the
  // sourceURL comment keeps devtools stack frames attributed to the bundle.
  el.textContent = `${code}\n//# sourceURL=${url}`
  document.head.appendChild(el)
  // Execution is synchronous for inline scripts: the factory is registered by
  // now, so the node (and its source text) has no further job. Removing it
  // keeps repeated HMR rebuilds from accumulating dead script nodes.
  el.remove()
}

const urlOf = (row: WebBootEntry): string => {
  // url is conditional on the wire (shell-own pseudo rows omit it); those
  // ids resolve through the static registry and never reach a fetch.
  if (row.url === undefined) throw new Error(`client-modules: entry "${row.id}" has no bundle url and no static registration`)
  return row.url
}

/**
 * A plugin bundle IS its package's client half: `<id>/client` (the exports
 * subpath external bundles emit) and the bare graph id name the same
 * surface, so table lookups normalize the suffix away.
 */
const stripClientSuffix = (spec: string): string =>
  spec.endsWith('/client') ? spec.slice(0, -'/client'.length) : spec

/**
 * Claim and inventory the <style> tags a factory injected during
 * materialization: preset-emitted tags arrive pre-tagged with data-plugin;
 * any untagged tag is claimed for the materializing plugin (HMR bookkeeping).
 */
const claimStyles = (id: string): string[] => {
  if (typeof document === 'undefined') return []
  for (const el of document.querySelectorAll('style:not([data-plugin])')) {
    el.setAttribute('data-plugin', id)
  }
  const owned: string[] = []
  for (const el of document.querySelectorAll(`style[data-plugin=${JSON.stringify(id)}]`)) {
    owned.push(el.getAttribute('data-plugin-css') ?? id)
  }
  return owned
}

/**
 * The client module system: state tables plus the arrival/materialization
 * machinery implementing {@link ClientModuleLoader} (whose members carry the
 * seam contract docs). Construction indexes the boot graph and installs the
 * `window.__ModuleLoader__` registration sink (contract C6) — once per page.
 */
export class ClientModuleLoaderImpl implements ClientModuleLoader {
  readonly version = 'client'
  readonly loadCache = new Map<string, ClientModuleRecord>()

  private readonly seed: Map<string, unknown>
  private readonly statics = new Map<string, unknown>()
  private readonly factories = new Map<string, RegisteredFactory>()
  /** In-flight prefetch (fetch + execute) per id; concurrent callers share it. */
  private readonly pendingArrival = new Map<string, Promise<void>>()
  /** Materialization re-entrancy guard: factory-form CJS cannot deliver partial exports, so a cycle is fatal. */
  private readonly materializing = new Set<string>()
  private readonly graphRows = new Map<string, WebBootEntry>()
  // Execution URL of the bundle currently being executed (bound into the
  // factory registration so diagnostics can name the source).
  private executingUrl = ''
  // Graph id of the row currently being executed ('' outside arrive):
  // the load sink cross-checks the handoff id against it so a mis-stamped
  // bundle cannot register under another entry's identity.
  private executingId = ''

  private readonly fetchBundle: (url: string) => Promise<string>
  private readonly executeBundle: (code: string, url: string) => void

  /**
   * Build the module system over the host graph.
   * @param options - entry graph, module-table staticModules, fetch/execute seams.
   */
  constructor(options: ClientModuleLoaderOptions) {
    this.seed = new Map(Object.entries(options.staticModules))
    this.fetchBundle = options.fetchBundle ?? defaultFetchBundle
    this.executeBundle = options.executeBundle ?? defaultExecuteBundle

    for (const entry of options.graph.entries) {
      if (this.graphRows.has(entry.id)) throw new Error(`client-modules: duplicate graph entry "${entry.id}"`)
      this.graphRows.set(entry.id, entry)
    }

    const win = globalThis as DshWindow
    if (win.__ModuleLoader__ !== undefined) throw new Error('client-modules: window.__ModuleLoader__ already installed (double boot?)')
    win.__ModuleLoader__ = {
      load: (handoff: ClientPluginHandoff): void => {
        // Registration is keyed by the handoff id; a duplicate means a bundle
        // executed twice without an invalidate — always a bug, always loud.
        if (this.factories.has(handoff.id)) throw new Error(`client-modules: duplicate factory registration for "${handoff.id}" (bundle executed twice without invalidate?)`)
        // A fetched row's bundle must register the id its row names — a
        // mis-stamped bundle registering under another entry's identity
        // would let that entry silently materialize foreign exports.
        if (this.executingId !== '' && handoff.id !== this.executingId) {
          throw new Error(`client-modules: bundle ${this.executingUrl} registered "${handoff.id}" while arriving for "${this.executingId}" (mis-stamped bundle id)`)
        }
        this.factories.set(handoff.id, { factory: handoff.factory, url: this.executingUrl })
      },
    }
  }

  /** Fetch + execute one graph row so its factory is registered (idempotent per in-flight arrival). */
  private arrive(row: WebBootEntry): Promise<void> {
    const { id } = row
    const pending = this.pendingArrival.get(id)
    if (pending !== undefined) return pending
    if (this.factories.has(id)) return Promise.resolve()
    const task = (async (): Promise<void> => {
      const url = urlOf(row)
      const code = await this.fetchBundle(url)
      this.executingUrl = url
      this.executingId = id
      try {
        this.executeBundle(code, url)
      } finally {
        this.executingUrl = ''
        this.executingId = ''
      }
      if (!this.factories.has(id)) {
        throw new Error(`client-modules: bundle ${url} executed without registering "${id}" via __ModuleLoader__.load`)
      }
    })().finally(() => { this.pendingArrival.delete(id) })
    this.pendingArrival.set(id, task)
    return task
  }

  /** Materialize a registered factory (synchronous; memoized in loadCache). */
  private materialize(id: string): ClientModuleRecord {
    const existing = this.loadCache.get(id)
    if (existing !== undefined) return existing
    const registered = this.factories.get(id)
    /* v8 ignore next -- callers check the factory branch before dispatching here. */
    if (registered === undefined) throw new Error(`client-modules: no registered factory for "${id}"`)
    if (this.materializing.has(id)) {
      throw new Error(`client-modules: require cycle through "${id}" (factory-form CJS cannot deliver partial exports)`)
    }
    this.materializing.add(id)
    try {
      const edges = new Set<string>()
      const surface = registered.factory(this.makeRequire(edges))
      const record: ClientModuleRecord = { id, surface, styles: claimStyles(id), edges }
      this.loadCache.set(id, record)
      return record
    } finally {
      this.materializing.delete(id)
    }
  }

  /**
   * The synchronous require answered to factories: seed → static → memoized
   * record → registered factory (recursive materialization — this is what
   * makes load order self-resolving). Fetching is async and therefore
   * unreachable from here; an unregistered plugin specifier is loud (and a
   * cross-plugin value import is already a build error upstream).
   */
  private makeRequire(edges: Set<string>): (spec: string) => unknown {
    return (spec: string): unknown => {
      edges.add(spec)
      if (this.seed.has(spec)) return this.seed.get(spec)
      if (this.statics.has(spec)) return this.statics.get(spec)
      const id = stripClientSuffix(spec)
      const record = this.loadCache.get(id)
      if (record !== undefined) return record.surface
      if (this.factories.has(id)) return this.materialize(id).surface
      throw new Error(
        `client-modules: require("${spec}") missed the module table — not a platform seed word, not a shell-own module, `
        + 'and no registered factory (a build-time externals drift, or a forbidden cross-plugin value import)',
      )
    }
  }

  async import(specifier: string): Promise<unknown> {
    if (this.seed.has(specifier)) return this.seed.get(specifier)
    const existing = this.loadCache.get(specifier)
    if (existing !== undefined) return existing.surface
    if (this.statics.has(specifier)) {
      const surface = this.statics.get(specifier)
      this.loadCache.set(specifier, { id: specifier, surface, styles: [], edges: new Set() })
      return surface
    }
    if (!this.factories.has(specifier)) {
      const row = this.graphRows.get(specifier)
      if (row === undefined) {
        throw new Error(
          `client-modules: cannot resolve "${specifier}" — not a seed word, not a shell-own module, `
          + 'and not a row in the boot graph (the runtime mirror of the bundle purity gate)',
        )
      }
      await this.arrive(row)
    }
    return this.materialize(specifier).surface
  }

  registerStatic(id: string, module: unknown): void {
    if (this.statics.has(id)) throw new Error(`client-modules: shell-own module "${id}" registered twice`)
    this.statics.set(id, module)
  }

  async prefetch(id: string): Promise<void> {
    if (this.statics.has(id)) return
    const row = this.graphRows.get(id)
    if (row === undefined) throw new Error(`client-modules: prefetch("${id}") — not a graph entry`)
    await this.arrive(row)
  }

  invalidate(id: string): void {
    this.factories.delete(id)
    this.loadCache.delete(id)
  }
}
