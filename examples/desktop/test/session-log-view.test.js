// Tests for lane-p1-tabs — src/renderer/session-log-view.js.
//
// The Log tab is the Chat pane's full-history event log for the ACTIVE
// session: a sessionEvents replay merged with live events, filtered by
// type-chips + text search, each row expandable with a { } inspector badge.
//
// Pure helpers (normalizeLogEntry / mergeLiveEntry / distinctTypes /
// summarizeEntry / pageSlice) run with no DOM. The controller
// (renderSessionLog / ingestLiveEvent) is exercised against a hand-rolled DOM
// shim + fake window.dsh.sessionEvents + a spy inspector — the same no-jsdom
// approach as inspector-drawer.test.js / chat-triple-view.test.js.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

// session-log-view.js reads window.DevtoolsModel / window.__dshInspector /
// window.dsh at call time, and attaches its API to window on load. Provide a
// window before requiring so the load-time `window.__dshSessionLogView =`
// assignment has a home, then read the module back off it. Also require
// DevtoolsModel so filterEntries composes exactly like the devtools panel.
const DevtoolsModel = require('../src/renderer/devtools-model.js')
global.window = global.window || {}
global.window.DevtoolsModel = DevtoolsModel
const logView = require('../src/renderer/session-log-view.js')

// ─── pure: normalizeLogEntry ───────────────────────────────────────────────

test('normalizeLogEntry: seq becomes the id; missing type → (unknown)', () => {
  const e = logView.normalizeLogEntry({ type: 'user/message', seq: 7, time: 100, data: { text: 'hi' } }, -1)
  assert.equal(e.id, 7)
  assert.equal(e.seq, 7)
  assert.equal(e.type, 'user/message')
  assert.equal(e.time, 100)
  assert.equal(e.event.data.text, 'hi')
})

test('normalizeLogEntry: seq-less event falls back to the supplied id', () => {
  const e = logView.normalizeLogEntry({ type: 'chunk/delta', data: {} }, -5)
  assert.equal(e.seq, null)
  assert.equal(e.id, -5)
  assert.equal(e.type, 'chunk/delta')
})

// ─── pure: mergeLiveEntry ───────────────────────────────────────────────────

test('mergeLiveEntry: appends a new seq in ascending order', () => {
  const list = [
    logView.normalizeLogEntry({ type: 'a', seq: 1 }),
    logView.normalizeLogEntry({ type: 'b', seq: 3 }),
  ]
  logView.mergeLiveEntry(list, logView.normalizeLogEntry({ type: 'c', seq: 2 }))
  assert.deepEqual(list.map((e) => e.seq), [1, 2, 3])
})

test('mergeLiveEntry: a duplicate seq replaces in place (fuller payload)', () => {
  const list = [logView.normalizeLogEntry({ type: 'assistant/message', seq: 5, data: { text: 'par' } })]
  logView.mergeLiveEntry(list, logView.normalizeLogEntry({ type: 'assistant/message', seq: 5, data: { text: 'partial→full' } }))
  assert.equal(list.length, 1, 'no duplicate row for the same seq')
  assert.equal(list[0].event.data.text, 'partial→full')
})

test('mergeLiveEntry: seq-less event always appends', () => {
  const list = [logView.normalizeLogEntry({ type: 'a', seq: 1 })]
  logView.mergeLiveEntry(list, logView.normalizeLogEntry({ type: 'delta' }, -1))
  logView.mergeLiveEntry(list, logView.normalizeLogEntry({ type: 'delta' }, -2))
  assert.equal(list.length, 3)
})

// ─── pure: distinctTypes / summarizeEntry / pageSlice ───────────────────────

test('distinctTypes: sorted unique type list', () => {
  const list = ['turn/start', 'user/message', 'turn/start', 'tool/call'].map(
    (t, i) => logView.normalizeLogEntry({ type: t, seq: i }))
  assert.deepEqual(logView.distinctTypes(list), ['tool/call', 'turn/start', 'user/message'])
})

test('summarizeEntry: prefers text, then content array, then stopReason', () => {
  assert.equal(
    logView.summarizeEntry(logView.normalizeLogEntry({ type: 'assistant/message', seq: 1, data: { text: 'hello world' } })),
    'hello world')
  assert.equal(
    logView.summarizeEntry(logView.normalizeLogEntry({
      type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: 'multi' }, { type: 'text', text: 'part' }] },
    })),
    'multi part')
  assert.equal(
    logView.summarizeEntry(logView.normalizeLogEntry({ type: 'turn/end', seq: 3, data: { stopReason: 'cancelled' } })),
    'cancelled')
})

test('summarizeEntry: truncates long text with an ellipsis', () => {
  const s = logView.summarizeEntry(logView.normalizeLogEntry({ type: 'assistant/message', seq: 1, data: { text: 'x'.repeat(120) } }))
  assert.ok(s.length <= 80)
  assert.ok(s.endsWith('…'))
})

test('pageSlice: caps at PAGE and reports hasMore', () => {
  const big = Array.from({ length: 450 }, (_, i) => logView.normalizeLogEntry({ type: 't', seq: i }))
  const first = logView.pageSlice(big, logView.PAGE)
  assert.equal(first.rows.length, logView.PAGE)
  assert.equal(first.hasMore, true)
  assert.equal(first.total, 450)
  const second = logView.pageSlice(big, logView.PAGE * 3)
  assert.equal(second.rows.length, 450)
  assert.equal(second.hasMore, false)
})

// ─── controller: seed events (in-memory cache) ──────────────────────────────

test('renderSessionLog: seedEvents paint immediately (live-only session)', async () => {
  const doc = makeDoc()
  const c = container(doc)
  const savedDsh = global.window.dsh
  // Bridge returns nothing — mimics a daemon that hasn't persisted this live
  // session. The seed must still render.
  global.window.dsh = { sessionEvents: async () => ({ events: [] }) }
  try {
    logView.renderSessionLog(c, {
      sessionId: 's-seed',
      seedEvents: [
        { type: 'user/message', seq: 1, data: { text: 'live' } },
        { type: 'turn/start', seq: 2, data: {} },
      ],
    })
    await new Promise((r) => setTimeout(r, 5))
    assert.equal(c.querySelectorAll('session-log-row').length, 2, 'seed rows survive an empty wire walk')
  } finally {
    global.window.dsh = savedDsh
  }
})

test('renderSessionLog: a larger wire walk supersedes the seed', async () => {
  const doc = makeDoc()
  const c = container(doc)
  const savedDsh = global.window.dsh
  const events = [
    { type: 'user/message', seq: 1, data: {} },
    { type: 'turn/start', seq: 2, data: {} },
    { type: 'assistant/message', seq: 3, data: {} },
    { type: 'turn/end', seq: 4, data: {} },
  ]
  global.window.dsh = { sessionEvents: makeSessionEventsBridge(events) }
  try {
    logView.renderSessionLog(c, {
      sessionId: 's-supersede',
      seedEvents: [{ type: 'user/message', seq: 1, data: {} }], // stale 1-event cache
    })
    await new Promise((r) => setTimeout(r, 5))
    assert.equal(c.querySelectorAll('session-log-row').length, 4, 'wire walk (4) beats seed (1)')
  } finally {
    global.window.dsh = savedDsh
  }
})

// ─── DOM shim ──────────────────────────────────────────────────────────────
//
// Minimal element with the surface session-log-view.js touches: className,
// dataset, textContent (clearing), appendChild, addEventListener + a manual
// `_fire`, querySelectorAll by single class, hidden, type/placeholder/value.

function makeDoc() {
  function el(tag) {
    const node = {
      tagName: String(tag).toUpperCase(),
      className: '',
      _text: '',
      placeholder: '',
      type: '',
      value: '',
      hidden: false,
      open: false,
      dataset: {},
      _children: [],
      _listeners: {},
      // Real DOM clears children when textContent is assigned; the controller
      // relies on `el.textContent = ''` to reset a pane before repaint.
      get textContent() { return this._text || this._children.map((c) => c.textContent || '').join('') },
      set textContent(v) { this._text = String(v); this._children.length = 0 },
      classList: {
        _s: new Set(),
        add(...c) { for (const x of c) this._s.add(x) },
        remove(...c) { for (const x of c) this._s.delete(x) },
        contains(c) { return this._s.has(c) },
        toggle(c, f) { const h = this._s.has(c); const on = f === undefined ? !h : f; if (on) this._s.add(c); else this._s.delete(c); return on },
      },
      get firstChild() { return this._children[0] || null },
      appendChild(c) { this._children.push(c); c.parentNode = node; return c },
      removeChild(c) { const i = this._children.indexOf(c); if (i >= 0) this._children.splice(i, 1); return c },
      setAttribute(k, v) { this.dataset[k] = v; if (k === 'class') this.className = String(v) },
      getAttribute(k) { return this.dataset[k] },
      addEventListener(evt, fn) { (this._listeners[evt] ||= []).push(fn) },
      _fire(evt, arg) { for (const fn of (this._listeners[evt] || [])) fn(arg || { stopPropagation() {}, preventDefault() {} }) },
      querySelectorAll(sel) {
        const cls = sel.replace(/^\./, '')
        const out = []
        const walk = (n) => {
          for (const c of (n._children || [])) {
            if (typeof c.className === 'string' && c.className.split(/\s+/).includes(cls)) out.push(c)
            walk(c)
          }
        }
        walk(node)
        return out
      },
    }
    return node
  }
  return { createElement: el, createElementNS: (_ns, t) => el(t) }
}

function container(doc) {
  const c = doc.createElement('div')
  c.ownerDocument = doc
  return c
}

// A fake window.dsh.sessionEvents that serves a fixed event list. First call
// (no seq) returns a metadata listing; windowed calls return slices.
function makeSessionEventsBridge(events) {
  const sorted = events.slice().sort((a, b) => a.seq - b.seq)
  return async function (sessionId, opts = {}) {
    if (opts.seq === undefined) {
      return { events: sorted.map((e) => ({ seq: e.seq, type: e.type })) }
    }
    const before = opts.before || 50
    const end = opts.seq
    const start = Math.max(0, end - before + 1)
    const slice = sorted.filter((e) => e.seq >= start && e.seq <= end)
    return { events: slice, startSeq: slice.length ? slice[0].seq : start }
  }
}

// ─── controller: history replay ─────────────────────────────────────────────

test('renderSessionLog: replays full history and paints rows + chips', async () => {
  const doc = makeDoc()
  const c = container(doc)
  const events = [
    { type: 'user/message', seq: 1, data: { text: 'go' } },
    { type: 'turn/start', seq: 2, data: {} },
    { type: 'assistant/message', seq: 3, data: { text: 'ok' } },
    { type: 'turn/end', seq: 4, data: { stopReason: 'end_turn' } },
  ]
  const savedDsh = global.window.dsh
  global.window.dsh = { sessionEvents: makeSessionEventsBridge(events) }
  try {
    logView.renderSessionLog(c, { sessionId: 's1' })
    // loadHistory is async (awaits the bridge); let microtasks settle.
    await new Promise((r) => setTimeout(r, 5))
    const rows = c.querySelectorAll('session-log-row')
    assert.equal(rows.length, 4, 'all four events render as rows')
    const chips = c.querySelectorAll('session-log-chip')
    assert.equal(chips.length, 4, 'one chip per distinct type')
  } finally {
    global.window.dsh = savedDsh
  }
})

test('renderSessionLog: empty state when the bridge returns nothing', async () => {
  const doc = makeDoc()
  const c = container(doc)
  const savedDsh = global.window.dsh
  global.window.dsh = { sessionEvents: async () => ({ events: [] }) }
  try {
    logView.renderSessionLog(c, { sessionId: 's-empty' })
    await new Promise((r) => setTimeout(r, 5))
    const empty = c.querySelectorAll('session-log-empty')
    assert.equal(empty.length, 1)
  } finally {
    global.window.dsh = savedDsh
  }
})

// ─── controller: type-chip filter ───────────────────────────────────────────

test('type-chip toggle filters rows to the selected type', async () => {
  const doc = makeDoc()
  const c = container(doc)
  const events = [
    { type: 'user/message', seq: 1, data: {} },
    { type: 'tool/call', seq: 2, data: { name: 'read' } },
    { type: 'tool/call', seq: 3, data: { name: 'write' } },
    { type: 'turn/end', seq: 4, data: {} },
  ]
  const savedDsh = global.window.dsh
  global.window.dsh = { sessionEvents: makeSessionEventsBridge(events) }
  try {
    logView.renderSessionLog(c, { sessionId: 's2' })
    await new Promise((r) => setTimeout(r, 5))
    assert.equal(c.querySelectorAll('session-log-row').length, 4)
    // Click the tool/call chip.
    const chips = c.querySelectorAll('session-log-chip')
    const toolChip = chips.find((ch) => ch.dataset.type === 'tool/call')
    assert.ok(toolChip, 'tool/call chip present')
    toolChip._fire('click')
    const rows = c.querySelectorAll('session-log-row')
    assert.equal(rows.length, 2, 'only tool/call rows remain')
    for (const r of rows) assert.equal(r.dataset.type, 'tool/call')
  } finally {
    global.window.dsh = savedDsh
  }
})

// ─── controller: text search ────────────────────────────────────────────────

test('text search narrows rows by payload substring', async () => {
  const doc = makeDoc()
  const c = container(doc)
  const events = [
    { type: 'user/message', seq: 1, data: { text: 'deploy the thing' } },
    { type: 'assistant/message', seq: 2, data: { text: 'rolling back' } },
  ]
  const savedDsh = global.window.dsh
  global.window.dsh = { sessionEvents: makeSessionEventsBridge(events) }
  try {
    logView.renderSessionLog(c, { sessionId: 's3' })
    await new Promise((r) => setTimeout(r, 5))
    const search = c.querySelectorAll('session-log-search')[0]
    assert.ok(search, 'search input present')
    search.value = 'deploy'
    search._fire('input')
    const rows = c.querySelectorAll('session-log-row')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].dataset.seq, '1')
  } finally {
    global.window.dsh = savedDsh
  }
})

// ─── controller: live merge ─────────────────────────────────────────────────

test('ingestLiveEvent: a live event for the shown session appends a row', async () => {
  const doc = makeDoc()
  const c = container(doc)
  const savedDsh = global.window.dsh
  global.window.dsh = { sessionEvents: makeSessionEventsBridge([
    { type: 'user/message', seq: 1, data: {} },
  ]) }
  try {
    logView.renderSessionLog(c, { sessionId: 's4' })
    await new Promise((r) => setTimeout(r, 5))
    assert.equal(c.querySelectorAll('session-log-row').length, 1)
    logView.ingestLiveEvent(c, 's4', { type: 'turn/start', seq: 2, data: {} })
    assert.equal(c.querySelectorAll('session-log-row').length, 2)
    // An event for a DIFFERENT session is ignored.
    logView.ingestLiveEvent(c, 's-other', { type: 'turn/end', seq: 3, data: {} })
    assert.equal(c.querySelectorAll('session-log-row').length, 2)
  } finally {
    global.window.dsh = savedDsh
  }
})

// ─── controller: inspector anchoring ────────────────────────────────────────

test('row { } badge opens the inspector anchored to that event', async () => {
  const doc = makeDoc()
  const c = container(doc)
  const opened = []
  const savedInsp = global.window.__dshInspector
  const savedDsh = global.window.dsh
  global.window.__dshInspector = {
    // Mirror the real attachInspectBadge: resolve the target at click time
    // and call open with it.
    attachInspectBadge(host, getTarget) {
      const btn = doc.createElement('button')
      btn.className = 'inspect-badge'
      btn.addEventListener('click', () => { const t = getTarget(); opened.push(t) })
      host.appendChild(btn)
      return btn
    },
    open(t) { opened.push(t) },
  }
  global.window.dsh = { sessionEvents: makeSessionEventsBridge([
    { type: 'assistant/message', seq: 9, data: { text: 'inspect me' } },
  ]) }
  try {
    logView.renderSessionLog(c, { sessionId: 's5' })
    await new Promise((r) => setTimeout(r, 5))
    const badge = c.querySelectorAll('inspect-badge')[0]
    assert.ok(badge, 'inspect badge attached to the row')
    badge._fire('click')
    assert.equal(opened.length, 1)
    assert.equal(opened[0].event.seq, 9, 'inspector anchored to the row event')
    assert.equal(opened[0].event.data.text, 'inspect me')
  } finally {
    global.window.__dshInspector = savedInsp
    global.window.dsh = savedDsh
  }
})
