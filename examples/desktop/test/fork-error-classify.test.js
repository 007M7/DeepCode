// Pins the main-side SessionForkError message classifier and asserts it
// agrees with the renderer's classifier on the same message. Divergence
// would mean the shell reports a different code than the renderer's system
// line ends up showing — worse than not classifying at all.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { classifyForkErrorMessage } = require('../src/main/fork-error-classify.js')
const { loadRenderer } = require('./renderer-harness.js')

// Fixture messages sampled from the exact throw sites in
// packages/core/session/src/index.ts on the integration worktree
// (2026-07-16). The wire flattens SessionForkError into -32603 with the
// message verbatim, so this fixture is what we'd actually see on the shell
// side. When the kernel rewords a message, update both classifiers together.
const CASES = [
  {
    msg: 'fork boundary 12 in session "abc" must be turn/end, got assistant/message',
    code: 'OPEN_TURN',
  },
  {
    msg: 'fork boundary for session "x" must be a non-negative safe integer, got NaN',
    code: 'INVALID_BOUNDARY',
  },
  {
    msg: 'fork boundary 999 does not exist in session "x" (last seq: 42)',
    code: 'INVALID_BOUNDARY',
  },
  {
    msg: 'fork boundary 5 does not match a contiguous event seq in session "x"',
    code: 'INVALID_BOUNDARY',
  },
  {
    msg: 'session "abc" is not the live store instance',
    code: 'SESSION_NOT_LIVE',
  },
  {
    msg: 'session "abc" not found',
    code: 'SESSION_NOT_FOUND',
  },
  {
    msg: 'session "abc-fork-1" already exists',
    code: 'SESSION_ALREADY_EXISTS',
  },
]

test('classifyForkErrorMessage pins each SessionForkError throw site to its code', () => {
  for (const { msg, code } of CASES) {
    assert.equal(classifyForkErrorMessage(msg), code, msg)
  }
})

test('unknown / empty / non-string messages return null (main.js falls through to mock)', () => {
  assert.equal(classifyForkErrorMessage(''), null)
  assert.equal(classifyForkErrorMessage(undefined), null)
  assert.equal(classifyForkErrorMessage(null), null)
  assert.equal(classifyForkErrorMessage(42), null)
  assert.equal(classifyForkErrorMessage('method not found: session/fork'), null)
  assert.equal(classifyForkErrorMessage('unknown session: abc'), null)
})

test('main-side and renderer-side classifiers agree on every kernel message', async () => {
  const { window } = await loadRenderer()
  const { classifyForkError } = window.__dshRenderer
  for (const { msg, code } of CASES) {
    const rendererCode = classifyForkError(new Error(msg)).code
    const mainCode = classifyForkErrorMessage(msg)
    assert.equal(rendererCode, code, `renderer: ${msg}`)
    assert.equal(mainCode, code, `main: ${msg}`)
    assert.equal(rendererCode, mainCode, `agreement: ${msg}`)
  }
})
