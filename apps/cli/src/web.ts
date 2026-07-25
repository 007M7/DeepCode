/**
 * `dsh web` — thin bin over the config-tree boot: run AppCLIEntry with the
 * already-parsed host/port/dev, print the URL line, wire signals. All
 * composition lives in cordis.yml; all boot glue lives in AppCLIEntry. Host and
 * port are unvalidated pass-through overrides — the `dsh-host-webserver` schema
 * gates them at boot.
 */

import { networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'
import { AppCLIEntry } from './app-cli-entry.ts'

const CONFIG_PATH = fileURLToPath(new URL('../cordis.yml', import.meta.url))

// Display-only mirrors of the webserver schema's allowed hosts: the loopback
// address the local URL always prints, and the all-interfaces value that gates
// LAN-address discovery. Not a source of truth — the schema is.
const LOOPBACK_HOST = '127.0.0.1'
const ALL_INTERFACES_HOST = '0.0.0.0'

/**
 * Serve the browser UI from the shipped config tree. `host`/`port` are passed
 * through only when the flag was given; absent, the `cordis.yml` value stands.
 * @param host - the bind host, or `undefined` to keep the config default.
 * @param port - the listen port (`0` requests an OS-assigned port), or `undefined` to keep the config default.
 * @param dev - mount the client HMR driver and watch plugin bundles for rebuilds.
 * @param workspaceRoot - parent directory for name-created workspaces, or `undefined` for the gateway's cwd fallback.
 */
export async function runWeb(
  host: string | undefined,
  port: number | undefined,
  dev: boolean,
  workspaceRoot: string | undefined,
): Promise<void> {
  const entry = new AppCLIEntry({
    configPath: CONFIG_PATH,
    dev,
    ...host !== undefined && { host },
    ...port !== undefined && { port },
    ...workspaceRoot !== undefined && { workspaceRoot },
  })
  const { ctx, port: boundPort } = await entry.run()

  let exiting = false
  const shutdown = (code: number): void => {
    if (exiting) return
    exiting = true
    void Promise.resolve(ctx.fiber.dispose()).finally(() => { process.exit(code) })
  }

  const lanCandidate = host === ALL_INTERFACES_HOST
    ? Object.values(networkInterfaces()).flat()
      .find(iface => iface !== undefined && iface.family === 'IPv4' && !iface.internal)
    : undefined
  const localUrl = `http://${LOOPBACK_HOST}:${boundPort}`
  console.log(`dsh web: ${localUrl}${lanCandidate === undefined ? '' : ` (LAN: http://${lanCandidate.address}:${boundPort})`}`)

  process.on('SIGTERM', () => { shutdown(0) })
  process.on('SIGINT', () => { shutdown(130) })
}
