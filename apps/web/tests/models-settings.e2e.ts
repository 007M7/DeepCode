// Web e2e scenario: the Models settings page end to end through the real
// wire — the add card offers the dormant pi-ai catalog, typing an API key
// stores it write-only under the derived reference (`MINIMAX_CN_API_KEY`)
// while the settings document records only that reference; the saved row
// appears after the route topology invalidation without presenting liveness
// as provider status. The customized-settings fold writes the curated
// reasoning field as a merge patch. Zero model calls: configuration is pure
// settings/credentials/llm-domain traffic, so there is no fixture and a
// stray stream would fail loud on the open seam. The provider under test is
// minimax-cn so a developer's real ANTHROPIC/OPENAI environment keys can
// never shadow the derived reference. Removing that row is guarded by the
// localized provider-confirmation dialog before the unset reaches the wire.
import { readFile } from 'node:fs/promises'
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

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/models-settings', import.meta.url))
const EMPTY_EXPECTED = join(SNAPSHOT_DIR, 'empty.expected.md')
const CONFIGURED_EXPECTED = join(SNAPSHOT_DIR, 'configured.expected.md')
const DECLARED_EXPECTED = join(SNAPSHOT_DIR, 'declared.expected.md')
const DELETE_EXPECTED = join(SNAPSHOT_DIR, 'delete.expected.md')
const MODE = webSnapshotMode()

describe('web e2e: Models settings page configures a dormant provider', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    // The scenario asserts the shipped Chinese copy, so the browser asks for it.
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('opens the add card over the dormant directory vocabulary', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-empty'))
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: '模型' }).click()
    await dialog.getByText('填入各提供方的 API 密钥即可使用其模型。').waitFor({ timeout: 10_000 })
    // The dormant pi-ai adapter contributes its whole installed catalog; no
    // provider is configured yet, so the page is one add button.
    const add = dialog.getByRole('button', { name: '添加提供方' })
    await add.waitFor({ timeout: 10_000 })
    // The button enables once the dormant catalog lands in the join.
    await expect.poll(async () => add.isEnabled(), { timeout: 10_000 }).toBe(true)
    await add.click()
    const pick = dialog.getByLabel('提供方')
    await pick.waitFor({ timeout: 10_000 })
    await expect.poll(async () => pick.locator('option').count(), { timeout: 10_000 }).toBeGreaterThan(30)
    const options = await pick.locator('option').allTextContents()
    expect(options).toContain('anthropic')
    expect(options).toContain('minimax-cn')
    await pick.selectOption('minimax-cn')
    await dialog.getByLabel('API 密钥').waitFor({ timeout: 10_000 })
    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(EMPTY_EXPECTED, snapshot, MODE)
  }, 60_000)

  it('stores the key under the derived reference and the route registers live', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-add'))
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.getByLabel('API 密钥').fill('sk-e2e-minimax')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    // The profile lands in settings.yaml with only the derived reference, the
    // key value lands in the harness home's .env, the dormant route
    // registers, and the topology frame invalidates the page into the row.
    const row = dialog.getByText('minimax-cn', { exact: true }).first()
    await row.waitFor({ timeout: 10_000 })
    const document = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(document).toContain('minimax-cn:')
    expect(document).toContain('apiKeyEnv: MINIMAX_CN_API_KEY')
    expect(document).not.toContain('sk-e2e-minimax')
    const stored = await readFile(join(scaffold.harnessHome, '.env'), 'utf8')
    expect(stored).toContain('MINIMAX_CN_API_KEY=sk-e2e-minimax')
    expect(await page.content()).not.toContain('sk-e2e-minimax')
  }, 60_000)

  it('applies a customized-settings field as a merge patch', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-customized'))
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.getByRole('button', { name: '编辑' }).click()
    await dialog.getByText('自定义设置').click()
    const effort = dialog.getByLabel('推理强度')
    await effort.waitFor({ timeout: 10_000 })
    await effort.selectOption('high')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    // The editor closes back to the row; the fold's write merged into the
    // stored profile beside the reference.
    await expect.poll(async () => dialog.getByLabel('推理强度').count(), { timeout: 10_000 }).toBe(0)
    const document = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(document).toContain('reasoning: high')
    expect(document).toContain('apiKeyEnv: MINIMAX_CN_API_KEY')
    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(CONFIGURED_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('declares a route the adapter does not ship, with its own reasoning effort', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-declare'))
    const dialog = page.getByRole('dialog', { name: '设置' })
    const declare = dialog.getByRole('button', { name: '添加自定义提供方' })
    await expect.poll(async () => declare.isEnabled(), { timeout: 10_000 }).toBe(true)
    await declare.click()
    await dialog.getByLabel('Provider ID').fill('acme-gateway')
    await dialog.getByLabel('显示名称').fill('Acme Gateway')
    await dialog.getByLabel('API 地址').fill('https://gateway.acme.example/v1')
    // The create card offers the same provider-level effort the editor card
    // does for this namespace; a route declared without it would gain the
    // control only on reopening.
    await dialog.getByLabel('推理强度').selectOption('high')
    await dialog.getByRole('button', { name: '添加模型' }).click()
    await dialog.getByLabel('模型 ID 1').fill('acme-large')
    await dialog.getByRole('button', { name: '创建提供方', exact: true }).click()

    const row = dialog.getByText('Acme Gateway', { exact: true }).first()
    await row.waitFor({ timeout: 10_000 })
    const document = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(document).toContain('acme-gateway:')
    expect(document).toContain('reasoning: high')

    // The tag follows the adapter's installed catalog: this route is in no
    // catalog, while minimax-cn is — even though both now have profiles.
    const rowCard = (name: string) => dialog.locator('li').filter({ hasText: name }).first()
    await expect.poll(async () => rowCard('Acme Gateway').getByText('自定义').count(), { timeout: 10_000 }).toBe(1)
    expect(await rowCard('minimax-cn').getByText('自定义').count()).toBe(0)

    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(DECLARED_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('confirms provider deletion before removing its settings profile', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-delete'))
    const settingsDialog = page.getByRole('dialog', { name: '设置' })
    // Two rows carry a delete action now that a route is also declared; this
    // scenario is about minimax-cn, so it names its own row.
    const minimaxRow = settingsDialog.locator('li').filter({ hasText: 'minimax-cn' }).first()
    await minimaxRow.getByRole('button', { name: '删除', exact: true }).click()
    const deleteDialog = page.getByRole('dialog', { name: '删除模型提供方？' })
    await deleteDialog.waitFor({ timeout: 10_000 })
    const snapshot = await captureStableAria(
      page,
      '[role="dialog"][aria-label="删除模型提供方？"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(DELETE_EXPECTED, snapshot, MODE)

    await deleteDialog.getByRole('button', { name: '取消', exact: true }).click()
    expect(await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')).toContain('minimax-cn:')
    await minimaxRow.getByRole('button', { name: '删除', exact: true }).click()
    await page.getByRole('dialog', { name: '删除模型提供方？' })
      .getByRole('button', { name: '删除提供方', exact: true }).click()
    await expect.poll(
      async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'),
      { timeout: 10_000 },
    ).not.toContain('minimax-cn:')
    expect(await readFile(join(scaffold.harnessHome, '.env'), 'utf8'))
      .toContain('MINIMAX_CN_API_KEY=sk-e2e-minimax')
    await expect.poll(
      async () => page.getByRole('dialog', { name: '删除模型提供方？' }).count(),
      { timeout: 10_000 },
    ).toBe(0)
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR,
      ['configured.expected.md', 'declared.expected.md', 'delete.expected.md', 'empty.expected.md'])
  })
})
