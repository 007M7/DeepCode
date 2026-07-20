// QA verification script for lane-p0-inspector. Boots an isolated Electron on
// a private CDP port (≥9280 to dodge the live demo instance on 9223), mints a
// conversation with user + assistant + reasoning + tool events through the
// DSH_QA=1 direct-dispatch seam (window.__dshOnSessionEvent), then drives the
// unified Inspector and captures four proof shots:
//
//   01-pretty-assistant  Inspector open on an assistant bubble, Pretty tab
//   02-raw-tool          Raw tab on a tool call (verbatim session.event)
//   03-json-tree         JSON tab showing the recursive Fields tree
//   04-scroll-chip       "↓ 回到底部" chip visible after scrolling up mid-stream
//
// Isolation follows the 2026-07-18 postmortem (scripts/qa-cdp-shoot-affordance
// .mjs / qa-cdp-shoot-nav-optional.mjs):
//   1. --user-data-dir=<tmp>   isolates Chromium userdata.
//   2. DSH_DESKTOP_HOME=<tmp>  isolates the main-process config root so we
//      never write into ~/.dsh-desktop.
//   3. Own CDP port           so we never attach to the user's live 9223.
// Electron binary comes from the PARENT repo (dsh-desktop-demo) per the brief.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { tmpdir } from 'node:os'

const WORKTREE = resolve(process.env.DSH_WORKTREE || process.cwd())
const PARENT = resolve(process.env.DSH_REPO || '/Users/ziya/harness/dsh-desktop-demo')
const ELECTRON = join(PARENT, 'node_modules/.bin/electron')
const CDP_PORT = Number(process.env.DSH_INSPECTOR_PORT || 9281)
const OUTDIR = join(WORKTREE, 'docs/qa-p0-inspector')

if (!existsSync(ELECTRON)) {
  console.error(`electron binary not found at ${ELECTRON}`)
  process.exit(2)
}
mkdirSync(OUTDIR, { recursive: true })

function seedHome(dshHome) {
  const seedOverlay = [
    '# QA p0-inspector-shoot seed overlay (tmp, per-run).',
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
      DSH_QA: '1', // exposes window.__dshOnSessionEvent + the Debug popover
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

// The synthetic turn we inject. seq numbers are monotonic so the inspector's
// data-seq → cachedEvents lookup resolves each bubble to its source event.
const SESSION_ID = 'qa-inspector-sess'
const TURN_EVENTS = [
  { type: 'turn/start', seq: 1, data: { turnId: 't0', trigger: 'user' } },
  { type: 'user/message', seq: 2, data: { text: 'Read package.json and tell me the version.' } },
  { type: 'assistant/chunk', seq: 3, data: { chunk: { type: 'reasoning-delta', text: 'The user wants the version field. I should read package.json first, then parse the JSON and report the "version" key. Let me call the read tool on package.json.' } } },
  { type: 'assistant/chunk', seq: 4, data: { chunk: { type: 'text-delta', text: 'Let me read package.json.' } } },
  { type: 'tool/call', seq: 5, data: { callId: 'call-1', name: 'read', arguments: { path: 'package.json', limit: 40 } } },
  { type: 'tool/result', seq: 6, data: { callId: 'call-1', isError: false, durationMs: 8, content: '{\n  "name": "dsh-desktop-demo",\n  "version": "0.4.2"\n}\n' } },
  { type: 'assistant/message', seq: 7, data: { content: [{ type: 'text', text: 'The version is 0.4.2 (from package.json).' }], usage: { inputTokens: 812, outputTokens: 46, totalTokens: 858 } } },
  { type: 'turn/end', seq: 8, data: { turnId: 't0' } },
]

async function injectTurn(evj) {
  const res = await evj(`
    (async () => {
      const dispatch = window.__dshOnSessionEvent
      if (typeof dispatch !== 'function') return { err: 'no __dshOnSessionEvent seam (DSH_QA=1?)' }
      if (window.__dshTabs && typeof window.__dshTabs.switchTo === 'function') window.__dshTabs.switchTo('chat')
      const events = ${JSON.stringify(TURN_EVENTS)}
      for (const ev of events) dispatch('${SESSION_ID}', ev)
      // report what actually landed in the DOM
      return {
        ok: true,
        userBubbles: document.querySelectorAll('.msg.user').length,
        asstBubbles: document.querySelectorAll('.msg.assistant').length,
        reasoning: document.querySelectorAll('.reasoning-block').length,
        toolBlocks: document.querySelectorAll('.tool-block').length,
        inspectBadges: document.querySelectorAll('.inspect-badge').length,
      }
    })()
  `)
  return res
}

async function screenshot(call, outName) {
  // captureBeyondViewport:false — we only ever need the visible frame (the
  // Inspector drawer + the chat viewport). Capturing beyond-viewport on the
  // tall padded stream (step 04) forces a giant full-page raster that times
  // out the throttled QA GPU. The visible frame carries every feature we
  // assert.
  // Retry: captureScreenshot occasionally times out when the QA GPU is
  // saturated (many Electron boots in a row). Retry a couple times before
  // giving up rather than failing the whole shoot on one slow frame. Shorter
  // per-attempt timeout (25s) so a hung frame fails fast and retries instead
  // of blocking 60s×3. PNG preferred; if every PNG attempt stalls we fall back
  // to JPEG, which is far cheaper to encode on a starved software rasterizer.
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
  // Keep the .png name even for a jpeg fallback body? No — write the honest
  // extension so the bytes match the name.
  const finalName = usedFormat === 'jpeg' ? outName.replace(/\.png$/, '.jpg') : outName
  const outPath = join(OUTDIR, finalName)
  writeFileSync(outPath, Buffer.from(shot.data, 'base64'))
  const kb = Math.round(statSync(outPath).size / 1024)
  console.log(`  wrote ${outPath} (${kb} KB, ${usedFormat})`)
  if (kb < 20) console.warn(`  ⚠ ${outName} is only ${kb} KB (<20 KB) — likely a blank/trivial frame`)
  return { path: outPath, kb }
}

async function main() {
  const dshHome = join(tmpdir(), 'dsh-p0-inspector-home')
  const userData = join(tmpdir(), 'dsh-p0-inspector-userdata')
  for (const dir of [dshHome, userData]) {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
    mkdirSync(dir, { recursive: true })
  }
  seedHome(dshHome)
  console.log(`[p0-inspector] booting on CDP port ${CDP_PORT}`)
  const { child } = await bootElectron(dshHome, userData, CDP_PORT)
  const results = []
  try {
    await sleep(1500)
    const { call, evj } = await newCdp(CDP_PORT)
    await call('Page.enable')
    await call('Runtime.enable')

    const injected = await injectTurn(evj)
    console.log('  injected:', JSON.stringify(injected))
    if (!injected || !injected.ok) throw new Error('turn injection failed: ' + JSON.stringify(injected))
    await sleep(500)

    // --- 01: Inspector on an assistant bubble, Pretty tab ---
    const openAsst = await evj(`
      (() => {
        const ins = window.__dshInspector
        const ev = { type: 'assistant/message', seq: 7, time: Date.now(),
          data: { content: [{ type: 'text', text: 'The version is 0.4.2 (from package.json).' }],
                  usage: { inputTokens: 812, outputTokens: 46, totalTokens: 858 } } }
        ins.open({ event: ev, tab: 'pretty' })
        const drawer = document.getElementById('inspector-drawer')
        return { open: drawer.classList.contains('open'),
                 title: (drawer.querySelector('.inspector-drawer-title')||{}).textContent,
                 hasUsage: !!drawer.querySelector('.inspector-meta-chip') }
      })()
    `)
    console.log('  01 pretty/assistant:', JSON.stringify(openAsst))
    await sleep(300)
    results.push(await screenshot(call, '01-pretty-assistant.png'))

    // --- 02: Raw tab on the tool call (verbatim session.event) ---
    const openRaw = await evj(`
      (() => {
        const ins = window.__dshInspector
        const ev = ${JSON.stringify(TURN_EVENTS[4])}  // the tool/call event
        ins.open({ event: ev, tab: 'raw' })
        const drawer = document.getElementById('inspector-drawer')
        const pre = drawer.querySelector('.inspector-raw-pre')
        return { tab: 'raw', headHasSeq: /seq 5/.test((drawer.querySelector('.inspector-raw-head-label')||{}).textContent||''),
                 preHasName: /"name": "read"/.test((pre||{}).textContent||'') }
      })()
    `)
    console.log('  02 raw/tool:', JSON.stringify(openRaw))
    await sleep(300)
    results.push(await screenshot(call, '02-raw-tool.png'))

    // --- 03: JSON tab (recursive Fields tree) ---
    const openJson = await evj(`
      (() => {
        const ins = window.__dshInspector
        const ev = ${JSON.stringify(TURN_EVENTS[5])}  // the tool/result event (nested content)
        ins.open({ event: ev, tab: 'json' })
        const drawer = document.getElementById('inspector-drawer')
        return { tab: 'json',
                 hasTree: !!drawer.querySelector('.trace-detail-json-tree'),
                 branchNodes: drawer.querySelectorAll('.trace-detail-json-node').length }
      })()
    `)
    console.log('  03 json/tree:', JSON.stringify(openJson))
    await sleep(300)
    results.push(await screenshot(call, '03-json-tree.png'))

    // --- 04: scroll-detached "back to bottom" chip ---
    // Under CDP the stream can't be scrolled for real (programmatic scrollTop
    // resets on this flex container; synthetic wheel events don't hit-test
    // through the offscreen GPU). So we drive the REAL follow controller via
    // the DSH_QA=1 seam (window.__dshQaFollow): detach() feeds "reader scrolled
    // up 400px" into the same controller the scroll listener uses, then each
    // reasoning-delta's followStream() → onContent() fires while detached →
    // the real chip element flips visible. This exercises the shipping logic,
    // not a faked class toggle.
    const chip = await evj(`
      (async () => {
        const ins = window.__dshInspector; if (ins) ins.close()
        const dispatch = window.__dshOnSessionEvent
        const qf = window.__dshQaFollow
        if (!qf) return { err: 'no __dshQaFollow seam (DSH_QA=1?)' }
        // A few tall turns so the composer/stream look like a real session
        // behind the chip (not strictly required — the chip is controller-
        // driven — but it makes the shot legible).
        for (let t = 1; t <= 6; t++) {
          dispatch('${SESSION_ID}', { type: 'turn/start', seq: 1000+t*10, data: { turnId: 'p'+t, trigger: 'user' } })
          dispatch('${SESSION_ID}', { type: 'user/message', seq: 1001+t*10, data: { text: 'Padding message '+t+'.' } })
          dispatch('${SESSION_ID}', { type: 'assistant/message', seq: 1002+t*10, data: { content: [{ type:'text', text: 'Reply '+t+'. '.repeat(12) }] } })
          dispatch('${SESSION_ID}', { type: 'turn/end', seq: 1003+t*10, data: { turnId: 'p'+t } })
        }
        // Open the final turn + streaming bubble (while pinned).
        dispatch('${SESSION_ID}', { type: 'turn/start', seq: 2000, data: { turnId: 'tx', trigger: 'user' } })
        dispatch('${SESSION_ID}', { type: 'user/message', seq: 2001, data: { text: 'One more, while scrolled up.' } })
        dispatch('${SESSION_ID}', { type: 'assistant/chunk', seq: 2002, data: { chunk: { type: 'reasoning-delta', text: 'Opening the reasoning block while pinned. ' } } })
        await new Promise(r => setTimeout(r, 200))
        // Detach: tell the controller the reader scrolled 400px up.
        const d = qf.detach(400)
        // Stream reasoning deltas → followStream() → onContent() while detached.
        // Stop as soon as the chip is visible and hold it there (don't stream
        // extra deltas — under the seam the real streamEl is still at the
        // bottom, so a later stray scroll event would re-pin and hide the chip;
        // that re-pin is a seam artifact, not a real-app path where the element
        // is genuinely scrolled up).
        const trace = []
        let shown = false
        for (let i = 1; i <= 4 && !shown; i++) {
          dispatch('${SESSION_ID}', { type: 'assistant/chunk', seq: 2002+i, data: { chunk: { type: 'reasoning-delta', text: 'Streaming chunk '+i+' while the reader is scrolled up — the chip should appear now. ' } } })
          await new Promise(r => setTimeout(r, 60))
          const el0 = document.getElementById('stream-scroll-chip')
          const vis = !!(el0 && !el0.hidden)
          trace.push({ i, chip: vis })
          if (vis) shown = true
        }
        const el = document.getElementById('stream-scroll-chip')
        return { chipExists: !!el, chipVisible: !!(el && !el.hidden), detach: d, trace,
                 pinned: qf.isPinned() }
      })()
    `)
    console.log('  04 scroll-chip:', JSON.stringify(chip))
    if (!chip || chip.chipVisible !== true) {
      console.warn('  ⚠ step-04 chip not visible — shot will not show the feature:', JSON.stringify(chip))
    }
    await sleep(150)
    results.push(await screenshot(call, '04-scroll-chip.png'))

    console.log('\n--- SUMMARY ---')
    console.log('inject :', JSON.stringify(injected))
    console.log('01     :', JSON.stringify(openAsst))
    console.log('02     :', JSON.stringify(openRaw))
    console.log('03     :', JSON.stringify(openJson))
    console.log('04     :', JSON.stringify(chip))
    for (const r of results) console.log(`shot   : ${r.path} (${r.kb} KB)`)
  } finally {
    try { child.kill('SIGKILL') } catch {}
    // Best-effort: give the port a moment to free. Electron helper procs can
    // linger and hold the debug port, so we cap the wait short and then
    // hard-exit rather than block the caller (the shots are already written).
    for (let i = 0; i < 6; i++) {
      await sleep(500)
      try { await fetch(`http://localhost:${CDP_PORT}/json/list`) } catch { break }
    }
  }
  // Force exit so a lingering Electron helper holding the CDP socket can't keep
  // the node event loop alive past the work.
  process.exit(0)
}

main().catch((err) => { console.error(err); process.exit(1) })
