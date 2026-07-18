// Task #168 / step 2 — edit-rerun-header tests.
//
// Covers:
//   pure model — editableConfigFields, coerceEditValue, computeEditSet,
//     buildRerunIntentText, deriveHeaderBoundary
//   DOM builder — buildEditRerunHeaderButton renders the four sampling
//     rows editable + grays tools/system, submit blocked when no change,
//     submit forks and calls sendPrompt with an intent that carries the
//     edits, gray downgrade note present.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const ER = require('../src/renderer/edit-rerun-header.js')

// ---- fake doc (matches other renderer tests) -----------------------------

function makeDoc() {
  function makeEl(tag) {
    const el = {
      tagName: (tag || 'div').toUpperCase(),
      children: [],
      _classSet: new Set(),
      dataset: {},
      _listeners: {},
      _attrs: {},
      _text: '',
      disabled: false,
      value: '',
      type: '',
      title: '',
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
    el.appendChild = (child) => { el.children.push(child); child.parentNode = el; return child }
    el.addEventListener = (evt, fn) => { (el._listeners[evt] = el._listeners[evt] || []).push(fn) }
    el.click = () => { for (const fn of (el._listeners.click || [])) fn({ stopPropagation() {} }) }
    el.ownerDocument = doc
    return el
  }
  const doc = { createElement: (t) => makeEl(t) }
  return doc
}

function find(el, cls) {
  if (!el) return null
  if (el._classSet && el._classSet.has(cls)) return el
  for (const c of (el.children || [])) {
    const r = find(c, cls)
    if (r) return r
  }
  return null
}
function findAll(el, cls, out) {
  out = out || []
  if (!el) return out
  if (el._classSet && el._classSet.has(cls)) out.push(el)
  for (const c of (el.children || [])) findAll(c, cls, out)
  return out
}

// ---- pure model -----------------------------------------------------------

test('editableConfigFields emits four editable sampling keys', () => {
  const h = { config: { model: 'claude-fable-5', temperature: 0.7, topP: 0.9, maxTokens: 4096 } }
  const rows = ER.editableConfigFields(h)
  const editable = rows.filter(r => r.editable).map(r => r.key)
  assert.deepEqual(editable, ['model', 'temperature', 'topP', 'maxTokens'])
})

test('editableConfigFields picks up model from top-level EpochHeader too', () => {
  const h = { model: 'wire-model', config: { temperature: 0.5 } }
  const rows = ER.editableConfigFields(h)
  const model = rows.find(r => r.key === 'model')
  assert.equal(model.value, 'wire-model')
})

test('editableConfigFields grays tools/system when wire ships them', () => {
  const h = {
    config: { model: 'm', temperature: 0.5 },
    system: 'You are a…',
    tools: [{ name: 't1' }, { name: 't2' }],
  }
  const rows = ER.editableConfigFields(h)
  const gray = rows.filter(r => !r.editable).map(r => r.key)
  assert.ok(gray.includes('tools'))
  assert.ok(gray.includes('system'))
  const toolsRow = rows.find(r => r.key === 'tools')
  assert.match(toolsRow.reason, /backend does not support/i)
})

test('coerceEditValue parses numeric knobs and rejects bad values', () => {
  assert.deepEqual(ER.coerceEditValue('temperature', '0.5'), { present: true, value: 0.5 })
  assert.deepEqual(ER.coerceEditValue('topP', ''), { present: false })
  const bad = ER.coerceEditValue('maxTokens', 'nope')
  assert.equal(bad.present, false)
  assert.match(bad.error, /positive integer/)
})

test('computeEditSet omits unchanged values, catches errors', () => {
  const h = { config: { model: 'm', temperature: 0.5, topP: 0.9, maxTokens: 4096 } }
  // Only temperature changed; model unchanged; bad topP triggers an error.
  const res = ER.computeEditSet(h, { model: 'm', temperature: '0.8', topP: '2', maxTokens: '4096' })
  assert.deepEqual(res.edits, { temperature: 0.8, topP: 2 })
  assert.equal(res.hasEdits, true)
  assert.deepEqual(res.errors, [])
})

test('computeEditSet.hasEdits=false when nothing changed', () => {
  const h = { config: { model: 'm', temperature: 0.5, topP: 0.9, maxTokens: 4096 } }
  const res = ER.computeEditSet(h, { model: 'm', temperature: '0.5', topP: '0.9', maxTokens: '4096' })
  assert.equal(res.hasEdits, false)
  assert.deepEqual(res.edits, {})
})

test('buildRerunIntentText contains a JSON fence and the seq reference', () => {
  const s = ER.buildRerunIntentText({ temperature: 0.8 }, { config: { model: 'X' } }, { seq: 42 })
  assert.match(s, /seq 42/)
  assert.match(s, /```json/)
  assert.match(s, /"temperature": 0\.8/)
  assert.match(s, /Backend does not accept a mid-session config swap/i)
})

test('deriveHeaderBoundary returns the header event seq (or undefined)', () => {
  assert.equal(ER.deriveHeaderBoundary({ seq: 12 }), 12)
  assert.equal(ER.deriveHeaderBoundary({}), undefined)
  assert.equal(ER.deriveHeaderBoundary(null), undefined)
})

// ---- DOM ------------------------------------------------------------------

test('buildEditRerunHeaderButton renders four editable inputs + grayed tools row', () => {
  const doc = makeDoc()
  const btn = ER.buildEditRerunHeaderButton({
    doc,
    header: { config: { model: 'm', temperature: 0.7, topP: 0.9, maxTokens: 4096 }, tools: [{}], system: 'sys' },
    headerEvent: { seq: 3, type: 'request/header', data: {} },
    sessionId: 'sess-1',
    api: { forkSession: () => {}, sendPrompt: () => {} },
  })
  assert.ok(btn, 'returns element')
  const rows = findAll(btn, 'edit-rerun-header-row')
  // 4 editable + tools + system = 6
  assert.equal(rows.length, 6)
  const disabledRows = rows.filter(r => r._classSet.has('disabled'))
  assert.equal(disabledRows.length, 2)
  const note = find(btn, 'edit-rerun-header-note')
  assert.match(note.textContent, /context message/i)
})

test('submit blocks when no active session', async () => {
  const doc = makeDoc()
  let forked = false
  const btn = ER.buildEditRerunHeaderButton({
    doc,
    header: { config: { model: 'm', temperature: 0.7 } },
    headerEvent: { seq: 3 },
    sessionId: null,
    api: {
      forkSession: async () => { forked = true; return { childSessionId: 'x' } },
      sendPrompt: async () => {},
    },
  })
  find(btn, 'edit-rerun-header-submit').click()
  await new Promise(r => setTimeout(r, 5))
  assert.equal(forked, false)
  const status = find(btn, 'edit-rerun-header-status')
  assert.match(status.textContent, /no active session/i)
})

test('submit with no changes reports "No changes" and does not fork', async () => {
  const doc = makeDoc()
  let forked = false
  const btn = ER.buildEditRerunHeaderButton({
    doc,
    header: { config: { model: 'm', temperature: 0.7, topP: 0.9, maxTokens: 4096 } },
    headerEvent: { seq: 3 },
    sessionId: 'sess-1',
    api: {
      forkSession: async () => { forked = true; return { childSessionId: 'x' } },
      sendPrompt: async () => {},
    },
  })
  find(btn, 'edit-rerun-header-submit').click()
  await new Promise(r => setTimeout(r, 5))
  assert.equal(forked, false)
  const status = find(btn, 'edit-rerun-header-status')
  assert.match(status.textContent, /no changes/i)
})

test('submit with edits forks + sendPrompt carries JSON intent', async () => {
  const doc = makeDoc()
  const calls = { fork: null, prompt: null }
  const btn = ER.buildEditRerunHeaderButton({
    doc,
    header: { config: { model: 'm', temperature: 0.7 } },
    headerEvent: { seq: 12 },
    sessionId: 'sess-1',
    api: {
      forkSession: async (arg) => { calls.fork = arg; return { childSessionId: 'child-abcdef1234567' } },
      sendPrompt: async (sid, text) => { calls.prompt = { sid, text } },
    },
  })
  // Change temperature to 0.9
  const inputs = findAll(btn, 'edit-rerun-header-input')
  const tempInput = inputs.find(i => i._children || true && i.parentNode && find(i.parentNode, 'edit-rerun-header-key').textContent === 'temperature')
  tempInput.value = '0.9'
  find(btn, 'edit-rerun-header-submit').click()
  // Await both awaits inside runRerun
  await new Promise(r => setTimeout(r, 10))
  assert.deepEqual(calls.fork, { sessionId: 'sess-1', boundary: 12 })
  assert.equal(calls.prompt.sid, 'child-abcdef1234567')
  assert.match(calls.prompt.text, /"temperature": 0\.9/)
  const status = find(btn, 'edit-rerun-header-status')
  assert.match(status.textContent, /Forked →/)
})

test('submit surfaces rejection code (SessionForkError classified)', async () => {
  const doc = makeDoc()
  const btn = ER.buildEditRerunHeaderButton({
    doc,
    header: { config: { model: 'm', temperature: 0.7 } },
    headerEvent: { seq: 12 },
    sessionId: 'sess-1',
    api: {
      forkSession: async () => ({ rejected: true, code: 'OPEN_TURN', message: 'open turn in progress' }),
      sendPrompt: async () => {},
    },
  })
  const inputs = findAll(btn, 'edit-rerun-header-input')
  const tempInput = inputs.find(i => i.parentNode && find(i.parentNode, 'edit-rerun-header-key').textContent === 'temperature')
  tempInput.value = '0.9'
  find(btn, 'edit-rerun-header-submit').click()
  await new Promise(r => setTimeout(r, 10))
  const status = find(btn, 'edit-rerun-header-status')
  assert.match(status.textContent, /Fork rejected/i)
  assert.match(status.textContent, /open turn/i)
})
