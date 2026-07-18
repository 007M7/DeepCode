// scripts/qa-cdp-shoot-demo-labels.mjs — selfie proofs for fix/demo-labels.
//
// Covers the four page-level chips added by the demo-labels audit:
//   1) Bench page header    → "demo · G18/G19/G20 pending" chip
//   2) Rubrics page header  → "demo · G1 pending" chip
//   3) Missions empty state → mission-board-preview-chip "preview"
//   4) Session Tree demo    → tree-nav-demo-chip "demo forest" (after Load demo tree)
//
// Runs against a fresh DSH_QA=1 Electron booted by the QA agent on port 9280.
//
// Usage: node scripts/qa-cdp-shoot-demo-labels.mjs 9280 docs/demo-shots/demo-labels

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const [,, portArg, outdirArg] = process.argv
const port = portArg || '9280'
const outdir = outdirArg || 'docs/demo-shots/demo-labels'
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
    let msg; try { msg = JSON.parse(String(ev.data)) } catch { return }
    if (msg.id != null && pending.has(msg.id)) {
      const [ok, err] = pending.get(msg.id); pending.delete(msg.id)
      if (msg.error) err(new Error(msg.error.message)); else ok(msg.result)
    }
  }
  const call = (m, p = {}, timeoutMs = 60000) => new Promise((ok, err) => {
    const _id = id++
    const t = setTimeout(() => { pending.delete(_id); err(new Error('cdp timeout: ' + m)) }, timeoutMs)
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
  return { call, evjs, sleep, close: () => ws.close() }
}

async function shoot(c, name) {
  const r = await c.call('Page.captureScreenshot', { format: 'png' }, 20000)
  const p = resolve(outdir, name + '.png')
  writeFileSync(p, Buffer.from(r.data, 'base64'))
  console.log('  wrote', p)
}

async function closeDevtools(c) {
  await c.evjs(`(function(){
    const btn = document.querySelector('.devtools-drawer .devtools-close')
    if (btn) btn.click()
    const d = document.querySelector('.devtools-drawer')
    if (d && !d.hidden) d.hidden = true
    // Fork-compare and other overlay drawers can survive a page-tab switch —
    // dismiss anything sitting on top of the pane so the shot captures the
    // page proper, not the overlay from a previous scenario.
    const fc = document.getElementById('fork-compare-drawer')
    if (fc && !fc.hidden) {
      // The head has Refresh + Close; match by textContent so we don't grab
      // Refresh (both are .ghost.small buttons).
      const btns = Array.from(fc.querySelectorAll('button'))
      const close = btns.find((b) => /close/i.test(b.textContent))
      if (close) close.click(); else fc.hidden = true
    }
  })()`)
}

const RECIPES = [
  { name: '01-bench-page-demo-chip', waitMs: 500, prep: async (c) => {
      await c.evjs(`window.__dshTabs.switchTo('bench')`)
    }, assert: `(function(){
      const chip = document.querySelector('[data-pane="bench"] .demo-tier-chip')
      return chip ? { present: true, text: chip.textContent.trim(), title: chip.title.slice(0, 80) } : { present: false }
    })()` },
  { name: '02-rubrics-page-demo-chip', waitMs: 500, prep: async (c) => {
      await c.evjs(`window.__dshTabs.switchTo('rubrics')`)
    }, assert: `(function(){
      const chip = document.querySelector('[data-pane="rubrics"] .demo-tier-chip')
      return chip ? { present: true, text: chip.textContent.trim(), title: chip.title.slice(0, 80) } : { present: false }
    })()` },
  { name: '03-missions-preview-chip', waitMs: 700, prep: async (c) => {
      await c.evjs(`window.__dshTabs.switchTo('mission')`)
      await c.sleep(200)
      // Mission Control opens on the tree subview by default; the ghost
      // preview lives on the board subview's empty state. Click the Board
      // chip so the reader (and this shot) lands on the labeled preview.
      await c.evjs(`(function(){
        const boardBtn = document.querySelector('.mission-subview-tab[data-mission-tab="board"]')
        if (boardBtn) boardBtn.click()
      })()`)
    }, assert: `(function(){
      const chip = document.querySelector('.mission-board-preview-chip')
      if (chip && chip.scrollIntoView) chip.scrollIntoView({ block: 'center' })
      return chip ? { present: true, text: chip.textContent.trim(), classes: chip.className } : { present: false }
    })()` },
  { name: '04-session-tree-demo-forest', waitMs: 800, prep: async (c) => {
      await c.evjs(`window.__dshTabs.switchTo('tree')`)
      await c.sleep(200)
      // Prefer the empty-state button when it shows (first-run); fall back
      // to the QA hook when real sessions already populate the tree so the
      // empty state never renders.
      await c.evjs(`(function(){
        const btns = Array.from(document.querySelectorAll('.tree-empty-actions button'))
        const t = btns.find(b => b.textContent.trim() === 'Load demo tree')
        if (t) { t.click(); return }
        if (window.__dshTree && window.__dshTree._loadDemoForQA) window.__dshTree._loadDemoForQA()
      })()`)
    }, assert: `(function(){
      const chip = document.querySelector('.tree-nav-demo-chip')
      return chip ? { present: true, text: chip.textContent.trim(), title: chip.title.slice(0, 80) } : { present: false }
    })()` },
]

async function main() {
  const c = await cdp()
  console.log('port', port, 'outdir', outdir)
  await closeDevtools(c)
  await c.sleep(200)
  for (const r of RECIPES) {
    console.log(r.name)
    await r.prep(c)
    await c.sleep(r.waitMs)
    await closeDevtools(c)
    await c.sleep(150)
    if (r.assert) {
      const result = await c.evjs(r.assert)
      console.log('  assert:', JSON.stringify(result))
      if (!result || !result.present) {
        console.error('  ✗ MISSING chip on', r.name)
      }
    }
    await shoot(c, r.name)
  }
  await c.close()
  console.log('done')
}

main().catch((e) => { console.error(e); process.exit(1) })
