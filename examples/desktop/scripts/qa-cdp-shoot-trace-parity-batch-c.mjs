// scripts/qa-cdp-shoot-trace-parity-batch-c.mjs — 2026-07-17 batch C selfies.
//
// Two shots proving the Batch C wire-up:
//   batch-c-08  Output panel Fields card drilling into a tool_result row +
//               an assistant/message row simultaneously. Recursive tree is
//               fully expanded to ≥3 nested levels so every wire field
//               (id/model/system_fingerprint/choices → message → tool_calls
//               → function.arguments → nested filter object) is reachable
//               through per-level ∨/▸ folds.
//   batch-c-09  Input panel message row exposing its own Fields subtree —
//               parity with Output rows so system prompts with
//               cache_control, multipart user content and per-role
//               metadata are recursively reachable from the Input side too.
//
// Usage:
//   node scripts/qa-cdp-shoot-trace-parity-batch-c.mjs <port> <outdir>
// The Electron demo must be running with --remote-debugging-port=<port>
// and DSH_QA=1.

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const [,, portArg, outdir] = process.argv
const port = portArg || '9242'
if (!outdir) {
  console.error('usage: node scripts/qa-cdp-shoot-trace-parity-batch-c.mjs <port> <outdir>')
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
    format: 'png', clip: { x: 0, y: 0, width: 1440, height: 1200, scale: 1 },
  })
  const path = resolve(outdir, `${name}.png`)
  writeFileSync(path, Buffer.from(png.data, 'base64'))
  console.log(path)
}

async function main() {
  const c = await cdp()
  await c.call('Page.enable')
  await c.evjs(`(async()=>{try{return window.dshQa && await window.dshQa.revealWindow()}catch(e){return {err:String(e)}}})()`)
  await c.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false })
  await c.evjs(`window.__dshTabs && window.__dshTabs.switchTo && window.__dshTabs.switchTo('chat')`)
  await c.sleep(300)
  await c.evjs(`(function(){
    document.body.classList.add('onboarded')
    const ob = document.querySelector('#onboarding, .onboarding, [data-onboarding]')
    if (ob) ob.remove()
    return 1
  })()`)

  // ─── SHOT 8: Output Fields drill — tool_result + assistant/message ─
  await c.evjs(`(async () => {
    const s = document.getElementById('stream')
    if (!s) return 'NO_STREAM'
    s.innerHTML = ''
    for (const stray of document.querySelectorAll('[data-parity-shot]')) stray.remove()
    const D = window.__dshTraceDetailPane
    if (!D || typeof D.buildOutputRow !== 'function') return 'NO_BUILD_OUTPUT_ROW'

    const host = document.createElement('div')
    host.setAttribute('data-parity-shot', 'c08')
    host.style.padding = '20px 24px'
    host.style.maxWidth = '1080px'
    host.style.margin = '20px auto'
    host.style.border = '1px solid rgba(0,0,0,0.09)'
    host.style.borderRadius = '8px'
    host.style.background = 'var(--surface, #fff)'

    const label = document.createElement('div')
    label.style.font = '600 13px system-ui, sans-serif'
    label.style.marginBottom = '4px'
    label.textContent = 'batch-c 08 — Output Fields card recursive drill: tool_result + raw assistant/message payload, ≥3 nested levels'
    host.appendChild(label)

    const sub = document.createElement('div')
    sub.style.font = '12px system-ui, sans-serif'
    sub.style.color = 'rgba(0,0,0,0.6)'
    sub.style.marginBottom = '14px'
    sub.textContent = 'Every wire field reachable via per-level ∨/▸ fold — id / model / system_fingerprint / choices → message → tool_calls → function.arguments → nested filters. Density = folding, never dropping.'
    host.appendChild(sub)

    // Wrap in a Fields card matching buildOutputPanel's shape.
    const card = document.createElement('div')
    card.className = 'trace-detail-fields-card'
    card.style.border = '1px solid rgba(0,0,0,0.09)'
    card.style.borderRadius = '6px'
    card.style.padding = '12px 14px'
    card.style.background = 'var(--bg-elev, #fafafa)'
    const head = document.createElement('div')
    head.className = 'trace-detail-fields-head'
    head.style.display = 'flex'; head.style.alignItems = 'baseline'; head.style.gap = '8px'
    head.style.marginBottom = '10px'
    head.style.font = '600 12px system-ui, sans-serif'
    const g = document.createElement('span')
    g.className = 'trace-detail-fields-glyph mono'
    g.textContent = '{ }'; g.style.fontFamily = 'var(--mono, monospace)'
    g.style.color = 'rgba(0,0,0,0.4)'
    const title = document.createElement('span')
    title.className = 'trace-detail-fields-title'
    title.textContent = 'Fields'
    const count = document.createElement('span')
    count.className = 'trace-detail-fields-count muted mono'
    count.textContent = '· 2'
    count.style.color = 'rgba(0,0,0,0.4)'
    count.style.fontFamily = 'var(--mono, monospace)'
    head.appendChild(g); head.appendChild(title); head.appendChild(count)
    card.appendChild(head)

    // Row 1: assistant/message with tool_use + raw response fields
    const asstEv = {
      seq: 42, time: 1721200000123, type: 'assistant/message',
      data: {
        id: 'chatcmpl-abc123',
        model: 'deepseek-v4-preview',
        object: 'chat.completion',
        system_fingerprint: 'fp_44709d6fcb',
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will search the web to answer that.' },
          { type: 'tool_use', id: 'toolu_01ABC123', name: 'search_web',
            input: { query: 'CBT therapy overview', filters: { language: 'en', region: 'US', top_k: 5, include_snippets: true } } },
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
          request_id: 'req_9f2c1e88',
          upstream: { latency_ms: 812, tokens_per_second: 96.3 },
        },
      },
    }
    const asstRow = D.buildOutputRow(document, {
      kind: 'message', role: 'assistant',
      text: 'I will search the web to answer that.',
      toolCalls: [{ id: 'toolu_01ABC123', name: 'search_web',
        args: { query: 'CBT therapy overview', filters: { language: 'en', region: 'US', top_k: 5, include_snippets: true } } }],
      raw: asstEv,
    }, 'markdown')

    // Wrap in field-block details like buildOutputPanel does.
    const b1 = document.createElement('details')
    b1.className = 'trace-detail-field-block'
    b1.open = true
    const s1 = document.createElement('summary')
    s1.className = 'trace-detail-field-block-head'
    const k1 = document.createElement('span'); k1.className = 'trace-detail-field-key mono'
    k1.textContent = 'output'; k1.style.fontFamily = 'var(--mono, monospace)'
    s1.appendChild(k1); b1.appendChild(s1); b1.appendChild(asstRow)
    card.appendChild(b1)

    // Row 2: tool_result
    const trEv = {
      seq: 43, time: 1721200000512, type: 'tool/result',
      data: {
        callId: 'toolu_01ABC123',
        content: [
          { type: 'text', text: 'Search returned 5 results about Cognitive Behavioral Therapy.' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png' } },
        ],
        isError: false,
        meta: { card: 'generic', tool: 'search_web', durationMs: 812,
          diagnostics: { hits: 5, backend: 'brave-search', request_id: 'req_search_zzz' } },
      },
    }
    const trRow = D.buildOutputRow(document, {
      kind: 'tool-result', role: 'tool',
      callId: 'toolu_01ABC123',
      content: trEv.data.content,
      isError: false,
      raw: trEv,
    }, 'markdown')
    const b2 = document.createElement('details')
    b2.className = 'trace-detail-field-block'
    b2.open = true
    const s2 = document.createElement('summary')
    s2.className = 'trace-detail-field-block-head'
    const k2 = document.createElement('span'); k2.className = 'trace-detail-field-key mono'
    k2.textContent = 'tool_result'; k2.style.fontFamily = 'var(--mono, monospace)'
    s2.appendChild(k2); b2.appendChild(s2); b2.appendChild(trRow)
    card.appendChild(b2)

    host.appendChild(card)
    s.appendChild(host)

    // Now walk every recursive-tree branch and open it so ≥3 depths are
    // simultaneously visible.
    for (const d of document.querySelectorAll('[data-parity-shot="c08"] .trace-detail-json-branch')) {
      d.open = true
    }
    // Also make sure the outer Fields subtree wrapper is open (Batch C: default true).
    for (const d of document.querySelectorAll('[data-parity-shot="c08"] .trace-detail-row-fields')) {
      d.open = true
    }
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
  await shot(c, 'trace-parity-08-output-fields-deep-drill')

  // ─── SHOT 9: Input panel message row Fields drill ─
  await c.evjs(`(async () => {
    const s = document.getElementById('stream')
    if (!s) return 'NO_STREAM'
    s.innerHTML = ''
    for (const stray of document.querySelectorAll('[data-parity-shot]')) stray.remove()
    const D = window.__dshTraceDetailPane
    if (!D || typeof D.buildMessageRow !== 'function') return 'NO_BUILD_MESSAGE_ROW'

    const host = document.createElement('div')
    host.setAttribute('data-parity-shot', 'c09')
    host.style.padding = '20px 24px'
    host.style.maxWidth = '1080px'
    host.style.margin = '20px auto'
    host.style.border = '1px solid rgba(0,0,0,0.09)'
    host.style.borderRadius = '8px'
    host.style.background = 'var(--surface, #fff)'

    const label = document.createElement('div')
    label.style.font = '600 13px system-ui, sans-serif'
    label.style.marginBottom = '4px'
    label.textContent = 'batch-c 09 — Input panel messages carry the same recursive Fields drill (system prompt cache_control, multipart content, metadata)'
    host.appendChild(label)

    const sub = document.createElement('div')
    sub.style.font = '12px system-ui, sans-serif'
    sub.style.color = 'rgba(0,0,0,0.6)'
    sub.style.marginBottom = '14px'
    sub.textContent = 'Input and Output present the same zero-drop reachability contract — every wire field reachable via fold, from either side.'
    host.appendChild(sub)

    const list = document.createElement('div')
    list.className = 'trace-detail-message-list'

    // Row A: system prompt with cache_control ephemeral
    const sysEv = {
      seq: 3, time: 1721200000000, type: 'context/message',
      data: {
        role: 'system',
        content: [
          { type: 'text', text: 'You are a careful research assistant. When you cite a source, prefer primary literature.',
            cache_control: { type: 'ephemeral', ttl: 300 } },
        ],
        metadata: { policy: 'research-mode', trace_id: 'trc_abc', origin: { plugin: 'system-prompt', turn: 0 } },
      },
    }
    // Row B: user turn with multipart content
    const userEv = {
      seq: 5, time: 1721200000100, type: 'user/message',
      data: {
        role: 'user',
        content: [
          { type: 'text', text: 'Summarise this screenshot and cite the referenced paper.' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', size: 48120 } },
        ],
        metadata: { userId: 'u-2601', clientVersion: '2026.7.17', sessionTags: ['research', 'multimodal'] },
      },
    }
    list.appendChild(D.buildMessageRow(document, sysEv, 'markdown'))
    list.appendChild(D.buildMessageRow(document, userEv, 'markdown'))
    host.appendChild(list)
    s.appendChild(host)

    // Force-open every recursive branch so ≥3 depths visible on capture.
    for (const d of document.querySelectorAll('[data-parity-shot="c09"] .trace-detail-json-branch')) {
      d.open = true
    }
    for (const d of document.querySelectorAll('[data-parity-shot="c09"] .trace-detail-row-fields')) {
      d.open = true
    }
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
  await shot(c, 'trace-parity-09-input-fields-drill')

  c.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
