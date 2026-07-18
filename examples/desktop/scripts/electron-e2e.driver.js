// Real-user E2E for the DSH desktop shell. Drives the running renderer via
// CDP and asserts both bug fixes.
//
// Usage:  npx electron . --enable-logging --remote-debugging-port=9222
//         node scripts/electron-e2e.driver.js
//
// Lives under scripts/ (not test/) so node --test's auto-discovery skips it
// — it needs a live Electron instance and would otherwise fail the suite.

'use strict'

async function main() {
  const res = await fetch('http://localhost:9222/json/list')
  const targets = await res.json()
  const target = targets.find((t) => t.type === 'page' && (t.title || '').includes('DSH'))
  if (!target) throw new Error('no DSH page target — is Electron running with --remote-debugging-port=9222?')

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, x) => { ws.onopen = r; ws.onerror = x })

  let nextId = 1
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id != null && pending.has(msg.id)) {
      const [resolve, reject] = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    }
  }
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, [resolve, reject])
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evalJs = async (expr) => {
    const r = await call('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ||
                      r.exceptionDetails.text || 'eval error')
    }
    return r.result && r.result.value
  }

  const fails = []
  function assert(cond, msg) {
    if (!cond) { fails.push(msg); console.error(' FAIL', msg) }
    else console.log(' ok  ', msg)
  }

  // Wait for the renderer to expose the debug seam
  for (let i = 0; i < 20; i++) {
    const ready = await evalJs(`!!(window.__dshRenderer && window.__dshRenderer.onSessionEvent)`)
    if (ready) break
    await new Promise((r) => setTimeout(r, 250))
  }

  // Switch to Chat tab
  await evalJs(`window.__dshTabs && window.__dshTabs.switchTo && window.__dshTabs.switchTo('chat')`)

  // ---- BUG 1 --------------------------------------------------------------
  // Feed a synthetic user/message with the buggy shape (object source) and
  // assert the rendered stream does NOT contain `[object Object]`. Also
  // assert a request/header event doesn't leak into the chat.
  const bug1 = await evalJs(`(() => {
    const R = window.__dshRenderer
    const sid = 'e2e-bug1-' + Date.now()
    R.ensureSession(sid)
    return R.selectSession(sid).then(() => {
      // Case (a): user/message with object source — historical bug
      R.onSessionEvent(sid, {
        type: 'user/message',
        seq: 1,
        time: Date.now(),
        data: {
          source: { kind: 'plugin', plugin: 'compact' },
          content: [{ type: 'text', text: 'context restored from compact summary' }],
        },
      })
      // Case (b): a dev-only event that used to spam the chat
      R.onSessionEvent(sid, {
        type: 'request/header',
        seq: 2,
        time: Date.now(),
        data: { model: 'echo-1', tokens: 42 },
      })
      // Case (c): a normal user/message from the user (control)
      R.onSessionEvent(sid, {
        type: 'user/message',
        seq: 3,
        time: Date.now(),
        data: {
          source: 'user',
          content: [{ type: 'text', text: 'hello from real user test' }],
        },
      })
      return {
        text: R.getStreamText(),
        html: R.getStreamHtml(),
      }
    })
  })()`)

  console.log('\n-- stream text after bug1 injection --')
  console.log(bug1.text.slice(0, 500))

  assert(!bug1.text.includes('[object Object]'), 'bug1: no [object Object] in chat stream')
  assert(!bug1.text.includes('[[object Object]]'), 'bug1: no [[object Object]] wrapper')
  assert(bug1.text.includes('[plugin:compact]'), 'bug1: object source rendered as [plugin:compact]')
  assert(bug1.text.includes('context restored from compact summary'),
         'bug1: compact source content shown')
  assert(!bug1.text.includes('request/header'), 'bug1: request/header event NOT in chat')
  assert(bug1.text.includes('hello from real user test'),
         'bug1: normal user message still renders')

  // ---- BUG 2 --------------------------------------------------------------
  // Fill session A with a live conversation. Switch to a new session B.
  // Switch back to A. Assert the conversation is still there — the daemon
  // hasn't persisted anything (we didn't call it), so this exclusively
  // exercises the in-memory cache path.
  const bug2 = await evalJs(`(async () => {
    const R = window.__dshRenderer
    const sidA = 'e2e-bug2-A-' + Date.now()
    const sidB = 'e2e-bug2-B-' + Date.now()
    R.ensureSession(sidA)
    R.ensureSession(sidB)
    await R.selectSession(sidA)
    // Simulate a full turn
    R.onSessionEvent(sidA, {
      type: 'user/message', seq: 1, time: Date.now(),
      data: { source: 'user', content: [{ type: 'text', text: 'draw a heat map SVG' }] },
    })
    R.onSessionEvent(sidA, {
      type: 'assistant/message', seq: 2, time: Date.now(),
      data: { content: [{ type: 'text', text: 'here is the SVG source…' }] },
    })
    R.onSessionEvent(sidA, {
      type: 'turn/end', seq: 3, time: Date.now(), data: { reason: { kind: 'end' } },
    })
    const beforeSwitch = R.getStreamText()

    // Switch away, then back
    await R.selectSession(sidB)
    const afterSwitchAway = R.getStreamText()
    await R.selectSession(sidA)
    const afterSwitchBack = R.getStreamText()

    return { beforeSwitch, afterSwitchAway, afterSwitchBack }
  })()`)

  console.log('\n-- bug2: before/after switch --')
  console.log('before (in A):', bug2.beforeSwitch.slice(-200))
  console.log('after switch away (B):', bug2.afterSwitchAway.slice(-200))
  console.log('after switch back to A:', bug2.afterSwitchBack.slice(-300))

  assert(bug2.beforeSwitch.includes('draw a heat map SVG'),
         'bug2: user message present in session A before switch')
  assert(bug2.beforeSwitch.includes('here is the SVG source'),
         'bug2: assistant reply present before switch')
  // After switch away, stream should be empty (B is fresh)
  assert(!bug2.afterSwitchAway.includes('heat map SVG'),
         'bug2: session B does not show A\'s history')
  // After switching back, both messages must be there
  assert(bug2.afterSwitchBack.includes('draw a heat map SVG'),
         'bug2: user message restored after switch-back')
  assert(bug2.afterSwitchBack.includes('here is the SVG source'),
         'bug2: assistant reply restored after switch-back')

  ws.close()
  console.log(fails.length === 0 ? '\nall real-user E2E assertions passed.' : `\n${fails.length} failure(s).`)
  process.exit(fails.length === 0 ? 0 : 1)
}

main().catch((err) => { console.error(err); process.exit(1) })
