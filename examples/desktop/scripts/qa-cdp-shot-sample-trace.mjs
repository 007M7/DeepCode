// Shot the empty-state → sample-trace path. Load the trace, wait for
// multiple card families to appear in the stream, then capture.

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const port = process.argv[2] || '9236'
const outdir = process.argv[3] || 'docs/demo-shots'
const name = process.argv[4] || 'nav-03'

async function main() {
  const listRes = await fetch(`http://localhost:${port}/json/list`)
  const targets = await listRes.json()
  const target = targets.find((t) => t.type === 'page')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, x) => { ws.onopen = r; ws.onerror = (e) => x(e) })

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
  const call = (m, p = {}, t = 20000) => new Promise((ok, err) => {
    const _id = id++
    const timer = setTimeout(() => { pending.delete(_id); err(new Error(`timeout ${m}`)) }, t)
    pending.set(_id, [(v) => { clearTimeout(timer); ok(v) }, (e) => { clearTimeout(timer); err(e) }])
    ws.send(JSON.stringify({ id: _id, method: m, params: p }))
  })
  const ev = async (js) => {
    const r = await call('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result?.value
  }

  await call('Page.enable')
  await ev(`window.dshQa && window.dshQa.revealWindow()`)
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })

  // Ensure we're on chat + sample trace path
  await ev(`window.__dshTabs && window.__dshTabs.switchTo('chat')`)
  await new Promise((r) => setTimeout(r, 300))
  // Kick the load-sample-trace path via the exposed helper.
  const loaded = await ev(`(async()=>{try{await window.__dshLoadSampleTrace();return 'ok'}catch(e){return String(e)}})()`)
  console.error(`load sample -> ${loaded}`)
  // Wait for card families to appear.
  const stableCheck = await ev(`(async()=>{
    for (let i=0; i<40; i++) {
      const stream = document.querySelector('.stream');
      if (stream) {
        const families = {
          reasoning: !!document.querySelector('.reasoning-block, [data-card-family="reasoning"]'),
          partialTool: !!document.querySelector('[data-tool-card-family], .tool-row'),
          compactCard: !!document.querySelector('.compact-card, [data-card-family="compact"]'),
          subagent: !!document.querySelector('.subagent-view, [data-subagent-inline]'),
          turnFooter: !!document.querySelector('.turn-footer, [data-turn-footer]'),
          turnContainer: !!document.querySelector('.assistant-turn, .turn-container'),
        };
        const hit = Object.values(families).filter(Boolean).length;
        if (hit >= 3 || i > 30) return { families, hit, i };
      }
      await new Promise(r => setTimeout(r, 200));
    }
    return { done: false };
  })()`)
  console.error(`stable -> ${JSON.stringify(stableCheck)}`)
  await new Promise((r) => setTimeout(r, 600))

  const shot = await call('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: 1440, height: 900, scale: 1 },
  })
  await call('Emulation.clearDeviceMetricsOverride')
  const path = resolve(outdir, `${name}.png`)
  writeFileSync(path, Buffer.from(shot.data, 'base64'))
  console.log(path)
  ws.close()
}
main().catch((e) => { console.error(String(e)); process.exit(1) })
