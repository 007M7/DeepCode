// QA verification script for lane-wf-feedback. Boots an isolated Electron on a
// private CDP port (≥9330 to dodge the live demo instance + sibling lanes),
// then captures two proof shots:
//
//   01-workflow-live   A live workflow card, minted by feeding the REAL wire
//                      shape (workflow.event frames from runtime commit
//                      dd29d8631) through the __dshOnWorkflowEvent seam — the
//                      same onWorkflowEvent path the live notification uses.
//                      The card wears the "live · workflow.event" chip.
//   02-feedback-tab    The inspector's 4th tab (Feedback) with a filled
//                      annotation (verdict + note + rubric dim) and the ✓
//                      marker painted on the source event's { } badge.
//
// Isolation follows the 2026-07-18 postmortem (qa-cdp-shoot-p0-inspector.mjs):
//   1. --user-data-dir=<tmp>   isolates Chromium userdata.
//   2. DSH_DESKTOP_HOME=<tmp>  isolates the main-process config root so we
//      never write into ~/.dsh-desktop (incl. the feedback-annotations.json
//      this lane writes).
//   3. Own CDP port (≥9330)    so we never attach to the user's live 9223.
// Electron binary comes from the PARENT repo (dsh-desktop-demo) per the brief.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync, statSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { tmpdir } from 'node:os'

const WORKTREE = resolve(process.env.DSH_WORKTREE || process.cwd())
const PARENT = resolve(process.env.DSH_REPO || '/Users/ziya/harness/dsh-desktop-demo')
const ELECTRON = join(PARENT, 'node_modules/.bin/electron')
const CDP_PORT = Number(process.env.DSH_WF_FEEDBACK_PORT || 9331)
const OUTDIR = join(WORKTREE, 'docs/qa-wf-feedback')

if (!existsSync(ELECTRON)) {
  console.error(`electron binary not found at ${ELECTRON}`)
  process.exit(2)
}
mkdirSync(OUTDIR, { recursive: true })

function seedHome(dshHome) {
  const seedOverlay = [
    '# QA wf-feedback-shoot seed overlay (tmp, per-run).',
    'plugins:',
    '  - "@cordisjs/plugin-include":',
    `      path: ${join(WORKTREE, 'config/daemon-echo.yml')}`,
    '',
  ].join('\n')
  writeFileSync(join(dshHome, 'user-overlay.cordis.yml'), seedOverlay)
  writeFileSync(join(dshHome, 'config.json'), JSON.stringify({ role: 'coding', approvalMode: 'never' }, null, 2))
  writeFileSync(join(dshHome, '.onboarded'), new Date().toISOString())
}

async function bootElectron(dshHome, userData, port) {
  const child = spawn(ELECTRON, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userData}`,
    '--disable-gpu',
    '--no-sandbox',
    '.',
  ], {
    cwd: WORKTREE,
    env: {
      ...process.env,
      DSH_DESKTOP_HOME: dshHome,
      DSH_MAXIMIZE: '1',
      DSH_QA: '1', // exposes window.__dshOnSessionEvent + __dshOnWorkflowEvent
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = []
  child.stdout.on('data', (d) => logs.push(String(d)))
  child.stderr.on('data', (d) => logs.push(String(d)))
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    try {
      const r = await fetch(`http://localhost:${port}/json/list`)
      if (r.ok) return { child, logs }
    } catch {}
  }
  child.kill('SIGKILL')
  console.error('electron CDP did not come up in 20s. logs:\n' + logs.join(''))
  process.exit(3)
}

async function newCdp(port) {
  const targets = await (await fetch(`http://localhost:${port}/json/list`)).json()
  const target = targets.find((t) => t.type === 'page')
  if (!target) throw new Error('no page target on port ' + port)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = (e) => err(e) })
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
  const call = (m, p = {}, ms = 20000) => new Promise((ok, err) => {
    const _id = id++
    const t = setTimeout(() => { pending.delete(_id); err(new Error('cdp timeout: ' + m)) }, ms)
    pending.set(_id, [(v) => { clearTimeout(t); ok(v) }, (e) => { clearTimeout(t); err(e) }])
    ws.send(JSON.stringify({ id: _id, method: m, params: p }))
  })
  const evj = async (expr) => {
    const r = await call('Runtime.evaluate', {
      expression: `(async()=>{try{return (${expr})}catch(e){return {__err:String(e)}}})()`,
      returnByValue: true, awaitPromise: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result?.value
  }
  return { ws, call, evj }
}

const SESSION_ID = 'qa-wf-feedback-sess'

// A minimal turn with a workflow tool/call so the live card has an anchor,
// plus the assistant bubble we'll annotate.
const TURN_EVENTS = [
  { type: 'turn/start', seq: 1, data: { turnId: 't0', trigger: 'user' } },
  { type: 'user/message', seq: 2, data: { text: 'Audit the three fs packages.' } },
  { type: 'tool/call', seq: 3, data: { callId: 'call-wf', name: 'workflow', arguments: { name: 'audit-flow', kind: 'seq' } } },
  { type: 'assistant/message', seq: 4, data: { content: [{ type: 'text', text: 'Kicking off the audit workflow across the three packages.' }], usage: { inputTokens: 210, outputTokens: 24, totalTokens: 234 } } },
  { type: 'turn/end', seq: 5, data: { turnId: 't0' } },
]

// The REAL workflow.event wire shape (runtime commit dd29d8631): incremental
// frames keyed by runId, meta{name,description}, per-kind payload. Named the
// same as the tool/call args so onWorkflowEvent anchors the card to the block.
const RUN_ID = 'run-audit-1'
const WF_META = { name: 'audit-flow', description: 'audit three fs packages' }
const WF_FRAMES = [
  { kind: 'workflow/start', runId: RUN_ID, meta: WF_META },
  { kind: 'workflow/phase', runId: RUN_ID, meta: WF_META, payload: 'Scan' },
  { kind: 'workflow/log', runId: RUN_ID, meta: WF_META, payload: 'starting with 3 packages' },
  { kind: 'workflow/agent-start', runId: RUN_ID, meta: WF_META, payload: { seq: 1, label: 'audit dsh-fs', phase: 'Scan', childId: 'c1' } },
  { kind: 'workflow/agent-end', runId: RUN_ID, meta: WF_META, payload: { seq: 1, label: 'audit dsh-fs', phase: 'Scan', childId: 'c1', outcome: 'completed' } },
  { kind: 'workflow/agent-start', runId: RUN_ID, meta: WF_META, payload: { seq: 2, label: 'audit dsh-bash', phase: 'Scan', childId: 'c2' } },
  { kind: 'workflow/agent-end', runId: RUN_ID, meta: WF_META, payload: { seq: 2, label: 'audit dsh-bash', phase: 'Scan', childId: 'c2', outcome: 'failed' } },
  { kind: 'workflow/agent-start', runId: RUN_ID, meta: WF_META, payload: { seq: 3, label: 'audit dsh-web', phase: 'Scan', childId: 'c3' } },
]

async function injectTurn(evj) {
  return evj(`
    (async () => {
      const dispatch = window.__dshOnSessionEvent
      const wf = window.__dshOnWorkflowEvent
      if (typeof dispatch !== 'function') return { err: 'no __dshOnSessionEvent seam (DSH_QA=1?)' }
      if (typeof wf !== 'function') return { err: 'no __dshOnWorkflowEvent seam (DSH_QA=1?)' }
      if (window.__dshTabs && typeof window.__dshTabs.switchTo === 'function') window.__dshTabs.switchTo('chat')
      // Clear the daemon-echo boot fixtures so our turn + live card is the only
      // content on the stream (auto-follow otherwise re-pins to the boot noise
      // and pushes our card below the fold — see qa-cdp-shoot-p0-inspector.mjs
      // note on the flex/min-height:0 container).
      const stream = document.getElementById('stream')
      if (stream) stream.innerHTML = ''
      for (const ev of ${JSON.stringify(TURN_EVENTS)}) dispatch('${SESSION_ID}', ev)
      // Feed the REAL wire frames through the live path.
      for (const f of ${JSON.stringify(WF_FRAMES)}) wf(f)
      return {
        ok: true,
        liveCards: document.querySelectorAll('.workflow-card-live').length,
        liveChip: document.querySelectorAll('.workflow-card-chip--live').length,
        steps: document.querySelectorAll('.workflow-card-live .workflow-step').length,
        toolBlocks: document.querySelectorAll('.tool-block[data-tool-name="workflow"]').length,
      }
    })()
  `)
}

async function screenshot(call, outName) {
  let shot = null
  let lastErr = null
  const attempts = [
    { format: 'png' }, { format: 'png' },
    { format: 'jpeg', quality: 82 }, { format: 'jpeg', quality: 82 },
  ]
  let usedFormat = 'png'
  for (const a of attempts) {
    try {
      shot = await call('Page.captureScreenshot', { ...a, captureBeyondViewport: false }, 25000)
      if (shot && shot.data) { usedFormat = a.format; break }
    } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 1200)) }
  }
  if (!shot || !shot.data) throw new Error('captureScreenshot failed for ' + outName + (lastErr ? ': ' + lastErr.message : ''))
  const finalName = usedFormat === 'jpeg' ? outName.replace(/\.png$/, '.jpg') : outName
  const outPath = join(OUTDIR, finalName)
  writeFileSync(outPath, Buffer.from(shot.data, 'base64'))
  const kb = Math.round(statSync(outPath).size / 1024)
  console.log(`  wrote ${outPath} (${kb} KB, ${usedFormat})`)
  if (kb < 20) console.warn(`  ⚠ ${outName} is only ${kb} KB (<20 KB) — likely a blank/trivial frame`)
  return { path: outPath, kb }
}

async function main() {
  const dshHome = join(tmpdir(), 'dsh-wf-feedback-home')
  const userData = join(tmpdir(), 'dsh-wf-feedback-userdata')
  for (const dir of [dshHome, userData]) {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
    mkdirSync(dir, { recursive: true })
  }
  seedHome(dshHome)
  console.log(`[wf-feedback] booting on CDP port ${CDP_PORT}`)
  const { child } = await bootElectron(dshHome, userData, CDP_PORT)
  const results = []
  try {
    await sleep(1500)
    const { call, evj } = await newCdp(CDP_PORT)
    await call('Page.enable')
    await call('Runtime.enable')

    // Let the daemon-echo scripted boot session finish streaming before we
    // inject — otherwise its late events re-append after our clear and
    // auto-follow pins to them, burying our card. Poll the status dot for
    // `idle` (bounded).
    for (let i = 0; i < 16; i++) {
      const st = await evj(`(document.querySelector('#status-text')||{}).textContent||''`)
      if (String(st).toLowerCase().includes('idle')) break
      await sleep(500)
    }
    await sleep(600)

    const injected = await injectTurn(evj)
    console.log('  injected:', JSON.stringify(injected))
    if (!injected || !injected.ok) throw new Error('turn injection failed: ' + JSON.stringify(injected))
    if (!injected.liveCards) console.warn('  ⚠ no live workflow card minted — the seam may not be wired')
    await sleep(400)

    // --- 01: the live workflow card (live chip + steps) ---
    // Re-clear + re-inject atomically right before capture so the daemon-echo
    // scripted session (which keeps re-rendering the stream) can't bury the
    // card between inject and shot, then scroll it into view.
    const scrolled = await evj(`
      (() => {
        const dispatch = window.__dshOnSessionEvent
        const wf = window.__dshOnWorkflowEvent
        const stream = document.getElementById('stream')
        if (stream) stream.innerHTML = ''
        for (const ev of ${JSON.stringify(TURN_EVENTS)}) dispatch('${SESSION_ID}', ev)
        for (const f of ${JSON.stringify(WF_FRAMES)}) wf(f)
        const card = document.querySelector('.workflow-card-live')
        if (!card) return { err: 'no live card to scroll to' }
        if (card.scrollIntoView) card.scrollIntoView({ block: 'center' })
        const chip = card.querySelector('.workflow-card-chip--live')
        return { chip: chip ? chip.textContent : null, steps: card.querySelectorAll('.workflow-step').length }
      })()
    `)
    console.log('  01 scroll:', JSON.stringify(scrolled))
    await sleep(150)
    results.push(await screenshot(call, '01-workflow-live.png'))

    // --- 02: inspector Feedback tab, filled annotation + ✓ marker ---
    const fb = await evj(`
      (async () => {
        const ins = window.__dshInspector
        if (!ins) return { err: 'no __dshInspector' }
        // Open the inspector on the assistant event, Feedback tab.
        const ev = { type: 'assistant/message', seq: 4, time: Date.now(),
          data: { content: [{ type: 'text', text: 'Kicking off the audit workflow across the three packages.' }] } }
        ins.open({ event: ev, tab: 'feedback', sessionId: '${SESSION_ID}' })
        const drawer = document.getElementById('inspector-drawer')
        const panel = drawer.querySelector('.inspector-panel[data-panel="feedback"]')
        // Fill: thumbs-up, a note, a rubric dim, then Save.
        const up = panel.querySelector('[aria-label="Thumbs up"]')
        if (up) up.click()
        const note = panel.querySelector('.inspector-feedback-note-input')
        if (note) note.value = 'Good — kicked off the right workflow for the audit.'
        const sel = panel.querySelector('.inspector-feedback-dim-select')
        if (sel && sel.options && sel.options.length > 1) sel.value = sel.options[1].value
        const save = panel.querySelector('.inspector-feedback-save')
        if (save) save.click()
        await new Promise(r => setTimeout(r, 350))
        // Attach a badge on a stream bubble so the ✓ marker is visible, then
        // refresh markers so the annotated (sessionId, seq) paints.
        if (typeof ins.refreshInspectMarkers === 'function') ins.refreshInspectMarkers()
        return {
          open: drawer.classList.contains('open'),
          verdictActive: !!panel.querySelector('.inspector-feedback-thumb.active'),
          status: (panel.querySelector('.inspector-feedback-status') || {}).textContent,
          markedBadges: document.querySelectorAll('.inspect-badge-annotated').length,
        }
      })()
    `)
    console.log('  02 feedback:', JSON.stringify(fb))
    if (!fb || fb.open !== true) console.warn('  ⚠ Feedback tab did not open:', JSON.stringify(fb))
    await sleep(250)
    results.push(await screenshot(call, '02-feedback-tab.png'))

    // Confirm the annotation actually persisted to the isolated home file.
    let persisted = null
    try {
      const p = join(dshHome, 'feedback-annotations.json')
      persisted = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
    } catch (e) { persisted = { __err: String(e) } }
    console.log('  persisted annotations:', JSON.stringify(persisted))

    console.log('\n--- SUMMARY ---')
    console.log('inject :', JSON.stringify(injected))
    console.log('02     :', JSON.stringify(fb))
    console.log('persist:', JSON.stringify(persisted))
    for (const r of results) console.log(`shot   : ${r.path} (${r.kb} KB)`)
  } finally {
    try { child.kill('SIGKILL') } catch {}
    for (let i = 0; i < 6; i++) {
      await sleep(500)
      try { await fetch(`http://localhost:${CDP_PORT}/json/list`) } catch { break }
    }
  }
  process.exit(0)
}

main().catch((err) => { console.error(err); process.exit(1) })
