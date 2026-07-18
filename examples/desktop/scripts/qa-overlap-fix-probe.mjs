// payload-controls overlap regression probe (2026-07-18 delta).
//
// Boots a fresh isolated Electron instance, injects tool blocks with a
// long meta suffix ("(content · meta · isError · error · durationMs)"),
// opens the JSON drawer, then asserts via getBoundingClientRect() that
// the button cluster (pretty ⇅ raw · copy · download) does NOT overlap
// the label / meta text at either width.
//
// Four payload-controls mount points get exercised — matches the shipped
// (merged) fix from da779ac (`fix/ui-hotfix-drawer-overlap` -> 9743db1):
//   A) inline tool-block args      renderer.js:1226 → `.tool-block-label-row`
//   B) inline tool-block result    renderer.js:1249 → `.tool-block-label-row`
//   C) tool-json-drawer sections   tool-cards.js:663 → `.tool-json-section-controls[data-drawer-controls]`
//   D) trace-detail Render=JSON    trace-detail-pane.js:1512 → `.trace-detail-json-panel`
//                                   (no-op verify — mount is flex-column,
//                                   controls right-anchor via margin-left)
//
// Runs the app under a private user-data dir + dedicated CDP port so it
// never collides with the user's own Electron. Kills the child on exit.
//
// Usage: `pnpm exec node scripts/qa-overlap-fix-probe.mjs [outDir]`.
// Requires the electron binary at `node_modules/.bin/electron`. When run
// in a worktree that has never had `pnpm install` executed there, either
// (a) run `pnpm install` locally, or (b) symlink `node_modules` in from
// the primary checkout — see docs/qa-overlap-fix/README.md.

import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PORT = Number(process.env.OVERLAP_PROBE_PORT || 9247)
const outDir = resolve(process.argv[2] || 'docs/qa-overlap-fix')
mkdirSync(outDir, { recursive: true })

const userData = mkdtempSync(join(tmpdir(), 'dsh-overlap-fix-'))
const electronBin = resolve('node_modules/.bin/electron')

const child = spawn(electronBin, [
  '.',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userData}`,
  '--no-first-run',
], {
  env: {
    ...process.env,
    DSH_QA: '1',
    DSH_MAXIMIZE: '0',
    DSH_ONBOARDING_SKIP: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let bootLog = ''
child.stdout.on('data', (b) => { bootLog += b.toString() })
child.stderr.on('data', (b) => { bootLog += b.toString() })

async function cleanup(code) {
  try { child.kill('SIGKILL') } catch {}
  try { rmSync(userData, { recursive: true, force: true }) } catch {}
  process.exit(code)
}
process.on('SIGINT', () => cleanup(130))
process.on('SIGTERM', () => cleanup(143))

async function waitForCdp(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${port}/json/list`)
      const list = await r.json()
      const page = list.find((t) => t.type === 'page')
      if (page && page.webSocketDebuggerUrl) return page
    } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`CDP not up on port ${port} after ${timeoutMs}ms; boot log:\n${bootLog}`)
}

async function main() {
  const page = await waitForCdp(PORT)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, x) => { ws.onopen = r; ws.onerror = (e) => x(new Error(String(e))) })
  let id = 1
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
    if (msg.id != null && pending.has(msg.id)) {
      const [ok, err] = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) err(new Error(msg.error.message))
      else ok(msg.result)
    }
  }
  const call = (m, p = {}, timeoutMs = 15000) => new Promise((ok, err) => {
    const _id = id++
    const timer = setTimeout(() => { pending.delete(_id); err(new Error('cdp timeout: ' + m)) }, timeoutMs)
    pending.set(_id, [(v) => { clearTimeout(timer); ok(v) }, (e) => { clearTimeout(timer); err(e) }])
    ws.send(JSON.stringify({ id: _id, method: m, params: p }))
  })
  const evj = async (expr) => {
    const r = await call('Runtime.evaluate', {
      expression: `(async()=>{try{return (${expr})}catch(e){return {__err: String(e)}}})()`,
      returnByValue: true, awaitPromise: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result?.value
  }

  await call('Page.enable')
  await evj(`window.dshQa && window.dshQa.revealWindow ? await window.dshQa.revealWindow() : null`)

  const results = []
  for (const w of [1440, 800]) {
    await call('Emulation.setDeviceMetricsOverride', {
      width: w, height: 900, deviceScaleFactor: 2, mobile: false,
    })
    await new Promise((r) => setTimeout(r, 400))

    // Inject a synthetic tool-block that mirrors renderer.js appendToolCall's
    // POST-fix shape (`.tool-block-label-row` wrapper containing `.label` and
    // the util's controls). We build the DOM directly rather than call
    // appendToolCall so we can stress-test with an intentionally long meta
    // suffix — that string is what pulled the buttons on top of the label
    // in the pre-fix bug.
    const injected = await evj(`(function(){
      const stream = document.getElementById('stream')
      if (!stream) return {ok:false, why:'no stream'}
      for (const el of stream.querySelectorAll('.tool-block.qa-overlap-fix')) el.remove()

      const details = document.createElement('details')
      details.className = 'tool-block qa-overlap-fix'
      details.setAttribute('data-tool-name', 'bash')
      details.setAttribute('data-tool-card-family', 'bash')
      details.setAttribute('open', '')
      const summary = document.createElement('summary')
      summary.textContent = 'bash — running the full test battery with a really long argument gist that should ellipsis and never overlap'
      details.appendChild(summary)

      const pc = window.__dshPayloadControls

      // (A) args row
      const argsRow = document.createElement('div')
      argsRow.className = 'tool-block-label-row'
      const argLabel = document.createElement('div')
      argLabel.className = 'label'
      argLabel.textContent = 'args (content · meta · isError · error · durationMs · plus even more meta text to stress-test)'
      argsRow.appendChild(argLabel)
      const argsBox = document.createElement('div')
      argsBox.className = 'args args-with-controls'
      if (pc && pc.attachPayloadControls) {
        const ret = pc.attachPayloadControls(argsRow, { getRaw: () => ({command: 'pnpm test'}), kind: 'args' })
        if (ret && ret.preEl && ret.preEl.parentNode) {
          ret.preEl.parentNode.removeChild(ret.preEl)
          argsBox.appendChild(ret.preEl)
        }
      }

      // (B) result row
      const resultRow = document.createElement('div')
      resultRow.className = 'tool-block-label-row'
      const resLabel = document.createElement('div')
      resLabel.className = 'label'
      resLabel.textContent = 'result (content · meta · isError · error · durationMs)'
      resultRow.appendChild(resLabel)
      const resBox = document.createElement('div')
      resBox.className = 'result result-with-controls'
      if (pc && pc.attachPayloadControls) {
        const ret = pc.attachPayloadControls(resultRow, { getRaw: () => ({ok: true, output: 'PASS'}), kind: 'result' })
        if (ret && ret.preEl && ret.preEl.parentNode) {
          ret.preEl.parentNode.removeChild(ret.preEl)
          resBox.appendChild(ret.preEl)
        }
      }

      details.appendChild(argsRow); details.appendChild(argsBox)
      details.appendChild(resultRow); details.appendChild(resBox)
      stream.appendChild(details)
      details.scrollIntoView({block:'center'})
      return {ok:true, id:'qa-overlap-fix'}
    })()`)
    if (!injected || !injected.ok) throw new Error('inject failed: ' + JSON.stringify(injected))

    await new Promise((r) => setTimeout(r, 300))

    // (C) open the drawer for the third callsite.
    const drawerRes = await evj(`(function(){
      const tc = window.__dshToolCards
      if (!tc || !tc.openJsonDrawer) return {ok:false, why:'no drawer api'}
      tc.openJsonDrawer({
        title: 'bash — a very long tool title used for the drawer overlap probe',
        call: { arguments: { command: 'pnpm test' } },
        result: { content: [{type:'text',text:'PASS'}], meta:{card:'generic'}, isError:false, durationMs:48 }
      })
      return {ok:true}
    })()`)
    if (!drawerRes || !drawerRes.ok) throw new Error('drawer open failed: ' + JSON.stringify(drawerRes))
    await new Promise((r) => setTimeout(r, 300))

    // Measure geometry — post-fix, controls sit inside the same flex row
    // as the label, right-anchored. The only failure mode we still guard
    // against is horizontal overlap between the label text rect and the
    // controls cluster rect (which happens if the flex breaks or someone
    // reintroduces float/negative-margin).
    const geom = await evj(`(function(){
      function rectOf(el){ if(!el) return null; const r=el.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height} }
      function overlapY(a,b){ if(!a||!b) return null; const top=Math.max(a.top,b.top); const bot=Math.min(a.bottom,b.bottom); return Math.max(0, bot-top) }
      function hOverlap(a,b){ if(!a||!b) return null; const left=Math.max(a.left,b.left); const right=Math.min(a.right,b.right); return Math.max(0, right-left) }

      const details = document.querySelector('.tool-block.qa-overlap-fix')
      if (!details) return {err:'no details'}
      const rows = details.querySelectorAll('.tool-block-label-row')
      const argRow = rows[0]
      const resRow = rows[1]
      const argLabel = argRow ? argRow.querySelector('.label') : null
      const argCtl = argRow ? argRow.querySelector('.payload-controls') : null
      const resLabel = resRow ? resRow.querySelector('.label') : null
      const resCtl = resRow ? resRow.querySelector('.payload-controls') : null

      const drawer = document.getElementById('tool-json-drawer')
      const drawerSummary = drawer ? drawer.querySelector('.tool-json-section summary') : null
      const drawerCtlStrip = drawer ? drawer.querySelector('.tool-json-section-controls[data-drawer-controls]') : null
      const drawerCtl = drawerCtlStrip ? drawerCtlStrip.querySelector('.payload-controls') : null

      return {
        argsRow: { label: rectOf(argLabel), controls: rectOf(argCtl), hOverlap: hOverlap(rectOf(argLabel), rectOf(argCtl)) },
        resultRow: { label: rectOf(resLabel), controls: rectOf(resCtl), hOverlap: hOverlap(rectOf(resLabel), rectOf(resCtl)) },
        drawer: { summary: rectOf(drawerSummary), controls: rectOf(drawerCtl), vOverlap: overlapY(rectOf(drawerSummary), rectOf(drawerCtl)) },
      }
    })()`)
    results.push({ width: w, geom })

    // Screenshot for eye verification alongside the geom log.
    const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const path = join(outDir, `overlap-w${w}.png`)
    writeFileSync(path, Buffer.from(shot.data, 'base64'))

    await evj(`window.__dshToolCards && window.__dshToolCards.closeJsonDrawer && window.__dshToolCards.closeJsonDrawer()`)
    await new Promise((r) => setTimeout(r, 200))
  }

  writeFileSync(join(outDir, 'geom-trace.log'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results, null, 2))

  let bad = 0
  for (const { width, geom } of results) {
    if (!geom || geom.__err) { console.error('geom error at width', width, geom); bad++; continue }
    const a = geom.argsRow, r = geom.resultRow, d = geom.drawer
    // The flex row wraps at narrow widths (flex-wrap: wrap on
    // .tool-block-label-row) — when it wraps, controls drop onto their
    // own line under the label, so hOverlap can become non-zero but
    // vOverlap between label and controls is 0. Guard against actual
    // stack-on-same-line overlap (both non-zero) rather than either alone.
    if (a && a.label && a.controls) {
      const sameLine = Math.abs((a.label.top + a.label.height/2) - (a.controls.top + a.controls.height/2)) < Math.max(a.label.height, a.controls.height)
      if (sameLine && a.hOverlap > 0.5) {
        console.error('args row: label ↔ controls overlap on same line =', a.hOverlap, 'px at width', width); bad++
      }
    }
    if (r && r.label && r.controls) {
      const sameLine = Math.abs((r.label.top + r.label.height/2) - (r.controls.top + r.controls.height/2)) < Math.max(r.label.height, r.controls.height)
      if (sameLine && r.hOverlap > 0.5) {
        console.error('result row: label ↔ controls overlap on same line =', r.hOverlap, 'px at width', width); bad++
      }
    }
    if (d && d.vOverlap > 0.5) {
      console.error('drawer: summary ↔ controls vertical overlap =', d.vOverlap, 'px at width', width); bad++
    }
  }
  if (bad) {
    console.error(`FAIL — ${bad} overlap(s) still present`)
    await cleanup(1)
  }
  console.log(`PASS — no overlaps at widths ${results.map((r) => r.width).join(', ')}`)
  await cleanup(0)
}

main().catch(async (e) => { console.error('probe error:', e && e.stack || e); await cleanup(2) })
