/**
 * `dsh web` — thin bin over the config-tree boot: parse argv, run
 * AppCLIEntry, print the URL line, wire signals. All composition lives in
 * cordis.yml; all boot glue lives in AppCLIEntry.
 */

import { parseArgs } from 'node:util'
import { networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'
import { AppCLIEntry } from './app-cli-entry.ts'

const LOOPBACK_HOST = '127.0.0.1'
const ALL_INTERFACES_HOST = '0.0.0.0'

const CONFIG_PATH = fileURLToPath(new URL('../cordis.yml', import.meta.url))

export async function runWeb(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      host: { type: 'string' },
      port: { type: 'string' },
      dev: { type: 'boolean', default: false },
      'workspace-root': { type: 'string' },
    },
    allowPositionals: false,
  })
  if (values.host !== undefined && values.host !== LOOPBACK_HOST && values.host !== ALL_INTERFACES_HOST) {
    process.stderr.write(
      `dsh web: invalid --host ${values.host}; expected ${LOOPBACK_HOST} or ${ALL_INTERFACES_HOST}\n`,
    )
    process.exit(1)
  }
  let port: number | undefined
  if (values.port !== undefined) {
    port = Number(values.port)
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      process.stderr.write(`dsh web: invalid --port ${values.port}\n`)
      process.exit(1)
    }
  }

  const entry = new AppCLIEntry({
    configPath: CONFIG_PATH,
    dev: values.dev,
    ...values.host !== undefined ? { host: values.host } : {},
    ...port !== undefined ? { port } : {},
    ...values['workspace-root'] !== undefined ? { workspaceRoot: values['workspace-root'] } : {},
  })
  const { ctx, port: boundPort } = await entry.run()

  let exiting = false
  const shutdown = (code: number): void => {
    if (exiting) return
    exiting = true
    void Promise.resolve(ctx.fiber.dispose()).finally(() => { process.exit(code) })
  }

  const lanCandidate = values.host === ALL_INTERFACES_HOST
    ? Object.values(networkInterfaces()).flat()
      .find(iface => iface !== undefined && iface.family === 'IPv4' && !iface.internal)
    : undefined
  const localUrl = `http://${LOOPBACK_HOST}:${boundPort}`
  console.log(`dsh web: ${localUrl}${lanCandidate === undefined ? '' : ` (LAN: http://${lanCandidate.address}:${boundPort})`}`)

  process.on('SIGTERM', () => { shutdown(0) })
  process.on('SIGINT', () => { shutdown(130) })
}
