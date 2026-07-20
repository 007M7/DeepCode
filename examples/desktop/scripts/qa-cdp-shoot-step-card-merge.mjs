// scripts/qa-cdp-shoot-step-card-merge.mjs — feat/step-card-merge shoot.
//
// Boots an isolated Electron on CDP :9522 with its own --user-data-dir
// and $DSH_DESKTOP_HOME so the user's live desktop demo (pid 7810/7816
// on ~/.dsh-desktop) is never touched. Seeds a turn with thinking +
// multiple tool calls, captures three screenshots:
//
//   01-fused-collapsed.png — chat flow, fused step/tool cards collapsed
//   02-fused-expanded.png  — first fused card opened, showing args +
//                            result + inputs/outputs/events panes + the
//                            edit-and-re-run trigger revealed on open
//   03-fused-edit-rerun.png — edit-and-re-run panel opened inside the
//                            expanded fused card (textarea visible)
//
// Isolation follows scripts/qa-cdp-shoot-context-topright.mjs precedent.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { tmpdir } from 'node:os'

const WORKTREE = resolve(process.env.DSH_WORKTREE || process.cwd())
const PARENT = resolve(process.env.DSH_REPO || '/Users/ziya/harness/dsh-desktop-demo')
const ELECTRON = join(PARENT, 'node_modules/.bin/electron')
const CDP_PORT = Number(process.env.DSH_STEP_CARD_MERGE_PORT || 9522)
const USER_DATA = join(tmpdir(), 'dsh-step-card-merge-userdata')
const DSH_HOME = join(tmpdir(), 'dsh-step-card-merge-home')
const OUTDIR = join(WORKTREE, 'docs/qa-step-card-merge')

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
      // Deliberately DO NOT set DSH_QA=1 — the QA fixture bootstrap seeds
      // its own bench/session content which overlays our seeded turns and
      // scrolls the fused cards off-screen. We drive the renderer seam
      // directly instead of relying on the fixture path.
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

// Seed: user prompt → 2 turns. First turn has one thinking chunk and a
// single tool call (read). Second turn has thinking + 3 parallel tool
// calls (read, grep, bash) so we can observe the "<first> +N" summary
// on the multi-call fused card.
const SEED = `(async () => {
  const R = window.__dshRenderer
  if (!R) return { __err: 'renderer seam missing' }
  const sid = 'step-merge-' + Date.now()
  R.ensureSession(sid, { title: 'step-card-merge demo', header: { model: 'deepseek-r1' } })
  await R.selectSession(sid)
  const emit = (ev) => R.onSessionEvent(sid, ev)
  const t0 = Date.now()
  let seq = 1
  const at = (o) => t0 + o
  // Turn 1: single-tool step
  emit({ type: 'user/message', seq: seq++, time: at(0),
         data: { content: [{ type: 'text', text: 'Read the design doc header for me.' }] } })
  emit({ type: 'turn/start', seq: seq++, time: at(5), data: { turnId: 't0', model: 'deepseek-r1' } })
  emit({ type: 'step/start', seq: seq++, time: at(10), data: { turn: 0, step: 0 } })
  emit({ type: 'assistant/message', seq: seq++, time: at(20), data: {
    content: [{ type: 'text', text: 'thinking: open the design doc' }],
    usage: { inputTokens: 210, outputTokens: 8, cacheReadTokens: 1024 },
  } })
  emit({ type: 'tool/call', seq: seq++, time: at(60),
         data: { callId: 'c-1', name: 'read', arguments: JSON.stringify({ path: 'docs/DESIGN.md', limit: 40 }) } })
  emit({ type: 'tool/result', seq: seq++, time: at(140),
         data: { callId: 'c-1', content: [{ type: 'text', text: '# design doc\\n\\n(header excerpt)' }] } })
  emit({ type: 'step/end', seq: seq++, time: at(150), data: {} })
  emit({ type: 'turn/end', seq: seq++, time: at(160), data: { turnId: 't0', reason: 'completed',
    usage: { total_tokens: 240 }, durationMs: 160 } })
  // Turn 2: multi-tool step
  emit({ type: 'user/message', seq: seq++, time: at(200),
         data: { content: [{ type: 'text', text: 'now grep for TODOs and list changed files.' }] } })
  emit({ type: 'turn/start', seq: seq++, time: at(210), data: { turnId: 't1', model: 'deepseek-r1' } })
  emit({ type: 'step/start', seq: seq++, time: at(215), data: { turn: 1, step: 0 } })
  emit({ type: 'assistant/message', seq: seq++, time: at(220), data: {
    content: [{ type: 'text', text: 'thinking: run three tools in parallel' }],
    usage: { inputTokens: 320, outputTokens: 14, cacheReadTokens: 2048 },
  } })
  emit({ type: 'tool/call', seq: seq++, time: at(230),
         data: { callId: 'c-2', name: 'read', arguments: JSON.stringify({ path: 'src/renderer/renderer.js', limit: 20 }) } })
  emit({ type: 'tool/call', seq: seq++, time: at(232),
         data: { callId: 'c-3', name: 'grep', arguments: JSON.stringify({ pattern: 'TODO', path: 'src' }) } })
  emit({ type: 'tool/call', seq: seq++, time: at(234),
         data: { callId: 'c-4', name: 'bash', arguments: JSON.stringify({ command: 'git status -s' }) } })
  emit({ type: 'tool/result', seq: seq++, time: at(310),
         data: { callId: 'c-2', content: [{ type: 'text', text: '// top of renderer.js' }] } })
  emit({ type: 'tool/result', seq: seq++, time: at(320),
         data: { callId: 'c-3', content: [{ type: 'text', text: 'src/renderer/foo.js:42:  // TODO polish' }] } })
  emit({ type: 'tool/result', seq: seq++, time: at(330),
         data: { callId: 'c-4', content: [{ type: 'text', text: ' M src/renderer/style.css' }] } })
  emit({ type: 'step/end', seq: seq++, time: at(340), data: {} })
  emit({ type: 'turn/end', seq: seq++, time: at(350), data: { turnId: 't1', reason: 'completed',
    usage: { total_tokens: 512 }, durationMs: 150 } })
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
      width: 1400, height: 1000, deviceScaleFactor: 2, mobile: false,
    })
    for (let i = 0; i < 20; i++) {
      const ready = await cdp.evj(`!!(window.__dshRenderer && window.__dshRenderer.onSessionEvent)`)
      if (ready) break
      await sleep(250)
    }
    const seedRes = await cdp.evj(SEED)
    console.log('seed:', JSON.stringify(seedRes))
    await sleep(800)

    // Verify fusion DOM contract before shooting so we don't waste a
    // screenshot on a broken build.
    const contract = await cdp.evj(`(() => {
      const fused = document.querySelectorAll('.tool-block.trace-card-fused')
      const standalone = document.querySelectorAll('.trace-card:not(.trace-card-fused)')
      const drawers = document.querySelectorAll('.turn-trace-drawer')
      const multi = document.querySelector('.tool-block.trace-card-fused[data-step-index="0"][data-step-turn="1"]')
      const multiName = multi ? multi.querySelector('.tool-family-name').textContent : null
      return {
        fusedCount: fused.length,
        standaloneTraceCount: standalone.length,
        drawerCount: drawers.length,
        multiCallSummary: multiName,
      }
    })()`)
    console.log('contract:', JSON.stringify(contract))

    // Make sure we're on the Chat tab so the seeded turns are on-screen,
    // then scroll to the top of the stream so shot 1 captures the whole
    // "collapsed fused" flow (thinking bubbles + tool row + turn footer).
    await cdp.evj(`window.__dshTabs && window.__dshTabs.switchTo && window.__dshTabs.switchTo('chat')`)
    await sleep(300)
    await cdp.evj(`(() => {
      const first = document.querySelector('.tool-block.trace-card-fused')
      if (first && first.scrollIntoView) first.scrollIntoView({ block: 'center' })
    })()`)
    await sleep(300)

    // Shot 1: collapsed
    await shoot(cdp, '01-fused-collapsed.png')

    // Open the first fused card + shoot expanded (args, result, panes + edit&re-run trigger visible)
    await cdp.evj(`(() => {
      const c = document.querySelector('.tool-block.trace-card-fused')
      if (c && c.tagName === 'DETAILS') c.open = true
      c && c.scrollIntoView({ block: 'center' })
    })()`)
    await sleep(400)
    await shoot(cdp, '02-fused-expanded.png')

    // Open the edit-and-re-run panel inside the same expanded fused card.
    const editState = await cdp.evj(`(() => {
      const c = document.querySelector('.tool-block.trace-card-fused')
      if (!c) return { __err: 'no fused card' }
      const trigger = c.querySelector('.tool-edit-rerun-trigger')
      if (!trigger) return { __err: 'no edit trigger inside fused card' }
      trigger.click()
      const panel = c.querySelector('.tool-edit-rerun-panel')
      return { visible: !!(panel && !panel.hidden), triggerText: trigger.textContent }
    })()`)
    console.log('edit-rerun:', JSON.stringify(editState))
    // Scroll the whole fused card into view so the shot captures the
    // summary + args/result + edit panel, not just the panel textarea.
    await cdp.evj(`(() => {
      const c = document.querySelector('.tool-block.trace-card-fused')
      if (c && c.scrollIntoView) c.scrollIntoView({ block: 'start' })
    })()`)
    await sleep(300)
    await shoot(cdp, '03-fused-edit-rerun.png')
  } finally {
    try { child.kill('SIGKILL') } catch {}
  }
}

main().catch(err => { console.error(err); process.exit(1) })
