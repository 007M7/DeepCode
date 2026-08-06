/**
 * Materialization of one provider route's model catalog. The installed pi-ai
 * catalog supplies defaults keyed by model id, and a profile's own model
 * entries override them field by field, so a route naming a catalog provider
 * stays configuration-free while a route pi-ai has never heard of is fully
 * describable from `settings.yaml`.
 *
 * Every pi-ai `Model` field the harness cannot default is required here rather
 * than at request time: an unserviceable route fails while its configuration is
 * being resolved, which is the earliest point that can name the offending key.
 *
 * @module dsh-llm-pi-ai/catalog
 */

import { builtinProviders, getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all'
import type { BuiltinProvider } from '@earendil-works/pi-ai/providers/all'
import type { Api, Model, ModelCost, Provider } from '@earendil-works/pi-ai'

/**
 * Pricing for a model the installed catalog does not describe. The harness
 * never reads pi-ai's cost metadata — `replay.ts` zeroes it and no consumer
 * reports spend — so this is the absence of a fact, not a configurable rate.
 */
const NO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/**
 * Input modalities for a model the installed catalog does not describe. The
 * request converter keeps only text blocks, so text is the adapter's actual
 * capability rather than a deployment choice.
 */
const TEXT_ONLY: Model<Api>['input'] = ['text']

let providerIndex: Map<string, Provider> | undefined

/**
 * Installed catalog providers by id, constructed once. Each entry owns the API
 * implementations for its own models, which is why a catalog route reuses this
 * provider instead of being rebuilt from parts.
 * @returns the catalog provider index.
 */
function catalogProviders(): Map<string, Provider> {
  providerIndex ??= new Map(builtinProviders().map(provider => [provider.id, provider]))
  return providerIndex
}

/**
 * The installed catalog provider for one route, when pi-ai ships one.
 * @param provider - provider route key.
 * @returns the catalog provider, or `undefined` for a route pi-ai does not ship.
 */
export function catalogProvider(provider: string): Provider | undefined {
  return catalogProviders().get(provider)
}

/**
 * Every provider route the installed pi-ai catalog ships.
 * @returns the catalog provider ids.
 */
export function catalogProviderIds(): readonly string[] {
  return getBuiltinProviders()
}

/**
 * The installed catalog models for one route, indexed by model id.
 * @param provider - provider route key.
 * @returns catalog models by id; empty for a route pi-ai does not ship.
 */
export function catalogModels(provider: string): Map<string, Model<Api>> {
  if (!catalogProviders().has(provider)) return new Map()
  const models = getBuiltinModels(provider as BuiltinProvider) as Model<Api>[]
  return new Map(models.map(model => [model.id, model]))
}

/** One configured model entry: an id plus the catalog fields it overrides. */
export interface PiAiModelProfile {
  /** Model id sent to the provider and accepted by {@link GenerateOptions.model}. */
  id: string
  /** Display name for selectors; defaults to the catalog name, then the id. */
  name?: string
  /** Maximum combined request and response context in tokens. */
  contextWindow?: number
  /**
   * Maximum output tokens. Configuring one also makes it this model's
   * per-request default; a value inherited from the installed catalog, or the
   * route's fallback, is the model's capability and never becomes a request
   * default on its own.
   */
  maxTokens?: number
}

/** The route-level facts model materialization reads. */
export interface RouteCatalogRequest {
  /** Provider route key, stamped onto every materialized model. */
  provider: string
  /** Wire protocol override; absent defers to each catalog model's own API. */
  api?: string
  /** Endpoint override; absent defers to the catalog model, then the catalog provider. */
  baseURL?: string
  /** Configured catalog; absent means the whole installed catalog for this route. */
  models?: readonly PiAiModelProfile[]
  /** Context capacity for a model neither the entry nor the catalog sizes. */
  defaultContextWindow: number
  /** Output capability for a model neither the entry nor the catalog sizes. */
  defaultMaxTokens: number
}

/** Report a route the deployment cannot serve, naming the settings key at fault. */
function invalid(provider: string, detail: string): never {
  throw new Error(`llm-pi-ai: provider "${provider}" ${detail}`)
}

/**
 * The one wire protocol a catalog route's shipped models agree on. This is what
 * lets a deployment add a model the installed catalog has not caught up with —
 * a provider's newest release — without restating the protocol its siblings
 * already use. A route whose shipped models disagree (an OpenAI-style catalog
 * spanning Responses and Chat Completions) has no such answer, so a model it
 * does not describe must name its protocol at the route.
 */
function sharedCatalogApi(defaults: ReadonlyMap<string, Model<Api>>): string | undefined {
  const apis = new Set<string>()
  for (const model of defaults.values()) apis.add(model.api)
  return apis.size === 1 ? [...apis][0] : undefined
}

/** One route's materialized catalog, plus the request caps its profile chose. */
export interface RouteCatalog {
  /** The materialized models in configuration order. */
  models: readonly Model<Api>[]
  /**
   * Per-request output caps this profile explicitly configured, by model id.
   *
   * Separate from `Model.maxTokens` because the two answer different
   * questions: pi-ai requires `maxTokens` as the model's output *capability*,
   * while the harness seam's `defaultMaxTokens` is a cap the deployment chose
   * to send on requests that name none. Materializing a catalog capability as
   * a request default would start capping every request at a number nobody
   * picked, so only an explicit configuration lands here.
   */
  configuredMaxTokens: ReadonlyMap<string, number>
}

/**
 * Materialize one route's catalog by merging the installed catalog defaults
 * under the configured entries. A route with no configured `models` serves the
 * installed catalog unchanged, which is what keeps an existing
 * `providers: { deepseek: { apiKeyEnv: … } }` profile working untouched.
 * @param request - the route-level catalog facts.
 * @returns the materialized models and the explicitly configured request caps.
 */
export function resolveRouteModels(request: RouteCatalogRequest): RouteCatalog {
  const { provider } = request
  const defaults = catalogModels(provider)
  const providerBaseUrl = catalogProvider(provider)?.baseUrl
  // An absent `models` key and an empty one are the same request: the config
  // schema materializes `[]` for the absent case, and an empty catalog could
  // serve no request anyway, so both mean "serve the installed catalog".
  const configured = request.models ?? []
  const entries: readonly PiAiModelProfile[] = configured.length > 0
    ? configured
    : [...defaults.values()].map(model => ({ id: model.id }))
  if (entries.length === 0) {
    invalid(provider, 'resolves no models; the installed catalog does not describe this route, so its models'
      + ' must be listed in configuration')
  }
  const routeApi = sharedCatalogApi(defaults)
  const seen = new Set<string>()
  const configuredMaxTokens = new Map<string, number>()
  const models = entries.map((entry) => {
    if (entry.id.length === 0) invalid(provider, 'has a model with an empty id')
    if (seen.has(entry.id)) invalid(provider, `lists model "${entry.id}" more than once`)
    seen.add(entry.id)
    const base = defaults.get(entry.id)
    const api = request.api ?? base?.api ?? routeApi
    if (api === undefined) {
      invalid(provider, `model "${entry.id}" needs an api; the installed catalog does not describe it, so set the`
        + ' route\'s api to the wire protocol its endpoint speaks')
    }
    const baseUrl = request.baseURL ?? base?.baseUrl ?? providerBaseUrl
    if (baseUrl === undefined) {
      invalid(provider, `model "${entry.id}" needs a baseURL; the installed catalog does not describe this route`)
    }
    // Capacities fall back to the route's own defaults, so a model listing that
    // discloses nothing but ids still yields a serviceable route. The fallback
    // is a guess by construction, which is why it is a configurable route field
    // rather than a constant buried here.
    const contextWindow = entry.contextWindow ?? base?.contextWindow ?? request.defaultContextWindow
    if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
      invalid(provider, `model "${entry.id}" contextWindow must be a positive integer`)
    }
    const maxTokens = entry.maxTokens ?? base?.maxTokens ?? request.defaultMaxTokens
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
      invalid(provider, `model "${entry.id}" maxTokens must be a positive integer`)
    }
    // Only a value the profile named is a deployment choice; the catalog's is
    // the model's capability and stays out of request defaults.
    if (entry.maxTokens !== undefined) configuredMaxTokens.set(entry.id, entry.maxTokens)
    return {
      // The installed entry lays the floor, and the fields below override it.
      // Enumerating instead would silently drop every `Model` field this
      // package does not model — reasoning-level spellings, compatibility
      // quirks, model headers, and whatever a pi-ai upgrade adds next. That is
      // not hypothetical: `headers` reached this file only after an nvidia
      // route lost it, and a rebuild keeps re-earning that bug on every
      // upgrade.
      ...base,
      id: entry.id,
      name: entry.name ?? base?.name ?? entry.id,
      api,
      provider,
      baseUrl,
      // Reasoning rides the installed entry or is absent: a bare boolean would
      // make pi-ai advertise effort levels with no `thinkingLevelMap` to spell
      // them, and no listing endpoint reports a model's reasoning protocol.
      reasoning: base?.reasoning ?? false,
      input: base?.input ?? TEXT_ONLY,
      cost: base?.cost ?? NO_COST,
      contextWindow,
      maxTokens,
    }
  })
  return { models, configuredMaxTokens }
}
