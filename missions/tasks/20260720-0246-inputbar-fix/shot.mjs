// InputBar screenshots -> .artifacts/. Run: node missions/tasks/20260720-0246-inputbar-fix/shot.mjs
// States per rulings 2026-07-20 (#3 running-lock): idle = single send circle; running =
// textarea locked (grayed, draft visible) + stop circle, no menu.
import { chromium } from 'playwright'

const BASE = process.env.DSC_WEB_URL ?? 'http://127.0.0.1:3080'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.goto(`${BASE}/?fixture`, { waitUntil: 'load' })
await page.waitForSelector('aside button[title="fx-alpha"]')
await page.locator('aside button[title="fx-alpha"]').click()
const input = page.locator('main textarea')
await input.waitFor()

// fx-alpha opens running=true in the fixture: reset to idle so shot 1 shows the send state.
const primary = page.locator('main button[class*="primary"]')
if (await primary.getAttribute('aria-label') === '停止') {
  await primary.click()
  await page.waitForSelector('main div[class*="head"] span[data-running]', { state: 'detached', timeout: 5000 })
}

// 1: idle — multi-line draft, single send circle
await input.fill('多行草稿演示：第一行\n第二行\n第三行\n这是一段没有换行符但很长很长很长会软换行的第四行文本内容')
await input.hover()
await page.waitForTimeout(300)
await page.screenshot({ path: '.artifacts/inputbar-idle.png' })

// 2: running — textarea locked (grayed), stop circle in the same slot
await input.fill('运行态演示消息')
await primary.click()
await page.waitForSelector('main div[class*="head"] span[data-running]', { timeout: 3000 })
await page.waitForTimeout(400)
await page.screenshot({ path: '.artifacts/inputbar-running-locked.png' })

await browser.close()
console.log('saved .artifacts/inputbar-{idle,running-locked}.png')
