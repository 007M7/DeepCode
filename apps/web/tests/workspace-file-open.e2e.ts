// Web e2e scenario: clicking a tool row's file path opens that file in a new
// browser tab, served by the web transport's own /f route. Cold-seeds the
// seeded-history fixture (zero model calls). The surface package tests can
// assert which opener the click reaches, but only the assembled application
// proves the opened URL actually serves the workspace file — the whole point
// of the route (docs/testing.md snapshot rule).
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  fixtureUserPrompts, launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

// Borrowed read-only: this scenario needs any settled turn whose tool rows
// carry a workspace file path, not a new recording (message-actions pattern).
const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'workspace-file-open-web-e2e'

const PROMPT = 'Use the read tool twice in one assistant message: read a.txt and b.txt. Then reply with the single word DONE and stop.'

describe('web e2e: opening a workspace file from a tool row', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    // The seeded Session's cwd is the scaffold workspace itself; the recording's
    // own nested directory is written too, so the seed's paths stay resolvable.
    await mkdir(join(scaffold.workspaceCwd, 'workspace'), { recursive: true })
    for (const dir of [scaffold.workspaceCwd, join(scaffold.workspaceCwd, 'workspace')]) {
      await writeFile(join(dir, 'a.txt'), 'alpha\n')
      await writeFile(join(dir, 'b.txt'), 'beta\n')
    }
    const raw = await readFile(SEED, 'utf8')
    expect(fixtureUserPrompts(raw), 'borrowed seed must carry the drive prompt').toEqual([PROMPT])
    await seedSession(scaffold, raw, SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it.skipIf(MODE === 'record')('opens the read row’s file in a new tab, served from the session workspace', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workspace-file-open'))
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await expect.poll(() => page.getByText('DONE', { exact: true }).count(), { timeout: 15_000 }).toBe(1)

    // The row summary IS the link: a button whose label is the tool's path.
    const fileLink = page.getByRole('button', { name: 'a.txt', exact: true }).first()
    await fileLink.waitFor({ timeout: 10_000 })
    const [opened] = await Promise.all([
      page.context().waitForEvent('page', { timeout: 15_000 }),
      fileLink.click(),
    ])
    await opened.waitForLoadState('domcontentloaded')
    expect(new URL(opened.url()).pathname).toBe(`/f/${SEED_ID}/a.txt`)
    expect(await opened.locator('body').innerText()).toContain('alpha')

    // The served response is a workspace read, not a download, and never cached
    // past the turn that produced it.
    const served = await page.request.get(opened.url())
    expect(served.status()).toBe(200)
    expect(served.headers()['x-content-type-options']).toBe('nosniff')
    expect(served.headers()['cache-control']).toBe('no-store')

    // Nothing outside the Session's workspace is reachable through the route.
    const escape = await page.request.get(`${scaffold.baseUrl}/f/${SEED_ID}/..%2Fetc%2Fhosts`)
    expect(escape.status()).toBe(404)

    await opened.close()
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 90_000)
})
