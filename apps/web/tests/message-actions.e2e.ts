// Web e2e scenario: message IconActions + clocks. Cold-seeds the seeded-history
// fixture (zero model calls) and pins the settled conversation aria after the
// user/assistant footers are focus-revealed — the surface package jsdom tests
// cannot substitute for (docs/testing.md snapshot rule).
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/message-actions', import.meta.url))
// Borrowed read-only: this scenario needs any settled user+assistant pair, not
// a new recording (workspace-management / sidebar-scrollbar pattern).
const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const MODE = webSnapshotMode()
const SEED_ID = 'message-actions-web-e2e'

const PROMPT = 'Use the read tool twice in one assistant message: read a.txt and b.txt. Then reply with the single word DONE and stop.'

describe('web e2e: message IconActions and clocks on settled history', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const sessionCwd = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(sessionCwd, { recursive: true })
    await writeFile(join(sessionCwd, 'a.txt'), 'alpha\n')
    await writeFile(join(sessionCwd, 'b.txt'), 'beta\n')
    const raw = await readFile(SEED, 'utf8')
    expect(fixtureUserPrompts(raw), 'borrowed seed must carry the drive prompt').toEqual([PROMPT])
    await seedSession(scaffold, raw, SEED_ID)
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 } })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it.skipIf(MODE === 'record')('lists the seeded session and reveals user/assistant IconActions', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-message-actions'))
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await expect.poll(() => page.getByText('DONE', { exact: true }).count(), { timeout: 15_000 }).toBe(1)

    // Focus-reveal the footers (hover:hover keeps them opacity-hidden until
    // hover/focus-within). User has three actions; each finalized assistant
    // text node has copy + branch.
    const copyButtons = page.getByRole('button', { name: '复制' })
    await expect.poll(() => copyButtons.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
    await copyButtons.first().focus()
    await expect.poll(() => page.getByRole('button', { name: '在新对话中分支' }).count(), { timeout: 5_000 })
      .toBeGreaterThanOrEqual(2)
    await expect.poll(() => page.getByRole('button', { name: '编辑' }).count(), { timeout: 5_000 }).toBe(1)
  }, 60_000)

  it.skipIf(MODE === 'record')('matches the conversation aria golden with IconActions and clocks', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-message-actions-aria'))
    await page.getByRole('button', {
      name: '选择模型，当前 deepseek-v4-flash',
    }).waitFor({ timeout: 10_000 })
    // Keep a footer focused so opacity-hidden actions stay in the a11y tree
    // as an active/focused control during the capture.
    await page.getByRole('button', { name: '复制' }).first().focus()
    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
  })

  it.skipIf(MODE === 'record')('issued zero model calls and kept a closed inventory', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  })
})
