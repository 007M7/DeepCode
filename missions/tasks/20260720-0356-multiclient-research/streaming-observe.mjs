// Focused check: page B (non-initiator) must render a GROWING partial in its DOM
// while page A's prompt streams — proves token-level live streaming on the other client.
import { chromium } from 'playwright'

const BASE = 'http://127.0.0.1:3080'
const SESSION = 'session-f512f7aa-98ec-46ef-b7a6-eea629957921'

const browser = await chromium.launch()
const pageA = await (await browser.newContext()).newPage()
const pageB = await (await browser.newContext()).newPage()

for (const [page, tag] of [[pageA, 'A'], [pageB, 'B']]) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  const item = page.locator(`[title="${SESSION}"]`)
  await item.waitFor({ timeout: 10000 })
  await item.click()
  await page.locator('textarea').waitFor({ timeout: 10000 })
  console.log(`[${tag}] opened`)
}

const baseLen = (await pageB.locator('body').innerText()).length
await pageA.locator('textarea').fill('Write the numbers 1 to 40 in words, one per line (e.g. "one", "two", ...). No other text.')
await pageA.keyboard.press('Enter')
console.log('[A] sent long prompt')

// Poll B's DOM: record body length every 400ms for up to 45s.
const lens = []
const t0 = Date.now()
while (Date.now() - t0 < 45000) {
  const txt = await pageB.locator('body').innerText()
  lens.push(txt.length)
  if (txt.includes('forty') && lens.length > 3) break
  await pageB.waitForTimeout(400)
}
const distinct = [...new Set(lens)]
const growingSteps = lens.filter((v, i) => i > 0 && v > lens[i - 1]).length
console.log(`B DOM polls=${lens.length} distinct-lengths=${distinct.length} growing-steps=${growingSteps} (base=${baseLen}, final=${lens.at(-1)})`)
console.log(`B live streaming render: ${growingSteps >= 3 ? 'PASS (DOM grew incrementally across >=3 polls)' : 'FAIL/INCONCLUSIVE'}`)

await browser.close()
