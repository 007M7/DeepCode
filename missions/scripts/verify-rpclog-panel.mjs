// RPC panel browser acceptance (fixture mode); step tags §D-1..§D-6 match the report labels.
// Prereqs: dsh web running on 3080, apps/web/dist freshly built, playwright chromium installed.
// Run: node missions/scripts/verify-rpclog-panel.mjs   (not part of any gate system)
import { chromium } from 'playwright'

const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080'
let failures = 0

function report(name, pass, detail = '') {
  failures += pass ? 0 : 1
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.goto(`${BASE}/?fixture`, { waitUntil: 'load' })

  // §D-1 page shell + rpclog rail button present, unread badge > 0 (boot auto-ping + subscribed frames); shell presence = the list sidebar.
  await page.waitForSelector('aside')
  const railBtn = page.locator('nav button[title="RPC 日志"]')
  await railBtn.waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const el = document.querySelector('nav button[title="RPC 日志"] span[class*="unread"]')
    return el !== null && /\d/.test(el.textContent ?? '')
  }, undefined, { timeout: 5000 })
  report('§D-1 角标存在且未读数 > 0', true)

  // §D-2 activate the rpclog bar: the ledger page fills the panel area, kinds cover three quadrants (direction symbols ↑ ↓ ⇟, up/down spatial metaphor)
  await railBtn.click()
  const list = page.locator('section:has(header)').locator('div[class*="list"]')
  await list.waitFor({ state: 'visible' })
  const rowTexts = await list.locator('button[class*="rowLine"]').allTextContents()
  const joined = rowTexts.join('\n')
  const hasThree = joined.includes('↑') && joined.includes('↓') && joined.includes('⇟')
  report('§D-2 展开见台账，三象限方向符齐', hasThree, `rows=${rowTexts.length}`)
  const unreadAfterOpen = await page.locator('span[class*="unread"]').count()
  report('§D-2 展开后未读徽标消失', unreadAfterOpen === 0)

  // §D-3 click ping: adds one client-request/server-response pair (host.describe)
  const rowsBefore = await list.locator('button[class*="rowLine"]').count()
  await page.locator('button', { hasText: 'ping' }).click()
  await page.waitForFunction(
    (n) => document.querySelectorAll('button[class*="rowLine"]').length >= n + 2,
    rowsBefore, { timeout: 3000 },
  )
  const lastTwo = (await list.locator('button[class*="rowLine"]').allTextContents()).slice(-2)
  const pingPair = lastTwo[0]?.includes('host.describe') && lastTwo[0]?.includes('↑')
    && lastTwo[1]?.includes('host.describe') && lastTwo[1]?.includes('↓')
  report('§D-3 ping 新增一对 describe 往返', Boolean(pingPair), lastTwo.map((t) => t.slice(0, 30)).join(' | '))

  // §D-3b hover pair highlight: hovering the last row (server-response) lights its client-request row too
  const rows = list.locator('div[class*="row"]:not([class*="rowLine"])')
  await list.locator('button[class*="rowLine"]').last().hover()
  await page.waitForTimeout(100)
  const pairedCount = await list.locator('div[class*="rowPaired"]').count()
  report('§D-3b hover 同 rpcId 配对行高亮（2 行）', pairedCount === 2, `paired=${pairedCount}`)

  // §D-4 click a row to expand the JSON payload, click again to collapse
  const firstRow = list.locator('button[class*="rowLine"]').first()
  await firstRow.click()
  const payloadShown = await list.locator('pre[class*="payload"]').count()
  await firstRow.click()
  const payloadHidden = await list.locator('pre[class*="payload"]').count()
  report('§D-4 点行 JSON 展开/收起', payloadShown === 1 && payloadHidden === 0)

  // §D-5 scrolling up pauses; resume restores follow
  // First overflow the list (no scroll overflow → onScroll can never fire): click ping until ≥30 rows
  while (await list.locator('button[class*="rowLine"]').count() < 30) {
    await page.locator('button', { hasText: 'ping' }).click()
    await page.waitForTimeout(30)
  }
  await list.evaluate((el) => { el.scrollTop = 0 })
  await page.waitForSelector('div[class*="pausedBar"]', { timeout: 3000 })
  const resumeBtn = page.locator('button', { hasText: '继续' })
  report('§D-5 上滚触发暂停（按钮态+提示条）', await resumeBtn.count() === 1)
  await resumeBtn.click()
  await page.waitForTimeout(100)
  const followRestored = await list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 30)
  report('§D-5b 继续恢复贴底跟随', followRestored)

  // §D-6 clear: list empty, counters reset; periodic frames keep arriving (wait 6s for new rows)
  await page.locator('button', { hasText: '清空' }).click()
  const emptyAfterClear = await list.locator('button[class*="rowLine"]').count()
  report('§D-6 清空后列表空', emptyAfterClear === 0)
  await page.waitForFunction(
    () => document.querySelectorAll('button[class*="rowLine"]').length > 0,
    undefined, { timeout: 8000 },
  )
  report('§D-6b 清空后周期帧继续进入', true)
} catch (error) {
  failures += 1
  console.log(`FAIL  脚本异常 — ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await browser.close()
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
