/** Host HTTP bridge for browser-client RPC. */
import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-attachment'
// Activates the httpServer Context merge used below.
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import { API_PATH } from './api-path.ts'
import { bridge } from './http-bridge.ts'
import { isTrustedNativeDialogRequest } from './native-dialog-request.ts'

export { API_PATH } from './api-path.ts'

/** Stable Cordis plugin name. */
export const name = 'client-connection'

/** Headroom for RPC JSON fields around the aggregate base64 image payload. */
const REQUEST_ENVELOPE_HEADROOM_BYTES = 1024 * 1024

/** Services required before mounting the route. */
export const inject = ['httpServer', 'apiProxy', 'attachments']

/**
 * Mounts the API gateway under the browser transport prefix.
 * @param ctx - Host plugin context.
 */
export function apply(ctx: Context): void {
  const apiHandler = toFetchHandler(ctx.apiProxy)
  const maxRequestBodyBytes = Math.ceil(
    ctx.attachments.imageLimits.maxMessageImageBytes * 4 / 3,
  ) + REQUEST_ENVELOPE_HEADROOM_BYTES
  const route: WebRoute = {
    kind: 'prefix',
    path: API_PATH,
    handler: async (req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      if ((pathname === `${API_PATH}/host.pickDirectory`
        || pathname === `${API_PATH}/host.openPath`)
        && !isTrustedNativeDialogRequest(req)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      await bridge(req, res, apiHandler, maxRequestBodyBytes)
    },
  }
  ctx.effect(() => ctx.httpServer.register(route), 'client-connection: /api route')
}
