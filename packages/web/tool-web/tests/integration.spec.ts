/**
 * Integration: the real fetch backend (`dsh-web-fetch-local`) + a real search
 * provider (`dsh-web-search-exa`) + the real seam (`dsh-web`) + the model tool
 * (`dsh-tool-web`), exercised through `ctx.tools.execute()` — nothing bypasses
 * the tool registry. Fetch hits a real loopback HTTP server (verifying the
 * WORLD); search runs the real Exa provider over a stubbed global `fetch` (the
 * network is the one boundary we mock).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { Context } from 'cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import WebService from '@deepseek-ai/dsh-web'
import * as WebFetchLocal from '@deepseek-ai/dsh-web-fetch-local'
import * as WebSearchExa from '@deepseek-ai/dsh-web-search-exa'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'

type Handler = (req: IncomingMessage, res: ServerResponse) => void

let server: Server
let base: string
let handler: Handler
let ctx: Context
let fiber: Awaited<ReturnType<Context['plugin']>>

beforeEach(async () => {
  handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>Hello</h1><p>World</p>') }
  server = createServer((req, res) => { handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(WebService, { searchProvider: WebSearchExa.EXA_PROVIDER_ID, fetchProvider: WebFetchLocal.LOCAL_FETCH_PROVIDER_ID })
  await ctx.plugin(WebFetchLocal, {})
  await ctx.plugin(WebSearchExa, { apiKey: 'exa-key', baseURL: 'https://api.exa.test' })
  fiber = await ctx.plugin(ToolWeb)
})

afterEach(async () => {
  await fiber.dispose()
  vi.unstubAllGlobals()
  await new Promise<void>(resolve => server.close(() => { resolve() }))
})

let counter = 0
type ToolResult = { isError: boolean; content: { type: string; text?: string }[]; error?: { code: string } }
function call(name: string, args: unknown): Promise<ToolResult> {
  return ctx.tools.execute({ callId: CallId(`call-${++counter}`), name, arguments: args })
}

describe('web_fetch integration over the real backend', () => {
  it('fetches an html page and renders it to markdown', async () => {
    const out = await call('web_fetch', { url: base })
    expect(out.isError).toBe(false)
    const text = out.content.map(b => b.text).join('')
    expect(text).toContain(`Fetched ${base}`)
    expect(text).toContain('# Hello')
    expect(text).toContain('World')
  })

  it('reports a 404 as a result, not an error', async () => {
    handler = (_req, res) => { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('missing') }
    const out = await call('web_fetch', { url: base })
    expect(out.isError).toBe(false)
    expect(out.content.map(b => b.text).join('')).toContain('HTTP 404')
  })

  it('surfaces WEB_INVALID_URL as a structured tool error', async () => {
    const out = await call('web_fetch', { url: 'ftp://example.com' })
    expect(out.isError).toBe(true)
    expect(out.error?.code).toBe('WEB_INVALID_URL')
  })

  it('surfaces a blocked cross-origin redirect as WEB_REDIRECT_BLOCKED', async () => {
    handler = (_req, res) => { res.writeHead(302, { location: 'https://example.com/' }); res.end() }
    const out = await call('web_fetch', { url: base })
    expect(out.isError).toBe(true)
    expect(out.error?.code).toBe('WEB_REDIRECT_BLOCKED')
  })
})

describe('web_search integration over the real Exa provider', () => {
  it('runs web_search end-to-end and formats the provider result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ results: [{ url: 'https://result.test', title: 'Result', highlights: ['a highlight'] }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )))
    const out = await call('web_search', { query: 'deepseek' })
    expect(out.isError).toBe(false)
    expect(out.content.map(b => b.text).join('')).toContain('[Result](https://result.test)')
  })
})
