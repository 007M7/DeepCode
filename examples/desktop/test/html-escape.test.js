'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

// html-escape.js is an IIFE that installs itself on `module.exports` for
// the node consumers below and on `window.__dshHtmlEscape` at runtime.
const { escapeHtml, escapeAttr } = require('../src/renderer/html-escape.js')

test('escapeHtml escapes all five OWASP characters', () => {
  const raw = `&<>"'`
  assert.equal(escapeHtml(raw), '&amp;&lt;&gt;&quot;&#39;')
})

test('escapeHtml is idempotent-safe on already-escaped input', () => {
  // We do not double-decode; & → &amp; regardless. This documents that
  // callers who want to re-render must decode first.
  assert.equal(escapeHtml('&amp;'), '&amp;amp;')
})

test('escapeHtml coerces non-string input to string first', () => {
  assert.equal(escapeHtml(42), '42')
  assert.equal(escapeHtml(null), 'null')
  assert.equal(escapeHtml(undefined), 'undefined')
})

test('escapeAttr is an alias for escapeHtml (covers single quotes for single-quoted attrs)', () => {
  const raw = `O'Brien "quoted" & <html>`
  assert.equal(escapeAttr(raw), escapeHtml(raw))
  assert.ok(escapeAttr(raw).includes('&#39;'), "single quote must be escaped for single-quoted attrs")
})

test('escapeHtml leaves neutral text untouched', () => {
  assert.equal(escapeHtml('hello world 123'), 'hello world 123')
})
