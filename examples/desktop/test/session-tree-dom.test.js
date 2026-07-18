// DOM-shape tests for the Session Tree page controller. Task #198: verify
// the readability rewrite lands the expected geometry — fork children get
// their own labels (never verbatim-copied parent titles), children live
// inside a nested <ul.tree-children>, the rail-kind data attribute reflects
// the edge kind so the CSS border-left picks the right style.
//
// Why this shape: session-tree-page.js is an IIFE guarded by `window.dsh`
// (see the file header). We can eval() the source inside a minimal
// window/document stub — same trick renderer-harness.js uses for
// renderer.js — and drive it through its public seam `window.__dshTree`.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { makeElement: baseMakeElement } = require('./renderer-harness.js')

// Small extension over the shared shim: give `style` a setProperty so the
// tree page's `li.style.setProperty('--depth', ...)` call doesn't throw.
function makeElement(tag) {
  const el = baseMakeElement(tag)
  el.style = { _s: {}, setProperty(k, v) { this._s[k] = String(v) }, getPropertyValue(k) { return this._s[k] || '' } }
  return el
}

// Walk a DOM tree and return every node matching a predicate. The shared
// shim's querySelector doesn't understand `data-*` attribute selectors
// because dataset writes bypass el.attrs; a small predicate walk is
// cheaper than teaching the selector engine.
function walk(root, out = []) {
  if (!root) return out
  if (Array.isArray(root.children)) {
    for (const c of root.children) {
      out.push(c)
      walk(c, out)
    }
  }
  return out
}
function findRow(document, sessionId) {
  for (const n of walk(document.body)) {
    if (n && n.classList && n.classList.contains('tree-row') && n.dataset && n.dataset.sessionId === sessionId) return n
  }
  return null
}
function findChildrenUL(row) {
  return (row.children || []).find((c) => c.tagName === 'UL' && c.classList.contains('tree-children'))
}
function findByClass(root, cls) {
  for (const n of walk(root)) {
    if (n && n.classList && n.classList.contains(cls)) return n
  }
  return null
}

// Small extension over the shared shim: give `style` a setProperty so the
// tree page's `li.style.setProperty('--depth', ...)` call doesn't throw.
function makeElement(tag) {
  const el = baseMakeElement(tag)
  el.style = { _s: {}, setProperty(k, v) { this._s[k] = String(v) }, getPropertyValue(k) { return this._s[k] || '' } }
  return el
}

function loadTreePage() {
  const docStub = {
    body: makeElement('body'),
    _byId: new Map(),
    _listeners: {},
    createElement(tag) { return makeElement(tag) },
    createTextNode(txt) { const t = makeElement('#text'); t._text = String(txt); return t },
    getElementById(id) {
      const cached = this._byId.get(id)
      if (cached) return cached
      const el = makeElement('div')
      el.setAttribute('id', id)
      this._byId.set(id, el)
      docStub.body.appendChild(el)
      return el
    },
    querySelector(sel) {
      // Walk body — reuse makeElement's own querySelector by pointing at body.
      return docStub.body.querySelector(sel)
    },
    querySelectorAll(sel) { return docStub.body.querySelectorAll(sel) },
    addEventListener(name, fn) {
      if (!this._listeners[name]) this._listeners[name] = []
      this._listeners[name].push(fn)
    },
    readyState: 'complete',
  }
  const windowStub = {
    document: docStub,
    dsh: {
      async forkSession() { return { childSessionId: 'x' } },
      async sessionEvents() { return { events: [] } },
    },
    // Sibling module handles the tree page reads defensively. The page
    // only touches __dshPanelsC (relativeTime, smartSessionTitle) and
    // __dshChat/__dshContextMeter — leave them undefined and the page
    // uses its fallback path.
    __dshChat: { getEntries() { return [] }, async refreshSessionList() {}, async selectSession() {} },
    __dshTabs: { switchTo() {} },
    setTimeout, clearTimeout,
  }
  // globalThis / CSS — the page reads CSS.escape defensively.
  const globalStub = { SessionTree: require('../src/renderer/session-tree.js') }
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'session-tree-page.js'),
    'utf8',
  )
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'window', 'document', 'globalThis', 'CSS',
    src,
  )
  fn(windowStub, docStub, globalStub, { escape: (s) => String(s).replace(/[^\w-]/g, '\\$&') })
  return { window: windowStub, document: docStub, tree: windowStub.__dshTree }
}

// --- Rendering fork children ------------------------------------------------

test('emitNode: fork child with duplicate title renders "(no new messages yet)" label', () => {
  const { window, document, tree } = loadTreePage()
  // Seed a minimal fork-tree via a stubbed getEntries. Reproduces the exact
  // bug the user hit — child.title == parent.title after seed replay.
  window.__dshChat.getEntries = () => [
    { sessionId: 'p', title: 'parent turn one', header: { title: 'parent turn one' }, lastEventTime: Date.now() - 1000, hasUserMessage: true },
    // Fork child that inherited the parent's title (the seed replay bug).
    { sessionId: 'c1', title: 'parent turn one', header: { title: 'parent turn one', parentSession: 'p', seedLength: 4 }, lastEventTime: Date.now() - 500, hasUserMessage: false },
    // Fork child that has its own message → label surfaces that message.
    { sessionId: 'c2', title: 'try a different palette', header: { title: 'try a different palette', parentSession: 'p', seedLength: 4 }, lastEventTime: Date.now() - 100, hasUserMessage: true },
  ]
  tree.render()

  // Parent row title = original title (no rewrite for roots).
  const parentRow = findRow(document, 'p')
  assert.ok(parentRow, 'parent row rendered')
  const parentTitle = findByClass(parentRow, 'tree-row-title')
  assert.equal(parentTitle.textContent, 'parent turn one', 'root row keeps its own title')

  // Fork child c1 — duplicate title path.
  const c1Row = findRow(document, 'c1')
  assert.ok(c1Row, 'first fork child rendered')
  const c1Title = findByClass(c1Row, 'tree-row-title')
  assert.equal(
    c1Title.textContent,
    'fork @ seq 3 · (no new messages yet)',
    'duplicate-title fork child shows the "no new messages yet" placeholder',
  )
  assert.ok(c1Title.classList.contains('is-untitled'), 'no-own-message label is muted')

  // Fork child c2 — own-message path.
  const c2Row = findRow(document, 'c2')
  const c2Title = findByClass(c2Row, 'tree-row-title')
  assert.equal(
    c2Title.textContent,
    'fork @ seq 3 · try a different palette',
    'own-message fork child shows its own signal',
  )
  assert.ok(!c2Title.classList.contains('is-untitled'), 'own-message label is not muted')
})

test('emitNode: fork children live inside <ul.tree-children> with rail-kind=fork', () => {
  const { window, document, tree } = loadTreePage()
  window.__dshChat.getEntries = () => [
    { sessionId: 'p', title: 'root work', header: { title: 'root work' }, lastEventTime: Date.now(), hasUserMessage: true },
    { sessionId: 'c', title: 'root work', header: { title: 'root work', parentSession: 'p', seedLength: 2 }, lastEventTime: Date.now() - 100, hasUserMessage: false },
  ]
  tree.render()

  const parentRow = findRow(document, 'p')
  const kids = findChildrenUL(parentRow)
  assert.ok(kids, 'children rendered inside nested <ul.tree-children> under the parent')
  assert.equal(kids.dataset.railKind, 'fork', 'rail-kind = fork for a normal fork child')
  // Child row lives inside the nested ul, NOT as a flat sibling of the parent.
  const childInside = kids.children.find((r) => r.classList.contains('tree-row') && r.dataset.sessionId === 'c')
  assert.ok(childInside, 'child row nests inside the children ul (not flat sibling)')
})

test('emitNode: subagent-origin children get rail-kind=subagent', () => {
  const { window, document, tree } = loadTreePage()
  window.__dshChat.getEntries = () => [
    { sessionId: 'p', title: 'parent', header: { title: 'parent' }, lastEventTime: Date.now(), hasUserMessage: true },
    { sessionId: 's', title: 'run lint', header: { title: 'run lint', parentSession: 'p', originKind: 'subagent', seedLength: 2 }, lastEventTime: Date.now() - 50, hasUserMessage: true },
  ]
  tree.render()

  const parentRow = findRow(document, 'p')
  const kids = findChildrenUL(parentRow)
  assert.ok(kids, 'children container rendered for subagent parent')
  assert.equal(kids.dataset.railKind, 'subagent', 'rail-kind = subagent when the child\'s origin is subagent')
  const subRow = kids.children.find((r) => r.classList.contains('tree-row') && r.dataset.sessionId === 's')
  assert.ok(subRow, 'subagent row nests inside the parent\'s ul.tree-children')
  assert.equal(subRow.dataset.edge, 'subagent', 'subagent row carries data-edge=subagent for CSS')
  // Label prefix uses the "subagent @ seq" kind so the reader can tell at
  // a glance the child was system-spawned, not user-forked.
  const subTitle = findByClass(subRow, 'tree-row-title')
  assert.ok(subTitle.textContent.startsWith('subagent @ seq'),
    `expected subagent-prefixed label, got: ${subTitle.textContent}`)
})

test('emitNode: root rows never render <ul.tree-children> when they have no forks', () => {
  const { window, document, tree } = loadTreePage()
  window.__dshChat.getEntries = () => [
    { sessionId: 'leaf', title: 'lone chat', header: { title: 'lone chat' }, lastEventTime: Date.now(), hasUserMessage: true },
  ]
  tree.render()

  const leafRow = findRow(document, 'leaf')
  assert.ok(leafRow, 'leaf root rendered')
  const kids = findChildrenUL(leafRow)
  assert.equal(kids, undefined, 'leaf root does not spawn an empty <ul.tree-children>')
})
