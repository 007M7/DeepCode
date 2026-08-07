/**
 * The web app's startup row: it owns the `dsh --profile web` flag family
 * (`--host`, `--port`, `--dev`, `--workspace-root`, `--trusted-host`) and its
 * `--help` text, turns those flags into changes on the rows that inject
 * {@link WEB_STARTUP_SERVICE}, and then provides it. Until it does, no web row
 * starts, so `dsh --profile web --help` prints this command's help and the
 * server never binds.
 * @module @deepseek-ai/dsh-web-app/startup
 */

import { networkInterfaces } from 'node:os'
import { Command } from 'commander'
import type { Context } from 'cordis'
import { interpolate, type EntryOptions } from '@cordisjs/plugin-loader'
import { runStartup } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'web-startup'

/** Services required before the flags can be resolved. */
export const inject = ['cmdlineArgs']

/**
 * The service this row provides and every flag-configured web row reads. The
 * rows are listed in this bundle's `cordis.patch.yml`, where each names the key
 * it takes from here and the value it falls back to.
 */
export const WEB_STARTUP_SERVICE = 'webStartup'

/** What the web rows read from {@link WEB_STARTUP_SERVICE}. */
export interface WebStartupValues {
  /** `--host`, absent when the invocation did not name one. */
  host?: string
  /** `--port`, absent when the invocation did not name one. */
  port?: number
  /** `--workspace-root`, absent when the invocation did not name one. */
  workspaceRoot?: string
  /** Web runtime mode; `--dev` selects development, which also mounts the client-plugin reload chain. */
  mode: 'production' | 'development'
  /**
   * The `/api` fence authorities for this invocation: the LAN literals an
   * all-interfaces bind derived, plus the `--trusted-host` extras, over what
   * the composition already configured.
   */
  trustedHosts: string[]
  /** The LAN literals the fence was configured with, for display. */
  lanAddresses: string[]
}

/** The webserver schema's all-interfaces bind literal: only this bind derives LAN authorities. */
const ALL_INTERFACES_HOST = '0.0.0.0'

/**
 * Read the deployment trust list before its row mounts and validates config.
 * @param config - the connection row's config resolved before `webStartup` exists.
 * @returns its configured authorities, or an empty list when absent.
 * @throws when the file-backed config is not an array of strings.
 */
function configuredTrustedHosts(config: unknown): string[] {
  const value = (config as { trustedHosts?: unknown } | undefined)?.trustedHosts
  if (value === undefined) return []
  const valid = Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string')
  if (!valid) throw new Error('web-startup: the composed connection trustedHosts must be an array of strings')
  return value
}

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
 * machine's LAN IP literals when the effective bind is all-interfaces, and the
 * `trustedHosts` value built from them plus the explicit extras. The single
 * sample is deliberate — display must advertise only addresses the fence was
 * configured with, so the `web-runtime` row receives this same snapshot.
 * Derived entries are port-less IP literals: DNS rebinding needs an
 * attacker-controlled name, so an IP-literal Host is safe on any port, and the
 * bound port may be OS-assigned, unknowable before the server binds.
 * @param bindHost - the effective webserver bind host (the flag, else the composed row value).
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

/** The web flag family, as commander parsed it. */
interface WebOptions {
  host?: string
  port?: string
  dev?: boolean
  workspaceRoot?: string
  trustedHost?: string[]
}

/**
 * This app's command: its flags, its description, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function webCommand(): Command {
  return new Command()
    .name('dsh --profile web')
    .description('Serve the DeepSeek Harness browser UI.')
    .helpOption('-h, --help', 'show this help')
    .option('--host <host>', 'bind host; pass 0.0.0.0 to reach it from another machine')
    .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
    .option('--dev', 'mount the client-plugin HMR receiver (run pnpm run dev:web separately to rebuild bundles)')
    .option('--workspace-root <path>', 'parent directory for workspaces created from the browser UI')
    .option('--trusted-host <authority...>', 'extra authority the /api browser-trust fence accepts (host or host:port; repeatable)')
    .addHelpText('after', `
Examples:
  dsh web                          serve on the composed host and port
  dsh web --port 8080              serve on another port
  dsh web --host 0.0.0.0           reach it from another machine on the LAN
  dsh web --dev                    mount the client-plugin HMR receiver
`)
}

/**
 * Turn the parsed flags into the values the web rows read.
 * @param program - the parsed web command.
 * @param rows - the waiting rows' composed options, in tree order.
 * @param ctx - the startup context used to resolve composed fallbacks before `webStartup` exists.
 * @returns the web rows' service value.
 */
function planWebStartup(program: Command, rows: readonly EntryOptions[], ctx: Context): WebStartupValues {
  const options = program.opts<WebOptions>()
  if (options.port !== undefined && !/^\d+$/.test(options.port)) {
    program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`)
  }
  const row = (id: string): EntryOptions => {
    const found = rows.find(candidate => candidate.id === id)
    if (found === undefined) throw new Error(`web-startup: the web composition has no waiting ${JSON.stringify(id)} row to configure`)
    return found
  }
  const webserver = row('webserver')
  row('api-gateway')
  row('web-runtime')
  const connection = row('connection')
  // Include preserves nested row expressions until their own injections are
  // active. Resolve just the composed fields this startup plan needs against
  // the pre-service context, where their `ctx.get('webStartup')` fallback wins.
  const webserverConfig = interpolate(ctx, webserver.config) as { host?: string } | undefined
  const connectionConfig: unknown = interpolate(ctx, connection.config)
  const bindHost = options.host ?? webserverConfig?.host
  const sampled = resolveLanTrust(bindHost, options.trustedHost ?? [])
  // Preserve deployment authorities when invocation-derived LAN literals or
  // explicit extras become the runtime value read by the connection row.
  const composedTrusted = configuredTrustedHosts(connectionConfig)
  return {
    ...options.host !== undefined && { host: options.host },
    ...options.port !== undefined && { port: Number(options.port) },
    ...options.workspaceRoot !== undefined && { workspaceRoot: options.workspaceRoot },
    // mode and lanAddresses describe this invocation, never the deployment, so
    // they are resolved on every boot.
    mode: options.dev === true ? 'development' : 'production',
    trustedHosts: [...composedTrusted, ...sampled.trustedHosts],
    lanAddresses: sampled.lanAddresses,
  }
}

/**
 * Resolve the web flag family for rows waiting on `webStartup`.
 * @param ctx - plugin context carrying the command line and the Loader.
 * @returns nothing once the values are provided, or once `--help` requested exit.
 */
export function apply(ctx: Context): void {
  runStartup(ctx, WEB_STARTUP_SERVICE, webCommand(), planWebStartup)
}
