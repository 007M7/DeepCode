/**
 * AppCLIEntry — the pre-cordis boot glue every dsh surface shape shares
 * (config-tree boot wired for `dsh web` this round; TUI/headless migrate
 * later). Everything here is what must exist before the Loader runs: layered
 * env, the patch composition over the shipped cordis.yml (profile json + CLI
 * flags + the resolved frontend dist), and the fail-loud triple after the
 * tree settles.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from 'cordis'
import type { FiberState } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Include, { type PatchOptions } from '@cordisjs/plugin-include'
import yaml from 'js-yaml'
import { assertEntriesLoaded, installFailLoud, loadEnv } from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-paths'
// Empty type import carries the httpServer Context merge for the port read below.
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Profile file under the invoking directory (read-only this round; never created — see the design's profile ruling). */
const PROFILE_DIR = '.dsh-tmp-profile'
const PROFILE_FILE = 'config.json'

/** One profile-json key mapped onto a yml row's config field. */
interface ProfileMapping {
  jsonPath: string
  entryId: string
  configKey: string
}

/**
 * The static profile→row mapping table. json is user config and wins over the
 * yml engineering default per field; a json key absent from this table fails
 * loud (a typo silently ignored would read as "setting has no effect").
 * Developers extend deployments by adding rows here.
 */
const PROFILE_MAPPINGS: ProfileMapping[] = [
  { jsonPath: 'provider', entryId: 'api-gateway', configKey: 'provider' },
  { jsonPath: 'model', entryId: 'api-gateway', configKey: 'model' },
  { jsonPath: 'persistenceRoot', entryId: 'session-persistence-jsonl', configKey: 'root' },
]

// The include's YAML dialect: `!!js` scalars become expression nodes the
// Loader evaluates at entry activation. The bypass parse below must accept
// them (and passing one through a patch unchanged is legal).
const jsExprType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: data => typeof data === 'string',
  construct: data => ({ __jsExpr: String(data) }),
})
const includeYamlSchema = yaml.JSON_SCHEMA.extend(jsExprType)

/**
 * Value mirror of cordis's `FiberState` const enum members the sweep needs
 * (a const enum has no runtime object to import; same rationale as the
 * client-side mirror in dsh-client-web).
 */
const FIBER_ACTIVE = 2 as FiberState.ACTIVE
const FIBER_PENDING = 0 as FiberState.PENDING

/** Constructor facts for one `dsh web` invocation (argv already parsed by web.ts). */
export interface AppCLIEntryOptions {
  /** Absolute path of the shipped cordis.yml. */
  configPath: string
  /** Whether to append the HMR row (the whole prod/dev difference). */
  dev: boolean
  /** --host when explicitly passed; undefined keeps the yml engineering default. */
  host?: string
  /** --port when explicitly passed; undefined keeps the yml engineering default. */
  port?: number
}

/**
 * Boot driver for the config-tree `dsh web` shape: holds only what exists
 * independently of (and prior to) cordis — argv facts, the composed patch
 * set, and finally the root ctx.
 */
export class AppCLIEntry {
  /** The root context, set by {@link run}. */
  ctx!: Context

  private patches: PatchOptions[] = []

  constructor(private readonly options: AppCLIEntryOptions) {}

  /**
   * Run the boot chain: layered env → patch composition → Loader include
   * boot (dev row before await) → fail-loud triple.
   * @returns the settled root context and the listening port.
   */
  async run(): Promise<{ ctx: Context; port: number }> {
    this.loadEnvLayers()
    this.composePatches()
    await this.bootTree()
    this.assertBoot()
    const port = this.ctx.get('httpServer')?.port
    /* v8 ignore next -- the sweep above guarantees an ACTIVE webserver row */
    if (port === undefined) throw new Error('dsh web: httpServer service missing after settled boot')
    return { ctx: this.ctx, port }
  }

  /** Layered .env: ambient > cwd (bin already loaded) > $DSH_HOME (loadEnvFile never overrides). */
  private loadEnvLayers(): void {
    loadEnv('dsh web', resolveDshHome())
  }

  /**
   * Compose the patch set from the three non-yml config sources: profile
   * json (user config), CLI flags, and the resolved frontend dist. Patches
   * replace a row's config wholesale, so each patched row's yml static
   * values are re-read here (bypass parse) and merged under the overrides.
   */
  private composePatches(): void {
    const rows = this.parseYmlRows()
    const overrides = new Map<string, Record<string, unknown>>()
    const put = (entryId: string, key: string, value: unknown): void => {
      const bag = overrides.get(entryId) ?? {}
      bag[key] = value
      overrides.set(entryId, bag)
    }

    // Source 1: profile json (missing file = empty; unmapped key = loud).
    for (const [key, value] of Object.entries(this.readProfile())) {
      const mapping = PROFILE_MAPPINGS.find(m => m.jsonPath === key)
      if (mapping === undefined) {
        throw new Error(`dsh web: profile key "${key}" has no mapping (known: ${PROFILE_MAPPINGS.map(m => m.jsonPath).join(', ')})`)
      }
      put(mapping.entryId, mapping.configKey, value)
    }

    // Source 2: CLI flags (field set disjoint from the json mappings).
    if (this.options.host !== undefined) put('webserver', 'host', this.options.host)
    if (this.options.port !== undefined) put('webserver', 'port', this.options.port)

    // Source 3: the frontend dist — an assembly fact of this app, never yml
    // user config. Workspace knowledge stays here.
    put('webserver', 'distIndex', this.resolveDistIndex())

    this.patches = [...overrides.entries()].map(([id, bag]) => {
      const yml = rows.get(id)
      if (yml === undefined) throw new Error(`dsh web: patch target row "${id}" not found in ${this.options.configPath}`)
      return { id, config: { ...(yml.config ?? {}) as Record<string, unknown>, ...bag } }
    })
  }

  /** Loader include boot; the dev HMR row mounts before await so the fail-loud triple covers it. */
  private async bootTree(): Promise<void> {
    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(join(resolve(this.options.configPath), '..')).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await ctx.loader.create({
      name: 'cordis:include',
      config: {
        path: pathToFileURL(resolve(this.options.configPath)).href,
        ...this.patches.length > 0 ? { patches: this.patches } : {},
      },
    })
    if (this.options.dev) {
      await ctx.loader.create({ name: '@deepseek-ai/dsh-client-hmr' })
    }
    this.ctx = ctx
    await ctx.loader.await()
  }

  /**
   * Fail-loud triple: assertEntriesLoaded catches import failures,
   * installFailLoud catches late apply rejections, and the all-ACTIVE sweep
   * below catches PENDING fibers (cordis inject waiting has no timeout).
   */
  private assertBoot(): void {
    installFailLoud('dsh web')
    assertEntriesLoaded(this.ctx, 'dsh web')
    const failures: string[] = []
    for (const entry of this.ctx.loader.entries()) {
      if (entry.fiber === undefined || entry.disabled) continue
      const state = entry.fiber.state
      if (state === FIBER_ACTIVE) continue
      if (state === FIBER_PENDING) {
        const missing = Object.keys(entry.fiber.inject).filter(service => this.ctx.get(service) === undefined)
        failures.push(`${entry.options.name}: pending (waiting for service${missing.length === 1 ? '' : 's'}: ${missing.join(', ') || 'unknown'})`)
      } else {
        failures.push(`${entry.options.name}: fiber state ${String(state)}`)
      }
    }
    if (failures.length > 0) {
      throw new Error(`dsh web: ${String(failures.length)} entr${failures.length === 1 ? 'y' : 'ies'} did not activate\n${failures.join('\n')}`)
    }
  }

  /** Bypass parse of the shipped yml (id → row) for patch-merge inputs; Loader still reads the file itself. */
  private parseYmlRows(): Map<string, { config?: unknown }> {
    const doc = yaml.load(readFileSync(this.options.configPath, 'utf8'), { schema: includeYamlSchema })
    if (!Array.isArray(doc)) throw new Error(`dsh web: ${this.options.configPath} is not a top-level entry list`)
    const rows = new Map<string, { config?: unknown }>()
    for (const row of doc as { id?: string; config?: unknown }[]) {
      if (typeof row.id === 'string') rows.set(row.id, row)
    }
    return rows
  }

  /** Profile json under cwd; read-only — never created here, absent = no user config. */
  private readProfile(): Record<string, unknown> {
    let raw: string
    try {
      raw = readFileSync(join(process.cwd(), PROFILE_DIR, PROFILE_FILE), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`dsh web: ${PROFILE_DIR}/${PROFILE_FILE} must hold a JSON object`)
    }
    return parsed as Record<string, unknown>
  }

  /** Dist location is workspace knowledge of this app: resolved through the frontend package exports, not configured. */
  private resolveDistIndex(): string {
    const require = createRequire(import.meta.url)
    try {
      return require.resolve('@deepseek-ai/dsh-frontend/dist/index.html')
    } catch {
      throw new Error('dsh web: frontend dist not built; run pnpm --filter @deepseek-ai/dsh-frontend build first')
    }
  }
}
