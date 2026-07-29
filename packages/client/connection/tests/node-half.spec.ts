/** Node half: registers the /api prefix route bridging to the api gateway. */
import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { HttpServerService, WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { API_PATH, apply, inject } from '../src/index.ts'

describe('connection node half', () => {
  it('registers the /api prefix route and removes it with the fiber', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    // Structural fake: the plugin only touches register(); the service class
    // carries private state a literal cannot (and need not) reproduce.
    const httpServer: Pick<HttpServerService, 'register' | 'tapIndex' | 'port'> = {
      register(route) {
        routes.push(route)
        return () => { routes.splice(routes.indexOf(route), 1) }
      },
      tapIndex: () => () => {},
      port: 0,
    }
    ctx.provide('httpServer', httpServer as HttpServerService)
    ctx.provide('apiProxy', {} as unknown as ApiProxy)

    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'prefix', path: API_PATH })

    // The privileged set: native dialogs plus every settings/credential write.
    // A non-loopback peer is denied even with same-origin headers.
    for (const url of [
      '/api/host.pickDirectory', '/api/host.openPath',
      '/api/settings.update', '/api/settings.replace',
      '/api/credentials.set', '/api/credentials.unset',
    ]) {
      let status: number | undefined
      let body: unknown
      const deniedRequest = {
        url,
        headers: {
          host: 'harness.example', origin: 'http://harness.example', 'sec-fetch-site': 'same-origin',
        },
        socket: { remoteAddress: '192.168.1.8' },
      } as unknown as IncomingMessage
      const deniedResponse = {
        writeHead(value: number) { status = value; return this },
        end(value?: unknown) { body = value; return this },
      } as unknown as ServerResponse
      await routes[0]!.handler(deniedRequest, deniedResponse)
      expect(status).toBe(403)
      expect(body).toBe('forbidden')
    }

    await fiber.dispose()
    expect(routes).toHaveLength(0)
  })

  it('leaves reads and unprivileged methods to the bridge under the same untrusted peer', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    const httpServer: Pick<HttpServerService, 'register' | 'tapIndex' | 'port'> = {
      register(route) {
        routes.push(route)
        return () => { routes.splice(routes.indexOf(route), 1) }
      },
      tapIndex: () => () => {},
      port: 0,
    }
    ctx.provide('httpServer', httpServer as HttpServerService)
    // The bridge parses the request before the (empty) impl is consulted; a
    // carrier-level 404/parse outcome proves the guard did not intercept.
    ctx.provide('apiProxy', {} as unknown as ApiProxy)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    let status: number | undefined
    const request = {
      url: '/api/settings.describe',
      method: 'POST',
      headers: {
        host: 'harness.example', origin: 'http://harness.example', 'sec-fetch-site': 'same-origin',
      },
      socket: { remoteAddress: '192.168.1.8' },
      // Minimal async-iterable face for the bridge's body assembly.
      async *[Symbol.asyncIterator]() {
        yield Buffer.from('not json')
      },
    } as unknown as IncomingMessage
    const response = {
      writeHead(value: number) { status = value; return this },
      setHeader() { return this },
      end() { return this },
      write() { return true },
      on() { return this },
    } as unknown as ServerResponse
    await routes[0]!.handler(request, response)
    // 400 (body is not JSON) comes from the carrier, not the 403 guard: the
    // read passed the privileged check and reached the fetch handler.
    expect(status).toBe(400)
    await fiber.dispose()
  })
})
