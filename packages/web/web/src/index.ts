/**
 * The web access seam (`ctx.web`): a provider registry plus a provider-selecting
 * execution surface for two capabilities — search and fetch. Provider packages
 * register concrete backends with `registerSearchProvider` /
 * `registerFetchProvider`; the model-facing consumer
 * (`@deepseek-ai/dsh-tool-web`) reads capability status and executes through
 * `search()` / `fetch()`.
 *
 * The registry half stays close to `LlmService`: a `Map<id, provider>` per
 * capability kind, register methods that return disposers, duplicate ids that
 * throw, and execution-time resolution that throws when the selected provider is
 * absent or unusable. On top of that sits one small selection-status layer so
 * diagnostics and execution can explain why a capability can or cannot run,
 * independent of registration order.
 *
 * @module @deepseek-ai/dsh-web
 */

import { Context, Service } from 'cordis'
import z from 'schemastery'
import type {
  WebCapabilityStatus,
  WebExecContext,
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebProviderStatus,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
} from './types.ts'
import { WebError } from './types.ts'

export {
  WebError,
} from './types.ts'
export type {
  WebCapabilityStatus,
  WebExecContext,
  WebFetchBody,
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebProviderStatus,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from './types.ts'

declare module 'cordis' {
  interface Context {
    web: WebService
  }

  interface Events {
    /**
     * Fired after the provider registry changes — a search or fetch provider was
     * registered or disposed. Carries no payload and no capability graph: it
     * means only "the provider registry changed; observers may recompute status
     * from `ctx.web`". `searchStatus()` / `fetchStatus()` stay derived, not
     * stored.
     * @mode emit
     */
    'web/providers-change'(this: WebService): void
  }
}

/** Selection inputs shared by the status query and execution resolution. */
interface Selection<P> {
  /** The configured provider id for this capability, if any. */
  readonly configuredId?: string
  /** Providers registered for this capability kind. */
  readonly providers: ReadonlyMap<string, P>
}

/**
 * Config for the web seam. `searchProvider` / `fetchProvider` pin which provider
 * wins for each capability; both are optional (a single registered usable
 * provider auto-selects). Operational overrides such as environment variables
 * must feed these same fields rather than introduce a hidden priority chain.
 */
export interface WebServiceConfig {
  /** Explicit search provider id. Omitted = auto-select when exactly one usable. */
  readonly searchProvider?: string
  /** Explicit fetch provider id. Omitted = auto-select when exactly one usable. */
  readonly fetchProvider?: string
}

/**
 * The web access service. Registered as `ctx.web` (one instance per context).
 *
 * Selection semantics (identical for status and execution, never order-
 * dependent):
 * - A configured id that is registered and `status().available` → that provider.
 * - A configured id not registered → `configured-missing` /
 *   `WEB_PROVIDER_CONFIGURED_MISSING`.
 * - A configured id registered but unavailable → `configured-unavailable` /
 *   `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`.
 * - No id configured, exactly one registered usable provider → that provider.
 * - No id configured, multiple usable providers → `ambiguous` /
 *   `WEB_PROVIDER_AMBIGUOUS`.
 * - No id configured, no usable provider → `none` / `WEB_PROVIDER_UNAVAILABLE`.
 */
export class WebService extends Service {
  /**
   * Provider selection config. Operational env overrides feed the SAME fields:
   * `$DSH_WEB_SEARCH_PROVIDER` / `$DSH_WEB_FETCH_PROVIDER` are equivalent to
   * `searchProvider` / `fetchProvider` and are NOT a hidden priority chain.
   */
  static Config: z<WebServiceConfig> = z.object({
    searchProvider: z.string(),
    fetchProvider: z.string(),
  })

  private searchProviders = new Map<string, WebSearchProvider>()
  private fetchProviders = new Map<string, WebFetchProvider>()
  private readonly searchProviderId: string | undefined
  private readonly fetchProviderId: string | undefined

  constructor(ctx: Context, config: WebServiceConfig = {}) {
    super(ctx, 'web')
    this.searchProviderId = config.searchProvider ?? process.env.DSH_WEB_SEARCH_PROVIDER
    this.fetchProviderId = config.fetchProvider ?? process.env.DSH_WEB_FETCH_PROVIDER
  }

  /**
   * Register a search provider. Throws {@link WebError} `WEB_DUPLICATE_PROVIDER`
   * if its id is already registered for search. Returns a disposer; emits
   * `web/providers-change` after a successful register and again on dispose.
   * Disposed with the calling fiber.
   */
  registerSearchProvider(provider: WebSearchProvider): () => void {
    return this.registerProvider(this.searchProviders, provider)
  }

  /**
   * Register a fetch provider. Throws {@link WebError} `WEB_DUPLICATE_PROVIDER`
   * if its id is already registered for fetch. Returns a disposer; emits
   * `web/providers-change` after a successful register and again on dispose.
   * Disposed with the calling fiber.
   */
  registerFetchProvider(provider: WebFetchProvider): () => void {
    return this.registerProvider(this.fetchProviders, provider)
  }

  private registerProvider<P extends { readonly id: string }>(store: Map<string, P>, provider: P): () => void {
    if (store.has(provider.id)) {
      throw new WebError(`a web provider with id "${provider.id}" is already registered`, 'WEB_DUPLICATE_PROVIDER')
    }
    const dispose = this.ctx.effect(function* (this: WebService) {
      store.set(provider.id, provider)
      // Yield the rollback BEFORE emitting `web/providers-change`: the generator
      // effect collects each yielded disposer before the next step runs, so a
      // throwing change listener removes the just-added provider instead of
      // leaking it into the registry.
      yield () => {
        store.delete(provider.id)
        this.ctx.emit('web/providers-change')
      }
      this.ctx.emit('web/providers-change')
    }.bind(this), 'web.registerProvider()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /** Search-capability selection status, derived live (never stored). */
  searchStatus(): WebCapabilityStatus {
    return resolveStatus({
      providers: this.searchProviders,
      ...this.searchProviderId !== undefined ? { configuredId: this.searchProviderId } : {},
    })
  }

  /** Fetch-capability selection status, derived live (never stored). */
  fetchStatus(): WebCapabilityStatus {
    return resolveStatus({
      providers: this.fetchProviders,
      ...this.fetchProviderId !== undefined ? { configuredId: this.fetchProviderId } : {},
    })
  }

  /**
   * Run one search through the selected provider. Resolves the provider at call
   * time with the selection rules above; throws {@link WebError} when the
   * capability cannot run. The seam enforces `request.maxResults` on the result:
   * if the provider over-returns, `sources[]` is truncated and `truncated` set.
   */
  async search(request: WebSearchRequest, exec?: WebExecContext): Promise<WebSearchResult> {
    const provider = resolveProvider({
      providers: this.searchProviders,
      ...this.searchProviderId !== undefined ? { configuredId: this.searchProviderId } : {},
    })
    const result = await provider.search(request, exec)
    return capSources(result, request.maxResults)
  }

  /**
   * Retrieve one URL through the selected provider. Resolves the provider at
   * call time with the selection rules above; throws {@link WebError} when the
   * capability cannot run. A non-2xx response is a result, not a throw.
   */
  async fetch(request: WebFetchRequest, exec?: WebExecContext): Promise<WebFetchResult> {
    const provider = resolveProvider({
      providers: this.fetchProviders,
      ...this.fetchProviderId !== undefined ? { configuredId: this.fetchProviderId } : {},
    })
    return provider.fetch(request, exec)
  }
}

interface ResolvableProvider {
  readonly id: string
  status(): WebProviderStatus
}

/** Compute the capability status from configured id + registered providers. */
function resolveStatus<P extends ResolvableProvider>(selection: Selection<P>): WebCapabilityStatus {
  const { configuredId, providers } = selection
  if (configuredId !== undefined) {
    const provider = providers.get(configuredId)
    if (!provider) return { available: false, reason: 'configured-missing' }
    if (!provider.status().available) return { available: false, reason: 'configured-unavailable' }
    return { available: true, providerId: configuredId }
  }
  const usable = [...providers.values()].filter(provider => provider.status().available)
  const [single] = usable
  if (single === undefined) return { available: false, reason: 'none' }
  if (usable.length > 1) return { available: false, reason: 'ambiguous' }
  return { available: true, providerId: single.id }
}

/**
 * Resolve the selected provider or throw the matching {@link WebError}. Shares
 * the selection rules with {@link resolveStatus} so status and execution can
 * never disagree.
 */
function resolveProvider<P extends ResolvableProvider>(selection: Selection<P>): P {
  const { configuredId, providers } = selection
  if (configuredId !== undefined) {
    const provider = providers.get(configuredId)
    if (!provider) {
      throw new WebError(`configured web provider "${configuredId}" is not registered`, 'WEB_PROVIDER_CONFIGURED_MISSING')
    }
    if (!provider.status().available) {
      throw new WebError(`configured web provider "${configuredId}" is registered but unavailable`, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
    }
    return provider
  }
  const usable = [...providers.values()].filter(provider => provider.status().available)
  const [single] = usable
  if (single === undefined) {
    throw new WebError('no usable web provider is registered', 'WEB_PROVIDER_UNAVAILABLE')
  }
  if (usable.length > 1) {
    const ids = usable.map(provider => provider.id).join(', ')
    throw new WebError(`multiple usable web providers are registered (${ids}); configure one explicitly`, 'WEB_PROVIDER_AMBIGUOUS')
  }
  return single
}

/** Enforce `maxResults` on a search result: truncate `sources[]` and flag it. */
function capSources(result: WebSearchResult, maxResults: number | undefined): WebSearchResult {
  if (maxResults === undefined || result.sources.length <= maxResults) return result
  return { ...result, sources: result.sources.slice(0, maxResults), truncated: true }
}

export default WebService
