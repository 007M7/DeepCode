import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import WebService from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchResult, WebProviderStatus } from '@deepseek-ai/dsh-web'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'
import {
  formatSearchOutput,
  formatFetchOutput,
  parseSearchArgs,
  parseFetchArgs,
  presentSearchCall,
  presentFetchCall,
  renderBody,
  htmlToMarkdown,
} from '@deepseek-ai/dsh-tool-web'

const available: WebProviderStatus = { available: true }

function searchProvider(result: WebSearchResult, status: WebProviderStatus = available): WebSearchProvider {
  return { id: 'stub-search', status: () => status, search: () => Promise.resolve(result) }
}

/** Mount the real registry, seam, and tool-web; return an executor helper. */
async function mountTools(opts: {
  config?: ToolWeb.Config
  webConfig?: ConstructorParameters<typeof WebService>[1]
  search?: WebSearchProvider
  fetchProvider?: import('@deepseek-ai/dsh-web').WebFetchProvider
} = {}): Promise<{ ctx: Context; fiber: Awaited<ReturnType<Context['plugin']>>; call: (name: string, args: unknown) => Promise<{ isError: boolean; content: { type: string; text?: string }[]; error?: { code: string } }> }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(WebService, opts.webConfig ?? {})
  if (opts.search) ctx.web.registerSearchProvider(opts.search)
  if (opts.fetchProvider) ctx.web.registerFetchProvider(opts.fetchProvider)
  const fiber = await ctx.plugin(ToolWeb, opts.config ?? {})
  let counter = 0
  const call = (name: string, args: unknown) => ctx.tools.execute({ callId: CallId(`call-${++counter}`), name, arguments: args }) as never
  return { ctx, fiber, call }
}

describe('search formatting', () => {
  it('renders content, sources with titles/hostnames, snippets, and a citation reminder', () => {
    const out = formatSearchOutput({
      providerId: 'p', query: 'q', content: 'an answer', truncated: false,
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
    expect(formatSearchOutput({ providerId: 'p', query: 'q', sources: [], truncated: false }))
      .toContain('No results found.')
  })

  it('renders content alone when there are no sources', () => {
    const out = formatSearchOutput({ providerId: 'p', query: 'q', content: 'just an answer', sources: [], truncated: false })
    expect(out).toContain('just an answer')
    expect(out).not.toContain('No results found.')
    expect(out).not.toContain('Sources:')
  })

  it('notes truncation', () => {
    const out = formatSearchOutput({ providerId: 'p', query: 'q', sources: [{ url: 'https://a.test' }], truncated: true })
    expect(out).toContain('Showing the first 1 sources')
  })

  it('validates the query', () => {
    expect(() => parseSearchArgs({ query: '   ' })).toThrow('non-empty')
    expect(parseSearchArgs({ query: 'hi' })).toEqual({ query: 'hi' })
  })

  it('presents a search call as a search-kind card titled by the query', () => {
    expect(presentSearchCall({ query: 'find me' })).toEqual({ card: 'generic', title: 'find me', kind: 'search', rawInput: 'find me' })
  })
})

describe('fetch formatting', () => {
  it('renders an html body to markdown text with a status header', () => {
    const out = formatFetchOutput({
      providerId: 'p', url: 'https://a.test', statusCode: 200, truncated: false,
      body: { kind: 'html', content: '<h1>Title</h1><p>Body text</p>' },
    })
    expect(out).toContain('Fetched https://a.test (HTTP 200)')
    expect(out).toContain('# Title')
    expect(out).toContain('Body text')
  })

  it('passes a text body through and notes truncation', () => {
    const out = formatFetchOutput({
      providerId: 'p', url: 'https://a.test', statusCode: 200, truncated: true,
      body: { kind: 'text', content: 'plain' },
    })
    expect(out).toContain('plain')
    expect(out).toContain('Content truncated')
  })

  it('renderBody dispatches on kind', () => {
    expect(renderBody({ kind: 'text', content: 'x' })).toBe('x')
    expect(renderBody({ kind: 'html', content: '<p>y</p>' })).toBe('y')
  })

  it('validates url and timeout', () => {
    expect(() => parseFetchArgs({ url: ' ' })).toThrow('non-empty')
    expect(() => parseFetchArgs({ url: 'https://a.test', timeout_ms: -1 })).toThrow('positive')
    expect(parseFetchArgs({ url: 'https://a.test', timeout_ms: 5 })).toEqual({ url: 'https://a.test', timeoutMs: 5 })
  })

  it('presents a fetch call as a fetch-kind card titled by the url', () => {
    expect(presentFetchCall({ url: 'https://a.test' })).toEqual({ card: 'generic', title: 'https://a.test', kind: 'fetch', rawInput: 'https://a.test' })
  })
})

describe('htmlToMarkdown', () => {
  it('drops scripts/styles, keeps text, decodes entities, converts links', () => {
    const md = htmlToMarkdown('<style>.x{}</style><script>bad()</script><p>Tom &amp; Jerry</p><a href="https://a.test">link</a>')
    expect(md).not.toContain('bad()')
    expect(md).not.toContain('.x{}')
    expect(md).toContain('Tom & Jerry')
    expect(md).toContain('[link](https://a.test)')
  })

  it('decodes numeric entities and collapses whitespace', () => {
    expect(htmlToMarkdown('<p>a&#39;b</p>')).toBe("a'b")
    expect(htmlToMarkdown('<div>x</div>\n\n\n<div>y</div>')).toBe('x\n\ny')
  })

  it('decodes hex entities and named entities, and leaves unknown/out-of-range ones intact', () => {
    expect(htmlToMarkdown('<p>&#x41;&#X42;</p>')).toBe('AB')
    expect(htmlToMarkdown('<p>&copy; &mdash;</p>')).toBe('© —')
    expect(htmlToMarkdown('<p>&notareal;</p>')).toBe('&notareal;')
    // An out-of-range code point keeps the original entity text (fromCodePoint fallback).
    expect(htmlToMarkdown('<p>&#x110000;</p>')).toBe('&#x110000;')
    expect(htmlToMarkdown('<p>&#1114112;</p>')).toBe('&#1114112;')
  })

  it('renders a link with an empty label as its bare href', () => {
    expect(htmlToMarkdown('<a href="https://a.test"></a>')).toBe('https://a.test')
  })

  it('converts headings and list items to markdown', () => {
    expect(htmlToMarkdown('<h2>Heading</h2><p>after</p>')).toContain('## Heading')
    const list = htmlToMarkdown('<ul><li>one</li><li>two</li></ul>')
    expect(list).toContain('- one')
    expect(list).toContain('- two')
  })

  it('falls back to the raw URL as a source label when the URL is unparseable', () => {
    const out = formatSearchOutput({ providerId: 'p', query: 'q', truncated: false, sources: [{ url: 'not a url' }] })
    expect(out).toContain('[not a url](not a url)')
  })
})

describe('tool-web registration', () => {
  it('registers both tools by default', async () => {
    const { fiber, ctx } = await mountTools()
    const names = ctx.tools.schemas().map(s => s.name)
    expect(names).toContain('web_search')
    expect(names).toContain('web_fetch')
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
    const { fiber, ctx } = await mountTools()
    expect(ctx.tools.schemas().map(s => s.name)).toContain('web_search')
    expect(ctx.web.searchStatus()).toEqual({ available: false, reason: 'none' })
    await fiber.dispose()
  })

  it('contributes prompt sections for the enabled tools', async () => {
    const { fiber, ctx } = await mountTools()
    const prompt = await ctx.systemPrompt.assemble()
    const text = prompt.sections.map(s => (typeof s.text === 'function' ? s.text() : s.text)).join('\n')
    expect(text).toContain('web_search')
    expect(text).toContain('web_fetch')
    await fiber.dispose()
  })
})

describe('tool-web execution through the real registry', () => {
  it('executes web_search and formats the result', async () => {
    const result: WebSearchResult = {
      providerId: 'stub-search', query: 'q', content: 'answer', truncated: false,
      sources: [{ url: 'https://a.test', title: 'A', snippet: 'snip' }],
    }
    const { fiber, call } = await mountTools({ webConfig: { searchProvider: 'stub-search' }, search: searchProvider(result) })
    const out = await call('web_search', { query: 'q' })
    expect(out.isError).toBe(false)
    expect(out.content.map(b => b.text).join('')).toContain('[A](https://a.test)')
    await fiber.dispose()
  })

  it('surfaces a structured WebError when no provider is available', async () => {
    const { fiber, call } = await mountTools()
    const out = await call('web_search', { query: 'q' })
    expect(out.isError).toBe(true)
    expect(out.error?.code).toBe('WEB_PROVIDER_UNAVAILABLE')
    await fiber.dispose()
  })

  it('surfaces WEB_PROVIDER_AMBIGUOUS for multiple unconfigured providers', async () => {
    const { ctx, fiber, call } = await mountTools({ search: searchProvider({ providerId: 'stub-search', query: 'q', sources: [], truncated: false }) })
    ctx.web.registerSearchProvider({ id: 'other', status: () => available, search: () => Promise.resolve({ providerId: 'other', query: 'q', sources: [], truncated: false }) })
    const out = await call('web_search', { query: 'q' })
    expect(out.isError).toBe(true)
    expect(out.error?.code).toBe('WEB_PROVIDER_AMBIGUOUS')
    await fiber.dispose()
  })

  it('rejects invalid arguments with a structured INVALID_ARGS error', async () => {
    const { fiber, call } = await mountTools({ webConfig: { searchProvider: 'stub-search' }, search: searchProvider({ providerId: 'stub-search', query: 'q', sources: [], truncated: false }) })
    const out = await call('web_search', { query: 123 })
    expect(out.isError).toBe(true)
    expect(out.error?.code).toBe('INVALID_ARGS')
    await fiber.dispose()
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in ToolWeb).toBe(false)
  })

  it('executes web_fetch, forwarding timeout_ms and the abort signal to the seam', async () => {
    const seen: { request?: { url: string; timeoutMs?: number }; signal?: AbortSignal | undefined } = {}
    const fetchProvider = {
      id: 'stub-fetch',
      status: () => available,
      fetch: (request: { url: string; timeoutMs?: number }, exec?: { signal?: AbortSignal }) => {
        seen.request = request
        seen.signal = exec?.signal
        return Promise.resolve({ providerId: 'stub-fetch', url: request.url, statusCode: 200, body: { kind: 'text' as const, content: 'ok' }, truncated: false })
      },
    }
    const { ctx, fiber } = await mountTools({ webConfig: { fetchProvider: 'stub-fetch' }, fetchProvider })
    const controller = new AbortController()
    const out = await ctx.tools.execute({ callId: CallId('fetch-1'), name: 'web_fetch', arguments: { url: 'https://a.test', timeout_ms: 1234 }, signal: controller.signal })
    expect(out.isError).toBe(false)
    expect(seen.request).toEqual({ url: 'https://a.test', timeoutMs: 1234 })
    expect(seen.signal).toBe(controller.signal)
    await fiber.dispose()
  })

  it('executes web_search, forwarding the abort signal to the seam', async () => {
    const seen: { signal?: AbortSignal | undefined } = {}
    const provider: WebSearchProvider = {
      id: 'stub-search',
      status: () => available,
      search: (_request, exec) => { seen.signal = exec?.signal; return Promise.resolve({ providerId: 'stub-search', query: 'q', sources: [], truncated: false }) },
    }
    const { ctx, fiber } = await mountTools({ webConfig: { searchProvider: 'stub-search' }, search: provider })
    const controller = new AbortController()
    await ctx.tools.execute({ callId: CallId('search-1'), name: 'web_search', arguments: { query: 'q' }, signal: controller.signal })
    expect(seen.signal).toBe(controller.signal)
    await fiber.dispose()
  })
})
