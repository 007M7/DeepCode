// tools/shoot-turn-flow-glyph.js — CDP driver to seed a multi-loop turn
// via __dshQaPlayFixture and screenshot the turn footer with the glyph.
'use strict'

const http = require('http')
const fs = require('fs')
// Node 22 ships a built-in WebSocket; no ws package needed.

const HOST = '127.0.0.1'
const PORT = process.env.CDP_PORT || 9227
const FIXTURE = process.argv[2] || '2.6-turn-flow-glyph-multiloop.json'
const OUT = process.argv[3] || '/tmp/turn-flow-glyph-multiloop.png'

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (r) => {
      let b = ''
      r.on('data', (c) => (b += c))
      r.on('end', () => resolve(b))
    }).on('error', reject)
  })
}

;(async () => {
  const targets = JSON.parse(await get(`http://${HOST}:${PORT}/json/list`))
  const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'))
  if (!page) throw new Error('no page target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let msgId = 1
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const j = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString())
    if (j.id && pending.has(j.id)) {
      const { resolve, reject } = pending.get(j.id)
      pending.delete(j.id)
      if (j.error) reject(new Error(JSON.stringify(j.error)))
      else resolve(j.result)
    }
  })
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = msgId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  await send('Page.enable', {})
  await send('Runtime.enable', {})

  const evalJS = (expr) => send('Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true,
  }).then((r) => r.result ? r.result.value : null)
  const evalJSSync = (expr) => send('Runtime.evaluate', {
    expression: expr, returnByValue: true,
  }).then((r) => r.result ? r.result.value : null)

  // Dismiss onboarding BEFORE playing the fixture so the click-through
  // does not race the QA seam. Sync eval — no awaitPromise chain.
  await evalJSSync(`(() => {
    try {
      const skipBtn = Array.from(document.querySelectorAll('button')).find(b =>
        /skip and use defaults/i.test((b.textContent || '').trim())
      );
      if (skipBtn) skipBtn.click();
    } catch (_) {}
    try {
      document.querySelectorAll('.onboarding-scrim, .app-dialog').forEach(n => {
        try { if (typeof n.close === 'function') n.close() } catch (_) {}
        try { if (n && n.parentNode) n.parentNode.removeChild(n) } catch (_) {}
      });
    } catch (_) {}
    return 'dismissed';
  })()`)
  await new Promise((r) => setTimeout(r, 200))

  // Seed the fixture (creates a new session, plays events through
  // onSessionEvent, resolves the id).
  const played = await evalJS(`window.__dshQaPlayFixture(${JSON.stringify(FIXTURE)}).then(r => JSON.stringify(r))`)
  console.log('play result:', played)

  // Small wait for DOM.
  await new Promise((r) => setTimeout(r, 800))

  // Force chat pane on + close devtools panel again (fixture play may
  // have re-triggered another surface). Sync eval — no awaitPromise.
  await evalJSSync(`(() => {
    try {
      const chatTab = document.querySelector('.tab-btn[data-tab="chat"]');
      if (chatTab) chatTab.click();
    } catch (_) {}
    try {
      const dt = document.querySelector('.devtools-panel');
      if (dt && !dt.hidden) {
        const close = dt.querySelector('.dt-close, .devtools-close, [data-close]');
        if (close) close.click();
        dt.hidden = true;
      }
    } catch (_) {}
    return 'cleaned';
  })()`)
  await new Promise((r) => setTimeout(r, 800))

  // Confirm the glyph is in the DOM.
  const found = await evalJS(`(() => {
    const g = document.querySelectorAll('.turn-flow-glyph');
    if (!g.length) return { count: 0 };
    const first = g[0];
    return {
      count: g.length,
      width: first.getAttribute('width'),
      dots: first.querySelectorAll('circle').length,
      kinds: Array.from(first.querySelectorAll('circle')).map(c => c.getAttribute('class')),
    };
  })()`)
  console.log('glyph diagnostics:', JSON.stringify(found))

  // Scroll the LAST assistant-turn (the one we just played) into view and
  // ensure the trace drawer is closed so the footer row (with the glyph)
  // is the visual anchor.
  await evalJS(`(() => {
    const rows = document.querySelectorAll('.assistant-turn');
    if (rows.length) {
      const last = rows[rows.length - 1];
      const footer = last.querySelector('.turn-footer');
      if (footer) footer.scrollIntoView({ block: 'center' });
      last.querySelectorAll('.turn-trace-drawer[open]').forEach(d => { d.open = false });
    }
    return true;
  })()`)
  await new Promise((r) => setTimeout(r, 300))

  // Grab a tight clip around the glyph's footer row so the reader sees
  // the visual craft (baseline alignment, hover-target size, palette).
  const clip = await evalJS(`(() => {
    const g = document.querySelector('.turn-flow-glyph');
    if (!g) return null;
    const footer = g.closest('.turn-footer');
    const r = (footer || g).getBoundingClientRect();
    // 24px padding around so the shot has breathing room without leaking neighbors.
    return { x: Math.max(0, r.left - 24), y: Math.max(0, r.top - 24), width: Math.min(r.width + 48, 900), height: Math.max(r.height + 48, 80), scale: 2 };
  })()`)
  const shotParams = { format: 'png', captureBeyondViewport: false }
  if (clip && clip.width > 0 && clip.height > 0) shotParams.clip = clip
  const shot = await send('Page.captureScreenshot', shotParams)
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'))
  console.log('wrote', OUT, 'clip=', JSON.stringify(clip))

  ws.close()
})().catch((e) => { console.error(e); process.exit(1) })
