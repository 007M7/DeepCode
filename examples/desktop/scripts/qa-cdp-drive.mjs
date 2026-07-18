// Simple CDP driver for the running DSH Electron shell — used by QA
// walkthrough passes (see docs/qa-walkthrough-round2.md) to drive the live
// app from a shell script.
//
// Prereqs: launch Electron with --remote-debugging-port=9222. Uses Node's
// built-in WebSocket (no Origin header) so Chromium doesn't 403 the connect
// the way a browser-origin WS would. Same-family tool as test/electron-e2e.js.
//
// Usage:  node test/qa-cdp-drive.mjs <cmd> [args...]
//   eval <js>             — run js in page, print JSON result
//   click <selector>      — document.querySelector(selector).click()
//   settab <tab-key>       — call window.__dshTabs.switchTo(tab)
//   mtab <mission-key>     — click .mission-subview-tab[data-mission-tab=key]
//   waitfor <selector>     — poll up to 3s for the selector, print bool

const [,, cmd, ...rest] = process.argv

async function main() {
  const res = await fetch('http://localhost:9222/json/list')
  const targets = await res.json()
  const target = targets.find((t) => t.type === 'page')
  if (!target) throw new Error('no page target')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, x) => { ws.onopen = r; ws.onerror = (e) => x(e) })
  let id = 1
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id != null && pending.has(msg.id)) {
      const [ok, err] = pending.get(msg.id); pending.delete(msg.id)
      if (msg.error) err(new Error(msg.error.message)); else ok(msg.result)
    }
  }
  const call = (m, p = {}) => new Promise((ok, err) => {
    const _id = id++; pending.set(_id, [ok, err])
    ws.send(JSON.stringify({ id: _id, method: m, params: p }))
  })
  const ev = async (js) => {
    const r = await call('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result?.value
  }

  let out
  if (cmd === 'eval')     out = await ev(rest.join(' '))
  else if (cmd === 'click')   out = await ev(`(function(){const el=document.querySelector(${JSON.stringify(rest[0])}); if(!el) return 'NO_ELEMENT'; el.click(); return 'OK'})()`)
  else if (cmd === 'settab')  out = await ev(`window.__dshTabs && window.__dshTabs.switchTo && window.__dshTabs.switchTo(${JSON.stringify(rest[0])})`)
  else if (cmd === 'mtab')    out = await ev(`(function(){const el=document.querySelector('.mission-subview-tab[data-mission-tab='+${JSON.stringify(rest[0])}+']'); if(!el) return 'NO_MTAB'; el.click(); return 'OK'})()`)
  else if (cmd === 'waitfor') out = await ev(`(async()=>{for(let i=0;i<15;i++){if(document.querySelector(${JSON.stringify(rest[0])})) return true; await new Promise(r=>setTimeout(r,200))} return false})()`)
  else throw new Error('unknown cmd '+cmd)
  console.log(typeof out === 'string' ? out : JSON.stringify(out))
  ws.close()
}
main().catch((e) => { console.error(String(e)); process.exit(1) })
