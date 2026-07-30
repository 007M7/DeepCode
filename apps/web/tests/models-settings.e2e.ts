// Web e2e scenario: the Models settings page end to end through the real
// wire — the dormant pi-ai directory renders as the add vocabulary, adding a
// provider writes the settings document and registers the route live (the
// row's 已启用 badge is the topology invalidation landing), and the key input
// stores a credential write-only into the harness home's .env. Zero model
// calls: configuration is pure settings/credentials/llm-domain traffic, so
// there is no fixture and a stray stream would fail loud on the open seam.
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
import { saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/models-settings', import.meta.url))
const EMPTY_EXPECTED = join(SNAPSHOT_DIR, 'empty.expected.md')
const CONFIGURED_EXPECTED = join(SNAPSHOT_DIR, 'configured.expected.md')
const MODE = webSnapshotMode()

describe('web e2e: Models settings page configures a dormant provider', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
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

  it('renders the dormant directory as the add vocabulary', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-empty'))
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: '模型' }).click()
    await dialog.getByText('填入各提供方的 API 密钥即可使用其模型。').waitFor({ timeout: 10_000 })
    // The dormant pi-ai adapter contributes its whole installed catalog; no
    // provider is configured yet, so the page is one add-select.
    const add = dialog.getByLabel('添加提供方')
    await add.waitFor({ timeout: 10_000 })
    // The select renders before the directory join settles; poll until the
    // dormant catalog landed.
    await expect.poll(async () => add.locator('option').count(), { timeout: 10_000 }).toBeGreaterThan(30)
    const options = await add.locator('option').allTextContents()
    expect(options).toContain('anthropic')
    expect(options).toContain('openai')
    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(EMPTY_EXPECTED, snapshot, MODE)
  }, 60_000)

  it('adds a provider through the schema-driven editor and the route registers live', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-add'))
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.getByLabel('添加提供方').selectOption('anthropic')
    // The editor is the real pi-ai profile schema rendered field by field;
    // the credential-reference control is the role-tagged override.
    const ref = dialog.getByLabel('API 密钥环境变量')
    await ref.waitFor({ timeout: 10_000 })
    // A test-owned reference name keeps this hermetic: a developer's real
    // ANTHROPIC_API_KEY in the process environment must not flip the badge.
    await ref.fill('E2E_ANTHROPIC_KEY')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    // The write lands in settings.yaml, the dormant route registers, the
    // topology frame invalidates the page, and the reloaded join shows the
    // row live with its credential still missing.
    const row = dialog.getByText('anthropic', { exact: true }).first()
    await row.waitFor({ timeout: 10_000 })
    await dialog.getByText('已启用').waitFor({ timeout: 10_000 })
    await dialog.getByText('缺少密钥').waitFor({ timeout: 10_000 })
    const document = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(document).toContain('llm-pi-ai:')
    expect(document).toContain('anthropic:')
    expect(document).toContain('apiKeyEnv: E2E_ANTHROPIC_KEY')
  }, 60_000)

  it('stores the API key write-only and the badge flips configured', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-key'))
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.getByRole('button', { name: '编辑' }).click()
    const key = dialog.getByLabel('API 密钥', { exact: true })
    await key.waitFor({ timeout: 10_000 })
    await key.fill('sk-ant-e2e-test')
    await dialog.getByRole('button', { name: '保存密钥' }).click()
    await dialog.getByText('已配置', { exact: true }).waitFor({ timeout: 10_000 })
    // The value went to the harness home's .env — and nowhere in the DOM.
    const stored = await readFile(join(scaffold.harnessHome, '.env'), 'utf8')
    expect(stored).toContain('E2E_ANTHROPIC_KEY=sk-ant-e2e-test')
    expect(await page.content()).not.toContain('sk-ant-e2e-test')
    await dialog.getByRole('button', { name: '取消' }).click()
    // The row badge converges from the credentials invalidation.
    await expect.poll(async () => dialog.getByText('缺少密钥').count(), { timeout: 10_000 }).toBe(0)
    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(CONFIGURED_EXPECTED, snapshot, MODE)
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['configured.expected.md', 'empty.expected.md'])
  })
})
