// Tests for lane-p1-tabs — Chat-pane view strip expansion + Tracing-page
// demotion. Covers:
//   - index.html declares the five-way view strip (List | Graph | 时序 |
//     Trace | Log) and the three new mount containers + script tag.
//   - style.css hides/show the right container per data-chat-view value.
//   - renderer.js setChatView flips data-chat-view + aria-selected across all
//     five views and only shows one at a time.
//   - the session-scoped Trace tab renders the tri-view over the active
//     session's aggregate.
//   - tracing-page.openDrill navigates (window.__dshOpenSessionTrace) rather
//     than swapping the table inline.
//   - the Chat-pane openSessionTrace bridge switches tab + selects session +
//     opens the Trace view in one call.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadRenderer } = require('./renderer-harness.js')

const RENDERER = path.join(__dirname, '..', 'src', 'renderer')

// renderer.js captures `chatPaneEl = document.querySelector('.pane[data-pane
// ="chat"]')` and the `.chat-view-tab` buttons at module-eval, so the harness
// body must carry that scaffold before renderer.js runs. The preboot hook
// fires before renderer.js; seed a chat pane + the five tab buttons + the
// view mounts so setChatView / getChatView resolve real nodes.
function seedChatPane(win) {
  const doc = win.document
  const pane = doc.createElement('section')
  pane.className = 'pane'
  pane.dataset.pane = 'chat'
  const tabs = doc.createElement('div')
  tabs.className = 'chat-view-tabs'
  for (const v of ['list', 'graph', 'timeline', 'trace', 'log']) {
    const btn = doc.createElement('button')
    btn.className = 'chat-view-tab' + (v === 'list' ? ' active' : '')
    btn.dataset.chatViewTab = v
    tabs.appendChild(btn)
  }
  pane.appendChild(tabs)
  doc.body.appendChild(pane)
}

function bootWithChatPane() {
  return loadRenderer({}, { preboot: (win) => seedChatPane(win) })
}

// ─── static gates: index.html + style.css ───────────────────────────────────

test('index.html declares the five-way Chat view strip', () => {
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8')
  for (const v of ['list', 'graph', 'timeline', 'trace', 'log']) {
    assert.match(html, new RegExp(`data-chat-view-tab="${v}"`), `missing view tab ${v}`)
  }
  // The 时序 tab label is the CN string per the deliverable.
  assert.match(html, /data-chat-view-tab="timeline"[^>]*>时序</, '时序 tab must carry the CN label')
})

test('index.html mounts the three new view containers + log script', () => {
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8')
  assert.match(html, /id="chat-session-timeline"/, 'timeline mount missing')
  assert.match(html, /id="chat-session-trace"/, 'trace mount missing')
  assert.match(html, /id="chat-session-log"/, 'log mount missing')
  assert.match(html, /session-log-view\.js/, 'session-log-view.js script tag missing')
})

test('style.css toggles each alternate view container off in list mode', () => {
  const css = fs.readFileSync(path.join(RENDERER, 'style.css'), 'utf8')
  // Each of the four non-list views hides the stream when active.
  for (const v of ['graph', 'timeline', 'trace', 'log']) {
    assert.match(css, new RegExp(`data-chat-view="${v}"\\][^{]*\\.stream\\s*\\{\\s*display:\\s*none`),
      `stream should hide when ${v} is active`)
  }
  // The timeline/trace/log containers default to display:none (shown only
  // when their own view value is active).
  assert.match(css, /\.chat-session-timeline[\s\S]*?display:\s*none/, 'timeline default hidden rule missing')
})

// ─── behavioral: setChatView ─────────────────────────────────────────────────

test('setChatView flips data-chat-view + aria-selected across all five views', async () => {
  const { window, document } = await bootWithChatPane()
  const R = window.__dshRenderer
  const pane = document.querySelector('.pane[data-pane="chat"]')
  assert.ok(pane, 'chat pane present')
  for (const v of ['graph', 'timeline', 'trace', 'log', 'list']) {
    R.setChatView(v)
    assert.equal(R.getChatView(), v, `data-chat-view should be ${v}`)
    assert.equal(pane.dataset.chatView, v)
  }
})

test('setChatView falls back to list on an unknown view', async () => {
  const { window } = await bootWithChatPane()
  const R = window.__dshRenderer
  R.setChatView('bogus')
  assert.equal(R.getChatView(), 'list')
})

test('Trace tab renders a tri-view over the active session aggregate', async () => {
  const { window, document } = await bootWithChatPane()
  const R = window.__dshRenderer
  // The trace tri-view + aggregator modules are require()'d into the harness
  // and read their globals off Node's `global.window`, while renderer.js runs
  // against the harness windowStub. In the browser these are one object; here
  // we bridge global.window to the harness window for the duration of the
  // test so tri-view.sessionTraceRecords can see __dshTraceAgg. Save/restore
  // so the mutation doesn't leak to sibling tests.
  const savedWin = global.window
  global.window = window
  try {
    // Seed a session with a step so aggregateSteps yields ≥1 record.
    const sid = 's-trace-1'
    R.ensureSession(sid)
    R.state.activeSessionId = sid
    const meta = R.getSessionMeta(sid)
    meta.cachedEvents = [
      { type: 'step/start', seq: 1, time: 1000, data: { turn: 0, step: 0 } },
      { type: 'assistant/message', seq: 2, time: 1100, data: { text: 'working' } },
      { type: 'step/end', seq: 3, time: 1500, data: {} },
    ]
    R.setChatView('trace')
    const traceEl = document.getElementById('chat-session-trace')
    const triviews = traceEl.querySelectorAll('.trace-tri-view')
    assert.equal(triviews.length, 1, 'a single tri-view mounts full-pane in the Trace tab')
  } finally {
    global.window = savedWin
  }
})

test('Trace tab shows the empty state when the session has no steps', async () => {
  const { window, document } = await bootWithChatPane()
  const R = window.__dshRenderer
  const sid = 's-trace-empty'
  R.ensureSession(sid)
  R.state.activeSessionId = sid
  R.getSessionMeta(sid).cachedEvents = []
  R.setChatView('trace')
  const traceEl = document.getElementById('chat-session-trace')
  assert.equal(traceEl.querySelectorAll('.chat-session-view-empty').length, 1)
  assert.equal(traceEl.querySelectorAll('.trace-tri-view').length, 0)
})

// ─── behavioral: Tracing-page demotion ───────────────────────────────────────

test('tracing-page.openDrill navigates via __dshOpenSessionTrace', () => {
  const src = fs.readFileSync(path.join(RENDERER, 'tracing-page.js'), 'utf8')
  // openDrill prefers the Chat-pane bridge; inline tri-view is the fallback.
  assert.match(src, /window\.__dshOpenSessionTrace/, 'openDrill must call the nav bridge')
  assert.match(src, /function openDrillInline/, 'inline drill retained as a named fallback')
  // The dead inline path must not be the default drill any more: openDrill's
  // body routes through the bridge before touching the table swap.
  const openDrillBody = src.match(/function openDrill \([\s\S]*?\n  \}/)
  assert.ok(openDrillBody, 'openDrill function found')
  assert.match(openDrillBody[0], /__dshOpenSessionTrace/, 'openDrill routes to the bridge first')
})

test('openSessionTrace bridge switches tab, selects session, opens Trace view', async () => {
  const { window } = await bootWithChatPane()
  const R = window.__dshRenderer
  // Spy the tab switch.
  const switched = []
  window.__dshTabs = { switchTo: (name) => switched.push(name) }
  const sid = 's-nav-1'
  R.ensureSession(sid)
  R.getSessionMeta(sid).cachedEvents = [
    { type: 'step/start', seq: 1, time: 1, data: { turn: 0, step: 0 } },
    { type: 'step/end', seq: 2, time: 2, data: {} },
  ]
  await R.openSessionTrace(sid)
  assert.deepEqual(switched, ['chat'], 'navigates to the Chat pane')
  assert.equal(R.getActiveSessionId(), sid, 'selects the drilled session')
  assert.equal(R.getChatView(), 'trace', 'opens the Trace tab')
})
