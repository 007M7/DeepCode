// Task #168 / step 1 — payload-controls util tests.
//
// Verifies:
//   1. pure helpers (prettyString / rawString / coerceForPretty /
//      jsonStringifySafe) behave on scalars, objects, strings-that-are-
//      JSON, circular refs, and undefined.
//   2. attachPayloadControls mounts controls + <pre> into a host, wires
//      the pretty↔raw toggle, and does not throw when navigator.clipboard
//      / URL.createObjectURL are absent (headless).
//   3. Toggle click swaps the <pre> text between pretty (indent=2) and
//      raw (indent=0) forms, and the button label follows.
//   4. Copy click invokes navigator.clipboard.writeText with the pretty
//      string when a stub is present.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const pc = require('../src/renderer/payload-controls.js')

// ---------- fake doc (matches trace-detail-pane.test shape) --------------

function makeDoc() {
  function makeEl(tag) {
    const el = {
      tagName: (tag || 'div').toUpperCase(),
      children: [],
      _classSet: new Set(),
      dataset: {},
      style: {},
      hidden: false,
      _listeners: {},
      _attrs: {},
      _text: '',
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
    el.classList = {
      add: (c) => el._classSet.add(c),
      remove: (c) => el._classSet.delete(c),
      contains: (c) => el._classSet.has(c),
    }
    el.setAttribute = (k, v) => { el._attrs[k] = String(v) }
    el.getAttribute = (k) => (k in el._attrs ? el._attrs[k] : null)
    el.appendChild = (child) => {
      el.children.push(child)
      child.parentNode = el
      return child
    }
    el.addEventListener = (evt, fn) => { (el._listeners[evt] = el._listeners[evt] || []).push(fn) }
    el.click = () => { for (const fn of (el._listeners.click || [])) fn({ stopPropagation() {} }) }
    el.ownerDocument = doc
    return el
  }
  const doc = { createElement: (t) => makeEl(t) }
  return doc
}

function findChild(el, cls) {
  for (const c of el.children) if (c._classSet && c._classSet.has(cls)) return c
  for (const c of el.children) {
    const nested = findChild(c, cls)
    if (nested) return nested
  }
  return null
}

// ---- pure helpers -------------------------------------------------------

test('prettyString indents objects by 2 spaces', () => {
  const s = pc.prettyString({ a: 1, b: [2, 3] })
  assert.equal(s, '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}')
})

test('rawString is single-line JSON.stringify', () => {
  const s = pc.rawString({ a: 1, b: [2, 3] })
  assert.equal(s, '{"a":1,"b":[2,3]}')
})

test('coerceForPretty re-parses JSON strings so pretty view shows structure', () => {
  const s = pc.prettyString('{"a":1}')
  assert.equal(s, '{\n  "a": 1\n}')
})

test('coerceForPretty leaves plain strings alone', () => {
  assert.equal(pc.prettyString('hello world'), '"hello world"')
})

test('jsonStringifySafe survives circular refs', () => {
  const a = { name: 'a' }; a.self = a
  const s = pc.prettyString(a)
  assert.match(s, /"self": "\[Circular\]"/)
})

test('undefined renders as (absent) marker (zero-drop rule)', () => {
  assert.equal(pc.prettyString(undefined), '(absent)')
  assert.equal(pc.rawString(undefined), '(absent)')
})

// ---- DOM composition ----------------------------------------------------

test('attachPayloadControls mounts controls + pre into host', () => {
  const doc = makeDoc()
  const host = doc.createElement('div')
  const payload = { command: 'echo hi', env: { X: '1' } }
  const ret = pc.attachPayloadControls(host, {
    getRaw: () => payload,
    kind: 'args',
  })
  assert.ok(ret, 'returns handle')
  const ctl = findChild(host, 'payload-controls')
  const pre = findChild(host, 'payload-body')
  assert.ok(ctl, 'controls container mounted')
  assert.ok(pre, 'pre body mounted')
  assert.equal(ctl.getAttribute('data-payload-kind'), 'args')
  assert.ok(findChild(ctl, 'payload-ctl-toggle'), 'toggle present')
  assert.ok(findChild(ctl, 'payload-ctl-copy'), 'copy present')
  assert.ok(findChild(ctl, 'payload-ctl-download'), 'download present')
  assert.match(pre.textContent, /"command": "echo hi"/, 'starts in pretty mode')
})

test('toggle swaps pretty↔raw text and label', () => {
  const doc = makeDoc()
  const host = doc.createElement('div')
  pc.attachPayloadControls(host, { getRaw: () => ({ a: 1 }), kind: 'args' })
  const toggle = findChild(host, 'payload-ctl-toggle')
  const pre = findChild(host, 'payload-body')
  assert.equal(toggle.textContent, 'pretty')
  toggle.click()
  assert.equal(toggle.textContent, 'raw')
  assert.equal(pre.textContent, '{"a":1}')
  toggle.click()
  assert.equal(toggle.textContent, 'pretty')
  assert.match(pre.textContent, /\n {2}"a": 1/)
})

test('copy click routes through navigator.clipboard.writeText when present', () => {
  const doc = makeDoc()
  const host = doc.createElement('div')
  let captured = null
  // Node 20+ exposes a read-only `navigator` global; poke `clipboard` onto
  // it via defineProperty (no clipboard is defined by default in node).
  // If a native clipboard already exists we shim writeText onto it.
  const clipDescOrig = Object.getOwnPropertyDescriptor(globalThis.navigator || {}, 'clipboard') || null
  const nav = globalThis.navigator
  const origClipboard = nav.clipboard
  try {
    Object.defineProperty(nav, 'clipboard', {
      configurable: true,
      value: { writeText: (s) => { captured = s; return Promise.resolve() } },
    })
    pc.attachPayloadControls(host, { getRaw: () => ({ ok: true }), kind: 'args' })
    const copy = findChild(host, 'payload-ctl-copy')
    copy.click()
    assert.match(captured, /"ok": true/)
  } finally {
    if (clipDescOrig) Object.defineProperty(nav, 'clipboard', clipDescOrig)
    else if (origClipboard === undefined) delete nav.clipboard
    else Object.defineProperty(nav, 'clipboard', { configurable: true, value: origClipboard })
  }
})

test('startMode=raw starts with raw text and toggle label', () => {
  const doc = makeDoc()
  const host = doc.createElement('div')
  pc.attachPayloadControls(host, { getRaw: () => ({ b: 2 }), kind: 'result', startMode: 'raw' })
  const toggle = findChild(host, 'payload-ctl-toggle')
  const pre = findChild(host, 'payload-body')
  assert.equal(toggle.textContent, 'raw')
  assert.equal(pre.textContent, '{"b":2}')
})

test('setRaw() refreshes the <pre> without callers touching getRaw', () => {
  const doc = makeDoc()
  const host = doc.createElement('div')
  let payload = { streaming: true }
  const { setRaw } = pc.attachPayloadControls(host, { getRaw: () => payload, kind: 'result' })
  const pre = findChild(host, 'payload-body')
  assert.match(pre.textContent, /"streaming": true/)
  payload = { streaming: false, done: 42 }
  setRaw(payload)
  assert.match(pre.textContent, /"done": 42/)
})

test('null host returns null (headless / caller-error safe)', () => {
  assert.equal(pc.attachPayloadControls(null, { getRaw: () => ({}) }), null)
})

test('missing document safety: returns null, no throw', () => {
  const noOwner = { appendChild: () => {} }
  assert.equal(pc.attachPayloadControls(noOwner, { getRaw: () => ({}) }), null)
})
