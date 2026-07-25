/** Node half: registers the /api prefix route bridging to the api gateway. */
import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
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

    await fiber.dispose()
    expect(routes).toHaveLength(0)
  })
})
