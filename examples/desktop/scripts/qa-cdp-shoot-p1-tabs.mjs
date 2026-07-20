// scripts/qa-cdp-shoot-p1-tabs.mjs — lane-p1-tabs selfie driver.
//
// Proves the Chat pane's five-way view strip (List | Graph | 时序 | Trace |
// Log) end-to-end against a REAL renderer: it boots an isolated Electron,
// injects a mixed trace fixture through the DSH_QA=1 seam (__dshOnSessionEvent
// → onSessionEvent → cachedEvents), then drives the real tab buttons and
// shoots each view. Also drills a Tracing-page row to prove it lands on the
// Chat pane's Trace tab.
//
// Four shots into docs/qa-p1-tabs/:
//   p1-01-timeline   时序 tab — full-pane Gantt with span rows
//   p1-02-trace      Trace tab — tri-view (Graph default) over the session
//   p1-03-log        Log tab — filter chips + a row expanded
//   p1-04-tracing-nav Tracing row click landed on the Chat Trace tab
//
// Isolation follows scripts/qa-cdp-shoot-nav-optional.mjs:
//   --user-data-dir=<tmp> isolates Chromium userdata
//   DSH_DESKTOP_HOME=<tmp> isolates the main-process config root
//   DSH_QA=1 installs the injection seams (renderer.js §2626)
// CDP port ≥9300 per the task brief. Electron binary comes from the PARENT
// repo (this worktree has no node_modules).
//
// Usage: node scripts/qa-cdp-shoot-p1-tabs.mjs [port]

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync, statSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { tmpdir } from 'node:os'

const WORKTREE = resolve(process.env.DSH_WORKTREE || process.cwd())
const PARENT = resolve(process.env.DSH_REPO || '/Users/ziya/harness/dsh-desktop-demo')
const ELECTRON = join(PARENT, 'node_modules/.bin/electron')
const PORT = Number(process.argv[2] || process.env.DSH_P1_TABS_PORT || 9312)
const OUTDIR = join(WORKTREE, 'docs/qa-p1-tabs')
const FIXTURE = 'fixtures/trace-samples/2.1-turn-trajectory-mixed.json'

if (!existsSync(ELECTRON)) {
  console.error(`electron binary not found at ${ELECTRON}`)
  process.exit(2)
}
mkdirSync(OUTDIR, { recursive: true })

function seedHome(dshHome) {
  const seedOverlay = [
    '# QA p1-tabs-shoot seed overlay (tmp, per-run).',
    'plugins:',
    '  - "@cordisjs/plugin-include":',
    `      path: ${join(WORKTREE, 'config/daemon-echo.yml')}`,
    '',
  ].join('\n')
  writeFileSync(join(dshHome, 'user-overlay.cordis.yml'), seedOverlay)
  writeFileSync(join(dshHome, 'config.json'), JSON.stringify({ role: 'coding', approvalMode: 'never' }, null, 2))
  writeFileSync(join(dshHome, '.onboarded'), new Date().toISOString())
}

async function bootElectron(dshHome, userData, port) {
  const child = spawn(ELECTRON, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userData}`,
    '--disable-gpu',
    '--no-sandbox',
    '.',
  ], {
    cwd: WORKTREE,
    env: {
      ...process.env,
      DSH_DESKTOP_HOME: dshHome,
      DSH_MAXIMIZE: '1',
      DSH_QA: '1', // installs __dshOnSessionEvent + __dshRendererState seams
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = []
  child.stdout.on('data', (d) => { logs.push(String(d)) })
  child.stderr.on('data', (d) => { logs.push(String(d)) })
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    try {
      const r = await fetch(`http://localhost:${port}/json/list`)
      if (r.ok) return { child, logs }
    } catch {}
  }
  child.kill('SIGKILL')
  console.error('electron CDP did not come up in 20s. logs:\n' + logs.join(''))
  process.exit(3)
}

async function newCdp(port) {
  const targets = await (await fetch(`http://localhost:${port}/json/list`)).json()
  const target = targets.find((t) => t.type === 'page')
  if (!target) throw new Error('no page target on port ' + port)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = (e) => err(e) })
  let id = 1
  const pending = new Map()
  ws.onmessage = (ev) => {
    const data = typeof ev.data === 'string' ? ev.data : String(ev.data)
    let msg; try { msg = JSON.parse(data) } catch { return }
    if (msg.id != null && pending.has(msg.id)) {
      const [ok, err] = pending.get(msg.id); pending.delete(msg.id)
      if (msg.error) err(new Error(msg.error.message)); else ok(msg.result)
    }
  }
  const call = (m, p = {}, ms = 30000) => new Promise((ok, err) => {
    const _id = id++
    const t = setTimeout(() => { pending.delete(_id); err(new Error('cdp timeout: ' + m)) }, ms)
    pending.set(_id, [(v) => { clearTimeout(t); ok(v) }, (e) => { clearTimeout(t); err(e) }])
    ws.send(JSON.stringify({ id: _id, method: m, params: p }))
  })
  const evj = async (expr) => {
    const r = await call('Runtime.evaluate', {
      expression: `(async()=>{try{return (${expr})}catch(e){return {__err:String(e)}}})()`,
      returnByValue: true, awaitPromise: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result?.value
  }
  return { ws, call, evj, close: () => ws.close() }
}

async function shoot(c, name) {
  // Hide the debug panel + any right-column overlay so the view fills frame.
  await c.evj(`(function(){
    const p = document.querySelector('.debug-panel'); if (p) p.style.display='none'
    for (const sel of ['#context-rail-drawer','#context-rail','.devtools-drawer','#devtools-panel']) {
      const n = document.querySelector(sel); if (n) { n.hidden = true; n.style.display='none' }
    }
    return 1
  })()`)
  const shot = await c.call('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: 1440, height: 900, scale: 1 },
  })
  const path = join(OUTDIR, `${name}.png`)
  writeFileSync(path, Buffer.from(shot.data, 'base64'))
  const size = statSync(path).size
  console.log(`  wrote ${path} (${size} bytes)`)
  if (size < 20000) console.error(`  WARN: ${name}.png is ${size} bytes (<20KB) — likely blank`)
  return { path, size }
}

async function main() {
  const dshHome = join(tmpdir(), 'dsh-p1-tabs-home')
  const userData = join(tmpdir(), 'dsh-p1-tabs-userdata')
  for (const dir of [dshHome, userData]) {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
    mkdirSync(dir, { recursive: true })
  }
  seedHome(dshHome)
  console.log(`booting on port ${PORT}`)
  const { child } = await bootElectron(dshHome, userData, PORT)
  const results = []
  try {
    await sleep(1500)
    const c = await newCdp(PORT)
    await c.call('Page.enable')
    await c.evj(`window.dshQa && window.dshQa.revealWindow && window.dshQa.revealWindow()`)
    await c.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    // Land on the Chat pane and dismiss onboarding.
    await c.evj(`window.__dshTabs && window.__dshTabs.switchTo('chat')`)
    await c.evj(`(function(){
      document.body.classList.add('onboarded')
      const ob = document.querySelector('#onboarding, .onboarding, [data-onboarding]'); if (ob) ob.remove()
      return 1
    })()`)
    await sleep(200)

    // Inject the fixture through the real dispatcher so cachedEvents fills
    // (drives the trace aggregate + the Log live-merge) on a stable sid.
    const fixtureJson = readFileSync(join(WORKTREE, FIXTURE), 'utf8')
    const injected = await c.evj(`(async () => {
      const sid = 'p1-tabs-shot'
      const events = ${fixtureJson}
      const dispatch = window.__dshOnSessionEvent
      if (typeof dispatch !== 'function') return { err: 'no __dshOnSessionEvent seam (DSH_QA not set?)' }
      const s = document.getElementById('stream'); if (s) s.innerHTML = ''
      for (const ev of events) dispatch(sid, ev)
      // Make it the active session for the view refreshers.
      if (window.__dshRendererState) window.__dshRendererState.activeSessionId = sid
      return { sid, count: events.length }
    })()`)
    console.log('inject ->', JSON.stringify(injected))

    // ── p1-01: 时序 (Timeline) tab ──────────────────────────────────────
    const tl = await c.evj(`(function(){
      window.__dshRenderer.setChatView('timeline')
      const el = document.getElementById('chat-session-timeline')
      return { view: window.__dshRenderer.getChatView(), rows: el ? el.querySelectorAll('.trace-timeline-row').length : -1 }
    })()`)
    console.log('[p1-01 timeline]', JSON.stringify(tl))
    await sleep(400)
    results.push(await shoot(c, 'p1-01-timeline'))

    // ── p1-02: Trace tab ────────────────────────────────────────────────
    const tr = await c.evj(`(function(){
      window.__dshRenderer.setChatView('trace')
      const el = document.getElementById('chat-session-trace')
      return { view: window.__dshRenderer.getChatView(), tri: el ? el.querySelectorAll('.trace-tri-view').length : -1 }
    })()`)
    console.log('[p1-02 trace]', JSON.stringify(tr))
    await sleep(400)
    results.push(await shoot(c, 'p1-02-trace'))

    // ── p1-03: Log tab — chips visible + a row expanded ─────────────────
    const lg = await c.evj(`(async () => {
      window.__dshRenderer.setChatView('log')
      const el = document.getElementById('chat-session-log')
      // Log history walks window.dsh.sessionEvents; give it a beat, then the
      // fixture events are already merged as live entries via cachedEvents
      // replay. Expand the first row so the payload preview shows.
      await new Promise(r => setTimeout(r, 350))
      const rows = el ? el.querySelectorAll('.session-log-row') : []
      const chips = el ? el.querySelectorAll('.session-log-chip').length : -1
      if (rows.length) rows[0].open = true, rows[0].dispatchEvent(new Event('toggle'))
      return { view: window.__dshRenderer.getChatView(), rows: rows.length, chips }
    })()`)
    console.log('[p1-03 log]', JSON.stringify(lg))
    await sleep(400)
    results.push(await shoot(c, 'p1-03-log'))

    // ── p1-04: Tracing page row click lands on the Chat Trace tab ───────
    // Switch to the Tracing page, click the first session row, and assert
    // we bounced back to the Chat pane's Trace tab.
    const nav = await c.evj(`(async () => {
      window.__dshTabs.switchTo('tracing')
      if (window.__dshTracingPage && window.__dshTracingPage.show) window.__dshTracingPage.show()
      await new Promise(r => setTimeout(r, 300))
      const row = document.querySelector('.tracing-page-row')
      if (!row) return { err: 'no tracing row (no non-empty sessions projected)' }
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise(r => setTimeout(r, 400))
      const chatPane = document.querySelector('.pane[data-pane="chat"]')
      return {
        chatVisible: chatPane ? !chatPane.hidden : false,
        chatView: window.__dshRenderer.getChatView(),
      }
    })()`)
    console.log('[p1-04 tracing-nav]', JSON.stringify(nav))
    await sleep(300)
    results.push(await shoot(c, 'p1-04-tracing-nav'))

    await c.call('Emulation.clearDeviceMetricsOverride').catch(() => {})
    c.close()
  } finally {
    try { child.kill('SIGKILL') } catch {}
    for (let i = 0; i < 20; i++) {
      await sleep(500)
      try { await fetch(`http://localhost:${PORT}/json/list`) } catch { break }
    }
  }

  console.log('\n--- SUMMARY ---')
  let ok = true
  for (const r of results) {
    console.log(`  ${r.path}: ${r.size} bytes${r.size < 20000 ? '  <-- WARN <20KB' : ''}`)
    if (r.size < 20000) ok = false
  }
  if (!ok) { console.error('one or more shots are suspiciously small'); process.exit(4) }
}

main().catch((err) => { console.error(err); process.exit(1) })
