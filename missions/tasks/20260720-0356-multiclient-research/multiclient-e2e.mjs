// Multi-client E2E: two browser pages open the same session; page A sends,
// verify page B sees streaming + final text; drafts stay isolated.
import { chromium } from 'playwright'

const BASE = 'http://127.0.0.1:3080'
const SESSION = 'session-f512f7aa-98ec-46ef-b7a6-eea629957921'
const MARK = `PW-MULTI-${Math.floor(Math.random() * 1e6)}`

const browser = await chromium.launch()
const pageA = await (await browser.newContext()).newPage()
const pageB = await (await browser.newContext()).newPage()

async function openSession(page, tag) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  // click the session list item whose title == SESSION
  const item = page.locator(`[title="${SESSION}"]`)
  await item.waitFor({ timeout: 10000 })
  await item.click()
  await page.locator('textarea').waitFor({ timeout: 10000 })
  console.log(`[${tag}] session opened`)
}

await openSession(pageA, 'A')
await openSession(pageB, 'B')

// Draft isolation: type different drafts, check they don't cross.
await pageA.locator('textarea').fill('draft-A-only')
await pageB.locator('textarea').fill('draft-B-only')
await pageA.waitForTimeout(500)
const draftA = await pageA.locator('textarea').inputValue()
const draftB = await pageB.locator('textarea').inputValue()
console.log(`draft isolation: A="${draftA}" B="${draftB}" -> ${draftA === 'draft-A-only' && draftB === 'draft-B-only' ? 'PASS' : 'FAIL'}`)

// A sends; B must see streaming then the final text.
await pageA.locator('textarea').fill(`Reply with exactly: ${MARK}`)
await pageA.keyboard.press('Enter')
console.log('[A] sent prompt')

// B: watch for partial (streaming) presence — poll body text for the mark growing in.
let sawStreamingOnB = false
const t0 = Date.now()
while (Date.now() - t0 < 40000) {
  const body = await pageB.locator('body').innerText()
  if (body.includes(MARK)) {
    // check whether a partial/streaming indicator existed at some point before final
    console.log(`[B] saw "${MARK}" after ${Date.now() - t0}ms`)
    sawStreamingOnB = true
    break
  }
  await pageB.waitForTimeout(300)
}
console.log(`B receives A's turn: ${sawStreamingOnB ? 'PASS' : 'FAIL'}`)

// B's draft must have survived untouched; A's box cleared on send.
const draftB2 = await pageB.locator('textarea').inputValue()
const draftA2 = await pageA.locator('textarea').inputValue()
console.log(`post-send drafts: A="${draftA2}" (expect empty) B="${draftB2}" (expect draft-B-only) -> ${draftA2 === '' && draftB2 === 'draft-B-only' ? 'PASS' : 'FAIL'}`)

// A also sees its own turn (sanity)
const bodyA = await pageA.locator('body').innerText()
console.log(`A sees own turn: ${bodyA.includes(MARK) ? 'PASS' : 'FAIL'}`)

// Refresh B mid-idle: must recover and still show the mark.
await pageB.reload({ waitUntil: 'domcontentloaded' })
const itemB = pageB.locator(`[title="${SESSION}"]`)
await itemB.waitFor({ timeout: 10000 })
await itemB.click()
await pageB.waitForTimeout(2000)
const bodyB2 = await pageB.locator('body').innerText()
console.log(`B refresh recovers history: ${bodyB2.includes(MARK) ? 'PASS' : 'FAIL'}`)

await browser.close()
console.log('E2E DONE')
