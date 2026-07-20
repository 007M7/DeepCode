// Session UI browser acceptance (fixture mode); step tags match the report labels.
// Prereqs: dsh web running on 3080, apps/web/dist freshly built, playwright chromium installed.
// Run: node missions/scripts/verify-session.mjs   (not part of any gate system)
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

  // §E1-1 three list rows + fx-alpha running dot + fx-beta lineage indent + empty right pane
  await page.waitForSelector('aside button[class*="item"]', { timeout: 5000 })
  const items = page.locator('aside button[class*="item"]')
  report('§E1-1a 列表 3 条', await items.count() === 3, `count=${await items.count()}`)
  const alphaDot = page.locator('aside button[title="fx-alpha"] span[class*="running"]')
  report('§E1-1b fx-alpha running 绿点', await alphaDot.count() === 1)
  const betaPad = await page.locator('aside button[title="fx-beta"]').evaluate((el) => el.style.paddingLeft)
  report('§E1-1c fx-beta 谱系缩进（depth=1 → 24px）', betaPad === '24px', `paddingLeft=${betaPad}`)
  report('§E1-1d 右侧空态', (await page.locator('main').textContent())?.includes('选择或新建') ?? false)

  // §E1-2 open fx-alpha: all history node kinds render, scroll lands at bottom
  await page.locator('aside button[title="fx-alpha"]').click()
  await page.waitForSelector('main div[class*="bubble"]', { timeout: 5000 })
  const mainText = await page.locator('main').textContent()
  report('§E1-2a user 气泡渲出', (mainText ?? '').includes('问题 59'))
  report('§E1-2b assistant 正文渲出', (mainText ?? '').includes('回答 59'))
  // Bottom check BEFORE expanding reasoning (a local expand grows height without triggering follow — view state, not a snapshot change; by design).
  const scroll = page.locator('main div[class*="scroll"]')
  const atBottom = await scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 30)
  report('§E1-2i 打开后滚动在底部', atBottom)
  const reasoningToggle = page.locator('main button[class*="reasoningToggle"]').last()
  report('§E1-2c reasoning 折叠钮存在', await reasoningToggle.count() > 0)
  await reasoningToggle.click()
  report('§E1-2d reasoning 展开有内容', ((await page.locator('main').textContent()) ?? '').includes('思考过程'))
  report('§E1-2e 工具卡渲出', await page.locator('main div[class*="card"] span[class*="name"]', { hasText: 'echo' }).count() > 0)
  report('§E1-2f steering 徽标渲出', await page.locator('main span[class*="badge"]', { hasText: '插话' }).count() > 0)
  report('§E1-2g context 折叠卡渲出', await page.locator('main button', { hasText: '上下文注入' }).count() > 0)
  report('§E1-2h 常驻审批占位卡', await page.locator('main div[class*="card"]', { hasText: '等待审批' }).count() === 1)

  // §E1-3 load-older: prepend one page, viewport stays anchored
  const olderBtn = page.locator('main button', { hasText: '加载更早' })
  report('§E1-3a hasMore 显示加载更早钮', await olderBtn.count() === 1)
  const beforeAnchor = await scroll.evaluate((el) => ({ h: el.scrollHeight, t: el.scrollTop }))
  await scroll.evaluate((el) => { el.scrollTop = 0 }) // scroll up before paging (realistic gesture)
  const anchorTop = await scroll.evaluate((el) => el.scrollTop)
  await olderBtn.click()
  await page.waitForFunction((prev) => {
    const el = document.querySelector('main div[class*="scroll"]')
    return el !== null && el.scrollHeight > prev
  }, beforeAnchor.h, { timeout: 5000 })
  const afterAnchor = await scroll.evaluate((el) => ({ h: el.scrollHeight, t: el.scrollTop }))
  const drift = Math.abs(afterAnchor.t - (anchorTop + (afterAnchor.h - beforeAnchor.h)))
  report('§E1-3b 翻页锚定（scrollTop 补偿高度差）', drift < 4, `drift=${drift}px`)
  report('§E1-3c 更早消息已前插', ((await page.locator('main').textContent()) ?? '').includes('问题 20'))

  // §E1-5 send (queue): user bubble lands + typewriter partial + finalize; draft clears.
  // Button rulings 2026-07-20: one primary button (send idle / stop running); running locks the input.
  const input = page.locator('main textarea')
  const primaryBtn = page.locator('main button[class*="primary"]')
  // fx-alpha opens running=true (fixture list material) — the merged primary reads 停止 there; reset to idle first.
  if (await primaryBtn.getAttribute('aria-label') === '停止') {
    await primaryBtn.click()
    await page.waitForSelector('main div[class*="head"] span[data-running]', { state: 'detached', timeout: 5000 })
  }
  await input.fill('验收消息一')
  await primaryBtn.click()
  await page.waitForSelector('main div[class*="bubble"]:has-text("验收消息一")', { timeout: 3000 })
  report('§E1-5a user 气泡入流', true)
  report('§E1-5b 草稿清空', await input.inputValue() === '')
  // Typewriter: the partial pulse is visible
  await page.waitForSelector('main span[class*="pulse"]', { timeout: 3000 })
  report('§E1-5c 流式 partial 脉冲出现', true)
  // Running dot lights up (fixture prompt flips status)
  await page.waitForSelector('main div[class*="head"] span[data-running]', { timeout: 3000 })
  report('§E1-5d running 状态点亮', true)

  // §E1-6 running locks the input (ruling 2026-07-20 #3, supersedes the hover menu):
  // textarea disabled (draft visible but frozen), no queue/steer menu, stop is the only action.
  report('§E1-6a running 时输入框置灰', await input.isDisabled())
  report('§E1-6b running 时无排队/插话菜单', await page.locator('main button[class*="menuItem"]').count() === 0)
  report('§E1-6c running 时主按钮为停止且可用', await primaryBtn.isEnabled() && (await primaryBtn.getAttribute('aria-label')) === '停止')

  // Wait for finalize: pulse gone + echo body present (partial -> finalized node swap)
  await page.waitForSelector('main span[class*="pulse"]', { state: 'detached', timeout: 15000 })
  report('§E1-5e 定稿切换（脉冲消失）', true)
  report('§E1-5f 回声正文定稿', ((await page.locator('main').textContent()) ?? '').includes('回声：验收消息一'))

  // §E1-7 stop: send another, the primary button flips to stop (same slot) mid-replay
  await input.fill('验收消息二')
  await primaryBtn.click()
  await page.waitForSelector('main button[aria-label="停止"]', { timeout: 3000 })
  report('§E1-7d 运行中主按钮原地变停止', true)
  await primaryBtn.click() // now the stop action
  await page.waitForSelector('main div[class*="head"] span[data-running]', { state: 'detached', timeout: 5000 })
  report('§E1-7a 停止后 running 熄灭', true)
  report('§E1-7b 中断标记入流', ((await page.locator('main').textContent()) ?? '').includes('（已中断）'))
  report('§E1-7e 停止后主按钮回到发送', await primaryBtn.getAttribute('aria-label') === '发送')
  // Turn end unlocks the box and returns focus (before any fill taints activeElement).
  await page.waitForTimeout(200)
  report('§E1-7f 停止解禁后焦点回输入框', await page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA'))
  await input.fill('x')
  await primaryBtn.hover()
  await page.waitForTimeout(300)
  report('§E1-7c 无排队/插话菜单（空闲 hover 亦无）', await page.locator('main button[class*="menuItem"]').count() === 0)
  await input.fill('')

  // §E1-8 switch to fx-beta and back: empty conversation / instant re-render (resident instances)
  await page.locator('aside button[title="fx-beta"]').click()
  await page.waitForFunction(() => {
    const main = document.querySelector('main')
    return main !== null && (main.textContent ?? '').includes('fx-beta')
  }, undefined, { timeout: 3000 })
  const betaBubbles = await page.locator('main div[class*="bubble"]').count()
  report('§E1-8a fx-beta 空对话', betaBubbles === 0, `bubbles=${betaBubbles}`)
  const t0 = Date.now()
  await page.locator('aside button[title="fx-alpha"]').click()
  await page.waitForSelector('main div[class*="bubble"]:has-text("验收消息一")', { timeout: 2000 })
  report('§E1-8b 切回 fx-alpha 即时呈现（常驻实例）', Date.now() - t0 < 1500, `${Date.now() - t0}ms`)

  // §E1-9 create selects and opens immediately
  const before = await items.count()
  await page.locator('aside button[title="新建 session"]').click()
  await page.waitForFunction((n) => document.querySelectorAll('aside button[class*="item"]').length > n, before, { timeout: 3000 })
  const newSelected = await page.locator('aside button[class*="selected"]').getAttribute('title')
  report('§E1-9 新建即入列表并选中', newSelected !== null && newSelected.startsWith('fx-'), `selected=${newSelected}`)

  // §E1-11 InputBar regression pins (IME composition / autorepeat / caret / autosize / draft semantics)
  await page.locator('aside button[title="fx-alpha"]').click()
  const inputBox = page.locator('main textarea')
  await inputBox.waitFor({ timeout: 3000 })

  // B1: composition Enter must not send (IME candidate pick)
  const bubblesB1 = await page.locator('main div[class*="bubble"]').count()
  await inputBox.fill('IME 探测')
  await inputBox.evaluate((el) => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }))
  })
  await page.waitForTimeout(200)
  report('§E1-11a IME 组合期 Enter 不发送', await page.locator('main div[class*="bubble"]').count() === bubblesB1 && await inputBox.inputValue() === 'IME 探测')

  // B6: key-repeat Enter must not send
  await inputBox.evaluate((el) => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, repeat: true }))
  })
  await page.waitForTimeout(200)
  report('§E1-11b Enter 长按 autorepeat 不发送', await page.locator('main div[class*="bubble"]').count() === bubblesB1)
  await inputBox.fill('')

  // B2: mid-text edit keeps the caret (synchronous controlled-value notify)
  await inputBox.fill('abcdef')
  await inputBox.evaluate((el) => el.setSelectionRange(3, 3))
  await inputBox.press('x')
  await page.waitForTimeout(100)
  const caret = await inputBox.evaluate((el) => ({ v: el.value, s: el.selectionStart }))
  report('§E1-11c 中段编辑光标不跳', caret.v === 'abcxdef' && caret.s === 4, `value=${caret.v} caret=${caret.s}`)
  await inputBox.fill('')

  // B3: soft-wrap long text grows the box (mirror-div auto-grow), capped at the 14-line baseline (336px)
  const hEmpty = (await inputBox.boundingBox())?.height ?? 0
  await inputBox.fill('这是一段没有换行符但是非常长的文本'.repeat(60))
  await page.waitForTimeout(100)
  const hLong = (await inputBox.boundingBox())?.height ?? 0
  report('§E1-11d 软换行自增高且封顶', hLong > hEmpty + 20 && hLong <= 344, `h ${hEmpty} -> ${hLong}`)
  await inputBox.fill('')

  // B4 (reworked under ruling 3): sending locks the box for the turn; focus returns on unlock (pinned at §E1-7f)
  const primary = page.locator('main button[class*="primary"]')
  await inputBox.fill('焦点验收')
  await primary.click()
  await page.waitForTimeout(200)
  report('§E1-11e 发送后运行期输入锁定', await inputBox.isDisabled())
  report('§E1-11f 发送即清稿（乐观清）', await inputBox.inputValue() === '')

  // B5: single primary slot — the button must not move when running flips (send<->stop in place)
  await page.waitForSelector('main button[aria-label="停止"]', { timeout: 3000 })
  const yRunning = (await primary.boundingBox())?.y ?? -1
  await primary.click() // stop
  await page.waitForSelector('main div[class*="head"] span[data-running]', { state: 'detached', timeout: 5000 })
  const yIdle = (await primary.boundingBox())?.y ?? -2
  report('§E1-11g 发送/停止原地切换不跳动', Math.abs(yRunning - yIdle) < 2, `primary.y ${yRunning} vs ${yIdle}`)

  // Sending force-scrolls to the bottom even when scrolled away (own words must be visible;
  // passive follow still respects scrolled-away readers during streaming).
  const scrollBox = page.locator('main div[class*="scroll"]')
  await scrollBox.evaluate((el) => { el.scrollTop = 0 })
  await inputBox.fill('置底验收消息')
  await primary.click()
  await page.waitForSelector('main div[class*="bubble"]:has-text("置底验收消息")', { timeout: 3000 })
  const nearBottom = await scrollBox.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 30)
  report('§E1-11h 上滚状态下发送强制置底', nearBottom)
  await page.waitForSelector('main button[aria-label="停止"]', { timeout: 3000 })
  await primary.click() // stop the replay to leave the fixture idle
  await page.waitForSelector('main div[class*="head"] span[data-running]', { state: 'detached', timeout: 5000 })

  // §E1-10 RPC panel cross-check: this run's traffic is visible in the ledger (history/prompt/cancel round trips).
  // The ledger is a left-menu bar page now: activate it from the icon rail, assert panel-area content.
  await page.locator('nav button[title="RPC 日志"]').click()
  await page.waitForSelector('section[class*="panel"]', { timeout: 3000 })
  const panelText = (await page.locator('section[class*="panel"]').textContent()) ?? ''
  const sawHistory = panelText.includes('session.history') || panelText.includes('session/event')
  report('§E1-10 调试面板见 session 流量', sawHistory)
  await page.locator('nav button[title="会话列表"]').click() // restore the sessions panel for later steps

  // §E1-12 时序批（audit S1/S3/S4）：fixture __fxTiming 后门制造慢 history / 丢帧 / 重连窗口。
  // 新开 page = 全新 fixture 实例，不受上面步骤污染。
  const page2 = await browser.newPage()
  await page2.goto(`${BASE}/?fixture`, { waitUntil: 'load' })
  await page2.waitForSelector('aside button[title="fx-alpha"]', { timeout: 5000 })

  // S1: open 窗口期来的 live 帧必须缝合进窗口（慢 history 下打开正在流式的会话）
  await page2.evaluate(() => globalThis.__fxTiming.setHistoryDelay(700))
  await page2.locator('aside button[title="fx-alpha"]').click()
  await page2.waitForTimeout(120) // open 在途（history 还有 ~580ms 才回）
  await page2.evaluate(() => {
    globalThis.__fxTiming.appendUser('fx-alpha', '开窗期实时消息A')
    globalThis.__fxTiming.appendUser('fx-alpha', '开窗期实时消息B')
  })
  // 就绪信号用气泡而非 textarea：fx-alpha 初始 running=true，输入框在 running 期被禁用
  await page2.waitForSelector('main div[class*="bubble"]', { timeout: 8000 })
  await page2.waitForSelector('main div[class*="bubble"]:has-text("开窗期实时消息B")', { timeout: 5000 }).catch(() => {})
  await page2.evaluate(() => globalThis.__fxTiming.setHistoryDelay(0))
  const s1Text = (await page2.locator('main').textContent()) ?? ''
  report('§E1-12a open 期间来帧缝合不丢（S1）', s1Text.includes('开窗期实时消息A') && s1Text.includes('开窗期实时消息B'))
  report('§E1-12b 缝合后无 fold 降级（S1）', !s1Text.includes('历史视图降级'))

  // S3: 途中丢一帧造出 seq 洞 → resync-lite 重拉尾页找回丢帧，且不触发 fold 降级
  await page2.evaluate(() => {
    globalThis.__fxTiming.appendSilent('fx-alpha', '途中丢失的消息C') // 只进 log 不发 mux 帧
    globalThis.__fxTiming.appendUser('fx-alpha', '洞后到达的消息D') // client 看见 seq 跳 2
  })
  const gapRepaired = await page2.waitForSelector('main div[class*="bubble"]:has-text("途中丢失的消息C")', { timeout: 5000 }).then(() => true).catch(() => false)
  report('§E1-12c seq 洞触发补拉，丢帧经 history 找回（S3）', gapRepaired)
  const s3Text = (await page2.locator('main').textContent()) ?? ''
  report('§E1-12d 洞后帧不丢（S3）', s3Text.includes('洞后到达的消息D'))
  report('§E1-12e 洞不再触发 fold 降级（S3）', !s3Text.includes('历史视图降级'))

  // S4: open 在途时断线，在途 history 注定失败 → 重连 resync 的 generation 必须作废旧结果，
  // 不得在新窗口成功打开后被迟到的旧失败定格成 error。用 fx-beta（无定时素材，running 恒 false）。
  await page2.evaluate(() => {
    globalThis.__fxTiming.setHistoryDelay(1200)
    globalThis.__fxTiming.failNextHistory()
  })
  await page2.locator('aside button[title="fx-beta"]').click()
  await page2.waitForTimeout(150) // 注定失败的 open 在途
  await page2.evaluate(() => {
    globalThis.__fxTiming.setHistoryDelay(0)
    globalThis.__fxTiming.breakStreams() // 双流断 → 重连（退避 ~250-500ms + 宽限 150ms）→ resync
  })
  await page2.waitForSelector('main textarea:not([disabled])', { timeout: 8000 })
  await page2.waitForTimeout(1400) // 等旧 doomed 请求（~1350ms 处）失败落地后再断言
  const s4ErrStrips = await page2.locator('main div[class*="openError"]').count()
  const s4InputOk = await page2.locator('main textarea:not([disabled])').count()
  report('§E1-12f 断线窗口在途 open 不定格失败（S4 generation 作废）', s4ErrStrips === 0 && s4InputOk === 1, `errStrips=${s4ErrStrips} input=${s4InputOk}`)
  await page2.close()

  // §E1-13 引用稳定（audit S5+C3）：流式 chunk 期间 memo 必须真实命中——
  // 稳定的 ToolCallCard/SessionListItem 渲染次数不随 chunk 帧线性增长。
  const page3 = await browser.newPage()
  await page3.addInitScript(() => { globalThis.__renderCounts = {} })
  await page3.goto(`${BASE}/?fixture`, { waitUntil: 'load' })
  await page3.waitForSelector('aside button[title="fx-alpha"]', { timeout: 5000 })
  await page3.locator('aside button[title="fx-alpha"]').click()
  await page3.waitForSelector('main div[class*="bubble"]', { timeout: 8000 })
  // 复位到空闲（fx-alpha 开局 running）
  const primary3 = page3.locator('main button[class*="primary"]')
  if (await primary3.getAttribute('aria-label') === '停止') {
    await primary3.click()
    await page3.waitForSelector('main div[class*="head"] span[data-running]', { state: 'detached', timeout: 5000 })
  }
  await page3.evaluate(() => { globalThis.__renderCounts = {} })
  // 发送触发 fixture 流式回放（约 20+ 个 chunk 帧）
  await page3.locator('main textarea').fill('memo 稳定性验收')
  await primary3.click()
  await page3.waitForSelector('main span[class*="pulse"]', { timeout: 5000 })
  await page3.waitForSelector('main span[class*="pulse"]', { state: 'detached', timeout: 20000 })
  const counts = await page3.evaluate(() => globalThis.__renderCounts)
  // 历史窗口 50 条消息里有 ~10 张工具卡，全部已定稿：chunk 期间它们的 props 引用应稳定，
  // memo 全程命中 → 整轮流式回放中每张卡渲染次数为 0（发送时快照 nodes 未变）。
  // 列表条目：running 翻转 2 次（true/false）+ updatedAt 变 1 次是合法渲染，帧驱动重渲则会到几十次。
  const toolRenders = counts.ToolCallCard ?? 0
  const listRenders = counts.SessionListItem ?? 0
  report('§E1-13a 流式期间已定稿工具卡 memo 命中（S5）', toolRenders <= 12, `ToolCallCard renders=${toolRenders}（10 卡；>12 即 memo 失效）`)
  report('§E1-13b 流式期间列表条目 memo 命中（S5+C3）', listRenders <= 12, `SessionListItem renders=${listRenders}（3 行 × 合法状态翻转；>12 即 memo 失效）`)

  // §E1-15 tool 卡三级回退（toolcard-wire）：fixture 60-62 turn 携带三型 view 样本；
  // echo（无 presenter）钉住无 view 兜底 JSON 卡路径。
  {
    const scroll3 = page3.locator('main div[class*="scroll"]')
    // fx-bash terminal 卡：命令占卡头 name 槽 + cwd + exit 胶囊 + 输出
    const termCmd = await page3.locator('main span[class*="name"]', { hasText: 'ls -la' }).count()
    const termCwd = await page3.locator('main span[class*="cwd"]', { hasText: '/tmp/fixture' }).count()
    const termPill = await page3.locator('main span[class*="pill"]', { hasText: 'exit 0' }).count()
    report('§E1-15a terminal 卡渲出（命令+cwd+exit 胶囊）', termCmd >= 1 && termCwd >= 1 && termPill >= 1, `cmd=${termCmd} cwd=${termCwd} pill=${termPill}`)
    const termOut = (await scroll3.textContent() ?? '').includes('drwxr-xr-x fixture')
    report('§E1-15b terminal 卡输出体渲出', termOut)
    // fx-write diff 卡：path 头 + 新文本块
    const diffPath = await page3.locator('main div[class*="diffPath"]', { hasText: 'notes/demo.txt' }).count()
    const diffNew = await page3.locator('main pre[class*="diffNew"]', { hasText: 'hello fixture' }).count()
    report('§E1-15c diff 卡渲出（path 头+新文本）', diffPath >= 1 && diffNew >= 1, `path=${diffPath} new=${diffNew}`)
    // fx-note generic 卡：view 标题上头 + kind 图标
    const genTitle = await page3.locator('main span[class*="name"]', { hasText: '记录笔记' }).count()
    report('§E1-15d generic 卡渲出（view 标题）', genTitle >= 1, `title=${genTitle}`)
    // echo 无 presenter：老 JSON 折叠卡兜底（参数折叠钮仍在）
    const echoCard = await page3.locator('main div[class*="card"]:has(span[class*="name"]:text-is("echo")) button', { hasText: '参数' }).count()
    report('§E1-15e 无 view 工具兜底 JSON 卡（echo）', echoCard >= 1, `echoParamToggles=${echoCard}`)
  }

  // §E1-16 壳骨架（app-shell knife 3）：tabs 条在、占位页渲、点 tool 卡展开右栏 detail、再点收起。
  {
    // tabs 条：conversation + gantt 两 tab 注册后条自然出现（单 tab 时不渲染的分支反证）。
    const tabConv = await page3.locator('main button', { hasText: '会话' }).count()
    const tabGantt = await page3.locator('main button', { hasText: '甘特' }).count()
    report('§E1-16a tabs 条渲出（会话+甘特）', tabConv >= 1 && tabGantt >= 1, `conv=${tabConv} gantt=${tabGantt}`)
    // 占位页：切甘特 tab 渲说明性占位，切回会话流还在。
    await page3.locator('main button', { hasText: '甘特' }).click()
    const placeholderText = (await page3.locator('main').textContent()) ?? ''
    report('§E1-16b 甘特占位页渲出', placeholderText.includes('视图建设中'))
    await page3.locator('main button', { hasText: '会话' }).first().click()
    await page3.waitForSelector('main div[class*="bubble"]', { timeout: 3000 })
    // 点 tool 卡头 → 右栏 detail 展开（callId+argsRaw JSON）；同卡再点 → 收起。
    const echoHead = page3.locator('main div[class*="card"]:has(span[class*="name"]:text-is("echo")) div[class*="head"]').first()
    await echoHead.click()
    const detailShown = await page3.waitForSelector('span[class*="detailTitle"]', { timeout: 3000 }).then(() => true).catch(() => false)
    const detailText = detailShown ? (await page3.locator('div[class*="detailBody"]').textContent()) ?? '' : ''
    report('§E1-16c 点卡展开右栏 detail（callId+argsRaw）', detailShown && detailText.includes('callId') && detailText.includes('argsRaw'))
    await echoHead.click()
    const detailGone = await page3.waitForSelector('span[class*="detailTitle"]', { state: 'detached', timeout: 3000 }).then(() => true).catch(() => false)
    report('§E1-16d 同卡再点收起', detailGone)
    // 关闭钮路径：再开一次，点 × 收起（空 detail 兜底由 jsdom 层守）。
    await echoHead.click()
    await page3.waitForSelector('span[class*="detailTitle"]', { timeout: 3000 })
    await page3.locator('button[title="关闭详情"]').click()
    const closedByBtn = await page3.waitForSelector('span[class*="detailTitle"]', { state: 'detached', timeout: 3000 }).then(() => true).catch(() => false)
    report('§E1-16e 关闭钮收起', closedByBtn)
  }

  // §E1-14 连接状态可见（audit C1）：断流 → 顶部细条出现；重连成功 → 细条消失。
  report('§E1-14a 连接正常时无断线细条', await page3.locator('div[class*="banner"]').count() === 0)
  await page3.evaluate(() => globalThis.__fxTiming.breakStreams())
  const bannerShown = await page3.waitForSelector('div[class*="banner"]', { timeout: 5000 }).then(() => true).catch(() => false)
  report('§E1-14b 断流后重连细条出现', bannerShown)
  const bannerGone = await page3.waitForSelector('div[class*="banner"]', { state: 'detached', timeout: 8000 }).then(() => true).catch(() => false)
  report('§E1-14c 重连成功后细条消失', bannerGone)
  await page3.close()
} catch (error) {
  failures += 1
  console.log(`FAIL  脚本异常 — ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await browser.close()
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
