/**
 * @deepseek-ai/dsh-host-webserver — plain HTTP route-registration plugin: a
 * node:http server plus the `httpServer` service (named-route registry + index
 * transform taps + static dist fallback). Knows no harness concepts — every
 * feature surface (API bridge, plugin bundles, SSE) is a route some other
 * plugin registers. Web (browser) shape only — Electron loads dist over
 * file:// and carries fetch over an IPC bridge, not this server. This package
 * never prints: the URL line belongs to the shell.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse, Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { dirname } from 'node:path'
import { Context, Service } from 'cordis'
import z from 'schemastery'
import { serveStatic } from './static.ts'

declare module 'cordis' {
  interface Context {
    httpServer: HttpServerService
  }
}

/** Route match kind: 'exact' matches the pathname verbatim; 'prefix' p matches p and p/<anything>. */
export type WebRouteKind = 'exact' | 'prefix'

/** One named route registration. */
export interface WebRoute {
  kind: WebRouteKind
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns the full response lifecycle (may hold the response open, e.g. SSE). */
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** Gateway config: listen address plus the static dist anchor (injected by the composing app, never self-resolved). */
export interface Config {
  /** Listen host; the two supported values are loopback and all-interfaces. */
  host: '127.0.0.1' | '0.0.0.0'
  /** Listen port; zero requests an OS-assigned port. */
  port: number
  /** Absolute path of index.html inside the static root (dist location is workspace knowledge of the app). */
  distIndex: string
}

/**
 * The web-shape HTTP carrier service. Activation listens immediately (route
 * registration order carries no request-facing semantics: named routes are
 * composed to be disjoint, and the static dist fallback answers anything not
 * yet claimed during the boot window). A listen failure throws out of init —
 * a FAILED fiber the boot's fail-loud sweep reports.
 */
export class HttpServerService extends Service {
  static Config: z<Config> = z.object({
    host: z.union([z.const('127.0.0.1'), z.const('0.0.0.0')]).required(),
    port: z.natural().max(65535).required(),
    distIndex: z.string().required(),
  })

  private readonly exact = new Map<string, WebRoute>()
  private readonly prefixes = new Map<string, WebRoute>()
  private readonly indexTaps: ((html: string) => string)[] = []
  private readonly distRoot: string
  private readonly distIndex: string
  private server!: Server
  private listenedPort!: number

  constructor(ctx: Context, private config: Config) {
    super(ctx, 'httpServer')
    this.distIndex = config.distIndex
    this.distRoot = dirname(config.distIndex)
  }

  /** The listening port (the OS-assigned value when config.port is 0). */
  get port(): number {
    return this.listenedPort
  }

  /**
   * Register a named route. Duplicate (kind, path) throws — route patterns are
   * a composition-level contract, so a collision is a misconfiguration.
   * @param route - kind, path, and the owning handler.
   * @returns the disposer removing the route.
   */
  register(route: WebRoute): () => void {
    const table = route.kind === 'exact' ? this.exact : this.prefixes
    if (table.has(route.path)) {
      throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
    }
    table.set(route.path, route)
    return () => { table.delete(route.path) }
  }

  /**
   * Register an index.html transform, applied to every index response in
   * registration order.
   * @param transform - pure html-to-html function.
   * @returns the disposer removing the transform.
   */
  tapIndex(transform: (html: string) => string): () => void {
    this.indexTaps.push(transform)
    return () => {
      const at = this.indexTaps.indexOf(transform)
      if (at !== -1) this.indexTaps.splice(at, 1)
    }
  }

  /** Listen; resolves once the socket is bound (rejection = FAILED fiber). */
  async [Service.init](): Promise<void> {
    const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      /* v8 ignore next -- `?? '/'` arm: node:http always sets url on server
      requests; the field is only optional on the client-side IncomingMessage type */
      const rawPath = new URL(req.url ?? '/', 'http://x').pathname
      const route = this.match(rawPath)
      if (route !== undefined) {
        await route.handler(req, res)
        return
      }
      // Static fallback keeps the pre-plugin semantics: non-GET/HEAD is 405,
      // traversal 403, miss falls back to index.html 200 (SPA routing).
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405)
        res.end()
        return
      }
      await serveStatic(decodeURIComponent(rawPath), res, this.distRoot, this.distIndex, () => this.renderIndex())
    }
    // Last-resort guard: handle() rejecting would otherwise be an unhandled
    // rejection killing the process on one malformed request (bad %-escape,
    // client dropping mid-body). Per-request failures log and answer 400 —
    // never a process exit.
    this.server = createServer((req, res) => {
      handle(req, res).catch((err: unknown) => {
        this.ctx.logger.warn(err instanceof Error ? err : new Error(String(err)))
        if (res.headersSent) {
          res.destroy()
          return
        }
        res.writeHead(400)
        res.end()
      })
    })

    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.off('error', reject)
        this.server.on('error', (err) => { this.ctx.logger.error(err) })
        this.listenedPort = (this.server.address() as AddressInfo).port
        resolve()
      })
    })

    // close + closeAllConnections: held-open responses (SSE) never end on
    // their own; without the force-close, close() would hang teardown.
    this.ctx.effect(() => () => new Promise<void>((resolve) => {
      this.server.close(() => { resolve() })
      this.server.closeAllConnections()
    }), 'httpServer.listen')
  }

  /** Longest-prefix-wins over the prefix table after an exact-table miss. */
  private match(pathname: string): WebRoute | undefined {
    const exact = this.exact.get(pathname)
    if (exact !== undefined) return exact
    let best: WebRoute | undefined
    for (const [prefix, route] of this.prefixes) {
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
      if (best === undefined || prefix.length > best.path.length) best = route
    }
    return best
  }

  /** Index body: dist index.html through the registered taps in order. */
  private async renderIndex(): Promise<string> {
    let html = await readFile(this.distIndex, 'utf8')
    for (const transform of this.indexTaps) html = transform(html)
    return html
  }
}

export default HttpServerService
