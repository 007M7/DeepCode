// Web e2e scenario: every visible permission picker gates Full access behind
// the same locale-aware, in-page risk confirmation. Zero model calls: the
// scenario boots the shipped Web composition and exercises the real
// permission projection, client command path, HTTP RPC, and pushed update.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

/**
 * connectFreshWorkspace twin over the product default Chinese locale (the
 * shared helper's anchors assume the English page every other scenario
 * boots; this scenario deliberately keeps zh, so the localized picker
 * copy is the anchor set).
 */
async function connectFreshWorkspaceZh(page: Page, name = 'workspace'): Promise<void> {
  await page.getByRole('button', { name: '选择工作区' }).click()
  await page.getByRole('menuitem', { name: '新建工作区' }).click()
  const dialog = page.getByRole('dialog', { name: '新建工作区' })
  await dialog.waitFor({ timeout: 10_000 })
  await dialog.getByLabel('新工作区名称').fill(name)
  await dialog.getByRole('button', { name: '创建工作区' }).click()
  await page.locator('textarea:enabled[placeholder="描述你想要构建的内容"]')
    .waitFor({ timeout: 15_000 })
}

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/access-confirmation', import.meta.url))
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const MODE = webSnapshotMode()

describe('web e2e: Full access confirmation', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    // CI uses Playwright's pinned browser. A developer may point this one
    // scenario at an installed Chromium when the matching browser download
    // is temporarily unavailable.
    const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    // Keep the product default Chinese locale: the golden pins the actual
    // registered dictionary rather than a test-local translation callback.
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspaceZh(page)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('requires acknowledgement before the composer picker can enable Full access', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-full-access-confirmation'))
    const access = page.locator('button[aria-label^="访问模式"]').first()
    await access.waitFor({ timeout: 10_000 })

    // Normalize the starting preset through the real command path. The
    // shipped web config may already start at Full access.
    if ((await access.getAttribute('aria-label'))?.endsWith('Full access') === true) {
      await access.click()
      await page.getByRole('menuitem', { name: 'Workspace Write' }).click()
      await expect.poll(() => access.getAttribute('aria-label'), { timeout: 10_000 })
        .toBe('访问模式，当前：Workspace Write')
    }

    await access.click()
    await page.getByRole('menuitem', { name: 'Full access' }).click()
    const dialog = page.getByRole('dialog', { name: '确认启用 Full access？' })
    await dialog.waitFor({ timeout: 10_000 })
    const enable = dialog.getByRole('button', { name: '启用 Full access' })
    expect(await enable.isDisabled()).toBe(true)

    // The modal is in this page's body (not a native/new window) and escapes
    // the sticky composer's stacking context.
    expect(await dialog.evaluate(node => node.parentElement?.parentElement === document.body)).toBe(true)
    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)

    await dialog.getByRole('checkbox', { name: '我已了解风险，并愿意继续' }).check()
    expect(await enable.isEnabled()).toBe(true)
    await enable.click()
    await expect.poll(() => access.getAttribute('aria-label'), { timeout: 10_000 })
      .toBe('访问模式，当前：Full access')
    expect(await dialog.count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps its snapshot inventory closed', async () => {
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  })
})
