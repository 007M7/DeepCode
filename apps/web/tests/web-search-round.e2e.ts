// Web e2e scenario for the shipped default search composition. A real browser
// drives `web_search`; the model stream is replayed while the real DeepSeek
// provider calls a deterministic local Anthropic-compatible endpoint through
// the real credentials service.
import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, recordFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/web-search-round', import.meta.url))
const FIXTURE = fileURLToPath(new URL('./snapshots/web-search-round/session.jsonl', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./snapshots/web-search-round/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const QUERY = 'DeepSeek Harness snapshot search'
const PROMPT = `Use web_search to search exactly "${QUERY}". Then reply exactly SEARCH_DONE and stop.`
const SEARCH_CREDENTIAL_REF = credentialRef('DSH_WEB_SEARCH_E2E_KEY')
const SEARCH_CREDENTIAL = 'snapshot-search-key'
const RESULT_URL = 'https://docs.example.test/search'

interface CapturedSearchRequest {
  path: string
  apiKey: string | undefined
  body: unknown
}

/** Start the deterministic DeepSeek Messages double used by the real provider. */
async function startSearchServer(captured: CapturedSearchRequest[]): Promise<{ server: Server; baseURL: string }> {
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      captured.push({
        path: request.url ?? '',
        apiKey: typeof request.headers['x-api-key'] === 'string' ? request.headers['x-api-key'] : undefined,
        body: JSON.parse(body) as unknown,
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        content: [
          {
            type: 'text',
            text: 'Found one source.',
            citations: [{
              type: 'web_search_result_location',
              url: RESULT_URL,
              cited_text: 'Snapshot search excerpt.',
            }],
          },
          {
            type: 'web_search_tool_result',
            content: [{
              type: 'web_search_result',
              url: RESULT_URL,
              title: 'Snapshot Search Result',
              page_age: '2026-07-31',
            }],
          },
        ],
      }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  return { server, baseURL: `http://127.0.0.1:${address.port}` }
}

describe('web e2e: shipped default web search', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let searchServer: Server | undefined
  let searchBaseURL: string
  let tripwire: ReturnType<typeof watchConsole>
  const searchRequests: CapturedSearchRequest[] = []
  const sessionEvents: SessionEvent[] = []

  beforeAll(async () => {
    const search = await startSearchServer(searchRequests)
    searchServer = search.server
    searchBaseURL = search.baseURL
    scaffold = await launchWebScaffold({
      deepSeekSearch: {
        baseURL: search.baseURL,
        apiKeyEnv: SEARCH_CREDENTIAL_REF,
      },
      ...(MODE === 'record' ? {} : { replayFixture: FIXTURE, paceMs: 15 }),
    })
    await scaffold.ctx.credentials.set(SEARCH_CREDENTIAL_REF, SEARCH_CREDENTIAL)
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await new Promise<void>((resolve, reject) => {
      if (searchServer === undefined) {
        resolve()
        return
      }
      searchServer.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
  })

  it('drives the recorded search to a settled turn (all modes)', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-search-drive'))
    if (MODE !== 'record') {
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    }
    const input = page.locator('textarea').first()
    await input.waitFor({ timeout: 10_000 })
    const settled = scaffold.whenTurnSettled()
    await input.fill(PROMPT)
    await input.press('Enter')
    const sessionId = await settled
    if (MODE === 'record') await recordFixture(scaffold, sessionId, FIXTURE)
  }, 200_000)

  it.skipIf(MODE === 'record')('uses the real provider and persists the structured result', () => {
    expect(searchRequests).toHaveLength(1)
    expect(searchRequests[0]).toMatchObject({
      path: '/messages',
      apiKey: SEARCH_CREDENTIAL,
      body: {
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: `Perform a web search for the query: ${QUERY}` }],
        }],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      },
    })

    const auxiliaryRequest = sessionEvents.find(
      (event): event is Extract<SessionEvent, { type: 'web/deepseek-search-llm-request' }> =>
        event.type === 'web/deepseek-search-llm-request',
    )
    expect(auxiliaryRequest?.data).toEqual({
      endpoint: `${searchBaseURL}/messages`,
      apiVersion: '2023-06-01',
      body: searchRequests[0]?.body,
    })

    const searchCall = sessionEvents.find(
      (event): event is Extract<SessionEvent, { type: 'tool/call' }> =>
        event.type === 'tool/call' && event.data.name === 'web_search',
    )
    if (searchCall === undefined) throw new Error('the replayed turn did not call web_search')
    const searchResult = sessionEvents.find(
      (event): event is Extract<SessionEvent, { type: 'tool/result' }> =>
        event.type === 'tool/result' && event.data.message.source.callId === searchCall.data.callId,
    )
    if (searchResult === undefined) throw new Error('web_search produced no durable result')
    const content = searchResult.data.message.content[0]
    expect(content.isError).toBe(false)
    expect(content.content.filter(block => block.type === 'text').map(block => block.text).join(''))
      .toContain(`[Snapshot Search Result](${RESULT_URL})`)
    expect(searchResult.data.meta).toMatchObject({
      sources: [{
        url: RESULT_URL,
        title: 'Snapshot Search Result',
        snippet: 'Snapshot search excerpt.',
        publishedAt: '2026-07-31',
      }],
      truncated: false,
    })
  })

  it.skipIf(MODE === 'record')('matches the settled search card aria golden', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-search-aria'))
    await expect.poll(() => page.getByText('SEARCH_DONE', { exact: true }).count(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1)
    await page.locator('[data-tool="web_search"]').waitFor({ timeout: 10_000 })
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
  })

  it.skipIf(MODE === 'record')('stayed clean and kept the exact fixture inventory', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.jsonl', 'ui.expected.md'])
  })
})
