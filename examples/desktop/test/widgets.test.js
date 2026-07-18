// Widget renderer unit tests. Runs under `node --test`, no Electron.
//
// The widget module is meant to run in the renderer (has `document`); we
// give it a small `document` shim just rich enough to see the tree it
// builds. This is a smoke check — the visual test lives in the shell's
// debug menu.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

// Minimal shim: node factory that records tag + children + textContent.
function makeShim() {
  const created = []
  function make(tagName, ns) {
    const el = {
      tagName: String(tagName).toUpperCase(),
      _ns: ns,
      children: [],
      attrs: {},
      style: {},
      dataset: {},
      classList: {
        _s: new Set(),
        add(...names) { for (const n of names) this._s.add(n) },
        contains(n) { return this._s.has(n) },
      },
      _text: '',
      get textContent() { return this._text },
      set textContent(v) { this._text = String(v); this.children = [] },
      set className(v) { this._className = String(v); for (const c of String(v).split(/\s+/)) this.classList.add(c) },
      get className() { return this._className || '' },
      set title(v) { this._title = String(v) },
      get title() { return this._title || '' },
      set type(v) { this._type = String(v) },
      get type() { return this._type || '' },
      set value(v) { this._value = v },
      get value() { return this._value },
      set placeholder(v) { this._placeholder = String(v) },
      get placeholder() { return this._placeholder || '' },
      setAttribute(k, v) { this.attrs[k] = String(v) },
      appendChild(c) { this.children.push(c); return c },
      append(...cs) { for (const c of cs) this.children.push(c) },
      addEventListener() { /* no-op for smoke test */ },
      dispatchEvent() { /* no-op */ },
    }
    created.push(el)
    return el
  }
  const doc = {
    createElement: (t) => make(t),
    createElementNS: (ns, t) => make(t, ns),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
  }
  return { doc, created }
}

function loadWidgets() {
  // Fresh module cache each test so the document swap sticks.
  const p = require.resolve('../src/renderer/widgets.js')
  delete require.cache[p]
  return require('../src/renderer/widgets.js')
}

function walk(node, pred, out = []) {
  if (!node || !node.tagName) return out
  if (pred(node)) out.push(node)
  for (const c of node.children || []) walk(c, pred, out)
  return out
}

test('renderWidget returns a wrapper element tagged with the kind', () => {
  const { doc } = makeShim()
  global.document = doc
  const { renderWidget } = loadWidgets()
  const w = renderWidget({
    kind: 'table', id: 't1',
    data: { columns: [{ key: 'a', label: 'A' }], rows: [{ a: 'x' }] },
  }, { sessionId: 'sid', sendPrompt: () => {} })
  assert.equal(w.tagName, 'DIV')
  assert.match(w.className, /^widget widget-table/)
  assert.equal(w.dataset.widgetId, 't1')
  const tables = walk(w, (n) => n.tagName === 'TABLE')
  assert.equal(tables.length, 1)
})

test('table renders one header row and one row per data entry', () => {
  const { doc } = makeShim()
  global.document = doc
  const { renderWidget } = loadWidgets()
  const w = renderWidget({
    kind: 'table', id: 't2',
    data: {
      columns: [
        { key: 'name', label: 'Name' },
        { key: 'n', label: 'N', align: 'right' },
      ],
      rows: [{ name: 'a', n: 1 }, { name: 'b', n: 2 }],
    },
  }, { sessionId: 'sid', sendPrompt: () => {} })
  const ths = walk(w, (n) => n.tagName === 'TH')
  assert.equal(ths.length, 2)
  assert.equal(ths[0]._text, 'Name')
  const rows = walk(w, (n) => n.tagName === 'TR')
  // header row + 2 body rows
  assert.equal(rows.length, 3)
  const cells = walk(w, (n) => n.tagName === 'TD')
  assert.equal(cells.length, 4)
  assert.equal(cells[3]._text, '2')
})

test('options widget: click on an option calls sendPrompt with the action.prompt', () => {
  const { doc } = makeShim()
  global.document = doc
  // Enrich the shim to actually fire click handlers.
  const clickHandlers = new WeakMap()
  const originalCreate = doc.createElement
  doc.createElement = (t) => {
    const el = originalCreate(t)
    el.addEventListener = (evt, fn) => {
      if (evt === 'click' || evt === 'widget-option-picked') {
        const arr = clickHandlers.get(el) || []
        arr.push({ evt, fn })
        clickHandlers.set(el, arr)
      }
    }
    el.dispatchEvent = (customEvent) => {
      // Propagate to ancestors when bubbles is true. We approximate by
      // firing on `el` and its wrapper (the widget root).
      const arr = clickHandlers.get(el) || []
      for (const { evt, fn } of arr) if (evt === customEvent.type) fn(customEvent)
      let cur = el._parent
      while (cur) {
        const parr = clickHandlers.get(cur) || []
        for (const { evt, fn } of parr) if (evt === customEvent.type) fn(customEvent)
        cur = cur._parent
      }
    }
    const origAppend = el.appendChild
    el.appendChild = (c) => { c._parent = el; return origAppend.call(el, c) }
    return el
  }
  const { renderWidget } = loadWidgets()
  const sends = []
  const w = renderWidget({
    kind: 'options', id: 'o1',
    data: {
      question: 'Pick a framework',
      options: [
        { id: 'react', label: 'React' },
        { id: 'vue', label: 'Vue' },
      ],
    },
    actions: [
      { id: 'react', label: 'React', prompt: "Let's use React." },
      { id: 'vue',   label: 'Vue',   prompt: "Let's use Vue." },
    ],
  }, {
    sessionId: 'sid-42',
    sendPrompt: (sid, text) => { sends.push({ sid, text }) },
  })
  // Find the second option button and dispatch a synthetic pick event on it.
  const optButtons = walk(w, (n) => n.tagName === 'BUTTON' && n.className && n.className.includes('widget-option'))
  assert.equal(optButtons.length, 2)
  const CustomEvent = class {
    constructor(type, init) { this.type = type; this.detail = (init && init.detail) || {}; this.bubbles = !!(init && init.bubbles) }
  }
  global.CustomEvent = CustomEvent
  const clickPick = new CustomEvent('widget-option-picked', {
    bubbles: true, detail: { optionId: 'vue', label: 'Vue' },
  })
  optButtons[1].dispatchEvent(clickPick)
  assert.deepEqual(sends, [{ sid: 'sid-42', text: "Let's use Vue." }])
})

test('unknown kind falls through to an unsupported box (never throws)', () => {
  const { doc } = makeShim()
  global.document = doc
  const { renderWidget } = loadWidgets()
  const w = renderWidget({ kind: 'not-a-widget', id: 'x', data: {} }, { sessionId: 's', sendPrompt: () => {} })
  const boxes = walk(w, (n) => n.className && n.className.includes('widget-unsupported'))
  assert.equal(boxes.length, 1)
  assert.match(boxes[0]._text, /unsupported widget: not-a-widget/)
})

test('malformed spec returns an unsupported node instead of throwing', () => {
  const { doc } = makeShim()
  global.document = doc
  const { renderWidget } = loadWidgets()
  const w = renderWidget(null, { sessionId: 's', sendPrompt: () => {} })
  assert.match(w.className, /widget-unsupported/)
})

// -- verb catalog (see next-actions.js) --------------------------------------
//
// The renderer maps each action to a verb. Real verbs fire side-effects
// through the api arg; record-only verbs fire a CustomEvent instead;
// broken actions render as disabled buttons.

function makeInteractiveShim() {
  const { doc } = makeShim()
  const clickHandlers = new WeakMap()
  const orig = doc.createElement
  doc.createElement = (t) => {
    const el = orig(t)
    let _disabled = false
    Object.defineProperty(el, 'disabled', {
      get() { return _disabled }, set(v) { _disabled = !!v },
    })
    el.addEventListener = (evt, fn) => {
      const arr = clickHandlers.get(el) || []
      arr.push({ evt, fn })
      clickHandlers.set(el, arr)
    }
    el.dispatchEvent = (customEvent) => {
      const arr = clickHandlers.get(el) || []
      for (const { evt, fn } of arr) if (evt === customEvent.type) fn(customEvent)
      let cur = el._parent
      while (cur) {
        const parr = clickHandlers.get(cur) || []
        for (const { evt, fn } of parr) if (evt === customEvent.type) fn(customEvent)
        cur = cur._parent
      }
    }
    const origAppend = el.appendChild
    el.appendChild = (c) => { c._parent = el; return origAppend.call(el, c) }
    return el
  }
  // Body sink so record-note CustomEvent has a dispatch target.
  const body = doc.createElement('body')
  doc.body = body
  return { doc, clickHandlers }
}

test('open_link verb calls api.openLink with the url', () => {
  const { doc, clickHandlers } = makeInteractiveShim()
  global.document = doc
  const { renderWidget } = loadWidgets()
  const links = []
  const w = renderWidget({
    kind: 'kv', id: 'v',
    data: { entries: [{ key: 'k', value: 'v' }] },
    actions: [{ id: 'go', verb: 'open_link', label: 'Open', url: 'https://example.test/' }],
  }, {
    sessionId: 's', sendPrompt: () => {},
    openLink: (u) => links.push(u),
  })
  // Find the action button (label "Open")
  const buttons = walk(w, (n) => n.tagName === 'BUTTON')
  const openBtn = buttons.find((b) => b._text === 'Open')
  assert.ok(openBtn)
  // Fire its click.
  const arr = clickHandlers.get(openBtn) || []
  for (const { evt, fn } of arr) if (evt === 'click') fn({ type: 'click' })
  assert.deepEqual(links, ['https://example.test/'])
})

test('open_artifact verb calls api.openArtifact with the artifactId', () => {
  const { doc, clickHandlers } = makeInteractiveShim()
  global.document = doc
  const { renderWidget } = loadWidgets()
  const opened = []
  const w = renderWidget({
    kind: 'kv', id: 'v',
    data: { entries: [{ key: 'k', value: 'v' }] },
    actions: [{ id: 'a', verb: 'open_artifact', label: 'Preview', artifactId: 'page.html' }],
  }, {
    sessionId: 's', sendPrompt: () => {},
    openArtifact: (id) => opened.push(id),
  })
  const buttons = walk(w, (n) => n.tagName === 'BUTTON')
  const previewBtn = buttons.find((b) => b._text === 'Preview')
  const arr = clickHandlers.get(previewBtn) || []
  for (const { evt, fn } of arr) if (evt === 'click') fn({ type: 'click' })
  assert.deepEqual(opened, ['page.html'])
})

test('note verb (RECORD-ONLY) fires api.onNote and never sendPrompt', () => {
  const { doc, clickHandlers } = makeInteractiveShim()
  global.document = doc
  global.CustomEvent = class { constructor(t, i) { this.type = t; this.detail = (i && i.detail) || {} } }
  const { renderWidget } = loadWidgets()
  const notes = []
  const sends = []
  const w = renderWidget({
    kind: 'kv', id: 'v',
    data: { entries: [{ key: 'k', value: 'v' }] },
    actions: [{ id: 'jot', verb: 'note', label: 'Jot', note: 'observed' }],
  }, {
    sessionId: 's',
    sendPrompt: (sid, t) => sends.push({ sid, t }),
    onNote: (detail) => notes.push(detail),
  })
  const buttons = walk(w, (n) => n.tagName === 'BUTTON')
  const jotBtn = buttons.find((b) => b._text === 'Jot')
  const arr = clickHandlers.get(jotBtn) || []
  for (const { evt, fn } of arr) if (evt === 'click') fn({ type: 'click' })
  assert.equal(notes.length, 1)
  assert.equal(notes[0].note, 'observed')
  assert.equal(sends.length, 0, 'note verb must not trigger sendPrompt')
})

test('unknown verb renders a DISABLED button with an unsupported tooltip', () => {
  const { doc, clickHandlers } = makeInteractiveShim()
  global.document = doc
  const { renderWidget } = loadWidgets()
  const sends = []
  const w = renderWidget({
    kind: 'kv', id: 'v',
    data: { entries: [{ key: 'k', value: 'v' }] },
    actions: [
      { id: 'teleport', verb: 'teleport', label: 'Teleport' },
    ],
  }, { sessionId: 's', sendPrompt: (_, t) => sends.push(t) })
  const buttons = walk(w, (n) => n.tagName === 'BUTTON')
  const tp = buttons.find((b) => b._text === 'Teleport')
  assert.ok(tp)
  assert.equal(tp.disabled, true)
  assert.match(tp.title, /unsupported action/)
  // Click has no effect (button is disabled and the handler bails).
  const arr = clickHandlers.get(tp) || []
  for (const { evt, fn } of arr) if (evt === 'click') fn({ type: 'click' })
  assert.equal(sends.length, 0)
})

test('open_link missing url renders as broken', () => {
  const { doc } = makeInteractiveShim()
  global.document = doc
  const { renderWidget } = loadWidgets()
  const w = renderWidget({
    kind: 'kv', id: 'v',
    data: { entries: [] },
    actions: [{ id: 'nolink', verb: 'open_link', label: 'Open (bad)', url: '' }],
  }, { sessionId: 's', sendPrompt: () => {} })
  const buttons = walk(w, (n) => n.tagName === 'BUTTON')
  const bad = buttons.find((b) => b._text === 'Open (bad)')
  assert.equal(bad.disabled, true)
  assert.match(bad.title, /missing "url"/)
})

test('broken envelope (missing kind) sets widget-broken class and banner', () => {
  const { doc } = makeInteractiveShim()
  global.document = doc
  const { renderWidget } = loadWidgets()
  // renderWidget short-circuits on missing kind (it checks typeof at entry)
  // so we take a path with a valid kind but a broken action to exercise the
  // envelope validator's action-level broken output.
  const w = renderWidget({
    kind: 'kv', id: '',
    data: { entries: [] },
    actions: [{ id: 'x', verb: 'teleport', label: '?' }],
  }, { sessionId: 's', sendPrompt: () => {} })
  // Envelope validator: id missing is `warn`, action is `broken`, so the
  // whole spec is broken.
  assert.equal(w.attrs['data-broken'], '1')
  assert.ok(w.classList.contains('widget-broken'))
})
