// Unit tests for src/renderer/compare-history.js — B4 helpers.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const C = require('../src/renderer/compare-history.js')

test('extractText: scalar text wins', () => {
  assert.equal(C.extractText({ text: 'hello' }), 'hello')
})

test('extractText: v2 content blocks concatenated in order, non-text dropped', () => {
  const e = {
    content: [
      { type: 'text', text: 'foo' },
      { type: 'image', data: '...' },
      { type: 'text', text: ' bar' },
    ],
  }
  assert.equal(C.extractText(e), 'foo bar')
})

test('extractText: null/undefined/empty → empty string', () => {
  assert.equal(C.extractText(null), '')
  assert.equal(C.extractText(undefined), '')
  assert.equal(C.extractText({}), '')
})

test('findFirstUserMessage: v2 message/user with content block', () => {
  const events = [
    { type: 'session/start' },
    { type: 'message/user', content: [{ type: 'text', text: 'why?' }] },
    { type: 'message/assistant', content: [{ type: 'text', text: 'because.' }] },
  ]
  const hit = C.findFirstUserMessage(events)
  assert.ok(hit)
  assert.equal(hit.text, 'why?')
  assert.equal(hit.index, 1)
})

test('findFirstUserMessage: legacy user/message with scalar text', () => {
  const events = [
    { kind: 'user/message', text: 'legacy' },
  ]
  const hit = C.findFirstUserMessage(events)
  assert.ok(hit)
  assert.equal(hit.text, 'legacy')
})

test('findFirstUserMessage: returns first, not last', () => {
  const events = [
    { type: 'message/user', text: 'first' },
    { type: 'message/user', text: 'second' },
  ]
  const hit = C.findFirstUserMessage(events)
  assert.equal(hit.text, 'first')
  assert.equal(hit.index, 0)
})

test('findFirstUserMessage: empty content skipped, next real user message wins', () => {
  const events = [
    { type: 'message/user', content: [] },
    { type: 'message/user', text: 'the real one' },
  ]
  const hit = C.findFirstUserMessage(events)
  assert.equal(hit.text, 'the real one')
})

test('findFirstUserMessage: no user message → null', () => {
  const events = [
    { type: 'message/assistant', text: 'hi' },
    { type: 'tool/call' },
  ]
  assert.equal(C.findFirstUserMessage(events), null)
})

test('findFirstUserMessage: non-array input → null', () => {
  assert.equal(C.findFirstUserMessage(null), null)
  assert.equal(C.findFirstUserMessage(undefined), null)
  assert.equal(C.findFirstUserMessage({}), null)
})

test('normaliseEventsResponse: plain array passthrough (fresh copy)', () => {
  const src = [{ type: 'x' }]
  const out = C.normaliseEventsResponse(src)
  assert.deepEqual(out, src)
  assert.notEqual(out, src) // must be a new array so mutation on either side is safe
})

test('normaliseEventsResponse: v2 wire shape', () => {
  const out = C.normaliseEventsResponse({ events: [{ type: 'a' }, { type: 'b' }] })
  assert.equal(out.length, 2)
  assert.equal(out[0].type, 'a')
})

test('normaliseEventsResponse: legacy items shape', () => {
  const out = C.normaliseEventsResponse({ items: [{ type: 'z' }] })
  assert.equal(out.length, 1)
  assert.equal(out[0].type, 'z')
})

test('normaliseEventsResponse: null/undefined/unknown → empty array', () => {
  assert.deepEqual(C.normaliseEventsResponse(null), [])
  assert.deepEqual(C.normaliseEventsResponse(undefined), [])
  assert.deepEqual(C.normaliseEventsResponse({ foo: 'bar' }), [])
})
