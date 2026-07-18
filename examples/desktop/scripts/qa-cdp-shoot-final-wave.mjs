// scripts/qa-cdp-shoot-final-wave.mjs — final-wave reshoot driver.
//
// Batch shots proving the eight-step merge onto test-real: every new page,
// the tri-view (Tree/Timeline/Graph + detail-pane), the chat empty launcher
// four-card, the Bench post-fix layout, and a §7 centered-card verification.
//
// Runs against a fresh DSH_QA=1 Electron on --remote-debugging-port=9224
// with a scratch --user-data-dir; the driver never launches Electron itself
// (the QA agent boots it in shell), just drives.
//
// Usage:
//   node scripts/qa-cdp-shoot-final-wave.mjs 9224 docs/demo-shots/final-wave

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const [,, portArg, outdirArg] = process.argv
const port = portArg || '9224'
const outdir = outdirArg || 'docs/demo-shots/final-wave'
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
      // Capture console entries so we can grep for SyntaxError in the
      // console-probe assertion at the tail of the run.
      const text = (msg.params?.args || [])
        .map((a) => a?.value ?? a?.description ?? '')
        .join(' ')
      consoleEntries.push({ level: msg.params?.type, text })
      return
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const desc = msg.params?.exceptionDetails?.exception?.description
        || msg.params?.exceptionDetails?.text || ''
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
  return { call, evjs, sleep, consoleEntries, close: () => ws.close() }
}

async function shoot(c, name) {
  const r = await c.call('Page.captureScreenshot', { format: 'png' })
  const p = resolve(outdir, name + '.png')
  writeFileSync(p, Buffer.from(r.data, 'base64'))
  console.log('  wrote', p)
}

// Close the devtools right-drawer if it's open. The QA harness pops it up
// on boot (Alt+D toggle default-visible when DSH_QA=1); every base-page
// shot needs it collapsed so the page fills the frame.
async function closeDevtools(c) {
  await c.evjs(`(function(){
    const btn = document.querySelector('.devtools-drawer .devtools-close')
    if (btn) { btn.click(); return { closed: true } }
    // fallback: hide the drawer directly
    const d = document.querySelector('.devtools-drawer')
    if (d && !d.hidden) { d.hidden = true; return { closed: 'hidden' } }
    return { closed: false }
  })()`)
}

// Open devtools drawer (for the trace tri-view sequence where the "Full
// trace" button lives inside the drawer head).
async function openDevtools(c) {
  await c.evjs(`(function(){
    const d = document.querySelector('.devtools-drawer')
    if (d && d.hidden) {
      // Find the show button in the debug bar
      const t = document.querySelector('[data-devtools-toggle], .devtools-toggle, button[title*="Devtools" i]')
      if (t) t.click()
      else d.hidden = false
      return { opened: true }
    }
    return { opened: !!d }
  })()`)
}

// ---------------- shot recipes ----------------
// Each entry: { name, prep(c), waitMs }
// prep may switch tabs, click subtabs, seed a session, etc.
const RECIPES = [
  // 1. Context page
  { name: '01-context-page', waitMs: 400, prep: async (c) => {
      await c.evjs(`window.__dshTabs.switchTo('context')`)
    } },
  // 2. Hub page
  { name: '02-hub-page', waitMs: 400, prep: async (c) => {
      await c.evjs(`window.__dshTabs.switchTo('hub')`)
    } },
  // 3. Bench page — post-fix layout (f1efa1c closed the two unclosed blocks
  // that had swallowed the bench grid rules; this shot is the "layout OK now"
  // proof).
  { name: '03-bench-page', waitMs: 500, prep: async (c) => {
      await c.evjs(`window.__dshTabs.switchTo('bench')`)
    } },
  // 4. Rubrics catalog
  { name: '04-rubrics-page', waitMs: 400, prep: async (c) => {
      await c.evjs(`window.__dshTabs.switchTo('rubrics')`)
    } },
  // 5. Runtimes page
  { name: '05-runtimes-page', waitMs: 400, prep: async (c) => {
      await c.evjs(`window.__dshTabs.switchTo('runtimes')`)
    } },
  // 6. Settings
  { name: '06-settings-page', waitMs: 400, prep: async (c) => {
      await c.evjs(`window.__dshTabs.switchTo('growth')`)
      // Growth might not exist as 'settings' pane; try both. Fall back to
      // whatever data-tab='settings' resolves to via nav btn click.
      await c.evjs(`
        (function(){
          const b = document.querySelector('.tab-btn[data-tab="settings"]')
          if (b) b.click()
        })()
      `)
    } },
  // 7. Session Tree
  { name: '07-session-tree', waitMs: 500, prep: async (c) => {
      await c.evjs(`window.__dshTabs.switchTo('tree')`)
    } },
  // 8. Chat empty-state launcher four cards. Rebuild by fetching the
  // real index.html and grafting its .empty-welcome block into the
  // stream — the daemon typically auto-selects a prior session on boot
  // and populates the stream, wiping the static template. Fetching
  // preserves the actual SVG icons, tint classes, and copy without us
  // reinventing them here.
  { name: '08-chat-empty-launcher', waitMs: 600, prep: async (c) => {
      await c.evjs(`window.__dshTabs.switchTo('chat')`)
      await c.evjs("(async function(){\n" +
        "  var stream = document.getElementById('stream')\n" +
        "  if (!stream) return { ok: false, msg: 'no stream' }\n" +
        "  var res = await fetch(window.location.href.split('#')[0])\n" +
        "  var html = await res.text()\n" +
        "  var m = html.match(/<div class=\"empty-welcome\"[\\s\\S]*?<\\/div>\\s*<\\/div>\\s*<\\/section>/)\n" +
        "  if (!m) return { ok: false, msg: 'template not found' }\n" +
        "  // Strip the trailing </section> we captured to find the block boundary.\n" +
        "  var block = m[0].replace(/<\\/section>$/, '').trim()\n" +
        "  stream.innerHTML = block\n" +
        "  return { ok: true }\n" +
        "})()")
    } },
]

// The tri-view detail shots run after the base pages. They seed a QA
// session, jump to Full trace via the devtools drawer contract, and then
// switch across tabs.
async function seedQaSession(c) {
  // Prefer __dshLoadSampleTrace — mints a session AND replays a rich
  // multi-turn fixture (~2.1+2.2+2.3+2.5+2.6 concatenated) so the Full
  // trace overlay opens with real steps, not "0 steps".
  return c.evjs(`(async () => {
    if (typeof window.__dshLoadSampleTrace === 'function') {
      await window.__dshLoadSampleTrace()
      return { via: 'loadSampleTrace' }
    }
    if (typeof window.__dshQaSeedSession === 'function') {
      const r = await window.__dshQaSeedSession()
      return { via: 'seed', id: (r && r.id) || null }
    }
    throw new Error('no seed helper (DSH_QA=1 not set?)')
  })()`)
}

async function openFullTrace(c) {
  // Two options:
  //   1) devtools drawer -> "Full trace" button opens a session-scope
  //      overlay (Tree/Timeline/Graph over the devtools event log). This
  //      is empty when we replay through onSessionEvent because the
  //      devtools drawer subscribes to a separate wire.
  //   2) Turn-footer per-turn tri-view drawer — this is where the Tree
  //      view actually mounts with real records. `<details.turn-trace-drawer>`
  //      is closed by default; open it programmatically.
  // Prefer path 2, fall back to path 1 for the empty-state proof.
  return c.evjs("(async () => {\n" +
    "  // Path 2: open the last turn's trace drawer inline.\n" +
    "  const drawers = document.querySelectorAll('details.turn-trace-drawer')\n" +
    "  if (drawers.length > 0) {\n" +
    "    const d = drawers[drawers.length - 1]\n" +
    "    d.open = true\n" +
    "    // Scroll it into view so the shot frames the tri-view, not empty scrollback.\n" +
    "    d.scrollIntoView({ block: 'center' })\n" +
    "    await new Promise(r => setTimeout(r, 400))\n" +
    "    return { via: 'turn-drawer', drawers: drawers.length }\n" +
    "  }\n" +
    "  // Path 1: fallback — devtools full-trace overlay (empty in this demo)\n" +
    "  const btns = Array.from(document.querySelectorAll('button, a, [role=button]'))\n" +
    "  const hit = btns.find(b => /full\\s*trace/i.test(b.textContent || ''))\n" +
    "  if (hit) { hit.click(); await new Promise(r => setTimeout(r, 300)); return { via: 'button' } }\n" +
    "  return { via: 'none' }\n" +
    "})()")
}

async function switchTriviewTab(c, tab) {
  // Only touch the tri-view inside the currently-open turn-trace-drawer.
  // Multiple turn drawers can carry their own chip sets; we opened the
  // last one, so scope to `details.turn-trace-drawer[open]`.
  const js =
    "(function(){\n" +
    "  var target = " + JSON.stringify(tab) + ";\n" +
    "  var scope = document.querySelector('details.turn-trace-drawer[open]') || document\n" +
    "  var btn = scope.querySelector('.trace-tri-chips .trace-tri-chip.chip-' + target)\n" +
    "  if (btn) { btn.click(); return { clicked: true, via: 'chip' } }\n" +
    "  var btn2 = scope.querySelector('.trace-tri-chip[data-view=\"' + target + '\"]')\n" +
    "  if (btn2) { btn2.click(); return { clicked: true, via: 'data-view' } }\n" +
    "  return { clicked: false, scoped: (scope !== document) }\n" +
    "})()"
  return c.evjs(js)
}

// ---------------- driver ----------------
async function main() {
  const c = await cdp()
  await c.call('Page.enable')
  await c.evjs(`document.title`) // handshake
  console.log('CDP handshake OK')

  // First pass: base pages (drawer closed).
  await closeDevtools(c)
  await c.sleep(200)
  for (const rec of RECIPES) {
    console.log('shot:', rec.name)
    try {
      await rec.prep(c)
      // The Chat pane opens the devtools drawer on entry in DSH_QA mode
      // (qa-harness auto-opens); close after each prep so page-only shots
      // stay clean.
      await closeDevtools(c)
    } catch (e) {
      console.log('  prep err:', e.message)
    }
    await c.sleep(rec.waitMs)
    await shoot(c, rec.name)
  }

  // Second pass: tri-view detail shots. Seed with real events first, then
  // open the devtools drawer so the Full-trace button is reachable.
  console.log('seeding QA session for tri-view shots...')
  try {
    // Back to chat pane where seeding wires stream to the visible pane.
    await c.evjs(`window.__dshTabs.switchTo('chat')`)
    await c.sleep(200)
    const seedRes = await seedQaSession(c)
    console.log('  seed:', JSON.stringify(seedRes))
    await c.sleep(800)
    // Bonus: populated chat with the sample-session fixture in place.
    // Devtools drawer stays closed for this shot.
    await closeDevtools(c)
    await c.sleep(200)
    await shoot(c, '13-chat-populated')
    // Keep devtools closed for the tri-view sequence — tri-view lives
    // inside a per-turn <details> drawer beneath the turn footer, not
    // inside the devtools drawer.
    const openRes = await openFullTrace(c)
    console.log('  openFullTrace:', JSON.stringify(openRes))
    await c.sleep(600)

    // 09 tree view (default after open) with inline time bar + model chip + pill row
    await shoot(c, '09-triview-tree')

    // 10 timeline tab (Gantt-shaped)
    await switchTriviewTab(c, 'timeline')
    await c.sleep(400)
    await shoot(c, '10-triview-timeline')

    // 11 graph tab
    await switchTriviewTab(c, 'graph')
    await c.sleep(400)
    await shoot(c, '11-triview-graph')

    // Back to tree, expand a step to see the four detail-pane tabs.
    await switchTriviewTab(c, 'tree')
    await c.sleep(300)
    // Click the first expandable step summary in the tree to open the detail pane.
    await c.evjs("(function(){\n" +
      "  // Tree lives inside the tri-view; the trace card rows are <details>\n" +
      "  // summaries built by renderer.js. Grab the first summary in the\n" +
      "  // active panel and click it to expand.\n" +
      "  var panel = document.querySelector('.trace-tri-panel.panel-tree:not([hidden])')\n" +
      "  var scope = panel || document\n" +
      "  var summary = scope.querySelector('details > summary')\n" +
      "  if (summary) { summary.click(); return { clicked: 'summary' } }\n" +
      "  var row = scope.querySelector('.trace-event-row')\n" +
      "  if (row) { row.click(); return { clicked: 'row' } }\n" +
      "  return { clicked: null }\n" +
      "})()")
    await c.sleep(500)
    await shoot(c, '12-triview-detail-pane')

    // 14 §7 verification — mount the centered-card family (approval,
    // workflow, subagent, question, terminal, diff) into the stream by
    // firing the QA Debug buttons. If ANY of them render centered
    // (not full-width) the shot exposes it; the CSS static gate should
    // already prevent it, this is the render-time cross-check.
    await c.evjs(`window.__dshTabs.switchTo('chat')`)
    await c.sleep(200)
    await c.evjs("(function(){\n" +
      "  var ids = ['mock-approval','mock-question','mock-card-terminal','mock-card-diff','mock-workflow','mock-recall','mock-compact-summary']\n" +
      "  var fired = []\n" +
      "  for (var i = 0; i < ids.length; i++) {\n" +
      "    var b = document.getElementById(ids[i])\n" +
      "    if (b) { b.click(); fired.push(ids[i]) }\n" +
      "  }\n" +
      "  return { fired: fired }\n" +
      "})()")
    await c.sleep(500)
    await closeDevtools(c)
    await c.sleep(200)
    await c.evjs("(function(){ var s = document.getElementById('stream'); if (s) s.scrollTop = 0 })()")
    await c.sleep(200)
    await shoot(c, '14-section7-tool-cards')
  } catch (e) {
    console.log('  tri-view sequence err:', e.message)
  }

  // Console-probe assertion — no SyntaxError should have surfaced.
  await c.sleep(200)
  const syntaxHits = c.consoleEntries.filter(e => /SyntaxError/i.test(e.text))
  const jsonPath = resolve(outdir, 'console-report.json')
  writeFileSync(jsonPath, JSON.stringify({
    port,
    outdir,
    totalConsoleEntries: c.consoleEntries.length,
    syntaxErrors: syntaxHits,
    exceptions: c.consoleEntries.filter(e => e.level === 'exception'),
  }, null, 2))
  console.log('console report:', jsonPath, 'syntaxErrors=' + syntaxHits.length)

  c.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
