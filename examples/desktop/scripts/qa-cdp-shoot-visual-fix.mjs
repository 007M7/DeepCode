// scripts/qa-cdp-shoot-visual-fix.mjs — visual-consistency-polish verification.
//
// Boots an isolated Electron on CDP :9403 (its own --user-data-dir +
// $DSH_DESKTOP_HOME so real user config is never touched, per the
// 2026-07-18 postmortem), seeds a session that fires a `plan-update`
// signal (so the .sig-plan chip appears next to an action turn's blue
// left rail — the P0-1 collision surface), then captures three PNGs
// covering the three fix surfaces:
//
//   01-chat-signal-plan.png       — Chat pane, mixed action turn +
//     .sig-plan chip. Plan chip must NOT match the turn left-rail blue.
//   02-rubrics-hint-row.png       — Rubrics catalog page. The similar-
//     sessions hint must read as a 28px compact row, not a purple hero.
//   03-growth-filter-chip.png     — Growth page. Filter chip active
//     state must use the app --accent-soft, not raw violet.
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
const CDP_PORT = Number(process.env.DSH_VISUAL_FIX_PORT || 9403)
const USER_DATA = join(tmpdir(), 'dsh-visual-fix-userdata')
const DSH_HOME = join(tmpdir(), 'dsh-visual-fix-home')
const OUTDIR = join(WORKTREE, 'docs/qa-visual-fix')

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

// Seed a demo session that (a) is a real action turn (so its blue left
// rail is painted) and (b) contains an assistant message that trips the
// numbered-plan heuristic in trace-signal-detect._looksLikePlanUpdate,
// producing a .sig-plan chip. The chip should now read teal, not the
// same blue as the rail — that's the P0-1 fix surface.
const SEED = `(async () => {
  const R = window.__dshRenderer
  if (!R) return { __err: 'renderer seam missing' }
  const sid = 'visual-fix-demo-' + Date.now()
  R.ensureSession(sid)
  await R.selectSession(sid)
  const emit = (ev) => R.onSessionEvent(sid, ev)
  let seq = 1
  const now = () => Date.now()
  emit({ type: 'user/message', seq: seq++, time: now(),
         data: { content: [{ type: 'text', text: 'plan out the release' }] } })
  emit({ type: 'turn/start', seq: seq++, time: now(),
         data: { turnId: 't0', model: 'deepseek-r1' } })
  emit({ type: 'assistant/message', seq: seq++, time: now(),
         data: { text: 'Here is the plan:\\n1. Cut the release branch.\\n2. Run the smoke suite.\\n3. Publish the tag.' } })
  emit({ type: 'tool/call', seq: seq++, time: now(),
         data: { callId: 'c1', name: 'git', arguments: '{"cmd":"checkout -b release"}' } })
  emit({ type: 'tool/result', seq: seq++, time: now(),
         data: { callId: 'c1', ok: true, output: 'Switched to a new branch', durationMs: 42 } })
  emit({ type: 'turn/end', seq: seq++, time: now(),
         data: { turnId: 't0', usage: { total_tokens: 240 }, durationMs: 620 } })
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

    // Shot 1: Chat pane, action turn with sig-plan chip
    await cdp.evj(`window.__dshTabs && window.__dshTabs.switchTo && window.__dshTabs.switchTo('chat')`)
    const seedRes = await cdp.evj(SEED)
    console.log('seed:', JSON.stringify(seedRes))
    await sleep(700)
    await shoot(cdp, '01-chat-signal-plan.png')

    // Shot 2: Rubrics page, hint row above the tile grid
    await cdp.evj(`window.__dshTabs && window.__dshTabs.switchTo && window.__dshTabs.switchTo('rubrics')`)
    await sleep(600)
    await shoot(cdp, '02-rubrics-hint-row.png')

    // Shot 3: Growth page, filter chip active
    await cdp.evj(`window.__dshTabs && window.__dshTabs.switchTo && window.__dshTabs.switchTo('growth')`)
    await sleep(600)
    await shoot(cdp, '03-growth-filter-chip.png')

    console.log('shots saved to', OUTDIR)
  } finally {
    child.kill('SIGKILL')
  }
}

main().catch(e => { console.error(e); process.exit(1) })
