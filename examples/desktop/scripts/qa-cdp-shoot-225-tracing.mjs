// scripts/qa-cdp-shoot-225-tracing.mjs — task #225 selfie driver.
//
// Two shots proving the Tracing page (LangSmith-style project runs table):
//   225-01  Tracing tab active — full project runs table with seeded
//           multi-session data. Search box + Columns button visible.
//   225-02  Row clicked -> tri-view drilldown (Timeline default at
//           session scope). Back-to-Tracing breadcrumb visible.
//
// Usage:
//   node scripts/qa-cdp-shoot-225-tracing.mjs <port> <outdir>

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const [,, portArg, outdir] = process.argv
const port = portArg || '9241'
if (!outdir) {
  console.error('usage: node scripts/qa-cdp-shoot-225-tracing.mjs <port> <outdir>')
  process.exit(1)
}
mkdirSync(outdir, { recursive: true })

async function cdp() {
  const listRes = await fetch(`http://localhost:${port}/json/list`)
  const targets = await listRes.json()
  const target = targets.find((t) => t.type === 'page')
  if (!target) throw new Error('no page target on port ' + port)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, x) => { ws.onopen = r; ws.onerror = (e) => x(e) })

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
  const call = (m, p = {}, timeoutMs = 60000) => new Promise((ok, err) => {
    const _id = id++
    const t = setTimeout(() => { pending.delete(_id); err(new Error(`cdp timeout: ${m}`)) }, timeoutMs)
    pending.set(_id, [(v) => { clearTimeout(t); ok(v) }, (e) => { clearTimeout(t); err(e) }])
    ws.send(JSON.stringify({ id: _id, method: m, params: p }))
  })
  const evjs = async (js) => {
    const r = await call('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result?.value
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  return { call, evjs, sleep, close: () => ws.close() }
}

// Seed the renderer with N synthetic sessions by planting them directly
// into __dshChat's state.sessions Map via a QA-only helper. Uses the same
// discipline as qa-cdp-shoot-203-triview: no daemon required.
//
// Each session gets a fabricated event stream so the aggregator produces
// realistic P50 / P99 / tokens / cost numbers. Fixtures live in
// fixtures/trace-samples/ so we don't ship yet another copy.
const SEED_SPEC = [
  { id: 'sess-mixed', title: 'exploration · mixed_probe', fixture: '2.1-turn-trajectory-mixed.json' },
  { id: 'sess-agent', title: 'agent_turn refactor loop',   fixture: '2.6-subagent-inline-trace.json' },
  { id: 'sess-single', title: 'single_turn_qa arithmetic', fixture: '1.1-trace-one-turn.json' },
]

async function shoot(c, name, prep) {
  if (typeof prep === 'function') {
    const r = await c.evjs(prep())
    console.error('[' + name + '] prep ->', JSON.stringify(r))
    await c.sleep(400)
  }
  // Hide overlays / dev drawers that could occlude the table.
  await c.evjs(`(function(){
    const p = document.querySelector('.debug-panel'); if (p) p.style.display='none'
    for (const sel of ['#context-rail-drawer', '#context-rail', '.context-rail-drawer', '.context-rail', '.devtools-drawer', '#devtools-panel']) {
      const n = document.querySelector(sel)
      if (n) { n.hidden = true; n.setAttribute('aria-hidden', 'true'); n.style.display = 'none' }
    }
    const ob = document.querySelector('#onboarding, .onboarding, [data-onboarding]')
    if (ob) ob.remove()
    return 1
  })()`)
  const shot = await c.call('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: 1440, height: 900, scale: 1 },
  })
  const path = resolve(outdir, name + '.png')
  writeFileSync(path, Buffer.from(shot.data, 'base64'))
  console.log(path)
}

async function main() {
  const c = await cdp()
  await c.call('Page.enable')
  const revealed = await c.evjs(`(async()=>{try{return window.dshQa && await window.dshQa.revealWindow()}catch(e){return {err: String(e)}}})()`)
  console.error('reveal ->', JSON.stringify(revealed))
  await c.call('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  })

  // 225-01: Tracing tab active with populated table.
  //
  // Sequence:
  //   1) switchTo('tracing') — flips the pane visible + calls show()
  //      (which will find zero seeded rows in the offline env because
  //       refreshSessionList only knows the daemon's persisted list).
  //   2) Seed 3 synthetic sessions with fixture events; rewrite times
  //      onto a stagger so "Most Recent Run" reads sensibly.
  //   3) show() again — projection now finds the seeded events.
  //
  // The switchTo/seed ordering matters: seeding before switchTo would
  // be blown away by refreshSessionList inside switchTo.
  await shoot(c, '225-01-tracing-table', () => `(async () => {
    if (!window.__dshTabs || typeof window.__dshTabs.switchTo !== 'function') return { err: 'no tabs seam' }
    window.__dshTabs.switchTo('tracing')
    await new Promise(r => setTimeout(r, 400))
    const rs = window.__dshRendererState
    if (!rs) return { err: 'no state seam' }
    const specs = ${JSON.stringify(SEED_SPEC)}
    const now = Date.now()
    let offset = 0
    for (const spec of specs) {
      const url = new URL('../../fixtures/trace-samples/' + spec.fixture, window.location.href)
      const res = await fetch(url.href)
      if (!res.ok) return { err: 'fetch ' + spec.fixture + ': ' + res.status }
      const events = await res.json()
      const base = now - (offset * 5 * 60 * 1000)
      for (let i = 0; i < events.length; i++) {
        if (events[i] && typeof events[i] === 'object') {
          events[i].time = base - (events.length - i) * 250
        }
      }
      rs.sessions.set(spec.id, {
        title: spec.title, running: false, lastEventTime: base,
        toolCalls: new Map(), header: null, live: true, persisted: true,
        forkMarkers: new Map(), contextTracker: null, recallCards: new Map(),
        hasUserMessage: true, eventCount: events.length, cachedEvents: events,
      })
      offset++
    }
    if (window.__dshTracingPage) window.__dshTracingPage.show()
    await new Promise(r => setTimeout(r, 250))
    return { rows: document.querySelectorAll('.tracing-page-row').length }
  })()`)

  // 225-02: Row click -> tri-view drilldown.
  await shoot(c, '225-02-tracing-drilldown', () => `(async () => {
    // Ensure we're on the tracing tab first (previous shot left us there).
    const row = document.querySelector('.tracing-page-row')
    if (!row) return { err: 'no rows visible' }
    row.click()
    await new Promise(r => setTimeout(r, 400))
    // The tri-view mounts inside #tracing-page-detail and defaults to
    // Timeline at session scope. Wait for the SVG walk to settle.
    await new Promise(r => setTimeout(r, 400))
    return {
      breadcrumb: document.querySelector('#tracing-page-breadcrumb')?.hidden === false,
      detailHasView: !!document.querySelector('#tracing-page-detail .trace-tri-view'),
    }
  })()`)

  c.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
