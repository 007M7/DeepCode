// Tests for the in-stream inline artifact preview (lane-artifact-inline).
//
// Two surfaces:
//   (a) Behavior — load src/renderer/artifacts.js against a handrolled DOM
//       stub (same approach as lane-ctx-deep-dom.test.js), drive the real
//       onArtifactEvent path, then click the preview toggle and assert the
//       region expands and builds the right content (md render / html
//       iframe / server-down fallback). The real md-mini module is wired in
//       as window.__dshMdMini so the md branch renders genuine DOM.
//   (b) Source + CSS locks — the iframe sandbox value (no allow-same-origin)
//       and the preview stylesheet block, so security-relevant drift trips
//       a gate even if the behavior stub is loosened.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')

// ---- DOM stub ------------------------------------------------------------
// Covers exactly what artifacts.js touches: createElement/createTextNode,
// append/appendChild, className/classList, dataset, hidden, open, textContent,
// innerHTML (stored, never parsed), setAttribute/getAttribute,
// addEventListener + a dispatch helper, and querySelector/querySelectorAll /
// closest for the specific selectors the module uses.

function makeEl(tag, doc) {
  const el = {
    tagName: tag ? String(tag).toUpperCase() : undefined,
    nodeType: tag ? 1 : 3,
    ownerDocument: doc,
    className: '',
    _text: '',
    innerHTML: '',
    hidden: false,
    open: false,
    src: '',
    href: '',
    title: '',
    type: '',
    disabled: false,
    dataset: {},
    _attrs: {},
    _listeners: {},
    _children: [],
    parentNode: null,
    scrollTop: 0,
    scrollHeight: 0,
    offsetWidth: 0,
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c) },
      remove(c) { this._set.delete(c) },
      contains(c) { return this._set.has(c) },
    },
    appendChild(c) { c.parentNode = el; el._children.push(c); return c },
    append(...kids) { for (const k of kids) { k.parentNode = el; el._children.push(k) } },
    removeChild(c) {
      const i = el._children.indexOf(c)
      if (i >= 0) el._children.splice(i, 1)
      return c
    },
    remove() { if (el.parentNode) el.parentNode.removeChild(el) },
    replaceWith(next) {
      if (!el.parentNode) return
      const i = el.parentNode._children.indexOf(el)
      if (i >= 0) el.parentNode._children[i] = next
      next.parentNode = el.parentNode
    },
    setAttribute(k, v) { el._attrs[k] = String(v) },
    getAttribute(k) { return k in el._attrs ? el._attrs[k] : null },
    removeAttribute(k) { delete el._attrs[k] },
    addEventListener(t, fn) { (el._listeners[t] = el._listeners[t] || []).push(fn) },
    dispatch(t, ev) { for (const fn of el._listeners[t] || []) fn(ev || {}) },
    set textContent(v) { el._text = String(v); el._children = [] },
    get textContent() {
      if (el.nodeType === 3) return el._text
      if (el._children.length === 0) return el._text
      return el._children.map((c) => c.textContent).join('')
    },
    closest(sel) {
      let n = el
      while (n) {
        if (matches(n, sel)) return n
        n = n.parentNode
      }
      return null
    },
    querySelector(sel) { return queryAll(el, sel)[0] || null },
    querySelectorAll(sel) { return queryAll(el, sel) },
  }
  return el
}

// Minimal selector matcher: 'tag', '.class', '[attr]', '[attr="v"]'.
function matches(el, sel) {
  if (!el || el.nodeType !== 1) return false
  sel = sel.trim()
  if (sel.startsWith('.')) {
    const cls = sel.slice(1)
    return el.classList._set.has(cls) || String(el.className).split(/\s+/).includes(cls)
  }
  const attrEq = /^\[([\w-]+)="([^"]*)"\]$/.exec(sel)
  if (attrEq) return (el.dataset[toCamel(attrEq[1])] ?? el._attrs[attrEq[1]]) === attrEq[2]
  const attr = /^\[([\w-]+)\]$/.exec(sel)
  if (attr) return el._attrs[attr[1]] != null || el.dataset[toCamel(attr[1])] != null
  return el.tagName === sel.toUpperCase()
}
function toCamel(s) { return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase()) }

// querySelectorAll supporting comma lists and ':scope > sel'. Descendant
// search otherwise (children recursively).
function queryAll(root, sel) {
  const out = []
  for (const part of sel.split(',').map((s) => s.trim())) {
    if (part.startsWith(':scope >')) {
      const child = part.slice(':scope >'.length).trim()
      for (const c of root._children) if (matches(c, child)) out.push(c)
    } else {
      const walk = (n) => {
        for (const c of n._children || []) {
          if (matches(c, part)) out.push(c)
          walk(c)
        }
      }
      walk(root)
    }
  }
  return out
}

function makeDoc() {
  const doc = {
    readyState: 'complete',
    _byId: {},
    createElement(tag) { return makeEl(tag, doc) },
    createTextNode(t) { const n = makeEl(null, doc); n._text = String(t); return n },
    getElementById(id) { return doc._byId[id] || null },
    addEventListener() {},
  }
  return doc
}

function findAllByClass(root, cls, out) {
  out = out || []
  if (!root) return out
  const has = (root.classList && root.classList._set.has(cls)) ||
    String(root.className || '').split(/\s+/).includes(cls)
  if (has) out.push(root)
  for (const c of root._children || []) findAllByClass(c, cls, out)
  return out
}

// ---- module loader -------------------------------------------------------
// Fresh module instance per test with the globals it reads. Returns the
// exposed __dshArtifacts API plus the stubbed doc/window/stream so tests can
// drive events and inspect the resulting tree.

function loadArtifacts(opts) {
  opts = opts || {}
  const doc = makeDoc()
  const stream = doc.createElement('div')
  doc._byId.stream = stream

  const dsh = {
    onArtifact() {},
    openArtifact: async () => ({ ok: true }),
    getArtifactBase: opts.getArtifactBase || (async () => ({ url: null, dir: '/tmp/a' })),
    openExternalUrl: opts.openExternalUrl || (() => {}),
  }
  const win = { dsh }
  // Real md-mini so the md branch renders genuine DOM.
  const md = require('../src/renderer/md-mini.js')
  win.__dshMdMini = md

  const sandbox = {
    window: win,
    document: doc,
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Date,
    module: { exports: {} },
  }
  win.window = win

  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/artifacts.js'), 'utf8')
  const vm = require('node:vm')
  vm.runInNewContext(src, sandbox)

  return { api: win.__dshArtifacts, doc, win, stream, dsh }
}

// The md/html card lands inside the auto-built panel's `.artifact-group`.
function firstCard(stream) {
  return findAllByClass(stream, 'artifact-card')[0]
}
function tick() { return new Promise((r) => setTimeout(r, 0)) }

// ---- behavior: collapsed by default -------------------------------------

test('inline preview: md card starts collapsed (region hidden, caret ▸)', () => {
  const { api, stream } = loadArtifacts()
  api.onArtifactEvent({ artifactId: 'notes.md', kind: 'md', version: 1, blob: '# Hi\n\nbody' })
  const card = firstCard(stream)
  assert.ok(card, 'expected an artifact card in the stream')
  const region = findAllByClass(card, 'artifact-preview-region')[0]
  const toggle = findAllByClass(card, 'artifact-preview-toggle')[0]
  assert.ok(region && toggle, 'expected preview toggle + region')
  assert.equal(region.hidden, true)
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')
})

test('inline preview: non-md/html kind gets NO preview strip', () => {
  const { api, stream } = loadArtifacts()
  api.onArtifactEvent({ artifactId: 'chart.svg', kind: 'svg', version: 1, blob: '<svg/>' })
  const card = firstCard(stream)
  assert.equal(findAllByClass(card, 'artifact-preview').length, 0)
})

// ---- behavior: md expand renders real DOM -------------------------------

test('inline preview: expanding md builds rendered markdown, no raw HTML nodes', () => {
  const { api, stream } = loadArtifacts()
  api.onArtifactEvent({
    artifactId: 'doc.md',
    kind: 'md',
    version: 1,
    blob: '# Title\n\n**bold** and `code`\n\n<script>x</script>',
  })
  const card = firstCard(stream)
  const toggle = findAllByClass(card, 'artifact-preview-toggle')[0]
  toggle.dispatch('click', { preventDefault() {}, stopPropagation() {} })

  const region = findAllByClass(card, 'artifact-preview-region')[0]
  assert.equal(region.hidden, false)
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')
  const mdBlock = findAllByClass(card, 'artifact-preview-md')[0]
  assert.ok(mdBlock, 'expected rendered markdown block')
  assert.equal(findAllByClass(mdBlock, 'md-mini-h1').length, 1)
  // The <script> stayed literal text — no script element was created.
  const scripts = []
  ;(function walk(n) { for (const c of n._children || []) { if (c.tagName === 'SCRIPT') scripts.push(c); walk(c) } })(mdBlock)
  assert.equal(scripts.length, 0)
  assert.ok(mdBlock.textContent.includes('<script>x</script>'))
})

test('inline preview: md link routes through openExternalUrl', () => {
  const opened = []
  const { api, stream } = loadArtifacts({ openExternalUrl: (u) => opened.push(u) })
  api.onArtifactEvent({
    artifactId: 'links.md',
    kind: 'md',
    version: 1,
    blob: 'see [site](https://x.test/p)',
  })
  const card = firstCard(stream)
  findAllByClass(card, 'artifact-preview-toggle')[0]
    .dispatch('click', { preventDefault() {}, stopPropagation() {} })
  const link = findAllByClass(card, 'md-mini-link')[0]
  assert.ok(link, 'expected a rendered md link')
  link.dispatch('click', { preventDefault() {}, stopPropagation() {} })
  assert.deepEqual(opened, ['https://x.test/p'])
})

test('inline preview: md with no blob shows honest "content not supplied" note', () => {
  const { api, stream } = loadArtifacts()
  // Real ArtifactServer path — event carries no blob.
  api.onArtifactEvent({ artifactId: 'server.md', kind: 'md', version: 1, path: '/a/server.md' })
  const card = firstCard(stream)
  findAllByClass(card, 'artifact-preview-toggle')[0]
    .dispatch('click', { preventDefault() {}, stopPropagation() {} })
  assert.equal(findAllByClass(card, 'artifact-preview-md').length, 0)
  const note = findAllByClass(card, 'artifact-preview-note')[0]
  assert.ok(note, 'expected a fallback note')
})

test('inline preview: collapse toggles region back to hidden', () => {
  const { api, stream } = loadArtifacts()
  api.onArtifactEvent({ artifactId: 't.md', kind: 'md', version: 1, blob: '# x' })
  const card = firstCard(stream)
  const toggle = findAllByClass(card, 'artifact-preview-toggle')[0]
  const region = findAllByClass(card, 'artifact-preview-region')[0]
  toggle.dispatch('click', { preventDefault() {}, stopPropagation() {} })
  assert.equal(region.hidden, false)
  toggle.dispatch('click', { preventDefault() {}, stopPropagation() {} })
  assert.equal(region.hidden, true)
})

// ---- behavior: html iframe + fallback -----------------------------------

test('inline preview: html expand mounts sandboxed iframe when server URL present', async () => {
  const { api, stream } = loadArtifacts()
  api.onArtifactEvent({
    artifactId: 'page.html',
    kind: 'html',
    version: 1,
    url: 'http://127.0.0.1:9812/a/page.html/',
  })
  const card = firstCard(stream)
  findAllByClass(card, 'artifact-preview-toggle')[0]
    .dispatch('click', { preventDefault() {}, stopPropagation() {} })
  await tick()
  const frame = findAllByClass(card, 'artifact-preview-frame')[0]
  assert.ok(frame, 'expected an iframe')
  assert.equal(frame.tagName, 'IFRAME')
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts')
  assert.ok(!/allow-same-origin/.test(frame.getAttribute('sandbox')))
  assert.equal(frame.src, 'http://127.0.0.1:9812/a/page.html/')
})

test('inline preview: html falls back to open-in-browser when server is down', async () => {
  const { api, stream } = loadArtifacts({ getArtifactBase: async () => ({ url: null }) })
  // No `url` on the event AND base.url null → server down.
  api.onArtifactEvent({ artifactId: 'down.html', kind: 'html', version: 1, path: '/a/down.html' })
  const card = firstCard(stream)
  findAllByClass(card, 'artifact-preview-toggle')[0]
    .dispatch('click', { preventDefault() {}, stopPropagation() {} })
  await tick()
  assert.equal(findAllByClass(card, 'artifact-preview-frame').length, 0)
  const note = findAllByClass(card, 'artifact-preview-note')[0]
  assert.ok(note, 'expected a fallback note when server is down')
  // The fallback offers an Open-in-browser button.
  const btns = findAllByClass(note, 'artifact-open')
  assert.ok(btns.length >= 1)
})

test('inline preview: html url composed from base when event lacks url', async () => {
  const { api, stream } = loadArtifacts({
    getArtifactBase: async () => ({ url: 'http://127.0.0.1:7000' }),
  })
  api.onArtifactEvent({ artifactId: 'nested/page.html', kind: 'html', version: 1 })
  const card = firstCard(stream)
  findAllByClass(card, 'artifact-preview-toggle')[0]
    .dispatch('click', { preventDefault() {}, stopPropagation() {} })
  await tick()
  const frame = findAllByClass(card, 'artifact-preview-frame')[0]
  assert.ok(frame)
  // encodeURIComponent keeps `/` as a path separator (server contract).
  assert.equal(frame.src, 'http://127.0.0.1:7000/a/nested/page.html/')
})

// ---- behavior: per-card open-state memory -------------------------------

test('inline preview: open state remembered in the session bucket', () => {
  const { api, stream } = loadArtifacts()
  api.onArtifactEvent({ artifactId: 'mem.md', kind: 'md', version: 1, blob: '# x' })
  const card = firstCard(stream)
  const toggle = findAllByClass(card, 'artifact-preview-toggle')[0]
  toggle.dispatch('click', { preventDefault() {}, stopPropagation() {} })
  const bucket = api._bySession.get(api.getActiveSessionId())
  assert.ok(bucket.previewOpen.has('mem.md'), 'expanding should record open state')
  toggle.dispatch('click', { preventDefault() {}, stopPropagation() {} })
  assert.ok(!bucket.previewOpen.has('mem.md'), 'collapsing should clear it')
})

// ---- source + css locks --------------------------------------------------

const artifactsSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/artifacts.js'), 'utf8')
const styleCss = fs.readFileSync(path.join(ROOT, 'src/renderer/style.css'), 'utf8')

test('inline preview: iframe sandbox is allow-scripts only (no same-origin)', () => {
  assert.match(artifactsSrc, /setAttribute\(['"]sandbox['"],\s*['"]allow-scripts['"]\)/)
  // The sandbox VALUE must never grant same-origin. (The word may appear in
  // an explanatory comment; guard the actual setAttribute argument instead.)
  const sandboxCalls = artifactsSrc.match(/setAttribute\(['"]sandbox['"],\s*['"][^'"]*['"]\)/g) || []
  for (const call of sandboxCalls) {
    assert.ok(!/allow-same-origin/.test(call), 'sandbox must never grant allow-same-origin')
  }
})

test('inline preview: md branch renders via __dshMdMini, never innerHTML', () => {
  assert.match(artifactsSrc, /window\.__dshMdMini/)
  // buildMdPreview / buildHtmlPreview must not assign innerHTML from content.
  const previewRegion = artifactsSrc.slice(
    artifactsSrc.indexOf('function buildMdPreview'),
    artifactsSrc.indexOf('function invokeOpen'),
  )
  assert.ok(!/\.innerHTML\s*=/.test(previewRegion), 'no innerHTML in preview builders')
})

test('inline preview: CSS defines the preview + iframe blocks', () => {
  assert.match(styleCss, /\.artifact-preview-toggle\s*\{/)
  assert.match(styleCss, /\.artifact-preview-md\s*\{/)
  assert.match(styleCss, /\.artifact-preview-frame\s*\{/)
  assert.match(styleCss, /\.artifact-preview-frame[\s\S]{0,120}height:\s*360px/)
})
