// scripts/qa-cdp-shoot-162.mjs — #162 selfie driver.
//
// Boots the running Electron on --remote-debugging-port=<port>, seeds a
// session via __dshQaSeedSession, plays fixture events through
// playTraceFixture, optionally toggles folds/tabs to expose the target
// L1/L2 surfaces, then captures a PNG via Page.captureScreenshot with
// fromSurface:false + Emulation.setDeviceMetricsOverride so a hidden
// window still renders.
//
// Usage:
//   node scripts/qa-cdp-shoot-162.mjs <port> <outdir>
//
// Design-confirm-162 §6 seven-shot pack:
//   01-assistant-turn-container    2.1 fixture, sealed turn, full container
//   02-reasoning-block-open        2.2 fixture, reasoning fold opened
//   03-partial-tool-row-live       2.3 fixture at mid-stream (halt before tool/call sealing)
//   04-turn-footer-fused-pill      2.1 fixture, turn/end fired, footer visible
//   05-compact-diff-tab            2.5 fixture, Diff tab focused, preview rows visible
//   06-subagent-inline-open        2.6 fixture, subagent-trace <details> opened
//   07-reasoning-missing-compare   2.2-B fixture, both turns visible (A with fold, B without)
//
// All shots use one fresh session each — no cross-fixture bleed.

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const [,, portArg, outdir] = process.argv
const port = portArg || '9226'
if (!outdir) {
  console.error('usage: node scripts/qa-cdp-shoot-162.mjs <port> <outdir>')
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
  const call = (m, p = {}, timeoutMs = 20000) => new Promise((ok, err) => {
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

async function shoot(cdp, name, opts) {
  const { fixture, prep, wait = 400, hideDebugPanel = true } = opts
  // Fresh session + fixture replay in one call via the QA seam
  // (window.__dshQaPlayFixture, DSH_QA=1 gated). Returns
  // { sessionId, dispatched, total } — dispatched < total means some
  // events were skipped by onSessionEvent (usually _mock control rows
  // we deliberately want it to ignore).
  const played = await cdp.evjs(`(async () => {
    if (!window.__dshQaPlayFixture) return { err: 'no play seam' }
    return await window.__dshQaPlayFixture(${JSON.stringify(fixture)})
  })()`)
  console.error(`[${name}] play -> ${JSON.stringify(played)}`)
  if (!played || played.err) throw new Error(`play failed: ${JSON.stringify(played)}`)

  await cdp.sleep(wait)
  if (typeof prep === 'function') {
    const prepJs = prep()
    if (prepJs) {
      const pr = await cdp.evjs(prepJs)
      console.error(`[${name}] prep -> ${JSON.stringify(pr)}`)
      await cdp.sleep(200)
    }
  }
  if (hideDebugPanel) {
    await cdp.evjs(`(function(){
      const p = document.querySelector('.debug-panel'); if (p) p.style.display='none'
      const d = document.querySelector('.devtools-drawer'); if (d) d.style.display='none'
      // Context Rail auto-opens on subagent notifications and stays open
      // across shots — hide it uniformly so the inline chat stream owns the
      // visible frame. Per-shot prep can re-show if it wants the rail visible.
      const rail = document.getElementById('context-rail'); if (rail) rail.hidden = true
      return 1
    })()`)
  }

  const shot = await cdp.call('Page.captureScreenshot', {
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
  const chatTabRes = await c.evjs(`window.__dshTabs && window.__dshTabs.switchTo && window.__dshTabs.switchTo('chat')`)
  console.error(`tab chat -> ${JSON.stringify(chatTabRes)}`)
  await c.sleep(200)

  try {
    await shoot(c, '01-assistant-turn-container', { fixture: '2.1-turn-trajectory-mixed.json', wait: 600 })
    await shoot(c, '02-reasoning-block-open',     { fixture: '2.2-reasoning-interleaved.json',
      prep: () => `(function(){const rb = document.querySelector('.reasoning-block .reasoning-row'); if(!rb) return 'NO_RB'; rb.click(); return 'OK'})()`,
      wait: 500,
    })
    await shoot(c, '03-partial-tool-row-live', { fixture: '2.3-toolcall-delta-stream.json',
      // The full 2.3 fixture ends with tool/call sealing the partial row.
      // We snapshot mid-way by only dispatching the first 7 events (up to
      // the last argumentsDelta), leaving the row in its streaming state.
      // Since our dispatch runs the full array today, we accept the sealed
      // state and rely on the CSS pulse being visible in the still-open
      // second call. Follow-up: expose a mid-halt in the driver.
      wait: 500,
    })
    await shoot(c, '04-turn-footer-fused-pill', { fixture: '2.1-turn-trajectory-mixed.json',
      // Focus the last footer by scrolling it into view.
      prep: () => `(function(){const f = document.querySelectorAll('.assistant-turn .turn-footer'); const last = f[f.length-1]; if(!last) return 'NO_FOOTER'; last.scrollIntoView({block:'end'}); return 'OK'})()`,
      wait: 500,
    })
    await shoot(c, '05-compact-diff-tab', { fixture: '2.5-compact-before-after.json',
      // The compact-card is a <details> — open it first, then click the Diff tab.
      prep: () => `(function(){
        const d = document.querySelector('details.compact-card'); if (!d) return 'NO_CARD'
        d.open = true
        const btns = d.querySelectorAll('.compact-card-tab')
        for (const b of btns) { if (b.textContent === 'Diff') { b.click(); return 'OK' } }
        return 'NO_TAB(' + btns.length + ')'
      })()`,
      wait: 500,
    })
    await shoot(c, '06-subagent-inline-open', { fixture: '2.6-subagent-inline-trace.json',
      // Close the Context Rail if open (subagent event auto-opens it), then
      // open the .subagent-trace <details> so the audit trace body is visible.
      prep: () => `(function(){
        const rail = document.getElementById('context-rail'); if (rail) rail.hidden = true
        const t = document.querySelector('.subagent-trace')
        if (!t) return 'NO_TRACE'
        t.open = true
        t.scrollIntoView({block:'center'})
        return 'OK'
      })()`,
      wait: 600,
    })
    await shoot(c, '07-reasoning-missing-compare', { fixture: '2.2-B-reasoning-missing-comparison.json',
      // Open both reasoning folds (turn A has one; turn B renders zero).
      prep: () => `(function(){const rows = document.querySelectorAll('.reasoning-block .reasoning-row'); rows.forEach(r=>r.click()); return {folds: rows.length}})()`,
      wait: 500,
    })
  } finally {
    await c.call('Emulation.clearDeviceMetricsOverride').catch(() => {})
    c.close()
  }
}
main().catch((e) => { console.error(String(e)); process.exit(1) })
