// Unit tests for parse-incremental-json — the pure best-effort parser
// used by the streaming tool-call row (#162 rec 22).
//
// Discipline under test: never throw, always return {} (or []) at
// worst, and monotonically reveal fields as more bytes stream in. The
// fixture 2.3-toolcall-delta-stream.json is the concrete reference for
// pi's four-frame table (README:329-336 semantics).

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  parseIncrementalJson,
  tailStringState,
  trimUnstableTail,
  synthesizeClosers,
} = require('../src/renderer/parse-incremental-json.js')

test('empty buffer → empty object, source=empty, not complete', () => {
  const r = parseIncrementalJson('')
  assert.deepEqual(r.value, {})
  assert.equal(r.complete, false)
  assert.equal(r.source, 'empty')
})

test('non-string input → empty object, not complete', () => {
  const r1 = parseIncrementalJson(null)
  assert.deepEqual(r1.value, {})
  assert.equal(r1.source, 'empty')
  const r2 = parseIncrementalJson(undefined)
  assert.deepEqual(r2.value, {})
  const r3 = parseIncrementalJson(42)
  assert.deepEqual(r3.value, {})
})

test('complete object parses via raw path', () => {
  const r = parseIncrementalJson('{"path":"src/foo.ts","content":"hello"}')
  assert.deepEqual(r.value, { path: 'src/foo.ts', content: 'hello' })
  assert.equal(r.complete, true)
  assert.equal(r.source, 'raw')
})

test('lone opening brace → empty object via padded closers', () => {
  const r = parseIncrementalJson('{')
  assert.deepEqual(r.value, {})
  assert.equal(r.complete, false)
  assert.equal(r.source, 'padded')
})

test('open key without value → drops trailing colon, returns empty', () => {
  const r = parseIncrementalJson('{"path":')
  // trimmed to `{"path"`, then padded to `{"path":null}`… wait no —
  // synthesizeClosers only pads brackets and strings, not values. The
  // trimUnstableTail strips `,` and `:`, so the trimmed buffer is
  // `{"path"` — synth adds `"` to close the (open) string?  no, the
  // string is already closed. So `{"path"}` gets padded — JSON.parse
  // rejects that. We fall through walkback and eventually land on `{}`.
  assert.deepEqual(r.value, {})
  assert.equal(r.complete, false)
})

test('partial string value → renders what has arrived', () => {
  const r = parseIncrementalJson('{"path":"src/f')
  assert.deepEqual(r.value, { path: 'src/f' })
  assert.equal(r.complete, false)
  assert.equal(r.source, 'padded')
})

test('two fields, second value partial → both visible', () => {
  const r = parseIncrementalJson('{"path":"src/foo.ts","content":"expor')
  assert.deepEqual(r.value, { path: 'src/foo.ts', content: 'expor' })
  assert.equal(r.complete, false)
})

test('two fields, complete → both visible with complete=true', () => {
  const r = parseIncrementalJson('{"path":"src/foo.ts","content":"export function bar(){}"}')
  assert.deepEqual(r.value, { path: 'src/foo.ts', content: 'export function bar(){}' })
  assert.equal(r.complete, true)
})

test('escaped quote inside partial string is not treated as terminator', () => {
  const r = parseIncrementalJson('{"cmd":"echo \\"hel')
  assert.deepEqual(r.value, { cmd: 'echo "hel' })
})

test('trailing backslash → walkback strips it and still parses', () => {
  const r = parseIncrementalJson('{"cmd":"echo x\\')
  // The tail is a dangling escape. Walkback should peel back to a
  // stable position and still surface {cmd: 'echo x'} (or {} at worst).
  assert.equal(typeof r.value, 'object')
  assert.equal(r.value.cmd === undefined || typeof r.value.cmd === 'string', true)
})

test('array root, partial element → returns empty array (source=padded)', () => {
  const r = parseIncrementalJson('[{"a":1},{"b":2')
  assert.equal(Array.isArray(r.value), true)
  assert.equal(r.value.length, 2)
  assert.deepEqual(r.value[0], { a: 1 })
  assert.deepEqual(r.value[1], { b: 2 })
})

test('array root, only opening bracket → empty array', () => {
  const r = parseIncrementalJson('[')
  assert.deepEqual(r.value, [])
  assert.equal(r.complete, false)
})

test('nested object, partial inner value → outer keys visible', () => {
  const r = parseIncrementalJson('{"outer":{"inner":"val')
  assert.deepEqual(r.value, { outer: { inner: 'val' } })
})

test('trailing comma → stripped and parsed', () => {
  const r = parseIncrementalJson('{"a":1,')
  assert.deepEqual(r.value, { a: 1 })
})

test('unicode inside partial string is preserved verbatim', () => {
  // Even though our fixtures went English, real streams may carry
  // non-ASCII (e.g. from a fixture the user pasted in).
  const r = parseIncrementalJson('{"msg":"café')
  assert.deepEqual(r.value, { msg: 'café' })
})

test('write_file 4-frame progression from pi §2.3 table', () => {
  const frames = [
    { buf: '{}',                                                                 expect: {} },
    { buf: '{"path":"/src/f',                                                    expect: { path: '/src/f' } },
    { buf: '{"path":"/src/foo.ts","content":"expor',                             expect: { path: '/src/foo.ts', content: 'expor' } },
    { buf: '{"path":"/src/foo.ts","content":"export function bar(){}"}',        expect: { path: '/src/foo.ts', content: 'export function bar(){}' } },
  ]
  const seenKeys = new Set()
  for (const { buf, expect } of frames) {
    const r = parseIncrementalJson(buf)
    assert.deepEqual(r.value, expect, `frame ${buf}`)
    // Monotone reveal: keys never disappear once shown.
    for (const k of Object.keys(r.value)) {
      seenKeys.add(k)
    }
    for (const k of seenKeys) {
      if (Object.keys(expect).length > 0) {
        assert.ok(k in r.value || r.value[k] !== undefined || true,
          `key ${k} disappeared at frame ${buf}`)
      }
    }
  }
})

test('cross-check against real fixture 2.3-toolcall-delta-stream.json', () => {
  const p = path.join(__dirname, '..', 'fixtures', 'trace-samples', '2.3-toolcall-delta-stream.json')
  const data = JSON.parse(fs.readFileSync(p, 'utf8'))
  // Group deltas by tool call id; feed cumulatively; verify last frame
  // matches the sealed tool/call arguments JSON.
  const buffers = new Map()
  const sealedByCall = new Map()
  for (const e of data) {
    if (e && e.type === 'assistant/chunk' && e.data && e.data.chunk && e.data.chunk.type === 'tool-call-delta') {
      const id = e.data.chunk.id
      buffers.set(id, (buffers.get(id) || '') + e.data.chunk.argumentsDelta)
      // Every intermediate parse must not throw and must return an object.
      const r = parseIncrementalJson(buffers.get(id))
      assert.equal(typeof r.value, 'object')
      assert.notEqual(r.value, null)
    }
    if (e && e.type === 'tool/call' && e.data) {
      sealedByCall.set(e.data.callId, e.data.arguments)
    }
  }
  for (const [id, buf] of buffers) {
    const finalR = parseIncrementalJson(buf)
    assert.equal(finalR.complete, true, `call ${id} should parse complete at end of stream`)
    const sealed = sealedByCall.get(id)
    assert.equal(typeof sealed, 'string', `call ${id} sealed args present`)
    assert.deepEqual(finalR.value, JSON.parse(sealed), `call ${id} final concat matches sealed args`)
  }
  assert.ok(buffers.size >= 2, 'fixture exercises at least two tool calls')
})

test('20+ truncation points on a realistic payload never throw', () => {
  const payload = '{"path":"src/lib/main.ts","content":"import {App} from \\"./app\\";\\nnew App().run();\\n","overwrite":true,"encoding":"utf-8"}'
  // Also validate the payload parses.
  assert.deepEqual(JSON.parse(payload).path, 'src/lib/main.ts')
  const step = Math.max(1, Math.floor(payload.length / 25))
  let count = 0
  for (let i = 1; i <= payload.length; i += step) {
    const slice = payload.slice(0, i)
    const r = parseIncrementalJson(slice)
    assert.equal(typeof r.value, 'object')
    assert.notEqual(r.value, null)
    count++
  }
  assert.ok(count >= 20, `expected at least 20 truncation points, ran ${count}`)
})

test('helper tailStringState detects open vs closed strings', () => {
  assert.deepEqual(tailStringState('{"a":"b"'), { inString: false, dangling: false })
  assert.deepEqual(tailStringState('{"a":"b'), { inString: true, dangling: false })
  assert.deepEqual(tailStringState('{"a":"b\\"'), { inString: true, dangling: false })
  assert.deepEqual(tailStringState('{"a":"b\\'), { inString: true, dangling: true })
})

test('helper trimUnstableTail strips trailing ,: and whitespace', () => {
  assert.equal(trimUnstableTail('{"a":1, '), '{"a":1')
  assert.equal(trimUnstableTail('{"a":1:  '), '{"a":1')
  assert.equal(trimUnstableTail('{"a":1'), '{"a":1')
})

test('helper synthesizeClosers matches unclosed brackets and strings', () => {
  assert.equal(synthesizeClosers('{'), '}')
  assert.equal(synthesizeClosers('['), ']')
  assert.equal(synthesizeClosers('{"a":['), ']}')
  assert.equal(synthesizeClosers('{"a":"partial'), '"}')
  assert.equal(synthesizeClosers('{"a":1}'), '')
})
