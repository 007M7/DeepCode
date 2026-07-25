/**
 * HMR plugin, node half: the host end of the dev reload chain. Stat-polls
 * every graph row's client bundle (fs.watchFile — polling by design: network
 * mounts deliver no inotify events), reports content changes through
 * `clientModuleHost.rebuilt(id)`, and serves the `/plugins/events` SSE channel
 * broadcasting graph/rebuilt frames to the browser half (src/client/).
 * Dev-only row: prod compositions never mount this plugin.
 */
import type { Stats } from 'node:fs'
import { unwatchFile, watchFile } from 'node:fs'
import type { ServerResponse } from 'node:http'
import type { Context } from 'cordis'
import z from 'schemastery'
// Empty type imports carry the clientModuleHost/httpServer Context merges.
import type {} from '@deepseek-ai/dsh-client-modules'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { PluginsEventFrame } from './events.ts'
import { EVENTS_ENDPOINT } from './events.ts'

export type { PluginsEventFrame } from './events.ts'
export { EVENTS_ENDPOINT } from './events.ts'

/** Cordis plugin name. */
export const name = 'client-hmr'

/** Required services: the web plugin table and the route registry. */
export const inject = ['clientModuleHost', 'httpServer']

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Bundle stat-poll interval in milliseconds (default 500, the build-side watcher's polling default). */
  pollIntervalMs?: number
}

export const Config: z<Config> = z.object({
  pollIntervalMs: z.number().step(1).min(1).default(500),
})

/** Serialize one frame as an SSE data line. */
function sseData(frame: PluginsEventFrame): string {
  return `data: ${JSON.stringify(frame)}\n\n`
}

/**
 * Mount the dev chain: bundle watches, rebuilt reporting, and the SSE channel.
 * @param ctx - host plugin context carrying clientModuleHost and httpServer.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery's .default() guarantees the field is set after validation.
  const pollIntervalMs = config.pollIntervalMs as number

  // --- bundle watch: one fs.watchFile stat poll per graph row -------------
  const watched = new Map<string, { path: string; listener: (curr: Stats, prev: Stats) => void }>()

  const watchRow = (id: string, path: string): void => {
    const listener = (curr: Stats, prev: Stats): void => {
      // fs.watchFile fires on any stat delta (atime included); only content
      // signals count. An all-zero curr means the file vanished mid-rebuild
      // — the completing write fires the next tick, so skipping is safe.
      if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return
      if (curr.mtimeMs === 0) return
      try {
        // rebuilt() re-hashes; an unchanged hash stays silent (clientModuleHost
        // fires onRebuilt only on a real rev change). A torn read of a
        // half-written bundle self-heals on the next poll tick.
        ctx.clientModuleHost.rebuilt(id)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') return // mid-rename window; the completed write fires the next poll tick
        ctx.logger.warn(error)
      }
    }
    watchFile(path, { interval: pollIntervalMs, persistent: false }, listener)
    watched.set(id, { path, listener })
  }

  // Diff the watch set against the current graph: drop watches for removed
  // rows (or rows whose bundle path moved), add watches for new rows.
  const syncWatches = (): void => {
    const rows = new Map<string, string>()
    for (const row of ctx.clientModuleHost.graph().entries) {
      const path = ctx.clientModuleHost.clientPath(row.id)
      if (path !== undefined) rows.set(row.id, path)
    }
    for (const [id, watch] of watched) {
      if (rows.get(id) === watch.path) continue
      unwatchFile(watch.path, watch.listener)
      watched.delete(id)
    }
    for (const [id, path] of rows) {
      if (!watched.has(id)) watchRow(id, path)
    }
  }

  ctx.effect(() => {
    // Initial sync covers rows already in the graph; the subscription covers
    // rows arriving later (boot-window activations, including this plugin's
    // own row — no self-exemption, a modules/hmr rebuild rides the same chain).
    syncWatches()
    const unsubscribe = ctx.clientModuleHost.onGraphChanged(syncWatches)
    return () => {
      unsubscribe()
      for (const { path, listener } of watched.values()) unwatchFile(path, listener)
      watched.clear()
    }
  }, 'client-hmr: bundle watches')

  // --- /plugins/events SSE channel ----------------------------------------
  const connections = new Set<ServerResponse>()

  const connect = (res: ServerResponse): void => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    })
    // Comment line on open so clients/proxies see a live channel even when
    // no rebuild ever happens; EventSource frame parsing skips it naturally.
    res.write(': connected\n\n')
    res.write(sseData({ type: 'graph', graph: ctx.clientModuleHost.graph() }))
    connections.add(res)
    res.on('close', () => { connections.delete(res) })
  }

  ctx.effect(() => {
    const disposeRoute = ctx.httpServer.register({
      kind: 'exact',
      path: EVENTS_ENDPOINT,
      handler: (req, res) => {
        // Named routes match ahead of the carrier's method gate; keep the old
        // global 405 semantics for non-GET hits on this endpoint.
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405)
          res.end()
          return
        }
        connect(res)
      },
    })
    const unsubscribe = ctx.clientModuleHost.onRebuilt((id, rev) => {
      const line = sseData({ type: 'rebuilt', id, rev })
      for (const res of connections) res.write(line)
    })
    return () => {
      unsubscribe()
      disposeRoute()
      for (const res of connections) res.destroy()
      connections.clear()
    }
  }, 'client-hmr: /plugins/events channel')
}
