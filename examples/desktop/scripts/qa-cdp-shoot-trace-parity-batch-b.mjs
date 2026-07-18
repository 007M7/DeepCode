// scripts/qa-cdp-shoot-trace-parity-batch-b.mjs — 2026-07-17 batch B selfies.
//
// Two shots proving the HUMAN-card convergence + recursive JSON tree:
//   batch-b-04  role convergence: user + assistant + tool bubbles rendered
//               with inline dot + Titlecase word ("User" / "Assistant" /
//               "Tool"), no uppercase HUMAN/USER hero heading.
//   batch-b-05  recursive JSON tree: an assistant tool_call arguments
//               block with a deep nested object rendered as a
//               `<details>`-based collapsible tree (every level has an
//               arrow, scalars carry a `·` dot).
//
// Usage:
//   node scripts/qa-cdp-shoot-trace-parity-batch-b.mjs <port> <outdir>
// The Electron demo must be running with --remote-debugging-port=<port>
// and DSH_QA=1.

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const [,, portArg, outdir] = process.argv
const port = portArg || '9240'
if (!outdir) {
  console.error('usage: node scripts/qa-cdp-shoot-trace-parity-batch-b.mjs <port> <outdir>')
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
  await c.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await c.evjs(`window.__dshTabs && window.__dshTabs.switchTo && window.__dshTabs.switchTo('chat')`)
  await c.sleep(300)
  await c.evjs(`(function(){
    document.body.classList.add('onboarded')
    const ob = document.querySelector('#onboarding, .onboarding, [data-onboarding]')
    if (ob) ob.remove()
    return 1
  })()`)

  // ─── SHOT 4: role convergence — inline titlecase, no HUMAN caps card ─
  await c.evjs(`(async () => {
    const s = document.getElementById('stream')
    if (!s) return 'NO_STREAM'
    s.innerHTML = ''
    for (const stray of document.querySelectorAll('[data-parity-shot]')) stray.remove()
    const host = document.createElement('div')
    host.setAttribute('data-parity-shot', 'b04')
    host.style.padding = '20px 24px'
    host.style.maxWidth = '900px'
    host.style.margin = '20px auto'
    host.style.border = '1px solid rgba(0,0,0,0.09)'
    host.style.borderRadius = '8px'
    host.style.background = 'var(--surface, #fff)'
    const label = document.createElement('div')
    label.style.font = '600 13px system-ui, sans-serif'
    label.style.marginBottom = '10px'
    label.textContent = 'batch-b 04 — Role convergence: inline · + Titlecase (never HUMAN/USER caps hero)'
    host.appendChild(label)
    // Fake three msg bubbles matching real appendMessage output shape
    // (role-glyph + role-label spans, .role container).
    for (const [role, text] of [
      ['user', 'What Cognitive-behavioral therapy is?'],
      ['assistant', 'CBT is a talk-therapy approach that identifies and reshapes unhelpful thought patterns.'],
      ['tool', 'read({"path": "notes.txt"}) → 1024 bytes'],
    ]) {
      const b = document.createElement('div')
      b.className = 'msg ' + role
      const r = document.createElement('div')
      r.className = 'role'
      r.dataset.role = role
      const g = document.createElement('span'); g.className = 'role-glyph'; g.textContent = '·'
      const l = document.createElement('span'); l.className = 'role-label'
      l.textContent = role.charAt(0).toUpperCase() + role.slice(1)
      r.appendChild(g); r.appendChild(l)
      const body = document.createElement('div')
      body.textContent = text
      b.appendChild(r); b.appendChild(body)
      host.appendChild(b)
    }
    // Callout naming the old shape being retired.
    const callout = document.createElement('div')
    callout.style.marginTop = '20px'
    callout.style.padding = '12px 14px'
    callout.style.background = 'rgba(220,53,69,0.06)'
    callout.style.border = '1px dashed rgba(220,53,69,0.3)'
    callout.style.borderRadius = '6px'
    callout.style.font = '12px system-ui, sans-serif'
    callout.style.color = '#8b1e2c'
    callout.textContent = 'Retired: block-level "HUMAN"/"USER" uppercase caps card (无信息增量) — role now inline dot + Titlecase word.'
    host.appendChild(callout)
    s.appendChild(host)
    return 1
  })()`)
  await c.sleep(600)
  await c.evjs(`(function(){
    for (const sel of ['#context-rail-drawer', '#context-rail', '.context-rail-drawer', '.context-rail', '.devtools-drawer', '#devtools-panel', '.debug-panel']) {
      const n = document.querySelector(sel)
      if (n) { n.hidden = true; n.style.display = 'none' }
    }
    return 1
  })()`)
  await c.sleep(200)
  await shot(c, 'trace-parity-04-role-titlecase')

  // ─── SHOT 5: Recursive JSON tree — deep nested tool_call arguments ─
  await c.evjs(`(async () => {
    const s = document.getElementById('stream')
    if (!s) return 'NO_STREAM'
    s.innerHTML = ''
    for (const stray of document.querySelectorAll('[data-parity-shot]')) stray.remove()
    const D = window.__dshTraceDetailPane
    if (!D || typeof D.buildJsonTree !== 'function') return 'NO_TREE_MOD'
    const host = document.createElement('div')
    host.setAttribute('data-parity-shot', 'b05')
    host.style.padding = '20px 24px'
    host.style.maxWidth = '860px'
    host.style.margin = '20px auto'
    host.style.border = '1px solid rgba(0,0,0,0.09)'
    host.style.borderRadius = '8px'
    host.style.background = 'var(--surface, #fff)'
    const label = document.createElement('div')
    label.style.font = '600 13px system-ui, sans-serif'
    label.style.marginBottom = '10px'
    label.textContent = 'batch-b 05 — Recursive JSON tree: tool_call arguments fold at every depth (density = folding, not dropping)'
    host.appendChild(label)
    // Card mimicking the LangSmith fields-card wrapper.
    const card = document.createElement('div')
    card.style.border = '1px solid rgba(0,0,0,0.09)'
    card.style.borderRadius = '6px'
    card.style.padding = '12px 14px'
    card.style.background = 'var(--bg-elev, #fafafa)'
    const head = document.createElement('div')
    head.style.display = 'flex'; head.style.alignItems = 'baseline'; head.style.gap = '8px'
    head.style.marginBottom = '10px'
    head.style.font = '600 12px system-ui, sans-serif'
    const glyph = document.createElement('span')
    glyph.textContent = '{ }'; glyph.style.fontFamily = 'var(--mono, monospace)'
    glyph.style.color = 'rgba(0,0,0,0.4)'
    const title = document.createElement('span'); title.textContent = 'arguments'
    head.appendChild(glyph); head.appendChild(title)
    card.appendChild(head)
    // A deep fixture mirroring a realistic OpenAI-style tool_call JSON.
    const fixture = {
      choices: [
        {
          finish_reason: 'stop',
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'tool_call_1',
                type: 'function',
                function: {
                  name: 'search_web',
                  arguments: { query: 'CBT therapy overview', top_k: 5, include_snippets: true },
                },
              },
            ],
          },
          logprobs: null,
        },
      ],
      id: 'chatcmpl-abc123',
      model: 'deepseek-v4',
      object: 'chat.completion',
      system_fingerprint: 'fp_9a71',
      usage: { prompt_tokens: 128, completion_tokens: 42, total_tokens: 170 },
    }
    const tree = D.buildJsonTree(document, fixture, { openDepth: 2 })
    card.appendChild(tree)
    host.appendChild(card)
    s.appendChild(host)
    return 1
  })()`)
  await c.sleep(600)
  await c.evjs(`(function(){
    for (const sel of ['#context-rail-drawer', '#context-rail', '.context-rail-drawer', '.context-rail', '.devtools-drawer', '#devtools-panel', '.debug-panel']) {
      const n = document.querySelector(sel)
      if (n) { n.hidden = true; n.style.display = 'none' }
    }
    return 1
  })()`)
  await c.sleep(200)
  await shot(c, 'trace-parity-05-fields-tree')

  // ─── SHOT 6: ≥3-level nested Fields subtree — Output-row raw payload ─
  //
  // task #39: the row-level Fields subtree (buildRawFieldsSubtree, wired
  // into every trace Output row) exposes the full assistant/message wire
  // payload; the shot must show at least 3 levels of nested objects
  // visibly expanded so the reader sees "each nested level has its own
  // ∨/▸ arrow" (density-layering-spec §7 positive-reference lock).
  //
  // Fixture: a Claude-style assistant/message with tool_use content
  // blocks + usage — the recursion reaches depth 4 (data → content →
  // [0] → input → {key/value}).  buildRawFieldsSubtree opens the top,
  // openDepth=2; we then programmatically flip deeper branches so the
  // shot captures a fully-unfolded state.
  await c.evjs(`(async () => {
    const s = document.getElementById('stream')
    if (!s) return 'NO_STREAM'
    s.innerHTML = ''
    for (const stray of document.querySelectorAll('[data-parity-shot]')) stray.remove()
    const D = window.__dshTraceDetailPane
    if (!D || typeof D.buildRawFieldsSubtree !== 'function') return 'NO_ROW_FIELDS_MOD'
    const host = document.createElement('div')
    host.setAttribute('data-parity-shot', 'b06')
    host.style.padding = '20px 24px'
    host.style.maxWidth = '900px'
    host.style.margin = '20px auto'
    host.style.border = '1px solid rgba(0,0,0,0.09)'
    host.style.borderRadius = '8px'
    host.style.background = 'var(--surface, #fff)'
    const label = document.createElement('div')
    label.style.font = '600 13px system-ui, sans-serif'
    label.style.marginBottom = '10px'
    label.textContent = 'batch-b 06 — Row-level Fields subtree, ≥3 depths visibly expanded (per-depth ∨/▸ arrows)'
    host.appendChild(label)
    // Simulate a real trace-detail Output row so the subtree renders in
    // its natural chrome (role + Fields + raw badge line).
    const row = document.createElement('div')
    row.className = 'trace-detail-output-row'
    row.style.padding = '8px 12px'
    row.style.border = '1px solid rgba(0,0,0,0.09)'
    row.style.borderRadius = '6px'
    row.style.background = 'var(--bg-elev, #fafafa)'
    row.style.display = 'flex'
    row.style.flexDirection = 'column'
    row.style.gap = '6px'
    const roleLine = document.createElement('div')
    roleLine.style.display = 'flex'
    roleLine.style.alignItems = 'baseline'
    roleLine.style.gap = '12px'
    const roleEl = document.createElement('span')
    roleEl.className = 'trace-detail-role'
    roleEl.dataset.role = 'assistant'
    const g = document.createElement('span'); g.className = 'trace-detail-role-glyph mono'; g.textContent = '·'
    const w = document.createElement('span'); w.className = 'trace-detail-role-label'; w.textContent = 'Assistant'
    roleEl.appendChild(g); roleEl.appendChild(w)
    const body = document.createElement('div')
    body.className = 'trace-detail-message-body'
    body.textContent = "I'll search the web for CBT therapy overviews and cite the top results."
    roleLine.appendChild(roleEl); roleLine.appendChild(body)
    row.appendChild(roleLine)
    // Deep raw event fixture — 5-level recursion once you enter tool_use.
    const rawEvent = {
      seq: 42,
      type: 'assistant/message',
      time: 1710000000000,
      data: {
        role: 'assistant',
        content: [
          { type: 'text', text: "I'll search the web for CBT therapy overviews and cite the top results." },
          {
            type: 'tool_use',
            id: 'toolu_01ABC123',
            name: 'search_web',
            input: {
              query: 'cognitive behavioral therapy overview',
              filters: { language: 'en', region: 'US', top_k: 5, include_snippets: true },
            },
          },
        ],
        finish_reason: 'tool_calls',
        stop_sequence: null,
        usage: {
          prompt_tokens: 342,
          completion_tokens: 78,
          total_tokens: 420,
          cache_read_input_tokens: 128,
          cache_creation_input_tokens: 0,
        },
        provider_diagnostics: {
          request_id: 'req_9f2a',
          upstream: { latency_ms: 812, tokens_per_second: 96.3 },
        },
      },
    }
    const subtree = D.buildRawFieldsSubtree(document, rawEvent)
    if (subtree) {
      subtree.open = true
      // Walk down + open every foldable branch so the ≥3-level state is
      // captured; without this the shot would only show the top level.
      const walk = subtree.querySelectorAll('.trace-detail-json-branch')
      walk.forEach((d) => { d.open = true })
      row.appendChild(subtree)
    }
    host.appendChild(row)
    s.appendChild(host)
    return 1
  })()`)
  await c.sleep(600)
  await c.evjs(`(function(){
    for (const sel of ['#context-rail-drawer', '#context-rail', '.context-rail-drawer', '.context-rail', '.devtools-drawer', '#devtools-panel', '.debug-panel']) {
      const n = document.querySelector(sel)
      if (n) { n.hidden = true; n.style.display = 'none' }
    }
    return 1
  })()`)
  await c.sleep(200)
  await shot(c, 'trace-parity-06-row-fields-deep')

  // ─── SHOT 7: trace-card right-side ∨ subtree-fold glyph (spec §7) ────
  //
  // task #38 selfie: the right-side ∨ glyph on trace-card summaries.
  // Shoot two side-by-side cards — one open, one closed — so the reader
  // sees the state transition + rotation cue.
  await c.evjs(`(async () => {
    const s = document.getElementById('stream')
    if (!s) return 'NO_STREAM'
    s.innerHTML = ''
    for (const stray of document.querySelectorAll('[data-parity-shot]')) stray.remove()
    const host = document.createElement('div')
    host.setAttribute('data-parity-shot', 'b07')
    host.style.padding = '20px 24px'
    host.style.maxWidth = '900px'
    host.style.margin = '20px auto'
    host.style.border = '1px solid rgba(0,0,0,0.09)'
    host.style.borderRadius = '8px'
    host.style.background = 'var(--surface, #fff)'
    const label = document.createElement('div')
    label.style.font = '600 13px system-ui, sans-serif'
    label.style.marginBottom = '10px'
    label.textContent = 'batch-b 07 — Trace-card right-side ∨ subtree-fold glyph (open / closed states)'
    host.appendChild(label)
    // Build two mock trace-cards matching the real renderTraceCard shape.
    function mockCard(open, stepPart, summaryText) {
      const el = document.createElement('details')
      el.className = 'trace-card'
      el.open = open
      const sum = document.createElement('summary')
      const l = document.createElement('span')
      l.className = 'trace-label'
      l.textContent = summaryText ? '▸ ' + stepPart + ' — "' + summaryText + '"' : '▸ ' + stepPart
      const badge = document.createElement('span')
      badge.className = 'trace-usage-badge'
      badge.textContent = '↑342 ↓78 ⚡128'
      const dur = document.createElement('span')
      dur.className = 'trace-duration'
      dur.textContent = '812ms'
      const foldGlyph = document.createElement('span')
      foldGlyph.className = 'trace-card-fold-glyph mono'
      foldGlyph.setAttribute('aria-hidden', 'true')
      foldGlyph.textContent = '∨'
      sum.appendChild(badge); sum.appendChild(l); sum.appendChild(dur); sum.appendChild(foldGlyph)
      el.appendChild(sum)
      const body = document.createElement('div')
      body.className = 'trace-body'
      body.textContent = '(step contents — inputs / outputs / events)'
      body.style.padding = '8px 10px'
      body.style.color = 'rgba(0,0,0,0.55)'
      body.style.fontFamily = 'var(--mono, monospace)'
      body.style.fontSize = '11px'
      el.appendChild(body)
      el.style.margin = '8px 0'
      return el
    }
    host.appendChild(mockCard(true, 'step 0.1', 'search_web(query="CBT therapy overview")'))
    host.appendChild(mockCard(false, 'step 0.2', 'assistant reply'))
    const callout = document.createElement('div')
    callout.style.marginTop = '14px'
    callout.style.padding = '10px 12px'
    callout.style.background = 'rgba(24,144,255,0.06)'
    callout.style.border = '1px dashed rgba(24,144,255,0.35)'
    callout.style.borderRadius = '6px'
    callout.style.font = '12px system-ui, sans-serif'
    callout.style.color = '#0e5aa7'
    callout.textContent = 'Right-side ∨ rotates on [open] (0deg open, -90deg closed) — density-layering-spec §7 lock.'
    host.appendChild(callout)
    s.appendChild(host)
    return 1
  })()`)
  await c.sleep(500)
  await c.evjs(`(function(){
    for (const sel of ['#context-rail-drawer', '#context-rail', '.context-rail-drawer', '.context-rail', '.devtools-drawer', '#devtools-panel', '.debug-panel']) {
      const n = document.querySelector(sel)
      if (n) { n.hidden = true; n.style.display = 'none' }
    }
    return 1
  })()`)
  await c.sleep(200)
  await shot(c, 'trace-parity-07-card-fold-glyph')

  c.close()
}

main().catch((e) => { console.error(e); process.exit(2) })
