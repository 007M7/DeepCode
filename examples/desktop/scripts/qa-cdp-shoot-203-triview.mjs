// scripts/qa-cdp-shoot-203-triview.mjs — task #203 selfie driver.
//
// Three shots proving the trace tri-view (Tree | Timeline | Graph):
//   triview-01  Timeline tab active, turn scope — Gantt bars over a
//               single step (2.1 fixture)
//   triview-02  Graph tab active, session scope — DAG with fan-out
//               (2.6 subagent fixture)
//   triview-03  Turn footer with view-toggle chips visible (Tree default)
//
// Usage:
//   node scripts/qa-cdp-shoot-203-triview.mjs <port> <outdir>

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const [,, portArg, outdir] = process.argv
const port = portArg || '9238'
if (!outdir) {
  console.error('usage: node scripts/qa-cdp-shoot-203-triview.mjs <port> <outdir>')
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

async function shoot(c, name, opts) {
  const { fixture, prep, wait = 500, hideDebug = true } = opts
  // The daemon isn't up in this env (tsx resolution fails at spawn), so we
  // can't use __dshQaPlayFixture (it calls newSession() which needs a
  // supervisor). Bypass by planting a synthetic active session id + streamEl
  // reset + direct onSessionEvent dispatch through window.__dshFixtureInject
  // (a QA-only helper the driver installs on the first shot).
  const played = await c.evjs(`(async () => {
    // Wait up to 5s for the renderer to plant an active session (daemon
    // may still be spawning). Re-resolve each attempt so a late boot is
    // caught even after the first install.
    let sid = null; let tries = 0
    for (let i = 0; i < 50 && !sid; i++) {
      tries++
      const chat = (window.__dshChat && window.__dshChat.getActiveSessionId) || null
      sid = chat ? chat() : null
      if (!sid) await new Promise(r => setTimeout(r, 100))
    }
    console.log('[__dshTriviewInject] wait ->', {tries, sid})
    if (!window.__dshTriviewInject) {
      window.__dshTriviewInject = async function (fname, activeSid) {
        try {
          const sid = activeSid || 'triview-shot-' + Date.now()
          // Reset stream to a clean slate.
          const streamEl = document.getElementById('stream')
          if (streamEl) streamEl.innerHTML = ''
          const url = new URL('../../fixtures/trace-samples/' + fname, window.location.href)
          const r = await fetch(url.href)
          if (!r.ok) return { err: 'fetch ' + r.status }
          const events = await r.json()
          // Route through the same dispatcher the real wire uses. We reach it
          // via the same window.__dshChat.selectSession seam if present, else
          // fall through to onSessionEvent via internal seam.
          const bag = (typeof window !== 'undefined') ? window : {}
          // Plant activeSessionId via the private renderer seam if exposed.
          if (bag.__dshRendererState) bag.__dshRendererState.activeSessionId = sid
          // Direct dispatch: renderer.js exposes the onSessionEvent function
          // as window.__dshOnSessionEvent when DSH_QA=1 (see fallback shim
          // below in case it's absent).
          const dispatch = bag.__dshOnSessionEvent
          if (typeof dispatch !== 'function') {
            return { err: 'no __dshOnSessionEvent seam — direct inject unavailable' }
          }
          for (const ev of events) dispatch(sid, ev)
          return { sid, count: events.length }
        } catch (e) { return { err: String(e) } }
      }
    }
    return await window.__dshTriviewInject(${JSON.stringify(fixture)}, sid)
  })()`)
  console.error(`[${name}] play -> ${JSON.stringify(played)}`)
  await c.sleep(wait)
  if (typeof prep === 'function') {
    const r = await c.evjs(prep())
    console.error(`[${name}] prep -> ${JSON.stringify(r)}`)
    await c.sleep(400)
  }
  if (hideDebug) {
    await c.evjs(`(function(){
      const p = document.querySelector('.debug-panel'); if (p) p.style.display='none'
      // Hide any right-column overlay so the wide tri-view fits — cover
      // every id/class we know can appear in the right column.
      for (const sel of ['#context-rail-drawer', '#context-rail', '.context-rail-drawer', '.context-rail', '.devtools-drawer', '#devtools-panel']) {
        const n = document.querySelector(sel)
        if (n) {
          n.hidden = true
          n.setAttribute('aria-hidden', 'true')
          n.style.display = 'none'
        }
      }
      return 1
    })()`)
  }
  const shot = await c.call('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: 1440, height: 900, scale: 1 },
  })
  const path = resolve(outdir, `${name}.png`)
  writeFileSync(path, Buffer.from(shot.data, 'base64'))
  console.log(path)
}

async function main() {
  const c = await cdp()
  await c.call('Page.enable')
  const revealed = await c.evjs(`(async()=>{try{return window.dshQa && await window.dshQa.revealWindow()}catch(e){return {err: String(e)}}})()`)
  console.error(`reveal -> ${JSON.stringify(revealed)}`)
  await c.call('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  })
  const chatSwitch = await c.evjs(`window.__dshTabs && window.__dshTabs.switchTo && window.__dshTabs.switchTo('chat')`)
  console.error(`tab chat -> ${JSON.stringify(chatSwitch)}`)
  await c.sleep(200)

  // Dismiss onboarding overlay if present — it can eclipse trace UI.
  await c.evjs(`(function(){
    document.body.classList.add('onboarded')
    const ob = document.querySelector('#onboarding, .onboarding, [data-onboarding]')
    if (ob) ob.remove()
    // Hide the devtools drawer if it's open — it covers the right half
    // of the viewport and would mask the detail pane in our shots.
    for (const sel of ['#devtools-panel', '.devtools-drawer', '.devtools-panel-drawer', '[data-devtools-panel]']) {
      const dt = document.querySelector(sel)
      if (dt) { dt.hidden = true; dt.style.display = 'none' }
    }
    return 1
  })()`)

  try {
    // triview-01: Timeline at TURN scope. Build the tri-view standalone
    // via the pure module because the daemon-echo → turn-trace-drawer
    // path is fragile in the offline harness. The tri-view we render is
    // the same component finishTurnContainer wraps — this is the L3
    // canvas the user will interact with.
    await shoot(c, 'triview-01', {
      fixture: '2.1-turn-trajectory-mixed.json',
      wait: 600,
      prep: () => `(async () => {
        const tri = window.__dshTraceTriView
        const agg = window.__dshTraceAgg
        if (!tri || !agg) return 'NO_MODS'
        const url = new URL('../../fixtures/trace-samples/2.1-turn-trajectory-mixed.json', window.location.href)
        const r = await fetch(url.href)
        const events = await r.json()
        const records = agg.aggregateSteps(events)
        // Stage a wide preview container inside the chat stream so the
        // shot centers on it. Clear the stream first for a clean frame.
        const s = document.getElementById('stream')
        if (s) s.innerHTML = ''
        const host = document.createElement('div')
        host.style.padding = '16px'
        host.style.maxWidth = '860px'
        host.style.margin = '20px auto'
        host.style.border = '1px solid rgba(0,0,0,0.09)'
        host.style.borderRadius = '8px'
        host.style.background = 'var(--surface, #fff)'
        const label = document.createElement('div')
        label.style.font = '600 13px system-ui, sans-serif'
        label.style.marginBottom = '10px'
        label.textContent = 'Turn footer trace drawer — tri-view (Timeline active)'
        host.appendChild(label)
        const view = tri.buildTriView(document, {
          records: records[0] || {},
          scope: 'turn',
          defaultView: 'timeline',
          onSeqClick: () => {},
        })
        host.appendChild(view)
        s.appendChild(host)
        return { records: records.length, viewOk: !!view }
      })()`,
    })

    // triview-02: Graph at SESSION scope — same standalone approach,
    // over multiple aggregated steps from the mixed fixture. Shows the
    // fan-out edge (spawn_agent → subagent node) and the full graph
    // spine.
    await shoot(c, 'triview-02', {
      fixture: '2.6-subagent-inline-trace.json',
      wait: 600,
      prep: () => `(async () => {
        const tri = window.__dshTraceTriView
        const agg = window.__dshTraceAgg
        const url = new URL('../../fixtures/trace-samples/2.6-subagent-inline-trace.json', window.location.href)
        const r = await fetch(url.href)
        const events = await r.json()
        const records = agg.aggregateSteps(events)
        const s = document.getElementById('stream')
        if (s) s.innerHTML = ''
        const host = document.createElement('div')
        host.style.padding = '16px'
        host.style.maxWidth = '860px'
        host.style.margin = '20px auto'
        host.style.border = '1px solid rgba(0,0,0,0.09)'
        host.style.borderRadius = '8px'
        host.style.background = 'var(--surface, #fff)'
        const label = document.createElement('div')
        label.style.font = '600 13px system-ui, sans-serif'
        label.style.marginBottom = '10px'
        label.textContent = 'Full-session trace overlay — tri-view (Graph active, fan-out edge)'
        host.appendChild(label)
        const view = tri.buildTriView(document, {
          records,
          scope: 'session',
          defaultView: 'graph',
          onSeqClick: () => {},
        })
        host.appendChild(view)
        s.appendChild(host)
        return { records: records.length }
      })()`,
    })

    // triview-03: All three chips visible with Tree active (default).
    // The Tree panel shows a stub explaining per-turn availability at
    // session scope; at turn scope it would carry the pre-rendered trace
    // card. This shot demonstrates the chip toggle affordance itself.
    await shoot(c, 'triview-03', {
      fixture: '1.1-trace-one-turn.json',
      wait: 500,
      prep: () => `(async () => {
        const tri = window.__dshTraceTriView
        const agg = window.__dshTraceAgg
        const url = new URL('../../fixtures/trace-samples/1.1-trace-one-turn.json', window.location.href)
        const r = await fetch(url.href)
        const events = await r.json()
        const records = agg.aggregateSteps(events)
        const s = document.getElementById('stream')
        if (s) s.innerHTML = ''
        const host = document.createElement('div')
        host.style.padding = '16px'
        host.style.maxWidth = '760px'
        host.style.margin = '20px auto'
        host.style.border = '1px solid rgba(0,0,0,0.09)'
        host.style.borderRadius = '8px'
        host.style.background = 'var(--surface, #fff)'
        const label = document.createElement('div')
        label.style.font = '600 13px system-ui, sans-serif'
        label.style.marginBottom = '10px'
        label.textContent = 'Tri-view chips (Tree | Timeline | Graph) with Export SVG affordance'
        host.appendChild(label)
        // Build a stand-in tree element so the Tree tab has content.
        const tree = document.createElement('div')
        tree.style.padding = '12px'
        tree.style.color = '#6b6b70'
        tree.style.font = '12px ui-monospace, monospace'
        tree.textContent = '(tree view: reuses the existing per-turn trace card — chips let the reader flip to Timeline or Graph without leaving the turn)'
        const view = tri.buildTriView(document, {
          treeEl: tree,
          records: records[0] || {},
          scope: 'turn',
          defaultView: 'tree',
          onSeqClick: () => {},
        })
        host.appendChild(view)
        s.appendChild(host)
        return { records: records.length }
      })()`,
    })

    // triview-04: (task #215) span-tree — the per-turn trace card with
    // real start→end waterfall bars on each event row. Renders the
    // renderer.js path directly so the shot proves the tree-with-time is
    // integrated, not just an isolated module. Uses the 2.1 turn fixture
    // via the __dshOnSessionEvent seam.
    await shoot(c, 'triview-04', {
      fixture: '2.1-turn-trajectory-mixed.json',
      wait: 600,
      prep: () => `(async () => {
        // The renderer already produced trace-card DOM via the injected
        // events. Find the last trace-card and scroll it into view so the
        // shot centers on the inline span bars.
        const cards = document.querySelectorAll('.trace-card')
        const last = cards[cards.length - 1]
        if (last) {
          last.setAttribute('open', '')
          const pane = last.querySelector('.trace-pane-events')
          if (pane) pane.setAttribute('open', '')
          last.scrollIntoView({ block: 'center' })
        }
        // Enrich the label header so the shot is self-explanatory.
        const s = document.getElementById('stream')
        if (s && !s.querySelector('[data-triview-04-header]')) {
          const label = document.createElement('div')
          label.setAttribute('data-triview-04-header', '1')
          label.style.font = '600 13px system-ui, sans-serif'
          label.style.margin = '12px auto 8px auto'
          label.style.maxWidth = '760px'
          label.style.padding = '0 16px'
          label.textContent = 'Span-tree waterfall — each event row shows start→end alignment (#215)'
          s.insertBefore(label, s.firstChild)
        }
        return { cards: cards.length }
      })()`,
    })

    // triview-05: (task #205) detail pane — tri-view stage with a step
    // selected, right-side pane open on the Output tab, tool_calls
    // rendered as KV blocks and arguments expandable.
    await shoot(c, 'triview-05', {
      fixture: '2.1-turn-trajectory-mixed.json',
      wait: 600,
      prep: () => `(async () => {
        const tri = window.__dshTraceTriView
        const agg = window.__dshTraceAgg
        if (!tri || !agg) return 'NO_MODS'
        const url = new URL('../../fixtures/trace-samples/2.1-turn-trajectory-mixed.json', window.location.href)
        const r = await fetch(url.href)
        const events = await r.json()
        const records = agg.aggregateSteps(events)
        const s = document.getElementById('stream')
        if (s) s.innerHTML = ''
        // Also collapse the devtools drawer so the right column is visible
        const dt = document.getElementById('devtools-panel')
        if (dt) dt.hidden = true
        const host = document.createElement('div')
        host.style.padding = '16px'
        host.style.maxWidth = '1180px'
        host.style.margin = '20px auto'
        host.style.border = '1px solid rgba(0,0,0,0.09)'
        host.style.borderRadius = '8px'
        host.style.background = 'var(--surface, #fff)'
        const label = document.createElement('div')
        label.style.font = '600 13px system-ui, sans-serif'
        label.style.marginBottom = '10px'
        label.textContent = 'Tri-view detail pane — node click opens Feedback / Input / Output / Attributes (#205)'
        host.appendChild(label)
        const view = tri.buildTriView(document, {
          records,
          scope: 'session',
          sessionId: 'triview-shot-session',
          defaultView: 'timeline',
          onSeqClick: () => {},
        })
        host.appendChild(view)
        s.appendChild(host)
        // Wait for lazy timeline build, then dispatch a click on a row
        // that has a real seq. SVG groups don't have .click().
        await new Promise((r) => setTimeout(r, 220))
        const rowsWithSeq = view.querySelectorAll('[data-seq]:not([data-seq=""])')
        // First row is the step header; the second (tool/call) is more
        // illustrative because it has real tool_call output content.
        let target = rowsWithSeq[0]
        for (const r of rowsWithSeq) {
          const sq = r.getAttribute('data-seq')
          if (sq && Number(sq) >= 3) { target = r; break }
        }
        if (target) target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        // Give lazy panel build time to run.
        await new Promise((r) => setTimeout(r, 60))
        return { records: records.length, opened: !!target, hasDetail: view.classList.contains('has-detail') }
      })()`,
    })
  } finally {
    await c.call('Emulation.clearDeviceMetricsOverride').catch(() => {})
    c.close()
  }
}
main().catch((e) => { console.error(String(e)); process.exit(1) })
