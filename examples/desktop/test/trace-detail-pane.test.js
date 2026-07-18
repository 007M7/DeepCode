// Task #205 — trace detail pane (four tabs).
// Verifies pure builders (attributesRows/outputRows/inputRows/feedbackRows)
// and the DOM composition of buildDetailPane. Uses a minimal doc stub —
// no full renderer harness needed since the module is pure DOM + wire data.

'use strict'

const test = require('node:test')
const assert = require('node:assert')
const dp = require('../src/renderer/trace-detail-pane.js')

// ---------- fake doc -----------------------------------------------------

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
      firstChild: null,
      _text: '',
    }
    Object.defineProperty(el, 'className', {
      get() { return Array.from(this._classSet).join(' ') },
      set(v) {
        this._classSet = new Set(String(v || '').split(/\s+/).filter(Boolean))
      },
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
      toggle: (c, on) => { if (on === undefined) on = !el._classSet.has(c); on ? el._classSet.add(c) : el._classSet.delete(c) },
    }
    el.setAttribute = (k, v) => { el._attrs[k] = String(v) }
    el.getAttribute = (k) => (k in el._attrs ? el._attrs[k] : null)
    el.appendChild = (child) => {
      el.children.push(child)
      el.firstChild = el.children[0] || null
      child.parentNode = el
      return child
    }
    el.removeChild = (child) => {
      const i = el.children.indexOf(child); if (i >= 0) el.children.splice(i, 1)
      el.firstChild = el.children[0] || null
    }
    el.addEventListener = (evt, fn) => { (el._listeners[evt] = el._listeners[evt] || []).push(fn) }
    el.querySelector = (sel) => queryOne(el, sel)
    el.querySelectorAll = (sel) => queryAll(el, sel)
    return el
  }
  return { createElement: (t) => makeEl(t) }
}
function walk(el, cb) {
  cb(el)
  for (const c of (el.children || [])) walk(c, cb)
}
function queryAll(root, sel) {
  const out = []
  const cls = sel.startsWith('.') ? sel.slice(1) : null
  walk(root, (el) => {
    if (!el || !el._classSet) return
    if (cls && el._classSet.has(cls)) out.push(el)
  })
  return out
}
function queryOne(root, sel) { const all = queryAll(root, sel); return all[0] || null }

// ---------- fixtures -----------------------------------------------------

function makeRec() {
  return {
    turn: 1, step: 2,
    startSeq: 10, endSeq: 15,
    startTime: 1000, endTime: 1500, durationMs: 500,
    summary: 'read types.ts',
    header: { model: 'deepseek-v4', provider: 'deepseek' },
    inputs: [
      { seq: 8, time: 999, type: 'user/message', data: { text: 'hello' } },
    ],
    outputs: [
      { seq: 11, time: 1100, type: 'assistant/message', data: {
        content: [
          { type: 'text', text: 'reading now' },
          { type: 'tool_use', id: 't1', name: 'read', input: { path: 'x.ts' } },
        ],
      } },
      { seq: 12, time: 1150, type: 'tool/call', data: {
        callId: 't1', tool: 'read', arguments: { path: 'x.ts' },
      } },
    ],
    events: [
      { seq: 10, time: 1000, type: 'step/start', data: {} },
      { seq: 11, time: 1100, type: 'assistant/message', data: {
        usage: { inputTokens: 50, outputTokens: 12, cacheReadTokens: 8 },
        finish_reason: 'stop',
      } },
    ],
  }
}

// ---------- pure builders ------------------------------------------------

test('attributesRows lists all wire fields including absent markers', () => {
  const rec = makeRec()
  const rows = dp.attributesRows(rec)
  const keys = rows.map(([k]) => k)
  assert.deepStrictEqual(keys, [
    'model', 'provider',
    'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens',
    'durationMs', 'finish_reason', 'tags',
    'cwd',         // Field §3 P0 #5 (2026-07-17): session-level cwd row.
    'mcp.server',  // Task #49 (2026-07-17): MCP source attribution row.
  ])
  const modelVal = rows.find(([k]) => k === 'model')[1]
  assert.strictEqual(modelVal, 'deepseek-v4')
  const tagsVal = rows.find(([k]) => k === 'tags')[1]
  assert.deepStrictEqual(tagsVal, { absent: true })
  const cacheWriteVal = rows.find(([k]) => k === 'cacheWriteTokens')[1]
  assert.deepStrictEqual(cacheWriteVal, { absent: true },
    'omitted numeric wire fields must surface as absent, not silently 0')
  // Field §3 P0 #5: cwd is absent without a sessionHeader argument.
  const cwdVal = rows.find(([k]) => k === 'cwd')[1]
  assert.deepStrictEqual(cwdVal, { absent: true })
})

test('outputRows extracts assistant message + tool_calls + separate tool/call', () => {
  const rec = makeRec()
  const rows = dp.outputRows(rec)
  assert.strictEqual(rows.length, 2)
  assert.strictEqual(rows[0].kind, 'message')
  assert.strictEqual(rows[0].text, 'reading now')
  assert.strictEqual(rows[0].toolCalls.length, 1)
  assert.strictEqual(rows[0].toolCalls[0].name, 'read')
  assert.strictEqual(rows[1].kind, 'tool-call')
  assert.strictEqual(rows[1].name, 'read')
  assert.strictEqual(rows[1].callId, 't1')
})

test('inputRows returns messagePrefix + header config', () => {
  const rec = makeRec()
  const { messages, config } = dp.inputRows(rec)
  assert.strictEqual(messages.length, 1)
  assert.strictEqual(messages[0].type, 'user/message')
  assert.ok(Array.isArray(config), 'config should always be an array (empty when no aggregator)')
})

test('feedbackRows returns available:false when no annotation module', () => {
  const fb = dp.feedbackRows('s1', null)
  assert.deepStrictEqual(fb, { available: false, rows: [] })
})

test('feedbackRows returns rows shaped from turnScores + overall', () => {
  const stubApi = {
    read(sid) {
      if (sid !== 'sX') return null
      return {
        overall: 'good',
        notes: 'nice work',
        annotator: 'ziya',
        updatedAt: 1700000000000,
        turnScores: [
          { turn: 0, dims: { 'feedback-understanding': 4, 'fix-effectiveness': 5 }, note: 'ok', annotator: 'ziya', updatedAt: 1700000001000 },
        ],
      }
    },
  }
  const fb = dp.feedbackRows('sX', stubApi)
  assert.strictEqual(fb.available, true)
  assert.strictEqual(fb.rows.length, 2)
  const turnRow = fb.rows.find((r) => r.scope === 'turn')
  const sessRow = fb.rows.find((r) => r.scope === 'session')
  assert.ok(turnRow && sessRow, 'expected both turn and session rows')
  assert.strictEqual(turnRow.dims['feedback-understanding'], 4)
  assert.strictEqual(sessRow.overall, 'good')
})

// ---------- DOM composition ---------------------------------------------

test('buildDetailPane emits four tabs in Feedback/Input/Output/Attributes order', () => {
  const doc = makeDoc()
  const rec = makeRec()
  const pane = dp.buildDetailPane(doc, { record: rec, sessionId: 's1', title: 'step 1.2', defaultTab: 'output' })
  const tabs = queryAll(pane, '.trace-detail-tab')
  assert.strictEqual(tabs.length, 4)
  assert.deepStrictEqual(
    tabs.map((t) => t.textContent),
    ['Feedback', 'Input', 'Output', 'Attributes'])
})

test('Output tab is default-built and lists messages + tool_calls', () => {
  const doc = makeDoc()
  const rec = makeRec()
  const pane = dp.buildDetailPane(doc, { record: rec, sessionId: 's1', defaultTab: 'output' })
  const outputPanel = queryOne(pane, '.panel-output')
  assert.ok(outputPanel, 'panel-output exists')
  assert.strictEqual(outputPanel.hidden, false, 'output panel is default active')
  const rows = queryAll(outputPanel, '.trace-detail-output-row')
  assert.strictEqual(rows.length, 2)
  const toolCalls = queryAll(outputPanel, '.trace-detail-tool-call')
  assert.ok(toolCalls.length >= 2, `expected 2+ tool_call kv blocks, got ${toolCalls.length}`)
})

test('Attributes tab renders absent markers on missing fields', () => {
  const doc = makeDoc()
  const rec = makeRec()
  const pane = dp.buildDetailPane(doc, { record: rec, sessionId: 's1', defaultTab: 'attributes' })
  const attrPanel = queryOne(pane, '.panel-attributes')
  assert.ok(attrPanel && !attrPanel.hidden)
  const values = queryAll(attrPanel, '.trace-detail-kv-value')
  let sawAbsent = false
  for (const v of values) if (v._classSet.has('absent')) { sawAbsent = true; break }
  assert.ok(sawAbsent, 'at least one attribute renders as absent (cacheWriteTokens/tags)')
})

test('Attributes tab: three independently-foldable groups (Model / Usage / Runtime)', () => {
  // Team-lead round-7 addendum (2026-07-17): each of the three groups is
  // an independently collapsible <details> section, not one flat table.
  const doc = makeDoc()
  const rec = makeRec()
  const pane = dp.buildDetailPane(doc, { record: rec, sessionId: 's1', defaultTab: 'attributes' })
  const attrPanel = queryOne(pane, '.panel-attributes')
  const groups = queryAll(attrPanel, '.trace-detail-attr-group')
  assert.strictEqual(groups.length, 3, 'three attribute groups')
  const keys = groups.map(g => (Array.from(g._classSet).find(c => c.startsWith('group-')) || '').slice(6))
  assert.deepStrictEqual(keys, ['model', 'usage', 'runtime'])
  // Each group is a native <details> so it collapses independently. The
  // fake doc creates them with tag `details` and `open=true` default.
  for (const g of groups) {
    assert.strictEqual(g.tagName, 'DETAILS',
      'group renders as <details> so it folds independently')
    assert.strictEqual(g.open, true, 'group starts open by default')
  }
})

test('Feedback tab shows empty-state + Add feedback button when no annotation', () => {
  // 2026-07-17 addendum: empty state is now a dashed `+ Add feedback`
  // inline button (was "Rate this trajectory"). Selector stays
  // `.trace-detail-annotate` so downstream CSS + selfies keep working.
  const doc = makeDoc()
  const rec = makeRec()
  const prev = global.window
  const prevDoc = global.document
  global.window = Object.assign({}, prev, {
    __dshAnnotation: { read() { return null } },
    addEventListener() {},
  })
  global.document = Object.assign({}, prevDoc || {}, {
    addEventListener() {},
  })
  try {
    const pane = dp.buildDetailPane(doc, { record: rec, sessionId: 'sZ', defaultTab: 'feedback' })
    const fbPanel = queryOne(pane, '.panel-feedback')
    assert.ok(fbPanel)
    const btn = queryOne(fbPanel, '.trace-detail-annotate')
    assert.ok(btn, 'expected `+ Add feedback` button in empty state')
    assert.strictEqual(btn.textContent, '+ Add feedback')
    // The button must also carry the `trace-detail-add-feedback` class
    // so the dashed-outline CSS applies (2026-07-17 spec).
    assert.ok(btn._classSet.has('trace-detail-add-feedback'),
      'empty-state button carries .trace-detail-add-feedback')
  } finally { global.window = prev; global.document = prevDoc }
})

test('Add feedback opens an inline popover (round-7 §15 team-lead 2026-07-17)', () => {
  // Clicking `+ Add feedback` opens a compact popover inline (≤5 fields:
  // verdict, scope, dim, comment, submit + full-annotation link) rather
  // than jumping to the full drawer.  The popover mounts as a sibling of
  // the button (below it, no floating overlay).  Submit calls
  // window.__dshAnnotation.submit(sessionId, patch); the full-drawer
  // fallback link calls window.__dshAnnotation.open(sessionId).
  const doc = makeDoc()
  const rec = makeRec()
  const prev = global.window
  const prevDoc = global.document
  let submitArgs = null
  let openCalled = null
  global.window = Object.assign({}, prev, {
    __dshAnnotation: {
      read() { return null },
      submit(sid, patch) { submitArgs = { sid, patch }; return { sessionId: sid } },
      open(sid) { openCalled = sid },
    },
    __dshRubricsModel: {
      MULTI_TURN_DIMENSIONS: [{ id: 'convergence', label: 'Convergence', hint: '' }],
    },
    addEventListener() {},
  })
  global.document = Object.assign({}, prevDoc || {}, { addEventListener() {} })
  try {
    const pane = dp.buildDetailPane(doc, { record: rec, sessionId: 'sZ', defaultTab: 'feedback' })
    const fbPanel = queryOne(pane, '.panel-feedback')
    const btn = queryOne(fbPanel, '.trace-detail-add-feedback')
    assert.ok(btn, 'button present')
    // Simulate click.
    const clickListeners = (btn._listeners && btn._listeners.click) || []
    assert.ok(clickListeners.length > 0, 'button has click listener')
    clickListeners[0]({ type: 'click' })
    // Popover mounts.
    const pop = queryOne(fbPanel, '.trace-detail-feedback-popover')
    assert.ok(pop, 'popover mounts on click')
    assert.strictEqual(pop._attrs.role, 'dialog')
    // ≤5 rows (verdict, scope?, dim?, note, actions).  Structure test:
    // at least the required rows are present.
    assert.ok(queryOne(pop, '.row-verdict'), 'verdict row present')
    assert.ok(queryOne(pop, '.row-note'), 'note row present')
    assert.ok(queryOne(pop, '.trace-detail-feedback-popover-submit'), 'submit present')
    assert.ok(queryOne(pop, '.trace-detail-feedback-popover-full'), 'full-annotation link present')
    // Click the "good" verdict, then Submit.
    const good = queryAll(pop, '.trace-detail-feedback-popover-verdict')
      .find(b => b._classSet.has('verdict-good'))
    assert.ok(good, 'good verdict button found')
    ;(good._listeners.click || [])[0]({ type: 'click' })
    const submit = queryOne(pop, '.trace-detail-feedback-popover-submit')
    ;(submit._listeners.click || [])[0]({ type: 'click' })
    assert.ok(submitArgs, 'submit invoked api.submit')
    assert.strictEqual(submitArgs.sid, 'sZ')
    assert.strictEqual(submitArgs.patch.overall, 'good')
    // Reopen and try "full annotation →".
    ;(btn._listeners.click || [])[0]({ type: 'click' })
    const pop2 = queryOne(fbPanel, '.trace-detail-feedback-popover')
    const full = queryOne(pop2, '.trace-detail-feedback-popover-full')
    ;(full._listeners.click || [])[0]({ type: 'click' })
    assert.strictEqual(openCalled, 'sZ', 'full-annotation link routes to api.open')
  } finally { global.window = prev; global.document = prevDoc }
})

test('detail pane subscribes to dsh:annotation-updated on document (contract)', () => {
  // team-lead 2026-07-17: annotation events fire on `document`, not `window`.
  // Guard the contract so a regression back to window is caught by the suite.
  const doc = makeDoc()
  const rec = makeRec()
  const prevWin = global.window
  const prevDoc = global.document
  const winCalls = []
  const docCalls = []
  global.window = Object.assign({}, prevWin, {
    __dshAnnotation: { read() { return null } },
    addEventListener(name /* , fn */) { winCalls.push(name) },
  })
  global.document = Object.assign({}, prevDoc || {}, {
    addEventListener(name /* , fn */) { docCalls.push(name) },
  })
  try {
    const pane = dp.buildDetailPane(doc, { record: rec, sessionId: 'sZ' })
    assert.ok(pane, 'pane built')
    assert.ok(docCalls.includes('dsh:annotation-updated'), 'subscribed on document')
    assert.ok(!winCalls.includes('dsh:annotation-updated'), 'NOT subscribed on window')
  } finally { global.window = prevWin; global.document = prevDoc }
})

test('Input tab lists messagePrefix events', () => {
  const doc = makeDoc()
  const rec = makeRec()
  const pane = dp.buildDetailPane(doc, { record: rec, sessionId: 's1', defaultTab: 'input' })
  const inputPanel = queryOne(pane, '.panel-input')
  assert.ok(inputPanel)
  const rows = queryAll(inputPanel, '.trace-detail-message-row')
  assert.strictEqual(rows.length, 1)
})

// ─── 2026-07-17 addendum: reference tracing UI detail-pane细节全抄批 ──────────────

test('pane composes header ID chip + Messages/Details switch', () => {
  const doc = makeDoc()
  const rec = makeRec()
  const pane = dp.buildDetailPane(doc, { record: rec, sessionId: 'sess-abc', title: 'step 1.2' })
  const chip = queryOne(pane, '.trace-detail-id-chip')
  assert.ok(chip, 'ID chip must render in header')
  const idVal = queryOne(chip, '.trace-detail-id-value')
  assert.ok(idVal && idVal.textContent.length > 0, 'ID value has content')
  const modeSwitch = queryOne(pane, '.trace-detail-mode-switch')
  assert.ok(modeSwitch, 'Messages/Details switch must render')
  const segs = queryAll(modeSwitch, '.trace-detail-mode-seg')
  assert.strictEqual(segs.length, 2, 'two segments — Messages | Details')
  assert.strictEqual(segs[0].textContent, 'Messages')
  assert.strictEqual(segs[1].textContent, 'Details')
})

test('sections are collapsible <details> — scroll-anchor grammar, not exclusive tabs', () => {
  const doc = makeDoc()
  const rec = makeRec()
  const pane = dp.buildDetailPane(doc, { record: rec, sessionId: 's1', defaultTab: 'output' })
  const sections = queryAll(pane, '.trace-detail-section')
  assert.strictEqual(sections.length, 4, 'four sections in the scroll document')
  for (const s of sections) {
    assert.strictEqual(s.tagName, 'DETAILS', 'each section is a <details>')
    assert.strictEqual(s.open, true, 'each section opens by default')
  }
})

test('Attributes group into Model / Usage / Runtime collapsibles', () => {
  const doc = makeDoc()
  const rec = makeRec()
  const pane = dp.buildDetailPane(doc, { record: rec, sessionId: 's1', defaultTab: 'attributes' })
  const groups = queryAll(pane, '.trace-detail-attr-group')
  assert.strictEqual(groups.length, 3, 'exactly three attribute groups')
  const labels = queryAll(pane, '.trace-detail-attr-group-label').map(l => l.textContent)
  assert.deepStrictEqual(labels, ['Model', 'Usage', 'Runtime'])
})

test('attributesGroups pure builder splits rows into the three buckets', () => {
  const rec = makeRec()
  const groups = dp.attributesGroups(rec)
  assert.strictEqual(groups.length, 3)
  const keysByGroup = Object.fromEntries(groups.map(g => [g.key, g.rows.map(([k]) => k)]))
  assert.deepStrictEqual(keysByGroup.model, ['model', 'provider'])
  assert.deepStrictEqual(keysByGroup.usage, ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'finish_reason'])
  // Field §3 P0 #5 (2026-07-17): Runtime group leads with cwd (SessionHeader),
  // then mcp.server (task #49 — MCP source attribution), durationMs
  // (per-step), tags (per-request). mcp.server row is present in the shape
  // (absent-marker) even when no MCP tools were called, matching the other
  // rows' "always emit an absent marker" contract.
  assert.deepStrictEqual(keysByGroup.runtime, ['cwd', 'mcp.server', 'durationMs', 'tags'])
})

test('attributesGroups surfaces mcp.server row in the Runtime bucket when the parser is loaded', () => {
  // The mcp-tool-name parser is a renderer module we install onto globalThis
  // for the detail pane to see. Fixture it here so the row surfaces the
  // servers referenced by the record's tool events.
  const parser = require('../src/renderer/mcp-tool-name.js')
  const prev = globalThis.__dshMcpToolName
  globalThis.__dshMcpToolName = parser
  try {
    const rec = {
      events: [
        { type: 'tool/call', data: { tool: 'mcp__github__create_issue' } },
        { type: 'tool/call', data: { tool: 'read_file' } }, // native, ignored
        { type: 'tool/call', data: { tool: 'mcp__everything__get_sum' } },
      ],
    }
    const groups = dp.attributesGroups(rec)
    const runtime = groups.find(g => g.key === 'runtime').rows
    const mcpRow = runtime.find(([k]) => k === 'mcp.server')
    assert.ok(mcpRow, 'mcp.server row should be present in Runtime group')
    // Servers are sorted+joined in a stable order (parser preserves insertion
    // order from the Set); the values are comma-space separated.
    assert.strictEqual(mcpRow[1], 'github, everything')
  } finally {
    globalThis.__dshMcpToolName = prev
  }
})

test('attributesGroups mcp.server row is absent when no MCP tool ran', () => {
  const parser = require('../src/renderer/mcp-tool-name.js')
  const prev = globalThis.__dshMcpToolName
  globalThis.__dshMcpToolName = parser
  try {
    const rec = { events: [{ type: 'tool/call', data: { tool: 'read_file' } }] }
    const groups = dp.attributesGroups(rec)
    const runtime = groups.find(g => g.key === 'runtime').rows
    const mcpRow = runtime.find(([k]) => k === 'mcp.server')
    assert.deepStrictEqual(mcpRow[1], { absent: true })
  } finally {
    globalThis.__dshMcpToolName = prev
  }
})

test('attributesGroups threads sessionHeader.cwd into Runtime group', () => {
  const rec = makeRec()
  // Field §3 P0 #5: absent when no header threaded.
  const bare = dp.attributesGroups(rec, null)
  const bareRuntime = bare.find(g => g.key === 'runtime').rows
  const bareCwd = bareRuntime.find(([k]) => k === 'cwd')[1]
  assert.deepStrictEqual(bareCwd, { absent: true })

  // Present when the shell passes the SessionHeader in.
  const withHeader = dp.attributesGroups(rec, { cwd: '~/harness/dsh-desktop-demo' })
  const runtime = withHeader.find(g => g.key === 'runtime').rows
  const cwd = runtime.find(([k]) => k === 'cwd')[1]
  assert.strictEqual(cwd, '~/harness/dsh-desktop-demo')

  // Non-string cwd should degrade to absent, not throw.
  const badHeader = dp.attributesGroups(rec, { cwd: 42 })
  const badCwd = badHeader.find(g => g.key === 'runtime').rows.find(([k]) => k === 'cwd')[1]
  assert.deepStrictEqual(badCwd, { absent: true })
})

test('Input/Output sections carry a Render dropdown (Markdown/Plain/JSON)', () => {
  const doc = makeDoc()
  const rec = makeRec()
  const pane = dp.buildDetailPane(doc, { record: rec, sessionId: 's1', defaultTab: 'output' })
  const selects = queryAll(pane, '.trace-detail-render-mode')
  assert.strictEqual(selects.length, 2, 'one dropdown each for Input + Output')
  for (const sel of selects) {
    const opts = (sel.children || []).map(c => c.value || c.textContent)
    assert.ok(opts.includes('markdown') || opts.length >= 3,
      'Render dropdown lists at least three modes')
  }
})

test('Output section wraps rows in a Fields card with Expand-all + Copy controls', () => {
  const doc = makeDoc()
  const rec = makeRec()
  const pane = dp.buildDetailPane(doc, { record: rec, sessionId: 's1', defaultTab: 'output' })
  const card = queryOne(pane, '.trace-detail-fields-card')
  assert.ok(card, 'Fields card wraps output rows')
  const title = queryOne(card, '.trace-detail-fields-title')
  assert.ok(title && title.textContent === 'Fields', 'card carries "Fields" title')
  const expand = queryOne(card, '.trace-detail-fields-expand')
  const copy = queryOne(card, '.trace-detail-fields-copy')
  assert.ok(expand, 'Expand all button present')
  assert.ok(copy, 'Copy button present')
  const perBlocks = queryAll(card, '.trace-detail-field-block')
  assert.ok(perBlocks.length >= 1, 'each output is a per-block <details>')
})

// ─── 2026-07-17 drift-review addendum: leak fix + follow-ups ───────────

test('outputRows preserves assistant-message + tool_use mixed content', () => {
  // Regression guard: an assistant/message with interleaved text and
  // tool_use blocks must yield one message row whose toolCalls[] carries
  // every tool_use in order, without dropping the text content.  This is
  // the shape we ship to the Output panel and the fields-card renderer.
  const rec = {
    outputs: [
      { seq: 20, type: 'assistant/message', data: {
        content: [
          { type: 'text', text: 'first ' },
          { type: 'tool_use', id: 'a', name: 'read', input: { path: 'a.ts' } },
          { type: 'text', text: 'more thoughts' },
          { type: 'tool_use', id: 'b', name: 'write', input: { path: 'b.ts' } },
        ],
      } },
    ],
  }
  const rows = dp.outputRows(rec)
  assert.strictEqual(rows.length, 1)
  assert.strictEqual(rows[0].kind, 'message')
  // First text block is exposed as the row's `text` field.
  assert.strictEqual(rows[0].text, 'first ')
  assert.strictEqual(rows[0].toolCalls.length, 2)
  assert.deepStrictEqual(rows[0].toolCalls.map(t => t.name), ['read', 'write'])
  assert.deepStrictEqual(rows[0].toolCalls.map(t => t.id), ['a', 'b'])
})

test('buildDetailPane defaults to Output when defaultTab is unspecified', () => {
  // reference tracing UI parity: the pane opens with Output as the emphasized tab
  // (matches the "run finished, show me what happened" default).  The
  // scroll-anchor rewrite kept sections mounted in <details open>, but
  // the active tab pill + initial scroll target must still land on Output.
  const doc = makeDoc()
  const rec = makeRec()
  const pane = dp.buildDetailPane(doc, { record: rec, sessionId: 's1' })
  const tabs = queryAll(pane, '.trace-detail-tab')
  assert.ok(tabs.length >= 3)
  const active = tabs.filter(t => t._classSet && t._classSet.has('active'))
  assert.strictEqual(active.length, 1, 'exactly one tab pill is active')
  assert.strictEqual(active[0].dataset.tab, 'output',
    'Output is the default active tab (LangSmith parity)')
})

test('reopening the pane does not accumulate dsh:annotation-updated listeners', () => {
  // Drift review 2026-07-17: earlier code called document.addEventListener
  // on every buildDetailPane() but never removeEventListener, so an
  // openDetailForSeq loop leaked one listener per open.  The tri-view now
  // exposes detachDetailListener(host) which pulls the recorded listener
  // off its target.  Simulate three open/close cycles and assert the doc
  // ends with zero live listeners.
  const TRI = require('../src/renderer/trace-tri-view.js')
  const listeners = []
  const prevDoc = global.document
  global.document = {
    addEventListener(name, fn) { listeners.push({ name, fn }) },
    removeEventListener(name, fn) {
      const i = listeners.findIndex(l => l.name === name && l.fn === fn)
      if (i >= 0) listeners.splice(i, 1)
    },
  }
  try {
    const slot = makeDoc().createElement('div')
    // querySelectorAll needs to return the mounted pane; use the same
    // stub the test fake gives.
    for (let i = 0; i < 3; i++) {
      TRI.detachDetailListener(slot) // pre-mount detach (no-op safe)
      // Simulate what openDetailForSeq does before mounting a new pane:
      // clear the slot then append a fresh pane.
      while (slot.firstChild) slot.removeChild(slot.firstChild)
      const pane = dp.buildDetailPane(makeDoc(), { record: makeRec(), sessionId: 's1' })
      slot.appendChild(pane)
      // Sanity: each build should have added exactly one listener.
      assert.strictEqual(listeners.length, 1,
        `cycle ${i}: exactly one listener during pane lifetime`)
      // Close the pane the way tri-view does: detach then clear.
      TRI.detachDetailListener(slot)
      while (slot.firstChild) slot.removeChild(slot.firstChild)
      assert.strictEqual(listeners.length, 0,
        `cycle ${i}: listener count is zero after detach + clear`)
    }
  } finally {
    if (prevDoc === undefined) delete global.document; else global.document = prevDoc
  }
})

// ─── Feedback tab dim-type chips (rubric primitive parity) ────────────

test('buildFeedbackDimChip stamps type badge + renders each primitive value', () => {
  const doc = makeDoc()
  // Continuous — value renders as-is.
  const cont = dp.buildFeedbackDimChip(doc, 'quality', 0.8,
    { id: 'quality', type: 'continuous', min: 0, max: 1 })
  assert.strictEqual(cont.dataset.dimType, 'continuous')
  const contBadge = queryOne(cont, '.trace-detail-feedback-dim-type-badge')
  assert.ok(contBadge && contBadge.textContent === 'continuous')
  const contVal = queryOne(cont, '.trace-detail-feedback-dim-value')
  assert.strictEqual(contVal.textContent, '0.8')
  // Categorical — value renders as enum text.
  const cat = dp.buildFeedbackDimChip(doc, 'verdict', 'good',
    { id: 'verdict', type: 'categorical', values: ['bad', 'ok', 'good'] })
  assert.strictEqual(cat.dataset.dimType, 'categorical')
  const catVal = queryOne(cat, '.trace-detail-feedback-dim-value')
  assert.strictEqual(catVal.textContent, 'good')
  // Boolean — value renders as the rubric's label.
  const boolChip = dp.buildFeedbackDimChip(doc, 'passes', true,
    { id: 'passes', type: 'boolean', labels: { true: 'pass', false: 'fail' } })
  assert.strictEqual(boolChip.dataset.dimType, 'boolean')
  const boolVal = queryOne(boolChip, '.trace-detail-feedback-dim-value')
  assert.strictEqual(boolVal.textContent, 'pass')
})

test('buildFeedbackDimChip handles null values as "absent"', () => {
  const doc = makeDoc()
  const chip = dp.buildFeedbackDimChip(doc, 'quality', null,
    { id: 'quality', type: 'continuous', min: 0, max: 1 })
  const val = queryOne(chip, '.trace-detail-feedback-dim-value')
  assert.strictEqual(val.textContent, '—')
  assert.ok(val._classSet.has('absent'), 'absent class applied')
})

test('buildFeedbackDimChip without a spec falls back to typeless rendering', () => {
  // Legacy path — untyped Feedback rows (5 fixed continuous dims) don't
  // pass through the annotation getActiveDims helper, so specById is empty.
  const doc = makeDoc()
  const chip = dp.buildFeedbackDimChip(doc, 'convergence', 4, null)
  const val = queryOne(chip, '.trace-detail-feedback-dim-value')
  assert.strictEqual(val.textContent, '4')
  // No type badge in typeless mode.
  const badge = queryOne(chip, '.trace-detail-feedback-dim-type-badge')
  assert.strictEqual(badge, null)
})

// ─── 2026-07-17 trace-parity batch: Error 第5tab (conditional) ────────

function makeErrorRec() {
  // Same shape as makeRec() but with a tool/result carrying isError=true —
  // the primary way DSH surfaces a tool-loop failure on the wire.
  return {
    turn: 1, step: 3,
    startSeq: 30, endSeq: 36,
    startTime: 3000, endTime: 3500, durationMs: 500,
    summary: 'read broken file',
    header: { model: 'deepseek-v4', provider: 'deepseek' },
    inputs: [{ seq: 28, time: 2999, type: 'user/message', data: { text: 'read x.ts' } }],
    outputs: [
      { seq: 31, time: 3100, type: 'assistant/message', data: {
        content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'x.ts' } }],
      } },
      { seq: 32, time: 3200, type: 'tool/result', data: {
        callId: 't1', isError: true,
        content: [{ type: 'text', text: "RuntimeError: file not found: x.ts" }],
        error: { name: 'RuntimeError', message: 'file not found: x.ts' },
      } },
    ],
    events: [
      { seq: 30, time: 3000, type: 'step/start', data: {} },
    ],
  }
}

// ---------- Reasoning tab (clickability audit, §4 differentiator) --------
// The tab is conditional: absent by default, appears when the record carries
// reasoning-delta chunks OR a positive usage.reasoningTokens.  Guards the
// existing 4-tab baseline and the new 5th tab shape.

function makeReasoningRec() {
  return {
    turn: 2, step: 0,
    startSeq: 20, endSeq: 27,
    startTime: 2000, endTime: 2900, durationMs: 900,
    summary: 'answer with reasoning',
    header: { model: 'deepseek-reasoner', provider: 'deepseek' },
    inputs: [
      { seq: 19, time: 1999, type: 'user/message', data: { text: 'why?' } },
    ],
    outputs: [
      { seq: 26, time: 2800, type: 'assistant/message', data: {
        content: [
          { type: 'reasoning', text: 'I need to think about the whys first, then articulate the answer clearly.' },
          { type: 'text', text: 'Here is the answer.' },
        ],
        usage: { inputTokens: 40, outputTokens: 8, reasoningTokens: 512 },
        finish_reason: 'stop',
      } },
    ],
    events: [
      { seq: 20, time: 2000, type: 'step/start', data: {} },
      { seq: 21, time: 2200, type: 'assistant/chunk', data: {
        chunk: { type: 'reasoning-delta', text: 'I need to think about ' } } },
      { seq: 22, time: 2250, type: 'assistant/chunk', data: {
        chunk: { type: 'reasoning-delta', text: 'the whys first, ' } } },
      { seq: 23, time: 2300, type: 'assistant/chunk', data: {
        chunk: { type: 'reasoning-delta', text: 'then articulate the answer clearly.' } } },
      { seq: 26, time: 2800, type: 'assistant/message', data: {
        usage: { inputTokens: 40, outputTokens: 8, reasoningTokens: 512 },
        finish_reason: 'stop' } },
    ],
  }
}

test('detectRecordError returns null on a clean run and details on an error run', () => {
  assert.strictEqual(dp.detectRecordError(makeRec()), null,
    'a rec with no error-flagged event should be null')
  const errInfo = dp.detectRecordError(makeErrorRec())
  assert.ok(errInfo, 'error record must be flagged')
  assert.strictEqual(errInfo.name, 'Tool error')
  assert.ok(errInfo.message && errInfo.message.includes('file not found'),
    'primary message pulled from tool/result content or error.message')
  assert.strictEqual(errInfo.code, 'RuntimeError')
  assert.strictEqual(errInfo.events.length, 1)
  assert.strictEqual(errInfo.events[0].type, 'tool/result')
})

test('detectRecordError catches turn/aborted and error/* wire events', () => {
  const aborted = dp.detectRecordError({
    outputs: [], events: [{ seq: 1, type: 'turn/aborted', data: { reason: 'user cancel' } }],
  })
  assert.ok(aborted && aborted.name === 'Turn aborted' && aborted.message === 'user cancel')
  const kernel = dp.detectRecordError({
    outputs: [], events: [{ seq: 2, type: 'error/kernel', data: { message: 'oom', name: 'OOM' } }],
  })
  assert.ok(kernel && kernel.name && kernel.message === 'oom' && kernel.code === 'OOM')
})

test('detectRecordError treats error-flavoured finish_reason as an error', () => {
  const rec = { outputs: [{ seq: 3, type: 'assistant/message', data: { finish_reason: 'content_policy_violation' } }] }
  const info = dp.detectRecordError(rec)
  assert.ok(info, 'content_policy_violation must count as error')
  assert.strictEqual(info.name, 'Model error')
})

test('resolveTabOrder prepends Error on error runs, leaves 4-tab layout on clean runs', () => {
  const clean = dp.resolveTabOrder(null)
  assert.deepStrictEqual(clean, ['feedback', 'input', 'output', 'attributes'],
    'clean runs keep the 4-tab layout (parity: LangSmith round-6 OK-run)')
  const withErr = dp.resolveTabOrder({ name: 'Tool error', message: 'x', events: [] })
  assert.deepStrictEqual(withErr, ['error', 'feedback', 'input', 'output', 'attributes'],
    'error runs get 5 tabs, Error prepended (parity: LangSmith round-6 shot 11)')
})

test('normal fixture renders 4 tabs, error fixture renders 5 tabs with Error pre-selected', () => {
  // Normal (clean run) — 4 tabs, no `.section-error`, Output active.
  const doc1 = makeDoc()
  const pane1 = dp.buildDetailPane(doc1, { record: makeRec(), sessionId: 's1' })
  const tabs1 = queryAll(pane1, '.trace-detail-tab')
  assert.strictEqual(tabs1.length, 4, 'clean run: 4 tabs')
  const errSec1 = queryOne(pane1, '.section-error')
  assert.strictEqual(errSec1, null, 'clean run: no Error section')
  assert.ok(!pane1._classSet.has('has-error'), 'clean pane does not carry .has-error')

  // Error fixture — 5 tabs, Error section rendered, Error tab active.
  const doc2 = makeDoc()
  const pane2 = dp.buildDetailPane(doc2, { record: makeErrorRec(), sessionId: 'sE' })
  const tabs2 = queryAll(pane2, '.trace-detail-tab')
  assert.strictEqual(tabs2.length, 5, 'error run: 5 tabs (Error prepended)')
  assert.strictEqual(tabs2[0].textContent, 'Error', 'first tab is Error')
  assert.ok(tabs2[0]._classSet.has('active'), 'Error tab pre-selected on error run')
  assert.ok(pane2._classSet.has('has-error'), 'pane carries .has-error class hook')
  const errSec = queryOne(pane2, '.section-error')
  assert.ok(errSec, 'Error section rendered')
})

test('Error section renders banner with name + message + related-event refs', () => {
  const doc = makeDoc()
  const pane = dp.buildDetailPane(doc, { record: makeErrorRec(), sessionId: 'sE' })
  const banner = queryOne(pane, '.trace-detail-error-banner')
  assert.ok(banner, 'red-outlined banner is present')
  const name = queryOne(banner, '.trace-detail-error-name')
  assert.ok(name && name.textContent === 'Tool error', 'name pulled from detectRecordError')
  const msg = queryOne(banner, '.trace-detail-error-message')
  assert.ok(msg && msg.textContent.includes('file not found'),
    'wire error message is displayed as text (not just red-coloured)')
  const code = queryOne(banner, '.trace-detail-error-code')
  assert.ok(code && code.textContent.includes('RuntimeError'),
    'error.name/code surfaces alongside the message')
  const refs = queryAll(pane, '.trace-detail-error-ref')
  assert.ok(refs.length >= 1, 'related-event refs render as buttons')
  assert.ok(refs[0].textContent.includes('tool/result'),
    'ref labels include the event type + seq')
})

// -------------------------------------------------------------------------
// Task #34 — HUMAN card convergence: role labels are inline titlecase
// (small dot glyph + Titlecase word), never an uppercase hero heading.
// The old block-level "USER"/"HUMAN" caps card was flagged by 老板 as adding
// no information increment ("这么强调 human 并不能带来额外的信息增量").
// Locks the new shape so we don't regress.
test('trace-detail-role renders as titlecase inline (dot glyph + Titlecase word), never uppercase', () => {
  const doc = makeDoc()
  const rec = {
    ...makeRec(),
    inputs: [
      { type: 'user/message', seq: 8, time: 999, data: { text: 'hi' } },
      { type: 'context/message', seq: 9, time: 999, data: { text: 'ctx' } },
    ],
  }
  const pane = dp.buildDetailPane(doc, { record: rec, sessionId: 's1', defaultTab: 'input' })
  const roles = queryAll(pane, '.trace-detail-role')
  // At minimum: one role per message row.
  assert.ok(roles.length >= 2, `each message row carries a .trace-detail-role (got ${roles.length})`)
  const first = roles[0]
  assert.equal(first._classSet.has('mono'), false,
    'trace-detail-role is NOT mono-typed (retired lowercase mono style)')
  const glyph = queryOne(first, '.trace-detail-role-glyph')
  const label = queryOne(first, '.trace-detail-role-label')
  assert.ok(glyph, 'role has a leading glyph child')
  assert.ok(label, 'role has a label child')
  // The label word must be Titlecase — first char uppercase, rest lowercase.
  const w = label.textContent || ''
  assert.ok(/^[A-Z][a-z]+$/.test(w),
    `role label "${w}" must be Titlecase (e.g. "User", not "USER" / "user")`)
  assert.notEqual(w, w.toUpperCase(),
    'role label must not be all-uppercase (HUMAN caps card is retired)')
  // data-role stays lowercase for CSS hooks.
  assert.ok(first.dataset.role && first.dataset.role === first.dataset.role.toLowerCase(),
    'data-role attr stays lowercase for styling')
})

// -------------------------------------------------------------------------
// Team-lead 2026-07-17 正面参照 ("像这样的 UI 就是我们想要的" — reference tracing UI
// detail-pane): tool_call arguments render as a RECURSIVELY collapsible
// JSON tree. Each nested object/array gets its own arrow at ANY depth,
// scalars get a leading `·` dot, leaves in mono. Density is managed by
// per-level folding, never by dropping (zero-drop rule).
test('buildJsonTree renders nested objects with per-depth foldable branches', () => {
  const doc = makeDoc()
  const nested = {
    choices: [
      {
        finish_reason: 'stop',
        index: 0,
        message: { role: 'assistant', content: 'ok', tool_calls: [{ id: 't1', name: 'read' }] },
      },
    ],
    id: 'chatcmpl-1',
    model: 'deepseek-v4',
  }
  const tree = dp.buildJsonTree(doc, nested, { openDepth: 1 })
  // Root has 3 keys → summary preview reflects it.
  const branches = queryAll(tree, '.trace-detail-json-branch')
  assert.ok(branches.length >= 3,
    `deep nested tree must expose a branch node at every level (got ${branches.length})`)
  const leaves = queryAll(tree, '.trace-detail-json-leaf')
  assert.ok(leaves.length >= 5, 'scalar leaves render inline (id, model, finish_reason, index, role, content, ...)')
  // Every leaf carries the `·` dot.
  const dots = queryAll(tree, '.trace-detail-json-dot')
  assert.equal(dots.length, leaves.length,
    'every leaf has its own `·` dot glyph')
  // Depth propagates down: at least one branch should sit at depth ≥ 2 (choices → [0] → message).
  const depths = branches.map((b) => parseInt(b.dataset.depth || '0', 10))
  assert.ok(Math.max.apply(null, depths) >= 2,
    `recursion reaches depth ≥ 2 (max observed ${Math.max.apply(null, depths)})`)
})

test('buildJsonTree respects openDepth and defaults to top-level-only open', () => {
  const doc = makeDoc()
  const tree = dp.buildJsonTree(doc, { a: { b: { c: 1 } } }, { openDepth: 1 })
  const branches = queryAll(tree, '.trace-detail-json-branch')
  // top branch open (depth 0), nested branches closed (depth 1, 2)
  const top = branches.find((b) => (b.dataset.depth || '0') === '0')
  assert.ok(top && top.open === true, 'top-level branch opens by default')
  const deeper = branches.filter((b) => (b.dataset.depth || '0') !== '0')
  for (const d of deeper) {
    assert.notEqual(d.open, true,
      `depth ${d.dataset.depth} branch stays folded until clicked (density-by-folding)`)
  }
})

test('buildJsonTree renders scalars with typed classes (string/number/boolean/null)', () => {
  const doc = makeDoc()
  const tree = dp.buildJsonTree(doc, {
    s: 'hi', n: 42, b: true, nl: null, arr: [], obj: {},
  }, { openDepth: 2 })
  const byKey = {}
  for (const leaf of queryAll(tree, '.trace-detail-json-leaf')) {
    const kEl = queryOne(leaf, '.trace-detail-json-key')
    const vEl = queryOne(leaf, '.trace-detail-json-value')
    if (kEl && vEl) byKey[kEl.textContent] = vEl
  }
  assert.ok(byKey.s && byKey.s._classSet.has('is-string'), 'string leaf marked is-string')
  assert.ok(byKey.n && byKey.n._classSet.has('is-number'), 'number leaf marked is-number')
  assert.ok(byKey.b && byKey.b._classSet.has('is-boolean'), 'boolean leaf marked is-boolean')
  assert.ok(byKey.nl && byKey.nl._classSet.has('is-null'), 'null leaf marked is-null')
  // Empty object/array collapse to `{}` / `[]` leaves (no fold to click into nothing).
  assert.ok(byKey.arr && (byKey.arr.textContent === '[]'), 'empty array is a leaf `[]`')
  assert.ok(byKey.obj && (byKey.obj.textContent === '{}'), 'empty object is a leaf `{}`')
})

// Task #37 + Batch C: every Output row exposes its full raw wire payload via
// a recursive Fields subtree (reference tracing UI parity — every wire field reachable
// through recursive fold, not just tool_call.arguments). Team-lead 2026-07-17
// Batch C flipped the default to OPEN so the tree is what the user sees on
// first click (matches user's reference tracing UI detail-pane screenshots); density is
// still carried by inner per-branch fold (openDepth=1).
test('buildRawFieldsSubtree wraps raw event.data in recursive tree, open by default', () => {
  const doc = makeDoc()
  const rawEv = {
    type: 'assistant/message',
    data: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'hello world' },
        { type: 'tool_use', id: 'call_1', name: 'ls', input: { path: '/tmp' } },
      ],
      finish_reason: 'tool_calls',
      usage: { prompt_tokens: 128, completion_tokens: 42, total_tokens: 170 },
    },
  }
  const subtree = dp.buildRawFieldsSubtree(doc, rawEv)
  assert.ok(subtree, 'returns a subtree element when payload has ≥1 key')
  assert.equal(subtree.tagName, 'DETAILS', 'top-level container is a <details>')
  assert.equal(subtree.open, true, 'open by default so the tree is visible on first render (Batch C)')
  const summary = queryOne(subtree, '.trace-detail-row-fields-summary')
  assert.ok(summary, 'has a summary anchor')
  const label = queryOne(summary, '.trace-detail-row-fields-label')
  assert.equal(label && label.textContent, 'Fields', 'summary reads "Fields"')
  const count = queryOne(summary, '.trace-detail-row-fields-count')
  assert.ok(count && /4 keys/.test(count.textContent), 'summary shows key count')
  // Body carries a buildJsonTree — walk down to prove depth reachability.
  const tree = queryOne(subtree, '.trace-detail-json-tree')
  assert.ok(tree, 'body hosts a recursive JSON tree')
  const branches = queryAll(tree, '.trace-detail-json-branch')
  const maxDepth = branches.length
    ? Math.max.apply(null, branches.map((b) => parseInt(b.dataset.depth || '0', 10)))
    : 0
  assert.ok(maxDepth >= 2, `recursion reaches deep enough (max depth ${maxDepth})`)
})

test('buildRawFieldsSubtree returns null for empty payload (nothing to reach)', () => {
  const doc = makeDoc()
  assert.equal(dp.buildRawFieldsSubtree(doc, null), null, 'null raw → null')
  assert.equal(dp.buildRawFieldsSubtree(doc, { type: 'x' }), null,
    'raw with no .data and no keys beyond type → null (nothing to unfold)')
  const empty = { type: 'x', data: {} }
  assert.equal(dp.buildRawFieldsSubtree(doc, empty), null, 'empty data → null')
})

// Batch C (team-lead 2026-07-17): tool/result events now surface as Output
// rows so the Fields card can drill into tool result content (multipart
// text/image blocks, isError, meta) with the same recursive fold grammar as
// tool_call.arguments and assistant/message payloads. Zero-drop reachability.
test('outputRows emits tool-result rows carrying raw content + isError (Batch C)', () => {
  const rec = {
    outputs: [
      { seq: 20, time: 2000, type: 'tool/call', data: { callId: 't2', tool: 'search', arguments: { q: 'x' } } },
      { seq: 21, time: 2100, type: 'tool/result', data: {
        callId: 't2',
        content: [
          { type: 'text', text: 'search returned 3 items' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png' } },
        ],
        isError: false,
        meta: { card: 'generic', latencyMs: 47 },
      } },
      { seq: 22, time: 2200, type: 'tool/result', data: {
        callId: 't3', content: [{ type: 'text', text: 'permission denied' }], isError: true,
      } },
    ],
  }
  const rows = dp.outputRows(rec)
  assert.equal(rows.length, 3, 'one tool-call + two tool-result rows')
  assert.equal(rows[1].kind, 'tool-result', 'tool/result → kind:tool-result')
  assert.equal(rows[1].callId, 't2')
  assert.equal(rows[1].isError, false)
  assert.ok(Array.isArray(rows[1].content) && rows[1].content.length === 2,
    'content is the ContentBlock[] payload')
  assert.equal(rows[2].isError, true, 'isError=true survives through the row')
})

test('buildOutputRow tool-result branch mounts recursive Fields + error chip on isError', () => {
  const doc = makeDoc()
  const rawEv = {
    seq: 30, time: 3000, type: 'tool/result',
    data: {
      callId: 't9',
      content: [{ type: 'text', text: 'stack trace goes here (very long payload elided for the fixture)…' }],
      isError: true,
      meta: { card: 'terminal', diagnostics: { exitCode: 137, signal: 'SIGKILL', durationMs: 812 } },
    },
  }
  const r = { kind: 'tool-result', role: 'tool', callId: 't9', content: rawEv.data.content, isError: true, raw: rawEv }
  const row = dp.buildOutputRow(doc, r, 'markdown')
  // Error chip surfaces isError inline
  const chip = queryOne(row, '.trace-detail-tool-result-error-chip')
  assert.ok(chip, 'isError=true renders a status chip inline')
  assert.equal(chip.textContent, 'isError')
  // Recursive Fields subtree present + open by default (Batch C)
  const subtree = queryOne(row, '.trace-detail-row-fields')
  assert.ok(subtree, 'tool-result row exposes Fields subtree')
  assert.equal(subtree.open, true, 'Fields subtree open by default so tree is visible on first render')
  const branches = queryAll(subtree, '.trace-detail-json-branch')
  const maxDepth = branches.length
    ? Math.max.apply(null, branches.map((b) => parseInt(b.dataset.depth || '0', 10)))
    : 0
  assert.ok(maxDepth >= 2, `recursive tree reaches ≥ depth 2 (got ${maxDepth})`)
  // Raw badge still present (L2 drawer reachability preserved)
  const raw = queryOne(row, '.trace-detail-raw-badge')
  assert.ok(raw, 'raw badge preserved for L2 drawer')
})

test('buildMessageRow (Input panel) exposes recursive Fields subtree per Batch C', () => {
  const doc = makeDoc()
  const ev = {
    seq: 5, time: 500, type: 'user/message',
    data: {
      role: 'user',
      content: [
        { type: 'text', text: 'summarise this doc', cache_control: { type: 'ephemeral' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png' } },
      ],
      metadata: { userId: 'u-42', clientVersion: '2026.7.17' },
    },
  }
  const row = dp.buildMessageRow(doc, ev, 'markdown')
  const subtree = queryOne(row, '.trace-detail-row-fields')
  assert.ok(subtree, 'Input message row exposes Fields subtree (parity with Output rows)')
  assert.equal(subtree.open, true, 'default-open so raw wire is visible on first click into the row')
  const branches = queryAll(subtree, '.trace-detail-json-branch')
  const maxDepth = branches.length
    ? Math.max.apply(null, branches.map((b) => parseInt(b.dataset.depth || '0', 10)))
    : 0
  assert.ok(maxDepth >= 2, `Input recursion reaches deep enough (max depth ${maxDepth})`)
  // Role label still leads the row (no HUMAN caps card regression).
  const label = queryOne(row, '.trace-detail-role-label')
  assert.ok(label && label.textContent === 'User', 'role label is lightweight Titlecase word "User"')
})

test('reasoningRows returns null on a record without reasoning', () => {
  assert.strictEqual(dp.reasoningRows(makeRec()), null)
})

test('reasoningRows aggregates deltas + tokens on a reasoning turn', () => {
  const r = dp.reasoningRows(makeReasoningRec())
  assert.ok(r, 'row struct exists')
  assert.strictEqual(r.deltaCount, 3, 'three reasoning-delta chunks counted')
  assert.strictEqual(r.reasoningTokens, 512)
  assert.ok(r.text && r.text.includes('articulate the answer clearly'),
    'concatenated reasoning body is present')
})

test('Reasoning tab is absent when the record has no reasoning', () => {
  const doc = makeDoc()
  const pane = dp.buildDetailPane(doc, { record: makeRec(), sessionId: 's1' })
  const tabs = queryAll(pane, '.trace-detail-tab')
  assert.strictEqual(tabs.length, 4, 'four tabs on non-reasoning record')
  assert.ok(!tabs.some((t) => t.textContent === 'Reasoning'),
    'no Reasoning tab label')
})

test('Reasoning tab appears when the record carries reasoning content', () => {
  const doc = makeDoc()
  const pane = dp.buildDetailPane(doc, { record: makeReasoningRec(), sessionId: 's2' })
  const tabs = queryAll(pane, '.trace-detail-tab')
  assert.strictEqual(tabs.length, 5, 'five tabs on a reasoning record')
  assert.strictEqual(tabs[4].textContent, 'Reasoning')
  const panel = queryOne(pane, '.panel-reasoning')
  assert.ok(panel, 'reasoning panel mounted')
  const body = queryOne(panel, '.trace-detail-reasoning-content')
  assert.ok(body, 'reasoning body rendered')
  assert.ok(body.textContent.includes('articulate the answer clearly'))
  const chips = queryAll(panel.parentNode.children[0], 'trace-detail-reasoning-chip')
  // Chips live inside the section head controls; walk the whole section.
  const section = queryOne(pane, '.section-reasoning')
  const chipEls = queryAll(section, '.trace-detail-reasoning-chip')
  assert.ok(chipEls.length >= 2, `expected token + delta chips, got ${chipEls.length}`)
  const chipText = chipEls.map((c) => c.textContent).join(' | ')
  assert.ok(/512 tok/.test(chipText), `reasoningTokens chip text: ${chipText}`)
  assert.ok(/3 deltas?/.test(chipText), `delta-count chip text: ${chipText}`)
})
