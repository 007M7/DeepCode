// QA verification script for lane-cordis-card. Boots an isolated Electron on
// its own CDP port, drives the cordis dedicated card + the upgraded
// code-dispatch nested tree entirely through the renderer's
// `window.__dshRenderer.onSessionEvent` seam (no live model / no key), and
// captures three screenshots into docs/qa-cordis-card/:
//
//   01-mount-card.png       — cordis_mount card: op glyph + id + kv block
//                             (id/name/state) + ＋dyn-1 add-delta + source fold.
//   02-inspect-fields.png   — cordis_inspect card: the six sections rendered
//                             through the reused Fields-tree widget.
//   03-code-dispatch-open.png — a run_code block with three fan-out sub-call
//                             rows, the first row expanded to show its args +
//                             result blocks, and the { } inspector badge.
//
// Isolation follows the 2026-07-18 postmortem baked into the sibling shoots
// (scripts/qa-cdp-shoot-msg-queue.mjs / nav-optional):
//   1. --user-data-dir=<tmp>   isolates Chromium userdata.
//   2. DSH_DESKTOP_HOME=<tmp>  isolates the main-process config root.
//   3. own CDP port (≥9310)    so a lingering Electron helper from another
//      lane's shoot can't hijack our DevTools endpoint.
//
// Why the seam and not a real Vibe run: the cordis card + code-dispatch tree
// are pure renderer concerns (parse the tool's own text / fan-out rows). We
// inject the REAL wire shapes from test/fixtures/cordis-wire-shapes.json
// through onSessionEvent — the exact path the live wire uses — so the render
// is deterministic with no daemon round-trip and no model key.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { tmpdir } from 'node:os'

const WORKTREE = resolve(process.env.DSH_WORKTREE || process.cwd())
const PARENT = resolve(process.env.DSH_REPO || '/Users/ziya/harness/dsh-desktop-demo')
const ELECTRON = join(PARENT, 'node_modules/.bin/electron')
const CDP_PORT = Number(process.env.DSH_CORDIS_PORT || 9310)
const OUTDIR = join(WORKTREE, 'docs/qa-cordis-card')
const FIX = JSON.parse(readFileSync(join(WORKTREE, 'test/fixtures/cordis-wire-shapes.json'), 'utf8'))

if (!existsSync(ELECTRON)) {
  console.error(`electron binary not found at ${ELECTRON}`)
  process.exit(2)
}
mkdirSync(OUTDIR, { recursive: true })

function seedHome(dshHome) {
  const seedOverlay = [
    '# QA cordis-card shoot seed overlay (tmp, per-run).',
    'plugins:',
    `  - "@cordisjs/plugin-include":`,
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
    env: { ...process.env, DSH_DESKTOP_HOME: dshHome, DSH_MAXIMIZE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = []
  child.stdout.on('data', d => logs.push(String(d)))
  child.stderr.on('data', d => logs.push(String(d)))
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
  const target = targets.find(t => t.type === 'page')
  if (!target) throw new Error('no page target on port ' + port)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = e => err(e) })
  let id = 1
  const pending = new Map()
  ws.onmessage = ev => {
    const data = typeof ev.data === 'string' ? ev.data : String(ev.data)
    let msg
    try { msg = JSON.parse(data) } catch { return }
    if (msg.id != null && pending.has(msg.id)) {
      const [ok, err] = pending.get(msg.id); pending.delete(msg.id)
      if (msg.error) err(new Error(msg.error.message)); else ok(msg.result)
    }
  }
  const call = (m, p = {}, ms = 15000) => new Promise((ok, err) => {
    const _id = id++
    const t = setTimeout(() => { pending.delete(_id); err(new Error('cdp timeout: ' + m)) }, ms)
    pending.set(_id, [v => { clearTimeout(t); ok(v) }, e => { clearTimeout(t); err(e) }])
    ws.send(JSON.stringify({ id: _id, method: m, params: p }))
  })
  const evj = async expr => {
    const r = await call('Runtime.evaluate', {
      expression: `(async()=>{try{return (${expr})}catch(e){return {__err:String(e)}}})()`,
      returnByValue: true, awaitPromise: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result?.value
  }
  return { ws, call, evj }
}

// Clip to the chat stream so the cards are unmistakably in frame.
async function shoot(call, evj, name) {
  const clip = await evj(`
    (() => {
      const s = document.getElementById('stream')
      if (!s) return null
      const r = s.getBoundingClientRect()
      return { x: r.x, y: Math.max(0, r.y), width: r.width, height: Math.min(r.height, 900), scale: 1 }
    })()
  `)
  const shotArgs = { format: 'png', captureBeyondViewport: true }
  if (clip) shotArgs.clip = clip
  const shot = await call('Page.captureScreenshot', shotArgs, 30000)
  if (!shot || !shot.data) throw new Error('captureScreenshot returned no data')
  const outPath = join(OUTDIR, name)
  writeFileSync(outPath, Buffer.from(shot.data, 'base64'))
  const bytes = statSync(outPath).size
  console.log(`  wrote ${outPath} (${bytes} bytes)`)
  if (bytes < 20000) throw new Error(`screenshot ${name} is only ${bytes} bytes (<20KB) — likely blank`)
  return { path: outPath, bytes }
}

// Inject a call+result pair for a cordis tool through onSessionEvent.
function injectPairExpr(sid, pair) {
  return `
    (() => {
      const R = window.__dshRenderer
      R.onSessionEvent(${JSON.stringify(sid)}, ${JSON.stringify(pair.call)})
      R.onSessionEvent(${JSON.stringify(sid)}, ${JSON.stringify(pair.result)})
      return true
    })()
  `
}

// Open the tool-block that hosts a given cordis op + scroll it into view so
// the card body (not the collapsed summary) fills the shot. For inspect, also
// expand the first section in the reused Fields tree so the list reads richly.
async function openCordisBlock(evj, op) {
  return evj(`
    (() => {
      const card = document.querySelector('.card-cordis[data-cordis-op="${op}"]')
      if (!card) return { opened: false }
      const block = card.closest ? card.closest('.tool-block') : null
      if (block) block.open = true
      // Expand the first Fields-tree section for inspect so it isn't all folded.
      const firstBranch = card.querySelector('.card-cordis-tree .trace-detail-json-branch')
      if (firstBranch) firstBranch.open = true
      ;(block || card).scrollIntoView({ block: 'center' })
      return { opened: true }
    })()
  `)
}

async function main() {
  const dshHome = join(tmpdir(), 'dsh-cordis-home')
  const userData = join(tmpdir(), 'dsh-cordis-userdata')
  for (const dir of [dshHome, userData]) {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
    mkdirSync(dir, { recursive: true })
  }
  seedHome(dshHome)
  console.log(`booting on CDP :${CDP_PORT}`)
  const { child } = await bootElectron(dshHome, userData, CDP_PORT)
  try {
    await sleep(1500)
    const { call, evj } = await newCdp(CDP_PORT)
    await call('Page.enable')

    // Fresh session for the cordis cards.
    const setup = await evj(`
      (async () => {
        const R = window.__dshRenderer
        if (!R) return { __err: 'no __dshRenderer seam' }
        if (!window.__dshCordisCard) return { __err: 'no __dshCordisCard module' }
        R.ensureSession('qa-cordis', { title: 'Cordis card demo', header: {}, hasUserMessage: true })
        await R.selectSession('qa-cordis')
        return { active: R.getActiveSessionId() }
      })()
    `)
    console.log('  setup:', JSON.stringify(setup))
    if (setup && setup.__err) throw new Error(setup.__err)

    // --- Shot 1: mount card -------------------------------------------------
    const mountOk = await evj(injectPairExpr('qa-cordis', FIX.mount_ok))
    if (mountOk && mountOk.__err) throw new Error(mountOk.__err)
    const mountCheck = await evj(`
      (() => {
        const c = document.querySelector('.card-cordis[data-cordis-op="cordis_mount"]')
        if (!c) return { found: false }
        return {
          found: true,
          id: (c.querySelector('.card-cordis-id') || {}).textContent || '',
          kvKeys: Array.from(c.querySelectorAll('.card-cordis-kv-key')).map(n => n.textContent),
          delta: !!c.querySelector('.card-cordis-delta.add'),
          codeFold: !!c.querySelector('.card-cordis-code'),
        }
      })()
    `)
    console.log('  mount card:', JSON.stringify(mountCheck))
    if (!mountCheck.found || mountCheck.id !== 'dyn-1' || !mountCheck.delta) {
      throw new Error('mount card missing expected shape: ' + JSON.stringify(mountCheck))
    }
    // Open the enclosing tool-block + scroll it into view so the card body
    // (not just the collapsed summary) is unmistakably in frame.
    await openCordisBlock(evj, 'cordis_mount')
    await sleep(250)
    const shot1 = await shoot(call, evj, '01-mount-card.png')

    // --- Shot 2: inspect card with fields tree ------------------------------
    const inspectOk = await evj(injectPairExpr('qa-cordis', FIX.inspect_all))
    if (inspectOk && inspectOk.__err) throw new Error(inspectOk.__err)
    const inspectCheck = await evj(`
      (() => {
        const c = document.querySelector('.card-cordis[data-cordis-op="cordis_inspect"]')
        if (!c) return { found: false }
        const tree = c.querySelector('.card-cordis-tree .trace-detail-json-tree')
        return {
          found: true,
          hasTree: !!tree,
          sections: tree ? Array.from(tree.querySelectorAll('.trace-detail-json-key')).map(n => n.textContent) : [],
        }
      })()
    `)
    console.log('  inspect card:', JSON.stringify(inspectCheck))
    if (!inspectCheck.found || !inspectCheck.hasTree) {
      throw new Error('inspect card missing fields tree: ' + JSON.stringify(inspectCheck))
    }
    await openCordisBlock(evj, 'cordis_inspect')
    await sleep(250)
    const shot2 = await shoot(call, evj, '02-inspect-fields.png')

    // --- Shot 3: code-dispatch nested tree, first row expanded --------------
    const cd = FIX.code_dispatch_run
    const dispatchInject = await evj(`
      (() => {
        const R = window.__dshRenderer
        const sid = 'qa-cordis'
        // Order matches mock-fixtures.mockCodeDispatch: the parent call+result
        // land first (the result populates the .result box), THEN each
        // tool/code-dispatch appends into it. Firing dispatches before the
        // result would let the generic tool/result branch overwrite the box.
        R.onSessionEvent(sid, ${JSON.stringify(cd.parent_call)})
        R.onSessionEvent(sid, ${JSON.stringify(cd.parent_result)})
        ${cd.dispatches.map(d => `R.onSessionEvent(sid, ${JSON.stringify(d)})`).join('\n        ')}
        // Expand the first sub-call row so the args + result blocks show.
        const parent = document.querySelector('.tool-block[data-call-id="run-code-1"]')
        const firstRow = parent && parent.querySelector('.card-code-dispatch-row')
        if (firstRow) firstRow.open = true
        return {
          rows: parent ? parent.querySelectorAll('.card-code-dispatch-row').length : 0,
          firstOpen: firstRow ? !!firstRow.open : false,
          badges: parent ? parent.querySelectorAll('.card-code-dispatch-summary-line .inspect-badge').length : 0,
          detailBlocks: firstRow ? firstRow.querySelectorAll('.card-code-dispatch-detail-block').length : 0,
        }
      })()
    `)
    console.log('  code-dispatch:', JSON.stringify(dispatchInject))
    if (!dispatchInject || dispatchInject.rows !== 3 || !dispatchInject.firstOpen || dispatchInject.badges !== 3) {
      throw new Error('code-dispatch tree missing expected shape: ' + JSON.stringify(dispatchInject))
    }
    // Scroll the run_code block into view before shooting.
    await evj(`
      (() => {
        const p = document.querySelector('.tool-block[data-call-id="run-code-1"]')
        if (p) { p.open = true; p.scrollIntoView({ block: 'center' }) }
        return true
      })()
    `)
    await sleep(300)
    const shot3 = await shoot(call, evj, '03-code-dispatch-open.png')

    console.log('\n--- SUMMARY ---')
    console.log(`mount card:        ${shot1.path} (${shot1.bytes} bytes)`)
    console.log(`inspect fields:    ${shot2.path} (${shot2.bytes} bytes)`)
    console.log(`code-dispatch open:${shot3.path} (${shot3.bytes} bytes)`)
  } finally {
    try { child.kill('SIGKILL') } catch {}
    for (let i = 0; i < 20; i++) {
      await sleep(500)
      try { await fetch(`http://localhost:${CDP_PORT}/json/list`) } catch { break }
    }
  }
}

main().catch(err => { console.error(err); process.exit(1) }).then(() => process.exit(0))
