// Web e2e scenario: a produced file, from the row that lists it to the bytes
// the browser gets. Cold-seeds a recorded write turn (zero model calls).
// Package tests cover the derivation and the route in isolation, but only the
// assembled application shows that the turn's Produced row, the URL it opens,
// and the file on disk are the same thing (docs/testing.md snapshot rule).
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

// Borrowed read-only: this scenario needs any settled turn whose tools WROTE a
// file, not a new recording (the message-actions borrowing pattern).
const SEED = fileURLToPath(new URL('./snapshots/permission-policy-context/session.jsonl', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'workspace-file-open-web-e2e'

/** The file the borrowed recording's write tool produces. */
const PRODUCED = 'policy-neutral.txt'
/** An active document placed alongside it, for the isolation header the route puts on those. */
const ACTIVE = 'preview.html'

describe('web e2e: opening a produced file from the conversation', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    // The seeded Session's cwd is the scaffold workspace; the recording's own
    // nested directory is created too, so its paths stay resolvable.
    await mkdir(join(scaffold.workspaceCwd, 'workspace'), { recursive: true })
    await writeFile(join(scaffold.workspaceCwd, PRODUCED), 'neutral\n')
    await writeFile(join(scaffold.workspaceCwd, ACTIVE), '<h1>produced</h1>\n')
    const raw = await readFile(SEED, 'utf8')
    expect(raw, 'borrowed recording must carry the write this scenario reads').toContain(PRODUCED)
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

  it.skipIf(MODE === 'record')('ends the turn with its produced file, which opens as the workspace file itself', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workspace-file-open'))
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()

    // The row the turn ends with — derived from the write call's locations,
    // not from whatever the closing message happened to say.
    const chip = page.getByRole('button', { name: `Open ${PRODUCED}`, exact: true }).first()
    await chip.waitFor({ timeout: 15_000 })
    expect(await chip.innerText()).toBe(PRODUCED)

    const [opened] = await Promise.all([
      page.context().waitForEvent('page', { timeout: 15_000 }),
      chip.click(),
    ])
    await opened.waitForLoadState('domcontentloaded')
    const url = new URL(opened.url())
    expect(url.pathname).toBe(`/f/${SEED_ID}/${PRODUCED}`)
    expect(await opened.locator('body').innerText()).toContain('neutral')

    // The isolation: previews come from the app's hostname on a DIFFERENT
    // port, so a served document is cross-origin to /api while keeping its own
    // capabilities. A workspace file is not necessarily agent-authored.
    const app = new URL(scaffold.baseUrl)
    expect(url.hostname).toBe(app.hostname)
    expect(url.port).not.toBe(app.port)
    const filesOrigin = url.origin

    const served = await page.request.get(opened.url())
    expect(served.status()).toBe(200)
    expect(served.headers()['x-content-type-options']).toBe('nosniff')
    expect(served.headers()['cache-control']).toBe('no-store')
    // No document is stripped of its origin: the port is the boundary.
    expect(served.headers()['content-security-policy']).toBeUndefined()

    // An active document keeps its own storage — the capability a sandbox
    // header would have taken, and the reason this route has its own port.
    const active = opened
    await active.goto(`${filesOrigin}/f/${SEED_ID}/${ACTIVE}`, { waitUntil: 'load' })
    expect(await active.evaluate(() => {
      try { window.localStorage.setItem('probe', '1'); return 'ok' } catch { return 'blocked' }
    })).toBe('ok')
    // …and cannot reach the API, which lives on the other origin.
    expect(await active.evaluate(async (base) => {
      try {
        await fetch(`${base}/api/session.list`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: 'x', method: 'session.list', payload: {} }),
        })
        return 'reached'
      } catch { return 'blocked' }
    }, scaffold.baseUrl)).toBe('blocked')

    // The workspace-file origin serves that one prefix and nothing else.
    expect((await page.request.get(`${filesOrigin}/`)).status()).toBe(404)
    // Nothing outside the Session's workspace is reachable through the route.
    expect((await page.request.get(`${filesOrigin}/f/${SEED_ID}/..%2Fetc%2Fhosts`)).status()).toBe(404)

    await active.close()
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 90_000)
})
