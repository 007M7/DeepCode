// Web e2e scenario: seeded history. A recorded session seeded cold through
// the REAL persistence API renders purely from the log — the surface nothing
// else covers: sidebar cold listing, the implicit resume/attach inside the
// history RPC, history-page tool views, and the client fold of historical
// events — with ZERO model calls in replay (no replay fixture; a stray stream
// fails loud on the open llm seam). The seed is a recorded fixture under the
// same record discipline as every other: DSH_SNAPSHOT=record drives the turn
// live through the composer (real read tool against seeded workspace files)
// and harvests seed.jsonl; replay/refresh seed it cold and only render.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { join } from 'node:path'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, recordFixture, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/seeded-history', import.meta.url))
const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./snapshots/seeded-history/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'seeded-history-web-e2e'

const PROMPT = 'Use the read tool twice in one assistant message: read a.txt and b.txt. Then reply with the single word DONE and stop.'

describe('web e2e: seeded history renders through cold resume', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    // The workspace-aware flow runs sessions in <workspaceRoot>/workspace
    // (the composer's default draft name); the read-tool targets must live in
    // that session cwd. Pre-creating the directory is safe: create-by-name
    // adopts an existing directory.
    const sessionCwd = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(sessionCwd, { recursive: true })
    await writeFile(join(sessionCwd, 'a.txt'), 'alpha\n')
    await writeFile(join(sessionCwd, 'b.txt'), 'beta\n')
    if (MODE !== 'record') {
      const raw = await readFile(SEED, 'utf8')
      expect(fixtureUserPrompts(raw), 'seed fixture must carry exactly the drive prompt').toEqual([PROMPT])
      await seedSession(scaffold, raw, SEED_ID)
    }
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

  it.skipIf(MODE !== 'record')('records the seed turn live through the composer', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-seeded-record'))
    const input = page.locator('textarea').first()
    await input.waitFor({ timeout: 10_000 })
    const settled = scaffold.whenTurnSettled()
    await input.fill(PROMPT)
    await input.press('Enter')
    const sessionId = await settled
    await recordFixture(scaffold, sessionId, SEED)
  }, 200_000)

  it.skipIf(MODE === 'record')('serves the projections baseline on the real composition tail page', async () => {
    // Composition regression tripwire: the projection registry must be a row
    // in the SHIPPED cordis.yml — with it absent every domain unit's optional
    // injection stays silent and this block disappears (no titles/todos on
    // the web), while fixture-level suites stay green. Assert through the
    // real HTTP wire against the booted real host.
    const response = await fetch(`${scaffold.baseUrl}/api/session.history`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'seeded-projections', method: 'session.history',
        payload: { sessionId: SEED_ID },
      }),
    })
    expect(response.ok).toBe(true)
    const body = await response.json() as {
      result: { ok: boolean; value?: { projections?: { asOfSeq: number; values: Record<string, unknown> } } }
    }
    expect(body.result.ok).toBe(true)
    const projections = body.result.value?.projections
    expect(projections).toBeDefined()
    expect(projections?.asOfSeq).toBeGreaterThanOrEqual(0)
    // The seed carries a session/title event: the title unit must serve it.
    expect(typeof projections?.values.title).toBe('string')
    // tool-todo is composed but the seed has no todo/write: whole-value null,
    // key PRESENT (absence would mean the unit never registered).
    expect(projections?.values).toHaveProperty('todos', null)
  })

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
    await page.getByRole('button', {
      // This scenario deliberately leaves the LLM seam open to prove zero
      // model calls. History still restores the selected id, but no catalog
      // adapter exists to provide its presentation name.
      name: 'Select model, current deepseek-v4-flash',
    }).waitFor({ timeout: 10_000 })
    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
  })

  it.skipIf(MODE === 'record')('file-path tool rows rebuilt from the cold log stay details-inert', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-seeded-toolrow'))
    // Interaction over cold-resumed history: read summaries are host-open
    // file links (not expand-in-place / not details). Runs after the golden
    // capture; still zero model calls.
    const fileLink = page.locator('[data-variant="read"] button').first()
    await fileLink.waitFor({ timeout: 10_000 })
    const frame = page.locator('[style*="grid-template-columns"]').first()
    expect(await frame.getAttribute('data-details-collapsed')).toBe('true')
    await fileLink.click()
    await expect.poll(() => frame.getAttribute('data-details-collapsed'), { timeout: 5_000 }).toBe('true')
    // Path label survives from the recorded args (a.txt).
    await expect.poll(() => page.getByText('a.txt', { exact: false }).count(), { timeout: 5_000 }).toBeGreaterThan(0)
  })

  it.skipIf(MODE === 'record')('issued zero model calls and stayed clean', async () => {
    // No replay fixture was installed and the llm seam is open — any stray
    // stream would have failed the turn loudly. Cleanliness pins the wire.
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['seed.jsonl', 'ui.expected.md'])
  })
})
