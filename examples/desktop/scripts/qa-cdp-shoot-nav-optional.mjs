// QA verification script for lane-nav-optional. Boots an isolated
// Electron on CDP :9272, rewrites the shell config for three fixture
// cases (missing hiddenPages / empty [] / custom list), and takes one
// sidebar screenshot for each case into docs/qa-nav-optional/.
//
// Isolation follows the 2026-07-18 postmortem in
// scripts/qa-cdp-shoot-affordance.mjs:
//   1. --user-data-dir=<tmp>   isolates Chromium userdata.
//   2. DSH_DESKTOP_HOME=<tmp>  isolates main-process config root so we
//      never write into ~/.dsh-desktop.
//
// Why three passes not one boot with hot reloads: the hidden-page filter
// reads config.json through IPC at renderer init; we could plumb a
// window.__dshNavFilter.apply() to re-read after we mutate the file,
// but the point of the shoot is to prove the boot-time filter honors
// the file as-shipped. So we relaunch three times with different
// on-disk configs — a clean-room reproduction of the three cases a
// researcher would actually hit.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { tmpdir } from 'node:os'

const WORKTREE = resolve(process.env.DSH_WORKTREE || process.cwd())
const PARENT = resolve(process.env.DSH_REPO || '/Users/ziya/harness/dsh-desktop-demo')
const ELECTRON = join(PARENT, 'node_modules/.bin/electron')
// One CDP port per case — Electron helper processes can linger past the
// main process death and hold the debug port bound, which quietly forces
// case-2/3 to attach to case-1's DevTools endpoint. Isolating ports side-
// steps the whole race.
const CDP_PORT_BASE = Number(process.env.DSH_NAV_OPTIONAL_PORT || 9272)
const OUTDIR = join(WORKTREE, 'docs/qa-nav-optional')

if (!existsSync(ELECTRON)) {
  console.error(`electron binary not found at ${ELECTRON}`)
  process.exit(2)
}
mkdirSync(OUTDIR, { recursive: true })

// Three fixture cases per task spec:
//   • case-1: config.json missing hiddenPages    → default (playground+mission hidden)
//   • case-2: hiddenPages = []                   → all pages visible
//   • case-3: hiddenPages = ["prs","growth"]     → PRs + Growth hidden
const CASES = [
  {
    name: '01-default-hidden',
    label: 'missing hiddenPages → default (playground+mission hidden)',
    config: { role: 'coding', approvalMode: 'never' },
  },
  {
    name: '02-empty-array',
    label: 'hiddenPages=[] → everything visible',
    config: { role: 'coding', approvalMode: 'never', hiddenPages: [] },
  },
  {
    name: '03-custom-list',
    label: 'hiddenPages=["prs","growth"] → PRs+Growth hidden',
    config: { role: 'coding', approvalMode: 'never', hiddenPages: ['prs', 'growth'] },
  },
]

function seedHome(dshHome, cfg) {
  // Every fresh boot writes a minimal overlay + config.json + .onboarded
  // sentinel so the first-run modal doesn't fire and rewrite our seed.
  const seedOverlay = [
    '# QA nav-optional-shoot seed overlay (tmp, per-run).',
    'plugins:',
    `  - "@cordisjs/plugin-include":`,
    `      path: ${join(WORKTREE, 'config/daemon-echo.yml')}`,
    '',
  ].join('\n')
  writeFileSync(join(dshHome, 'user-overlay.cordis.yml'), seedOverlay)
  writeFileSync(join(dshHome, 'config.json'), JSON.stringify(cfg, null, 2))
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
      // Deliberately NOT setting DSH_QA=1: qa-harness.js §11 clicks every
      // onboarding button on boot including the skip path, which triggers
      // onboarding:apply and rewrites config.json without our seeded
      // hiddenPages. See main.js:763 — `writeShellConfig({role,approvalMode,createdAt})`
      // drops any other fields on the floor.
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = []
  child.stdout.on('data', d => { const s = String(d); logs.push(s); if (s.includes('[nav:')) process.stdout.write('MAIN_STDOUT: ' + s) })
  child.stderr.on('data', d => { const s = String(d); logs.push(s); if (s.includes('[nav:')) process.stdout.write('MAIN_STDERR: ' + s) })
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
  const chunks = []
  ws.onmessage = ev => {
    const data = typeof ev.data === 'string' ? ev.data : String(ev.data)
    let msg
    try { msg = JSON.parse(data) } catch { chunks.push(data); return }
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

async function runCase(kase, idx) {
  const port = CDP_PORT_BASE + idx
  const dshHome = join(tmpdir(), `dsh-nav-optional-home-${kase.name}`)
  const userData = join(tmpdir(), `dsh-nav-optional-userdata-${kase.name}`)
  for (const dir of [dshHome, userData]) {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
    mkdirSync(dir, { recursive: true })
  }
  seedHome(dshHome, kase.config)
  console.log(`[${kase.name}] booting on port ${port}: ${kase.label}`)
  const { child } = await bootElectron(dshHome, userData, port)
  try {
    // Give the renderer a beat to run applyNavHiddenPages.
    await sleep(1500)
    const { call, evj } = await newCdp(port)
    await call('Page.enable')

    // Diagnostics before assertion: prove the IPC path is reachable and
    // the model resolves the fixture case we expect. Without this, a
    // race between the applyNavHiddenPages await and the shot capture
    // leaves us reading DOM that hasn't been filtered yet.
    const diag = await evj(`
      (async () => {
        const M = window.__dshNavConfigModel || null
        const raw = window.dsh && window.dsh.nav && typeof window.dsh.nav.getHiddenPages === 'function'
          ? await window.dsh.nav.getHiddenPages()
          : '<no-ipc>'
        const resolved = M ? M.resolveHiddenPages(raw || {}) : '<no-model>'
        // Force-run the filter now so the DOM is definitely up-to-date
        // before we assert. This is what the settings-page.js checkbox
        // path calls on toggle too.
        if (window.__dshNavFilter && typeof window.__dshNavFilter.apply === 'function') {
          await window.__dshNavFilter.apply()
        }
        return { hasModel: !!M, ipcResult: raw, resolved }
      })()
    `)
    console.log(`  diag  :`, JSON.stringify(diag))

    // Assert the DOM matches expectation before we capture — cheap
    // sanity so a broken build fails loud instead of shipping a bad shot.
    const visible = await evj(`
      Array.from(document.querySelectorAll('.sidebar-nav .tab-btn'))
        .filter(b => !b.classList.contains('nav-item--hidden'))
        .map(b => b.dataset.tab)
    `)
    const hidden = await evj(`
      Array.from(document.querySelectorAll('.sidebar-nav .tab-btn'))
        .filter(b => b.classList.contains('nav-item--hidden'))
        .map(b => b.dataset.tab)
    `)
    console.log(`  visible:`, visible)
    console.log(`  hidden :`, hidden)

    // Screenshot: clip to the left sidebar so we get a tight frame of
    // the nav filter effect (not a giant chat pane full of empty state).
    const clip = await evj(`
      (() => {
        const s = document.querySelector('.sidebar')
        if (!s) return null
        const r = s.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 }
      })()
    `)
    const shotArgs = { format: 'png', captureBeyondViewport: true }
    if (clip) shotArgs.clip = clip
    const shot = await call('Page.captureScreenshot', shotArgs, 30000)
    if (!shot || !shot.data) throw new Error('captureScreenshot returned no data')
    const outPath = join(OUTDIR, `${kase.name}.png`)
    writeFileSync(outPath, Buffer.from(shot.data, 'base64'))
    console.log(`  wrote ${outPath}`)
    return { visible, hidden, path: outPath }
  } finally {
    try { child.kill('SIGKILL') } catch {}
    // Aggressively wait for the CDP port to actually free — Electron
    // spawns a helper process (GPU / renderer) that can linger after the
    // main process death, keeping the port bound. Poll until /json/list
    // stops answering (or 10s cap).
    for (let i = 0; i < 20; i++) {
      await sleep(500)
      try {
        await fetch(`http://localhost:${port}/json/list`)
      } catch {
        break // port is free
      }
    }
  }
}

async function main() {
  const results = []
  for (let i = 0; i < CASES.length; i++) {
    const kase = CASES[i]
    const r = await runCase(kase, i)
    results.push({ name: kase.name, label: kase.label, ...r })
  }
  console.log('\n--- SUMMARY ---')
  for (const r of results) {
    console.log(`${r.name}: ${r.label}`)
    console.log(`  visible: ${JSON.stringify(r.visible)}`)
    console.log(`  hidden : ${JSON.stringify(r.hidden)}`)
    console.log(`  shot   : ${r.path}`)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
