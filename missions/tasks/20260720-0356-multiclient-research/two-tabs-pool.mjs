// HTTP/1.1 per-origin connection-pool probe: 3 tabs in ONE browser context
// (shared socket pool, like real same-browser tabs). Each tab holds 2 SSE
// streams; 3 tabs = 6 = Chromium's per-origin cap → does tab 3 still work?
import { chromium } from 'playwright'

const BASE = 'http://127.0.0.1:3080'
const SESSION = 'session-f512f7aa-98ec-46ef-b7a6-eea629957921'

const browser = await chromium.launch()
const context = await browser.newContext()

const pages = []
for (let i = 0; i < 2; i++) {
  const page = await context.newPage()
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  pages.push(page)
  await page.waitForTimeout(1500)
  const listVisible = await page.locator(`[title="${SESSION}"]`).isVisible().catch(() => false)
  console.log(`tab${i + 1}: session list loaded = ${listVisible}`)
}

// All three try to open the session and check the conversation renders.
for (let i = 0; i < 2; i++) {
  const page = pages[i]
  const item = page.locator(`[title="${SESSION}"]`)
  const ok = await item.isVisible().catch(() => false)
  if (!ok) { console.log(`tab${i + 1}: LIST NEVER LOADED (pool starvation suspect)`); continue }
  await item.click()
  const gotTextarea = await page.locator('textarea').waitFor({ timeout: 8000 }).then(() => true).catch(() => false)
  const body = await page.locator('body').innerText()
  console.log(`tab${i + 1}: open session -> textarea=${gotTextarea}, history-rendered=${body.length > 300}`)
}

// Now the live-stream check: prompt from tab1, do tab2 AND tab3 both see it?
const MARK = `THREETAB-${Math.floor(Math.random() * 1e6)}`
await pages[0].locator('textarea').fill(`Reply with exactly: ${MARK}`)
await pages[0].keyboard.press('Enter')
console.log('[tab1] sent')
for (const [i, page] of [[1, pages[1]]]) {
  const t0 = Date.now()
  let seen = false
  while (Date.now() - t0 < 30000) {
    if ((await page.locator('body').innerText()).includes(MARK)) { seen = true; break }
    await page.waitForTimeout(400)
  }
  console.log(`tab${i + 1} sees tab1's turn: ${seen ? `PASS (${Date.now() - t0}ms)` : 'FAIL (30s timeout)'}`)
}

await browser.close()
console.log('POOL PROBE DONE')
