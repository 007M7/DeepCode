/** Node half: registers the /api prefix route bridging to the api gateway. */
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { HttpServerService, WebRoute } from '@deepseek-ai/dsh-host-webserver'
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
function fakeRequest(headers: Record<string, string>): IncomingMessage {
  const request = Readable.from([]) as unknown as IncomingMessage
  Object.assign(request, { url: `${API_PATH}/session.list`, method: 'GET', headers })
  return request
}

/** Response recorder compatible with both the fence's short-circuit and the bridge. */
function fakeResponse(): { response: ServerResponse; state: { status?: number; body?: unknown } } {
  const state: { status?: number; body?: unknown } = {}
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writeHead(value: number) { state.status = value; return this },
    write() { return true },
    end(this: { writableEnded: boolean }, value?: unknown) {
      if (value !== undefined) state.body = value
      this.writableEnded = true
      return this
    },
  }) as unknown as ServerResponse
  return { response, state }
}

async function mounted(config?: { trustedHosts?: string[] }): Promise<{ routes: WebRoute[]; dispose: () => Promise<void> }> {
  const ctx = new Context()
  const routes: WebRoute[] = []
  ctx.provide('httpServer', fakeHttpServer(routes) as HttpServerService)
  ctx.provide('apiProxy', {} as unknown as ApiProxy)
  const fiber = ctx.plugin({ inject: [...inject], apply }, config)
  await fiber.await()
  return { routes, dispose: () => fiber.dispose() }
}

describe('connection node half', () => {
  it('fails the load on a trustedHosts entry that is not a bare authority', async () => {
    const routes: WebRoute[] = []
    const ctx = new Context()
    ctx.provide('httpServer', fakeHttpServer(routes) as HttpServerService)
    ctx.provide('apiProxy', {} as unknown as ApiProxy)
    // The apply throw also escapes cordis as a late rejection — the shape the
    // boot's installFailLoud is contracted to catch. Capture it so the run
    // stays clean, same pattern as the webserver bind-failure test.
    const rejections: unknown[] = []
    const onUnhandled = (err: unknown): void => { rejections.push(err) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.internal/path'] })
      await expect(fiber.await()).rejects.toThrow(/not a bare host\[:port\] authority/)
      expect(routes).toHaveLength(0)
      for (let i = 0; i < 100 && rejections.length === 0; i++) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(rejections.map(String).join('\n')).toContain('not a bare host[:port] authority')
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('registers the /api prefix route and removes it with the fiber', async () => {
    const { routes, dispose } = await mounted()
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'prefix', path: API_PATH })
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
