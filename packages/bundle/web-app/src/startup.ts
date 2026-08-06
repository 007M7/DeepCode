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
import type { EntryOptions } from '@cordisjs/plugin-loader'
import { overrideConfig, runStartup, type RowChange } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'web-startup'

/** Services required before the flags can be resolved. */
export const inject = ['cmdlineArgs']

/**
 * The startup service every flag-configured web row injects. The rows are
 * listed in this bundle's `cordis.patch.yml`; a row this startup plans changes
 * for without injecting the service fails loud.
 */
export const WEB_STARTUP_SERVICE = 'webStartup'

/** The webserver schema's all-interfaces bind literal: only this bind derives LAN authorities. */
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
 * Turn the parsed flags into the changes each waiting row needs.
 * @param program - the parsed web command.
 * @param rows - the waiting rows' composed options, in tree order.
 * @returns row id → changes; rows absent from the map start on their composed values.
 */
function planWebStartup(program: Command, rows: readonly EntryOptions[]): Map<string, RowChange> {
  const options = program.opts<WebOptions>()
  if (options.port !== undefined && !/^\d+$/.test(options.port)) {
    program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`)
  }
  const row = (id: string): EntryOptions => {
    const found = rows.find(candidate => candidate.id === id)
    if (found === undefined) throw new Error(`web-startup: the web composition has no waiting "${id}" row to configure`)
    return found
  }
  const plan = new Map<string, RowChange>()
  const webserver = row('webserver')
  const composedHost = (webserver.config as { host?: string } | undefined)?.host
  plan.set('webserver', overrideConfig(webserver, {
    ...options.host !== undefined && { host: options.host },
    ...options.port !== undefined && { port: Number(options.port) },
  }))
  if (options.workspaceRoot !== undefined) {
    plan.set('api-gateway', overrideConfig(row('api-gateway'), { workspaceRoot: options.workspaceRoot }))
  }
  const { lanAddresses, trustedHosts } = resolveLanTrust(options.host ?? composedHost, options.trustedHost ?? [])
  if (trustedHosts.length > 0) {
    // Additive over the composed value: a cordis.patch.yml-configured fence
    // authority must survive the derived LAN literals and the flag extras —
    // dropping it silently would weaken security-relevant configuration.
    const connection = row('connection')
    const composedTrusted = (connection.config as { trustedHosts?: string[] } | undefined)?.trustedHosts ?? []
    plan.set('connection', overrideConfig(connection, { trustedHosts: [...composedTrusted, ...trustedHosts] }))
  }
  // mode and lanAddresses are resolved on every boot, never pass-throughs of
  // composed values: they describe this invocation, not the deployment.
  plan.set('web-runtime', overrideConfig(row('web-runtime'), {
    mode: options.dev === true ? 'development' : 'production',
    lanAddresses,
  }))
  // The receiver ships disabled so `--dev` is a row toggle rather than a
  // runtime insert (the Loader cannot resolve a row inserted from inside a
  // mounting plugin).
  if (options.dev === true) plan.set('client-hmr', { disabled: false })
  return plan
}

/**
 * Resolve the web flag family and start the rows waiting for it.
 * @param ctx - plugin context carrying the command line and the Loader.
 * @returns nothing once the waiting rows are released, or once `--help` requested exit.
 */
export function apply(ctx: Context): Promise<void> {
  return runStartup(ctx, WEB_STARTUP_SERVICE, webCommand(), planWebStartup)
}
