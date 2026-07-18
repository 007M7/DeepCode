// subagent-view.test.js — task #138 batch 3 §1.4.
// Verifies:
//   1. parseSubagentReturn extracts JSON from a ```json ... ``` fence
//   2. parseSubagentReturn returns ok:false with raw payload on parse failure
//   3. parseSubagentReturn returns null for empty/missing content blocks
//   4. summariseSubagentSteps counts step/start/step/end and captures duration
//   5. buildSubagentCard renders lineage + status pill + steps + return sections
//   6. buildSubagentCard uses raw section when return is not JSON
//   7. buildSubagentRail renders one pill per agent with click handler
//   8. shortId shortens long ids in the head

'use strict'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const fs = require('node:fs')

const view = require('../src/renderer/subagent-view.js')

function makeDoc() {
  return {
    createElement(tag) {
      const el = {
        tagName: tag.toUpperCase(),
        className: '',
        textContent: '',
        _children: [],
        _listeners: {},
        dataset: {},
        appendChild(c) { this._children.push(c); return c },
        append(...cs) { for (const c of cs) this._children.push(c) },
        addEventListener(name, fn) { (this._listeners[name] = this._listeners[name] || []).push(fn) },
        setAttribute() {},
      }
      Object.defineProperty(el, 'open', {
        get() { return this._open === true },
        set(v) { this._open = v },
      })
      return el
    },
  }
}

function collectByClass(root, className, out = []) {
  if (!root) return out
  if (root.className && root.className.split(' ').includes(className)) out.push(root)
  for (const c of (root._children || [])) collectByClass(c, className, out)
  return out
}

test('parseSubagentReturn extracts JSON from a ```json fence', () => {
  const blocks = [{ type: 'text', text: '```json\n{"a":1,"b":[2,3]}\n```' }]
  const r = view.parseSubagentReturn(blocks)
  assert.ok(r)
  assert.strictEqual(r.ok, true)
  assert.deepStrictEqual(r.json, { a: 1, b: [2, 3] })
})

test('parseSubagentReturn returns ok:false with raw payload on parse failure', () => {
  const blocks = [{ type: 'text', text: '```json\nnot valid json {\n```' }]
  const r = view.parseSubagentReturn(blocks)
  assert.ok(r)
  assert.strictEqual(r.ok, false)
  assert.match(r.raw, /not valid/)
})

test('parseSubagentReturn returns null for empty/missing content', () => {
  assert.strictEqual(view.parseSubagentReturn(null), null)
  assert.strictEqual(view.parseSubagentReturn([]), null)
  assert.strictEqual(view.parseSubagentReturn([{ type: 'image' }]), null)
})

test('summariseSubagentSteps counts step/start and step/end and captures duration', () => {
  const evs = [
    { type: 'turn/start', time: 100, data: { turn: 0 } },
    { type: 'step/start', time: 110, data: { step: 0 } },
    { type: 'step/end',   time: 200, data: { step: 0 } },
    { type: 'step/start', time: 210, data: { step: 1 } },
    { type: 'step/end',   time: 300, data: { step: 1 } },
    { type: 'turn/end',   time: 310, data: { reason: { kind: 'completed' } } },
  ]
  const s = view.summariseSubagentSteps(evs)
  assert.strictEqual(s.total, 2)
  assert.strictEqual(s.done, 2)
  assert.strictEqual(s.running, 0)
  assert.strictEqual(s.failed, 0)
  assert.strictEqual(s.durationMs, 210)
})

test('buildSubagentCard shows lineage + status + steps + return section', () => {
  const doc = makeDoc()
  const fixturePath = path.join(__dirname, '..', 'fixtures', 'trace-samples', '1.4-subagent-structured-return.json')
  const seq = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'))
  const started = seq.find(e => e && e.method === 'subagent.started')
  const finished = seq.find(e => e && e.method === 'subagent.finished')
  const childEvents = seq.filter(e => e && !e.method)
  const spec = {
    parentSessionId: started.params.parentSessionId,
    childSessionId: started.params.childSessionId,
    provider: finished.params.provider,
    status: finished.params.status,
    childEvents,
    lastAssistantMessage: finished.params.lastAssistantMessage,
  }
  const card = view.buildSubagentCard(doc, spec, {})
  const lineage = collectByClass(card, 'subagent-card-lineage')[0]
  assert.match(lineage.textContent, /root/)
  assert.match(lineage.textContent, /sub-def/)
  const pill = collectByClass(card, 'subagent-card-status')[0]
  assert.strictEqual(pill.textContent, 'done')
  const returnJson = collectByClass(card, 'subagent-card-return-json')[0]
  assert.ok(returnJson, 'expected a JSON return section for the structured fixture')
  assert.match(returnJson.textContent, /references/)
})

test('buildSubagentCard falls back to prose section when return is not JSON', () => {
  // viz-coverage-matrix §5 P0-5 fix: unstructured lastAssistantMessage now
  // renders as prose paragraph (.subagent-card-return-prose), not a <pre>
  // (.subagent-card-return-raw). The old class remains reserved for callers
  // that need explicit raw-text framing (none in-tree).
  const doc = makeDoc()
  const spec = {
    parentSessionId: 'p', childSessionId: 'c',
    status: 'ok',
    childEvents: [],
    lastAssistantMessage: [{ type: 'text', text: 'plain english, no fence' }],
  }
  const card = view.buildSubagentCard(doc, spec, {})
  assert.strictEqual(collectByClass(card, 'subagent-card-return-json').length, 0)
  const prose = collectByClass(card, 'subagent-card-return-prose')[0]
  assert.ok(prose, 'expected .subagent-card-return-prose element')
  assert.strictEqual(prose.textContent, 'plain english, no fence')
})

test('buildSubagentRail renders one pill per agent with click handler', () => {
  const doc = makeDoc()
  const clicks = []
  const rail = view.buildSubagentRail(doc, [
    { childSessionId: 'a1234567890', status: 'running' },
    { childSessionId: 'b0987654321', status: 'done' },
  ], { onPillClick: (id) => clicks.push(id) })
  const pills = collectByClass(rail, 'subagent-rail-pill')
  assert.strictEqual(pills.length, 2)
  const click = (pills[0]._listeners.click || [])[0]
  click()
  assert.deepStrictEqual(clicks, ['a1234567890'])
})

test('buildSubagentRail shows empty state when no agents', () => {
  const doc = makeDoc()
  const rail = view.buildSubagentRail(doc, [], {})
  const empty = collectByClass(rail, 'subagent-rail-empty')[0]
  assert.ok(empty)
})

// -- buildInlineSubagentTrace (#162 rec 31) --------------------------------
//
// Wraps buildSubagentCard in an inline shell so a subagent shows up as a
// peer step under the parent's spawn tool-row inside the assistant-turn
// body — not as a floating side card. Header row: glyph + label +
// lineage + meta (steps · duration · status).

test('buildInlineSubagentTrace: sealed subagent = check glyph + steps summary + full card body', () => {
  const doc = makeDoc()
  const spec = {
    parentSessionId: 'root-abc',
    childSessionId: 'sub-def-1234',
    parentCallId: 'call_spawn_9',
    status: 'ok',
    childEvents: [
      { type: 'step/start', time: 100, data: { step: 0 } },
      { type: 'step/end',   time: 250, data: { step: 0 } },
      { type: 'step/start', time: 260, data: { step: 1 } },
      { type: 'step/end',   time: 400, data: { step: 1 } },
    ],
    lastAssistantMessage: [{ type: 'text', text: '```json\n{"count":1}\n```' }],
  }
  const trace = view.buildInlineSubagentTrace(doc, spec, {})
  assert.strictEqual(trace.tagName, 'DETAILS')
  assert.ok(trace.className.includes('turn-child'))
  assert.ok(trace.className.includes('subagent-trace'))
  assert.strictEqual(trace.dataset.parentCallId, 'call_spawn_9')
  assert.strictEqual(trace.dataset.childSessionId, 'sub-def-1234')

  const glyph = collectByClass(trace, 'subagent-trace-glyph')[0]
  assert.ok(glyph)
  assert.strictEqual(glyph.textContent, '✓')  // ✓

  const meta = collectByClass(trace, 'subagent-trace-meta')[0]
  assert.ok(meta)
  // "2/2 steps · 300ms · done"
  assert.match(meta.textContent, /2\/2 steps/)
  assert.match(meta.textContent, /300ms/)
  assert.match(meta.textContent, /done/)

  // Full card sits inside body — verify at least one signature class from
  // buildSubagentCard is present. C16/C17 (drift cycle 13/14): the outer
  // <summary> now owns lineage/status/steps/duration and the inner card
  // renders with omitHead:true, so we look for `.subagent-card` itself
  // and confirm no `.subagent-card-head` duplicate lives inside.
  const innerCard = collectByClass(trace, 'subagent-card')[0]
  assert.ok(innerCard)
  const heads = collectByClass(trace, 'subagent-card-head')
  assert.strictEqual(heads.length, 0,
    'buildInlineSubagentTrace must pass omitHead:true so the inner card does not re-render lineage/status/steps/duration')
})

test('buildInlineSubagentTrace: failed subagent = cross glyph and "failed" meta', () => {
  const doc = makeDoc()
  const spec = {
    childSessionId: 'sub-fail',
    parentCallId: 'call_x',
    status: 'failed',
    childEvents: [],
  }
  const trace = view.buildInlineSubagentTrace(doc, spec, {})
  const glyph = collectByClass(trace, 'subagent-trace-glyph')[0]
  assert.strictEqual(glyph.textContent, '✗')  // ✗
  const meta = collectByClass(trace, 'subagent-trace-meta')[0]
  assert.match(meta.textContent, /failed/)
})

test('buildInlineSubagentTrace: collapsed by default, opts.collapsed=false forces open', () => {
  const doc = makeDoc()
  const specA = { childSessionId: 's', parentCallId: 'c', status: 'ok', childEvents: [] }
  const collapsed = view.buildInlineSubagentTrace(doc, specA, {})
  assert.notStrictEqual(collapsed._open, true)
  const expanded = view.buildInlineSubagentTrace(doc, specA, { collapsed: false })
  assert.strictEqual(expanded._open, true)
})

// -- viz-coverage-matrix §5 P0-5/6: subagent.finished field backfill ---------

test('renderStatusToken: appends stopReason when present, falls back on empty', () => {
  assert.strictEqual(view.renderStatusToken('done', 'stop'), 'done · stop')
  assert.strictEqual(view.renderStatusToken('done', 'max-tokens'), 'done · max-tokens')
  assert.strictEqual(view.renderStatusToken('failed', 'error'), 'failed · error')
  assert.strictEqual(view.renderStatusToken('done', null), 'done')
  assert.strictEqual(view.renderStatusToken('done', ''), 'done')
  assert.strictEqual(view.renderStatusToken('running', undefined), 'running')
})

test('buildInlineSubagentTrace: stopReason surfaces in the summary meta segment', () => {
  const doc = makeDoc()
  const spec = {
    childSessionId: 'sub-1', parentCallId: 'call_1',
    status: 'ok', stopReason: 'max-tokens', childEvents: [],
  }
  const trace = view.buildInlineSubagentTrace(doc, spec, {})
  const meta = collectByClass(trace, 'subagent-trace-meta')[0]
  assert.match(meta.textContent, /done · max-tokens/)
})

test('buildSubagentCard: stopReason surfaces in the head status pill', () => {
  const doc = makeDoc()
  const spec = {
    parentSessionId: 'p', childSessionId: 'c',
    status: 'ok', stopReason: 'stop', childEvents: [],
  }
  const card = view.buildSubagentCard(doc, spec, {})
  const pill = collectByClass(card, 'subagent-card-status')[0]
  assert.ok(pill)
  assert.strictEqual(pill.textContent, 'done · stop')
})

test('subagentLastMessagePreview: flattens ContentBlock[] to one-liner ≤140 chars', () => {
  const short = view.subagentLastMessagePreview([
    { type: 'text', text: 'quick answer' },
  ])
  assert.strictEqual(short, 'quick answer')

  const long = view.subagentLastMessagePreview([
    { type: 'text', text: 'a'.repeat(200) },
  ])
  assert.ok(long.endsWith('…'))
  // Cap: 137 chars + one ellipsis character = 138. The 140 in the doc is
  // the length gate (>140 triggers truncation), not the final output.
  assert.strictEqual(long.length, 138)

  const multiline = view.subagentLastMessagePreview([
    { type: 'text', text: 'line one\n\nline two' },
  ])
  assert.strictEqual(multiline, 'line one line two')

  assert.strictEqual(view.subagentLastMessagePreview(null), '')
  assert.strictEqual(view.subagentLastMessagePreview([]), '')
})

test('buildSubagentRail: pill title carries status·stopReason and message preview', () => {
  const doc = makeDoc()
  const rail = view.buildSubagentRail(doc, [
    { childSessionId: 'sub-abc-xyz', status: 'ok', stopReason: 'stop',
      lastAssistantMessage: [{ type: 'text', text: 'summary of the run' }] },
    { childSessionId: 'sub-run-000', status: 'running' },
  ], {})
  // The mock doc only stores dataset + className + textContent; title lands
  // on el.title via a direct assignment which the mock stashes as own property.
  const pills = collectByClass(rail, 'subagent-rail-pill')
  assert.strictEqual(pills.length, 2)
  assert.match(pills[0].title, /sub-abc-xyz/)
  assert.match(pills[0].title, /done · stop/)
  assert.match(pills[0].title, /summary of the run/)
  assert.match(pills[1].title, /running/)
})

test('buildSubagentCard: empty lastAssistantMessage skips return section entirely', () => {
  const doc = makeDoc()
  const spec = {
    parentSessionId: 'p', childSessionId: 'c', status: 'ok',
    childEvents: [], lastAssistantMessage: [],
  }
  const card = view.buildSubagentCard(doc, spec, {})
  assert.strictEqual(collectByClass(card, 'subagent-card-return').length, 0)
})
