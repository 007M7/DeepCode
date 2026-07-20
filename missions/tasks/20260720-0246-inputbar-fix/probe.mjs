// InputBar bug probe (fixture mode). Run: node /tmp/inputbar-probe.mjs
import { chromium } from 'playwright'

const BASE = process.env.DSC_WEB_URL ?? 'http://127.0.0.1:3080'
const out = []
const note = (id, verdict, detail = '') => {
  out.push(`${verdict.padEnd(10)} ${id}  ${detail}`)
  console.log(`${verdict.padEnd(10)} ${id}  ${detail}`)
}

const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto(`${BASE}/?fixture`, { waitUntil: 'load' })
await page.waitForSelector('aside button[title="fx-alpha"]')
await page.locator('aside button[title="fx-alpha"]').click()
await page.waitForSelector('main textarea')
const input = page.locator('main textarea')
// fx-alpha opens running=true; ruling 3 locks the textarea then — reset to idle before probing.
{
  const stop = page.locator('main button[aria-label="停止"]')
  if (await stop.count()) {
    await stop.click()
    await page.waitForSelector('main div[class*="head"] span[data-running]', { state: 'detached', timeout: 5000 }).catch(() => {})
  }
}

// P1: IME composition Enter — dispatch keydown with isComposing=true; message must NOT send
await input.fill('中文候选')
const bubblesBefore = await page.locator('main div[class*="bubble"]').count()
await input.evaluate((el) => {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }))
})
await page.waitForTimeout(300)
const bubblesAfterIme = await page.locator('main div[class*="bubble"]').count()
const draftAfterIme = await input.inputValue()
note('P1-IME组合期Enter', bubblesAfterIme > bubblesBefore ? 'BUG' : 'OK', `bubbles ${bubblesBefore}->${bubblesAfterIme}, draft="${draftAfterIme}"`)
// cleanup: if sent, wait for replay to finish via stop
if (bubblesAfterIme > bubblesBefore) {
  const stop = page.locator('main button[aria-label="停止"]')
  if (await stop.count()) await stop.click()
  await page.waitForSelector('main div[class*="head"] span[data-running]', { state: 'detached', timeout: 5000 }).catch(() => {})
}
await input.fill('')

// P2: cursor jump when editing mid-text (async controlled value)
await input.fill('abcdef')
await input.evaluate((el) => { el.setSelectionRange(3, 3) })
await input.press('x') // insert at middle -> expect "abcxdef", cursor at 4
await page.waitForTimeout(120)
const p2 = await input.evaluate((el) => ({ v: el.value, s: el.selectionStart }))
note('P2-中段编辑光标', p2.v === 'abcxdef' && p2.s === 4 ? 'OK' : 'BUG', `value="${p2.v}" cursor=${p2.s} (expect abcxdef@4)`)
await input.fill('')

// P2b: rapid typing loses chars?
await input.click()
await page.keyboard.type('快速输入测试1234567890', { delay: 5 })
await page.waitForTimeout(150)
const p2b = await input.inputValue()
note('P2b-快速输入丢字', p2b === '快速输入测试1234567890' ? 'OK' : 'BUG', `value="${p2b}"`)
await input.fill('')

// P3: double Enter double send (same text sent twice before draft clears)
const b3 = await page.locator('main div[class*="bubble"]').count()
await input.fill('双发探测')
await input.press('Enter')
await input.press('Enter')
await page.waitForTimeout(500)
const dupes = await page.locator('main div[class*="bubble"]', { hasText: '双发探测' }).count()
note('P3-连按Enter重复发送', dupes > 1 ? 'BUG' : 'OK', `"双发探测" bubbles=${dupes} (total ${b3}->${await page.locator('main div[class*="bubble"]').count()})`)
{ const stop = page.locator('main button[aria-label="停止"]'); if (await stop.count()) await stop.click(); await page.waitForSelector('main div[class*="head"] span[data-running]', { state: 'detached', timeout: 5000 }).catch(() => {}) }

// P4 (ruling 3 semantics): sending locks the box; focus must return to the textarea once the turn ends
await input.fill('焦点探测')
await page.locator('main button[class*="primary"]').click()
await page.waitForTimeout(300)
{ const stop = page.locator('main button[aria-label="停止"]'); if (await stop.count()) await stop.click(); await page.waitForSelector('main div[class*="head"] span[data-running]', { state: 'detached', timeout: 5000 }).catch(() => {}) }
await page.waitForTimeout(200)
const focusIsTextarea = await page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA')
note('P4-解禁后焦点回输入框', focusIsTextarea ? 'OK' : 'BUG', `activeElement=${await page.evaluate(() => document.activeElement?.tagName)}`)

// P5 (ruling 3 semantics): running locks the box — typing mid-turn must be dropped, draft frozen.
await input.fill('在途探测')
await input.press('Enter')
await input.pressSequentially('后续输入', { delay: 10 }).catch(() => {})
await page.waitForTimeout(400)
const p5 = await input.inputValue()
const p5locked = await input.isDisabled()
note('P5-运行期输入锁定', p5locked && !p5.includes('后续输入') ? 'OK' : 'BUG', `locked=${p5locked} draft="${p5}"`)
{ const stop = page.locator('main button[aria-label="停止"]'); if (await stop.count()) await stop.click(); await page.waitForSelector('main div[class*="head"] span[data-running]', { state: 'detached', timeout: 5000 }).catch(() => {}) }
await input.fill('')

// P6: soft-wrap long single-line paste — rows stays 1?
await input.fill('这是一段没有换行符但是非常长的文本'.repeat(8))
await page.waitForTimeout(100)
const p6 = await input.evaluate((el) => ({ rows: el.rows, clientH: el.clientHeight, scrollH: el.scrollHeight }))
note('P6-软换行不增高', p6.rows === 1 && p6.scrollH > p6.clientH + 4 ? 'BUG' : 'OK', `rows=${p6.rows} clientH=${p6.clientH} scrollH=${p6.scrollH}`)
await input.fill('')

// P7: multi-line growth via Shift+Enter, height-capped at the 14-line baseline (mirror-div method)
await input.click()
const h1line = (await input.boundingBox())?.height ?? 0
for (let i = 0; i < 3; i++) { await page.keyboard.type(`L${i}`); await page.keyboard.press('Shift+Enter') }
await page.waitForTimeout(100)
const h4line = (await input.boundingBox())?.height ?? 0
for (let i = 3; i < 20; i++) { await page.keyboard.type(`L${i}`); await page.keyboard.press('Shift+Enter') }
await page.waitForTimeout(100)
const h20line = (await input.boundingBox())?.height ?? 0
const p7ok = h4line > h1line + 20 && h20line <= 344 && h20line > h4line
note('P7-多行自增高+封顶', p7ok ? 'OK' : 'BUG', `h(1)=${h1line} h(4)=${h4line} h(21)=${h20line} (cap≈336)`)
await input.fill('')

// P8: whitespace-only draft — buttons disabled? Enter no-op?
await input.fill('   \n  ')
const sendDisabled = !(await page.locator('main button[class*="primary"]').isEnabled())
await input.press('Enter')
await page.waitForTimeout(200)
const p8bubbles = await page.locator('main div[class*="bubble"]').count()
note('P8-空白输入', sendDisabled ? 'OK' : 'BUG', `sendDisabled=${sendDisabled}`)
await input.fill('')

// P9: draft kept across session switch
await input.fill('切换保稿探测')
await page.locator('aside button[title="fx-beta"]').click()
await page.waitForTimeout(300)
const betaDraft = await page.locator('main textarea').inputValue()
await page.locator('aside button[title="fx-alpha"]').click()
await page.waitForTimeout(300)
const backDraft = await page.locator('main textarea').inputValue()
note('P9-切session草稿', backDraft === '切换保稿探测' && betaDraft === '' ? 'OK' : 'BUG', `beta="${betaDraft}" back="${backDraft}"`)

// P10: focus after switching session — textarea focused?
const p10 = await page.evaluate(() => document.activeElement?.tagName)
note('P10-切session焦点', p10 === 'TEXTAREA' ? 'OK' : 'INFO', `activeElement=${p10}`)

// P11: stop button appearance shifts send/steer position (layout jump)
await page.locator('main textarea').fill('布局探测')
const sendBox1 = await page.locator('main button[class*="primary"]').boundingBox()
await page.locator('main button[class*="primary"]').click()
await page.waitForSelector('main button[aria-label="停止"]', { timeout: 3000 })
const sendBox2 = await page.locator('main button[class*="primary"]').boundingBox()
note('P11-停止钮引发布局跳动', Math.abs((sendBox1?.y ?? 0) - (sendBox2?.y ?? 0)) > 2 ? 'BUG' : 'OK', `send.y ${sendBox1?.y} -> ${sendBox2?.y}`)
{ const stop = page.locator('main button[aria-label="停止"]'); if (await stop.count()) await stop.click(); await page.waitForSelector('main div[class*="head"] span[data-running]', { state: 'detached', timeout: 5000 }).catch(() => {}) }

// P12: Enter autorepeat (hold Enter) — many sends?
const b12 = await page.locator('main div[class*="bubble"]').count()
await page.locator('main textarea').fill('重复探测')
await page.locator('main textarea').evaluate((el) => {
  for (let i = 0; i < 3; i++) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, repeat: true }))
})
await page.waitForTimeout(400)
const p12 = await page.locator('main div[class*="bubble"]', { hasText: '重复探测' }).count()
note('P12-Enter长按autorepeat', p12 > 1 ? 'BUG' : p12 === 1 ? 'INFO' : 'OK', `sent=${p12}`)

await browser.close()
console.log('\n--- done ---')
