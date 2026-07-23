/**
 * `dsh web` — the web-shape assembly: startHost + dist resolution +
 * startWebServer + the URL line + signal wiring. Mixing host and carrier
 * concerns is this app module's job (packages stay single-sided).
 */

import { parseArgs } from 'node:util'
import { networkInterfaces } from 'node:os'
import { createRequire } from 'node:module'
import { mountWebPlugins, startHost } from '@deepseek-ai/dsh-host-runtime'
import { createHostWebPluginRegistry, startWebServer } from '@deepseek-ai/dsh-host-webserver'

const LOOPBACK_HOST = '127.0.0.1'
const ALL_INTERFACES_HOST = '0.0.0.0'

export async function runWeb(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      host: { type: 'string', default: LOOPBACK_HOST },
      port: { type: 'string', default: '3080' },
    },
    allowPositionals: false,
  })
  if (values.host !== LOOPBACK_HOST && values.host !== ALL_INTERFACES_HOST) {
    process.stderr.write(
      `dsh web: invalid --host ${values.host}; expected ${LOOPBACK_HOST} or ${ALL_INTERFACES_HOST}\n`,
    )
    process.exit(1)
  }
  const hostAddress = values.host
  const port = Number(values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`dsh web: invalid --port ${values.port}\n`)
    process.exit(1)
  }

  // A missing DEEPSEEK_API_KEY throws here (plugin load is fail-loud, uncaught by design).
  const host = await startHost({
    boot: {
      persistenceRoot: './.sessions',
      workspaceContext: { maxBytes: 65_536 },
    },
  })

  // Web UI plugin chain: in-memory Loader tree over the eight UI packages,
  // then the registry that feeds __DSH_BOOT__ and /plugins/<id>/client.js.
  const mounted = await mountWebPlugins(host.ctx)
  const webPlugins = createHostWebPluginRegistry({
    ctx: host.ctx,
    loader: mounted.loader,
    resolvePkgJson: mounted.resolvePkgJson,
    onError: (err: Error) => { process.stderr.write(`dsh web: plugin rescan: ${String(err)}\n`) },
  })
  // Published so the webserver invariant companion can audit manifest/bundle
  // consistency; nothing else reads this key.
  host.ctx.reflect.provide('webPlugins', webPlugins)

  // Dist location is workspace knowledge of this app: resolved through
  // @deepseek-ai/dsh-frontend's package exports, not configured.
  const require = createRequire(import.meta.url)
  let distIndex: string
  try {
    distIndex = require.resolve('@deepseek-ai/dsh-frontend/dist/index.html')
  } catch {
    process.stderr.write('dsh web: frontend dist not built; run pnpm --filter @deepseek-ai/dsh-frontend build first\n')
    await host.dispose()
    process.exit(1)
  }

  let exiting = false
  async function shutdown(code: number): Promise<void> {
    if (exiting) return
    exiting = true
    try {
      await server.close()
      await host.dispose()
    } finally {
      process.exit(code)
    }
  }

  let server: Awaited<ReturnType<typeof startWebServer>>
  try {
    server = await startWebServer(
      { host: hostAddress, port, distIndex, apiHandler: host.handler, webPlugins },
      (err: Error) => {
        process.stderr.write(`dsh web: ${String(err)}\n`)
        void shutdown(1)
      },
    )
  } catch (error: unknown) {
    // listen failed (EADDRINUSE…): no server to close, dispose the host directly.
    process.stderr.write(`dsh web: ${String(error)}\n`)
    await host.dispose()
    process.exit(1)
  }

  const lan = hostAddress === ALL_INTERFACES_HOST
    ? Object.values(networkInterfaces()).flat()
      .find(iface => iface !== undefined && iface.family === 'IPv4' && !iface.internal)
    : undefined
  const localUrl = `http://${LOOPBACK_HOST}:${server.port}`
  console.log(`dsh web: ${localUrl}${lan === undefined ? '' : ` (LAN: http://${lan.address}:${server.port})`}`)

  process.on('SIGTERM', () => { void shutdown(0) })
  process.on('SIGINT', () => { void shutdown(130) })
}
