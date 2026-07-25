/**
 * `dsh web` — thin bin over the config-tree boot: run AppCLIEntry with the
 * already-parsed host/port/dev, print the URL line, wire signals. All
 * composition lives in cordis.yml; all boot glue lives in AppCLIEntry. The
 * argument adapter validated host (loopback/all-interfaces) and port (0–65535).
 */

import { networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'
import { AppCLIEntry } from './app-cli-entry.ts'
import { ALL_INTERFACES_HOST, LOOPBACK_HOST } from './args.ts'

const CONFIG_PATH = fileURLToPath(new URL('../cordis.yml', import.meta.url))

/**
 * Serve the browser UI from the shipped config tree.
 * @param hostAddress - the bind host: {@link LOOPBACK_HOST} or {@link ALL_INTERFACES_HOST}.
 * @param port - the listen port; `0` lets the OS choose a free port.
 * @param dev - mount the client HMR driver and watch plugin bundles for rebuilds.
 */
export async function runWeb(hostAddress: string, port: number, dev: boolean): Promise<void> {
  const entry = new AppCLIEntry({ configPath: CONFIG_PATH, dev, host: hostAddress, port })
  const { ctx, port: boundPort } = await entry.run()

  let exiting = false
  const shutdown = (code: number): void => {
    if (exiting) return
    exiting = true
    void Promise.resolve(ctx.fiber.dispose()).finally(() => { process.exit(code) })
  }

  const lanCandidate = hostAddress === ALL_INTERFACES_HOST
    ? Object.values(networkInterfaces()).flat()
      .find(iface => iface !== undefined && iface.family === 'IPv4' && !iface.internal)
    : undefined
  const localUrl = `http://${LOOPBACK_HOST}:${boundPort}`
  console.log(`dsh web: ${localUrl}${lanCandidate === undefined ? '' : ` (LAN: http://${lanCandidate.address}:${boundPort})`}`)

  process.on('SIGTERM', () => { shutdown(0) })
  process.on('SIGINT', () => { shutdown(130) })
}
