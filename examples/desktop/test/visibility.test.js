// Unit tests for the pure visibility module (batch B of the P0 renderer audit).
// The DOM controller layer is exercised separately by the smoke run; here we
// pin the payload → view-model contract so the shell-side representation of
// each event stays right even as the wire shapes evolve.
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  foldTodoList,
  formatTurnEndReason,
  formatTurnEndLine,
  formatSessionFinishedLine,
  formatFinishReason,
  foldPromptBlocked,
  summarizeSubagentFinished,
  auditRowForApproval,
  classifyEvent,
  joinContentText,
} = require('../src/renderer/visibility.js')

// -- foldTodoList -----------------------------------------------------------

test('foldTodoList: happy path — all three statuses, order preserved', () => {
  const out = foldTodoList([
    { content: 'read spec',       status: 'completed'  },
    { content: 'draft impl',      status: 'in_progress'},
    { content: 'write tests',     status: 'pending'    },
    { content: 'ship it',         status: 'pending'    },
  ])
  assert.equal(out.items.length, 4)
  assert.deepEqual(out.items.map(i => i.content), [
    'read spec', 'draft impl', 'write tests', 'ship it',
  ])
  assert.equal(out.items[0].icon, '✓')
  assert.equal(out.items[1].icon, '⋯')
  assert.equal(out.items[2].icon, '·')
  assert.deepEqual(out.counts, { pending: 2, in_progress: 1, completed: 1, total: 4 })
  assert.deepEqual(out.warnings, [])
})

test('foldTodoList: whole-list replacement — a second call is independent', () => {
  const a = foldTodoList([
    { content: 'a', status: 'pending' },
    { content: 'b', status: 'pending' },
  ])
  const b = foldTodoList([
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'completed' },
    { content: 'c', status: 'pending' },
  ])
  assert.equal(a.items[0].status, 'pending')
  assert.equal(b.items[0].status, 'in_progress')
  assert.equal(b.items[1].status, 'completed')
  assert.equal(b.counts.total, 3)
})

test('foldTodoList: warns when >1 in_progress (tool invariant violated)', () => {
  const out = foldTodoList([
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'in_progress' },
  ])
  assert.equal(out.counts.in_progress, 2)
  assert.equal(out.warnings.length, 1)
  assert.match(out.warnings[0], /2 items in progress/)
})

test('foldTodoList: drops malformed rows with warnings, keeps the rest', () => {
  const out = foldTodoList([
    { content: 'ok', status: 'pending' },
    null,
    { content: '', status: 'pending' },                 // empty content
    { content: 'weird', status: 'blocked' },            // bad status
    { content: 42, status: 'pending' },                 // wrong content type
    { content: 'also ok', status: 'completed' },
  ])
  assert.deepEqual(out.items.map(i => i.content), ['ok', 'also ok'])
  assert.equal(out.warnings.length, 4)
})

test('foldTodoList: non-array payload → warning, empty items', () => {
  const out = foldTodoList(null)
  assert.deepEqual(out.items, [])
  assert.equal(out.warnings.length, 1)
})

// -- formatTurnEndReason ----------------------------------------------------

test('formatTurnEndReason: completed/interrupted/disposed → null (kind alone is enough)', () => {
  assert.equal(formatTurnEndReason({ kind: 'completed' }), null)
  assert.equal(formatTurnEndReason({ kind: 'interrupted' }), null)
  assert.equal(formatTurnEndReason({ kind: 'disposed' }), null)
})

test('formatTurnEndReason: error → detail with step + code, severity=error', () => {
  const r = formatTurnEndReason({ kind: 'error', step: 3, message: 'connection reset', code: 'ECONNRESET' })
  assert.deepEqual(r, { detail: 'error at step 3: connection reset [ECONNRESET]', severity: 'error' })
})

test('formatTurnEndReason: error without code + missing step still reads', () => {
  const r = formatTurnEndReason({ kind: 'error', message: 'boom' })
  assert.equal(r.severity, 'error')
  assert.equal(r.detail, 'error: boom')
})

test('formatTurnEndReason: max-tokens → warn, no field on payload', () => {
  const r = formatTurnEndReason({ kind: 'max-tokens' })
  assert.deepEqual(r, { detail: 'hit max tokens', severity: 'warn' })
})

test('formatTurnEndReason: rejected carries reason', () => {
  const r = formatTurnEndReason({ kind: 'rejected', reason: 'blocked by policy' })
  assert.deepEqual(r, { detail: 'rejected: blocked by policy', severity: 'warn' })
})

test('formatTurnEndReason: aborted with reason surfaces it; without reason → null', () => {
  const withReason = formatTurnEndReason({ kind: 'aborted', reason: 'user cancel' })
  assert.deepEqual(withReason, { detail: 'aborted: user cancel', severity: 'info' })
  assert.equal(formatTurnEndReason({ kind: 'aborted' }), null)
})

test('formatTurnEndReason: unknown kind (plugin-added) → null (fall through)', () => {
  assert.equal(formatTurnEndReason({ kind: 'quota-exhausted', usage: 999 }), null)
})

test('formatTurnEndReason: bad input → null (never throws)', () => {
  assert.equal(formatTurnEndReason(null), null)
  assert.equal(formatTurnEndReason(undefined), null)
  assert.equal(formatTurnEndReason('completed'), null)
})

// -- foldPromptBlocked ------------------------------------------------------

test('foldPromptBlocked: extracts reason + joined text + source', () => {
  const out = foldPromptBlocked({
    content: [{ type: 'text', text: 'rm -rf /' }],
    source: 'user',
    reason: 'destructive path in workspace root',
  })
  assert.deepEqual(out, {
    reason: 'destructive path in workspace root',
    text: 'rm -rf /',
    source: 'user',
  })
})

test('foldPromptBlocked: missing reason gets a placeholder, defaults source=user', () => {
  const out = foldPromptBlocked({ content: [{ type: 'text', text: 'hi' }] })
  assert.equal(out.reason, '(no reason)')
  assert.equal(out.source, 'user')
})

// -- summarizeSubagentFinished ---------------------------------------------

test('summarizeSubagentFinished: string message → oneLine + full', () => {
  const s = summarizeSubagentFinished({
    lastAssistantMessage: 'Refactored auth to use the new middleware. All tests pass.',
  })
  assert.equal(s.full, 'Refactored auth to use the new middleware. All tests pass.')
  assert.equal(s.oneLine, 'Refactored auth to use the new middleware. All tests pass.')
})

test('summarizeSubagentFinished: content blocks flatten to text', () => {
  const s = summarizeSubagentFinished({
    lastAssistantMessage: [
      { type: 'text', text: 'Edited 3 files.' },
      { type: 'text', text: ' See the diff.' },
    ],
  })
  assert.equal(s.full, 'Edited 3 files. See the diff.')
})

test('summarizeSubagentFinished: long message truncates oneLine but preserves full', () => {
  const long = 'x'.repeat(300)
  const s = summarizeSubagentFinished({ lastAssistantMessage: long })
  assert.equal(s.oneLine.length, 118)          // 117 chars + '…'
  assert.equal(s.oneLine.endsWith('…'), true)
  assert.equal(s.full.length, 300)
})

test('summarizeSubagentFinished: absent lastAssistantMessage → null (fallthrough)', () => {
  assert.equal(summarizeSubagentFinished({ status: 'ok' }), null)
  assert.equal(summarizeSubagentFinished(null), null)
})

// -- auditRowForApproval ----------------------------------------------------

test('auditRowForApproval: allowed-once → ok, verb "allowed"', () => {
  const r = auditRowForApproval(
    { id: 'x', toolName: 'bash', reason: 'network fetch' },
    { id: 'x', outcome: 'allowed-once' },
  )
  assert.deepEqual(r, {
    toolName: 'bash', outcome: 'allowed-once',
    verb: 'allowed', reason: 'network fetch', tone: 'ok',
  })
})

test('auditRowForApproval: rejected → error tone; missing ask still returns a row', () => {
  const r = auditRowForApproval(null, { id: 'x', outcome: 'rejected' })
  assert.equal(r.tone, 'error')
  assert.equal(r.toolName, '(unknown tool)')
  assert.equal(r.verb, 'rejected')
})

test('auditRowForApproval: unknown outcome → passthrough verb, warn tone', () => {
  const r = auditRowForApproval({ toolName: 'edit' }, { outcome: 'weird' })
  assert.equal(r.verb, 'weird')
  assert.equal(r.tone, 'warn')
})

// -- classifyEvent ----------------------------------------------------------

test('classifyEvent: buckets each subscribed type; anything else → ignore', () => {
  const cases = [
    ['todo/write',         'todo'],
    ['prompt/blocked',     'prompt-blocked'],
    ['turn/end',           'turn-end'],
    ['approval/asked',     'approval-asked'],
    ['approval/decided',   'approval-decided'],
    ['bash/sandbox-mode',  'sandbox-mode'],
    ['permission/preset',  'permission-preset'],
    ['assistant/chunk',    'ignore'],       // not our surface
    ['tool/call',          'ignore'],       // batch A's surface
  ]
  for (const [type, kind] of cases) {
    assert.equal(classifyEvent({ type, data: {} }).kind, kind, type)
  }
  assert.equal(classifyEvent(null).kind, 'ignore')
})

// -- joinContentText --------------------------------------------------------

test('joinContentText: string passthrough, array joins text-only blocks', () => {
  assert.equal(joinContentText('hello'), 'hello')
  assert.equal(joinContentText([
    { type: 'text', text: 'a' },
    { type: 'image', url: '…' },      // non-text ignored
    { type: 'text', text: 'b' },
  ]), 'ab')
  assert.equal(joinContentText(null), '')
})

// -- formatTurnEndLine (Field §3 P0 #4) -------------------------------------

test('formatTurnEndLine: error variant — full concat with step + message + code', () => {
  const out = formatTurnEndLine({
    kind: 'error', step: 3, message: 'model returned HTTP 429', code: 'RATE_LIMITED',
  })
  assert.match(out.line, /^turn ended: error at step 3: model returned HTTP 429 \[RATE_LIMITED\]$/)
  assert.equal(out.title, out.line, 'short messages have title === line')
  assert.equal(out.severity, 'error')
})

test('formatTurnEndLine: long error message truncates line but keeps full title', () => {
  const longMsg = 'adapter refused: model returned HTTP 429 after 2 retries (rate-limited by upstream); the retry-after header suggested 60s but our pool waited only 12s before giving up'
  const out = formatTurnEndLine({ kind: 'error', step: 5, message: longMsg })
  assert.ok(out.line.length <= 120, `line ${out.line.length} chars, expected <=120`)
  assert.ok(out.line.endsWith('…'), 'truncated line ends with ellipsis')
  assert.ok(out.title.length > out.line.length, 'title carries the full untruncated string')
  assert.ok(out.title.includes(longMsg), 'title contains full message')
  assert.equal(out.severity, 'error')
})

test('formatTurnEndLine: error variant — missing message falls back to "(no message)"', () => {
  const out = formatTurnEndLine({ kind: 'error', step: 2 })
  assert.equal(out.line, 'turn ended: error at step 2: (no message)')
  assert.equal(out.severity, 'error')
})

test('formatTurnEndLine: rejected variant — reason spliced in', () => {
  const out = formatTurnEndLine({ kind: 'rejected', reason: 'policy: destructive-ops' })
  assert.equal(out.line, 'turn ended: rejected: policy: destructive-ops')
  assert.equal(out.severity, 'warn')
})

test('formatTurnEndLine: max-tokens variant — short label', () => {
  const out = formatTurnEndLine({ kind: 'max-tokens' })
  assert.equal(out.line, 'turn ended: hit max tokens')
  assert.equal(out.severity, 'warn')
})

test('formatTurnEndLine: completed variant — bare kind, ok severity', () => {
  const out = formatTurnEndLine({ kind: 'completed' })
  assert.equal(out.line, 'turn ended: completed')
  assert.equal(out.severity, 'ok')
})

test('formatTurnEndLine: unknown plugin-merged kind — bare kind, no truncation', () => {
  const out = formatTurnEndLine({ kind: 'plugin-specific-kind' })
  assert.equal(out.line, 'turn ended: plugin-specific-kind')
  assert.equal(out.title, out.line)
})

test('formatTurnEndLine: null / non-object reason — safe default', () => {
  const a = formatTurnEndLine(null)
  const b = formatTurnEndLine(undefined)
  const c = formatTurnEndLine('bad-shape')
  assert.equal(a.line, 'turn ended')
  assert.equal(b.line, 'turn ended')
  assert.equal(c.line, 'turn ended')
  assert.equal(a.severity, 'ok')
})

// -- formatSessionFinishedLine (Field §3 P0 #10) ----------------------------

test('formatSessionFinishedLine: ok status — bare label', () => {
  const out = formatSessionFinishedLine({ status: 'ok' })
  assert.equal(out.line, 'session finished (ok)')
  assert.equal(out.title, out.line)
  assert.equal(out.severity, 'ok')
})

test('formatSessionFinishedLine: error status + reason — full concat', () => {
  const out = formatSessionFinishedLine({
    status: 'error',
    reason: {
      kind: 'error', step: 5, message: 'persistence backend disk full', code: 'PERSIST_FAIL',
    },
  })
  assert.match(out.line,
    /^session finished \(error\): error at step 5: persistence backend disk full \[PERSIST_FAIL\]$/)
  assert.equal(out.severity, 'error')
})

test('formatSessionFinishedLine: error status without reason — bare label with severity', () => {
  const out = formatSessionFinishedLine({ status: 'error' })
  assert.equal(out.line, 'session finished (error)')
  assert.equal(out.severity, 'error')
})

test('formatSessionFinishedLine: error status + rejected reason — nested detail', () => {
  const out = formatSessionFinishedLine({
    status: 'error',
    reason: { kind: 'rejected', reason: 'policy: guard' },
  })
  assert.equal(out.line, 'session finished (error): rejected: policy: guard')
  assert.equal(out.severity, 'error') // status wins over inner warn
})

// -- formatFinishReason (Field §3 P0 #9) ------------------------------------

test('formatFinishReason: stop variant — ok tone', () => {
  const out = formatFinishReason({ kind: 'stop' })
  assert.equal(out.label, 'stop')
  assert.equal(out.tone, 'ok')
  assert.match(out.title, /^finish: stop/)
})

test('formatFinishReason: max-tokens — warn tone', () => {
  const out = formatFinishReason({ kind: 'max-tokens' })
  assert.equal(out.label, 'max-tokens')
  assert.equal(out.tone, 'warn')
})

test('formatFinishReason: tool-calls — info tone', () => {
  const out = formatFinishReason({ kind: 'tool-calls' })
  assert.equal(out.label, 'tool-calls')
  assert.equal(out.tone, 'info')
})

test('formatFinishReason: error variant — message + code fold into title', () => {
  const out = formatFinishReason({ kind: 'error', message: 'upstream 500', code: 'GATEWAY' })
  assert.equal(out.label, 'error')
  assert.equal(out.tone, 'error')
  assert.match(out.title, /upstream 500/)
  assert.match(out.title, /\[GATEWAY\]/)
})

test('formatFinishReason: plugin-merged unknown kind — surfaces the extension', () => {
  const out = formatFinishReason({ kind: 'plugin-defined' })
  assert.equal(out.label, 'plugin-defined')
  assert.equal(out.tone, 'info')
})

test('formatFinishReason: null / bad shape → null', () => {
  assert.equal(formatFinishReason(null), null)
  assert.equal(formatFinishReason(undefined), null)
  assert.equal(formatFinishReason('stop'), null)
  assert.equal(formatFinishReason({}), null)
  assert.equal(formatFinishReason({ kind: null }), null)
})

// -- formatTurnEndReason stays behavior-preserving ---------------------------

test('formatTurnEndReason: unchanged behaviour after formatTurnEndLine addition', () => {
  const err = formatTurnEndReason({ kind: 'error', step: 2, message: 'x' })
  assert.equal(err.detail, 'error at step 2: x')
  assert.equal(err.severity, 'error')
  const maxTok = formatTurnEndReason({ kind: 'max-tokens' })
  assert.equal(maxTok.detail, 'hit max tokens')
  const completed = formatTurnEndReason({ kind: 'completed' })
  assert.equal(completed, null)
})
