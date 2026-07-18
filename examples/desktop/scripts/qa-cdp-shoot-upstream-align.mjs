// scripts/qa-cdp-shoot-upstream-align.mjs — ticket #15 selfie driver.
//
// Three shots that lock the upstream-align visual contract:
//   01-subagent-live-running — RUNNING inline card with the pulsing accent
//                              left border + live-subtrajectory rows growing
//                              (fixture is halted between subagent.started
//                              and subagent.finished so the RUNNING state
//                              is on screen).
//   02-subagent-live-done    — full sealed inline trace after
//                              subagent.finished lands and swaps the card
//                              in place. Structured JSON return visible.
//   03-raw-inject-cards      — two raw-envelope injection cards (typed
//                              workspace-instructions + generic unknown-kind
//                              fallback) sitting alongside one tagged
//                              (envelope='context') inject card so the
//                              visual A/B reads at a glance.
//
// Usage:
//   node scripts/qa-cdp-shoot-upstream-align.mjs <port> <outdir>

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const [,, portArg, outdir] = process.argv
const port = portArg || '9241'
if (!outdir) {
  console.error('usage: node scripts/qa-cdp-shoot-upstream-align.mjs <port> <outdir>')
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

// Live subagent driver — plays events one at a time, halting between
// subagent.started and subagent.finished to expose the RUNNING state.
// The full fixture has 18 entries; we replay through entry 14 (the last
// live child event) and STOP before entry 15 (subagent.finished).
async function playPartial(cdp, name, upTo) {
  return await cdp.evjs(`(async () => {
    // Mint a session + focus it.
    const { id } = await window.dsh.newSession()
    if (window.__dshChat && window.__dshChat.selectSession) {
      await window.__dshChat.selectSession(id)
    }
    // Fetch the fixture directly so we can slice it.
    const url = new URL('../../fixtures/trace-samples/${name}', window.location.href)
    const res = await fetch(url.href)
    const events = await res.json()
    const slice = events.slice(0, ${upTo})
    // Re-use the same idMap the shipped playTraceFixture builds so the
    // sub-session events land under the right lineage record.
    const idMap = new Map()
    for (const ev of slice) {
      if (ev && ev.type === '_notification' && ev.method) {
        const params = { ...(ev.params || {}) }
        if (params.parentSessionId && !idMap.has(params.parentSessionId)) {
          idMap.set(params.parentSessionId, id)
        }
        params.parentSessionId = idMap.get(params.parentSessionId) || id
        if (params.childSessionId && !idMap.has(params.childSessionId)) {
          idMap.set(params.childSessionId, 'fixture-' + params.childSessionId)
        }
        params.childSessionId = idMap.get(params.childSessionId)
        window.__dshRenderer.dispatchSubagentNotification(ev.method, params)
        continue
      }
      const target = ev && ev._sessionId
        ? (idMap.get(ev._sessionId) || (idMap.set(ev._sessionId, 'fixture-' + ev._sessionId), idMap.get(ev._sessionId)))
        : id
      window.__dshRenderer.onSessionEvent(target, ev)
    }
    return { sessionId: id, dispatched: slice.length, total: events.length }
  })()`)
}

async function shoot(cdp, name, opts) {
  const { play, wait = 400, hideDebugPanel = true, prep } = opts
  const played = await play()
  console.error(`[${name}] play -> ${JSON.stringify(played)}`)
  await cdp.sleep(wait)
  if (typeof prep === 'function') {
    const p = prep()
    if (p) { await cdp.evjs(p); await cdp.sleep(200) }
  }
  if (hideDebugPanel) {
    await cdp.evjs(`(function(){
      const p = document.querySelector('.debug-panel'); if (p) p.style.display='none'
      const d = document.querySelector('.devtools-drawer'); if (d) d.style.display='none'
      const rail = document.getElementById('context-rail-drawer'); if (rail) { rail.hidden = true; rail.style.display = 'none' }
      const ov = document.getElementById('onboarding');
      if (ov) { ov.style.display='none'; ov.hidden = true }
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
  // Dismiss any onboarding / modal overlay that ships on first-run so the
  // chat stream is actually visible.
  await c.evjs(`(function(){
    const overlay = document.getElementById('onboarding');
    if (overlay) { overlay.style.display = 'none'; overlay.hidden = true; }
    // Also close Context Rail — subagent notifications auto-open it and the
    // shots want the chat stream owning the frame.
    const rail = document.getElementById('context-rail-drawer');
    if (rail) { rail.hidden = true; rail.style.display = 'none' }
    return { overlayCleared: !!overlay };
  })()`)
  await c.evjs(`window.__dshTabs && window.__dshTabs.switchTo && window.__dshTabs.switchTo('chat')`)
  await c.sleep(300)

  try {
    // 01 — halt at index 14 (indices 0..13 = up through the child's
    // turn/end; index 14 = subagent.finished which would flip the card).
    // Fixture layout verified by `node -e` walk 2026-07-17.
    await shoot(c, '01-subagent-live-running', {
      play: () => playPartial(c, 'upstream-align-A-subagent-live.json', 14),
      wait: 600,
      prep: () => `(function(){
        // Ensure rail stays hidden — subagent notifications auto-open it.
        const rail = document.getElementById('context-rail-drawer'); if (rail) { rail.hidden = true; rail.style.display = 'none' };
        // Ensure the spawn tool row is open so the reader sees the payload
        // that led to the running subagent underneath.
        const tool = document.querySelector('.tool-block[data-call-id="call_spawn_live_1"]');
        if (tool) tool.open = true;
        // Ensure the RUNNING trace details are open so the live rows are visible.
        const card = document.querySelector('.subagent-trace--running');
        if (card) { card.open = true; if (card.scrollIntoView) card.scrollIntoView({block:'center'}); }
        return { rail: !!rail, tool: !!tool, card: !!card };
      })()`,
    })

    // 02 — full fixture (subagent.finished lands; card swaps to sealed).
    await shoot(c, '02-subagent-live-done', {
      play: () => c.evjs(`window.__dshQaPlayFixture('upstream-align-A-subagent-live.json')`),
      wait: 600,
      prep: () => `(function(){
        const rail = document.getElementById('context-rail-drawer'); if (rail) { rail.hidden = true; rail.style.display = 'none' };
        const tool = document.querySelector('.tool-block[data-call-id="call_spawn_live_1"]');
        if (tool) tool.open = true;
        const t = document.querySelector('.subagent-trace');
        if (t) { t.open = true; if (t.scrollIntoView) t.scrollIntoView({block:'center'}); }
        // Open the return section explicitly so the structured JSON is visible.
        const ret = document.querySelector('.subagent-card-return');
        if (ret) ret.open = true;
        return { tool: !!tool, trace: !!t, ret: !!ret };
      })()`,
    })

    // 03 — raw inject cards.
    await shoot(c, '03-raw-inject-cards', {
      play: () => c.evjs(`window.__dshQaPlayFixture('upstream-align-B-raw-inject.json')`),
      wait: 600,
      prep: () => `(function(){
        // Open both raw cards so the typed shape + L2 JSON are visible.
        const cards = document.querySelectorAll('.raw-inject-card');
        for (const c of cards) c.open = true;
        // Also open the L2 JSON drawer on the first raw card so envelope+meta
        // are visible in the selfie (zero-loss demonstration).
        const l2 = document.querySelector('.raw-inject-l2');
        if (l2) l2.open = true;
        return { rawCards: cards.length, opened: !!l2 };
      })()`,
    })
  } finally {
    c.close()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
