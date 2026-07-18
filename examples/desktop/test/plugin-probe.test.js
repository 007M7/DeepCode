// Unit tests for src/main/plugin-probe.js. The pure parts — pattern
// matching, anchor-to-row — are covered here; the full boot path is
// exercised by the README manual verification (booting a daemon in a
// unit-test loop is flaky enough that the smoke script is the right
// venue).

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const P = require('../src/main/plugin-probe.js')

test('parseFailLoudLines: recognises missing-module errors', () => {
  const stderr = [
    'ready',
    "Error: Cannot find module '@deepseek-ai/dsh-does-not-exist'",
    "  at ...",
  ].join('\n')
  const findings = P.parseFailLoudLines(stderr)
  const match = findings.find((f) => f.kind === 'package')
  assert.ok(match)
  assert.equal(match.value, '@deepseek-ai/dsh-does-not-exist')
})

test('parseFailLoudLines: recognises plugin failed-to-load', () => {
  const stderr = 'plugin "session-query" failed to load: something'
  const findings = P.parseFailLoudLines(stderr)
  const match = findings.find((f) => f.kind === 'id')
  assert.ok(match)
  assert.equal(match.value, 'session-query')
})

test('parseFailLoudLines: recognises service-not-found', () => {
  const stderr = 'Error: service "sessionQuery" not found for daemon-agent'
  const findings = P.parseFailLoudLines(stderr)
  const match = findings.find((f) => f.kind === 'service')
  assert.ok(match)
  assert.equal(match.value, 'sessionQuery')
})

test('parseFailLoudLines: catchall keeps error-ish lines even without a pattern hit', () => {
  const stderr = 'random error line about something else'
  const findings = P.parseFailLoudLines(stderr)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].kind, 'unknown')
  assert.equal(findings[0].value, null)
})

test('parseFailLoudLines: empty input → empty findings', () => {
  assert.deepEqual(P.parseFailLoudLines(''), [])
  assert.deepEqual(P.parseFailLoudLines(null), [])
})

test('anchorFindings: package-kind matches by name to a base entry', () => {
  const baseEntries = [
    { id: 'bash', name: '@deepseek-ai/dsh-bash-local' },
    { id: 'fs', name: '@deepseek-ai/dsh-fs-local' },
  ]
  const findings = [{ kind: 'package', value: '@deepseek-ai/dsh-bash-local', message: 'Cannot find module …' }]
  const diags = P.anchorFindings(findings, baseEntries, [])
  assert.equal(diags.length, 1)
  assert.equal(diags[0].scope, 'entry')
  assert.equal(diags[0].id, 'bash')
  assert.match(diags[0].message, /Cannot find module/)
})

test('anchorFindings: id-kind matches to an overlay patch that introduces a new entry', () => {
  const findings = [{ kind: 'id', value: 'custom', message: 'plugin "custom" failed to load' }]
  const overlay = [{ id: 'custom', name: '@x/y' }]
  const diags = P.anchorFindings(findings, [], overlay)
  assert.equal(diags[0].id, 'custom')
  assert.equal(diags[0].scope, 'entry')
})

test('anchorFindings: unknown findings fall through to overall diagnostics', () => {
  const findings = [{ kind: 'unknown', value: null, message: 'something bad happened' }]
  const diags = P.anchorFindings(findings, [], [])
  assert.equal(diags[0].scope, 'overall')
  assert.match(diags[0].message, /something bad happened/)
})
