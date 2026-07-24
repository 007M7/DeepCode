/**
 * @deepseek-ai/dsh-host-webserver — the web-shape HTTP carrier: node:http server
 * routing /api/* to an injected fetch-shaped handler (node:http ↔ WHATWG
 * bridge with SSE streamed out chunk by chunk) and everything else to static
 * file serving. Web (browser) shape only — Electron loads dist over file://
 * and carries fetch over an IPC bridge, not this server. This package never
 * prints: the URL line belongs to the shell.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { dirname } from 'node:path'
import { serveStatic } from './static.ts'
import { createPluginEventChannel } from './plugin-events.ts'
import type { HostWebPluginRegistry, WebBootGraph } from './web-plugins.ts'

export { createHostWebPluginRegistry } from './web-plugins.ts'
export type {
  HostWebPluginRegistry, LoaderEntryView, LoaderView, WebBootEntry, WebBootGraph, WebPluginRegistryDeps,
} from './web-plugins.ts'
export type { PluginEventChannel, PluginEventFrame } from './plugin-events.ts'

/** Options for startWebServer. */
export interface WebServerOptions {
  /** Address or hostname to listen on. */
  host: string
  /** Port to listen on; zero requests an OS-assigned port. */
  port: number
  /**
   * Absolute path of index.html inside the static root — the caller resolves
   * it (dist location is workspace knowledge of the shell, not this package's).
   */
  distIndex: string
  /** Fetch-shaped API carrier; /api/*-prefixed requests are bridged to it. */
  apiHandler: { fetch: typeof fetch }
  /**
   * Web plugin table. When present, every index.html response carries the
   * `window.__DSH_BOOT__` entry graph script, `/plugins/<id>/client.js` serves
   * each fetch entry's client bundle, and `GET /plugins/events` streams graph/
   * rebuilt frames (SSE) — rebuilt frames ride the registry's own bundle-watch
   * notifications (`onRebuilt`). Absent = all three surfaces off (carrier-only
   * use).
   */
  webPlugins?: Pick<HostWebPluginRegistry, 'graph' | 'clientPath' | 'onRebuilt'>
}

/** Listening web server handle. */
export interface RunningWebServer {
  /** The listening port, including the OS-assigned value when options.port is zero. */
  port: number
  /**
   * Shutdown: close + closeAllConnections (SSE connections never end on their
   * own; without the force-close, close() would hang). Idempotent.
   */
  close(): Promise<void>
}

/**
 * Start the web-shape HTTP server on the caller-selected host and port.
 * Routing: /api/* → apiHandler bridge; non-GET/HEAD → 405; everything else →
 * static with the step1-locked semantics (403 traversal, SPA fallback 200).
 * A listen failure (EADDRINUSE…) rejects — the shell decides how to exit; a
 * server error after listen goes to onError. A request whose handling throws
 * (malformed %-escapes, a client dropping mid-body) is answered 400 — or the
 * socket destroyed when headers are already out — and reported to onError;
 * it never becomes an unhandled rejection.
 * @param options - port, static root anchor, and the API carrier.
 * @param onError - sink for post-listen server errors and per-request handling failures.
 * @returns the running server handle once listening.
 */
export function startWebServer(options: WebServerOptions, onError: (err: Error) => void): Promise<RunningWebServer> {
  const { host, port, distIndex, apiHandler, webPlugins } = options
  const distRoot = dirname(distIndex)
  const renderIndex = webPlugins === undefined ? undefined : async (): Promise<string> => {
    const html = await readFile(distIndex, 'utf8')
    return injectBootManifest(html, webPlugins.graph())
  }
  const pluginEvents = webPlugins === undefined ? undefined : createPluginEventChannel()
  // Rebuilt frames come from the registry's own bundle watch (dev mode); a
  // prod registry without watching simply never notifies.
  const unsubscribeRebuilt = webPlugins !== undefined && pluginEvents !== undefined
    ? webPlugins.onRebuilt((id, rev) => { pluginEvents.broadcast({ type: 'rebuilt', id, rev }) })
    : undefined

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    /* v8 ignore next -- `?? '/'` arm: node:http always sets url on server
    requests; the field is only optional on the client-side IncomingMessage type */
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    if (rawPath.startsWith('/api/')) {
      await bridge(req, res, apiHandler)
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    if (webPlugins !== undefined && pluginEvents !== undefined && rawPath === '/plugins/events') {
      pluginEvents.connect(res, webPlugins.graph())
      return
    }
    if (webPlugins !== undefined && rawPath.startsWith('/plugins/') && rawPath.endsWith('/client.js')) {
      await servePluginBundle(decodeURIComponent(rawPath), res, webPlugins)
      return
    }
    await serveStatic(decodeURIComponent(rawPath), res, distRoot, distIndex, renderIndex)
  }
  // Last-resort guard: handle() rejecting would otherwise be an unhandled
  // rejection, and one malformed request (a bad %-escape hitting
  // decodeURIComponent, a client dropping mid-body) would kill the whole
  // process. Nothing after this catch can throw again on the same response.
  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      onError(err instanceof Error ? err : new Error(String(err)))
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.writeHead(400)
      res.end()
    })
  })

  let closing: Promise<void> | undefined
  const close = (): Promise<void> => (closing ??= new Promise((resolveClose) => {
    unsubscribeRebuilt?.()
    server.close(() => { resolveClose() })
    server.closeAllConnections()
  }))

  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, host, () => {
      server.off('error', rejectListen)
      server.on('error', onError)
      resolveListen({ port: (server.address() as AddressInfo).port, close })
    })
  })
}

/**
 * Inject the boot entry graph into index.html: `window.__DSH_BOOT__` as the
 * first script in <head> (before the shell bundle reads it). `<` is escaped in
 * the JSON so plugin-controlled strings cannot break out of the script element.
 * @param html - the index.html source.
 * @param graph - the composed entry graph from the registry.
 * @returns the html with the graph script injected.
 */
export function injectBootManifest(html: string, graph: WebBootGraph): string {
  const json = JSON.stringify(graph).replaceAll('<', '\\u003c')
  const script = `<script>window.__DSH_BOOT__ = ${json}</script>`
  const head = html.indexOf('<head>')
  if (head !== -1) return `${html.slice(0, head + 6)}${script}${html.slice(head + 6)}`
  // Headless fixture pages may lack <head>; prepending keeps the read-before-shell ordering.
  return `${script}${html}`
}

/**
 * Serve one plugin client bundle from the registry table (unknown id = 404;
 * the id may contain a scope slash). The `?rev=` query is a cache-busting
 * parameter only — serving ignores it; `no-cache` makes the browser revalidate
 * so a stale rev never sticks.
 */
async function servePluginBundle(
  pathname: string, res: ServerResponse, webPlugins: Pick<HostWebPluginRegistry, 'clientPath'>,
): Promise<void> {
  const id = pathname.slice('/plugins/'.length, -'/client.js'.length)
  const path = webPlugins.clientPath(id)
  if (path === undefined) {
    res.writeHead(404)
    res.end()
    return
  }
  try {
    const body = await readFile(path)
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' })
    res.end(body)
  } catch {
    // Registered but unreadable (bundle not built yet): loud 404 beats a silent SPA-fallback HTML page.
    res.writeHead(404)
    res.end()
  }
}

/** Bridge one node:http request to the WHATWG fetch handler (client close aborts; SSE bodies stream out chunk by chunk). */
async function bridge(req: IncomingMessage, res: ServerResponse, apiHandler: { fetch: typeof fetch }): Promise<void> {
  const abort = new AbortController()
  // Client-disconnect detection MUST hang off the response, not the request:
  // since Node 16, IncomingMessage 'close' fires as soon as the request body is
  // fully consumed (immediately for a bodyless GET), which would abort every SSE
  // stream right after open. ServerResponse 'close' fires on connection teardown;
  // writableEnded distinguishes a normal end() from the client going away.
  res.on('close', () => {
    if (!res.writableEnded) abort.abort()
  })
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  /* v8 ignore next 3 -- `??` arms: node:http always sets url/method on server
  requests; the fields are only optional on the client-side IncomingMessage type */
  const request = new Request(new URL(req.url ?? '/', 'http://dsh.internal'), {
    method: req.method ?? 'GET',
    headers: Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === 'string') as [string, string][]),
    ...chunks.length > 0 ? { body: Buffer.concat(chunks) } : {},
    signal: abort.signal,
  })
  const response = await apiHandler.fetch(request)
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
  if (response.body === null) {
    res.end()
    return
  }
  for await (const chunk of response.body) {
    // Backpressure: a false return means the socket buffer is full — wait for drain
    // instead of buffering unboundedly (slow/suspended SSE consumers). 'close' also
    // resolves so a mid-wait disconnect can't park this loop forever; the close
    // handler above aborts the handler stream, which then ends the iteration.
    if (!res.write(chunk)) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          res.off('drain', done)
          res.off('close', done)
          resolve()
        }
        res.once('drain', done)
        res.once('close', done)
      })
    }
  }
  res.end()
}
