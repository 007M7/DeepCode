// Verification script for lane-evals-merge (2026-07-19):
// launches an isolated Electron on CDP :9455 with its own --user-data-dir
// and DSH_DESKTOP_HOME, opens the shell, clicks the new Evals nav item,
// cycles the three inner tabs [ Rubrics | Growth | Runtime ], flips the
// shared rubric selector, and shoots five screenshots into
// docs/qa-evals-merge/:
//   00-sidebar-full.png          — left nav shows Evals (not three rows)
//   01-evals-rubrics.png         — Rubrics tab active
//   02-evals-growth.png          — Growth tab active
//   03-evals-runtime.png         — Runtime tab active (all rubrics)
//   04-evals-selector-runtime.png — shared selector picks one rubric,
//                                    Runtime grid filters to that card
//
// Two-root isolation (per 2026-07-18 postmortem in
// scripts/qa-cdp-shoot-affordance.mjs header):
//   1. --user-data-dir=<tmp>   isolates Chromium userdata
//   2. DSH_DESKTOP_HOME=<tmp>  isolates our shell's config root
// Neither the user's running Electron on CDP 9333 nor their ~/.dsh-desktop
// is touched.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { tmpdir } from 'node:os'

const WORKTREE = resolve(process.env.DSH_WORKTREE || process.cwd())
const PARENT = resolve(process.env.DSH_REPO || '/Users/ziya/harness/dsh-desktop-demo')
const ELECTRON = join(PARENT, 'node_modules/.bin/electron')
const CDP_PORT = Number(process.env.DSH_EVALS_MERGE_PORT || 9455)
const USER_DATA = join(tmpdir(), 'dsh-evals-merge-userdata')
const DSH_HOME = join(tmpdir(), 'dsh-evals-merge-home')
const OUTDIR = join(WORKTREE, 'docs/qa-evals-merge')

if (!existsSync(ELECTRON)) {
  console.error(`electron binary not found at ${ELECTRON}`)
  process.exit(2)
}
mkdirSync(OUTDIR, { recursive: true })
for (const dir of [USER_DATA, DSH_HOME]) {
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
  mkdirSync(dir, { recursive: true })
}
// Minimal onboarding seed so we don't hit the first-run modal. Same shape
// as scripts/qa-cdp-shoot-affordance.mjs — never touches the real ~/.dsh-desktop.
const seedOverlay = [
  '# QA evals-merge seed overlay (tmp, per-run).',
  'plugins:',
  '  - "@cordisjs/plugin-include":',
  `      path: ${join(WORKTREE, 'config/daemon-echo.yml')}`,
  '',
].join('\n')
writeFileSync(join(DSH_HOME, 'user-overlay.cordis.yml'), seedOverlay)
writeFileSync(join(DSH_HOME, 'config.json'), JSON.stringify({
  role: 'coding', approvalMode: 'never',
}))
writeFileSync(join(DSH_HOME, '.onboarded'), new Date().toISOString())

async function bootElectron() {
  const child = spawn(ELECTRON, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${USER_DATA}`,
    '--disable-gpu',
    '--no-sandbox',
    '.',
  ], {
    cwd: WORKTREE,
    env: {
      ...process.env,
      DSH_DESKTOP_HOME: DSH_HOME,
      DSH_MAXIMIZE: '1',
      // DSH_QA is intentionally NOT set — it injects the `#qa` URL hash
      // that turns on qa-harness.js's click-sweep, which fires switchTo
      // in the middle of our own driver's shot sequence. We only need
      // isolation + a stable renderer, not the auto-walker.
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = []
  child.stdout.on('data', d => logs.push(String(d)))
  child.stderr.on('data', d => logs.push(String(d)))
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    try {
      const r = await fetch(`http://localhost:${CDP_PORT}/json/list`)
      if (r.ok) return { child, logs }
    } catch {}
  }
  child.kill('SIGKILL')
  console.error('electron CDP did not come up in 20s. logs:\n' + logs.join(''))
  process.exit(3)
}

async function newCdp() {
  const targets = await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json()
  const target = targets.find(t => t.type === 'page')
  if (!target) throw new Error('no page target on port ' + CDP_PORT)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = e => err(e) })
  let id = 1
  const pending = new Map()
  ws.onmessage = ev => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
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

async function main() {
  const { child, logs } = await bootElectron()
  const kill = () => { try { child.kill('SIGKILL') } catch {} }
  try {
    const cdp = await newCdp()
    await cdp.call('Page.enable')
    await cdp.call('Runtime.enable')
    // Wait until the sidebar Evals button exists — proves index.html
    // wired the new nav and the renderer has painted.
    let ready = false
    for (let i = 0; i < 60; i++) {
      await sleep(200)
      ready = await cdp.evj(`!!document.querySelector('.tab-btn[data-tab="evals"]')`)
      if (ready) break
    }
    if (!ready) throw new Error('Evals nav button never mounted — check index.html + renderer.js')

    const shoot = async (name) => {
      // Retry once — the Runtime tab paint kicks off async listProfiles/
      // runtimeStatus calls; on slow machines the first capture attempt
      // occasionally times out while the compositor is busy. A single
      // retry with a longer settle is enough in practice.
      await sleep(500)
      let attempts = 0
      let lastErr
      while (attempts < 2) {
        attempts++
        try {
          const r = await cdp.call('Page.captureScreenshot', { format: 'png' }, 90000)
          writeFileSync(join(OUTDIR, name + '.png'), Buffer.from(r.data, 'base64'))
          console.error('wrote', name + '.png')
          return
        } catch (e) {
          lastErr = e
          console.error(`shoot ${name} attempt ${attempts} failed: ${e.message}; retrying after 800ms`)
          await sleep(800)
        }
      }
      throw lastErr
    }

    // 00 — sidebar full, before entering Evals. Prove: exactly ONE
    // Evals button; the three legacy ids (rubrics/growth/runtimes)
    // are gone from the nav.
    const sidebar = await cdp.evj(`(() => {
      const items = [...document.querySelectorAll('.sidebar-nav .tab-btn')]
      return items.map(b => ({ tab: b.dataset.tab, label: (b.textContent || '').trim() }))
    })()`)
    console.error('sidebar snapshot:', JSON.stringify(sidebar))
    const tabs = sidebar.map(s => s.tab)
    if (tabs.filter(t => t === 'evals').length !== 1) throw new Error('expected exactly one evals button, got ' + tabs.filter(t => t === 'evals').length)
    for (const legacy of ['rubrics', 'growth', 'runtimes']) {
      if (tabs.includes(legacy)) throw new Error(`legacy nav id still present: ${legacy}`)
    }
    await shoot('00-sidebar-full')

    // 01 — click Evals, expect Rubrics tab active + rubrics-catalog painted.
    await cdp.evj(`document.querySelector('.tab-btn[data-tab="evals"]').click()`)
    await sleep(500)
    const rubricsActive = await cdp.evj(`(() => {
      const pane = document.querySelector('.pane[data-pane="evals"]')
      if (!pane) return { ok: false, reason: 'no evals pane' }
      if (pane.hidden) return { ok: false, reason: 'pane hidden after switchTo' }
      const active = pane.dataset.evalsActive
      const rubricsPane = pane.querySelector('.evals-tab-pane[data-evals-tab-pane="rubrics"]')
      const growthPane = pane.querySelector('.evals-tab-pane[data-evals-tab-pane="growth"]')
      const runtimePane = pane.querySelector('.evals-tab-pane[data-evals-tab-pane="runtime"]')
      return {
        ok: active === 'rubrics' && !rubricsPane.hidden && growthPane.hidden && runtimePane.hidden,
        active,
        rubricsHidden: rubricsPane.hidden,
        growthHidden: growthPane.hidden,
        runtimeHidden: runtimePane.hidden,
        catalogChildren: pane.querySelectorAll('#rubrics-catalog *').length,
      }
    })()`)
    console.error('rubrics-active state:', JSON.stringify(rubricsActive))
    if (!rubricsActive.ok) throw new Error('rubrics tab did not activate as expected: ' + JSON.stringify(rubricsActive))
    await shoot('01-evals-rubrics')

    // 02 — click Growth tab, expect only Growth pane visible.
    await cdp.evj(`document.querySelector('.evals-tab[data-evals-tab="growth"]').click()`)
    await sleep(500)
    const growthActive = await cdp.evj(`(() => {
      const pane = document.querySelector('.pane[data-pane="evals"]')
      const active = pane.dataset.evalsActive
      const growthPane = pane.querySelector('.evals-tab-pane[data-evals-tab-pane="growth"]')
      const rubricsPane = pane.querySelector('.evals-tab-pane[data-evals-tab-pane="rubrics"]')
      const runtimePane = pane.querySelector('.evals-tab-pane[data-evals-tab-pane="runtime"]')
      return { ok: active === 'growth' && !growthPane.hidden && rubricsPane.hidden && runtimePane.hidden, active }
    })()`)
    console.error('growth-active state:', JSON.stringify(growthActive))
    if (!growthActive.ok) throw new Error('growth tab did not activate as expected: ' + JSON.stringify(growthActive))
    await shoot('02-evals-growth')

    // 03 — click Runtime tab. Confirm the rollout-grid card container
    // for the fusion-seeded rubrics is populated.
    await cdp.evj(`document.querySelector('.evals-tab[data-evals-tab="runtime"]').click()`)
    await sleep(700)
    const runtimeState = await cdp.evj(`(() => {
      const evals = document.querySelector('.pane[data-pane="evals"]')
      const active = evals ? evals.dataset.evalsActive : null
      const runtimePane = evals ? evals.querySelector('.evals-tab-pane[data-evals-tab-pane="runtime"]') : null
      const gridCards = evals ? evals.querySelectorAll('[data-testid^="rubric-grid-card-"]').length : 0
      return {
        ok: !!evals && !evals.hidden && active === 'runtime' && runtimePane && !runtimePane.hidden,
        active, gridCards,
      }
    })()`)
    console.error('runtime-active state:', JSON.stringify(runtimeState))
    if (!runtimeState.ok) throw new Error('runtime tab did not activate as expected: ' + JSON.stringify(runtimeState))
    await shoot('03-evals-runtime')

    // 04 — pick a rubric in the shared selector and confirm the Runtime
    // grid filters down. The fusion seed loads a handful of rubrics; we
    // take the first available id.
    const filterProof = await cdp.evj(`(async () => {
      const sel = document.getElementById('evals-shared-rubric')
      if (!sel) return { ok: false, reason: 'no shared selector' }
      // Skip the "All rubrics" sentinel option; pick the first real one.
      const opts = [...sel.querySelectorAll('option')].filter(o => o.value)
      if (!opts.length) return { ok: false, reason: 'no rubric options' }
      const pick = opts[0].value
      sel.value = pick
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      // Give the change listener + Runtime repaint a moment.
      await new Promise(r => setTimeout(r, 400))
      const gridCards = [...document.querySelectorAll('[data-testid^="rubric-grid-card-"]')]
      return {
        ok: gridCards.length === 1,
        picked: pick,
        gridCardIds: gridCards.map(el => el.getAttribute('data-testid')),
      }
    })()`)
    console.error('shared-selector filter proof:', JSON.stringify(filterProof))
    if (!filterProof.ok) throw new Error('shared-selector filter did not narrow the Runtime grid: ' + JSON.stringify(filterProof))
    await shoot('04-evals-selector-runtime')

    console.error('all evals-merge checkpoints passed')
    kill()
  } catch (e) {
    console.error('shoot failed:', e.message)
    console.error('captured logs:\n' + logs.slice(-30).join(''))
    kill()
    process.exit(1)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
