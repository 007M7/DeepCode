// Real-host spot check (condensed acceptance + connection stability): real sessions in the list,
// history renders on open, real prompt streams back. The stability assertions guard against
// fixture masking: fake streams never touch real SSE, so bridge-layer bugs (e.g. the req 'close'
// misdetection) only surface against a real host.
import { chromium } from 'playwright'
const BASE = process.env.VERIFY_BASE ?? 'http://127.0.0.1:3080'
let failures = 0
const report = (n, p, d = '') => { failures += p ? 0 : 1; console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`) }
const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)))
  const apiRequests = []
  let apiFailed = 0
  page.on('request', (r) => { if (r.url().includes('/api/')) apiRequests.push(r.url()) })
  page.on('requestfailed', (r) => { if (r.url().includes('/api/')) apiFailed++ })
  await page.goto(`${BASE}/`, { waitUntil: 'load' })
  // E2-0 connection stability: within a 12s window /api requests must be one-time setup cost
  // (two streams + describe + list <= 10), zero aborts. The 300ms reconnect storm
  // (the bridge bug fixed 2026-07-20) shows up here instantly.
  await page.waitForTimeout(12000)
  report('E2-0a 12s 内 /api 请求 ≤10（无重连风暴）', apiRequests.length <= 10, `count=${apiRequests.length}`)
  report('E2-0b 无 requestfailed（SSE 不被 client abort）', apiFailed === 0, `failed=${apiFailed}`)
  // E2-0c cold-session merge: list must include persisted sessions from previous host runs,
  // not just in-memory attached ones (guards the R4 regression: first screen empty after
  // restart). Requires at least one prior run's session on disk — every run of this script
  // leaves some behind, so only a truly virgin .sessions root skips the assertion.
  const listRes = await page.evaluate(async (base) => {
    const res = await fetch(`${base}/api/session.list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'verify-cold-list', method: 'session.list', payload: {} }),
    })
    return res.json()
  }, BASE)
  const coldItems = listRes?.result?.ok ? listRes.result.value.items : []
  const sorted = coldItems.every((it, i) => i === 0 || coldItems[i - 1].updatedAt >= it.updatedAt)
  if (coldItems.length > 0) {
    report('E2-0c 冷 session 进 list 且 updatedAt 倒序', sorted, `count=${coldItems.length}`)
    const coldRows = await page.locator('aside button[class*="item"]').count()
    report('E2-0d 首屏列表渲染冷 session（非空）', coldRows >= 1, `rows=${coldRows}`)
    // Legacy no-cwd logs are not served (pre-release stance: no compatibility) —
    // every listed session must carry its project cwd.
    const noCwd = coldItems.filter((it) => typeof it.cwd !== 'string' || it.cwd.length === 0)
    report('E2-0c2 无 cwd 存量不可见（全部条目携带 project cwd）', noCwd.length === 0, `noCwd=${noCwd.length}`)
  } else {
    console.log('SKIP  E2-0c/E2-0c2/E2-0d 冷 session 断言（.sessions 为空的全新 host）')
  }
  // E2-0e error-channel fidelity: an unknown id must come back as session-not-found,
  // never disguised as internal (and vice versa — guards the R3 regression).
  const nf = await page.evaluate(async (base) => {
    const res = await fetch(`${base}/api/session.history`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'verify-not-found', method: 'session.history', payload: { sessionId: 'session-00000000-dead-beef-0000-000000000000' } }),
    })
    return res.json()
  }, BASE)
  report('E2-0e 未知 id 回 session-not-found（不伪装 internal）', nf?.result?.ok === false && nf.result.error.code === 'session-not-found', `code=${nf?.result?.error?.code}`)
  // E2-1 create a real session into the list via '+' (covers the create path).
  await page.locator('aside button[title="新建 session"]').click()
  await page.waitForSelector('aside button[class*="item"]', { timeout: 8000 })
  const n = await page.locator('aside button[class*="item"]').count()
  report('E2-1 新建真 session 入列表', n >= 1, `count=${n}`)
  // E2-1b default-project injection: a create without an explicit cwd must still get one
  // (the host default — its process working directory), so the session lands in a project
  // bucket instead of _no-cwd (guards the B-decision regression).
  const afterCreate = await page.evaluate(async (base) => {
    const res = await fetch(`${base}/api/session.list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'verify-default-cwd', method: 'session.list', payload: {} }),
    })
    return res.json()
  }, BASE)
  const newest = afterCreate?.result?.ok ? afterCreate.result.value.items[0] : undefined
  report('E2-1b 新建 session 携带默认 cwd（host 进程目录注入）', typeof newest?.cwd === 'string' && newest.cwd.length > 0, `cwd=${newest?.cwd ?? '(absent)'}`)
  // E2-2 open the first row: openState reaches open (input enabled)
  await page.locator('aside button[class*="item"]').first().click()
  await page.waitForSelector('main textarea:not([disabled])', { timeout: 8000 })
  report('E2-2 打开真 session（history 通、输入可用）', true)
  // E2-3 real prompt: user bubble lands + partial pulse (real model streaming).
  // Ask for a ~100-char reply: too-short replies finish inside waitForSelector's polling gap,
  // making the pulse assertion race into a false failure.
  await page.locator('main textarea').fill('用大约100字介绍事件溯源，最后一句以「介绍完毕」结尾')
  await page.locator('main button[class*="primary"]').click()
  await page.waitForSelector('main div[class*="bubble"]', { timeout: 5000 })
  report('E2-3a user 气泡入流', true)
  const sawPulse = await page.waitForSelector('main span[class*="pulse"]', { timeout: 30000 }).then(() => true).catch(() => false)
  report('E2-3b 真模型流式 partial 出现', sawPulse)
  await page.waitForSelector('main span[class*="pulse"]', { state: 'detached', timeout: 60000 })
  const text = (await page.locator('main').textContent()) ?? ''
  report('E2-3c 回复定稿入流', text.includes('介绍完毕') || text.includes('事件溯源'), text.slice(-60))
  // E2-4 stop mid-stream freezes the partial (aborted turns never finalize): the accumulated
  // text survives as an interrupted terminal node (已停止 marker), the pulse stops, and later
  // messages land after it. A reload must reconstruct the same node from the logged chunks.
  const primary = page.locator('main button[class*="primary"]')
  await page.locator('main textarea').fill('请从头背诵出师表全文，直接开始不要客套')
  await primary.click()
  await page.waitForSelector('main span[class*="pulse"]', { timeout: 30000 })
  // Let visible content accumulate so the frozen node has a body to keep.
  await page.waitForTimeout(2500)
  await primary.click() // stop mid-stream (the no-finalize abort path)
  await page.waitForSelector('main div[class*="head"] span[data-running]', { state: 'detached', timeout: 15000 })
  const pulseGone = await page.waitForSelector('main span[class*="pulse"]', { state: 'detached', timeout: 2000 }).then(() => true).catch(() => false)
  const frozenMark = await page.locator('main span[class*="stopped"]', { hasText: '已停止' }).count()
  report('E2-4a 停止后 partial 定格（脉冲停+已停止标记+文本保留）', pulseGone && frozenMark >= 1, `pulseGone=${pulseGone} marks=${frozenMark}`)
  await page.locator('main textarea').fill('请只回复四个字：顺序正常')
  await primary.click()
  await page.waitForSelector('main div[class*="bubble"]:has-text("顺序正常")', { timeout: 10000 })
  const rows = await page.evaluate(() => {
    const scroll = document.querySelector('main div[class*="scroll"]')
    return [...(scroll?.children ?? [])].map((el) => (el.textContent ?? '').trim()).filter(Boolean)
  })
  const iStopped = rows.findIndex((t) => t.includes('出师表'))
  const iNew = rows.findIndex((t) => t.includes('顺序正常'))
  report('E2-4b 停止后再发消息顺序正确（新消息在末尾）', iNew > iStopped && iStopped >= 0, `stopped@${iStopped} new@${iNew}`)
  // E2-4c reload: history replay re-freezes the interrupted node (live view and replay agree).
  await page.waitForSelector('main span[class*="pulse"]', { state: 'detached', timeout: 60000 })
  await page.reload({ waitUntil: 'load' })
  await page.locator('aside button[class*="item"]').first().click()
  await page.waitForSelector('main textarea:not([disabled])', { timeout: 8000 })
  const marksAfterReload = await page.locator('main span[class*="stopped"]', { hasText: '已停止' }).count()
  report('E2-4c 刷新后中断消息仍在（history 重建一致）', marksAfterReload >= 1, `marks=${marksAfterReload}`)
} catch (e) {
  failures += 1
  console.log(`FAIL  脚本异常 — ${String(e).slice(0, 300)}`)
} finally {
  await browser.close()
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
