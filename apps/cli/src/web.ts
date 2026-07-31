/**
 * `dsh web` — thin bin over the config-tree boot: run AppCLIEntry with the
 * already-parsed host/port/dev, print the URL line, wire signals. All
 * composition lives in the shared base plus Web overlay; all boot glue lives in AppCLIEntry. Host and
 * port are unvalidated pass-through overrides — the `dsh-host-webserver` schema
 * gates them at boot.
 */

import { fileURLToPath } from 'node:url'
import { resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { AppCLIEntry } from './app-cli-entry.ts'

// The shared core every `dsh` surface mounts, plus this surface's overlay over it.
const BASE_CONFIG = fileURLToPath(new URL('../config/base.cordis.yml', import.meta.url))
const WEB_OVERLAY = fileURLToPath(new URL('../config/web.cordis.yml', import.meta.url))

// Display-only mirror of the webserver schema's loopback host: the address the
// local URL always prints. Not a source of truth — the schema is.
const LOOPBACK_HOST = '127.0.0.1'

/**
 * Serve the browser UI from the shipped config tree. `host`/`port` are passed
 * through only when the flag was given; absent, the shipped Web overlay value stands.
 * @param host - the bind host, or `undefined` to keep the config default.
 * @param port - the listen port (`0` requests an OS-assigned port), or `undefined` to keep the config default.
 * @param dev - mount the client HMR driver and watch plugin bundles for rebuilds.
 * @param workspaceRoot - parent directory for name-created workspaces, or `undefined` for the gateway's cwd fallback.
 * @param trustedHosts - extra authorities for the /api browser-trust fence, or `undefined` for the derived LAN literals alone.
 * @param config - an overlay of loader patches applied over the shipped web
 * composition instead of `$DSH_HOME/config.yaml`, or `undefined` to use the
 * personal overlay; already parsed from `--config`.
 */
export async function runWeb(
  host: string | undefined,
  port: number | undefined,
  dev: boolean,
  workspaceRoot: string | undefined,
  trustedHosts: string[] | undefined,
  config?: string,
): Promise<void> {
  const entry = new AppCLIEntry({
    configPath: BASE_CONFIG,
    overlayPath: WEB_OVERLAY,
    ...config !== undefined && { extraOverlayPath: resolveConfigPath(config, undefined) },
    dev,
    ...host !== undefined && { host },
    ...port !== undefined && { port },
    ...workspaceRoot !== undefined && { workspaceRoot },
    ...trustedHosts !== undefined && { trustedHosts },
  })
  const { ctx, port: boundPort } = await entry.run()

  let exiting = false
  const shutdown = (code: number): void => {
    if (exiting) return
    exiting = true
    void Promise.resolve(ctx.fiber.dispose()).finally(() => { process.exit(code) })
  }

  // Install shutdown handling before publishing readiness: supervisors may
  // send a signal as soon as they observe the URL line.
  process.on('SIGTERM', () => { shutdown(0) })
  process.on('SIGINT', () => { shutdown(130) })

  // The entry's boot-time snapshot, not a fresh sample: the printed LAN URL
  // must name an address the /api trust fence was configured with.
  const lanCandidate = entry.lanAddresses[0]
  const localUrl = `http://${LOOPBACK_HOST}:${boundPort}`
  console.log(`dsh web: ${localUrl}${lanCandidate === undefined ? '' : ` (LAN: http://${lanCandidate}:${boundPort})`}`)
}
