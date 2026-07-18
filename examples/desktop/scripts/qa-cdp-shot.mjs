// CDP walkthrough driver + screenshotter for QA round-3 re-verification.
//
// Uses Page.captureScreenshot instead of macOS `screencapture` so we don't
// have to activate the Electron window (which would steal focus from the
// user). Same 403/Origin gotcha handling as scripts/qa-cdp-drive.mjs — Node
// built-in WebSocket sends no Origin header, so Chromium accepts.
//
// Usage:
//   node scripts/qa-cdp-shot.mjs <port> <outdir> <name> [tab] [mtab] [waitSel] [waitMs]
//
// Example:
//   node scripts/qa-cdp-shot.mjs 9223 docs/qa-round3-shots 03-mission-tree \
//       mission tree ".mission-view" 400
//
// - <port>      Electron --remote-debugging-port
// - <outdir>    directory to write <name>.png into
// - <name>      shot basename (no extension)
// - <tab>       optional __dshTabs.switchTo(...) target ('' to skip)
// - <mtab>      optional .mission-subview-tab[data-mission-tab=...] value
// - <waitSel>   optional CSS selector to wait for before the shot
// - <waitMs>    optional post-render settle in ms (default 300)

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [,, portArg, outdir, name, tab, mtab, waitSel, waitMsArg] = process.argv
const port = portArg || '9222'
const waitMs = Number(waitMsArg || 300)

if (!outdir || !name) {
  console.error('usage: node scripts/qa-cdp-shot.mjs <port> <outdir> <name> [tab] [mtab] [waitSel] [waitMs]')
  process.exit(1)
}

async function main() {
  const listRes = await fetch(`http://localhost:${port}/json/list`)
  const targets = await listRes.json()
  const target = targets.find((t) => t.type === 'page')
  if (!target) throw new Error('no page target')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, x) => { ws.onopen = r; ws.onerror = (e) => x(e) })

  let id = 1
  const pending = new Map()
  const chunks = []
  ws.onmessage = (ev) => {
    // Big Page.captureScreenshot payloads occasionally arrive as multiple
    // frames on the built-in WebSocket. Join before JSON.parse if needed.
    const data = typeof ev.data === 'string' ? ev.data : String(ev.data)
    let msg
    try { msg = JSON.parse(data) } catch { chunks.push(data); return }
    if (msg.id != null && pending.has(msg.id)) {
      const [ok, err] = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) err(new Error(msg.error.message))
      else ok(msg.result)
    }
  }
  const call = (m, p = {}, timeoutMs = 20000) => new Promise((ok, err) => {
    const _id = id++
    const timer = setTimeout(() => {
      pending.delete(_id)
      err(new Error(`cdp call timeout: ${m}`))
    }, timeoutMs)
    pending.set(_id, [(v) => { clearTimeout(timer); ok(v) }, (e) => { clearTimeout(timer); err(e) }])
    ws.send(JSON.stringify({ id: _id, method: m, params: p }))
  })
  const ev = async (js) => {
    const r = await call('Runtime.evaluate', {
      expression: js, returnByValue: true, awaitPromise: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result?.value
  }

  // Page domain enable — CDP allows Page.captureScreenshot without it in
  // theory, but some Chromium builds hang waiting for the frame lifecycle
  // notifications the domain publishes. Enable explicitly to be safe.
  await call('Page.enable')

  // Ask main to reveal the window (no focus steal) so the compositor has a
  // surface to render into. Without this Page.captureScreenshot can hang
  // indefinitely on a hidden window — that was the whole reason we shipped
  // the DSH_QA=1 window:reveal seam (src/main/main.js + src/main/window-reveal.js).
  // If the seam isn't exposed (production preload or DSH_QA not set on the
  // running instance), the eval returns undefined and we fall through to the
  // legacy setDeviceMetricsOverride path — no hard requirement.
  const revealed = await ev(`(async()=>{try{return window.dshQa && await window.dshQa.revealWindow()}catch(e){return {err: String(e)}}})()`)
  console.error(`reveal -> ${JSON.stringify(revealed)}`)

  // Force a fixed device viewport. With the reveal seam this is belt-and-
  // braces — the compositor now has a real surface — but keeping the override
  // in place also normalises the shot dimensions across whatever the window
  // was actually sized to, so shot-to-shot diffs stay meaningful.
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  })

  if (tab) {
    const rTab = await ev(`window.__dshTabs && window.__dshTabs.switchTo && window.__dshTabs.switchTo(${JSON.stringify(tab)})`)
    console.error(`settab ${tab} -> ${JSON.stringify(rTab)}`)
    await new Promise((r) => setTimeout(r, 200))
  }
  if (mtab) {
    const rMtab = await ev(`(function(){const el=document.querySelector('.mission-subview-tab[data-mission-tab='+${JSON.stringify(mtab)}+']'); if(!el) return 'NO_MTAB'; el.click(); return 'OK'})()`)
    console.error(`mtab ${mtab} -> ${rMtab}`)
    await new Promise((r) => setTimeout(r, 200))
  }
  if (waitSel) {
    const found = await ev(`(async()=>{for(let i=0;i<20;i++){if(document.querySelector(${JSON.stringify(waitSel)})) return true; await new Promise(r=>setTimeout(r,150))} return false})()`)
    console.error(`waitfor ${waitSel} -> ${found}`)
  }
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs))

  // fromSurface: false renders into an offscreen bitmap, so it works even
  // when the Electron window is occluded / minimized — captureScreenshot
  // with the default fromSurface: true hangs forever when the compositor
  // has no surface (which is exactly the case when we're deliberately not
  // stealing focus). captureBeyondViewport: true widens the render window
  // to the full document.
  const shot = await call('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: 1440, height: 900, scale: 1 },
  })
  await call('Emulation.clearDeviceMetricsOverride')
  const path = resolve(outdir, `${name}.png`)
  writeFileSync(path, Buffer.from(shot.data, 'base64'))
  console.log(path)
  ws.close()
}
main().catch((e) => { console.error(String(e)); process.exit(1) })
