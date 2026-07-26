import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import WebService from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchResult } from '@deepseek-ai/dsh-web'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'
import {
  formatSearchOutput,
  formatFetchOutput,
  parseSearchArgs,
  parseFetchArgs,
  presentSearchCall,
  presentFetchCall,
  renderBody,
  WEB_SEARCH_MAX_RESULTS,
} from '@deepseek-ai/dsh-tool-web'

const testToolSignal = new AbortController().signal

const available = true

function searchProvider(result: WebSearchResult, isAvailable = available): WebSearchProvider {
  return { id: 'stub-search', available: () => isAvailable, search: () => Promise.resolve(result) }
}

/** Mount the real registry, seam, and tool-web; return an executor helper. */
async function mountTools(opts: {
  config?: ToolWeb.Config
  webConfig?: ConstructorParameters<typeof WebService>[1]
  search?: WebSearchProvider
  fetchProvider?: import('@deepseek-ai/dsh-web').WebFetchProvider
} = {}): Promise<{ ctx: Context; fiber: Awaited<ReturnType<Context['plugin']>>; call: (name: string, args: unknown) => Promise<ToolExecutionResult> }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(WebService, opts.webConfig ?? {})
  if (opts.search) ctx.web.registerSearchProvider(opts.search)
  if (opts.fetchProvider) ctx.web.registerFetchProvider(opts.fetchProvider)
  const fiber = await ctx.plugin(ToolWeb, opts.config ?? {})
  let counter = 0
  const call = (name: string, args: unknown) => ctx.tools.execute({ signal: testToolSignal, callId: CallId(`call-${++counter}`), name, arguments: args })
  return { ctx, fiber, call }
}

describe('search formatting', () => {
  it('renders content, sources with titles/hostnames, snippets, and a citation reminder', () => {
    const out = formatSearchOutput({
      content: 'an answer', truncated: false,
      sources: [
        { url: 'https://a.test/x', title: 'A', snippet: 'about a', publishedAt: '2026-01-01' },
        { url: 'https://b.test/y' },
      ],
    })
    expect(out).toContain('an answer')
    expect(out).toContain('[A](https://a.test/x) — about a (2026-01-01)')
    expect(out).toContain('[b.test](https://b.test/y)')
    expect(out).toContain('Cite the relevant URLs')
  })

  it('reports no results when there is neither content nor sources', () => {
    expect(formatSearchOutput({ sources: [], truncated: false }))
      .toContain('No results found.')
  })

  it('renders content alone when there are no sources', () => {
    const out = formatSearchOutput({ content: 'just an answer', sources: [], truncated: false })
    expect(out).toContain('just an answer')
    expect(out).not.toContain('No results found.')
    expect(out).not.toContain('Sources:')
  })

  it('notes truncation', () => {
    const out = formatSearchOutput({ sources: [{ url: 'https://a.test' }], truncated: true })
    expect(out).toContain('Showing the first 1 sources')
  })

  it('validates the query', () => {
    expect(() => parseSearchArgs({ query: '   ' })).toThrow('non-empty')
    expect(parseSearchArgs({ query: 'hi' })).toEqual({ query: 'hi' })
  })

  it('falls back to the raw URL as a source label when the URL is unparseable', () => {
    const out = formatSearchOutput({ truncated: false, sources: [{ url: 'not a url' }] })
    expect(out).toContain('[not a url](not a url)')
  })

  it('presents a search call as a search-kind card titled by the query', () => {
    expect(presentSearchCall({ query: 'find me' })).toEqual({ card: 'generic', title: 'find me', kind: 'search', rawInput: 'find me' })
  })
})

describe('fetch formatting', () => {
  it('renders an html body to markdown text with a status header', () => {
    const out = formatFetchOutput({
      url: 'https://a.test', statusCode: 200, truncated: false,
      body: { kind: 'html', content: '<h1>Title</h1><p>Body text</p>' },
    })
    expect(out).toContain('Fetched https://a.test (HTTP 200)')
    expect(out).toContain('# Title')
    expect(out).toContain('Body text')
  })

  it('passes a text body through and notes truncation', () => {
    const out = formatFetchOutput({
      url: 'https://a.test', statusCode: 200, truncated: true,
      body: { kind: 'text', content: 'plain' },
    })
    expect(out).toContain('plain')
    expect(out).toContain('Content truncated')
  })

  it('renderBody dispatches on kind', () => {
    expect(renderBody({ kind: 'text', content: 'x' })).toBe('x')
    expect(renderBody({ kind: 'html', content: '<p>y</p>' })).toBe('y')
  })

  it('converts html via turndown: entities, links, tables, nesting; drops script/style/noscript', () => {
    expect(renderBody({
      kind: 'html',
      content: '<style>.x{}</style><script>bad()</script><noscript>ns</noscript><p>Tom &amp; Jerry &copy; R&eacute;sum&eacute;</p><a href="https://a.test">link</a>',
    })).toBe('Tom & Jerry © Résumé\n\n[link](https://a.test)')
    expect(renderBody({ kind: 'html', content: '<h2>Heading</h2><ul><li>one</li><li>two</li></ul>' }))
      .toBe('## Heading\n\n-   one\n-   two')
    expect(renderBody({ kind: 'html', content: '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>' }))
      .toBe('| A   | B   |\n| --- | --- |\n| 1   | 2   |')
    expect(renderBody({ kind: 'html', content: '<p><strong>bold <em>italic</em></strong></p><blockquote><p>quoted</p></blockquote>' }))
      .toBe('**bold _italic_**\n\n> quoted')
  })

  it('falls back to the raw html body when turndown throws on pathological nesting', { timeout: 60_000 }, () => {
    // Nesting past V8's default stack overflows turndown/domino's recursive
    // walk with a RangeError (measured: 4k levels throw on the main thread,
    // 8k in a worker); 20k adds margin over either stack size. The raw body
    // must pass through instead of throwing.
    const depth = 20_000
    const pathological = '<div>'.repeat(depth) + 'x' + '</div>'.repeat(depth)
    expect(renderBody({ kind: 'html', content: pathological })).toBe(pathological)
  })

  it('validates url (non-empty), no timeout parameter', () => {
    expect(() => parseFetchArgs({ url: ' ' })).toThrow('non-empty')
    expect(parseFetchArgs({ url: 'https://a.test' })).toEqual({ url: 'https://a.test' })
  })

  it('presents a fetch call as a fetch-kind card titled by the url', () => {
    expect(presentFetchCall({ url: 'https://a.test' })).toEqual({ card: 'generic', title: 'https://a.test', kind: 'fetch', rawInput: 'https://a.test' })
  })
})

describe('tool-web registration', () => {
  it('registers both tools by default', async () => {
    const { fiber, ctx } = await mountTools()
    const names = ctx.tools.schemas().map(s => s.name)
    expect(names).toContain('web_search')
    expect(names).toContain('web_fetch')
    expect(ctx.tools.executionMode({ signal: testToolSignal, callId: CallId('search-safe'), name: 'web_search', arguments: { query: 'q' } }))
      .toEqual({ kind: 'parallel' })
    expect(ctx.tools.executionMode({ signal: testToolSignal, callId: CallId('fetch-safe'), name: 'web_fetch', arguments: { url: 'https://a.test' } }))
      .toEqual({ kind: 'parallel' })
    await fiber.dispose()
    expect(ctx.tools.schemas().map(s => s.name)).not.toContain('web_search')
  })

  it('registers only enabled tools', async () => {
    const { fiber, ctx } = await mountTools({ config: { search: true, fetch: false } })
    const names = ctx.tools.schemas().map(s => s.name)
    expect(names).toContain('web_search')
    expect(names).not.toContain('web_fetch')
    await fiber.dispose()
  })

  it('registers only web_fetch when search is disabled', async () => {
    const { fiber, ctx } = await mountTools({ config: { search: false, fetch: true } })
    const names = ctx.tools.schemas().map(s => s.name)
    expect(names).not.toContain('web_search')
    expect(names).toContain('web_fetch')
    await fiber.dispose()
  })

  it('registers web_search even when no provider is available (schema follows enablement, not availability)', async () => {
    const { fiber, ctx, call } = await mountTools()
    expect(ctx.tools.schemas().map(s => s.name)).toContain('web_search')
    // No provider is registered: the schema stays visible and execution reports
    // the structured unavailability instead.
    const out = await call('web_search', { query: 'q' })
    expect(out.error?.info?.code).toBe('WEB_PROVIDER_UNAVAILABLE')
    await fiber.dispose()
  })

  it('contributes prompt sections for the enabled tools', async () => {
    const { fiber, ctx } = await mountTools()
    const prompt = await ctx.systemPrompt.assemble()
    const text = prompt.sections.map(s => s.text).join('\n')
    expect(text).toContain('web_search')
    expect(text).toContain('web_fetch')
    await fiber.dispose()
  })
})

describe('tool-web execution through the real registry', () => {
  it('executes web_search and formats the result', async () => {
    const result: WebSearchResult = {
      content: 'answer', truncated: false,
      sources: [{ url: 'https://a.test', title: 'A', snippet: 'snip', publishedAt: '2026-07-20' }],
    }
    const { fiber, call } = await mountTools({ webConfig: { searchProvider: 'stub-search' }, search: searchProvider(result) })
    const out = await call('web_search', { query: 'q' })
    expect(out.isError).toBe(false)
    expect(out.value).toEqual(result)
    expect(out.content.map(b => b.type === 'text' ? b.text : '').join('')).toContain('[A](https://a.test)')
    await fiber.dispose()
  })

  it('surfaces a structured WebError when no provider is available', async () => {
    const { fiber, call } = await mountTools()
    const out = await call('web_search', { query: 'q' })
    expect(out.isError).toBe(true)
    expect(out.error?.info?.code).toBe('WEB_PROVIDER_UNAVAILABLE')
    await fiber.dispose()
  })

  it('surfaces WEB_PROVIDER_AMBIGUOUS for multiple unconfigured providers', async () => {
    const { ctx, fiber, call } = await mountTools({ search: searchProvider({ sources: [], truncated: false }) })
    ctx.web.registerSearchProvider({ id: 'other', available: () => available, search: () => Promise.resolve({ sources: [], truncated: false }) })
    const out = await call('web_search', { query: 'q' })
    expect(out.isError).toBe(true)
    expect(out.error?.info?.code).toBe('WEB_PROVIDER_AMBIGUOUS')
    await fiber.dispose()
  })

  it('rejects invalid arguments with a structured INVALID_ARGS error', async () => {
    const { fiber, call } = await mountTools({ webConfig: { searchProvider: 'stub-search' }, search: searchProvider({ sources: [], truncated: false }) })
    const out = await call('web_search', { query: 123 })
    expect(out.isError).toBe(true)
    expect(out.error?.info?.code).toBe('INVALID_ARGS')
    await fiber.dispose()
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in ToolWeb).toBe(false)
  })

  it('executes web_fetch, forwarding the url (no timeout param) and the abort signal to the seam', async () => {
    const seen: { request?: { url: string }; signal?: AbortSignal | undefined } = {}
    const fetchProvider = {
      id: 'stub-fetch',
      available: () => available,
      fetch: (request: { url: string }, signal?: AbortSignal) => {
        seen.request = request
        seen.signal = signal
        return Promise.resolve({ url: request.url, statusCode: 200, body: { kind: 'text' as const, content: 'ok' }, truncated: false })
      },
    }
    const { ctx, fiber } = await mountTools({ webConfig: { fetchProvider: 'stub-fetch' }, fetchProvider })
    const controller = new AbortController()
    const out = await ctx.tools.execute({ callId: CallId('fetch-1'), name: 'web_fetch', arguments: { url: 'https://a.test' }, signal: controller.signal })
    expect(out.isError).toBe(false)
    expect(out.value).toEqual({
      url: 'https://a.test',
      statusCode: 200,
      body: { kind: 'text', content: 'ok' },
      truncated: false,
    })
    // The model schema exposes no timeout: the tool forwards only the url; the
    // tool-call budget is owned by dsh-timeout-policy over exec.signal.
    expect(seen.request).toEqual({ url: 'https://a.test' })
    expect(seen.signal).toBe(controller.signal)
    await fiber.dispose()
  })

  it('forwards the required caller signal to web_fetch', async () => {
    const seen: { signal?: AbortSignal | undefined; passedSignal?: boolean } = {}
    const fetchProvider = {
      id: 'stub-fetch',
      available: () => available,
      fetch: (request: { url: string }, signal?: AbortSignal) => {
        seen.passedSignal = signal !== undefined
        seen.signal = signal
        return Promise.resolve({ url: request.url, statusCode: 200, body: { kind: 'text' as const, content: 'ok' }, truncated: false })
      },
    }
    const { ctx, fiber } = await mountTools({ webConfig: { fetchProvider: 'stub-fetch' }, fetchProvider })
    const out = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('fetch-2'), name: 'web_fetch', arguments: { url: 'https://a.test' } })
    expect(out.isError).toBe(false)
    expect(out.value).toEqual({
      url: 'https://a.test',
      statusCode: 200,
      body: { kind: 'text', content: 'ok' },
      truncated: false,
    })
    expect(seen.passedSignal).toBe(true)
    expect(seen.signal).toBe(testToolSignal)
    await fiber.dispose()
  })

  it('executes web_search, forwarding the abort signal to the seam', async () => {
    const seen: { signal?: AbortSignal | undefined } = {}
    const provider: WebSearchProvider = {
      id: 'stub-search',
      available: () => available,
      search: (_request, signal) => { seen.signal = signal; return Promise.resolve({ sources: [], truncated: false }) },
    }
    const { ctx, fiber } = await mountTools({ webConfig: { searchProvider: 'stub-search' }, search: provider })
    const controller = new AbortController()
    await ctx.tools.execute({ callId: CallId('search-1'), name: 'web_search', arguments: { query: 'q' }, signal: controller.signal })
    expect(seen.signal).toBe(controller.signal)
    await fiber.dispose()
  })
})

describe('searchMaxResults is plugin config', () => {
  it('forwards the default cap to the seam when unconfigured', async () => {
    const seen: { maxResults?: number | undefined } = {}
    const provider: WebSearchProvider = {
      id: 'stub-search',
      available: () => available,
      search: (request) => { seen.maxResults = request.maxResults; return Promise.resolve({ sources: [], truncated: false }) },
    }
    const { fiber, call } = await mountTools({ webConfig: { searchProvider: 'stub-search' }, search: provider })
    await call('web_search', { query: 'q' })
    expect(seen.maxResults).toBe(WEB_SEARCH_MAX_RESULTS)
    await fiber.dispose()
  })

  it('forwards a configured cap to the seam, which enforces it', async () => {
    const sources = Array.from({ length: 5 }, (_, i) => ({ url: `https://s${i}.test` }))
    const provider: WebSearchProvider = {
      id: 'stub-search',
      available: () => available,
      search: () => Promise.resolve({ sources, truncated: false }),
    }
    const { fiber, call } = await mountTools({ config: { searchMaxResults: 2 }, webConfig: { searchProvider: 'stub-search' }, search: provider })
    const out = await call('web_search', { query: 'q' })
    expect(out.isError).toBe(false)
    const body = out.content.map(b => b.type === 'text' ? b.text : '').join('')
    expect(body).toContain('https://s1.test')
    expect(body).not.toContain('https://s2.test')
    expect(body).toContain('Showing the first 2 sources.')
    await fiber.dispose()
  })

  it.each([
    ['zero', 0],
    ['negative', -3],
    ['fractional', 1.5],
  ])('rejects a %s searchMaxResults at load', async (_label, value) => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(WebService, {})
    await expect(ctx.plugin(ToolWeb, { searchMaxResults: value }))
      .rejects.toThrow(/tool-web: searchMaxResults must be a positive integer/)
  })
})

describe('tool-call timeout budget is plugin config', () => {
  it('attaches the default 30s budget to web_fetch and web_search', async () => {
    const { fiber, ctx } = await mountTools()
    expect(ctx.tools.get('web_fetch')?.timeoutMs).toBe(30_000)
    expect(ctx.tools.get('web_search')?.timeoutMs).toBe(30_000)
    await fiber.dispose()
  })

  it('honors per-tool timeout overrides from config', async () => {
    const { fiber, ctx } = await mountTools({ config: { fetchTimeoutMs: 60_000, searchTimeoutMs: 10_000 } })
    expect(ctx.tools.get('web_fetch')?.timeoutMs).toBe(60_000)
    expect(ctx.tools.get('web_search')?.timeoutMs).toBe(10_000)
    await fiber.dispose()
  })

  it.each([
    ['fetchTimeoutMs', { fetchTimeoutMs: 0 }],
    ['searchTimeoutMs', { searchTimeoutMs: -5 }],
  ])('rejects a non-positive-integer %s at load', async (key, config) => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(WebService, {})
    await expect(ctx.plugin(ToolWeb, config))
      .rejects.toThrow(new RegExp(`tool-web: ${key} must be a positive integer`))
  })
})
