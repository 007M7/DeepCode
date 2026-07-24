// Web e2e scenario: seeded history. A recorded session seeded cold through
// the REAL persistence API renders purely from the log — the surface nothing
// else covers: sidebar cold listing, the implicit resume/attach inside the
// history RPC, history-page tool views, and the client fold of historical
// events — with ZERO model calls in replay (no replay fixture; a stray stream
// fails loud on the open llm seam). The seed is a recorded fixture under the
// same record discipline as every other: DSH_SNAPSHOT=record drives the turn
// live through the composer (real read tool against seeded workspace files)
// and harvests seed.jsonl; replay/refresh seed it cold and only render.
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { join } from 'node:path'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebHarness, recordFixture, seedSession, watchConsole, webSnapshotMode, type WebHarness,
} from './harness.ts'
import { saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/seeded-history', import.meta.url))
const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./snapshots/seeded-history/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'seeded-history-web-e2e'

const PROMPT = 'Use the read tool twice in one assistant message: read a.txt and b.txt. Then reply with the single word DONE and stop.'

describe('web e2e: seeded history renders through cold resume', () => {
  let harness: WebHarness
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    harness = await launchWebHarness({})
    // The read-tool targets exist in both modes: record needs them for the
    // live turn; replay's seeded log carries their recorded contents but the
    // workspace stays consistent for any user poking the harness.
    await writeFile(join(harness.workspaceCwd, 'a.txt'), 'alpha\n')
    await writeFile(join(harness.workspaceCwd, 'b.txt'), 'beta\n')
    if (MODE !== 'record') {
      const raw = await readFile(SEED, 'utf8')
      expect(fixtureUserPrompts(raw), 'seed fixture must carry exactly the drive prompt').toEqual([PROMPT])
      await seedSession(harness, raw, SEED_ID)
    }
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 } })
    tripwire = watchConsole(page)
    await page.goto(harness.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await harness?.close()
  })

  it.skipIf(MODE !== 'record')('records the seed turn live through the composer', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-seeded-record'))
    const input = page.locator('textarea').first()
    await input.waitFor({ timeout: 10_000 })
    const settled = harness.whenTurnSettled()
    await input.fill(PROMPT)
    await input.press('Enter')
    const sessionId = await settled
    await recordFixture(harness, sessionId, SEED)
  }, 200_000)

  it.skipIf(MODE === 'record')('lists the seeded session cold and renders its history from the log', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-seeded-history'))
    // The sidebar tree collapses workspace groups by default: click the group
    // row (treeitem 0) to expand, then the revealed session row.
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    // Settled barrier for history: the recorded final assistant text renders.
    await expect.poll(() => page.getByText('DONE', { exact: true }).count(), { timeout: 15_000 }).toBe(1)
    // Tool cards render from logged tool/call + tool/result alone (views are
    // host-recomputed per page; the generic card is the documented default).
    const toolRows = page.locator('[data-variant], [data-sample]')
    await expect.poll(() => toolRows.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
    expect(await page.getByText('a.txt', { exact: false }).count()).toBeGreaterThan(0)
  }, 60_000)

  it.skipIf(MODE === 'record')('matches the historical conversation aria golden', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-seeded-aria'))
    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', harness.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
  })

  it.skipIf(MODE === 'record')('issued zero model calls and stayed clean', async () => {
    // No replay fixture was installed and the llm seam is open — any stray
    // stream would have failed the turn loudly. Cleanliness pins the wire.
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    expect(harness.serverErrors).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['seed.jsonl', 'ui.expected.md'])
  })
})
