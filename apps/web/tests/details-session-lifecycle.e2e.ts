// Keyless browser regression for the details column's Session ownership.
// The real shipped composition owns the state transition: an active Session
// rehydrates an open panel, New Session replaces the details owner, and the
// root layout must release the third grid track before the next paint.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, fixtureUserPrompts, launchWebScaffold, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('./snapshots/lifecycle-chrome/session.jsonl', import.meta.url))
const PROMPT = 'Reply with the single word LIGHTHOUSE and stop.'
const MODE = webSnapshotMode()

/** Last AppFrame grid track in CSS pixels. */
async function detailsTrack(page: Page): Promise<number> {
  return await page.locator('[class*="frame"]').first().evaluate((element) => {
    const tracks = getComputedStyle(element).gridTemplateColumns.split(' ')
    return Number.parseFloat(tracks.at(-1) ?? 'NaN')
  })
}

describe.skipIf(MODE === 'record')('web e2e: details panel follows the current Session lifecycle', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    scaffold = await launchWebScaffold({ replayFixture: FIXTURE, paceMs: 5 })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 } })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('removes the details track for New Session and keeps it closed when returning', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-details-session-lifecycle'))
    const settled = scaffold.whenTurnSettled()
    const input = page.locator('textarea').first()
    await input.fill(PROMPT)
    await input.press('Enter')
    await settled
    await page.getByText('LIGHTHOUSE', { exact: true }).waitFor({ timeout: 15_000 })

    // Rehydrate the production layout action's persisted result. The active
    // Session survives reload, so its details panel remains valid and open.
    await page.evaluate(() => {
      localStorage.setItem('dsh.layout.panels', JSON.stringify({ sidebar: 280, details: 360 }))
    })
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await page.getByText('LIGHTHOUSE', { exact: true }).waitFor({ timeout: 15_000 })
    expect(await detailsTrack(page)).toBe(360)
    expect(await page.getByText('详情', { exact: true }).count()).toBe(1)

    await page.getByRole('button', { name: 'New session', exact: true }).last().click()
    await page.getByText("Let's start building", { exact: false }).waitFor({ timeout: 15_000 })
    expect(await page.locator('[class*="frame"]').first().getAttribute('data-details-collapsed')).not.toBeNull()
    await expect.poll(() => detailsTrack(page), { timeout: 5_000 }).toBe(0)
    expect(await page.getByText('详情', { exact: true }).isVisible()).toBe(false)

    const original = page.locator('[role=treeitem]').filter({ hasText: 'Reply with the single word' }).first()
    await original.click()
    await page.getByText('LIGHTHOUSE', { exact: true }).waitFor({ timeout: 15_000 })
    await expect.poll(() => detailsTrack(page), { timeout: 5_000 }).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 90_000)
})
