/**
 * Connection plugin, node half: the host end of the web transport. Registers
 * the /api prefix route on the web server and bridges node:http requests to
 * the transport-agnostic fetch-shaped api handler. The wire consumer layer
 * lives in the client half (src/client/ — contract: api-contracts v3
 * section 3); consumers import the /client subpath.
 */
import type { Context } from 'cordis'
// Type-only route import; it also carries the httpServer Context merge.
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import { API_PATH } from './api-path.ts'
import { bridge } from './http-bridge.ts'

export { API_PATH } from './api-path.ts'

/** Cordis plugin name. */
export const name = 'client-connection'

/** Required services: the route registry and the api gateway. */
export const inject = ['httpServer', 'apiProxy']

/**
 * Mount the /api transport: wrap the api gateway into a fetch handler and
 * serve it under the /api prefix.
 * @param ctx - host plugin context carrying httpServer and apiProxy.
 */
export function apply(ctx: Context): void {
  const apiHandler = toFetchHandler(ctx.apiProxy)
  const route: WebRoute = {
    kind: 'prefix',
    path: API_PATH,
    handler: (req, res) => bridge(req, res, apiHandler),
  }
  ctx.effect(() => ctx.httpServer.register(route), 'client-connection: /api route')
}
