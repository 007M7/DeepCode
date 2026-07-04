import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import WebService, {
  WebError,
  type WebFetchProvider,
  type WebFetchResult,
  type WebProviderStatus,
  type WebSearchProvider,
  type WebSearchRequest,
  type WebSearchResult,
} from '@deepseek-ai/dsh-web'

/** A scripted search provider for contract tests. */
function makeSearchProvider(
  id: string,
  status: WebProviderStatus,
  search: (request: WebSearchRequest) => Promise<WebSearchResult>,
): WebSearchProvider {
  return { id, status: () => status, search: request => search(request) }
}

function makeFetchProvider(id: string, status: WebProviderStatus, result: WebFetchResult): WebFetchProvider {
  return { id, status: () => status, fetch: () => Promise.resolve(result) }
}

const available: WebProviderStatus = { available: true }
const unavailable: WebProviderStatus = { available: false, reason: 'missing-credential' }

function searchResult(providerId: string, overrides: Partial<WebSearchResult> = {}): WebSearchResult {
  return { providerId, query: 'q', sources: [], truncated: false, ...overrides }
}

function fetchResult(providerId: string): WebFetchResult {
  return { providerId, url: 'https://example.com', statusCode: 200, body: { kind: 'text', content: 'hi' }, truncated: false }
}

/** Mount a WebService on a fresh root context with the given config. */
async function mountWeb(config: ConstructorParameters<typeof WebService>[1] = {}): Promise<{ ctx: Context; web: WebService }> {
  const ctx = new Context()
  await ctx.plugin(WebService, config)
  return { ctx, web: ctx.web }
}

describe('WebService registration', () => {
  it('registers and disposes a search provider, emitting providers-change each way', async () => {
    const { ctx, web } = await mountWeb()
    const changed = vi.fn()
    ctx.on('web/providers-change', changed)

    const dispose = web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa'))))
    expect(changed).toHaveBeenCalledTimes(1)
    expect(web.searchStatus()).toEqual({ available: true, providerId: 'exa' })

    dispose()
    expect(changed).toHaveBeenCalledTimes(2)
    expect(web.searchStatus()).toEqual({ available: false, reason: 'none' })
  })

  it('throws WEB_DUPLICATE_PROVIDER on a duplicate search id', async () => {
    const { web } = await mountWeb()
    web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa'))))
    expect(() => web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa')))))
      .toThrow(expect.objectContaining({ code: 'WEB_DUPLICATE_PROVIDER' }))
  })

  it('keeps search and fetch id namespaces independent', async () => {
    const { web } = await mountWeb()
    web.registerSearchProvider(makeSearchProvider('shared', available, () => Promise.resolve(searchResult('shared'))))
    expect(() => web.registerFetchProvider(makeFetchProvider('shared', available, fetchResult('shared')))).not.toThrow()
  })

  it('rolls back a registration when a providers-change listener throws', async () => {
    const { ctx, web } = await mountWeb()
    ctx.on('web/providers-change', () => { throw new Error('listener boom') })
    expect(() => web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa')))))
      .toThrow('listener boom')
    // The throwing listener must not leave the provider in the registry.
    expect(web.searchStatus()).toEqual({ available: false, reason: 'none' })
  })

  it('disposes provider registrations when the contributing fiber is disposed (HMR safety)', async () => {
    const { ctx, web } = await mountWeb()
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa'))))
    }, { inject: ['web'] }))
    expect(web.searchStatus()).toEqual({ available: true, providerId: 'exa' })
    await fiber.dispose()
    expect(web.searchStatus()).toEqual({ available: false, reason: 'none' })
  })
})

describe('WebService selection status', () => {
  it('reports none when nothing is registered', async () => {
    const { web } = await mountWeb()
    expect(web.searchStatus()).toEqual({ available: false, reason: 'none' })
    expect(web.fetchStatus()).toEqual({ available: false, reason: 'none' })
  })

  it('auto-selects the single usable provider when no id is configured', async () => {
    const { web } = await mountWeb()
    web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa'))))
    expect(web.searchStatus()).toEqual({ available: true, providerId: 'exa' })
  })

  it('reports ambiguous when multiple usable providers exist and none is configured', async () => {
    const { web } = await mountWeb()
    web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa'))))
    web.registerSearchProvider(makeSearchProvider('perplexity', available, () => Promise.resolve(searchResult('perplexity'))))
    expect(web.searchStatus()).toEqual({ available: false, reason: 'ambiguous' })
  })

  it('ignores unusable providers when auto-selecting', async () => {
    const { web } = await mountWeb()
    web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa'))))
    web.registerSearchProvider(makeSearchProvider('perplexity', unavailable, () => Promise.resolve(searchResult('perplexity'))))
    expect(web.searchStatus()).toEqual({ available: true, providerId: 'exa' })
  })

  it('reports none when providers exist but none are usable', async () => {
    const { web } = await mountWeb()
    web.registerSearchProvider(makeSearchProvider('exa', unavailable, () => Promise.resolve(searchResult('exa'))))
    expect(web.searchStatus()).toEqual({ available: false, reason: 'none' })
  })

  it('honors a configured id over a different registered provider', async () => {
    const { web } = await mountWeb({ searchProvider: 'perplexity' })
    web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa'))))
    web.registerSearchProvider(makeSearchProvider('perplexity', available, () => Promise.resolve(searchResult('perplexity'))))
    expect(web.searchStatus()).toEqual({ available: true, providerId: 'perplexity' })
  })

  it('reports configured-missing when the configured id is not registered', async () => {
    const { web } = await mountWeb({ searchProvider: 'perplexity' })
    web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa'))))
    expect(web.searchStatus()).toEqual({ available: false, reason: 'configured-missing' })
  })

  it('reports configured-unavailable when the configured id is registered but unusable', async () => {
    const { web } = await mountWeb({ searchProvider: 'exa' })
    web.registerSearchProvider(makeSearchProvider('exa', unavailable, () => Promise.resolve(searchResult('exa'))))
    expect(web.searchStatus()).toEqual({ available: false, reason: 'configured-unavailable' })
  })

  it('does not let registration order change auto-selection', async () => {
    const a = await mountWeb()
    a.web.registerSearchProvider(makeSearchProvider('exa', unavailable, () => Promise.resolve(searchResult('exa'))))
    a.web.registerSearchProvider(makeSearchProvider('perplexity', available, () => Promise.resolve(searchResult('perplexity'))))
    expect(a.web.searchStatus()).toEqual({ available: true, providerId: 'perplexity' })

    const b = await mountWeb()
    b.web.registerSearchProvider(makeSearchProvider('perplexity', available, () => Promise.resolve(searchResult('perplexity'))))
    b.web.registerSearchProvider(makeSearchProvider('exa', unavailable, () => Promise.resolve(searchResult('exa'))))
    expect(b.web.searchStatus()).toEqual({ available: true, providerId: 'perplexity' })
  })
})

describe('WebService execution resolution', () => {
  it('throws WEB_PROVIDER_UNAVAILABLE when nothing is registered', async () => {
    const { web } = await mountWeb()
    await expect(web.search({ query: 'q' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_UNAVAILABLE' }))
  })

  it('throws WEB_PROVIDER_CONFIGURED_MISSING for an unregistered configured id', async () => {
    const { web } = await mountWeb({ searchProvider: 'perplexity' })
    web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa'))))
    await expect(web.search({ query: 'q' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('throws WEB_PROVIDER_CONFIGURED_UNAVAILABLE for an unusable configured id', async () => {
    const { web } = await mountWeb({ searchProvider: 'exa' })
    web.registerSearchProvider(makeSearchProvider('exa', unavailable, () => Promise.resolve(searchResult('exa'))))
    await expect(web.search({ query: 'q' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }))
  })

  it('throws WEB_PROVIDER_AMBIGUOUS rather than picking by order', async () => {
    const { web } = await mountWeb()
    web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa'))))
    web.registerSearchProvider(makeSearchProvider('perplexity', available, () => Promise.resolve(searchResult('perplexity'))))
    await expect(web.search({ query: 'q' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_AMBIGUOUS' }))
  })

  it('runs the selected provider and returns its result', async () => {
    const { web } = await mountWeb()
    web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(
      searchResult('exa', { content: 'answer', sources: [{ url: 'https://a' }] }),
    )))
    const result = await web.search({ query: 'q' })
    expect(result.providerId).toBe('exa')
    expect(result.content).toBe('answer')
    expect(result.sources).toEqual([{ url: 'https://a' }])
  })

  it('propagates the abort signal to the provider', async () => {
    const { web } = await mountWeb()
    const seen: (AbortSignal | undefined)[] = []
    web.registerSearchProvider({
      id: 'exa',
      status: () => available,
      search: (_request, exec) => { seen.push(exec?.signal); return Promise.resolve(searchResult('exa')) },
    })
    const controller = new AbortController()
    await web.search({ query: 'q' }, { signal: controller.signal })
    expect(seen[0]).toBe(controller.signal)
  })
})

describe('WebService maxResults enforcement', () => {
  it('truncates sources and sets truncated when a provider over-returns', async () => {
    const { web } = await mountWeb()
    web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa', {
      sources: [{ url: 'https://1' }, { url: 'https://2' }, { url: 'https://3' }],
    }))))
    const result = await web.search({ query: 'q', maxResults: 2 })
    expect(result.sources).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })

  it('leaves truncated false when within the bound', async () => {
    const { web } = await mountWeb()
    web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa', {
      sources: [{ url: 'https://1' }],
    }))))
    const result = await web.search({ query: 'q', maxResults: 8 })
    expect(result.sources).toHaveLength(1)
    expect(result.truncated).toBe(false)
  })

  it('does not bound when maxResults is omitted', async () => {
    const { web } = await mountWeb()
    web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa', {
      sources: [{ url: 'https://1' }, { url: 'https://2' }],
    }))))
    const result = await web.search({ query: 'q' })
    expect(result.sources).toHaveLength(2)
    expect(result.truncated).toBe(false)
  })
})

describe('WebService fetch capability', () => {
  it('resolves and runs the fetch provider independently of search', async () => {
    const { web } = await mountWeb()
    web.registerFetchProvider(makeFetchProvider('local-http', available, fetchResult('local-http')))
    const result = await web.fetch({ url: 'https://example.com' })
    expect(result.providerId).toBe('local-http')
    expect(result.statusCode).toBe(200)
  })

  it('throws WEB_PROVIDER_UNAVAILABLE for fetch when no fetch provider is registered', async () => {
    const { web } = await mountWeb()
    web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa'))))
    await expect(web.fetch({ url: 'https://example.com' })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_PROVIDER_UNAVAILABLE' }),
    )
  })
})

describe('WebError', () => {
  it('is a HarnessError carrying its code', () => {
    const error = new WebError('boom', 'WEB_INVALID_URL')
    expect(error.code).toBe('WEB_INVALID_URL')
    expect(error.name).toBe('WebError')
  })
})
