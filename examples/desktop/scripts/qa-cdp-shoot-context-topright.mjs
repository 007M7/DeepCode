// scripts/qa-cdp-shoot-context-topright.mjs — fix/context-topright-panel shoot.
//
// Boots an isolated Electron on CDP :9411 (its own --user-data-dir +
// $DSH_DESKTOP_HOME so real user config is never touched), seeds a
// small event stream, switches to the Context tab, and captures:
//
//   01-context-page-before.png — Context page loaded, top-right
//     Details toggle visible, drawer closed
//   02-context-topright-open.png — same session, right-side peek
//     drawer open showing window occupancy + interventions + jump
//   03-context-topright-closed.png — after clicking the × close,
//     drawer collapsed again (regression check for close binding)
//
// Isolation follows scripts/qa-cdp-shoot-chat-triple.mjs precedent.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { tmpdir } from 'node:os'

const WORKTREE = resolve(process.env.DSH_WORKTREE || process.cwd())
const PARENT = resolve(process.env.DSH_REPO || '/Users/ziya/harness/dsh-desktop-demo')
const ELECTRON = join(PARENT, 'node_modules/.bin/electron')
const CDP_PORT = Number(process.env.DSH_CONTEXT_TOPRIGHT_PORT || 9411)
const USER_DATA = join(tmpdir(), 'dsh-context-topright-userdata')
const DSH_HOME = join(tmpdir(), 'dsh-context-topright-home')
const OUTDIR = join(WORKTREE, 'docs/qa-context-topright')

if (!existsSync(ELECTRON)) {
  console.error(`electron binary not found at ${ELECTRON}`)
  process.exit(2)
}
mkdirSync(OUTDIR, { recursive: true })
for (const dir of [USER_DATA, DSH_HOME]) {
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
  mkdirSync(dir, { recursive: true })
}
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
      DSH_QA: '1',
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
  console.error('electron CDP did not come up. logs:\n' + logs.join(''))
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

// Seed a demo session with events likely to have window-family + intervention
// signals (compact + context/message + inject fixtures).
const SEED = `(async () => {
  const R = window.__dshRenderer
  if (!R) return { __err: 'renderer seam missing' }
  const sid = 'ctx-topright-' + Date.now()
  R.ensureSession(sid)
  await R.selectSession(sid)
  const emit = (ev) => R.onSessionEvent(sid, ev)
  let seq = 1
  const now = () => Date.now()
  emit({ type: 'user/message', seq: seq++, time: now(),
         data: { content: [{ type: 'text', text: 'summarize this repo' }] } })
  emit({ type: 'turn/start', seq: seq++, time: now(),
         data: { turnId: 't0', model: 'deepseek-r1' } })
  emit({ type: 'context/message', seq: seq++, time: now(),
         data: { content: [{ type: 'text', text: 'plugin note' }],
                 source: { kind: 'plugin', plugin: 'skill-loader' } } })
  emit({ type: 'tool/call', seq: seq++, time: now(),
         data: { call_id: 'c1', name: 'ls', arguments: '{"path":"."}' } })
  emit({ type: 'tool/result', seq: seq++, time: now(),
         data: { call_id: 'c1', ok: true, output: 'src/ test/', durationMs: 42 } })
  emit({ type: 'turn/end', seq: seq++, time: now(),
         data: { turnId: 't0', usage: { total_tokens: 240 }, durationMs: 620 } })
  emit({ type: 'user/message', seq: seq++, time: now(),
         data: { content: [{ type: 'text', text: 'now compact history' }] } })
  emit({ type: 'turn/start', seq: seq++, time: now(),
         data: { turnId: 't1', model: 'deepseek-r1' } })
  emit({ type: 'compact/summary', seq: seq++, time: now(),
         data: { fromSeq: 1, toSeq: 6, summaryTokens: 300, savedTokens: 800 } })
  emit({ type: 'turn/end', seq: seq++, time: now(),
         data: { turnId: 't1', usage: { total_tokens: 512 }, durationMs: 4100 } })
  return { sid, count: seq - 1 }
})()`

async function shoot(cdp, name) {
  const shot = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: false })
  const buf = Buffer.from(shot.data, 'base64')
  writeFileSync(join(OUTDIR, name), buf)
  console.log(' shot', name, buf.length, 'bytes')
}

async function main() {
  const { child } = await bootElectron()
  try {
    await sleep(1500)
    const cdp = await newCdp()
    await cdp.call('Page.enable')
    await cdp.call('Emulation.setDeviceMetricsOverride', {
      width: 1400, height: 900, deviceScaleFactor: 2, mobile: false,
    })
    for (let i = 0; i < 20; i++) {
      const ready = await cdp.evj(`!!(window.__dshRenderer && window.__dshRenderer.onSessionEvent)`)
      if (ready) break
      await sleep(250)
    }
    const seedRes = await cdp.evj(SEED)
    console.log('seed:', JSON.stringify(seedRes))
    await sleep(400)
    await cdp.evj(`window.__dshTabs && window.__dshTabs.switchTo && window.__dshTabs.switchTo('context')`)
    await sleep(600)
    await shoot(cdp, '01-context-page-before.png')
    // Assertions before open
    const beforeState = await cdp.evj(`(() => {
      const btn = document.getElementById('context-side-drawer-btn')
      const drawer = document.getElementById('context-side-drawer')
      return {
        btnPresent: !!btn,
        drawerPresent: !!drawer,
        drawerHidden: drawer && drawer.classList.contains('hidden'),
        aria: btn && btn.getAttribute('aria-expanded'),
      }
    })()`)
    console.log('before:', JSON.stringify(beforeState))
    await cdp.evj(`document.getElementById('context-side-drawer-btn').click()`)
    await sleep(400)
    await shoot(cdp, '02-context-topright-open.png')
    const openState = await cdp.evj(`(() => {
      const btn = document.getElementById('context-side-drawer-btn')
      const drawer = document.getElementById('context-side-drawer')
      const body = document.getElementById('context-side-drawer-body')
      return {
        drawerHidden: drawer && drawer.classList.contains('hidden'),
        aria: btn && btn.getAttribute('aria-expanded'),
        sections: body ? body.querySelectorAll('.context-side-drawer-section').length : 0,
        hasJump: !!(body && body.querySelector('#context-side-drawer-jump')),
      }
    })()`)
    console.log('open:', JSON.stringify(openState))
    await cdp.evj(`document.getElementById('context-side-drawer-close').click()`)
    await sleep(300)
    await shoot(cdp, '03-context-topright-closed.png')
    const closedState = await cdp.evj(`(() => {
      const btn = document.getElementById('context-side-drawer-btn')
      const drawer = document.getElementById('context-side-drawer')
      return {
        drawerHidden: drawer && drawer.classList.contains('hidden'),
        aria: btn && btn.getAttribute('aria-expanded'),
      }
    })()`)
    console.log('closed:', JSON.stringify(closedState))

    // Basic gates
    if (!beforeState.btnPresent) throw new Error('gate: toggle button missing on Context page')
    if (!beforeState.drawerHidden) throw new Error('gate: drawer must be hidden by default')
    if (openState.drawerHidden) throw new Error('gate: drawer must open on toggle click')
    if (openState.aria !== 'true') throw new Error('gate: aria-expanded must flip true on open')
    if (!openState.hasJump) throw new Error('gate: jump link missing when drawer is open')
    if (openState.sections < 2) throw new Error('gate: drawer must render at least 2 sections (occupancy + interventions) — got ' + openState.sections)
    if (!closedState.drawerHidden) throw new Error('gate: drawer must re-hide on close click')
    if (closedState.aria !== 'false') throw new Error('gate: aria-expanded must flip back to false on close')
    console.log('shots saved to', OUTDIR)
    console.log('ALL_GATES_PASS')
  } finally {
    child.kill('SIGKILL')
  }
}

main().catch(e => { console.error(e); process.exit(1) })
