// scripts/qa-cdp-shoot-chat-triple.mjs — feat/chat-triple-view shoot.
//
// Boots an isolated Electron on CDP :9271 (its own --user-data-dir +
// $DSH_DESKTOP_HOME so real user config is never touched, per the
// 2026-07-18 postmortem), seeds one fixture session with a small event
// stream (three turns + fork + interruption) so the drawer's history
// list and the graph's fork/interrupt topology both have something to
// paint, then captures three PNGs:
//
//   01-list-view-colored-edges.png — default List view, action-turn
//     rails visible, drawer collapsed
//   02-drawer-open.png             — same session, right-side detail
//     drawer expanded with Current Turn + Session Overview + History
//   03-graph-view.png              — Graph tab active, DAG visible
//
// Isolation follows scripts/qa-cdp-shoot-affordance.mjs precedent.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { tmpdir } from 'node:os'

const WORKTREE = resolve(process.env.DSH_WORKTREE || process.cwd())
const PARENT = resolve(process.env.DSH_REPO || '/Users/ziya/harness/dsh-desktop-demo')
const ELECTRON = join(PARENT, 'node_modules/.bin/electron')
const CDP_PORT = Number(process.env.DSH_CHAT_TRIPLE_PORT || 9271)
const USER_DATA = join(tmpdir(), 'dsh-chat-triple-userdata')
const DSH_HOME = join(tmpdir(), 'dsh-chat-triple-home')
const OUTDIR = join(WORKTREE, 'docs/qa-chat-triple')

if (!existsSync(ELECTRON)) {
  console.error(`electron binary not found at ${ELECTRON}`)
  process.exit(2)
}
mkdirSync(OUTDIR, { recursive: true })
for (const dir of [USER_DATA, DSH_HOME]) {
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
  mkdirSync(dir, { recursive: true })
}
const seedOverlay = [
  'plugins:',
  `  - "@cordisjs/plugin-include":`,
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

// Seed a demo session in the running renderer via __dshRenderer.
// The renderer exposes ensureSession + selectSession + onSessionEvent.
const SEED = `(async () => {
  const R = window.__dshRenderer
  if (!R) return { __err: 'renderer seam missing' }
  const sid = 'triple-demo-' + Date.now()
  R.ensureSession(sid)
  await R.selectSession(sid)
  const emit = (ev) => R.onSessionEvent(sid, ev)
  let seq = 1
  const now = () => Date.now()
  emit({ type: 'user/message', seq: seq++, time: now(),
         data: { content: [{ type: 'text', text: 'summarize this repo' }] } })
  emit({ type: 'turn/start', seq: seq++, time: now(),
         data: { turnId: 't0', model: 'deepseek-r1' } })
  emit({ type: 'assistant/message', seq: seq++, time: now(),
         data: { text: 'sure — poking around now.' } })
  emit({ type: 'tool/call', seq: seq++, time: now(),
         data: { call_id: 'c1', name: 'ls', arguments: '{"path":"."}' } })
  emit({ type: 'tool/result', seq: seq++, time: now(),
         data: { call_id: 'c1', ok: true, output: 'src/ test/ …', durationMs: 42 } })
  emit({ type: 'turn/end', seq: seq++, time: now(),
         data: { turnId: 't0', usage: { total_tokens: 240 }, durationMs: 620 } })
  emit({ type: 'user/message', seq: seq++, time: now(),
         data: { content: [{ type: 'text', text: 'now run tests' }] } })
  emit({ type: 'turn/start', seq: seq++, time: now(),
         data: { turnId: 't1', model: 'deepseek-r1' } })
  emit({ type: 'assistant/message', seq: seq++, time: now(),
         data: { text: 'kicking off the suite.' } })
  emit({ type: 'turn/end', seq: seq++, time: now(),
         data: { turnId: 't1', usage: { total_tokens: 512 }, durationMs: 4100 } })
  emit({ type: 'session/fork', seq: seq++, time: now(),
         data: { fromTurnId: 't1', childSessionId: 'child-xyz' } })
  emit({ type: 'user/message', seq: seq++, time: now(),
         data: { content: [{ type: 'text', text: 'wait, cancel' }] } })
  emit({ type: 'turn/start', seq: seq++, time: now(),
         data: { turnId: 't2', model: 'deepseek-r1' } })
  emit({ type: 'user/interrupt', seq: seq++, time: now(), data: {} })
  emit({ type: 'turn/end', seq: seq++, time: now(),
         data: { turnId: 't2', stopReason: 'cancelled' } })
  return { sid, count: seq - 1 }
})()`

async function shoot(cdp, name) {
  const shot = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: false })
  const buf = Buffer.from(shot.data, 'base64')
  writeFileSync(join(OUTDIR, name), buf)
  console.log(' shot', name, buf.length, 'bytes')
}

async function main() {
  const { child, logs } = await bootElectron()
  try {
    await sleep(1500)
    const cdp = await newCdp()
    await cdp.call('Page.enable')
    await cdp.call('Emulation.setDeviceMetricsOverride', {
      width: 1400, height: 900, deviceScaleFactor: 2, mobile: false,
    })
    // wait for renderer seam
    for (let i = 0; i < 20; i++) {
      const ready = await cdp.evj(`!!(window.__dshRenderer && window.__dshRenderer.onSessionEvent)`)
      if (ready) break
      await sleep(250)
    }
    await cdp.evj(`window.__dshTabs && window.__dshTabs.switchTo && window.__dshTabs.switchTo('chat')`)
    const seedRes = await cdp.evj(SEED)
    console.log('seed:', JSON.stringify(seedRes))
    await sleep(600)
    // Shot 1: List view, drawer collapsed (default)
    await shoot(cdp, '01-list-view-colored-edges.png')
    // Shot 2: Drawer open
    await cdp.evj(`document.getElementById('chat-side-drawer-btn').click()`)
    await sleep(400)
    await shoot(cdp, '02-drawer-open.png')
    // Close drawer, switch to Graph
    await cdp.evj(`document.getElementById('chat-side-drawer-close').click()`)
    await sleep(200)
    await cdp.evj(`document.querySelector('.chat-view-tab[data-chat-view-tab="graph"]').click()`)
    await sleep(400)
    await shoot(cdp, '03-graph-view.png')
    console.log('shots saved to', OUTDIR)
  } finally {
    child.kill('SIGKILL')
  }
}

main().catch(e => { console.error(e); process.exit(1) })
