// Unit tests for the pure layout-hint engine. Runs under `node --test`.
// The module has no DOM/protocol/timer dependency, so we hand it plain
// SessionEvent fixtures and assert on the returned hint.
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  classifyTool,
  signalsFromEvent,
  aggregate,
  computeHint,
  LayoutHintTracker,
  LAYOUTS,
} = require('../src/renderer/layout-heuristics.js')

// -- fixtures ---------------------------------------------------------------

let seq = 0
let now = 1_000_000
function toolCall(name) {
  return { type: 'tool/call', seq: seq++, time: now++, data: { name, callId: `c${seq}` } }
}
function toolResult({ meta } = {}) {
  return {
    type: 'tool/result', seq: seq++, time: now++,
    data: { callId: `c${seq}`, content: [{ type: 'text', text: 'ok' }], isError: false, meta },
  }
}
function chunk(kind, text) {
  return {
    type: 'assistant/chunk', seq: seq++, time: now++,
    data: { chunk: { type: kind + '-delta', text } },
  }
}
function turnStart() { return { type: 'turn/start', seq: seq++, time: now++, data: {} } }
function turnEnd()   { return { type: 'turn/end',   seq: seq++, time: now++, data: {} } }

// -- classifyTool -----------------------------------------------------------

test('classifyTool buckets common tool names', () => {
  assert.equal(classifyTool('edit_file'), 'diff')
  assert.equal(classifyTool('str_replace_editor'), 'diff')
  assert.equal(classifyTool('apply_patch'), 'diff')
  assert.equal(classifyTool('MultiEdit'), 'diff')
  assert.equal(classifyTool('write'), 'diff')
  assert.equal(classifyTool('bash'), 'bash')
  assert.equal(classifyTool('run_command'), 'bash')
  assert.equal(classifyTool('shell'), 'bash')
  assert.equal(classifyTool('artifact.create'), 'artifact')
  assert.equal(classifyTool('show_artifact'), 'artifact')
  assert.equal(classifyTool('read_file'), 'other')
  assert.equal(classifyTool(''), null)
  assert.equal(classifyTool(undefined), null)
})

// -- signalsFromEvent -------------------------------------------------------

test('signalsFromEvent maps only the events layouts care about', () => {
  assert.equal(signalsFromEvent(null), null)
  assert.equal(signalsFromEvent({ type: 'step/start' }), null)
  assert.equal(signalsFromEvent({ type: 'request/header' }), null)
  const s1 = signalsFromEvent(toolCall('edit_file'))
  assert.equal(s1.kind, 'tool')
  assert.equal(s1.tool, 'diff')
  const s2 = signalsFromEvent(chunk('reasoning', 'thinking about it'))
  assert.equal(s2.kind, 'reasoning')
  assert.equal(s2.charCount, 'thinking about it'.length)
  const artifactEv = toolResult({ meta: { card: 'artifact', artifact: { id: 'x' } } })
  const s3 = signalsFromEvent(artifactEv)
  assert.equal(s3.kind, 'tool')
  assert.equal(s3.tool, 'artifact')
})

// -- computeHint (pure) -----------------------------------------------------

test('computeHint returns chat for empty windows', () => {
  const empty = aggregate([])
  assert.equal(computeHint(empty, empty, {}), 'chat')
})

test('computeHint returns code-review when diff tools dominate the window', () => {
  const sigs = [
    signalsFromEvent(toolCall('edit_file')),
    signalsFromEvent(toolCall('edit_file')),
    signalsFromEvent(toolCall('apply_patch')),
    signalsFromEvent(toolCall('read_file')),
  ]
  assert.equal(computeHint(aggregate(sigs), aggregate(sigs), {}), 'code-review')
})

test('computeHint does NOT flip to code-review on a single edit', () => {
  const sigs = [
    signalsFromEvent(toolCall('edit_file')),
    signalsFromEvent(toolCall('read_file')),
    signalsFromEvent(toolCall('read_file')),
  ]
  assert.equal(computeHint(aggregate(sigs), aggregate(sigs), {}), 'chat')
})

test('computeHint returns monitor when bash is dense AND session is running', () => {
  const sigs = [
    signalsFromEvent(toolCall('bash')),
    signalsFromEvent(toolCall('bash')),
    signalsFromEvent(toolCall('shell')),
    signalsFromEvent(toolCall('read_file')),
  ]
  const full = aggregate(sigs)
  assert.equal(computeHint(full, full, { running: true }), 'monitor')
  // Same signal set without `running` and inside a short window stays chat.
  assert.equal(computeHint(full, full, { running: false }), 'chat')
})

test('computeHint prefers artifact over everything when the recent slice has one', () => {
  const sigs = [
    signalsFromEvent(toolCall('edit_file')),
    signalsFromEvent(toolCall('edit_file')),
    signalsFromEvent(toolCall('apply_patch')),
    signalsFromEvent(toolResult({ meta: { card: 'artifact' } })),
  ]
  const full = aggregate(sigs)
  const recent = aggregate(sigs.slice(-2))
  assert.equal(computeHint(full, recent, {}), 'artifact')
})

test('computeHint drops artifact once it ages out of the recent slice', () => {
  const sigs = [
    signalsFromEvent(toolResult({ meta: { card: 'artifact' } })),
    signalsFromEvent(toolCall('read_file')),
    signalsFromEvent(toolCall('read_file')),
    signalsFromEvent(toolCall('read_file')),
    signalsFromEvent(toolCall('read_file')),
  ]
  const full = aggregate(sigs)
  const recent = aggregate(sigs.slice(-3)) // artifact aged out
  assert.equal(computeHint(full, recent, {}), 'chat')
})

// -- LayoutHintTracker (debounce, lock, reset) ------------------------------

test('tracker sits on chat until N stable proposals promote a new hint', () => {
  const t = new LayoutHintTracker({ stability: 3 })
  // First diff tool: only 1 diff tool → doesn't meet diffToolsMin=2 yet, so
  // computeHint proposes chat. Candidate stays null.
  let r = t.push(toolCall('edit_file'))
  assert.equal(r.hint, 'chat')
  assert.equal(r.changed, false)
  // Second edit: diffTools=2, ratio=1 → proposal=code-review (candidate=1).
  r = t.push(toolCall('edit_file'))
  assert.equal(r.hint, 'chat')
  // Third: candidate=2.
  r = t.push(toolCall('apply_patch'))
  assert.equal(r.hint, 'chat')
  // Fourth: candidate=3 → promote.
  r = t.push(toolCall('edit_file'))
  assert.equal(r.hint, 'code-review')
  assert.equal(r.changed, true)
})

test('tracker debounce: a mixed jitter does NOT flip layouts', () => {
  const t = new LayoutHintTracker({ stability: 3 })
  // Alternating diff / non-diff — proposal never accumulates enough to fire.
  const events = [
    toolCall('edit_file'),
    toolCall('read_file'),
    toolCall('edit_file'),
    toolCall('read_file'),
  ]
  let lastHint = 'chat'
  for (const ev of events) lastHint = t.push(ev).hint
  assert.equal(lastHint, 'chat')
})

test('tracker manual lock wins over auto proposals', () => {
  const t = new LayoutHintTracker({ stability: 2 })
  t.lock('artifact')
  // A cascade of diff events would normally promote code-review after 2 samples.
  let r
  for (let i = 0; i < 5; i++) r = t.push(toolCall('edit_file'))
  assert.equal(r.hint, 'artifact')
  assert.equal(r.changed, false)
  // Unlock and let the queue resume; the accumulated diff signals still
  // satisfy the ratio, so the next diff event promotes on the second sample.
  t.unlock()
  t.push(toolCall('edit_file'))
  const after = t.push(toolCall('edit_file'))
  assert.equal(after.hint, 'code-review')
})

test('tracker reset clears the window (used when switching sessions)', () => {
  const t = new LayoutHintTracker({ stability: 2 })
  t.push(toolCall('edit_file'))
  t.push(toolCall('edit_file'))
  t.push(toolCall('edit_file'))  // promotes to code-review
  assert.equal(t.currentHint(), 'code-review')
  t.reset()
  assert.equal(t.currentHint(), 'chat')
})

test('tracker exposes only the four documented layouts', () => {
  assert.deepEqual([...LAYOUTS].sort(), ['artifact', 'chat', 'code-review', 'monitor'])
})

test('tracker.setMeta influences monitor gate (running=true relaxes windowSpan)', () => {
  const t = new LayoutHintTracker({ stability: 2 })
  t.setMeta({ running: true })
  // bashToolsMin=3, so the third push is the first that proposes monitor;
  // stability=2 needs one more of the same proposal to promote.
  t.push(toolCall('bash'))
  t.push(toolCall('bash'))
  t.push(toolCall('shell'))
  const r = t.push(toolCall('bash'))
  assert.equal(r.hint, 'monitor')
})

test('artifact hint has priority over code-review even mid-debounce', () => {
  const t = new LayoutHintTracker({ stability: 2 })
  // build up diff signal
  t.push(toolCall('edit_file'))
  t.push(toolCall('edit_file'))
  // then an artifact result appears — even without stability window growth
  // (artifact only needs 2 stable samples in the recent slice).
  t.push(toolResult({ meta: { card: 'artifact' } }))
  const r = t.push(toolResult({ meta: { card: 'artifact' } }))
  assert.equal(r.hint, 'artifact')
})
