/** Node half: registers the /api and /f prefix routes over the api gateway and the session workspaces. */
import { EventEmitter } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { HttpServerService, WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { FILES_PATH } from '@deepseek-ai/dsh-host-apiproxy/api'
import { API_PATH, apply, inject } from '../src/index.ts'

/** Structural httpServer fake: the plugin only touches register(). */
function fakeHttpServer(routes: WebRoute[]): Pick<HttpServerService, 'register' | 'tapIndex' | 'port'> {
  return {
    register(route) {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
    tapIndex: () => () => {},
    port: 0,
  }
}

/** Bodyless GET carrying the given headers (enough for the trust fence + bridge). */
function fakeRequest(headers: Record<string, string>, url = `${API_PATH}/session.list`): IncomingMessage {
  const request = Readable.from([]) as unknown as IncomingMessage
  Object.assign(request, { url, method: 'GET', headers })
  return request
}

/** Response recorder compatible with both the fence's short-circuit and the bridge. */
function fakeResponse(): { response: ServerResponse; state: { status?: number; body?: unknown; headers?: Record<string, string> } } {
  const state: { status?: number; body?: unknown; headers?: Record<string, string> } = {}
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writeHead(value: number, headers?: Record<string, string>) {
      state.status = value
      if (headers !== undefined) state.headers = headers
      return this
    },
    write() { return true },
    end(this: { writableEnded: boolean }, value?: unknown) {
      if (value !== undefined) state.body = value
      this.writableEnded = true
      return this
    },
  }) as unknown as ServerResponse
  return { response, state }
}

/** The gateway stub: only the session-directory authority the /f route reads. */
function fakeApiProxy(workspaces: Record<string, string> = {}): ApiProxy {
  return { workspaceRootOf: async (id: string) => workspaces[id] } as unknown as ApiProxy
}

async function mounted(
  config?: { trustedHosts?: string[] },
  workspaces: Record<string, string> = {},
): Promise<{ routes: WebRoute[]; dispose: () => Promise<void> }> {
  const ctx = new Context()
  const routes: WebRoute[] = []
  ctx.provide('httpServer', fakeHttpServer(routes) as HttpServerService)
  ctx.provide('apiProxy', fakeApiProxy(workspaces))
  const fiber = ctx.plugin({ inject: [...inject], apply }, config)
  await fiber.await()
  return { routes, dispose: () => fiber.dispose() }
}

/** The /f route is registered after /api; both are prefix routes on the same server. */
function filesRoute(routes: WebRoute[]): WebRoute {
  const route = routes.find(candidate => candidate.path === FILES_PATH)
  if (route === undefined) throw new Error('the /f route was not registered')
  return route
}

describe('connection node half', () => {
  it('fails the load on a trustedHosts entry that is not a bare authority', async () => {
    const routes: WebRoute[] = []
    const ctx = new Context()
    ctx.provide('httpServer', fakeHttpServer(routes) as HttpServerService)
    ctx.provide('apiProxy', fakeApiProxy())
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.internal/path'] })
    await expect(fiber).rejects.toThrow(/not a bare host\[:port\] authority/)
    expect(routes).toHaveLength(0)
  })

  it('registers both transport prefix routes and removes them with the fiber', async () => {
    const { routes, dispose } = await mounted()
    expect(routes).toMatchObject([{ kind: 'prefix', path: API_PATH }, { kind: 'prefix', path: FILES_PATH }])
    await dispose()
    expect(routes).toHaveLength(0)
  })

  it('refuses an untrusted Host on any /api path before the bridge runs', async () => {
    const { routes, dispose } = await mounted()
    const { response, state } = fakeResponse()
    await routes[0]!.handler(fakeRequest({
      host: 'harness.example', origin: 'http://harness.example', 'sec-fetch-site': 'same-origin',
    }), response)
    expect(state.status).toBe(403)
    expect(state.body).toBe('forbidden')
    await dispose()
  })

  it('pins privileged methods to loopback even for a declared trusted authority', async () => {
    const { routes, dispose } = await mounted({ trustedHosts: ['harness.example'] })
    // The privileged set: native dialogs plus the whole settings/credential
    // configuration plane, reads included. The same declared authority reaches
    // ordinary reads (carrier-level 404 from the empty proxy proves the fence
    // passed), but each privileged method stays loopback-only and 403s.
    for (const method of [
      'host.pickDirectory', 'host.openPath',
      'settings.describe', 'settings.update', 'settings.replace', 'settings.mutate',
      'credentials.describe', 'credentials.set', 'credentials.unset',
    ]) {
      const denied = fakeResponse()
      await routes[0]!.handler(
        fakeRequest({ host: 'harness.example' }, `${API_PATH}/${method}`),
        denied.response,
      )
      expect(denied.state.status).toBe(403)
      expect(denied.state.body).toBe('forbidden')
    }
    const read = fakeResponse()
    await routes[0]!.handler(fakeRequest({ host: 'harness.example' }), read.response)
    expect(read.state.status).not.toBe(403)
    await dispose()
  })

  it('passes loopback and declared-authority requests through to the bridge', async () => {
    const { routes, dispose } = await mounted({ trustedHosts: ['harness.example:3080', '192.168.1.5'] })
    // Loopback, no browser markers (curl shape): the fence passes; the carrier
    // answers 404 for a GET unary path — proof the bridge ran.
    const loopback = fakeResponse()
    await routes[0]!.handler(fakeRequest({ host: '127.0.0.1:3080' }), loopback.response)
    expect(loopback.state.status).toBe(404)
    // LAN authority declared as a port-less IP literal — the shape the CLI
    // derives for `--host 0.0.0.0` — passes markerless curl on any port.
    const lan = fakeResponse()
    await routes[0]!.handler(fakeRequest({ host: '192.168.1.5:3080' }), lan.response)
    expect(lan.state.status).toBe(404)
    // Declared public authority, same-origin browser shape.
    const declared = fakeResponse()
    await routes[0]!.handler(fakeRequest({
      host: 'harness.example:3080', origin: 'http://harness.example:3080', 'sec-fetch-site': 'same-origin',
    }), declared.response)
    expect(declared.state.status).toBe(404)
    await dispose()
  })
})

describe('connection node half: the /f workspace-file route', () => {
  /** A workspace holding one file, torn down with the returned disposer. */
  async function workspace(): Promise<{ cwd: string; remove: () => Promise<void> }> {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-node-half-'))
    await writeFile(join(cwd, 'index.html'), '<h1>ok</h1>')
    return { cwd, remove: () => rm(cwd, { recursive: true, force: true }) }
  }

  /** HEAD keeps the assertion on the route's decision, not on the byte stream. */
  function head(url: string, headers: Record<string, string> = { host: '127.0.0.1:3080' }): IncomingMessage {
    const request = fakeRequest(headers, url)
    Object.assign(request, { method: 'HEAD' })
    return request
  }

  it('applies the same browser-trust fence as /api, and refuses writes', async () => {
    const { routes, dispose } = await mounted()
    const untrusted = fakeResponse()
    await filesRoute(routes).handler(head(`${FILES_PATH}/s-1/index.html`, { host: 'harness.example' }), untrusted.response)
    expect(untrusted.state.status).toBe(403)
    expect(untrusted.state.body).toBe('forbidden')

    const written = fakeResponse()
    const post = fakeRequest({ host: '127.0.0.1:3080' }, `${FILES_PATH}/s-1/index.html`)
    Object.assign(post, { method: 'POST' })
    await filesRoute(routes).handler(post, written.response)
    expect(written.state.status).toBe(405)
    expect(written.state.headers).toMatchObject({ allow: 'GET, HEAD' })
    await dispose()
  })

  it('confines reads to the directory the gateway names for that session', async () => {
    const { cwd, remove } = await workspace()
    const { routes, dispose } = await mounted(undefined, { 's-1': cwd })
    const served = fakeResponse()
    await filesRoute(routes).handler(head(`${FILES_PATH}/s-1/index.html`), served.response)
    expect(served.state.status).toBe(200)
    // A session the gateway names no directory for has no workspace to confine
    // against, so there is nothing to serve.
    const unknown = fakeResponse()
    await filesRoute(routes).handler(head(`${FILES_PATH}/s-absent/index.html`), unknown.response)
    expect(unknown.state.status).toBe(404)
    await dispose()
    await remove()
  })
})

describe('connection node half over a real HTTP server', () => {
  /** Serve the registered prefix route from a real server and return its port. */
  async function serve(routes: WebRoute[]): Promise<{ port: number; close: () => Promise<void> }> {
    const server = createServer((request, response) => {
      void routes[0]!.handler(request, response)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    return {
      port: address.port,
      close: () => new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined || error === null) resolve()
          else reject(error)
        })
      }),
    }
  }

  /** One real request; `host` spoofs the authority the way a LAN client's browser would send it. */
  function call(port: number, method: string, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        { host: '127.0.0.1', port, path: `${API_PATH}/${method}`, method: 'GET', headers: { host } },
        (response) => {
          response.resume()
          response.on('end', () => { resolve(response.statusCode ?? 0) })
        },
      )
      request.on('error', reject)
      request.end()
    })
  }

  it('answers a declared LAN authority with 403 on every configuration method, over real HTTP', async () => {
    // The fence's input is a real IncomingMessage parsed by Node from the
    // wire, not a hand-assembled object: the Host header a LAN browser sends
    // is exactly what decides loopback-only here, so the boundary is asserted
    // against the parse the server actually performs.
    const { routes, dispose } = await mounted({ trustedHosts: ['harness.example'] })
    const { port, close } = await serve(routes)
    try {
      // Reads are as privileged as writes: describe returns the exposed
      // configuration, and credentials.describe probes arbitrary env-var names.
      for (const method of [
        'settings.describe', 'settings.update', 'settings.replace', 'settings.mutate',
        'credentials.describe', 'credentials.set', 'credentials.unset',
        'host.pickDirectory', 'host.openPath',
      ]) {
        expect([method, await call(port, method, 'harness.example')]).toEqual([method, 403])
      }
      // The model catalog stays reachable for the same authority: a LAN
      // client's model picker needs it, and it carries no key or endpoint
      // state (404 is the empty proxy's carrier answer — the fence passed).
      for (const method of ['llm.providers', 'llm.models']) {
        expect([method, await call(port, method, 'harness.example')]).toEqual([method, 404])
      }
      // Loopback reaches everything, configuration included.
      expect(await call(port, 'settings.describe', `127.0.0.1:${String(port)}`)).toBe(404)
    } finally {
      await close()
      await dispose()
    }
  })
})
