/**
 * @deepseek-ai/dsh-host-apiproxy — the API gateway every client shape shares:
 * the ApiProxy contract (api/: types + zod schemas, browser-safe), the fetch
 * carrier pair (fetch/: toFetchHandler on the host side, AbstractApiClient +
 * platform subclasses on the client side), and the host-side implementation
 * (api-proxy.ts: createApiProxy + the ApiProxyService gateway plugin providing
 * `ctx.apiProxy`). Transport-agnostic by design: this package registers no
 * routes — carriers (HTTP today, IPC later) wrap `ctx.apiProxy` themselves.
 */

import { Context, Service } from 'cordis'
import z from 'schemastery'
import type { ApiProxy } from './api/index.ts'
import { createApiProxy } from './api-proxy.ts'

export type * from './api/index.ts'
export { RpcId } from './api/rpc.ts'
export { toFetchHandler } from './fetch/handler.ts'
export { AbstractApiClient, InProcessApiClient } from './fetch/client.ts'
export type { IApiClient } from './fetch/client.ts'
export { createApiProxy } from './api-proxy.ts'
export type { ApiProxyDefaults } from './api-proxy.ts'

declare module 'cordis' {
  interface Context {
    /** The host-side ApiProxy implementation (the transport-agnostic gateway face). */
    apiProxy: ApiProxy
  }
}

/** Gateway plugin config: the host-level default agent routing. */
export interface Config {
  /** Default provider route for created/resumed agents. */
  provider: string
  /** Default model id. */
  model: string
}

/**
 * The API gateway service: implements the ApiProxy contract over the composed
 * host context and provides it as `ctx.apiProxy`. The default project
 * directory for new sessions is the host process working directory (not a
 * config field this round).
 */
export class ApiProxyService extends Service implements ApiProxy {
  static inject = ['agents', 'sessions', 'tools', 'userInteraction']

  static Config: z<Config> = z.object({
    provider: z.string().required(),
    model: z.string().required(),
  })

  readonly sessions: ApiProxy['sessions']
  readonly host: ApiProxy['host']
  readonly events: ApiProxy['events']
  readonly respond: ApiProxy['respond']

  constructor(ctx: Context, config: Config) {
    super(ctx, 'apiProxy')
    const api = createApiProxy(ctx, { provider: config.provider, model: config.model, cwd: process.cwd() })
    this.sessions = api.sessions
    this.host = api.host
    this.events = api.events
    // createApiProxy returns closures (no `this` capture); bind only satisfies
    // the unbound-method lint without changing behavior.
    this.respond = api.respond.bind(api)
  }
}

export default ApiProxyService
