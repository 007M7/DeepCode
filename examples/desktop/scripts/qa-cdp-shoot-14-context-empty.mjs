// Shot for task #14 — Context empty-state layout fix (user field report
// 2026-07-17). Verifies the pane no longer shows: (a) a left column hole,
// (b) an empty card floating in the right slot, or (c) an orphaned SDK
// support card. After the fix the empty pane reads as a single-column
// document: subtitle → empty card (page chrome, sole "no activity" copy) →
// SDK support card, stacked full-width. See src/renderer/style.css
// `.context-page-body.is-empty`, context-page.js `renderEmpty()`.
//
// Runs against an Electron shell launched with DSH_QA=1 and
// --remote-debugging-port=$port (default 9241). Node built-in WebSocket
// sends no Origin header, which Chromium accepts.

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const port = process.argv[2] || '9241'
const outdir = process.argv[3] || 'docs/demo-shots'
mkdirSync(outdir, { recursive: true })

async function main () {
  const targets = await (await fetch(`http://localhost:${port}/json/list`)).json()
  const target = targets.find((t) => t.type === 'page')
  if (!target) throw new Error('no page target on port ' + port)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, x) => { ws.onopen = r; ws.onerror = (e) => x(e) })

  let id = 1
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
    if (msg.id != null && pending.has(msg.id)) {
      const [ok, err] = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) err(new Error(msg.error.message))
      else ok(msg.result)
    }
  }
  const call = (m, p = {}, timeoutMs = 15000) => new Promise((ok, err) => {
    const _id = id++
    const timer = setTimeout(() => { pending.delete(_id); err(new Error('cdp timeout: ' + m)) }, timeoutMs)
    pending.set(_id, [(v) => { clearTimeout(timer); ok(v) }, (e) => { clearTimeout(timer); err(e) }])
    ws.send(JSON.stringify({ id: _id, method: m, params: p }))
  })
  const evj = async (expr) => {
    const r = await call('Runtime.evaluate', {
      expression: `(async()=>{try{return (${expr})}catch(e){return {__err: String(e)}}})()`,
      returnByValue: true, awaitPromise: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result?.value
  }

  await call('Page.enable')
  await evj(`window.dshQa && window.dshQa.revealWindow ? await window.dshQa.revealWindow() : null`)
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
  })

  // Dismiss onboarding if it's up.
  await evj(`(function(){
    const btns = Array.from(document.querySelectorAll('button'));
    const skip = btns.find(b => /skip and use defaults/i.test(b.textContent || ''));
    if (skip) { skip.click(); return 'dismissed'; }
    return 'no-onboarding';
  })()`)
  await new Promise((r) => setTimeout(r, 300))

  // Hide devtools drawer if it stole the right edge.
  await evj(`(function(){
    const d = document.querySelector('.devtools-drawer');
    if (d) { d.style.display = 'none'; return 'hidden'; }
    return 'no-drawer';
  })()`)

  // Switch to Context tab. Force through the seam so we don't rely on the
  // sidebar text — nav items may hide labels behind icons.
  await evj(`(function(){
    if (window.__dshTabs && window.__dshTabs.switchTo) {
      window.__dshTabs.switchTo('context');
      return 'via seam';
    }
    const el = document.querySelector('[data-tab="context"]');
    if (el) { el.click(); return 'via click'; }
    return 'no-target';
  })()`)
  await new Promise((r) => setTimeout(r, 500))

  // Empty by design — no session events. Verify the layout classes we care about.
  const inspect = await evj(`(function(){
    const body = document.querySelector('.context-page-body');
    const empty = document.getElementById('context-page-empty');
    const list = document.getElementById('context-page-list');
    const legend = document.querySelector('.context-page-legend-card');
    const sub = document.getElementById('context-page-subtitle');
    return {
      bodyClass: body ? body.className : null,
      isEmpty: !!(body && body.classList.contains('is-empty')),
      emptyHidden: empty ? empty.hidden : null,
      emptyRect: empty ? (({x,y,width,height}) => ({x:Math.round(x),y:Math.round(y),w:Math.round(width),h:Math.round(height)}))(empty.getBoundingClientRect()) : null,
      listHidden: list ? list.hidden : null,
      legendRect: legend ? (({x,y,width,height}) => ({x:Math.round(x),y:Math.round(y),w:Math.round(width),h:Math.round(height)}))(legend.getBoundingClientRect()) : null,
      subtitleText: sub ? sub.textContent : null,
    };
  })()`)
  console.error('layout ->', JSON.stringify(inspect))

  await new Promise((r) => setTimeout(r, 500))
  const shot = await call('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: 1440, height: 900, scale: 2 },
  }, 30000)
  const outPath = resolve(outdir, '14-context-empty-fixed.png')
  writeFileSync(outPath, Buffer.from(shot.data, 'base64'))
  console.log(outPath)
  ws.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
