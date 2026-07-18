// Task #168 / step 3 — tool-edit-rerun tests.
//
// Covers:
//   pure model — parseArgsForEdit, coerceEditedArgs, computeToolEdit,
//     buildToolRerunIntentText, deriveToolBoundary
//   DOM builder — attachToolEditRerun mounts trigger + panel, submit
//     blocks without a session / with no changes / with bad JSON, submit
//     with edits calls forkSession with {sessionId, boundary} and
//     sendPrompt carries a JSON intent, rejection surfaces the code.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const TER = require('../src/renderer/tool-edit-rerun.js')

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
      _value: '',
      disabled: false,
      hidden: false,
      rows: 0,
      spellcheck: true,
      title: '',
      open: false,
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
    Object.defineProperty(el, 'value', {
      get() { return this._value },
      set(v) { this._value = String(v == null ? '' : v) },
    })
    el.classList = {
      add: (c) => el._classSet.add(c),
      remove: (c) => el._classSet.delete(c),
      contains: (c) => el._classSet.has(c),
    }
    el.setAttribute = (k, v) => { el._attrs[k] = String(v) }
    el.getAttribute = (k) => (k in el._attrs ? el._attrs[k] : null)
    el.appendChild = (child) => {
      // Detach from previous parent.
      if (child.parentNode) {
        const idx = child.parentNode.children.indexOf(child)
        if (idx >= 0) child.parentNode.children.splice(idx, 1)
      }
      el.children.push(child); child.parentNode = el; return child
    }
    el.insertBefore = (child, ref) => {
      if (child.parentNode) {
        const idx = child.parentNode.children.indexOf(child)
        if (idx >= 0) child.parentNode.children.splice(idx, 1)
      }
      const idx = el.children.indexOf(ref)
      if (idx < 0) el.children.push(child)
      else el.children.splice(idx, 0, child)
      child.parentNode = el
      return child
    }
    el.querySelector = (sel) => {
      const cls = sel.startsWith('.') ? sel.slice(1) : null
      if (!cls) return null
      return find(el, cls)
    }
    el.addEventListener = (evt, fn) => { (el._listeners[evt] = el._listeners[evt] || []).push(fn) }
    el.click = () => { for (const fn of (el._listeners.click || [])) fn({ stopPropagation() {} }) }
    el.focus = () => {}
    Object.defineProperty(el, 'nextSibling', {
      get() {
        if (!el.parentNode) return null
        const idx = el.parentNode.children.indexOf(el)
        return idx >= 0 && idx + 1 < el.parentNode.children.length ? el.parentNode.children[idx + 1] : null
      },
    })
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

function makeToolBlock(doc) {
  const details = doc.createElement('details')
  details.open = false
  const summary = doc.createElement('summary')
  details.appendChild(summary)
  const argLabel = doc.createElement('div')
  argLabel.className = 'label'
  argLabel.textContent = 'args'
  details.appendChild(argLabel)
  const argsBox = doc.createElement('div')
  argsBox.className = 'args'
  argsBox.textContent = '(args body)'
  details.appendChild(argsBox)
  const resLabel = doc.createElement('div')
  resLabel.className = 'label'
  resLabel.textContent = 'result'
  details.appendChild(resLabel)
  const resBox = doc.createElement('div')
  resBox.className = 'result'
  details.appendChild(resBox)
  return details
}

// ---- pure model -----------------------------------------------------------

test('parseArgsForEdit pretty-prints JSON string args', () => {
  const out = TER.parseArgsForEdit('{"command":"echo hi"}')
  assert.match(out.parsed, /"command": "echo hi"/)
})

test('parseArgsForEdit keeps non-JSON strings verbatim', () => {
  const out = TER.parseArgsForEdit('rm -rf /tmp/foo')
  assert.equal(out.parsed, 'rm -rf /tmp/foo')
})

test('parseArgsForEdit pretty-prints object args', () => {
  const out = TER.parseArgsForEdit({ path: 'src/x.ts' })
  assert.match(out.parsed, /"path": "src\/x\.ts"/)
})

test('coerceEditedArgs rejects empty + bad JSON', () => {
  assert.match(TER.coerceEditedArgs('   ').error, /empty/i)
  assert.match(TER.coerceEditedArgs('{bad json').error, /Invalid JSON/)
})

test('coerceEditedArgs parses good JSON', () => {
  const out = TER.coerceEditedArgs('{"a": 1}')
  assert.deepEqual(out.value, { a: 1 })
})

test('computeToolEdit detects no-change vs change via canonicalisation', () => {
  const same = TER.computeToolEdit('{"a":1,"b":2}', '{ "b": 2, "a": 1 }')
  assert.equal(same.hasEdits, false)
  const diff = TER.computeToolEdit('{"a":1}', '{"a":2}')
  assert.equal(diff.hasEdits, true)
  assert.deepEqual(diff.newArgs, { a: 2 })
})

test('computeToolEdit surfaces JSON errors', () => {
  const err = TER.computeToolEdit('{"a":1}', '{bad')
  assert.equal(err.hasEdits, false)
  assert.match(err.error, /Invalid JSON/)
})

test('buildToolRerunIntentText names tool + old/new fences + downgrade note', () => {
  const s = TER.buildToolRerunIntentText({
    callId: 'call-42', name: 'bash', seq: 17,
    oldArgs: { command: 'ls' }, newArgs: { command: 'ls -la' },
  })
  assert.match(s, /Tool "bash"/)
  assert.match(s, /callId call-42/)
  assert.match(s, /seq 17/)
  assert.match(s, /"command": "ls"/)
  assert.match(s, /"command": "ls -la"/)
  assert.match(s, /Backend does not rewrite historical tool arguments/i)
})

test('deriveToolBoundary returns seq or undefined', () => {
  assert.equal(TER.deriveToolBoundary({ seq: 5 }), 5)
  assert.equal(TER.deriveToolBoundary({}), undefined)
  assert.equal(TER.deriveToolBoundary(null), undefined)
})

// ---- DOM ------------------------------------------------------------------

test('attachToolEditRerun inserts trigger on summary and hidden panel after args', () => {
  const doc = makeDoc()
  const block = makeToolBlock(doc)
  const ret = TER.attachToolEditRerun(block, {
    doc,
    callId: 'c1', name: 'bash', args: '{"command":"ls"}', seq: 3,
    sessionId: 'sess-1',
    api: { forkSession: async () => ({}), sendPrompt: async () => {} },
  })
  assert.ok(ret, 'returns handle')
  assert.ok(ret.trigger, 'trigger present')
  assert.ok(ret.panel.hidden, 'panel starts hidden')
  const summary = block.children[0]
  assert.ok(summary.children.includes(ret.trigger), 'trigger on summary')
  // Panel sits immediately after .args (index of .args + 1).
  const argsIdx = block.children.findIndex(c => c._classSet && c._classSet.has('args'))
  const panelIdx = block.children.findIndex(c => c._classSet && c._classSet.has('tool-edit-rerun-panel'))
  assert.equal(panelIdx, argsIdx + 1)
})

test('trigger click opens the tool block and reveals the panel', () => {
  const doc = makeDoc()
  const block = makeToolBlock(doc)
  const ret = TER.attachToolEditRerun(block, {
    doc, callId: 'c1', name: 'bash', args: '{"command":"ls"}', seq: 3,
    sessionId: 'sess-1',
    api: { forkSession: async () => ({}), sendPrompt: async () => {} },
  })
  assert.equal(block.open, false)
  ret.trigger.click()
  assert.equal(block.open, true, 'block force-opened')
  assert.equal(ret.panel.hidden, false, 'panel shown')
  ret.trigger.click()
  assert.equal(ret.panel.hidden, true, 'toggled off on second click')
})

test('submit without session reports and does not fork', async () => {
  const doc = makeDoc()
  const block = makeToolBlock(doc)
  let forked = false
  const ret = TER.attachToolEditRerun(block, {
    doc, callId: 'c1', name: 'bash', args: '{"command":"ls"}', seq: 3,
    sessionId: null,
    api: { forkSession: async () => { forked = true; return {} }, sendPrompt: async () => {} },
  })
  ret.submit.click()
  await new Promise(r => setTimeout(r, 5))
  assert.equal(forked, false)
  assert.match(ret.status.textContent, /no active session/i)
})

test('submit with no changes reports and does not fork', async () => {
  const doc = makeDoc()
  const block = makeToolBlock(doc)
  let forked = false
  const ret = TER.attachToolEditRerun(block, {
    doc, callId: 'c1', name: 'bash', args: '{"command":"ls"}', seq: 3,
    sessionId: 'sess-1',
    api: { forkSession: async () => { forked = true; return {} }, sendPrompt: async () => {} },
  })
  // textarea seeded from parseArgsForEdit → same canonical form.
  ret.submit.click()
  await new Promise(r => setTimeout(r, 5))
  assert.equal(forked, false)
  assert.match(ret.status.textContent, /no changes/i)
})

test('submit with bad JSON surfaces the parse error', async () => {
  const doc = makeDoc()
  const block = makeToolBlock(doc)
  const ret = TER.attachToolEditRerun(block, {
    doc, callId: 'c1', name: 'bash', args: '{"command":"ls"}', seq: 3,
    sessionId: 'sess-1',
    api: { forkSession: async () => ({}), sendPrompt: async () => {} },
  })
  ret.textarea.value = '{bad json'
  ret.submit.click()
  await new Promise(r => setTimeout(r, 5))
  assert.match(ret.status.textContent, /Invalid JSON/)
})

test('submit with edits forks at seq and sendPrompt carries JSON intent', async () => {
  const doc = makeDoc()
  const block = makeToolBlock(doc)
  const calls = { fork: null, prompt: null }
  const ret = TER.attachToolEditRerun(block, {
    doc, callId: 'call-42', name: 'bash', args: '{"command":"ls"}', seq: 17,
    sessionId: 'sess-1',
    api: {
      forkSession: async (arg) => { calls.fork = arg; return { childSessionId: 'child-abcdef1234' } },
      sendPrompt: async (sid, text) => { calls.prompt = { sid, text } },
    },
  })
  ret.textarea.value = '{"command": "ls -la"}'
  ret.submit.click()
  await new Promise(r => setTimeout(r, 10))
  assert.deepEqual(calls.fork, { sessionId: 'sess-1', boundary: 17 })
  assert.equal(calls.prompt.sid, 'child-abcdef1234')
  assert.match(calls.prompt.text, /Tool "bash"/)
  assert.match(calls.prompt.text, /"command": "ls -la"/)
  assert.match(ret.status.textContent, /Forked →/)
})

test('submit surfaces rejection code (SessionForkError classified)', async () => {
  const doc = makeDoc()
  const block = makeToolBlock(doc)
  const ret = TER.attachToolEditRerun(block, {
    doc, callId: 'c1', name: 'bash', args: '{"command":"ls"}', seq: 3,
    sessionId: 'sess-1',
    api: {
      forkSession: async () => ({ rejected: true, code: 'OPEN_TURN', message: 'open turn in progress' }),
      sendPrompt: async () => {},
    },
  })
  ret.textarea.value = '{"command": "ls -la"}'
  ret.submit.click()
  await new Promise(r => setTimeout(r, 10))
  assert.match(ret.status.textContent, /Fork rejected/i)
  assert.match(ret.status.textContent, /open turn/i)
})

test('when seq is omitted, forkSession is called without boundary', async () => {
  const doc = makeDoc()
  const block = makeToolBlock(doc)
  const calls = { fork: null }
  const ret = TER.attachToolEditRerun(block, {
    doc, callId: 'c1', name: 'bash', args: '{"command":"ls"}',
    sessionId: 'sess-1',
    api: {
      forkSession: async (arg) => { calls.fork = arg; return { childSessionId: 'child-xxx' } },
      sendPrompt: async () => {},
    },
  })
  ret.textarea.value = '{"command":"ls -la"}'
  ret.submit.click()
  await new Promise(r => setTimeout(r, 10))
  assert.deepEqual(calls.fork, { sessionId: 'sess-1' })
})
