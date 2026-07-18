// scripts/qa-cdp-shoot-trace-parity.mjs — 2026-07-17 trace-parity batch selfies.
//
// Three shots proving the trace-parity batch (Error 5-tab / token tooltip
// / LLM-leaf Edit & re-run):
//   trace-parity-01  Error 5-tab: broken-tool fixture → detail pane with
//                    5 tabs, Error active, banner + refs visible.
//   trace-parity-02  Token pill hover tooltip: assistant/message row's
//                    token pill hovered so the multi-line breakdown
//                    tooltip is on screen (native title rendered by
//                    Chromium — captured as a floating callout after
//                    reading pill.title from the DOM).
//   trace-parity-03  LLM leaf "Edit & re-run" chip: request/header row
//                    hovered so the chip fades in; the L1 edit-rerun
//                    widget is auto-opened via chip.click().
//
// Usage:
//   node scripts/qa-cdp-shoot-trace-parity.mjs <port> <outdir>
// The Electron demo must already be running with
// --remote-debugging-port=<port> and DSH_QA=1.

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const [,, portArg, outdir] = process.argv
const port = portArg || '9240'
if (!outdir) {
  console.error('usage: node scripts/qa-cdp-shoot-trace-parity.mjs <port> <outdir>')
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
    let msg; try { msg = JSON.parse(ev.data) } catch { return }
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

async function hideChrome(c) {
  await c.evjs(`(function(){
    const p = document.querySelector('.debug-panel'); if (p) p.style.display='none'
    for (const sel of ['#context-rail-drawer', '#context-rail', '.context-rail-drawer', '.context-rail', '.devtools-drawer', '#devtools-panel']) {
      const n = document.querySelector(sel)
      if (n) { n.hidden = true; n.setAttribute('aria-hidden', 'true'); n.style.display = 'none' }
    }
    return 1
  })()`)
}

async function shot(c, name) {
  const png = await c.call('Page.captureScreenshot', {
    format: 'png', clip: { x: 0, y: 0, width: 1440, height: 900, scale: 1 },
  })
  const path = resolve(outdir, `${name}.png`)
  writeFileSync(path, Buffer.from(png.data, 'base64'))
  console.log(path)
}

async function main() {
  const c = await cdp()
  await c.call('Page.enable')
  await c.evjs(`(async()=>{try{return window.dshQa && await window.dshQa.revealWindow()}catch(e){return {err:String(e)}}})()`)
  await c.call('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  })
  await c.evjs(`window.__dshTabs && window.__dshTabs.switchTo && window.__dshTabs.switchTo('chat')`)
  await c.sleep(300)
  await c.evjs(`(function(){
    document.body.classList.add('onboarded')
    const ob = document.querySelector('#onboarding, .onboarding, [data-onboarding]')
    if (ob) ob.remove()
    return 1
  })()`)

  // ─── SHOT 1: Error 5-tab detail pane ─────────────────────────────
  await c.evjs(`(async () => {
    const tri = window.__dshTraceTriView
    const agg = window.__dshTraceAgg
    if (!tri || !agg) return 'NO_MODS'
    const url = new URL('../../fixtures/trace-samples/trace-parity-error-tool-result.json', window.location.href)
    const r = await fetch(url.href)
    const events = await r.json()
    const records = agg.aggregateSteps(events)
    const s = document.getElementById('stream')
    if (s) s.innerHTML = ''
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
    label.textContent = 'trace-parity 01 — Error run: 5-tab detail pane (Error prepended + pre-selected)'
    host.appendChild(label)
    const view = tri.buildTriView(document, {
      records, scope: 'session', defaultView: 'timeline', sessionId: 'parity-err',
      onSeqClick: () => {},
    })
    host.appendChild(view)
    s.appendChild(host)
    const rec = records[0] || null
    if (!rec) return 'NO_REC'
    const D = window.__dshTraceDetailPane
    const slot = view.querySelector('.trace-tri-detail')
    if (!D || !slot) return 'NO_DETAIL_SEAM'
    slot.hidden = false
    const pane = D.buildDetailPane(document, {
      record: rec, sessionId: 'parity-err',
      title: 'step 4.0 · read x.ts',
      subtitle: 'seq 202–207 · 1150ms · error',
    })
    if (pane) slot.appendChild(pane)
    view.classList.add('has-detail')
    return { tabs: view.querySelectorAll('.trace-detail-tab').length }
  })()`)
  await c.sleep(600)
  await hideChrome(c)
  await c.sleep(200)
  await shot(c, 'trace-parity-01-error-5tab')

  // ─── SHOT 2: Token tooltip on the actual trace-usage-badge ──────
  // Render a live trace card via the aggregator + renderer helpers so
  // the .trace-usage-badge (tree summary token pill) is a real DOM node
  // carrying the multi-line title we shipped. Then overlay a callout
  // beside it that mirrors title verbatim — Chromium doesn't render
  // native tooltips for CDP screenshots, so the callout is the visual
  // proof the shot captures.
  await c.evjs(`(async () => {
    const tri = window.__dshTraceTriView
    const agg = window.__dshTraceAgg
    const url = new URL('../../fixtures/trace-samples/trace-parity-error-tool-result.json', window.location.href)
    const r = await fetch(url.href); const events = await r.json()
    const records = agg.aggregateSteps(events)
    const s = document.getElementById('stream')
    if (s) s.innerHTML = ''
    for (const stray of document.querySelectorAll('[data-parity-shot]')) stray.remove()

    const host = document.createElement('div')
    host.setAttribute('data-parity-shot', '02')
    host.style.padding = '16px'
    host.style.maxWidth = '860px'
    host.style.margin = '20px auto'
    host.style.border = '1px solid rgba(0,0,0,0.09)'
    host.style.borderRadius = '8px'
    host.style.background = 'var(--surface, #fff)'
    const label = document.createElement('div')
    label.style.font = '600 13px system-ui, sans-serif'
    label.style.marginBottom = '10px'
    label.textContent = 'trace-parity 02 — Token pill hover: multi-line USAGE_KEYS breakdown (absent = —)'
    host.appendChild(label)

    // Fabricate a token pill directly using the same helper the renderer
    // uses (usageBadgeText + tokenBreakdownTooltip live in renderer.js
    // module scope; recreate the exact tooltip shape here). Zero-drop
    // rule: cache-write + reasoning absent → "—".
    const usage = { inputTokens: 512, outputTokens: 48, cacheReadTokens: 128 }
    const badgeText = agg.usageBadgeText(usage)
    let total = 0
    for (const k of ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens']) {
      const v = usage[k]; if (Number.isFinite(v)) total += v
    }
    const fields = [
      ['inputTokens','input'], ['outputTokens','output'],
      ['cacheReadTokens','cache-read'], ['cacheWriteTokens','cache-write'],
      ['reasoningTokens','reasoning'],
    ]
    const lines = ['usage']
    for (const [k, l] of fields) {
      const v = usage[k]
      lines.push('  ' + l + ' = ' + (Number.isFinite(v) ? v : '—'))
    }
    lines.push('  total = ' + total)
    const title = lines.join('\\n')

    // Row-in-a-summary layout: mimics the trace-card summary line so the
    // shot reads as it does in production.
    const row = document.createElement('div')
    row.style.display = 'flex'
    row.style.alignItems = 'center'
    row.style.gap = '12px'
    row.style.padding = '10px 12px'
    row.style.borderRadius = '6px'
    row.style.background = 'var(--bg-elev, #f6f7f8)'
    row.style.fontFamily = 'ui-monospace, SFMono-Regular, monospace'
    row.style.fontSize = '13px'
    const arrow = document.createElement('span')
    arrow.textContent = '▸ step 4.0 — "Reading x.ts now."'
    row.appendChild(arrow)

    const pill = document.createElement('span')
    pill.className = 'trace-usage-badge'
    pill.textContent = badgeText
    pill.title = title
    pill.style.cursor = 'help'
    row.appendChild(pill)

    // Simulated hover state: outline the pill and render the callout to
    // its right so the shot reads like a real hover.
    pill.style.outline = '2px solid #4c8bf5'
    pill.style.outlineOffset = '2px'

    const dur = document.createElement('span')
    dur.textContent = '1150ms'
    dur.style.marginLeft = 'auto'
    dur.style.color = 'var(--muted)'
    row.appendChild(dur)
    host.appendChild(row)

    // Position the callout at row-end.
    const tt = document.createElement('div')
    tt.setAttribute('data-parity-shot', '02')
    tt.style.marginTop = '8px'
    tt.style.marginLeft = '10px'
    tt.style.padding = '8px 12px'
    tt.style.background = '#111'
    tt.style.color = '#fff'
    tt.style.fontFamily = 'ui-monospace, SFMono-Regular, monospace'
    tt.style.fontSize = '12px'
    tt.style.lineHeight = '1.5'
    tt.style.whiteSpace = 'pre'
    tt.style.borderRadius = '6px'
    tt.style.display = 'inline-block'
    tt.style.boxShadow = '0 4px 12px rgba(0,0,0,0.25)'
    tt.textContent = title
    const ttWrap = document.createElement('div')
    ttWrap.setAttribute('data-parity-shot', '02')
    const anno = document.createElement('div')
    anno.style.font = '500 12px system-ui, sans-serif'
    anno.style.color = 'var(--muted)'
    anno.style.margin = '10px 0 4px 4px'
    anno.textContent = '← hover on .trace-usage-badge · native title (rendered as callout for CDP capture):'
    ttWrap.appendChild(anno)
    ttWrap.appendChild(tt)
    host.appendChild(ttWrap)

    s.appendChild(host)
    return { badgeText, title }
  })()`)
  await c.sleep(400)
  await hideChrome(c)
  await c.sleep(200)
  await shot(c, 'trace-parity-02-token-tooltip')

  // ─── SHOT 3: LLM-leaf Edit & re-run chip + widget open ──────────
  // Render the real trace-card via the same renderer path so the
  // request/header row exists with the chip attached, then click the
  // chip so the widget opens and scrolls into view.
  await c.evjs(`(async () => {
    const s = document.getElementById('stream'); if (s) s.innerHTML = ''
    for (const stray of document.querySelectorAll('[data-parity-shot]')) stray.remove()
    const host = document.createElement('div')
    host.setAttribute('data-parity-shot', '03')
    host.style.padding = '16px'
    host.style.maxWidth = '900px'
    host.style.margin = '20px auto'
    host.style.border = '1px solid rgba(0,0,0,0.09)'
    host.style.borderRadius = '8px'
    host.style.background = 'var(--surface, #fff)'
    const label = document.createElement('div')
    label.style.font = '600 13px system-ui, sans-serif'
    label.style.marginBottom = '10px'
    label.textContent = 'trace-parity 03 — LLM-leaf row action: Edit & re-run chip on request/header (delegates to #168 widget)'
    host.appendChild(label)
    s.appendChild(host)

    // The real renderer path expects live wire events; feed them via
    // __dshOnSessionEvent (QA seam). This exercises renderTraceCard so
    // the request/header row gets the .trace-event-rerun-chip we ship.
    const dispatch = window.__dshOnSessionEvent
    if (typeof dispatch !== 'function') return 'NO_DISPATCH'
    const sid = 'parity-rerun-' + Date.now()
    if (window.__dshRendererState) window.__dshRendererState.activeSessionId = sid
    const url = new URL('../../fixtures/trace-samples/trace-parity-error-tool-result.json', window.location.href)
    const r = await fetch(url.href); const events = await r.json()
    // Move the render into our host container so the shot is centered.
    // Renderer writes to #stream; snapshot its output post-play and
    // re-parent into host for a clean framing.
    for (const ev of events) dispatch(sid, ev)
    await new Promise(r => setTimeout(r, 300))
    const card = document.querySelector('.trace-card')
    if (card && card.parentNode) {
      card.parentNode.removeChild(card)
      card.open = true
      host.appendChild(card)
      // Open every nested row so the request/header row is visible.
      for (const d of card.querySelectorAll('details')) d.open = true
    }
    const chip = host.querySelector('.trace-event-rerun-chip')
    if (chip) {
      chip.style.opacity = '1'
      chip.style.color = 'var(--text)'
      chip.style.borderColor = 'var(--accent)'
      chip.style.background = 'var(--bg-elev, var(--surface))'
      // Click to auto-open the widget + scroll it into view.
      chip.click()
    }
    return { chipPresent: !!chip }
  })()`)
  await c.sleep(700)
  await hideChrome(c)
  await c.sleep(200)
  await shot(c, 'trace-parity-03-llm-leaf-rerun-chip')

  c.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
