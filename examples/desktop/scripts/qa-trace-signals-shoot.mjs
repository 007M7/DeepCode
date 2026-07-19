// qa-trace-signals-shoot.mjs — lane-trace-signals selfie driver.
//
// Three shots proving the trace signal overlays (feat/trace-signals):
//   signals-01  Timeline view — loop-detected + redundant-call badges
//                in the left gutter of a loop-heavy step-record
//   signals-02  Graph view — colored ring around a tool-error node
//   signals-03  Turn footer — signal chip row above the assistant body
//                with three signal kinds (loop/redundant/plan) chips
//
// Requires the desktop shell running via `pnpm --dir examples/desktop start`
// with --remote-debugging-port=<port> exposed. In an env without electron,
// see scripts/qa-trace-signals-fixture.mjs for a headless SVG render that
// exercises the exact rendering code paths — enough for a diff-review.
//
// Usage:
//   node scripts/qa-trace-signals-shoot.mjs <port> <outdir>

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const [,, portArg, outdir] = process.argv
const port = portArg || '9241'
if (!outdir) {
  console.error('usage: node scripts/qa-trace-signals-shoot.mjs <port> <outdir>')
  process.exit(1)
}
mkdirSync(outdir, { recursive: true })

async function cdp() {
  const listRes = await fetch(`http://localhost:${port}/json/list`)
  const targets = await listRes.json()
  const target = targets.find((t) => t.type === 'page')
  if (!target) throw new Error('no page target on port ' + port)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, x) => { ws.onopen = r; ws.onerror = (e) => x(e) })
  let id = 1
  const pending = new Map()
  ws.onmessage = (ev) => {
    const data = typeof ev.data === 'string' ? ev.data : String(ev.data)
    let msg; try { msg = JSON.parse(data) } catch { return }
    if (msg.id != null && pending.has(msg.id)) {
      const [ok, err] = pending.get(msg.id); pending.delete(msg.id)
      if (msg.error) err(new Error(msg.error.message)); else ok(msg.result)
    }
  }
  const call = (m, p = {}, timeoutMs = 60000) => new Promise((ok, err) => {
    const _id = id++
    const t = setTimeout(() => { pending.delete(_id); err(new Error(`cdp timeout: ${m}`)) }, timeoutMs)
    pending.set(_id, [(v) => { clearTimeout(t); ok(v) }, (e) => { clearTimeout(t); err(e) }])
    ws.send(JSON.stringify({ id: _id, method: m, params: p }))
  })
  const evjs = async (js) => {
    const r = await call('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result?.value
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  return { call, evjs, sleep, close: () => ws.close() }
}

async function shoot(c, name, opts) {
  const { fixture, prep, wait = 500 } = opts
  await c.evjs(`(function () {
    const fx = ${JSON.stringify(fixture)};
    // Inject fixture into a fresh session and force a re-render.
    const chat = window.__dshChat; if (!chat) throw new Error('__dshChat missing');
    const id = chat.newSession ? chat.newSession('trace-signals-' + '${name}') : 'trace-signals-${name}';
    const meta = window.__dshState && window.__dshState.sessions
      ? window.__dshState.sessions.get(id) : null;
    if (meta) { meta.cachedEvents = fx.events.slice(); }
    if (typeof window.__dshQaReplayFixture === 'function') {
      window.__dshQaReplayFixture(id, fx.events);
    }
    return id;
  })()`)
  await c.sleep(wait)
  if (typeof prep === 'function') await prep(c)
  const shot = await c.call('Page.captureScreenshot', { format: 'png' })
  const buf = Buffer.from(shot.data, 'base64')
  const out = resolve(outdir, `${name}.png`)
  writeFileSync(out, buf)
  console.log('wrote', out)
}

async function main() {
  const c = await cdp()
  try {
    // Fixture 1: three identical fs.read calls → loop-detected + redundant
    await shoot(c, 'signals-01-timeline-loop', {
      fixture: {
        events: [
          { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
          { type: 'step/start', seq: 2, time: 1010, data: { turn: 1, step: 0 } },
          { type: 'tool/call', seq: 3, time: 1050, data: { name: 'fs.read', arguments: '{"path":"main.ts"}', callId: 'c1' } },
          { type: 'tool/result', seq: 4, time: 1080, data: { callId: 'c1', ok: true } },
          { type: 'tool/call', seq: 5, time: 1100, data: { name: 'fs.read', arguments: '{"path":"main.ts"}', callId: 'c2' } },
          { type: 'tool/result', seq: 6, time: 1130, data: { callId: 'c2', ok: true } },
          { type: 'tool/call', seq: 7, time: 1150, data: { name: 'fs.read', arguments: '{"path":"main.ts"}', callId: 'c3' } },
          { type: 'tool/result', seq: 8, time: 1180, data: { callId: 'c3', ok: true } },
          { type: 'step/end', seq: 9, time: 1200, data: { turn: 1, step: 0 } },
          { type: 'turn/end', seq: 10, time: 1210 },
        ],
      },
      // Open the trace drawer and switch to Timeline
      prep: async (c) => {
        await c.evjs(`(function () {
          const drawer = document.querySelector('.turn-trace-drawer');
          if (drawer) drawer.open = true;
          const btn = document.querySelector('.trace-tri-chip.chip-timeline');
          if (btn) btn.click();
        })()`)
        await c.sleep(300)
      },
    })

    // Fixture 2: tool error → red ring on the graph node
    await shoot(c, 'signals-02-graph-error', {
      fixture: {
        events: [
          { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
          { type: 'step/start', seq: 2, time: 1010, data: { turn: 1, step: 0 } },
          { type: 'tool/call', seq: 3, time: 1050, data: { name: 'bash', arguments: 'ls /nope', callId: 'c1' } },
          { type: 'tool/result', seq: 4, time: 1080, data: { callId: 'c1', ok: false, error: 'ENOENT: no such file or directory' } },
          { type: 'tool/call', seq: 5, time: 1100, data: { name: 'bash', arguments: 'ls /tmp', callId: 'c2' } },
          { type: 'tool/result', seq: 6, time: 1130, data: { callId: 'c2', ok: true } },
          { type: 'step/end', seq: 7, time: 1200, data: { turn: 1, step: 0 } },
          { type: 'turn/end', seq: 8, time: 1210 },
        ],
      },
      prep: async (c) => {
        await c.evjs(`(function () {
          const drawer = document.querySelector('.turn-trace-drawer');
          if (drawer) drawer.open = true;
          const btn = document.querySelector('.trace-tri-chip.chip-graph');
          if (btn) btn.click();
        })()`)
        await c.sleep(300)
      },
    })

    // Fixture 3: plan-update + loop → chips above turn body
    await shoot(c, 'signals-03-chips-plan', {
      fixture: {
        events: [
          { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
          { type: 'assistant/message', seq: 2, time: 1050, data: { content: [{ type: 'text', text: 'Here is the new plan: 1. read main.ts\n2. edit imports\n3. verify' }] } },
          { type: 'tool/call', seq: 3, time: 1100, data: { name: 'fs.read', arguments: '{"path":"main.ts"}', callId: 'c1' } },
          { type: 'tool/call', seq: 4, time: 1150, data: { name: 'fs.read', arguments: '{"path":"main.ts"}', callId: 'c2' } },
          { type: 'tool/call', seq: 5, time: 1200, data: { name: 'fs.read', arguments: '{"path":"main.ts"}', callId: 'c3' } },
          { type: 'turn/end', seq: 6, time: 1210 },
        ],
      },
    })
  } finally {
    c.close()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
