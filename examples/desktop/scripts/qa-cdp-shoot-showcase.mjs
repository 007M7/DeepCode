// scripts/qa-cdp-shoot-showcase.mjs — boss showcase batch (20 shots).
//
// Drives a fresh DSH_QA=1 Electron on --remote-debugging-port=9260 via
// CDP; every shot uses fixture/mock data (no API burn). Writes PNGs into
// docs/demo-shots/showcase-2026-07-18/ named 01-*.png … 20-*.png in list
// order so the summary can be relayed 1:1.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [,, portArg, outdirArg] = process.argv
const port = portArg || '9260'
const outdir = outdirArg || 'docs/demo-shots/showcase-2026-07-18'
mkdirSync(outdir, { recursive: true })

// ---------------- CDP plumbing ----------------
async function cdp() {
  const listRes = await fetch(`http://localhost:${port}/json/list`)
  const targets = await listRes.json()
  const target = targets.find((t) => t.type === 'page')
  if (!target) throw new Error('no page target on port ' + port)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, x) => { ws.onopen = r; ws.onerror = (e) => x(e) })

  let id = 1
  const pending = new Map()
  const consoleEntries = []
  ws.onmessage = (ev) => {
    const data = typeof ev.data === 'string' ? ev.data : String(ev.data)
    let msg; try { msg = JSON.parse(data) } catch { return }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params?.args || []).map((a) => a?.value ?? a?.description ?? '').join(' ')
      consoleEntries.push({ level: msg.params?.type, text })
      return
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const desc = msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text || ''
      consoleEntries.push({ level: 'exception', text: desc })
      return
    }
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
  await call('Runtime.enable')
  await call('Page.enable')
  return { call, evjs, sleep, consoleEntries, close: () => ws.close() }
}

async function shoot(c, name) {
  // Retry once — heavy fixtures + expanded trees can push a single capture
  // past the default 60s window; a second attempt after a short breath
  // usually succeeds.
  let r
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      r = await c.call('Page.captureScreenshot', { format: 'png' }, 90000)
      break
    } catch (e) {
      if (attempt === 2) throw e
      console.log('  captureScreenshot retry:', e.message)
      await c.sleep(1500)
    }
  }
  const p = resolve(outdir, name + '.png')
  writeFileSync(p, Buffer.from(r.data, 'base64'))
  const size = Buffer.from(r.data, 'base64').length
  console.log('  wrote', p, `(${(size / 1024).toFixed(0)} KB)`)
  return { path: p, size }
}

async function closeDevtools(c) {
  await c.evjs(`(function(){
    const btn = document.querySelector('.devtools-drawer .devtools-close')
    if (btn) { btn.click(); return { closed: true } }
    const d = document.querySelector('.devtools-drawer')
    if (d && !d.hidden) { d.hidden = true; return { closed: 'hidden' } }
    return { closed: false }
  })()`)
}

// closeOverlays — reset any transient right/drawer overlays that leak between
// shots (fork compare drawer, context rail drawer). Called before every shot
// so the visible pane fills the frame without residue from the previous prep.
async function closeOverlays(c) {
  await c.evjs(`(function(){
    // Fork compare drawer — has its own close button + hidden fallback
    const forkBtn = document.querySelector('.fork-compare-drawer button, #fork-compare-drawer button')
    // The Close chip carries "Close" text — walk close-family buttons.
    const forkCloseBtns = document.querySelectorAll('.fork-compare-drawer button, #fork-compare-drawer button, .playground-compare-drawer button')
    for (const b of forkCloseBtns) {
      const txt = (b.textContent || '').trim().toLowerCase()
      if (txt === 'close' || txt === '×' || b.classList.contains('close')) { b.click(); break }
    }
    const forkDrawer = document.querySelector('.fork-compare-drawer, #fork-compare-drawer')
    if (forkDrawer) forkDrawer.hidden = true
    // Note: do NOT set style.display here — openForkCompare's re-open only
    // toggles hidden (the property), so a stuck display:none would blank the
    // drawer even after a fresh mock fires.
    // Context rail drawer
    const railClose = document.getElementById('context-rail-drawer-close')
    if (railClose) railClose.click()
    const rail = document.getElementById('context-rail-drawer')
    if (rail && !rail.hidden) rail.hidden = true
    // Devtools drawer
    const dtClose = document.querySelector('.devtools-drawer .devtools-close')
    if (dtClose) dtClose.click()
    const dt = document.querySelector('.devtools-drawer')
    if (dt && !dt.hidden) dt.hidden = true
    // Compact drawer / any generic overlay drawer
    const drawers = document.querySelectorAll('.overlay-drawer[open], details.overlay-drawer[open]')
    drawers.forEach(d => { try { d.open = false } catch (_) {} })
    // Runtime warning banner ("The daemon reported an issue.") — cosmetic
    // but crowds the top of every shot; dismiss it via its own X button
    // so subsequent shots start clean.
    const bannerX = document.querySelector('#chat-runtime-banner .chat-runtime-banner-dismiss')
    if (bannerX) bannerX.click()
    const banner = document.getElementById('chat-runtime-banner')
    if (banner) banner.remove()
    // Annotation "Rate trajectory" side panel — persists across tab
    // switches; nuke it explicitly so shots 16-21 don't inherit shot 15's
    // panel. The panel exposes a close via window.__dshAnnotation.close.
    if (window.__dshAnnotation && typeof window.__dshAnnotation.close === 'function') {
      try { window.__dshAnnotation.close() } catch (_) {}
    }
    const ann = document.querySelector('#annotation-drawer, .annotation-drawer, .annotation-panel, [data-annotation-panel]')
    if (ann) { ann.hidden = true; ann.setAttribute('aria-hidden', 'true'); ann.style.display = 'none' }
    // Full-trace overlay — belt-and-suspenders in case shots 05-08 chained
    // and the caller forgot the explicit cleanup.
    const overlay = document.querySelector('.devtools-full-trace-overlay')
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay)
    return { ok: true }
  })()`)
}

async function switchTab(c, name) {
  return c.evjs(`(function(){
    if (window.__dshTabs && typeof window.__dshTabs.switchTo === 'function') {
      window.__dshTabs.switchTo(${JSON.stringify(name)})
      return { via: 'switchTo' }
    }
    const btn = document.querySelector('.tab-btn[data-tab="' + ${JSON.stringify(name)} + '"]')
    if (btn) { btn.click(); return { via: 'click' } }
    return { via: 'none' }
  })()`)
}

async function clickById(c, id) {
  return c.evjs(`(function(){
    const b = document.getElementById(${JSON.stringify(id)})
    if (b) { b.click(); return { ok: true, id: ${JSON.stringify(id)} } }
    return { ok: false, id: ${JSON.stringify(id)} }
  })()`)
}

async function scrollTop(c, sel) {
  return c.evjs(`(function(){
    const el = ${sel ? `document.querySelector(${JSON.stringify(sel)})` : 'document.getElementById("stream")'}
    if (el) { el.scrollTop = 0; return { ok: true } }
    return { ok: false }
  })()`)
}

async function scrollBottom(c, sel) {
  return c.evjs(`(function(){
    const el = ${sel ? `document.querySelector(${JSON.stringify(sel)})` : 'document.getElementById("stream")'}
    if (el) { el.scrollTop = el.scrollHeight; return { ok: true, sh: el.scrollHeight } }
    return { ok: false }
  })()`)
}

async function seedFresh(c) {
  await switchTab(c, 'chat')
  await c.sleep(200)
  return c.evjs(`(async () => {
    const { id } = await window.dsh.newSession()
    if (typeof window.__dshChat === 'object' && window.__dshChat && typeof window.__dshChat.select === 'function') {
      await window.__dshChat.select(id)
    }
    // Clear the stream so residual fixtures from the last shot are gone.
    const s = document.getElementById('stream'); if (s) s.innerHTML = ''
    return { id }
  })()`)
}

async function playFixture(c, name) {
  return c.evjs(`(async () => {
    if (typeof window.__dshQaPlayFixture !== 'function') return { err: 'no seam' }
    return await window.__dshQaPlayFixture(${JSON.stringify(name)})
  })()`)
}

async function loadSample(c) {
  return c.evjs(`(async () => {
    if (typeof window.__dshLoadSampleTrace === 'function') {
      await window.__dshLoadSampleTrace()
      return { via: 'loadSampleTrace' }
    }
    return { via: 'none' }
  })()`)
}

// ---------------- driver ----------------
async function main() {
  const c = await cdp()
  await c.evjs(`document.title`) // handshake
  console.log('CDP handshake OK on port', port)

  // Set the viewport to 1440×900 via Emulation.setDeviceMetricsOverride
  // (the main.js hardcodes 1200×800; overriding here gives the requested
  // showcase framing without touching source).
  await c.call('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
  })
  await c.sleep(300)

  const notes = []
  const rec = async (name, note, fn) => {
    console.log('shot:', name, '—', note)
    // Reset every transient overlay before we prep this shot's state so leftover
    // drawers from #12/etc. don't bleed through.
    try { await closeOverlays(c) } catch (_) {}
    await c.sleep(120)
    try {
      await fn()
    } catch (e) {
      console.log('  prep err:', e.message)
      notes.push({ name, note, err: e.message })
      return
    }
    await c.sleep(400)
    await closeDevtools(c)
    await c.sleep(150)
    const res = await shoot(c, name)
    notes.push({ name, note, size: res.size })
  }

  // ── 01 Chat 空态 launcher (4 卡) ─────────────────────────────────────
  await rec('01-chat-empty-launcher', 'Chat 空态：4 卡 launcher 一屏', async () => {
    await switchTab(c, 'chat')
    await c.sleep(300)
    // Force the empty-welcome block back: if the daemon auto-selected a prior
    // session, fetch the template and re-inject the launcher.
    await c.evjs(`(async () => {
      const stream = document.getElementById('stream'); if (!stream) return
      const res = await fetch(window.location.href.split('#')[0])
      const html = await res.text()
      const m = html.match(/<div class="empty-welcome"[\\s\\S]*?<\\/div>\\s*<\\/div>\\s*<\\/section>/)
      if (!m) return
      const block = m[0].replace(/<\\/section>$/, '').trim()
      stream.innerHTML = block
    })()`)
    await c.sleep(400)
  })

  // ── 02 对话流全景（fixture 1.1-trace-full） ─────────────────────────
  await rec('02-conversation-flow-full', '对话流全景：turn 容器 + reasoning 折叠展开 + tool 行 + turn footer', async () => {
    await seedFresh(c)
    await playFixture(c, '1.1-trace-full.json')
    await c.sleep(1200)
    // Expand any reasoning-block details on the last turn so both folded and
    // expanded states show in the same frame.
    await c.evjs(`(function(){
      const rs = document.querySelectorAll('details.reasoning-block, details.reasoning')
      if (rs.length > 0) rs[rs.length - 1].open = true
      // scroll to bottom so turn footer/glyph is visible
      const s = document.getElementById('stream'); if (s) s.scrollTop = s.scrollHeight
    })()`)
    await c.sleep(500)
  })

  // ── 03 Reasoning 差异化（mock-reasoning-only + trace 折叠展开） ─────
  await rec('03-reasoning-differentiator', 'Reasoning 差异化：reasoning-only 折叠卡展开 + 行显 reasoning', async () => {
    await seedFresh(c)
    await c.sleep(200)
    await clickById(c, 'mock-reasoning-only')
    await c.sleep(1200)
    await c.evjs(`(function(){
      const rs = document.querySelectorAll('details.reasoning-block, details.reasoning')
      rs.forEach(d => d.open = true)
      const s = document.getElementById('stream'); if (s) s.scrollTop = 0
    })()`)
    await c.sleep(400)
  })

  // ── 04 Tracing 一级页 ────────────────────────────────────────────────
  await rec('04-tracing-page-eight-column', 'Tracing 一级页：八列表格，3-5 条会话', async () => {
    // Pre-seed multiple sessions with different fixtures so the tracing table has rows.
    for (const fx of ['sample-session.json', '1.1-trace-full.json', '2.1-turn-trajectory-mixed.json', '1.7-compact-three-events.json', '2.6-subagent-inline-trace.json']) {
      try { await seedFresh(c); await playFixture(c, fx); await c.sleep(500) } catch (_) {}
    }
    await switchTab(c, 'tracing')
    await c.sleep(1200)
  })

  // ── 05 三视图 Tree ───────────────────────────────────────────────────
  // Rework2 (2026-07-18): fixture playback drops trace-cards directly into
  // the stream (no turn-footer, no auto-drawer), so we manually mount the
  // tri-view via the __dshTraceTriView module against the trace card's
  // attached _rec step-record. That is the same code path the per-turn
  // drawer would trigger; we just wrap the card ourselves for the shot.
  const triSetup = async () => {
    await seedFresh(c)
    await playFixture(c, '1.1-trace-full.json')
    await c.sleep(1500)
    await switchTab(c, 'chat')
    await c.sleep(200)
    const mount = await c.evjs(`(function(){
      // Build session-scope records from the active session's cached events.
      const mod = window.__dshTraceTriView
      if (!mod) return { ok: false, err: 'no tri module' }
      const sid = (window.__dshChat && typeof window.__dshChat.getActiveSessionId === 'function')
        ? window.__dshChat.getActiveSessionId()
        : null
      let events = []
      if (window.__dshChat && typeof window.__dshChat.getEventsForActive === 'function') {
        events = window.__dshChat.getEventsForActive() || []
      }
      const records = mod.sessionTraceRecords(events)
      // For the tree tab we want a real trace card — the fixture playback
      // drops one or more <.trace-card> into the stream. Wrap the outer
      // section that holds all cards so the Tree view shows a rich walked
      // record, not the "per-turn" stub.
      const cards = document.querySelectorAll('.trace-card')
      // Stack every card into a synthetic parent so treeEl carries all steps.
      let treeEl = null
      if (cards.length) {
        const stack = document.createElement('div')
        stack.className = 'showcase-triview-tree-stack'
        for (const c of cards) stack.appendChild(c.cloneNode(true))
        treeEl = stack
      }
      const view = mod.buildTriView(document, {
        treeEl: treeEl,
        records: records && records.length ? records : (cards[0] && cards[0]._rec ? cards[0]._rec : []),
        scope: 'session',
        sessionId: sid,
        defaultView: 'tree',
        onSeqClick: () => {},
      })
      const wrap = document.createElement('div')
      wrap.className = 'showcase-triview-mount'
      wrap.style.padding = '16px 24px'
      wrap.appendChild(view)
      const stream = document.getElementById('stream')
      if (stream) {
        for (const child of Array.from(stream.children)) child.style.display = 'none'
        stream.appendChild(wrap)
      }
      // Dismiss any runtime warning banner that may have appeared during
      // fixture playback.
      const warn = document.querySelector('.runtime-warning, .warning-banner')
      if (warn) { warn.style.display = 'none' }
      const dismiss = document.querySelector('.runtime-warning button, .warning-banner button, [aria-label="dismiss"]')
      if (dismiss) dismiss.click()
      wrap.scrollIntoView({ block: 'start' })
      return { ok: true, via: 'session-scope', records: (records || []).length, cards: cards.length }
    })()`)
    console.log('  triSetup:', JSON.stringify(mount))
    await c.sleep(500)
  }
  await rec('05-triview-tree', '三视图 Tree：内联时间条 + model chip + token/duration pill', async () => {
    await triSetup()
    await c.evjs(`(function(){
      const chip = document.querySelector('.showcase-triview-mount .trace-tri-chip.chip-tree, .showcase-triview-mount .trace-tri-chip[data-view="tree"]')
      if (chip) chip.click()
    })()`)
    await c.sleep(500)
  })

  // ── 06 三视图 Timeline (Gantt) ───────────────────────────────────────
  await rec('06-triview-timeline', '三视图 Timeline (Gantt)', async () => {
    const present = await c.evjs(`(function(){ return !!document.querySelector('.showcase-triview-mount') })()`)
    if (!present) await triSetup()
    await c.evjs(`(function(){
      const chip = document.querySelector('.showcase-triview-mount .trace-tri-chip.chip-timeline, .showcase-triview-mount .trace-tri-chip[data-view="timeline"]')
      if (chip) chip.click()
    })()`)
    await c.sleep(500)
  })

  // ── 07 三视图 Graph ─────────────────────────────────────────────────
  await rec('07-triview-graph', '三视图 Graph：节点选中态', async () => {
    const present = await c.evjs(`(function(){ return !!document.querySelector('.showcase-triview-mount') })()`)
    if (!present) await triSetup()
    await c.evjs(`(function(){
      const chip = document.querySelector('.showcase-triview-mount .trace-tri-chip.chip-graph, .showcase-triview-mount .trace-tri-chip[data-view="graph"]')
      if (chip) chip.click()
    })()`)
    await c.sleep(500)
    await c.evjs(`(function(){
      const scope = document.querySelector('.showcase-triview-mount') || document
      const node = scope.querySelector('.trace-graph-node, [data-graph-node], .graph-node, circle[data-node], g[data-node]')
      if (node) {
        // SVG elements don't have HTMLElement.click(); dispatch a proper MouseEvent instead.
        const ev = new MouseEvent('click', { bubbles: true, cancelable: true, view: window })
        node.dispatchEvent(ev)
        node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
        // Add a visual selected marker in case the tri-view keys on this class.
        node.classList && node.classList.add('selected')
      }
    })()`)
    await c.sleep(300)
  })

  // ── 08 Detail pane (四段 + Fields 递归树 ≥3 层) ────────────────────
  await rec('08-detail-pane-fields-tree', 'Detail pane：四区段 + Fields 递归树 ≥3 层展开', async () => {
    const present = await c.evjs(`(function(){ return !!document.querySelector('.showcase-triview-mount') })()`)
    if (!present) await triSetup()
    await c.evjs(`(function(){
      const chip = document.querySelector('.showcase-triview-mount .trace-tri-chip.chip-tree, .showcase-triview-mount .trace-tri-chip[data-view="tree"]')
      if (chip) chip.click()
    })()`)
    await c.sleep(400)
    await c.evjs(`(function(){
      const scope = document.querySelector('.showcase-triview-mount') || document
      // Find a leaf whose click will populate the detail pane.
      const rows = scope.querySelectorAll('.trace-event-row, .trace-tree-row, [data-step-row]')
      let hit = null
      for (const r of rows) {
        const txt = (r.textContent || '').toLowerCase()
        if (/tool|result|fields|read|write/.test(txt)) hit = r
      }
      if (!hit && rows.length) hit = rows[Math.min(2, rows.length - 1)]
      if (hit) hit.click()
      setTimeout(() => {
        const detailsAll = document.querySelectorAll('.trace-detail-pane details')
        detailsAll.forEach(d => d.open = true)
      }, 200)
    })()`)
    await c.sleep(900)
  })

  // ── 09 Error tab (5 tab 红 banner) ──────────────────────────────────
  await rec('09-error-tab-banner', 'Error tab：5 tab 红 banner 态', async () => {
    // Remove any tri-view mount from the previous sequence and un-hide
    // the stream's original children.
    await c.evjs(`(function(){
      const mount = document.querySelector('.showcase-triview-mount')
      if (mount && mount.parentNode) mount.parentNode.removeChild(mount)
      const stream = document.getElementById('stream')
      if (stream) for (const child of Array.from(stream.children)) child.style.display = ''
      const o = document.querySelector('.devtools-full-trace-overlay')
      if (o && o.parentNode) o.parentNode.removeChild(o)
    })()`)
    await c.sleep(150)
    await seedFresh(c)
    await playFixture(c, 'trace-parity-error-tool-result.json')
    await c.sleep(1000)
    await switchTab(c, 'chat')
    await c.sleep(200)
    await c.evjs(`(async () => {
      const drawers = document.querySelectorAll('details.turn-trace-drawer')
      if (drawers.length > 0) {
        const d = drawers[drawers.length - 1]
        d.open = true
        d.scrollIntoView({ block: 'center' })
      }
      await new Promise(r => setTimeout(r, 500))
      const scope = document.querySelector('details.turn-trace-drawer[open]') || document
      // Click into an error row
      const rows = scope.querySelectorAll('.trace-event-row, .trace-tree-row')
      for (const r of rows) {
        if (/error|fail|reject/i.test(r.textContent || '')) { r.click(); break }
      }
      await new Promise(r => setTimeout(r, 300))
      // Click Error tab explicitly if present
      const errBtn = document.querySelector('.trace-detail-tab.is-error, .trace-detail-tab[data-tab="error"]')
      if (errBtn) errBtn.click()
    })()`)
    await c.sleep(600)
  })

  // ── 10 Reasoning tab (5th tab 展开 982 tok) ─────────────────────────
  await rec('10-reasoning-tab', 'Reasoning tab：5th tab 展开 (differentiator)', async () => {
    await seedFresh(c)
    await clickById(c, 'mock-reasoning-only')
    await c.sleep(1200)
    await c.evjs(`(async () => {
      const drawers = document.querySelectorAll('details.turn-trace-drawer')
      if (drawers.length > 0) {
        const d = drawers[drawers.length - 1]
        d.open = true
        d.scrollIntoView({ block: 'center' })
      }
      await new Promise(r => setTimeout(r, 500))
      const scope = document.querySelector('details.turn-trace-drawer[open]') || document
      // Find a row that had reasoning tokens
      const rows = scope.querySelectorAll('.trace-event-row, .trace-tree-row')
      let hit = null
      for (const r of rows) {
        const txt = (r.textContent || '').toLowerCase()
        if (/reason|reasoning|assistant|llm/.test(txt)) hit = r
      }
      if (!hit && rows.length) hit = rows[rows.length - 1]
      if (hit) hit.click()
      await new Promise(r => setTimeout(r, 300))
      const rBtn = document.querySelector('.trace-detail-tab[data-tab="reasoning"]')
      if (rBtn) rBtn.click()
    })()`)
    await c.sleep(500)
  })

  // ── 11 Edit & re-run header ─────────────────────────────────────────
  await rec('11-edit-rerun-header', 'Edit & re-run：header 改参面板展开', async () => {
    await seedFresh(c)
    await loadSample(c)
    await c.sleep(1000)
    await switchTab(c, 'chat')
    await c.sleep(300)
    await c.evjs(`(function(){
      // Open all edit-rerun-header details in the stream.
      const hs = document.querySelectorAll('details.edit-rerun-header')
      if (hs.length > 0) {
        const target = hs[hs.length - 1]
        target.open = true
        target.scrollIntoView({ block: 'center' })
      }
    })()`)
    await c.sleep(500)
  })

  // ── 12 Fork compare drawer ──────────────────────────────────────────
  await rec('12-fork-compare-drawer', 'Fork compare：父子并排抽屉', async () => {
    await seedFresh(c)
    await clickById(c, 'mock-fork-compare')
    await c.sleep(1000)
    await c.evjs(`(function(){
      const drawer = document.querySelector('.fork-compare-drawer, .compare-drawer, [data-fork-compare]')
      if (drawer) drawer.scrollIntoView({ block: 'center' })
    })()`)
    await c.sleep(400)
  })

  // ── 13 Compact 卡 三 tab Diff 态 ────────────────────────────────────
  await rec('13-compact-card-diff-tab', 'Compact 卡：三 tab Diff 态', async () => {
    await seedFresh(c)
    await playFixture(c, '1.7-compact-three-events.json')
    await c.sleep(1000)
    await c.evjs(`(function(){
      // Click the diff tab on the compact card.
      const cards = document.querySelectorAll('.compact-card, .compact-badge, [data-compact-card]')
      let hit = null
      for (const c2 of cards) {
        const btn = c2.querySelector('button[data-tab="diff"], .compact-tab-diff, .compact-tabs .diff')
        if (btn) { btn.click(); hit = c2; break }
      }
      if (!hit) {
        // Fallback: find any tab labeled "Diff" inside a compact-* container
        const allBtns = document.querySelectorAll('.compact-card button, .compact-badge button')
        for (const b of allBtns) if (/diff/i.test(b.textContent || '')) { b.click(); break }
      }
      const first = document.querySelector('.compact-card, .compact-badge')
      if (first) first.scrollIntoView({ block: 'center' })
    })()`)
    await c.sleep(500)
  })

  // ── 14 Subagent 实时子轨迹 ──────────────────────────────────────────
  await rec('14-subagent-inline-trace', 'Subagent 实时子轨迹：DONE/RUNNING 卡', async () => {
    await seedFresh(c)
    await playFixture(c, '2.6-subagent-inline-trace.json')
    await c.sleep(1000)
    await c.evjs(`(function(){
      const s = document.getElementById('stream'); if (s) s.scrollTop = s.scrollHeight
      // Ensure any subagent trace details are open
      const details = document.querySelectorAll('details.subagent-inline, details[data-subagent], .subagent-card details')
      details.forEach(d => d.open = true)
    })()`)
    await c.sleep(500)
  })

  // ── 15 标注面板：三类型 rubric 打分态 ───────────────────────────────
  await rec('15-annotation-panel-typed', '标注面板：Continuous 按钮排 + Categorical 枚举', async () => {
    await seedFresh(c)
    await loadSample(c)
    await c.sleep(600)
    await switchTab(c, 'chat')
    await c.sleep(200)
    await c.evjs(`(async () => {
      if (window.__dshAnnotation && typeof window.__dshAnnotation.open === 'function') {
        const sid = (window.__dshAnnotationSamples && window.__dshAnnotationSamples.sessions && window.__dshAnnotationSamples.sessions[0] && window.__dshAnnotationSamples.sessions[0].sessionId) || 'demo-session'
        window.__dshAnnotation.open(sid)
      }
    })()`)
    await c.sleep(800)
  })

  // ── 16 Rubrics 页 + Create-from-scratch 表单 ────────────────────────
  await rec('16-rubrics-page-create', 'Rubrics 页：28 类目录 + Create-from-scratch 表单', async () => {
    await switchTab(c, 'rubrics')
    await c.sleep(700)
    await c.evjs(`(function(){
      // Click a "Create from scratch" / "new rubric" button if present.
      const btns = document.querySelectorAll('button')
      for (const b of btns) {
        const t = (b.textContent || '').toLowerCase()
        if (/create.*scratch|new rubric|from scratch/.test(t)) { b.click(); return { ok: true } }
      }
      // Also try id-based hooks.
      const bId = document.getElementById('rubrics-create-from-scratch') || document.getElementById('rubric-new')
      if (bId) { bId.click(); return { ok: 'id' } }
      return { ok: false }
    })()`)
    await c.sleep(700)
  })

  // ── 17 Bench 页 (4 实验八列表) ───────────────────────────────────────
  await rec('17-bench-page', 'Bench 页：4 实验八列表 + 详情', async () => {
    await switchTab(c, 'bench')
    await c.sleep(900)
  })

  // ── 18 Hub 页 (七类资产目录) ────────────────────────────────────────
  await rec('18-hub-page', 'Hub 页：七类资产目录', async () => {
    await switchTab(c, 'hub')
    await c.sleep(900)
  })

  // ── 19 Context 页 (turn 行 + SDK legend) ────────────────────────────
  await rec('19-context-page', 'Context 页：加载 sample 后的 turn 行 + SDK legend', async () => {
    // Seed sample so context ledger is populated.
    await seedFresh(c)
    await loadSample(c)
    await c.sleep(600)
    await switchTab(c, 'context')
    await c.sleep(900)
  })

  // ── 20 Session Tree (fork 实线/subagent 虚线) ───────────────────────
  await rec('20-session-tree', 'Session Tree：demo forest — fork 实线/subagent 虚线', async () => {
    await switchTab(c, 'tree')
    await c.sleep(1000)
  })

  // ── 21 (bonus) turn/end error 完整行 ────────────────────────────────
  await rec('21-turn-end-error-row', 'turn/end · error 完整行 (红字全因)', async () => {
    await seedFresh(c)
    await clickById(c, 'mock-turn-end-error')
    await c.sleep(900)
    await c.evjs(`(function(){
      const s = document.getElementById('stream'); if (s) s.scrollTop = s.scrollHeight
    })()`)
    await c.sleep(400)
  })

  // Console-probe assertion
  const syntaxHits = c.consoleEntries.filter(e => /SyntaxError/i.test(e.text))
  const jsonPath = resolve(outdir, 'console-report.json')
  writeFileSync(jsonPath, JSON.stringify({
    port,
    outdir,
    totalConsoleEntries: c.consoleEntries.length,
    syntaxErrors: syntaxHits,
    exceptions: c.consoleEntries.filter(e => e.level === 'exception').slice(0, 20),
  }, null, 2))
  console.log('console report:', jsonPath, 'syntaxErrors=' + syntaxHits.length)

  // Write per-shot notes summary
  writeFileSync(resolve(outdir, 'shots-manifest.json'), JSON.stringify(notes, null, 2))

  c.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
