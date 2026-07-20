// Light/dark screenshots incl. the sidebar toggle. Run from repo root.
import { chromium } from 'playwright'
const BASE = 'http://127.0.0.1:3080'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.goto(`${BASE}/?fixture`, { waitUntil: 'load' })
await page.waitForSelector('aside button[title="fx-alpha"]')
await page.locator('aside button[title="fx-alpha"]').click()
await page.waitForSelector('main textarea')
const primary = page.locator('main button[class*="primary"]')
if (await primary.getAttribute('aria-label') === '停止') {
  await primary.click()
  await page.waitForSelector('main div[class*="head"] span[data-running]', { state: 'detached', timeout: 5000 })
}
await page.locator('main textarea').fill('主题演示草稿')
// light
await page.screenshot({ path: '.artifacts/theme-light.png' })
// toggle to dark via the sidebar button
await page.locator('aside button[title="切换到深色模式"]').click()
await page.waitForTimeout(300)
const attr = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
const stored = await page.evaluate(() => localStorage.getItem('dsc.theme'))
console.log('data-theme =', attr, '; localStorage =', stored)
// open RPC panel for the dark sweep too
await page.locator('button', { hasText: 'RPC' }).first().click()
await page.waitForTimeout(200)
await page.screenshot({ path: '.artifacts/theme-dark.png' })
// reload: persisted?
await page.reload({ waitUntil: 'load' })
await page.waitForTimeout(500)
const attrAfter = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
console.log('after reload data-theme =', attrAfter)
await browser.close()
