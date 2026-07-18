// Task #168 / step 4 — fork-compare tests.
//
// Covers:
//   pure helpers — buildBadgeText, normaliseEventsResponse, summariseEvent,
//     extractText, short
//   DOM builder — openForkCompare creates the drawer on first call, paints
//     both columns from a mock sessionEvents bridge, clipping the parent
//     stream to seq<=boundary and the child stream to seq>boundary; Refresh
//     re-hydrates; Close hides.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

// Install a minimal global DOM before requiring the module so the CommonJS
// export path is what runs (window is undefined in Node, so the module
// registers only as module.exports; we then install `window`/`document`
// after require for the DOM builder tests).
const FC = require('../src/renderer/fork-compare.js')

// ---- pure helpers --------------------------------------------------------

test('short trims long ids and passes short ones through', () => {
  assert.equal(FC.short('abcdef1234567890'), 'abcdef12…')
  assert.equal(FC.short('short'), 'short')
  assert.equal(FC.short(null), '')
})

test('buildBadgeText names parent/child + optional seq + source label', () => {
  const s = FC.buildBadgeText({
    parentId: 'parent-1234567890',
    childId: 'child-abcdef',
    seq: 42,
    source: 'config',
  })
  assert.match(s, /Fork of parent-1/)
  assert.match(s, /child-ab/)
  assert.match(s, /@ seq 42/)
  assert.match(s, /source: edited config/)
})

test('buildBadgeText omits seq + source when absent', () => {
  const s = FC.buildBadgeText({ parentId: 'p1', childId: 'c1' })
  assert.doesNotMatch(s, /@ seq/)
  assert.doesNotMatch(s, /source:/)
})

test('normaliseEventsResponse accepts [], {events:[]}, {items:[]}', () => {
  assert.deepEqual(FC.normaliseEventsResponse([{ seq: 1 }]), [{ seq: 1 }])
  assert.deepEqual(FC.normaliseEventsResponse({ events: [{ seq: 2 }] }), [{ seq: 2 }])
  assert.deepEqual(FC.normaliseEventsResponse({ items: [{ seq: 3 }] }), [{ seq: 3 }])
  assert.deepEqual(FC.normaliseEventsResponse(null), [])
})

test('summariseEvent produces a compact one-liner per kind', () => {
  assert.equal(FC.summariseEvent({ type: 'message/user', text: 'hi' }), 'hi')
  assert.equal(
    FC.summariseEvent({ type: 'tool/call', data: { name: 'bash' } }),
    'bash(…)',
  )
  assert.equal(
    FC.summariseEvent({ type: 'tool/result', data: { isError: true } }),
    '(error)',
  )
  assert.equal(
    FC.summariseEvent({ type: 'request/header', data: { header: { config: { model: 'X' } } } }),
    'model=X',
  )
})

test('extractText handles scalar text, content-blocks, and data.content', () => {
  assert.equal(FC.extractText({ text: 'plain' }), 'plain')
  assert.equal(
    FC.extractText({ content: [{ type: 'text', text: 'a' }, { type: 'other' }, { type: 'text', text: 'b' }] }),
    'ab',
  )
  assert.equal(
    FC.extractText({ data: { content: [{ type: 'text', text: 'c' }] } }),
    'c',
  )
})

// ---- DOM builder ---------------------------------------------------------
//
// We install a minimal document into globalThis so openForkCompare has
// somewhere to build the drawer. Everything Node lacks (getElementById on
// the whole document, appendChild on body) is faked.

function installFakeDom() {
  const doc = makeMinimalDoc()
  globalThis.document = doc
  globalThis.window = { document: doc, dsh: null, __dshCompareHistory: null }
  FC.__resetForTests()
  // Bug D layer 4 (2026-07-18): openForkCompare requires a recent trusted
  // user gesture + boot to be past BOOT_QUIET_MS. Neither hold in a node
  // test process, so we cheat both explicitly.
  FC.__setBootAtForTests(Date.now() - 60_000) // pretend renderer booted 1 min ago
  FC.__markGestureForTests(Date.now())
  return doc
}

function tearDownFakeDom() {
  delete globalThis.document
  delete globalThis.window
  FC.__resetForTests()
}

function makeMinimalDoc() {
  const store = new Map()
  function makeEl(tag) {
    const el = {
      tagName: (tag || 'div').toUpperCase(),
      children: [],
      _classSet: new Set(),
      dataset: {},
      _listeners: {},
      _attrs: {},
      _text: '',
      _id: '',
      _innerHTML: '',
      hidden: false,
      title: '',
    }
    Object.defineProperty(el, 'className', {
      get() { return Array.from(this._classSet).join(' ') },
      set(v) { this._classSet = new Set(String(v || '').split(/\s+/).filter(Boolean)) },
    })
    Object.defineProperty(el, 'textContent', {
      get() {
        if (this._text) return this._text
        let s = ''
        for (const c of this.children) s += (c.textContent || '')
        return s
      },
      set(v) { this._text = String(v == null ? '' : v); this.children = [] },
    })
    Object.defineProperty(el, 'innerHTML', {
      get() { return this._innerHTML },
      set(v) {
        this._innerHTML = String(v == null ? '' : v)
        // Simulate "innerHTML = '' clears children" — the only usage in the
        // module under test.
        if (v === '' || v == null) this.children = []
      },
    })
    Object.defineProperty(el, 'id', {
      get() { return this._id },
      set(v) {
        if (this._id && store.get(this._id) === this) store.delete(this._id)
        this._id = String(v == null ? '' : v)
        if (this._id) store.set(this._id, this)
      },
    })
    Object.defineProperty(el, 'isConnected', {
      get() {
        let n = this
        while (n) {
          if (n === doc.body) return true
          n = n.parentNode
        }
        return false
      },
    })
    el.classList = {
      add: (c) => el._classSet.add(c),
      remove: (c) => el._classSet.delete(c),
      contains: (c) => el._classSet.has(c),
    }
    el.setAttribute = (k, v) => { el._attrs[k] = String(v) }
    el.getAttribute = (k) => (k in el._attrs ? el._attrs[k] : null)
    el.appendChild = (child) => {
      if (child.parentNode) {
        const idx = child.parentNode.children.indexOf(child)
        if (idx >= 0) child.parentNode.children.splice(idx, 1)
      }
      el.children.push(child); child.parentNode = el; return child
    }
    el.addEventListener = (evt, fn) => { (el._listeners[evt] = el._listeners[evt] || []).push(fn) }
    el.click = () => { for (const fn of (el._listeners.click || [])) fn({ stopPropagation() {} }) }
    el.focus = () => {}
    el.ownerDocument = doc
    return el
  }
  const doc = {
    createElement: (t) => makeEl(t),
    getElementById: (id) => store.get(id) || null,
  }
  doc.body = makeEl('body')
  return doc
}

test('openForkCompare builds the drawer once, paints both columns clipped by seq', async () => {
  installFakeDom()
  try {
    const events = [
      { seq: 0, type: 'message/user', text: 'hello' },
      { seq: 1, type: 'request/header', data: { header: { config: { model: 'X' } } } },
      { seq: 2, type: 'tool/call', data: { name: 'bash' } },
      { seq: 3, type: 'message/assistant', text: 'done' },
    ]
    const forkExtras = [
      { seq: 3, type: 'message/assistant', text: 'done' }, // parent's own last event (inherited)
      { seq: 4, type: 'message/user', text: 'edit re-run intent' },
      { seq: 5, type: 'message/assistant', text: 'ok!' },
    ]
    const seen = []
    globalThis.window.dsh = {
      sessionEvents: async (sid) => {
        seen.push(sid)
        if (sid === 'parent') return { events }
        if (sid === 'child') return { events: forkExtras }
        return { events: [] }
      },
    }
    FC.openForkCompare({ parentId: 'parent', childId: 'child', seq: 3, source: 'tool' })
    // Two async fetches — flush.
    await new Promise((r) => setTimeout(r, 15))
    const doc = globalThis.document
    const badge = doc.getElementById('fork-compare-badge')
    assert.ok(badge, 'badge element exists')
    assert.match(badge.textContent, /@ seq 3/)
    assert.match(badge.textContent, /edited tool args/)
    const leftStream = doc.getElementById('fork-compare-left-stream')
    const rightStream = doc.getElementById('fork-compare-right-stream')
    // Left column: 4 event rows (seq 0..3)
    const leftRows = leftStream.children.filter((c) => c._classSet.has('fork-compare-row'))
    assert.equal(leftRows.length, 4)
    // Right column: 2 events (seq 4 + 5 — seq 3 is inherited from parent)
    const rightRows = rightStream.children.filter((c) => c._classSet.has('fork-compare-row'))
    assert.equal(rightRows.length, 2)
    // Both session ids were fetched.
    assert.ok(seen.includes('parent'))
    assert.ok(seen.includes('child'))
    // Drawer is visible.
    assert.equal(doc.getElementById('fork-compare-drawer').hidden, false)
  } finally {
    tearDownFakeDom()
  }
})

test('openForkCompare surfaces fetch errors inline (no throw)', async () => {
  installFakeDom()
  try {
    globalThis.window.dsh = {
      sessionEvents: async () => { throw new Error('boom') },
    }
    FC.openForkCompare({ parentId: 'p', childId: 'c', seq: 5 })
    await new Promise((r) => setTimeout(r, 10))
    const doc = globalThis.document
    const leftStream = doc.getElementById('fork-compare-left-stream')
    const rightStream = doc.getElementById('fork-compare-right-stream')
    assert.match(leftStream.textContent, /could not load parent history/i)
    assert.match(rightStream.textContent, /could not load fork history/i)
  } finally {
    tearDownFakeDom()
  }
})

test('closeForkCompare hides the drawer', async () => {
  installFakeDom()
  try {
    globalThis.window.dsh = { sessionEvents: async () => ({ events: [] }) }
    FC.openForkCompare({ parentId: 'p', childId: 'c' })
    await new Promise((r) => setTimeout(r, 10))
    const doc = globalThis.document
    assert.equal(doc.getElementById('fork-compare-drawer').hidden, false)
    FC.closeForkCompare()
    assert.equal(doc.getElementById('fork-compare-drawer').hidden, true)
  } finally {
    tearDownFakeDom()
  }
})

test('empty fork stream surfaces the "waiting for next turn" meta line', async () => {
  installFakeDom()
  try {
    globalThis.window.dsh = {
      sessionEvents: async (sid) => (sid === 'p'
        ? { events: [{ seq: 0, type: 'message/user', text: 'hi' }] }
        : { events: [{ seq: 0, type: 'message/user', text: 'hi' }] }),
    }
    FC.openForkCompare({ parentId: 'p', childId: 'c', seq: 0 })
    await new Promise((r) => setTimeout(r, 10))
    const doc = globalThis.document
    const rightStream = doc.getElementById('fork-compare-right-stream')
    assert.match(rightStream.textContent, /waiting for the next turn/i)
  } finally {
    tearDownFakeDom()
  }
})

// ---- Bug D regressions (2026-07-18) -------------------------------------

test('Bug D: openForkCompare refuses to open while renderer is replaying', async () => {
  installFakeDom()
  try {
    globalThis.window.__dshRenderer = { state: { replayingId: 'some-old-session' } }
    globalThis.window.dsh = { sessionEvents: async () => ({ events: [] }) }
    FC.openForkCompare({ parentId: 'p', childId: 'c', seq: 3 })
    await new Promise((r) => setTimeout(r, 5))
    const doc = globalThis.document
    // The drawer was never even built — nothing landed in the DOM.
    assert.equal(doc.getElementById('fork-compare-drawer'), null,
      'replay path must not build a fork-compare drawer')
  } finally {
    tearDownFakeDom()
  }
})

test('Bug D: openForkCompare opens normally when replayingId is null', async () => {
  installFakeDom()
  try {
    globalThis.window.__dshRenderer = { state: { replayingId: null } }
    globalThis.window.dsh = { sessionEvents: async () => ({ events: [] }) }
    FC.openForkCompare({ parentId: 'p', childId: 'c', seq: 3 })
    await new Promise((r) => setTimeout(r, 10))
    const doc = globalThis.document
    assert.ok(doc.getElementById('fork-compare-drawer'),
      'a normal open (no replay) must build the drawer')
    assert.equal(doc.getElementById('fork-compare-drawer').hidden, false)
  } finally {
    tearDownFakeDom()
  }
})

test('Bug D: click on drawer root (backdrop gutter) closes the drawer', async () => {
  installFakeDom()
  try {
    globalThis.window.dsh = { sessionEvents: async () => ({ events: [] }) }
    FC.openForkCompare({ parentId: 'p', childId: 'c' })
    await new Promise((r) => setTimeout(r, 10))
    const doc = globalThis.document
    const root = doc.getElementById('fork-compare-drawer')
    assert.equal(root.hidden, false)
    // Simulate a click whose target IS the root (i.e., the 40px gutter).
    // Our doc.click() bubbles a target the module reads as e.target.
    // The listener we registered checks e.target === root.
    for (const fn of (root._listeners.click || [])) fn({ target: root })
    assert.equal(root.hidden, true,
      'clicking the drawer root gutter must close the drawer')
  } finally {
    tearDownFakeDom()
  }
})

test('Bug D: Escape key closes the drawer when it is open', async () => {
  installFakeDom()
  try {
    // Escape needs a doc-level keydown listener; extend the fake doc.
    // openForkCompare installs TWO keydown listeners: the gesture watcher
    // (a bump function, non-closing) and the Escape closer. Grab them all
    // and fire Escape past every registered listener so we don't guess
    // which slot ensureEscListener occupies.
    const listeners = []
    globalThis.document.addEventListener = (evt, fn) => {
      listeners.push({ evt, fn })
    }
    globalThis.window.dsh = { sessionEvents: async () => ({ events: [] }) }
    FC.openForkCompare({ parentId: 'p', childId: 'c' })
    await new Promise((r) => setTimeout(r, 10))
    const doc = globalThis.document
    assert.equal(doc.getElementById('fork-compare-drawer').hidden, false)
    const keyListeners = listeners.filter((l) => l.evt === 'keydown')
    assert.ok(keyListeners.length >= 1,
      'openForkCompare must install at least one keydown listener')
    // Fire Escape past every keydown listener; the Escape closer will react,
    // the gesture bumper will ignore the untrusted synthetic event.
    for (const l of keyListeners) l.fn({ key: 'Escape', stopPropagation() {} })
    assert.equal(doc.getElementById('fork-compare-drawer').hidden, true,
      'Escape must close the drawer')
  } finally {
    tearDownFakeDom()
  }
})

// ---- Bug D layer 4: user-gesture guard ----------------------------------

test('Bug D L4: openForkCompare refuses to open during boot-quiet window', () => {
  installFakeDom()
  try {
    // Force boot age to zero so the boot-quiet gate slams.
    FC.__setBootAtForTests(Date.now())
    FC.__markGestureForTests(Date.now())
    const ret = FC.openForkCompare({ parentId: 'p', childId: 'c' })
    assert.deepEqual(ret, { blocked: 'boot-quiet' },
      'return value must surface the block reason')
    const doc = globalThis.document
    assert.equal(doc.getElementById('fork-compare-drawer'), null,
      'no drawer element must exist when open is blocked during boot')
  } finally {
    tearDownFakeDom()
  }
})

test('Bug D L4: openForkCompare refuses to open without a recent user gesture', () => {
  installFakeDom()
  try {
    // Boot is old (installFakeDom set it to -60s) but the gesture stamp
    // is stale beyond the 5s window.
    FC.__markGestureForTests(Date.now() - 10_000)
    const ret = FC.openForkCompare({ parentId: 'p', childId: 'c' })
    assert.deepEqual(ret, { blocked: 'no-gesture' },
      'a >5s-old gesture must block open')
    const doc = globalThis.document
    assert.equal(doc.getElementById('fork-compare-drawer'), null,
      'no drawer built when gesture is stale')
  } finally {
    tearDownFakeDom()
  }
})

test('Bug D L4: openForkCompare refuses to open with zero gestures ever recorded', () => {
  installFakeDom()
  try {
    // Explicitly clear the stamp — simulates the boot-time auto-open path
    // the user hit (no user click preceded the call).
    FC.__markGestureForTests(0)
    const ret = FC.openForkCompare({ parentId: 'p', childId: 'c' })
    assert.deepEqual(ret, { blocked: 'no-gesture' })
    const doc = globalThis.document
    assert.equal(doc.getElementById('fork-compare-drawer'), null,
      'a fresh renderer with zero user gestures must never auto-open the fork-compare drawer')
  } finally {
    tearDownFakeDom()
  }
})

test('Bug D L4: markUserGesture stamps within window, then open succeeds', async () => {
  installFakeDom()
  try {
    FC.__markGestureForTests(0)
    // Legitimate button handler calls markUserGesture then openForkCompare.
    FC.markUserGesture()
    globalThis.window.dsh = { sessionEvents: async () => ({ events: [] }) }
    FC.openForkCompare({ parentId: 'p', childId: 'c' })
    await new Promise((r) => setTimeout(r, 10))
    const doc = globalThis.document
    assert.ok(doc.getElementById('fork-compare-drawer'),
      'markUserGesture + openForkCompare inside one handler must succeed')
    assert.equal(doc.getElementById('fork-compare-drawer').hidden, false)
  } finally {
    tearDownFakeDom()
  }
})
