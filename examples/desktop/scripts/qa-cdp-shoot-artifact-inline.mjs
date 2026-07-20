// QA verification for lane-artifact-inline: the in-stream inline md/html
// artifact preview. Boots one isolated Electron on CDP :9320, seeds the
// artifact board fixture (md cards carry blob content) + fires the debug
// mock-artifact path (writes a real .html the artifact server serves), then
// captures three shots into docs/qa-artifact-inline/:
//
//   01-collapsed-default   — cards present, previews collapsed (quiet rows)
//   02-md-preview-expanded — an .md card with its markdown preview open
//                            (headings / bold / fenced code visibly rendered)
//   03-html-iframe-expanded— the mock .html card with its sandboxed iframe
//                            preview open, framing the live 127.0.0.1 page
//
// Isolation mirrors scripts/qa-cdp-shoot-nav-optional.mjs (the 2026-07-18
// postmortem pattern): tmp DSH_DESKTOP_HOME + tmp --user-data-dir, single
// CDP port, electron resolved from the PARENT repo (this worktree has no
// node_modules). DSH_QA=1 is deliberately NOT set (qa-harness auto-clicks
// onboarding). The artifact panel auto-mounts on stream init, so we drive
// the real onArtifactEvent path the production wire uses.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { tmpdir } from 'node:os'

const WORKTREE = resolve(process.env.DSH_WORKTREE || process.cwd())
const PARENT = resolve(process.env.DSH_REPO || '/Users/ziya/harness/dsh-desktop-demo')
const ELECTRON = join(PARENT, 'node_modules/.bin/electron')
const CDP_PORT = Number(process.env.DSH_ARTIFACT_INLINE_PORT || 9320)
const OUTDIR = join(WORKTREE, 'docs/qa-artifact-inline')

if (!existsSync(ELECTRON)) {
  console.error(`electron binary not found at ${ELECTRON}`)
  process.exit(2)
}
mkdirSync(OUTDIR, { recursive: true })

function seedHome(dshHome) {
  const seedOverlay = [
    '# QA artifact-inline-shoot seed overlay (tmp, per-run).',
    'plugins:',
    `  - "@cordisjs/plugin-include":`,
    `      path: ${join(WORKTREE, 'config/daemon-echo.yml')}`,
    '',
  ].join('\n')
  writeFileSync(join(dshHome, 'user-overlay.cordis.yml'), seedOverlay)
  writeFileSync(join(dshHome, 'config.json'),
    JSON.stringify({ role: 'coding', approvalMode: 'never' }, null, 2))
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

async function shoot(call, name) {
  const shot = await call('Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: true }, 30000)
  if (!shot || !shot.data) throw new Error('captureScreenshot returned no data for ' + name)
  const outPath = join(OUTDIR, `${name}.png`)
  writeFileSync(outPath, Buffer.from(shot.data, 'base64'))
  const kb = (statSync(outPath).size / 1024).toFixed(1)
  console.log(`  wrote ${outPath} (${kb} KB)`)
  return outPath
}

async function main() {
  const dshHome = join(tmpdir(), 'dsh-artifact-inline-home')
  const userData = join(tmpdir(), 'dsh-artifact-inline-userdata')
  for (const dir of [dshHome, userData]) {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
    mkdirSync(dir, { recursive: true })
  }
  seedHome(dshHome)
  console.log(`booting on port ${CDP_PORT}`)
  const { child } = await bootElectron(dshHome, userData, CDP_PORT)
  const results = {}
  try {
    await sleep(1800)
    const { call, evj } = await newCdp(CDP_PORT)
    await call('Page.enable')
    await call('Runtime.enable')

    // Make sure we're on the Chat view so the artifact stream/panel is live.
    await evj(`(() => {
      const chatBtn = document.querySelector('.tab-btn[data-tab="chat"]')
      if (chatBtn) chatBtn.click()
      return true
    })()`)
    await sleep(400)

    // Seed the board fixture through the production onArtifactEvent path —
    // md entries (session.md / README.md) carry blob content so the inline
    // markdown preview renders real formatting.
    const seeded = await evj(`(() => {
      const A = window.__dshArtifacts
      const seed = window.__dshArtifactBoardSeed
      if (!A || !seed) return { ok: false, reason: 'no seed/api' }
      A.seedBoardFixture(seed.artifacts)
      const md = seed.artifacts.filter(a => a.kind === 'md').map(a => a.artifactId)
      return { ok: true, mdIds: [...new Set(md)] }
    })()`)
    console.log('  seeded:', JSON.stringify(seeded))
    await sleep(600)

    // --- shot 1: collapsed default (quiet rows, no preview open) ----------
    // Scroll the stream to the artifact panel first.
    await evj(`(() => {
      const p = document.querySelector('.artifact-panel')
      if (p && p.scrollIntoView) p.scrollIntoView({ block: 'center' })
      return true
    })()`)
    await sleep(300)
    results.collapsed = await shoot(call, '01-collapsed-default')

    // --- shot 2: md preview expanded --------------------------------------
    // Open a specific .md card's <details>, then click its preview toggle.
    // README.md is a single-version md with headings + a fenced code block —
    // the richest formatting to show.
    const mdOpen = await evj(`(() => {
      const card = document.querySelector('.artifact-card[data-artifact-id="README.md"]')
        || document.querySelector('.artifact-card[data-artifact-id="session.md"]')
      if (!card) return { ok: false, reason: 'no md card' }
      card.open = true
      const toggle = card.querySelector('.artifact-preview-toggle')
      if (!toggle) return { ok: false, reason: 'no toggle' }
      toggle.click()
      const region = card.querySelector('.artifact-preview-region')
      const mdBlock = card.querySelector('.artifact-preview-md')
      if (card.scrollIntoView) card.scrollIntoView({ block: 'center' })
      return {
        ok: true,
        id: card.dataset.artifactId,
        regionShown: region ? !region.hidden : null,
        hasMd: !!mdBlock,
        headings: mdBlock ? mdBlock.querySelectorAll('.md-mini-h').length : 0,
        codeBlocks: mdBlock ? mdBlock.querySelectorAll('.md-mini-pre').length : 0,
      }
    })()`)
    console.log('  md preview:', JSON.stringify(mdOpen))
    await sleep(400)
    results.md = await shoot(call, '02-md-preview-expanded')

    // --- shot 3: html iframe expanded -------------------------------------
    // Fire the debug mock-artifact path: it writes a real mock-artifact.html
    // into the artifact dir and the ArtifactServer serves it on 127.0.0.1,
    // so the event carries a live `url` the sandboxed iframe can frame.
    const htmlOpen = await evj(`(async () => {
      if (!(window.dsh && typeof window.dsh.mockArtifact === 'function'))
        return { ok: false, reason: 'no mockArtifact' }
      await window.dsh.mockArtifact()
      await new Promise(r => setTimeout(r, 700))
      const card = document.querySelector('.artifact-card[data-artifact-id="mock-artifact.html"]')
      if (!card) return { ok: false, reason: 'no mock html card' }
      card.open = true
      const toggle = card.querySelector('.artifact-preview-toggle')
      if (!toggle) return { ok: false, reason: 'no toggle' }
      toggle.click()
      if (card.scrollIntoView) card.scrollIntoView({ block: 'center' })
      return { ok: true }
    })()`)
    console.log('  html mock+open:', JSON.stringify(htmlOpen))
    // Wait for the iframe to actually fire `load` (cross-origin sandboxed
    // frame paints async; capturing before load leaves a blank frame).
    const loaded = await evj(`(async () => {
      const card = document.querySelector('.artifact-card[data-artifact-id="mock-artifact.html"]')
      const frame = card ? card.querySelector('.artifact-preview-frame') : null
      if (!frame) return { ok: false, reason: 'no frame' }
      if (frame.scrollIntoView) frame.scrollIntoView({ block: 'center' })
      await new Promise((resolve) => {
        let done = false
        const finish = () => { if (!done) { done = true; resolve() } }
        frame.addEventListener('load', finish)
        // Fallback cap in case load already fired before this listener.
        setTimeout(finish, 2500)
      })
      return { ok: true }
    })()`)
    console.log('  iframe load:', JSON.stringify(loaded))
    const frameState = await evj(`(() => {
      const card = document.querySelector('.artifact-card[data-artifact-id="mock-artifact.html"]')
      const frame = card ? card.querySelector('.artifact-preview-frame') : null
      const note = card ? card.querySelector('.artifact-preview-note') : null
      return {
        hasFrame: !!frame,
        sandbox: frame ? frame.getAttribute('sandbox') : null,
        src: frame ? frame.src : null,
        fallbackNote: note ? note.textContent.trim().slice(0, 60) : null,
      }
    })()`)
    console.log('  iframe state:', JSON.stringify(frameState))
    // Extra beat for the framed page's own paint after load.
    await sleep(900)
    results.html = await shoot(call, '03-html-iframe-expanded')

    console.log('\n--- SUMMARY ---')
    console.log('  md preview built :', mdOpen && mdOpen.ok, '(headings', mdOpen && mdOpen.headings, ', code', mdOpen && mdOpen.codeBlocks, ')')
    console.log('  html iframe      :', frameState.hasFrame, 'sandbox=', frameState.sandbox)
    console.log('  shots            :', Object.values(results).join(', '))
  } finally {
    try { child.kill('SIGKILL') } catch {}
    for (let i = 0; i < 20; i++) {
      await sleep(500)
      try { await fetch(`http://localhost:${CDP_PORT}/json/list`) } catch { break }
    }
  }
}

main().catch(err => { console.error(err); process.exit(1) })
