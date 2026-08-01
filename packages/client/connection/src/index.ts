/** Host HTTP bridge for browser-client RPC and workspace-file reads. */
import type { Context } from 'cordis'
import z from 'schemastery'
// Activates the httpServer Context merge used below.
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import { FILES_PATH } from '@deepseek-ai/dsh-host-apiproxy/api'
// The merge-free types subpath: pulling the session package's root into this
// client-registered program would merge the host `sessions` service over the
// browser runtime's own.
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { API_PATH } from './api-path.ts'
import { bridge } from './http-bridge.ts'
import { handleWorkspaceFile } from './workspace-files.ts'
import { assertTrustedAuthority, isTrustedApiRequest } from './api-request-trust.ts'

export { API_PATH } from './api-path.ts'

/** Stable Cordis plugin name. */
export const name = 'client-connection'

/** Services required before mounting the routes. */
export const inject = ['httpServer', 'apiProxy']

/** Plugin config: the deployment's non-loopback serving authorities. */
export interface ConnectionConfig {
  /**
   * Authorities this deployment serves beyond loopback: exact `host:port`, or
   * port-less `host` matching any port. The /api trust fence refuses any
   * request whose Host is neither loopback nor listed here, so a
   * non-loopback (`0.0.0.0`) deployment must declare the names it is reached
   * by (the dsh CLI derives the machine's LAN IP literals itself). An entry
   * that is not a bare, canonical authority fails the plugin load.
   */
  trustedHosts?: string[]
}

export const Config: z<ConnectionConfig> = z.object({
  trustedHosts: z.array(String).default([]),
})

/**
 * Methods gated to loopback even on a trusted-host deployment. Native dialogs
 * act on the host machine; the settings and credential domains mutate the
 * user's configuration and secret store, and READING them is equally
 * privileged — `settings.describe` returns every exposed namespace's
 * configuration and `credentials.describe` reports whether an arbitrary
 * environment-variable name is configured and where from, which is
 * reconnaissance no anonymous caller should have. `trustedHosts` is a
 * DNS-rebinding fence, explicitly not authentication, so the whole
 * configuration plane stays loopback-same-origin until a real authentication
 * layer exists. The model catalog (`llm.providers`, `llm.models`) is
 * deliberately NOT here: it carries provider ids, display names, and model
 * lists — no endpoints, keys, or key state — and a LAN client's model picker
 * legitimately needs it.
 */
const PRIVILEGED_METHODS = new Set([
  'host.pickDirectory',
  'host.openPath',
  'settings.describe',
  'settings.update',
  'settings.replace',
  'settings.mutate',
  'credentials.describe',
  'credentials.set',
  'credentials.unset',
])

/**
 * Mounts the API gateway and the workspace-file reads under the browser
 * transport prefixes. Every request on either prefix passes the browser-trust
 * fence first (DNS-rebinding and cross-site defense —
 * [api-request-trust](./api-request-trust.ts)); privileged methods
 * additionally pass it with an empty trust list, which pins them to loopback.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin config (schema defaults applied).
 */
export function apply(ctx: Context, config?: ConnectionConfig): void {
  // The Loader resolves schema defaults; hand-built test contexts may pass none.
  const trustedHosts = config?.trustedHosts ?? []
  // Config boundary: a malformed entry fails the load loudly here rather than
  // silently authorizing its hostname prefix at request time.
  for (const entry of trustedHosts) assertTrustedAuthority(entry)
  const apiHandler = toFetchHandler(ctx.apiProxy)
  const route: WebRoute = {
    kind: 'prefix',
    path: API_PATH,
    handler: async (req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith(`${API_PATH}/`)
        ? pathname.slice(API_PATH.length + 1)
        : undefined
      const allowed = method !== undefined && PRIVILEGED_METHODS.has(method)
        ? isTrustedApiRequest(req, [])
        : isTrustedApiRequest(req, trustedHosts)
      if (!allowed) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      await bridge(req, res, apiHandler)
    },
  }
  ctx.effect(() => ctx.httpServer.register(route), 'client-connection: /api route')

  // The gateway is the host's session authority: it answers where a Session's
  // files live without this package reaching into the core services, which
  // would merge their host-side Context declarations into the browser lane.
  const cwdFor = (sessionId: string): Promise<string | undefined> =>
    ctx.apiProxy.workspaceRootOf(sessionId as SessionId)
  const filesRoute: WebRoute = {
    kind: 'prefix',
    path: FILES_PATH,
    handler: async (req, res) => {
      if (!isTrustedApiRequest(req, trustedHosts)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        // RFC 9110 §15.5.6: a 405 names the methods the resource does support.
        res.writeHead(405, { allow: 'GET, HEAD' })
        res.end()
        return
      }
      await handleWorkspaceFile(req, res, { cwdFor })
    },
  }
  ctx.effect(() => ctx.httpServer.register(filesRoute), 'client-connection: /f route')
}
