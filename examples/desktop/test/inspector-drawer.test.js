// Tests for lane-p0-inspector — src/renderer/inspector-drawer.js.
//
// The inspector's projections (projectPretty / formatRaw / normalizeTab /
// kindForEvent) are pure and are the contract the three tabs render against;
// the DOM renderers (renderPretty / renderRaw / renderJson) take an injected
// `doc` so we exercise them with a hand-rolled shim (same approach as
// tool-cards.test.js / context-side-drawer.test.js — no jsdom).
//
// Static gates assert the index.html drawer scaffold + style.css geometry are
// present, since the browser wiring (open/close/setTab) resolves the drawer by
// id and toggles classes the CSS keys off.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const inspector = require('../src/renderer/inspector-drawer.js')

// --- pure: normalizeTab / kindForEvent ------------------------------------

test('normalizeTab: known tabs pass through; unknown falls back to pretty', () => {
  assert.equal(inspector.normalizeTab('pretty'), 'pretty')
  assert.equal(inspector.normalizeTab('raw'), 'raw')
  assert.equal(inspector.normalizeTab('json'), 'json')
  assert.equal(inspector.normalizeTab('feedback'), 'feedback')
  assert.equal(inspector.normalizeTab('bogus'), 'pretty')
  assert.equal(inspector.normalizeTab(undefined), 'pretty')
})

test('kindForEvent: maps each stream element type to its inspector kind', () => {
  assert.equal(inspector.kindForEvent({ type: 'user/message' }), 'user')
  assert.equal(inspector.kindForEvent({ type: 'assistant/message' }), 'assistant')
  assert.equal(inspector.kindForEvent({ type: 'reasoning' }), 'reasoning')
  assert.equal(inspector.kindForEvent({ type: 'tool/call' }), 'tool-call')
  assert.equal(inspector.kindForEvent({ type: 'tool/result' }), 'tool-result')
  assert.equal(inspector.kindForEvent({ type: 'context/message' }), 'context')
  assert.equal(inspector.kindForEvent({ type: 'steering/message' }), 'context')
  assert.equal(inspector.kindForEvent({ type: 'compact/summary' }), 'compact')
  assert.equal(inspector.kindForEvent({ type: 'subagent/started' }), 'subagent')
  assert.equal(inspector.kindForEvent({ type: 'subagent/finished' }), 'subagent')
  assert.equal(inspector.kindForEvent({ type: 'dev/heartbeat' }), 'event')
  assert.equal(inspector.kindForEvent({}), 'event')
})

// --- pure: projectPretty per event type -----------------------------------

test('projectPretty: user message projects text block + seq chip', () => {
  const p = inspector.projectPretty({ type: 'user/message', seq: 4, data: { text: 'hello there' } })
  assert.equal(p.kind, 'user')
  assert.equal(p.title, 'User message')
  assert.deepEqual(p.meta[0], { label: 'seq', value: '4' })
  const textBlock = p.blocks.find((b) => b.label === 'text')
  assert.ok(textBlock && textBlock.text === 'hello there')
})

test('projectPretty: user message folds content blocks when no raw text', () => {
  const p = inspector.projectPretty({
    type: 'user/message',
    data: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
  })
  assert.equal(p.blocks.find((b) => b.label === 'text').text, 'ab')
})

test('projectPretty: assistant message surfaces usage as meta chips', () => {
  const p = inspector.projectPretty({
    type: 'assistant/message',
    seq: 7,
    data: { text: 'answer', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
  })
  assert.equal(p.title, 'Assistant message')
  const labels = p.meta.map((m) => m.label)
  assert.ok(labels.includes('input') && labels.includes('output') && labels.includes('total'))
  assert.equal(p.meta.find((m) => m.label === 'output').value, '20')
})

test('projectPretty: usage dedupes across alias keys (input_tokens vs inputTokens)', () => {
  const p = inspector.projectPretty({
    type: 'assistant/message',
    data: { text: 'x', usage: { inputTokens: 5, input_tokens: 5 } },
  })
  const inputs = p.meta.filter((m) => m.label === 'input')
  assert.equal(inputs.length, 1, 'the input label appears once even when two alias keys are present')
})

test('projectPretty: reasoning projects the full thinking text', () => {
  const p = inspector.projectPretty({ type: 'reasoning', data: { text: 'step by step' } })
  assert.equal(p.title, 'Reasoning')
  assert.equal(p.blocks[0].label, 'thinking')
  assert.equal(p.blocks[0].text, 'step by step')
})

test('projectPretty: tool call shows name in title, args + result blocks (mono)', () => {
  const p = inspector.projectPretty({
    type: 'tool/call',
    data: {
      name: 'bash', callId: 'c1',
      arguments: { cmd: 'ls' },
      result: { content: 'file.txt', isError: false, durationMs: 12 },
    },
  })
  assert.equal(p.title, 'Tool call · bash')
  assert.ok(p.meta.some((m) => m.label === 'callId' && m.value === 'c1'))
  assert.ok(p.meta.some((m) => m.label === 'isError' && m.value === 'false'))
  assert.ok(p.meta.some((m) => m.label === 'durationMs' && m.value === '12'))
  const args = p.blocks.find((b) => b.label === 'arguments')
  assert.ok(args.mono && /"cmd": "ls"/.test(args.text))
  const res = p.blocks.find((b) => b.label === 'result')
  assert.ok(res.mono && res.text === 'file.txt')
})

test('projectPretty: tool call with no result yet marks result pending', () => {
  const p = inspector.projectPretty({ type: 'tool/call', data: { name: 'read', arguments: {} } })
  assert.equal(p.blocks.find((b) => b.label === 'result').text, '(result pending)')
})

test('projectPretty: tool result projects content + isError', () => {
  const p = inspector.projectPretty({
    type: 'tool/result',
    data: { callId: 'c2', isError: true, content: 'boom' },
  })
  assert.equal(p.title, 'Tool result')
  assert.ok(p.meta.some((m) => m.label === 'isError' && m.value === 'true'))
  assert.equal(p.blocks.find((b) => b.label === 'content').text, 'boom')
})

test('projectPretty: context injection shows source + payload', () => {
  const p = inspector.projectPretty({
    type: 'context/message',
    data: { source: { kind: 'plugin', plugin: 'skill' }, content: [{ type: 'text', text: 'loaded' }] },
  })
  assert.equal(p.title, 'Context injection')
  assert.equal(p.meta.find((m) => m.label === 'source').value, 'plugin:skill')
  assert.equal(p.blocks.find((b) => b.label === 'payload').text, 'loaded')
})

test('projectPretty: steering message titled distinctly from context', () => {
  const p = inspector.projectPretty({ type: 'steering/message', data: { content: [{ type: 'text', text: 'go left' }] } })
  assert.equal(p.title, 'Steering message')
})

test('projectPretty: compact projects the summary text + phase', () => {
  const p = inspector.projectPretty({ type: 'compact/summary', data: { summary: 'kept the gist' } })
  assert.equal(p.title, 'Compaction')
  assert.equal(p.meta.find((m) => m.label === 'phase').value, 'summary')
  assert.equal(p.blocks.find((b) => b.label === 'summary').text, 'kept the gist')
})

test('projectPretty: subagent projects status/stopReason + last assistant message', () => {
  const p = inspector.projectPretty({
    type: 'subagent/finished',
    data: {
      agentId: 'a1', status: 'ok', stopReason: 'end_turn',
      lastAssistantMessage: [{ type: 'text', text: 'done' }],
    },
  })
  assert.equal(p.title, 'Subagent')
  assert.ok(p.meta.some((m) => m.label === 'status' && m.value === 'ok'))
  assert.ok(p.meta.some((m) => m.label === 'stopReason' && m.value === 'end_turn'))
  assert.equal(p.blocks.find((b) => b.label === 'result').text, 'done')
})

// --- pure: formatRaw -------------------------------------------------------

test('formatRaw: verbatim event → header (seq/type/time) + pretty JSON, not reconstructed', () => {
  const raw = inspector.formatRaw({ type: 'user/message', seq: 3, time: 1234, data: { text: 'hi' } })
  assert.equal(raw.header.seq, 3)
  assert.equal(raw.header.type, 'user/message')
  assert.equal(raw.header.time, 1234)
  assert.equal(raw.reconstructed, false)
  assert.equal(raw.note, '')
  assert.ok(/"text": "hi"/.test(raw.json))
})

test('formatRaw: reconstructed record is flagged + noted, and the marker is stripped from JSON', () => {
  const raw = inspector.formatRaw({
    type: 'tool/call', data: { name: 'bash' }, __reconstructed: true,
  })
  assert.equal(raw.reconstructed, true)
  assert.match(raw.note, /reconstructed/)
  assert.ok(!/__reconstructed/.test(raw.json), 'internal marker must not leak into the verbatim JSON')
})

test('formatRaw: missing seq/time degrade to null header fields', () => {
  const raw = inspector.formatRaw({ type: 'event', data: {} })
  assert.equal(raw.header.seq, null)
  assert.equal(raw.header.time, null)
  assert.equal(raw.header.type, 'event')
})

// --- DOM shim --------------------------------------------------------------

function makeShim() {
  function make(tagName) {
    const el = {
      tagName: String(tagName).toUpperCase(),
      children: [],
      attrs: {},
      style: {},
      dataset: {},
      hidden: false,
      _listeners: {},
      classList: {
        _s: new Set(),
        add(...names) { for (const n of names) this._s.add(n) },
        remove(...names) { for (const n of names) this._s.delete(n) },
        contains(n) { return this._s.has(n) },
        toggle(n, force) {
          const want = force === undefined ? !this._s.has(n) : !!force
          if (want) this._s.add(n); else this._s.delete(n)
          return want
        },
      },
      _text: '',
      get textContent() { return this._text },
      set textContent(v) { this._text = String(v); this.children = [] },
      set className(v) { this._className = String(v); this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)) },
      get className() { return this._className || '' },
      setAttribute(k, v) { this.attrs[k] = String(v) },
      getAttribute(k) { return this.attrs[k] },
      appendChild(c) { c.parentNode = this; this.children.push(c); return c },
      append(...cs) { for (const c of cs) { c.parentNode = this; this.children.push(c) } },
      addEventListener(k, fn) { (this._listeners[k] = this._listeners[k] || []).push(fn) },
      dispatch(k, ev) { for (const fn of (this._listeners[k] || [])) fn(ev || {}) },
      querySelector(sel) { return matchAll(this, sel)[0] || null },
      querySelectorAll(sel) { const out = matchAll(this, sel); out.forEach = Array.prototype.forEach.bind(out); return out },
    }
    el.ownerDocument = null
    return el
  }
  // Minimal selector matcher: '.class', '[data-panel="x"]', and
  // '.class[data-panel="x"]' combined.
  function matches(node, sel) {
    if (!node || !node.tagName) return false
    let rest = sel.trim()
    // class
    const classMatch = rest.match(/^\.([\w-]+)/)
    if (classMatch) {
      if (!node.classList.contains(classMatch[1])) return false
      rest = rest.slice(classMatch[0].length)
    }
    // attribute [data-x="y"]
    const attrMatch = rest.match(/^\[([\w-]+)="([^"]*)"\]/)
    if (attrMatch) {
      const key = attrMatch[1]
      const want = attrMatch[2]
      const got = key.startsWith('data-') ? node.dataset[dataKey(key)] : node.attrs[key]
      if (String(got) !== want) return false
      rest = rest.slice(attrMatch[0].length)
    }
    return rest.length === 0
  }
  function dataKey(attr) {
    return attr.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())
  }
  function matchAll(root, sel) {
    const out = []
    const stack = [...(root.children || [])]
    while (stack.length) {
      const n = stack.shift()
      if (matches(n, sel)) out.push(n)
      if (n && n.children) stack.push(...n.children)
    }
    return out
  }
  const doc = {
    createElement: (t) => { const e = make(t); e.ownerDocument = doc; return e },
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
  }
  return { doc, make }
}

// --- DOM: renderPretty -----------------------------------------------------

test('renderPretty: writes title, meta chips, and block bodies into the host', () => {
  const { doc } = makeShim()
  const host = doc.createElement('div')
  inspector.renderPretty(doc, host, {
    title: 'Assistant message',
    meta: [{ label: 'seq', value: '7' }, { label: 'output', value: '20' }],
    blocks: [{ label: 'text', text: 'the answer' }],
  })
  const title = host.children.find((c) => c.className.includes('inspector-pretty-title'))
  assert.equal(title.textContent, 'Assistant message')
  const metaWrap = host.children.find((c) => c.className.includes('inspector-pretty-meta'))
  assert.equal(metaWrap.children.length, 2)
  const block = host.children.find((c) => c.tagName === 'SECTION')
  assert.ok(block, 'a block section renders')
  const body = block.children.find((c) => c.className.includes('inspector-pretty-block-body'))
  assert.equal(body.textContent, 'the answer')
})

test('renderPretty: empty block text renders the "(empty)" placeholder', () => {
  const { doc } = makeShim()
  const host = doc.createElement('div')
  inspector.renderPretty(doc, host, { title: 't', meta: [], blocks: [{ label: 'text', text: '' }] })
  const body = host.querySelector('.inspector-pretty-block-body')
  assert.equal(body.textContent, '(empty)')
})

// --- DOM: renderRaw --------------------------------------------------------

test('renderRaw: header line joins seq/type/time; <pre> holds the JSON; copy button present', () => {
  const { doc } = makeShim()
  const host = doc.createElement('div')
  inspector.renderRaw(doc, host, inspector.formatRaw({ type: 'tool/call', seq: 9, time: 42, data: { name: 'bash' } }))
  const label = host.querySelector('.inspector-raw-head-label')
  assert.match(label.textContent, /seq 9/)
  assert.match(label.textContent, /tool\/call/)
  const pre = host.querySelector('.inspector-raw-pre')
  assert.match(pre.textContent, /"name": "bash"/)
  const copy = host.querySelector('.inspector-raw-copy')
  assert.equal(copy.textContent, 'copy')
})

test('renderRaw: reconstructed record renders the "not a verbatim wire event" note', () => {
  const { doc } = makeShim()
  const host = doc.createElement('div')
  inspector.renderRaw(doc, host, inspector.formatRaw({ type: 'reasoning', data: { text: 'x' }, __reconstructed: true }))
  const note = host.querySelector('.inspector-raw-note')
  assert.ok(note && /reconstructed/.test(note.textContent))
})

// --- DOM: renderJson (fields tree reuse) -----------------------------------

test('renderJson: falls back to a flat <pre> when the trace-detail fields tree is unavailable', () => {
  const { doc } = makeShim()
  const host = doc.createElement('div')
  // No window.__dshTraceDetailPane in node → fallback path.
  inspector.renderJson(doc, host, { type: 'user/message', data: { text: 'hi' }, __reconstructed: true })
  const pre = host.querySelector('.inspector-raw-pre')
  assert.ok(pre, 'fallback flat pre renders when buildJsonTree is absent')
  assert.ok(!/__reconstructed/.test(pre.textContent), 'internal marker stripped in the JSON tab too')
})

// --- Static gates: index.html + style.css ---------------------------------

test('index.html: #inspector-drawer aside with three tabs + panels exists', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8')
  assert.match(html, /id="inspector-drawer"/, 'the one drawer must exist so open()/close() can resolve it by id')
  assert.match(html, /data-tab="pretty"/, 'Pretty tab button')
  assert.match(html, /data-tab="raw"/, 'Raw tab button')
  assert.match(html, /data-tab="json"/, 'JSON tab button')
  assert.match(html, /data-tab="feedback"/, 'Feedback tab button')
  assert.match(html, /data-panel="pretty"/, 'Pretty panel')
  assert.match(html, /data-panel="raw"/, 'Raw panel')
  assert.match(html, /data-panel="json"/, 'JSON panel')
  assert.match(html, /data-panel="feedback"/, 'Feedback panel')
  assert.match(html, /id="inspector-drawer-close"/, 'close button target for the × / Escape bindings')
})

test('index.html: #stream-scroll-chip exists, hidden by default', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8')
  assert.match(html, /id="stream-scroll-chip"[^>]*hidden/, 'the "back to bottom" chip starts hidden')
})

test('index.html: inspector-drawer.js is loaded AFTER trace-detail-pane.js (reuses its buildJsonTree)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8')
  const traceIdx = html.indexOf('trace-detail-pane.js')
  const insIdx = html.indexOf('inspector-drawer.js')
  assert.ok(traceIdx >= 0 && insIdx >= 0 && traceIdx < insIdx,
    'inspector must load after trace-detail-pane so window.__dshTraceDetailPane.buildJsonTree is ready')
})

test('style.css: .inspector-drawer anchors right + slides via .open', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'style.css'), 'utf8')
  const m = css.match(/\.inspector-drawer\s*\{[\s\S]+?\}/)
  assert.ok(m, '.inspector-drawer rule missing')
  assert.match(m[0], /right:\s*0/, 'drawer must anchor to the right edge')
  assert.match(css, /\.inspector-drawer\.open\s*\{[^}]*translateX\(0\)/,
    '.open must slide the drawer into view — open() adds this class')
  assert.match(css, /\.stream-scroll-chip\[hidden\]\s*\{\s*display:\s*none/,
    'the chip [hidden] attribute must collapse it')
})

// --- Drawer wiring: open() event anchoring + setTab() switching -----------
//
// open() / setTab() / renderActivePanel() guard on `typeof document`; we mint a
// global window+document with the same drawer scaffold index.html carries, load
// a FRESH copy of the module so its `isBrowser` closure sees them, then drive
// the state machine. This is the "event anchoring + tab switching" contract.

function buildDrawerDom(doc) {
  const drawer = doc.createElement('aside')
  drawer.id = 'inspector-drawer'
  drawer.setAttribute('aria-hidden', 'true')
  const title = doc.createElement('div'); title.className = 'inspector-drawer-title'; title.textContent = 'inspector'
  drawer.appendChild(title)
  for (const t of ['pretty', 'raw', 'json', 'feedback']) {
    const tab = doc.createElement('button')
    tab.className = 'inspector-tab' + (t === 'pretty' ? ' active' : '')
    tab.dataset.tab = t
    tab.setAttribute('aria-selected', t === 'pretty' ? 'true' : 'false')
    drawer.appendChild(tab)
  }
  for (const p of ['pretty', 'raw', 'json', 'feedback']) {
    const panel = doc.createElement('div')
    panel.className = 'inspector-panel'
    panel.dataset.panel = p
    panel.hidden = p !== 'pretty'
    drawer.appendChild(panel)
  }
  return drawer
}

function loadInspectorWithDom() {
  const { doc } = makeShim()
  const drawer = buildDrawerDom(doc)
  const byId = { 'inspector-drawer': drawer }
  doc.getElementById = (id) => byId[id] || null
  doc.readyState = 'complete'
  doc.addEventListener = () => {}
  doc.removeEventListener = () => {}
  const win = { document: doc }
  global.window = win
  global.document = doc
  const p = require.resolve('../src/renderer/inspector-drawer.js')
  delete require.cache[p]
  const ins = require('../src/renderer/inspector-drawer.js')
  return { ins, doc, drawer, byId }
}

function cleanupDom() {
  delete global.window
  delete global.document
  const p = require.resolve('../src/renderer/inspector-drawer.js')
  delete require.cache[p]
}

test('open(): anchors to the event, opens the drawer, renders the initial tab', () => {
  const { ins, drawer } = loadInspectorWithDom()
  try {
    const ret = ins.open({ event: { type: 'user/message', seq: 2, data: { text: 'hi' } }, tab: 'pretty' })
    assert.ok(ret, 'open returns the drawer node')
    assert.equal(drawer.classList.contains('open'), true)
    assert.equal(drawer.getAttribute('aria-hidden'), 'false')
    const prettyPanel = drawer.querySelector('.inspector-panel[data-panel="pretty"]')
    assert.equal(prettyPanel.hidden, false)
    assert.ok(prettyPanel.children.length > 0, 'pretty panel got populated from the anchored event')
    const title = drawer.querySelector('.inspector-drawer-title')
    assert.equal(title.textContent, 'User message')
  } finally { cleanupDom() }
})

test('open(): missing event is a no-op (returns null, drawer stays closed)', () => {
  const { ins, drawer } = loadInspectorWithDom()
  try {
    assert.equal(ins.open({}), null)
    assert.equal(drawer.classList.contains('open'), false)
  } finally { cleanupDom() }
})

test('setTab(): switches active tab, toggles panel visibility + aria-selected', () => {
  const { ins, drawer } = loadInspectorWithDom()
  try {
    ins.open({ event: { type: 'tool/call', data: { name: 'bash', arguments: { cmd: 'ls' } } }, tab: 'pretty' })
    assert.equal(ins.setTab('raw'), 'raw')
    const rawPanel = drawer.querySelector('.inspector-panel[data-panel="raw"]')
    const prettyPanel = drawer.querySelector('.inspector-panel[data-panel="pretty"]')
    assert.equal(rawPanel.hidden, false, 'raw panel shows')
    assert.equal(prettyPanel.hidden, true, 'pretty panel hides')
    const rawTab = drawer.querySelector('.inspector-tab[data-tab="raw"]')
    assert.equal(rawTab.getAttribute('aria-selected'), 'true')
    assert.equal(rawTab.classList.contains('active'), true)
    assert.ok(rawPanel.querySelector('.inspector-raw-pre'), 'raw tab rendered its <pre>')
  } finally { cleanupDom() }
})

test('setTab(): unknown tab name falls back to pretty', () => {
  const { ins } = loadInspectorWithDom()
  try {
    ins.open({ event: { type: 'user/message', data: { text: 'x' } } })
    assert.equal(ins.setTab('nope'), 'pretty')
  } finally { cleanupDom() }
})

test('openFromDrawer(): call+result path reconstructs a combined tool/call record on the JSON tab', () => {
  const { ins, drawer } = loadInspectorWithDom()
  try {
    ins.openFromDrawer({
      title: 'tool: bash',
      call: { callId: 'c9', name: 'bash', arguments: { cmd: 'ls' } },
      result: { content: 'ok', isError: false },
    })
    assert.equal(drawer.classList.contains('open'), true)
    // default tab for the drawer adapter is json
    const jsonTab = drawer.querySelector('.inspector-tab[data-tab="json"]')
    assert.equal(jsonTab.getAttribute('aria-selected'), 'true')
    // switch to Raw and confirm the reconstructed note shows (combined record)
    ins.setTab('raw')
    const note = drawer.querySelector('.inspector-raw-note')
    assert.ok(note && /reconstructed/.test(note.textContent),
      'a combined call+result is labelled reconstructed, never sold as a verbatim wire event')
  } finally { cleanupDom() }
})

test('openFromDrawer(): bare event path routes verbatim to the Raw tab', () => {
  const { ins, drawer } = loadInspectorWithDom()
  try {
    ins.openFromDrawer({ title: 'user/message', event: { type: 'user/message', seq: 5, data: { text: 'hi' } }, tab: 'raw' })
    const rawPanel = drawer.querySelector('.inspector-panel[data-panel="raw"]')
    assert.equal(rawPanel.hidden, false)
    assert.ok(!rawPanel.querySelector('.inspector-raw-note'), 'a verbatim event carries no reconstructed note')
  } finally { cleanupDom() }
})

test('close(): removes the open class + marks aria-hidden', () => {
  const { ins, drawer } = loadInspectorWithDom()
  try {
    ins.open({ event: { type: 'user/message', data: { text: 'x' } } })
    ins.close()
    assert.equal(drawer.classList.contains('open'), false)
    assert.equal(drawer.getAttribute('aria-hidden'), 'true')
  } finally { cleanupDom() }
})

// --- Feedback tab (lane-wf-feedback) --------------------------------------

test('renderFeedback: builds verdict thumbs, rubric select, note, and Save; injected dims populate the select', () => {
  const { doc } = makeShim()
  const host = doc.createElement('div')
  inspector.renderFeedback(doc, host, {
    event: { type: 'assistant/message', seq: 7 },
    sessionId: 'sess-1',
    dimensions: [{ id: 'convergence', label: 'Convergence' }, { id: 'no-regression', label: 'No regression' }],
    existing: null,
    onSave: () => {},
  })
  assert.ok(host.querySelector('.inspector-feedback'), 'feedback form root renders')
  assert.ok(host.querySelector('[aria-label="Thumbs up"]'), 'thumbs-up button')
  assert.ok(host.querySelector('[aria-label="Thumbs down"]'), 'thumbs-down button')
  const select = host.querySelector('.inspector-feedback-dim-select')
  assert.ok(select, 'rubric dimension select renders')
  // (none) + 2 injected dims = 3 options
  assert.equal(select.children.length, 3)
  assert.ok(host.querySelector('.inspector-feedback-note-input'), 'note textarea')
  assert.ok(host.querySelector('.inspector-feedback-save'), 'Save button')
})

test('renderFeedback: an existing annotation prefills verdict, note, and rubric dim', () => {
  const { doc } = makeShim()
  const host = doc.createElement('div')
  inspector.renderFeedback(doc, host, {
    event: { type: 'assistant/message', seq: 7 },
    sessionId: 'sess-1',
    dimensions: [{ id: 'convergence', label: 'Convergence' }],
    existing: { sessionId: 'sess-1', seq: 7, verdict: 'up', note: 'good turn', rubricDim: 'convergence' },
    onSave: () => {},
  })
  const up = host.querySelector('[aria-label="Thumbs up"]')
  assert.equal(up.classList.contains('active'), true, 'thumbs-up reflects the stored verdict')
  const note = host.querySelector('.inspector-feedback-note-input')
  assert.equal(note.value, 'good turn')
  const select = host.querySelector('.inspector-feedback-dim-select')
  assert.equal(select.value, 'convergence')
})

test('renderFeedback: Save collects the form and hands it to onSave', () => {
  const { doc } = makeShim()
  const host = doc.createElement('div')
  let captured = null
  inspector.renderFeedback(doc, host, {
    event: { type: 'assistant/message', seq: 12 },
    sessionId: 'sess-9',
    dimensions: [{ id: 'convergence', label: 'Convergence' }],
    existing: null,
    onSave: (form) => { captured = form; return { ok: true } },
  })
  // Toggle thumbs-up, type a note, pick a dim, then Save.
  host.querySelector('[aria-label="Thumbs up"]').dispatch('click')
  host.querySelector('.inspector-feedback-note-input').value = 'needs work'
  host.querySelector('.inspector-feedback-dim-select').value = 'convergence'
  host.querySelector('.inspector-feedback-save').dispatch('click')
  assert.ok(captured, 'onSave fired')
  assert.equal(captured.sessionId, 'sess-9')
  assert.equal(captured.seq, 12)
  assert.equal(captured.verdict, 'up')
  assert.equal(captured.note, 'needs work')
  assert.equal(captured.rubricDim, 'convergence')
})

test('renderFeedback: a second click on the active verdict clears it (toggle to null)', () => {
  const { doc } = makeShim()
  const host = doc.createElement('div')
  let captured = null
  inspector.renderFeedback(doc, host, {
    event: { type: 'assistant/message', seq: 3 },
    sessionId: 's',
    dimensions: [],
    existing: { sessionId: 's', seq: 3, verdict: 'down', note: '' },
    onSave: (form) => { captured = form },
  })
  const down = host.querySelector('[aria-label="Thumbs down"]')
  assert.equal(down.classList.contains('active'), true)
  down.dispatch('click') // toggle off
  assert.equal(down.classList.contains('active'), false)
  host.querySelector('.inspector-feedback-save').dispatch('click')
  assert.equal(captured.verdict, null)
})

test('open(): Feedback tab renders the annotation form anchored to the event', () => {
  const { ins, drawer } = loadInspectorWithDom()
  try {
    ins.open({ event: { type: 'assistant/message', seq: 7, data: { content: [] } }, tab: 'feedback', sessionId: 'sess-x' })
    const panel = drawer.querySelector('.inspector-panel[data-panel="feedback"]')
    assert.equal(panel.hidden, false, 'feedback panel shows')
    assert.ok(panel.querySelector('.inspector-feedback'), 'feedback form mounted')
    const feedbackTab = drawer.querySelector('.inspector-tab[data-tab="feedback"]')
    assert.equal(feedbackTab.getAttribute('aria-selected'), 'true')
  } finally { cleanupDom() }
})

test('attachInspectBadge: stamps (sessionId, seq) on the badge for marker refresh', () => {
  const { ins, doc } = loadInspectorWithDom()
  try {
    const host = doc.createElement('div')
    const badge = ins.attachInspectBadge(host, () => ({
      event: { type: 'assistant/message', seq: 42 }, tab: 'pretty', sessionId: 'sess-7',
    }))
    assert.ok(badge, 'badge created')
    assert.equal(badge.getAttribute('data-annot-session'), 'sess-7')
    assert.equal(badge.getAttribute('data-annot-seq'), '42')
  } finally { cleanupDom() }
})

