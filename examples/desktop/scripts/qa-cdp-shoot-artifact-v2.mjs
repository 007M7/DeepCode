// QA shoot for lane-artifact-v2 (Artifacts evolution chain + Board view).
//
// Cheap variant vs. the full electron-shoot pattern (qa-cdp-shoot-*.mjs):
// this loads docs/qa-artifact-evolution/fixture.html directly in a bare
// Electron BrowserWindow — no user-data-dir, no seed overlay, no
// $DSH_DESKTOP_HOME plumbing, because the fixture doesn't touch profiles
// / plugins / main.js. It just needs a Chromium to render style.css +
// artifacts.js + artifacts-board.js against the fixture JSON.
//
// Shoots three screenshots into docs/qa-artifact-evolution/:
//   01-list.png       — default List view (compact rows + auto-group)
//   02-board.png      — Board view grouped by kind
//   03-evolution.png  — session.md's evolution strip expanded, showing
//                       the v1→v2 diff pane opened

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { tmpdir } from 'node:os'

const WORKTREE = resolve(process.env.DSH_WORKTREE || process.cwd())
const PARENT = resolve(process.env.DSH_REPO || '/Users/ziya/harness/dsh-desktop-demo')
const ELECTRON = join(PARENT, 'node_modules/.bin/electron')
const CDP_PORT = Number(process.env.DSH_ARTIFACT_V2_PORT || 9276)

const OUTDIR = join(WORKTREE, 'docs/qa-artifact-evolution')
if (!existsSync(OUTDIR)) mkdirSync(OUTDIR, { recursive: true })

// Tiny electron main.js: loads a single file via `file://`. Written to
// /tmp/dsh-artifact-v2-<pid>/main.js so we don't pollute the worktree.
const APPDIR = join(tmpdir(), `dsh-artifact-v2-${process.pid}`)
mkdirSync(APPDIR, { recursive: true })
const fixturePath = join(WORKTREE, 'docs/qa-artifact-evolution/fixture.html')
writeFileSync(join(APPDIR, 'package.json'), JSON.stringify({
  name: 'dsh-artifact-v2-shoot', main: 'main.js',
}))
writeFileSync(join(APPDIR, 'main.js'), `
const { app, BrowserWindow } = require('electron')
app.commandLine.appendSwitch('remote-debugging-port', '${CDP_PORT}')
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1200, height: 900,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  })
  win.loadFile(${JSON.stringify(fixturePath)})
})
app.on('window-all-closed', () => app.quit())
`)

async function bootElectron() {
  const child = spawn(ELECTRON, ['.'], {
    cwd: APPDIR,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = []
  child.stdout.on('data', (d) => logs.push(String(d)))
  child.stderr.on('data', (d) => logs.push(String(d)))
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
  const target = targets.find((t) => t.type === 'page')
  if (!target) throw new Error('no page target on port ' + CDP_PORT)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = (e) => err(e) })
  let id = 1
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
    if (msg.id != null && pending.has(msg.id)) {
      const [ok, err] = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) err(new Error(msg.error.message)); else ok(msg.result)
    }
  }
  const call = (m, p = {}, ms = 15000) => new Promise((ok, err) => {
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

async function main() {
  const { child, logs } = await bootElectron()
  const kill = () => { try { child.kill('SIGKILL') } catch {} }
  process.on('exit', kill)
  process.on('SIGINT', () => { kill(); process.exit(1) })

  try {
    await sleep(1500)
    const cdp = await newCdp()
    await cdp.call('Page.enable')
    await cdp.call('Emulation.setDeviceMetricsOverride', {
      width: 1200, height: 900, deviceScaleFactor: 2, mobile: false,
    })

    // Wait for fixture data to load — the fetch() inside fixture.html
    // is async so give it a beat.
    await sleep(1500)
    const state = await cdp.evj(`(() => {
      const api = window.__dshArtifacts
      const board = window.__dshArtifactsBoard
      return {
        cards: api ? api.cards.size : -1,
        historyKeys: api ? [...api.history.keys()] : [],
        boardOk: !!board,
      }
    })()`)
    console.error('fixture state:', JSON.stringify(state))
    if (!state.cards || state.cards < 5) throw new Error('fixture did not populate: ' + JSON.stringify(state))

    const shoot = async (name) => {
      await sleep(300)
      const r = await cdp.call('Page.captureScreenshot', { format: 'png' }, 30000)
      writeFileSync(join(OUTDIR, name + '.png'), Buffer.from(r.data, 'base64'))
      console.error('wrote', name + '.png')
    }

    // 01. List view — default state, auto-grouped rows.
    await shoot('01-list')

    // 02. Board view.
    await cdp.evj(`window.__dshArtifacts.switchView('board')`)
    await sleep(400)
    await shoot('02-board')

    // 03. Evolution strip — return to List, click session.md's version
    // chip, and open the first diff pane so the diff is captured in the
    // resting state.
    await cdp.evj(`window.__dshArtifacts.switchView('list')`)
    await sleep(300)
    await cdp.evj(`(() => {
      const card = document.querySelector('.artifact-card[data-artifact-id="session.md"]')
      const chip = card && card.querySelector('.artifact-version')
      if (chip) chip.click()
      // Open the first diff pane so the v1→v2 line-diff is visible in the shot.
      const firstDiff = document.querySelector('.artifact-evolution-diff')
      if (firstDiff) firstDiff.open = true
      return true
    })()`)
    await sleep(400)
    // Scroll the strip into view so the shot's top has it.
    await cdp.evj(`document.querySelector('.artifact-evolution').scrollIntoView({ block: 'start' })`)
    await sleep(200)
    await shoot('03-evolution')

    console.error('DONE — shots at', OUTDIR)
  } finally {
    kill()
    try { rmSync(APPDIR, { recursive: true, force: true }) } catch {}
  }
}

main().catch((err) => {
  console.error('shoot failed:', err)
  process.exit(1)
})
