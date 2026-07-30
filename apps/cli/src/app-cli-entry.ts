/**
 * AppCLIEntry — the pre-cordis boot glue the config-tree dsh surfaces share
 * for the Web/headless surface.
 * Everything here is what must exist before the Loader runs: the patch
 * composition over the shipped base and surface overlay (profile json + CLI
 * flags + the resolved frontend dist), and the fail-loud triple after the tree
 * settles. The environment is what the bin already loaded (ambient plus the
 * invoking directory's `.env`); `$DSH_HOME/.env` belongs to the credential
 * provider and is never hoisted here.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { networkInterfaces } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from 'cordis'
import type { PatchOptions } from '@cordisjs/plugin-include'
import yaml from 'js-yaml'
import { boot, installFailLoud, loadOverlayPatches, loadPersonalPatches } from '@deepseek-ai/dsh-app-boot'
// Empty type import carries the httpServer Context merge for the port read below.
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Profile file under the invoking directory (read-only this round; never created — see the design's profile ruling). */
const PROFILE_DIR = '.dsh-tmp-profile'
const PROFILE_FILE = 'config.json'

/** The session-telemetry row id the DSH_TELEMETRY_DISABLED switch targets (mounted in web.cordis.yml). */
const TELEMETRY_ROW_ID = 'telemetry-otel'

/** The webserver schema's all-interfaces bind literal: gates LAN-authority derivation here and the printed LAN URL in web.ts. */
const ALL_INTERFACES_HOST = '0.0.0.0'

/**
 * Non-internal IPv4 interface addresses of this machine — the IP-literal
 * authorities an all-interfaces bind is reachable by on the LAN.
 * @returns the addresses in interface order (possibly empty).
 */
function lanIPv4Addresses(): string[] {
  return Object.values(networkInterfaces()).flat()
    .filter((iface): iface is NonNullable<typeof iface> => iface !== undefined && iface.family === 'IPv4' && !iface.internal)
    .map(iface => iface.address)
}

/**
 * One LAN-trust resolution for one invocation, sampled exactly once: the
 * machine's LAN IP literals when the effective bind is all-interfaces, and
 * the `trustedHosts` value built from them plus the explicit extras. The
 * single sample is deliberate — display must advertise only addresses the
 * fence was configured with, so both read this snapshot. Derived entries are
 * port-less IP literals: DNS rebinding needs an attacker-controlled name, so
 * an IP-literal Host is safe on any port, and the bound port may be
 * OS-assigned, unknowable pre-boot.
 * @param bindHost - the effective webserver bind host (CLI flag, else the yml default).
 * @param extra - `--trusted-host` values, in argv order.
 * @returns the sampled LAN addresses and the connection row's `trustedHosts` value (each possibly empty).
 */
export function resolveLanTrust(
  bindHost: string | undefined,
  extra: readonly string[],
): { lanAddresses: string[]; trustedHosts: string[] } {
  const lanAddresses = bindHost === ALL_INTERFACES_HOST ? lanIPv4Addresses() : []
  return { lanAddresses, trustedHosts: [...lanAddresses, ...extra] }
}

/**
 * Resolve the telemetry opt-out switch into its boot patch. ANY non-empty
 * value (including `'0'`/`'false'`) disables: a privacy switch prefers
 * off-by-mistake over on-by-mistake. Throws when the switch is set but the
 * row is absent — a silently no-op "disabled" privacy switch would keep
 * exporting while the user believes it is off.
 * @param disabledEnv - the raw `DSH_TELEMETRY_DISABLED` value (`undefined` when unset).
 * @param hasRow - whether the composition carries the {@link TELEMETRY_ROW_ID} row.
 * @returns the disable patch, or `undefined` when telemetry stays enabled.
 */
export function resolveTelemetryPatch(disabledEnv: string | undefined, hasRow: boolean): PatchOptions | undefined {
  if ((disabledEnv ?? '') === '') return undefined
  if (!hasRow) {
    throw new Error(`dsh: DSH_TELEMETRY_DISABLED is set but row "${TELEMETRY_ROW_ID}" is not in this composition`)
  }
  return { id: TELEMETRY_ROW_ID, disabled: true }
}

/**
 * Whether a config file carries the telemetry row, parsed under the same
 * `!!js`-tolerant dialect the boot uses — the `hasRow` input for launchers
 * that compose their patch lists outside {@link AppCLIEntry} (the TUI).
 * @param file - absolute path of the config or overlay file.
 * @returns true when a top-level (or inserted) row has the telemetry id.
 */
export function configHasTelemetryRow(file: string): boolean {
  const doc = yaml.load(readFileSync(file, 'utf8'), { schema: includeYamlSchema })
  if (!Array.isArray(doc)) throw new Error(`dsh: ${file} is not a top-level entry list`)
  return (doc as { id?: string; insert?: { id?: string }[] }[]).some(row =>
    row.id === TELEMETRY_ROW_ID || (row.insert ?? []).some(inserted => inserted.id === TELEMETRY_ROW_ID))
}

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

/** Constructor facts for one dsh invocation over the shared composition (argv already parsed by the surface bin). */
export interface AppCLIEntryOptions {
  /** Absolute path of the shared base config the Loader includes. */
  configPath: string
  /**
   * Absolute path of this surface's overlay: a patch list applied over
   * {@link configPath} before this entry's own profile/flag patches. Its rows
   * are also merge inputs, so a flag override preserves the overlay's other
   * fields on the same row.
   */
  overlayPath: string
  /**
   * Optional explicit overlay applied after {@link overlayPath} and before
   * this entry's own profile/flag patches. When absent, the personal
   * `$DSH_HOME/config.yaml` overlay is applied instead.
   */
  extraOverlayPath?: string
  /** Whether to append the HMR row (the whole prod/dev difference; web surface only). */
  dev: boolean
  /** --host when explicitly passed; undefined keeps the yml engineering default. */
  host?: string
  /**
   * Listen port override onto the webserver row. Web passes the --port flag
   * value; headless passes 0 (an OS-assigned port, so parallel `dsh -p` runs
   * never collide — and the printed URL still opens the live session in a
   * browser).
   */
  port?: number
  /** Parent directory for name-created Workspaces; undefined uses the gateway's cwd fallback. */
  workspaceRoot?: string
  /** Extra authorities for the /api browser-trust fence (`host` or `host:port`), appended to the derived LAN IP literals. */
  trustedHosts?: string[]
}

/**
 * Boot driver for the config-tree dsh surfaces (web and headless share the
 * one composition; the surfaces differ only in constructor facts): holds only
 * what exists independently of (and prior to) cordis — argv facts, the
 * composed patch set, and finally the root ctx.
 */
export class AppCLIEntry {
  /** The root context, set by {@link run}. */
  ctx!: Context

  /**
   * LAN IPv4 addresses sampled once at patch composition — the exact snapshot
   * the /api trust fence was configured with. Display reads this instead of
   * re-sampling, so the advertised LAN URL can never name an address the
   * fence rejects. Empty unless the effective bind is all-interfaces.
   */
  lanAddresses: readonly string[] = []

  private patches: PatchOptions[] = []

  constructor(private readonly options: AppCLIEntryOptions) {}

  /**
   * Run the boot chain: patch composition → Loader include boot (dev row
   * before await) → fail-loud triple.
   * @returns the settled root context and the listening port.
   */
  async run(): Promise<{ ctx: Context; port: number }> {
    this.composePatches()
    await this.bootTree()
    this.assertBoot()
    const port = this.ctx.get('httpServer')?.port
    /* v8 ignore next -- the sweep above guarantees an ACTIVE webserver row */
    if (port === undefined) throw new Error('dsh: httpServer service missing after settled boot')
    return { ctx: this.ctx, port }
  }

  /**
   * Compose the patch set from profile json, CLI flags, and the resolved
   * frontend dist. Patches replace a row's config wholesale, so each patched row's yml
   * static values are re-read here (bypass parse) and merged under the overrides.
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
        throw new Error(`dsh: profile key "${key}" has no mapping (known: ${PROFILE_MAPPINGS.map(m => m.jsonPath).join(', ')})`)
      }
      put(mapping.entryId, mapping.configKey, value)
    }

    // Source 2: CLI flags (field set disjoint from the json mappings).
    if (this.options.host !== undefined) put('webserver', 'host', this.options.host)
    if (this.options.port !== undefined) put('webserver', 'port', this.options.port)
    if (this.options.workspaceRoot !== undefined) put('api-gateway', 'workspaceRoot', this.options.workspaceRoot)

    // Source 2b: authorities for the /api browser-trust fence (rationale on
    // resolveLanTrust).
    const ymlHost = (rows.get('webserver')?.config as { host?: string } | undefined)?.host
    const { lanAddresses, trustedHosts } = resolveLanTrust(this.options.host ?? ymlHost, this.options.trustedHosts ?? [])
    this.lanAddresses = lanAddresses
    if (trustedHosts.length > 0) put('connection', 'trustedHosts', trustedHosts)

    // Source 3: the frontend dist — an assembly fact of this app, never yml
    // user config. Workspace knowledge stays here.
    put('webserver', 'distIndex', this.resolveDistIndex())

    this.patches = [...overrides.entries()].map(([id, bag]) => {
      const yml = rows.get(id)
      if (yml === undefined) throw new Error(`dsh: patch target row "${id}" not found in ${this.options.configPath}`)
      return { id, config: { ...(yml.config ?? {}) as Record<string, unknown>, ...bag } }
    })

    // Telemetry opt-out: a row can only be turned off at the patch layer
    // (config cannot disable an entry), and the switch must hold BEFORE the
    // plugin constructs — its exporter.url validation is load-time fail-loud.
    const telemetryPatch = resolveTelemetryPatch(process.env.DSH_TELEMETRY_DISABLED, rows.has(TELEMETRY_ROW_ID))
    if (telemetryPatch !== undefined) this.patches.push(telemetryPatch)
  }

  /** Shared Loader boot; the dev HMR row mounts before await so the fail-loud sweep covers it. */
  private async bootTree(): Promise<void> {
    // One include of the shared base with every overlay as a sibling patch
    // list: patches never cross an include boundary, so nesting them would
    // silently stop reaching base rows. The surface overlay applies first, then
    // this entry's profile-json and CLI-flag patches, which therefore win.
    const patches = [
      ...loadOverlayPatches('dsh', this.options.overlayPath),
      ...this.options.extraOverlayPath === undefined
        ? loadPersonalPatches('dsh') ?? []
        : loadOverlayPatches('dsh', this.options.extraOverlayPath),
      ...this.patches,
    ]
    this.ctx = await boot('dsh', resolve(this.options.configPath), patches, async (ctx) => {
      if (this.options.dev) await ctx.loader.create({ name: '@deepseek-ai/dsh-client-hmr' })
    })
  }

  /** Install the diagnostic for plugin rejections that happen after settled boot. */
  private assertBoot(): void {
    installFailLoud('dsh')
  }

  /**
   * Bypass parse of the base and this surface's overlay (id → row) for
   * patch-merge inputs; the Loader still reads both files itself. The overlay
   * wins per row, matching the order its patches are applied in, and its
   * `insert` rows are indexed too because a flag may target one of them.
   */
  private parseYmlRows(): Map<string, { config?: unknown }> {
    const rows = new Map<string, { config?: unknown }>()
    const files = [this.options.configPath, this.options.overlayPath]
    if (this.options.extraOverlayPath !== undefined) files.push(this.options.extraOverlayPath)
    for (const file of files) {
      for (const row of this.parseRowList(file)) {
        if (typeof row.id === 'string') rows.set(row.id, row)
        for (const inserted of row.insert ?? []) {
          if (typeof inserted.id === 'string') rows.set(inserted.id, inserted)
        }
      }
    }
    return rows
  }

  /**
   * Parse one entry or patch list, rejecting anything that is not a top-level
   * array so a malformed file fails here rather than at row lookup.
   * @param file - absolute path of the config or overlay file.
   * @returns the parsed top-level entries.
   */
  private parseRowList(file: string): { id?: string; config?: unknown; insert?: { id?: string; config?: unknown }[] }[] {
    const doc = yaml.load(readFileSync(file, 'utf8'), { schema: includeYamlSchema })
    if (!Array.isArray(doc)) throw new Error(`dsh: ${file} is not a top-level entry list`)
    return doc as { id?: string; config?: unknown; insert?: { id?: string; config?: unknown }[] }[]
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
      throw new Error(`dsh: ${PROFILE_DIR}/${PROFILE_FILE} must hold a JSON object`)
    }
    return parsed as Record<string, unknown>
  }

  /** Dist location is workspace knowledge of this app: resolved through the frontend package exports, not configured. */
  private resolveDistIndex(): string {
    const require = createRequire(import.meta.url)
    try {
      return require.resolve('@deepseek-ai/dsh-frontend/dist/index.html')
    } catch {
      throw new Error('dsh: frontend dist not built; run pnpm --filter @deepseek-ai/dsh-frontend build first')
    }
  }
}
