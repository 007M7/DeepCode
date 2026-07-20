// Shared test harness for renderer.js unit tests. Runs the whole 2000-loc
// renderer script inside `node --test` against a minimal document/window
// stub. The renderer's IIFE entrypoint is written to run inside Electron;
// the shim gives it just enough DOM and `window.dsh` to boot without
// crashing so its `onSessionEvent` / `selectSession` / `onInitialized`
// closures are reachable via the `window.__dshRenderer` debug seam.
//
// Why this shape (vs. jsdom): jsdom isn't a dep, and pulling it in for
// four tests bloats the dev tree. Renderer.js already exposes a debug
// seam (`window.__dshRenderer`, see renderer.js §"Debug seam") that
// exists for real Electron E2E tests. The shim mirrors what that E2E
// harness sees, so writing against it keeps the seam load-bearing.

'use strict'

const fs = require('node:fs')
const path = require('node:path')

// -- DOM stub ---------------------------------------------------------------

function makeElement(tagName) {
  const children = []
  const listeners = {} // eventName -> Array<fn>
  const el = {
    tagName: String(tagName || 'DIV').toUpperCase(),
    children,
    _text: '',
    _innerHTML: '',
    attrs: {},
    style: {},
    dataset: {},
    disabled: false,
    hidden: false,
    parentElement: null,
    // Real DOM Node exposes both `parentElement` (Element-only parent)
    // and `parentNode` (any-parent, incl. #document). Renderer code
    // reads both interchangeably as truthy/falsy attach checks (e.g.
    // `traceCard.parentNode` in finishTurnContainer's drawer guard —
    // F-3 fix, 2026-07-18). Alias via a getter so any parentElement
    // mutation is mirrored transparently.
    get parentNode() { return this.parentElement },
    _listeners: listeners,
    // Read-through backing store; classList is used as both a set and a
    // getter target so the shim mirrors the flavour renderer.js expects.
    classList: {
      _s: new Set(),
      add(...names) { for (const n of names) this._s.add(n) },
      remove(...names) { for (const n of names) this._s.delete(n) },
      toggle(n, force) {
        if (force === undefined) {
          if (this._s.has(n)) this._s.delete(n); else this._s.add(n)
          return this._s.has(n)
        }
        if (force) this._s.add(n); else this._s.delete(n)
        return force
      },
      contains(n) { return this._s.has(n) },
    },
    get textContent() {
      if (this._text) return this._text
      return this.children.map((c) => c.textContent || '').join('')
    },
    set textContent(v) { this._text = String(v); this.children.length = 0 },
    get innerHTML() { return this._innerHTML },
    set innerHTML(v) {
      this._innerHTML = String(v)
      // Renderer.js only uses innerHTML='' (clear); nothing else.
      if (v === '') this.children.length = 0
    },
    set className(v) {
      this._className = String(v)
      this.classList._s.clear()
      for (const c of String(v).split(/\s+/)) { if (c) this.classList.add(c) }
    },
    get className() { return this._className || '' },
    setAttribute(k, v) { this.attrs[k] = String(v) },
    getAttribute(k) { return this.attrs[k] },
    removeAttribute(k) { delete this.attrs[k] },
    appendChild(c) {
      // Real DOM appendChild removes the node from its current parent
      // before inserting; without this, the shim double-counts nodes
      // when the renderer reparents them (e.g. finishTurnContainer
      // lifting a trace-card from streamEl into the drawer — F-3 fix
      // 2026-07-18). Test suites keyed on `querySelectorAll('.trace-card')
      // .length` failed because the card lived in both children arrays.
      if (c.parentElement && c.parentElement !== el && Array.isArray(c.parentElement.children)) {
        const oldChildren = c.parentElement.children
        const oi = oldChildren.indexOf(c)
        if (oi >= 0) oldChildren.splice(oi, 1)
      }
      c.parentElement = el
      children.push(c)
      return c
    },
    append(...cs) {
      for (const c of cs) {
        if (c.parentElement && c.parentElement !== el && Array.isArray(c.parentElement.children)) {
          const oldChildren = c.parentElement.children
          const oi = oldChildren.indexOf(c)
          if (oi >= 0) oldChildren.splice(oi, 1)
        }
        c.parentElement = el
        children.push(c)
      }
    },
    prepend(...cs) {
      for (const c of cs.reverse()) { c.parentElement = el; children.unshift(c) }
    },
    replaceChildren(...cs) {
      children.length = 0
      for (const c of cs) { c.parentElement = el; children.push(c) }
    },
    // Ticket #15 (2026-07-17) stub widenings: insertBefore + removeChild +
    // replaceChild. The renderer's subagent-swap path (RUNNING card →
    // sealed card at the same anchor) calls all three. Semantics mirror
    // the DOM: reference==null appends; a not-found reference throws in
    // real DOM, but the shim degrades to append so a fixture race doesn't
    // crash the whole test.
    insertBefore(node, reference) {
      node.parentElement = el
      if (!reference) { children.push(node); return node }
      const i = children.indexOf(reference)
      if (i < 0) { children.push(node); return node }
      children.splice(i, 0, node)
      return node
    },
    removeChild(node) {
      const i = children.indexOf(node)
      if (i >= 0) { children.splice(i, 1); node.parentElement = null }
      return node
    },
    replaceChild(newNode, oldNode) {
      const i = children.indexOf(oldNode)
      if (i < 0) { children.push(newNode); newNode.parentElement = el; return oldNode }
      children[i] = newNode
      newNode.parentElement = el
      oldNode.parentElement = null
      return oldNode
    },
    get firstChild() { return children[0] || null },
    get lastChild() { return children[children.length - 1] || null },
    get nextSibling() {
      if (!el.parentElement) return null
      const sibs = el.parentElement.children
      const i = sibs.indexOf(el)
      return i >= 0 ? (sibs[i + 1] || null) : null
    },
    remove() {
      if (el.parentElement) {
        const pc = el.parentElement.children
        const i = pc.indexOf(el)
        if (i >= 0) pc.splice(i, 1)
        el.parentElement = null
      }
    },
    querySelector(sel) { return querySelectorImpl(el, sel) },
    querySelectorAll(sel) { return querySelectorAllImpl(el, sel) },
    addEventListener(name, fn) {
      if (!listeners[name]) listeners[name] = []
      listeners[name].push(fn)
    },
    removeEventListener(name, fn) {
      const arr = listeners[name]
      if (!arr) return
      const i = arr.indexOf(fn)
      if (i >= 0) arr.splice(i, 1)
    },
    // Test helper: fire a synthetic "click" (or any event) through registered
    // listeners. Not part of the real DOM API but lets tests exercise the
    // interrupt round-trip without a real MouseEvent.
    _fire(name, evt = {}) {
      const arr = listeners[name] || []
      for (const fn of arr.slice()) fn(evt)
    },
    focus() {},
    dispatchEvent() {},
    // rebindForkButton clones a button and replaces the old node — the
    // renderer uses this to shake off event listeners bound via
    // addEventListener. Provide minimal cloneNode + replaceWith to keep
    // that path alive under the shim.
    cloneNode(_deep) {
      const clone = makeElement(el.tagName)
      clone._className = el._className
      for (const c of el.classList._s) clone.classList._s.add(c)
      Object.assign(clone.attrs, el.attrs)
      Object.assign(clone.dataset, el.dataset)
      clone._text = el._text
      return clone
    },
    replaceWith(node) {
      if (!el.parentElement) return
      const pc = el.parentElement.children
      const i = pc.indexOf(el)
      if (i >= 0) { pc[i] = node; node.parentElement = el.parentElement }
      el.parentElement = null
    },
    getBoundingClientRect() {
      return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }
    },
    // Form-element hooks — a few code paths read/write .value / .disabled /
    // .type / .name / .placeholder. These property assignments are
    // observed by the selector engine's `readAttrLike` so that
    // `input[type=radio]` matches an element whose `.type` was set
    // property-style.
    _value: '',
    get value() { return this._value },
    set value(v) { this._value = String(v == null ? '' : v) },
    _type: '',
    get type() { return this._type },
    set type(v) { this._type = String(v); this.attrs.type = String(v) },
    _name: '',
    get name() { return this._name },
    set name(v) { this._name = String(v); this.attrs.name = String(v) },
    _placeholder: '',
    get placeholder() { return this._placeholder },
    set placeholder(v) { this._placeholder = String(v) },
    scrollIntoView() {},
    click() { el._fire('click', { target: el, stopPropagation() {} }) },
  }
  return el
}

function walkAll(node, out = []) {
  if (!node) return out
  out.push(node)
  if (node.children) for (const c of node.children) walkAll(c, out)
  return out
}

// Simple selector matcher: covers `.class`, `#id`, `[data-x]`, `[data-x=y]`,
// and one-level combinations (`.class[data-x]`). Renderer.js's queries fit
// this subset; anything unrecognised falls back to `null` / `[]`.
function readAttrLike(el, key) {
  // A few DOM properties are commonly set via `el.type = 'radio'` or
  // `el.name = 'q'` but the underlying attribute is what selectors match
  // against. Mirror the browser's read-through so `[type=radio]` finds an
  // element whose `_type` was set property-style.
  if (key in el.attrs) return el.attrs[key]
  const propKey = '_' + key
  if (propKey in el) return el[propKey]
  // Ticket #15 (2026-07-17) test-harness widening: `[data-foo-bar]` selector
  // must map to `el.dataset.fooBar` — the browser stores every dataset write
  // as an attribute automatically. Without this the shim silently misses
  // any selector keyed on a data-* attribute set via `el.dataset.x = v`.
  if (key.startsWith('data-') && el.dataset) {
    const camel = key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    if (camel in el.dataset) return el.dataset[camel]
  }
  return undefined
}
function matches(el, sel) {
  const s = sel.trim()
  const parts = s.match(/(^[a-zA-Z][a-zA-Z0-9-]*)?((?:\.[a-zA-Z_-][\w-]*)*)?((?:\[[^\]]+\])*)?/)
  if (!parts) return false
  const [, tag, cls, attr] = parts
  if (tag && el.tagName !== tag.toUpperCase()) return false
  if (cls) {
    for (const c of cls.split('.').filter(Boolean)) {
      if (!el.classList.contains(c)) return false
    }
  }
  if (attr) {
    const re = /\[([a-zA-Z_-][\w-]*)(?:=(?:"([^"]*)"|([^\]]*)))?\]/g
    let m
    while ((m = re.exec(attr))) {
      const key = m[1]
      const val = m[2] !== undefined ? m[2] : m[3]
      const got = readAttrLike(el, key)
      if (val === undefined) {
        if (got === undefined) return false
      } else {
        if (got !== val) return false
      }
    }
  }
  return true
}

function querySelectorImpl(root, sel) {
  for (const n of walkAll(root)) {
    if (n === root) continue
    try { if (matches(n, sel)) return n } catch (_) { /* ignore */ }
  }
  return null
}

function querySelectorAllImpl(root, sel) {
  const out = []
  for (const n of walkAll(root)) {
    if (n === root) continue
    try { if (matches(n, sel)) out.push(n) } catch (_) { /* ignore */ }
  }
  return out
}

// -- window.dsh stub --------------------------------------------------------

// The stub records every call for assertion + resolves promises with
// harmless shapes so the module boots. Tests override individual methods
// via `dsh.__stub(name, impl)` when they need to shape a specific reply.
function makeDshStub() {
  const calls = []
  const listeners = {}
  const dsh = {
    __calls: calls,
    __listeners: listeners,
    __stub(name, impl) { dsh[name] = impl },
    // Notification streams — installed listeners are captured so tests can
    // fire synthetic events straight into onNotify / onInitialized handlers.
    onNotify(cb) { listeners.onNotify = cb },
    onStatus(cb) { listeners.onStatus = cb },
    onCrash(cb) { listeners.onCrash = cb },
    onStderr(cb) { listeners.onStderr = cb },
    onError(cb) { listeners.onError = cb },
    onInitialized(cb) { listeners.onInitialized = cb },
    onInterruptIncoming(cb) { listeners.onInterruptIncoming = cb },
    onInterruptInvalidate(cb) { listeners.onInterruptInvalidate = cb },
    // Blocking calls used at boot — return harmless promises so bootUi runs
    // to completion without throwing. Individual tests can override.
    async listProfiles() { calls.push(['listProfiles']); return [] },
    async listSessions() { calls.push(['listSessions']); return { entries: [] } },
    async runtimeStatus() { calls.push(['runtimeStatus']); return { status: 'ok', profile: 'test', model: 'test-model' } },
    async newSession() { calls.push(['newSession']); return { id: 'test-session' } },
    async resumeSession(id) { calls.push(['resumeSession', id]); return {} },
    async sessionEvents(id, opts) { calls.push(['sessionEvents', id, opts]); return { events: [] } },
    async sendPrompt(sid, text) { calls.push(['sendPrompt', sid, text]); return {} },
    async cancelPrompt(sid, reason) { calls.push(['cancelPrompt', sid, reason]); return { ok: true } },
    async forkSession(opts) { calls.push(['forkSession', opts]); return { id: 'forked' } },
    async setSessionConfig(sid, patch) { calls.push(['setSessionConfig', sid, patch]); return {} },
    async compactSession(sid) { calls.push(['compactSession', sid]); return {} },
    async resolveInterrupt(id, result) { calls.push(['resolveInterrupt', id, result]); return {} },
    async startRuntime(profile) { calls.push(['startRuntime', profile]); return {} },
    onboarding: {
      async status() { return { cwd: '/tmp', approvalMode: 'ask-first' } },
      async reset() { return {} },
    },
  }
  return dsh
}

// -- module loader ----------------------------------------------------------

// Load renderer.js against a fresh stub. Returns the shim's window +
// document + the __dshRenderer debug seam. Boot-time calls that await
// promises resolve on the microtask queue; the harness returns a promise
// that resolves after those settle so tests see a fully-booted state.
async function loadRenderer(customStubs = {}, options = {}) {
  const documentStub = {
    body: makeElement('body'),
    _byId: new Map(),
    // Real DOM nodes always expose `ownerDocument`; modules that build their
    // own subtree (e.g. session-log-view.js) resolve the document off the
    // container's ownerDocument. Stamp it so those modules find a document.
    createElement(tag) { const e = makeElement(tag); e.ownerDocument = documentStub; return e },
    createElementNS(_ns, tag) { const e = makeElement(tag); e.ownerDocument = documentStub; return e },
    createTextNode(txt) {
      // A text node is a leaf with no children — mirror the API surface
      // just enough for `append(inp, document.createTextNode(...))`.
      const t = makeElement('#text')
      t._text = String(txt)
      return t
    },
    getElementById(id) {
      const cached = this._byId.get(id)
      if (cached) return cached
      // Manufacture on-demand. This mirrors what the shim would find in
      // index.html if we'd hydrated the whole DOM — every getElementById
      // in renderer.js gets a stub, and the test can reach the same node
      // later via document.getElementById(id).
      const el = makeElement('div')
      el.setAttribute('id', id)
      el.ownerDocument = documentStub
      this._byId.set(id, el)
      documentStub.body.appendChild(el)
      return el
    },
    querySelector(sel) { return querySelectorImpl(documentStub.body, sel) },
    querySelectorAll(sel) { return querySelectorAllImpl(documentStub.body, sel) },
    addEventListener() {},
  }
  const dsh = makeDshStub()
  for (const [name, impl] of Object.entries(customStubs)) dsh.__stub(name, impl)
  const windowStub = {
    dsh,
    document: documentStub,
    location: { href: 'file:///tmp/', origin: 'file://' },
    localStorage: {
      _s: new Map(),
      getItem(k) { return this._s.get(k) ?? null },
      setItem(k, v) { this._s.set(k, String(v)) },
      removeItem(k) { this._s.delete(k) },
    },
    requestAnimationFrame(cb) { setTimeout(cb, 0) },
    setTimeout, clearTimeout, setInterval, clearInterval,
    alert() {},
    confirm() { return false },
    prompt() { return null },
    addEventListener() {},
    // Renderer.js reads several `__dshFoo` extensions injected by sibling
    // scripts. Leave them undefined; renderer.js guards each read.
  }
  // Pure-module namespaces the renderer reads: preload them via CommonJS
  // so their global handles are present before renderer.js runs. session-tree.js
  // sets `globalThis.SessionTree` in the browser (== window), so we surface
  // it both on window (unused here) and inside the wrapped scope below.
  const preloadPure = [
    ['event-filter.js', '__dshEventFilter'],
    ['context-meter.js', '__dshContextMeter'],
    ['compact-badge.js', '__dshCompactBadge'],
    ['compact-card.js', '__dshCompactCard'],
    ['context-rail.js', '__dshContextRail'],
    ['workflow-view.js', '__dshWorkflowView'],
    ['subagent-view.js', '__dshSubagentView'],
    ['subagent-lineage.js', '__dshSubagentLineage'],
    ['debug-fixtures.js', '__dshDebugFixtures'],
    ['inject-family.js', '__dshInjectFamily'],
    ['raw-inject.js', '__dshRawInject'],
    ['trace-aggregator.js', '__dshTraceAgg'],
    ['trace-timeline.js', '__dshTraceTimeline'],
    ['trace-detail-pane.js', '__dshTraceDetailPane'],
    // lane-p1-tabs: the Chat pane's Trace/时序/Log tabs read these three.
    // trace-tri-view wraps the timeline/graph projections; session-log-view
    // owns the full-history Log tab. Both are guarded on read in renderer.js,
    // but preloading lets renderer-harness tests exercise the tab helpers.
    ['trace-tri-view.js', '__dshTraceTriView'],
    ['session-log-view.js', '__dshSessionLogView'],
    ['edit-rerun-header.js', '__dshEditRerunHeader'],
    ['panels-c.js', '__dshPanelsC'],
    ['tool-cards.js', '__dshToolCards'],
    ['widgets.js', '__dshWidgets'],
    ['capabilities.js', '__dshCapabilities'],
    ['msg-queue-model.js', '__dshMsgQueueModel'],
  ]
  for (const [file, key] of preloadPure) {
    const p = path.join(__dirname, '..', 'src', 'renderer', file)
    const mod = require(p)
    windowStub[key] = mod
  }
  const SessionTree = require(path.join(__dirname, '..', 'src', 'renderer', 'session-tree.js'))
  // Preboot hook (N2 test seam, 2026-07-16): let a caller inject window
  // properties before renderer.js runs. Used by
  // renderer-qa-seed-session.test.js to plant `window.dshQa` in the same
  // shape the preload would create when DSH_QA=1.
  if (typeof options.preboot === 'function') options.preboot(windowStub)
  // Load renderer.js as a wrapped function so it sees our window/document
  // as globals. Same shape quick-chat.test.js uses.
  //
  // mock-fixtures.js (task #96 F-05) sits alongside renderer.js under the
  // same shared global scope in production (loaded as a classic <script>
  // before renderer.js in index.html). The Debug popover's boot code in
  // renderer.js references those `function mock*` decls by name at
  // top-level, so the harness must give the same "one shared lexical
  // scope" — concat the source before renderer.js. Function declarations
  // inside a `new Function` scope hoist to the enclosing wrapper, which
  // is exactly what the browser gives us with the two script tags.
  const mockFixturesSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'mock-fixtures.js'),
    'utf8',
  )
  const rendererSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'),
    'utf8',
  )
  const src = mockFixturesSrc + '\n' + rendererSrc
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'window', 'document', 'globalThis', 'SessionTree',
    'const setTimeout = window.setTimeout;\n' +
    'const clearTimeout = window.clearTimeout;\n' +
    src,
  )
  fn(windowStub, documentStub, windowStub, SessionTree)
  // Drain the microtask queue so bootUi's promises settle before tests run.
  await new Promise((res) => setTimeout(res, 5))
  return {
    window: windowStub,
    document: documentStub,
    dsh,
    listeners: dsh.__listeners,
    renderer: windowStub.__dshRenderer,
  }
}

module.exports = { loadRenderer, makeElement }
