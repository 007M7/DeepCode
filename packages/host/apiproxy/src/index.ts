/**
 * @deepseek-ai/dsh-host-apiproxy — the API gateway every client shape shares:
 * the ApiProxy contract (api/: types + zod schemas, browser-safe), the fetch
 * carrier pair (fetch/: toFetchHandler on the host side, AbstractApiClient +
 * platform subclasses on the client side), and the host-side implementation
 * (api-proxy.ts: createApiProxy + the ApiProxyService gateway plugin providing
 * `ctx.apiProxy`). Transport-agnostic by design: this package registers no
 * routes — physical carriers wrap `ctx.apiProxy` themselves.
 *
 * The gateway also owns the `api-gateway` settings section: the route a
 * session starts from when its own log names none. The composition entry is
 * the shipped default and the section layers the user's choice over it, so
 * switching models in a conversation is what sets the default for the next
 * one. Sessions that have already logged a route are never retargeted by it.
 */

import { resolve } from 'node:path'
import { Context, Service } from 'cordis'
import z from 'schemastery'
import type { AgentLlmTarget } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
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

/**
 * The settings namespace carrying the user's default route. Named for the
 * gateway rather than for the package, because this key is what a person reads
 * and writes in `settings.yaml`; the row id in a composition happens to match
 * but does not determine it.
 */
export const API_GATEWAY_SETTINGS_NAMESPACE = settingsNamespace('api-gateway')

/**
 * The user-settable slice of the gateway config: the route a session starts
 * from when its own log names none. `workspaceRoot` is deliberately not part
 * of it — that is a launcher fact, not a preference.
 */
export interface DefaultRouteSettings {
  /** Default provider route for created agents. */
  provider: string
  /** Default model id. */
  model: string
  /** Default reasoning effort; absence preserves the adapter/provider default. */
  reasoningEffort?: string
}

/** Gateway plugin config: host-level agent routing and Workspace creation root. */
export interface Config extends DefaultRouteSettings {
  /** Parent directory for name-created Workspaces; defaults to the Host cwd. */
  workspaceRoot?: string
}

/**
 * The default-route fields, as fresh schema instances. Both the plugin config
 * and the settings section are built from this one call, so the section stays
 * a subset of the config structurally rather than by a comment two people have
 * to keep true.
 */
function defaultRouteFields(): { [K in keyof Required<DefaultRouteSettings>]: z<string> } {
  return {
    provider: z.string().required(),
    model: z.string().required(),
    reasoningEffort: z.string(),
  }
}

/** Schema of the settings section. */
const DefaultRouteSchema: z<DefaultRouteSettings> = z.object(defaultRouteFields())

/** Project the stored/composed section onto the agent-facing target shape. */
function routeTarget(settings: DefaultRouteSettings): AgentLlmTarget {
  return {
    provider: settings.provider,
    model: settings.model,
    ...settings.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(settings.reasoningEffort) },
  }
}

/**
 * The API gateway service: implements the ApiProxy contract over the composed
 * host context and provides it as `ctx.apiProxy`. The Host cwd is the default
 * project directory and the fallback parent for name-created Workspaces.
 */
export class ApiProxyService extends Service implements ApiProxy {
  static inject = [
    'agents', 'directoryPicker', 'llm', 'sessions', 'subagents', 'sessionQuery',
    'tools', 'userInteraction', 'workspace',
  ]

  static Config: z<Config> = z.object({
    ...defaultRouteFields(),
    workspaceRoot: z.string(),
  })

  readonly sessions: ApiProxy['sessions']
  readonly subagents: ApiProxy['subagents']
  readonly workspace: ApiProxy['workspace']
  readonly host: ApiProxy['host']
  readonly commands: ApiProxy['commands']
  readonly goals: ApiProxy['goals']
  readonly skills: ApiProxy['skills']
  readonly settings: ApiProxy['settings']
  readonly credentials: ApiProxy['credentials']
  readonly llm: ApiProxy['llm']
  readonly events: ApiProxy['events']
  readonly respond: ApiProxy['respond']

  constructor(ctx: Context, config: Config) {
    super(ctx, 'apiProxy')
    const cwd = process.cwd()
    // The composition entry is the shipped default; the settings section
    // layers the user's own choice over it, and a deployment without a
    // settings provider simply keeps the entry.
    const entry: DefaultRouteSettings = {
      provider: config.provider,
      model: config.model,
      ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
    }
    let route: () => DefaultRouteSettings = () => entry
    installSettingsSection(ctx, API_GATEWAY_SETTINGS_NAMESPACE, DefaultRouteSchema, entry, {
      setSource: (current) => {
        route = current
      },
      // Nothing registration-level derives from the default: every consumer
      // reads it through the thunk at the moment it needs a route.
      onChange: () => {},
    })
    const api = createApiProxy(ctx, {
      defaultTarget: () => routeTarget(route()),
      // Wholesale, never a merge: switching to a model with no reasoning
      // effort must clear a stored one, and a merged patch would strand it
      // for the next session to fail on. The section holds no secrets, so
      // there is nothing a replace can collaterally drop.
      persistDefaultTarget: async (target) => {
        await ctx.get('settings')?.replace(API_GATEWAY_SETTINGS_NAMESPACE, target)
      },
      cwd,
      workspaceRoot: resolve(config.workspaceRoot ?? cwd),
    })
    this.sessions = api.sessions
    this.subagents = api.subagents
    this.workspace = api.workspace
    this.host = api.host
    this.commands = api.commands
    this.goals = api.goals
    this.skills = api.skills
    this.settings = api.settings
    this.credentials = api.credentials
    this.llm = api.llm
    this.events = api.events
    // createApiProxy returns closures (no `this` capture); bind only satisfies
    // the unbound-method lint without changing behavior.
    this.respond = api.respond.bind(api)
  }
}

export default ApiProxyService
