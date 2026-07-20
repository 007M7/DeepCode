// QA verification script for lane-msg-queue. Boots an isolated Electron on
// its own CDP port, drives the composer message queue entirely through the
// renderer's `window.__dshRenderer` seam (no live model needed), and captures
// two screenshots into docs/qa-msg-queue/:
//
//   01-inflight-two-queued.png — a turn in flight with TWO messages queued;
//       the strip shows two chips + a "queued 2" counter.
//   02-after-turn-end-one-left.png — after turn/end auto-drains the head, the
//       first queued message appears as a sent bubble and the strip shows one
//       remaining chip ("queued 1").
//
// Isolation follows the 2026-07-18 postmortem baked into
// scripts/qa-cdp-shoot-nav-optional.mjs:
//   1. --user-data-dir=<tmp>   isolates Chromium userdata.
//   2. DSH_DESKTOP_HOME=<tmp>  isolates the main-process config root so we
//      never write into ~/.dsh-desktop.
//   3. own CDP port (≥9290)    so a lingering Electron helper from another
//      lane's shoot can't hijack our DevTools endpoint.
//
// Why drive via the seam and not a real prompt: the message-queue behaviour
// is a pure renderer concern (enqueue-on-inflight + auto-drain on turn/end).
// `window.__dshRenderer` exposes send() + onSessionEvent() + listMsgQueue()
// ungated, so we can create an in-flight turn, enqueue two messages, and step
// the turn to completion deterministically — no daemon round-trip, no model
// key. The keyless daemon-echo include still boots the runtime so the shell
// is in its normal chat state.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { tmpdir } from 'node:os'

const WORKTREE = resolve(process.env.DSH_WORKTREE || process.cwd())
const PARENT = resolve(process.env.DSH_REPO || '/Users/ziya/harness/dsh-desktop-demo')
const ELECTRON = join(PARENT, 'node_modules/.bin/electron')
const CDP_PORT = Number(process.env.DSH_MSG_QUEUE_PORT || 9290)
const OUTDIR = join(WORKTREE, 'docs/qa-msg-queue')

if (!existsSync(ELECTRON)) {
  console.error(`electron binary not found at ${ELECTRON}`)
  process.exit(2)
}
mkdirSync(OUTDIR, { recursive: true })

function seedHome(dshHome) {
  // Minimal keyless overlay + config + onboarded sentinel so the first-run
  // modal doesn't fire and steal the window / rewrite our seed. daemon-echo
  // is the keyless demo runtime; we never send a real prompt through it.
  const seedOverlay = [
    '# QA msg-queue shoot seed overlay (tmp, per-run).',
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

// Clip to the composer footer so the strip is unmistakably in frame (not a
// giant empty chat pane). Falls back to a full-page shot if the selector
// isn't found.
async function shoot(call, evj, name) {
  const clip = await evj(`
    (() => {
      const f = document.querySelector('.composer.composer-shell')
      if (!f) return null
      const r = f.getBoundingClientRect()
      // pad upward so a freshly-sent bubble just above the composer is caught.
      const top = Math.max(0, r.y - 220)
      return { x: r.x, y: top, width: r.width, height: (r.bottom - top) + 12, scale: 1 }
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

async function main() {
  const dshHome = join(tmpdir(), 'dsh-msg-queue-home')
  const userData = join(tmpdir(), 'dsh-msg-queue-userdata')
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

    // Step 1: create a session, make it active, and open an in-flight turn.
    // We drive the renderer directly through the always-exposed seam.
    const setup = await evj(`
      (async () => {
        const R = window.__dshRenderer
        if (!R) return { __err: 'no __dshRenderer seam' }
        R.ensureSession('qa-mq', { title: 'Message queue demo', header: {}, hasUserMessage: true })
        await R.selectSession('qa-mq')
        R.onSessionEvent('qa-mq', { type: 'turn/start', seq: 1 })
        // Enqueue two follow-ups via the real composer send() path.
        const input = document.getElementById('input')
        input.value = 'Summarise the three failing tests'
        await R.send()
        input.value = 'Then open a PR with the fix'
        await R.send()
        return { active: R.getActiveSessionId(), queued: R.listMsgQueue('qa-mq').map(x => x.text) }
      })()
    `)
    console.log('  setup:', JSON.stringify(setup))
    if (setup && setup.__err) throw new Error(setup.__err)
    if (!setup || setup.queued.length !== 2) throw new Error('expected 2 queued messages, got ' + JSON.stringify(setup))

    // Assert the strip is actually visible with two chips before shooting.
    const stripA = await evj(`
      (() => {
        const s = document.getElementById('msg-queue-strip')
        return {
          hidden: s.hidden,
          chips: s.querySelectorAll('.msg-queue-chip').length,
          counter: (s.querySelector('.msg-queue-count') || {}).textContent || '',
        }
      })()
    `)
    console.log('  strip (inflight):', JSON.stringify(stripA))
    if (stripA.hidden || stripA.chips !== 2) throw new Error('strip not showing 2 chips: ' + JSON.stringify(stripA))
    await sleep(300)
    const shotA = await shoot(call, evj, '01-inflight-two-queued.png')

    // Step 2: end the turn. turn/end auto-drains exactly one item — the head
    // renders as an optimistic user bubble and the strip drops to one chip.
    const drained = await evj(`
      (async () => {
        const R = window.__dshRenderer
        R.onSessionEvent('qa-mq', { type: 'turn/end', seq: 2 })
        await new Promise(r => setTimeout(r, 60))
        const bubbles = Array.from(document.querySelectorAll('#stream .msg.user .role-label')).length
        return { remaining: R.listMsgQueue('qa-mq').map(x => x.text), userBubbles: bubbles }
      })()
    `)
    console.log('  after turn/end:', JSON.stringify(drained))
    if (!drained || drained.remaining.length !== 1) throw new Error('expected 1 remaining, got ' + JSON.stringify(drained))

    const stripB = await evj(`
      (() => {
        const s = document.getElementById('msg-queue-strip')
        return {
          hidden: s.hidden,
          chips: s.querySelectorAll('.msg-queue-chip').length,
          counter: (s.querySelector('.msg-queue-count') || {}).textContent || '',
        }
      })()
    `)
    console.log('  strip (after drain):', JSON.stringify(stripB))
    if (stripB.hidden || stripB.chips !== 1) throw new Error('strip not showing 1 chip after drain: ' + JSON.stringify(stripB))
    await sleep(300)
    const shotB = await shoot(call, evj, '02-after-turn-end-one-left.png')

    console.log('\n--- SUMMARY ---')
    console.log(`inflight (2 queued): ${shotA.path} (${shotA.bytes} bytes)`)
    console.log(`after drain (1 left): ${shotB.path} (${shotB.bytes} bytes)`)
  } finally {
    try { child.kill('SIGKILL') } catch {}
    for (let i = 0; i < 20; i++) {
      await sleep(500)
      try { await fetch(`http://localhost:${CDP_PORT}/json/list`) } catch { break }
    }
  }
}

main().catch(err => { console.error(err); process.exit(1) })
