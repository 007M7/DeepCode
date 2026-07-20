// Cordis dedicated card unit tests. Runs under `node --test`, no Electron.
// Shares the hand-rolled DOM shim with tool-cards.test.js / widgets.test.js
// (see those files for why we don't pull in jsdom). Fixtures mirror the REAL
// upstream wire shapes (test/fixtures/cordis-wire-shapes.json).

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/cordis-wire-shapes.json'), 'utf8'))

function makeShim() {
  function make(tagName) {
    const el = {
      tagName: String(tagName).toUpperCase(),
      children: [],
      attrs: {},
      style: {},
      dataset: {},
      classList: {
        _s: new Set(),
        add(...names) { for (const n of names) this._s.add(n) },
        remove(...names) { for (const n of names) this._s.delete(n) },
        contains(n) { return this._s.has(n) },
        toggle(n) { if (this._s.has(n)) this._s.delete(n); else this._s.add(n) },
      },
      _text: '',
      get textContent() { return this._text },
      set textContent(v) { this._text = String(v); this.children = [] },
      set className(v) { this._className = String(v); for (const c of String(v).split(/\s+/)) this.classList.add(c) },
      get className() { return this._className || '' },
      setAttribute(k, v) { this.attrs[k] = String(v) },
      getAttribute(k) { return this.attrs[k] },
      appendChild(c) { this.children.push(c); return c },
      append(...cs) { for (const c of cs) this.children.push(c) },
      addEventListener() { /* no-op */ },
    }
    return el
  }
  const doc = { createElement: (t) => make(t) }
  return { doc }
}

function walk(node, pred, out = []) {
  if (!node || !node.tagName) return out
  if (pred(node)) out.push(node)
  for (const c of node.children || []) walk(c, pred, out)
  return out
}
function byClass(node, cls) { return walk(node, (n) => n.classList && n.classList.contains(cls)) }
function firstText(node, cls) { const h = byClass(node, cls)[0]; return h ? h._text : undefined }

function loadCard() {
  const p = require.resolve('../src/renderer/cordis-card.js')
  delete require.cache[p]
  return require('../src/renderer/cordis-card.js')
}

// ----- name detection --------------------------------------------------------

test('isCordisTool: only the three cordis names, and they match TOOL_FAMILIES', () => {
  global.document = makeShim().doc
  const { isCordisTool, CORDIS_TOOLS } = loadCard()
  assert.ok(isCordisTool('cordis_mount'))
  assert.ok(isCordisTool('cordis_unmount'))
  assert.ok(isCordisTool('cordis_inspect'))
  assert.ok(!isCordisTool('bash'))
  assert.ok(!isCordisTool('cordis_frobnicate'))
  assert.ok(!isCordisTool(null))
  // consistency with the family map that also identifies these names
  const tc = require('../src/renderer/tool-cards.js')
  for (const n of CORDIS_TOOLS) assert.equal(tc.toolFamilyFor(n).className, 'family-cordis')
})

// ----- parsers (pure, over real result text) --------------------------------

test('parseMountResult: active mount, no waiting', () => {
  global.document = makeShim().doc
  const { parseMountResult } = loadCard()
  const text = FIX.mount_ok.result.data.content[0].text
  const m = parseMountResult(text)
  assert.deepEqual(m, { id: 'dyn-1', pluginName: 'change-logger', state: 'active', waiting: [] })
})

test('parseMountResult: pending mount names the awaited services', () => {
  global.document = makeShim().doc
  const { parseMountResult } = loadCard()
  const text = FIX.mount_pending_waiting.result.data.content[0].text
  const m = parseMountResult(text)
  assert.equal(m.id, 'dyn-2')
  assert.equal(m.pluginName, 'greeter-consumer')
  assert.equal(m.state, 'pending')
  assert.deepEqual(m.waiting, ['greeter'])
})

test('parseMountResult: non-mount text yields null (falls back to raw)', () => {
  global.document = makeShim().doc
  const { parseMountResult } = loadCard()
  assert.equal(parseMountResult('mount code returned `undefined`'), null)
  assert.equal(parseMountResult(''), null)
  assert.equal(parseMountResult(null), null)
})

test('parseUnmountResult: id + plugin name', () => {
  global.document = makeShim().doc
  const { parseUnmountResult } = loadCard()
  const text = FIX.unmount_ok.result.data.content[0].text
  assert.deepEqual(parseUnmountResult(text), { id: 'dyn-1', pluginName: 'change-logger' })
  assert.equal(parseUnmountResult('no dynamic plugin with id "dyn-9"'), null)
})

test('parseInspectSections: splits `## ` headings into line arrays', () => {
  global.document = makeShim().doc
  const { parseInspectSections } = loadCard()
  const text = FIX.inspect_all.result.data.content[0].text
  const secs = parseInspectSections(text)
  assert.deepEqual(Object.keys(secs), ['services', 'plugins', 'tools', 'dynamic', 'api', 'events'])
  assert.ok(secs.tools.includes('- cordis_mount'))
  assert.ok(secs.dynamic.includes('- dyn-1: change-logger [active]'))
  // no headings → empty object
  assert.deepEqual(parseInspectSections('just some text'), {})
  assert.deepEqual(parseInspectSections(''), {})
})

// ----- mount card ------------------------------------------------------------

test('renderCordisCard mount ok: header id + kv block + add delta', () => {
  const { doc } = makeShim(); global.document = doc
  const { renderCordisCard } = loadCard()
  const el = renderCordisCard({
    name: 'cordis_mount',
    argsObj: JSON.parse(FIX.mount_ok.call.data.arguments),
    text: FIX.mount_ok.result.data.content[0].text,
    isError: false,
    doc,
  })
  assert.equal(el.getAttribute('data-cordis-op'), 'cordis_mount')
  assert.equal(el.getAttribute('data-tool-card-family'), 'cordis')
  assert.equal(firstText(el, 'card-cordis-id'), 'dyn-1')
  // status ok
  assert.ok(byClass(el, 'card-cordis-status')[0].classList.contains('ok'))
  // kv rows: id / name / state (no waiting)
  const keys = byClass(el, 'card-cordis-kv-key').map((n) => n._text)
  assert.deepEqual(keys, ['id', 'name', 'state'])
  // add-delta line for the mounted id
  const delta = byClass(el, 'card-cordis-delta')[0]
  assert.ok(delta.classList.contains('add'))
  assert.equal(firstText(delta, 'card-cordis-delta-entry'), 'dyn-1')
  // plugin source fold present (code arg captured)
  assert.equal(byClass(el, 'card-cordis-code').length, 1)
})

test('renderCordisCard mount pending: waiting row present', () => {
  const { doc } = makeShim(); global.document = doc
  const { renderCordisCard } = loadCard()
  const el = renderCordisCard({
    name: 'cordis_mount',
    argsObj: JSON.parse(FIX.mount_pending_waiting.call.data.arguments),
    text: FIX.mount_pending_waiting.result.data.content[0].text,
    isError: false,
    doc,
  })
  const keys = byClass(el, 'card-cordis-kv-key').map((n) => n._text)
  assert.deepEqual(keys, ['id', 'name', 'state', 'waiting'])
  const waitVal = byClass(el, 'card-cordis-kv-val').map((n) => n._text)
  assert.ok(waitVal.includes('greeter'))
})

test('renderCordisCard mount error: verbatim message, err status, no delta', () => {
  const { doc } = makeShim(); global.document = doc
  const { renderCordisCard } = loadCard()
  const el = renderCordisCard({
    name: 'cordis_mount',
    argsObj: JSON.parse(FIX.mount_error.call.data.arguments),
    text: FIX.mount_error.result.data.content[0].text,
    isError: true,
    doc,
  })
  assert.ok(byClass(el, 'card-cordis-status')[0].classList.contains('err'))
  const err = byClass(el, 'card-cordis-error')[0]
  assert.ok(err._text.includes('did you forget `return`'))
  assert.equal(byClass(el, 'card-cordis-delta').length, 0)
  assert.equal(byClass(el, 'card-cordis-kv').length, 0)
})

// ----- unmount card ----------------------------------------------------------

test('renderCordisCard unmount ok: kv + del delta on the removed id', () => {
  const { doc } = makeShim(); global.document = doc
  const { renderCordisCard } = loadCard()
  const el = renderCordisCard({
    name: 'cordis_unmount',
    argsObj: JSON.parse(FIX.unmount_ok.call.data.arguments),
    text: FIX.unmount_ok.result.data.content[0].text,
    isError: false,
    doc,
  })
  assert.equal(firstText(el, 'card-cordis-id'), 'dyn-1')
  const delta = byClass(el, 'card-cordis-delta')[0]
  assert.ok(delta.classList.contains('del'))
  assert.equal(firstText(delta, 'card-cordis-delta-entry'), 'dyn-1')
})

test('renderCordisCard unmount error: header id from args, message verbatim', () => {
  const { doc } = makeShim(); global.document = doc
  const { renderCordisCard } = loadCard()
  const el = renderCordisCard({
    name: 'cordis_unmount',
    argsObj: JSON.parse(FIX.unmount_error.call.data.arguments),
    text: FIX.unmount_error.result.data.content[0].text,
    isError: true,
    doc,
  })
  // header id still resolves from args even when the result is an error
  assert.equal(firstText(el, 'card-cordis-id'), 'dyn-9')
  assert.ok(byClass(el, 'card-cordis-error')[0]._text.includes('no dynamic plugin'))
  assert.equal(byClass(el, 'card-cordis-delta').length, 0)
})

// ----- inspect card ----------------------------------------------------------

test('renderCordisCard inspect: reuses injected buildJsonTree over parsed sections', () => {
  const { doc } = makeShim(); global.document = doc
  const { renderCordisCard } = loadCard()
  let seenValue = null
  let seenOpts = null
  const buildTree = (d, value, opts) => { seenValue = value; seenOpts = opts; const n = d.createElement('div'); n.className = 'stub-tree'; return n }
  const el = renderCordisCard({
    name: 'cordis_inspect',
    argsObj: {},
    text: FIX.inspect_all.result.data.content[0].text,
    isError: false,
    buildTree,
    doc,
  })
  // header id defaults to "all sections" when `what` is absent
  assert.equal(firstText(el, 'card-cordis-id'), 'all sections')
  // the tree host holds the stub tree (no new tree built here)
  assert.equal(byClass(el, 'stub-tree').length, 1)
  // buildJsonTree was fed the parsed section object + openDepth 1
  assert.deepEqual(Object.keys(seenValue), ['services', 'plugins', 'tools', 'dynamic', 'api', 'events'])
  assert.equal(seenOpts.openDepth, 1)
})

test('renderCordisCard inspect with `what`: header shows the section, tree over one key', () => {
  const { doc } = makeShim(); global.document = doc
  const { renderCordisCard } = loadCard()
  let seenValue = null
  const buildTree = (d, value) => { seenValue = value; const n = d.createElement('div'); n.className = 'stub-tree'; return n }
  const el = renderCordisCard({
    name: 'cordis_inspect',
    argsObj: JSON.parse(FIX.inspect_dynamic.call.data.arguments),
    text: FIX.inspect_dynamic.result.data.content[0].text,
    isError: false,
    buildTree,
    doc,
  })
  assert.equal(firstText(el, 'card-cordis-id'), 'dynamic')
  assert.deepEqual(Object.keys(seenValue), ['dynamic'])
})

test('renderCordisCard inspect: falls back to raw text when no tree builder', () => {
  const { doc } = makeShim(); global.document = doc
  const { renderCordisCard } = loadCard()
  const el = renderCordisCard({
    name: 'cordis_inspect',
    argsObj: {},
    text: FIX.inspect_all.result.data.content[0].text,
    isError: false,
    buildTree: null,
    doc,
  })
  assert.equal(byClass(el, 'card-cordis-raw').length, 1)
})
