/**
 * @deepseek-ai/dsh-host-apiproxy — the API gateway every client shape shares:
 * the ApiProxy contract (api/: types + zod schemas, browser-safe), the fetch
 * carrier pair (fetch/: toFetchHandler on the host side, AbstractApiClient +
 * platform subclasses on the client side), and the host-side implementation
 * (api-proxy.ts: createApiProxy + the ApiProxyService gateway plugin providing
 * `ctx.apiProxy`). Transport-agnostic by design: this package registers no
 * routes — carriers (HTTP today, IPC later) wrap `ctx.apiProxy` themselves.
 */

import { resolve } from 'node:path'
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

/** Gateway plugin config: host-level agent routing and Workspace creation root. */
export interface Config {
  /** Default provider route for created/resumed agents. */
  provider: string
  /** Default model id. */
  model: string
  /** Parent directory for name-created Workspaces; defaults to the Host cwd. */
  workspaceRoot?: string
}

/**
 * The API gateway service: implements the ApiProxy contract over the composed
 * host context and provides it as `ctx.apiProxy`. The Host cwd is the default
 * project directory and the fallback parent for name-created Workspaces.
 */
export class ApiProxyService extends Service implements ApiProxy {
  static inject = ['agents', 'llm', 'sessions', 'tools', 'userInteraction', 'workspace']

  static Config: z<Config> = z.object({
    provider: z.string().required(),
    model: z.string().required(),
    workspaceRoot: z.string(),
  })

  readonly sessions: ApiProxy['sessions']
  readonly workspace: ApiProxy['workspace']
  readonly host: ApiProxy['host']
  readonly commands: ApiProxy['commands']
  readonly goals: ApiProxy['goals']
  readonly skills: ApiProxy['skills']
  readonly events: ApiProxy['events']
  readonly respond: ApiProxy['respond']

  constructor(ctx: Context, config: Config) {
    super(ctx, 'apiProxy')
    const cwd = process.cwd()
    const api = createApiProxy(ctx, {
      provider: config.provider,
      model: config.model,
      cwd,
      workspaceRoot: resolve(config.workspaceRoot ?? cwd),
    })
    this.sessions = api.sessions
    this.workspace = api.workspace
    this.host = api.host
    this.commands = api.commands
    this.goals = api.goals
    this.skills = api.skills
    this.events = api.events
    // createApiProxy returns closures (no `this` capture); bind only satisfies
    // the unbound-method lint without changing behavior.
    this.respond = api.respond.bind(api)
  }
}

export default ApiProxyService
