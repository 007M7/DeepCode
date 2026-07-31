// Keyless browser e2e: the shipped DeepSeek adapter stays mounted while its
// credential is absent, onboarding routes to the real Models editor, and its
// write lands in an isolated harness home without a reload or model call.
import { randomBytes } from 'node:crypto'
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

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/onboarding-deepseek-config', import.meta.url))
const MISSING_EXPECTED = join(SNAPSHOT_DIR, 'missing.expected.md')
const MODELS_EXPECTED = join(SNAPSHOT_DIR, 'models.expected.md')
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: first-run DeepSeek credential setup', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const browserConsole: string[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ deepSeekMissingCredential: true })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
    tripwire = watchConsole(page)
    page.on('console', message => browserConsole.push(message.text()))
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('stores a key write-only and observes configured state without restarting', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-onboarding-deepseek-config'))
    const dialog = page.getByRole('dialog', { name: '添加一个 API Key 开始使用' })
    await dialog.waitFor({ timeout: 15_000 })
    expect(await dialog.getByRole('textbox').count()).toBe(0)
    const initial = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(MISSING_EXPECTED, initial, MODE)

    await dialog.getByRole('button', { name: '前往配置' }).click()
    await dialog.waitFor({ state: 'detached', timeout: 15_000 })
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ timeout: 10_000 })
    const keyInput = settings.getByLabel('API 密钥', { exact: true })
    await keyInput.waitFor({ timeout: 10_000 })

    const secret = `dsh_onboarding_${randomBytes(12).toString('hex')}`
    await keyInput.fill(secret)
    await settings.getByRole('button', { name: '保存', exact: true }).click()
    await keyInput.waitFor({ state: 'detached', timeout: 15_000 })

    const stored = await readFile(join(scaffold.harnessHome, '.env'), 'utf8')
    expect(stored.includes(`DEEPSEEK_API_KEY=${secret}`)).toBe(true)
    expect((await page.content()).includes(secret)).toBe(false)
    expect((await page.locator('body').ariaSnapshot()).includes(secret)).toBe(false)
    expect(browserConsole.some(line => line.includes(secret))).toBe(false)

    // The same open Models surface reuses the refreshed join and exposes the
    // configured write-only placeholder without a reload.
    const deepSeekRow = settings.getByText('DeepSeek', { exact: true }).first()
    await deepSeekRow.waitFor({ timeout: 10_000 })
    await deepSeekRow.locator('xpath=ancestor::li').getByRole('button', { name: '编辑' }).click()
    const configuredInput = settings.getByLabel('API 密钥', { exact: true })
    await configuredInput.waitFor({ timeout: 10_000 })
    await expect.poll(
      () => configuredInput.getAttribute('placeholder'),
      { timeout: 10_000 },
    ).toBe('已配置——输入新值可替换')

    expect((await page.content()).includes(secret)).toBe(false)
    expect((await page.locator('body').ariaSnapshot()).includes(secret)).toBe(false)
    expect(browserConsole.some(line => line.includes(secret))).toBe(false)
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('configures arbitrary DeepSeek models and prompts after the selected model is removed', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-onboarding-deepseek-models'))
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.getByText('自定义设置').click()
    await settings.getByRole('button', { name: '删除模型' }).first().click()
    await settings.getByRole('button', { name: '添加模型' }).click()
    const customModelId = settings.getByLabel('模型 ID 2')
    await customModelId.fill('private-preview')
    await settings.getByLabel('显示名称 2').fill('Private Preview')
    await settings.getByLabel('上下文窗口 2').fill('131072')

    const modelEditor = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(MODELS_EXPECTED, modelEditor, MODE)
    await settings.getByRole('button', { name: '保存', exact: true }).click()
    await customModelId.waitFor({ state: 'detached', timeout: 15_000 })

    const document = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(document).toContain('id: deepseek-v4-pro')
    expect(document).toContain('id: private-preview')
    expect(document).toContain('name: Private Preview')
    expect(document).toContain('contextWindow: 131072')
    expect(document).not.toContain('id: deepseek-v4-flash')

    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '创建工作区', exact: true }).click()
    await page.getByRole('menuitem', { name: '新建工作区', exact: true }).click()
    const workspaceDialog = page.getByRole('dialog', { name: '新建工作区' })
    await workspaceDialog.getByLabel('新工作区名称').fill('model-fallback-e2e')
    await workspaceDialog.getByRole('button', { name: '创建工作区', exact: true }).click()
    await workspaceDialog.waitFor({ state: 'detached', timeout: 10_000 })

    const modelTrigger = page.getByRole('button', { name: '选择模型', exact: true })
    await modelTrigger.waitFor({ timeout: 10_000 })
    await modelTrigger.click()
    await page.getByRole('menuitem', { name: /模型/ }).click()
    expect(await page.getByText('deepseek-v4-flash', { exact: true }).count()).toBe(0)
    await page.getByRole('menuitemradio', { name: 'Private Preview' }).waitFor({ timeout: 10_000 })
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['missing.expected.md', 'models.expected.md'])
  })
})
