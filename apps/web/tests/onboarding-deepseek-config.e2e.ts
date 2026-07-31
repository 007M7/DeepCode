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
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  WELCOME_NOTICE_ACK_FIELD, WELCOME_NOTICE_COPY, WELCOME_NOTICE_SETTINGS_NAMESPACE,
  WELCOME_NOTICE_VERSION,
} from '@deepseek-ai/dsh-client-ui-settings-general'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/onboarding-deepseek-config', import.meta.url))
const WELCOME_EXPECTED = join(SNAPSHOT_DIR, 'welcome.expected.md')
const MISSING_EXPECTED = join(SNAPSHOT_DIR, 'missing.expected.md')
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: first-run DeepSeek credential setup', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const browserConsole: string[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ deepSeekMissingCredential: true, welcomeNoticePending: true })
    browser = await chromium.launch()
    // The scenario asserts the shipped Chinese copy, so the browser asks for it.
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
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
    const welcome = page.getByRole('region', { name: WELCOME_NOTICE_COPY.zh.title })
    await welcome.waitFor({ timeout: 15_000 })
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(true)
    const welcomeAria = await captureStableAria(page, '[role="region"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(WELCOME_EXPECTED, welcomeAria, MODE)
    expect(await welcome.getByRole('button').allTextContents()).toEqual([WELCOME_NOTICE_COPY.zh.continueLabel])
    expect(await welcome.locator('button').count()).toBe(1)

    const mask = page.locator('[class*="onboardingMask"]')
    expect(await mask.count()).toBe(1)
    const maskStyles = await mask.evaluate((mask) => {
      const style = getComputedStyle(mask)
      const rect = mask.getBoundingClientRect()
      return {
        position: style.position,
        left: style.left,
        right: style.right,
        top: style.top,
        bottom: style.bottom,
        background: style.backgroundColor,
        backdropFilter: style.backdropFilter,
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      }
    })
    expect(maskStyles).toEqual({
      position: 'absolute',
      left: '0px',
      right: '0px',
      top: '80px',
      bottom: '0px',
      background: 'rgba(0, 0, 0, 0.24)',
      backdropFilter: 'blur(2px)',
      rect: { left: 0, top: 80, right: 1440, bottom: 960 },
    })

    // Closing the process/page before acknowledgement writes nothing, so the
    // same durable profile presents the notice again after reload.
    const firstReloadWarnings = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, firstReloadWarnings)
    await welcome.waitFor({ timeout: 15_000 })

    await welcome.getByRole('button', { name: WELCOME_NOTICE_COPY.zh.continueLabel }).click()
    await welcome.waitFor({ state: 'detached', timeout: 15_000 })
    const credentialStep = page.getByRole('region', { name: '添加一个 API Key 开始使用' })
    await credentialStep.waitFor({ timeout: 15_000 })
    expect(await credentialStep.getByRole('textbox').count()).toBe(0)
    const initial = await captureStableAria(page, '[role="region"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(MISSING_EXPECTED, initial, MODE)

    await credentialStep.getByRole('button', { name: '前往配置' }).click()
    await credentialStep.waitFor({ state: 'detached', timeout: 15_000 })
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ timeout: 10_000 })
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(false)
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

    const acknowledgedSettings = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(acknowledgedSettings).toContain(`${WELCOME_NOTICE_ACK_FIELD}: ${WELCOME_NOTICE_VERSION}`)

    const secondReloadWarnings = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, secondReloadWarnings)
    await page.waitForSelector('[class*="frame"]', { timeout: 15_000 })
    expect(await page.getByRole('region', { name: WELCOME_NOTICE_COPY.zh.title }).count()).toBe(0)
    expect(await page.getByRole('region', { name: '添加一个 API Key 开始使用' }).count()).toBe(0)

    // A different stored copy version represents an intentional version bump:
    // the welcome step returns even though the credential is already ready.
    await scaffold.ctx.settings.mutate(settingsNamespace(WELCOME_NOTICE_SETTINGS_NAMESPACE), [{
      op: 'set', path: [WELCOME_NOTICE_ACK_FIELD], value: 'previous-copy-version',
    }])
    const thirdReloadWarnings = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, thirdReloadWarnings)
    await welcome.waitFor({ timeout: 15_000 })
    await welcome.getByRole('button', { name: WELCOME_NOTICE_COPY.zh.continueLabel }).click()
    await welcome.waitFor({ state: 'detached', timeout: 15_000 })
    expect(await page.getByRole('region', { name: '添加一个 API Key 开始使用' }).count()).toBe(0)

    expect((await page.content()).includes(secret)).toBe(false)
    expect((await page.locator('body').ariaSnapshot()).includes(secret)).toBe(false)
    expect(browserConsole.some(line => line.includes(secret))).toBe(false)
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['missing.expected.md', 'welcome.expected.md'])
  })
})
