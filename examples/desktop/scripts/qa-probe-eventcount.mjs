// Probe live 9224 for eventCount / hasUserMessage distribution on session/list.
// Same raw-WebSocket pattern as qa-cdp-shot.mjs (built-in WS = no Origin).
const port = process.argv[2] || '9224'
const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const target = tabs.find(t => t.type === 'page' && t.url && t.url.startsWith('file://'))
if (!target) { console.error('no page target'); process.exit(1) }
const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
function call(method, params={}) {
  const nid = ++id
  return new Promise((res, rej) => {
    pending.set(nid, { res, rej })
    ws.send(JSON.stringify({ id: nid, method, params }))
  })
}
await new Promise(r => ws.addEventListener('open', r, { once: true }))
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) }
})
await call('Runtime.enable')
const r = await call('Runtime.evaluate', {
  expression: `(async () => {
    const sessions = window.__dshChat && window.__dshChat.getSessions ? window.__dshChat.getSessions() : []
    const arr = Array.isArray(sessions) ? sessions : []
    const total = arr.length
    let withEC = 0, ecZero = 0, ecUndef = 0, huTrue = 0, huUndef = 0
    for (const s of arr) {
      if (typeof s.eventCount === 'number') { withEC++; if (s.eventCount === 0) ecZero++ }
      else ecUndef++
      if (s.hasUserMessage === true) huTrue++
      else if (s.hasUserMessage === undefined) huUndef++
    }
    return JSON.stringify({ total, withEC, ecZero, ecUndef, huTrue, huUndef, sample: arr.slice(0,3).map(s => ({ id: s.sessionId && s.sessionId.slice(0,8), eventCount: s.eventCount, hasUserMessage: s.hasUserMessage, live: s.live, persisted: s.persisted, title: s.header && s.header.title })) })
  })()`,
  returnByValue: true,
  awaitPromise: true,
})
console.log(r.result && r.result.value)
ws.close()
