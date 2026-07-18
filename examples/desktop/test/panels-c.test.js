// Pure unit tests for panels-c.js (P1 renderer batch C). Runs under
// `node --test`, no Electron, no DOM.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

function loadModule() {
  const p = require.resolve('../src/renderer/panels-c.js')
  delete require.cache[p]
  return require('../src/renderer/panels-c.js')
}

// ----- foldWebSearchResults -------------------------------------------------

test('foldWebSearchResults: JSON with {results:[…]} keeps title/url/snippet', () => {
  const { foldWebSearchResults } = loadModule()
  const content = [{ type: 'text', text: JSON.stringify({
    results: [
      { title: 'DSH', url: 'https://deepseek.com', snippet: 'the doc' },
      { title: 'Anthropic', url: 'https://anthropic.com', snippet: 'AI safety' },
    ],
  }) }]
  const { results } = foldWebSearchResults(content)
  assert.equal(results.length, 2)
  assert.deepEqual(results[0], { title: 'DSH', url: 'https://deepseek.com', snippet: 'the doc' })
})

test('foldWebSearchResults: bare JSON array works', () => {
  const { foldWebSearchResults } = loadModule()
  const content = [{ type: 'text', text: JSON.stringify([
    { title: 'A', url: 'https://a.example', snippet: 'x' },
  ]) }]
  const { results } = foldWebSearchResults(content)
  assert.equal(results.length, 1)
  assert.equal(results[0].url, 'https://a.example')
})

test('foldWebSearchResults: plain-text mode parses url + title + snippet', () => {
  const { foldWebSearchResults } = loadModule()
  const content = [{ type: 'text', text: 'Anthropic\nhttps://anthropic.com\nWe build safety.\n\nDeepSeek\nhttps://deepseek.com\nOpen weights.' }]
  const { results } = foldWebSearchResults(content)
  assert.equal(results.length, 2)
  assert.equal(results[0].title, 'Anthropic')
  assert.equal(results[0].url, 'https://anthropic.com')
  assert.match(results[0].snippet, /safety/)
})

test('foldWebSearchResults: rejects non-http(s) urls', () => {
  const { foldWebSearchResults } = loadModule()
  const content = [{ type: 'text', text: JSON.stringify({
    results: [
      { title: 'Local', url: 'file:///etc/passwd', snippet: '' },
      { title: 'Data', url: 'data:text/html,<script>', snippet: '' },
      { title: 'JS', url: 'javascript:alert(1)', snippet: '' },
      { title: 'OK', url: 'https://ok.example', snippet: '' },
    ],
  }) }]
  const { results } = foldWebSearchResults(content)
  assert.equal(results.length, 1)
  assert.equal(results[0].url, 'https://ok.example')
})

test('foldWebSearchResults: empty / garbled content yields empty results', () => {
  const { foldWebSearchResults } = loadModule()
  assert.deepEqual(foldWebSearchResults(undefined).results, [])
  assert.deepEqual(foldWebSearchResults([]).results, [])
  assert.deepEqual(foldWebSearchResults([{ type: 'text', text: 'no urls here at all' }]).results, [])
  assert.deepEqual(foldWebSearchResults([{ type: 'text', text: '{"malformed":' }]).results, [])
})

// ----- isSafeExternalUrl ----------------------------------------------------

test('isSafeExternalUrl: http and https pass; other schemes fail', () => {
  const { isSafeExternalUrl } = loadModule()
  assert.equal(isSafeExternalUrl('https://x.example'), true)
  assert.equal(isSafeExternalUrl('http://x.example'), true)
  assert.equal(isSafeExternalUrl('file:///a'), false)
  assert.equal(isSafeExternalUrl('javascript:1'), false)
  assert.equal(isSafeExternalUrl('data:,x'), false)
  assert.equal(isSafeExternalUrl(''), false)
  assert.equal(isSafeExternalUrl(null), false)
  assert.equal(isSafeExternalUrl('not a url'), false)
})

// ----- foldSkillLoad --------------------------------------------------------

test('foldSkillLoad: pulls name from args JSON and body from content', () => {
  const { foldSkillLoad } = loadModule()
  const out = foldSkillLoad({
    args: JSON.stringify({ name: 'code-review' }),
    content: [{ type: 'text', text: '# Code review\n\nDo the thing.' }],
  })
  assert.equal(out.name, 'code-review')
  assert.match(out.body, /Do the thing/)
})

test('foldSkillLoad: accepts args.skill alias, empty content ok', () => {
  const { foldSkillLoad } = loadModule()
  const out = foldSkillLoad({ args: JSON.stringify({ skill: 'verify' }), content: [] })
  assert.equal(out.name, 'verify')
  assert.equal(out.body, '')
})

test('foldSkillLoad: malformed args → name empty', () => {
  const { foldSkillLoad } = loadModule()
  const out = foldSkillLoad({ args: '{{}', content: [{ type: 'text', text: 'x' }] })
  assert.equal(out.name, '')
  assert.equal(out.body, 'x')
})

// ----- foldWorkflowCall -----------------------------------------------------

test('foldWorkflowCall: pulls name + phases (string form)', () => {
  const { foldWorkflowCall } = loadModule()
  const out = foldWorkflowCall({ args: JSON.stringify({ name: 'ship', phases: ['plan', 'build', 'test'] }) })
  assert.equal(out.name, 'ship')
  assert.equal(out.phases.length, 3)
  assert.equal(out.phases[0].id, 'plan')
  assert.equal(out.phases[0].status, 'pending')
})

test('foldWorkflowCall: phases as objects with status', () => {
  const { foldWorkflowCall } = loadModule()
  const out = foldWorkflowCall({ args: JSON.stringify({
    workflow: 'demo',
    phases: [
      { id: 'a', label: 'Analyze', status: 'done' },
      { id: 'b', label: 'Build', status: 'running' },
      { id: 'c', status: 'bogus' },
    ],
  }) })
  assert.equal(out.name, 'demo')
  assert.equal(out.phases[0].status, 'done')
  assert.equal(out.phases[1].status, 'running')
  assert.equal(out.phases[2].status, 'pending') // bogus → pending
  assert.equal(out.phases[2].label, 'c') // label defaults to id
})

test('foldWorkflowCall: missing args → empty structure', () => {
  const { foldWorkflowCall } = loadModule()
  const out = foldWorkflowCall({})
  assert.equal(out.name, '')
  assert.deepEqual(out.phases, [])
})

// ----- updateBackgroundTasks ------------------------------------------------

test('updateBackgroundTasks: task_output/call → running entry', () => {
  const { updateBackgroundTasks } = loadModule()
  const s0 = { tasks: new Map() }
  const s1 = updateBackgroundTasks(s0, {
    toolName: 'task_output', callId: 'c1',
    args: JSON.stringify({ taskId: 'T1' }), phase: 'call',
  })
  assert.ok(s1.tasks.has('T1'))
  assert.equal(s1.tasks.get('T1').status, 'running')
  // Purity: source Map untouched.
  assert.equal(s0.tasks.size, 0)
})

test('updateBackgroundTasks: task_output/result updates summary', () => {
  const { updateBackgroundTasks } = loadModule()
  let s = { tasks: new Map([['T1', { id: 'T1', name: 'do a thing', status: 'running', summary: '', lastUpdate: '' }]]) }
  s = updateBackgroundTasks(s, {
    toolName: 'task_output',
    args: JSON.stringify({ taskId: 'T1' }),
    content: [{ type: 'text', text: 'line 1\nline 2' }],
    phase: 'result',
  })
  assert.equal(s.tasks.get('T1').summary, 'line 1\nline 2')
  assert.equal(s.tasks.get('T1').name, 'do a thing') // preserved
})

test('updateBackgroundTasks: task_list authoritative overwrite', () => {
  const { updateBackgroundTasks } = loadModule()
  let s = { tasks: new Map([['stale', { id: 'stale', name: 'gone', status: 'running', summary: '', lastUpdate: '' }]]) }
  s = updateBackgroundTasks(s, {
    toolName: 'task_list',
    content: [{ type: 'text', text: JSON.stringify({
      tasks: [
        { id: 'T1', name: 'build', status: 'running' },
        { id: 'T2', name: 'test',  status: 'pending' },
      ],
    }) }],
    phase: 'result',
  })
  assert.equal(s.tasks.size, 2)
  assert.ok(!s.tasks.has('stale'))
  assert.equal(s.tasks.get('T1').status, 'running')
})

test('updateBackgroundTasks: task_kill flips to killed', () => {
  const { updateBackgroundTasks } = loadModule()
  let s = { tasks: new Map([['T1', { id: 'T1', name: 'x', status: 'running', summary: '', lastUpdate: '' }]]) }
  s = updateBackgroundTasks(s, {
    toolName: 'task_kill',
    args: JSON.stringify({ taskId: 'T1' }),
    content: [{ type: 'text', text: 'ok' }],
    phase: 'result',
  })
  assert.equal(s.tasks.get('T1').status, 'killed')
})

test('updateBackgroundTasks: unrelated tool is a no-op', () => {
  const { updateBackgroundTasks } = loadModule()
  const s0 = { tasks: new Map() }
  const s1 = updateBackgroundTasks(s0, {
    toolName: 'bash', args: JSON.stringify({ command: 'ls' }), phase: 'call',
  })
  assert.equal(s1.tasks.size, 0)
})

test('updateBackgroundTasks: isError on result flips to failed', () => {
  const { updateBackgroundTasks } = loadModule()
  let s = { tasks: new Map([['T1', { id: 'T1', name: 'x', status: 'running', summary: '', lastUpdate: '' }]]) }
  s = updateBackgroundTasks(s, {
    toolName: 'task_output',
    args: JSON.stringify({ taskId: 'T1' }),
    isError: true,
    content: [{ type: 'text', text: 'oom' }],
    phase: 'result',
  })
  assert.equal(s.tasks.get('T1').status, 'failed')
  assert.equal(s.tasks.get('T1').summary, 'oom')
})

test('updateBackgroundTasks: initial state ok (undefined / missing tasks)', () => {
  const { updateBackgroundTasks } = loadModule()
  const s1 = updateBackgroundTasks(undefined, { toolName: 'task_list', phase: 'result', content: [{ type: 'text', text: '{"tasks":[]}' }] })
  assert.equal(s1.tasks.size, 0)
  const s2 = updateBackgroundTasks({}, { toolName: 'task_output', phase: 'call' })
  assert.equal(s2.tasks.size, 0)
})

// ----- splitSessionsByLive --------------------------------------------------

test('splitSessionsByLive: live=true → live; live=false+persisted=true → history', () => {
  const { splitSessionsByLive } = loadModule()
  const entries = [
    { sessionId: 'a', live: true,  persisted: true },
    { sessionId: 'b', live: true,  persisted: false },
    { sessionId: 'c', live: false, persisted: true },
    { sessionId: 'd', live: false, persisted: false }, // stale ghost — dropped
  ]
  const { live, history } = splitSessionsByLive(entries)
  assert.deepEqual(live.map((e) => e.sessionId), ['a', 'b'])
  assert.deepEqual(history.map((e) => e.sessionId), ['c'])
})

test('splitSessionsByLive: missing live flag treated as live (v1 fallback)', () => {
  const { splitSessionsByLive } = loadModule()
  const { live, history } = splitSessionsByLive([
    { sessionId: 'a' },
    { sessionId: 'b', persisted: true },
  ])
  assert.equal(live.length, 2)
  assert.equal(history.length, 0)
})

test('splitSessionsByLive: not-an-array → empty split', () => {
  const { splitSessionsByLive } = loadModule()
  const { live, history } = splitSessionsByLive(null)
  assert.deepEqual(live, [])
  assert.deepEqual(history, [])
})

// ----- helpers --------------------------------------------------------------

test('joinTextBlocks: robust across string/array/nulls', () => {
  const { joinTextBlocks } = loadModule()
  assert.equal(joinTextBlocks('plain'), 'plain')
  assert.equal(joinTextBlocks([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(joinTextBlocks([{ text: 'x' }]), 'x') // no type but has text
  assert.equal(joinTextBlocks(null), '')
  assert.equal(joinTextBlocks(undefined), '')
})

test('classifyTaskTool: recognises the three task_* tools; nothing else', () => {
  const { classifyTaskTool } = loadModule()
  assert.equal(classifyTaskTool('task_output'), 'output')
  assert.equal(classifyTaskTool('task_list'), 'list')
  assert.equal(classifyTaskTool('task_kill'), 'kill')
  assert.equal(classifyTaskTool('task_something_else'), null)
  assert.equal(classifyTaskTool('bash'), null)
})

test('shortSummary: truncates past 200 chars with ellipsis', () => {
  const { shortSummary } = loadModule()
  const s = 'x'.repeat(500)
  const t = shortSummary(s)
  assert.equal(t.length, 198)
  assert.match(t, /…$/)
})

// ----- smartSessionTitle + relativeTime (round-2 HISTORY noise collapse) ----

test('smartSessionTitle: real user title passes through unchanged', () => {
  const { smartSessionTitle } = loadModule()
  const now = 1_800_000_000_000
  const out = smartSessionTitle(
    { title: '修复 fs-local 边界', sessionId: 'abc123def', lastEventTime: now - 60_000 },
    now,
  )
  assert.equal(out.text, '修复 fs-local 边界')
  assert.equal(out.isUntitled, false)
})

test('smartSessionTitle: (smoke-…) fixture becomes Untitled · <rel>', () => {
  const { smartSessionTitle } = loadModule()
  const now = 1_800_000_000_000
  const out = smartSessionTitle(
    { title: '(smoke-tree-parent-1751000000000)', sessionId: 's', lastEventTime: now - 3600_000 },
    now,
  )
  assert.equal(out.isUntitled, true)
  assert.match(out.text, /^Untitled · /)
  assert.match(out.text, /h ago$/)
})

test('smartSessionTitle: bare "smoke-…" fixture also collapses', () => {
  const { smartSessionTitle } = loadModule()
  const out = smartSessionTitle(
    { title: 'smoke-daemon-123', sessionId: 's', lastEventTime: 0 },
    1_800_000_000_000,
  )
  assert.equal(out.isUntitled, true)
  assert.equal(out.text, 'Untitled')  // lastEventTime=0 → no rel suffix
})

test('smartSessionTitle: (shortId) renderer fallback also collapses', () => {
  const { smartSessionTitle } = loadModule()
  const now = 1_800_000_000_000
  // Both the generic hex placeholder and the sessionId-derived one collapse.
  const a = smartSessionTitle(
    { title: '(abcdef12)', sessionId: 'abcdef12-9999', lastEventTime: now - 120_000 },
    now,
  )
  assert.equal(a.isUntitled, true)
  const b = smartSessionTitle(
    { title: '(smokeXYZ)', sessionId: 'smokeXYZ-tail', lastEventTime: now - 120_000 },
    now,
  )
  assert.equal(b.isUntitled, true)
})

test('smartSessionTitle: missing title also renders untitled with rel-time', () => {
  const { smartSessionTitle } = loadModule()
  const now = 1_800_000_000_000
  const out = smartSessionTitle({ sessionId: 'x', lastEventTime: now - 30_000 }, now)
  assert.equal(out.isUntitled, true)
  assert.equal(out.text, 'Untitled · just now')
})

test('relativeTime: covers just now / min / h / d / w / mo / y', () => {
  const { relativeTime } = loadModule()
  const now = 1_800_000_000_000
  assert.equal(relativeTime(now - 5_000,      now), 'just now')
  assert.equal(relativeTime(now - 120_000,    now), '2 min ago')
  assert.equal(relativeTime(now - 3600_000,   now), '1 h ago')
  assert.equal(relativeTime(now - 86400_000,  now), '1 d ago')
  assert.equal(relativeTime(now - 7*86400_000, now), '1 w ago')
  assert.equal(relativeTime(now - 40*86400_000, now), '1 mo ago')
  assert.equal(relativeTime(now - 400*86400_000, now), '1 y ago')
})

test('relativeTime: absent / bogus timestamps render as empty string', () => {
  const { relativeTime } = loadModule()
  assert.equal(relativeTime(undefined, Date.now()), '')
  assert.equal(relativeTime(null, Date.now()), '')
  assert.equal(relativeTime(0, Date.now()), '')
  assert.equal(relativeTime(NaN, Date.now()), '')
  // Future timestamps clamp to "just now" — never emit a negative delta.
  assert.equal(relativeTime(Date.now() + 60_000, Date.now()), 'just now')
})

// ----- mergeRecentSessions (unified SESSIONS + HISTORY) ---------------------

test('mergeRecentSessions: sorts live + persisted rows together by lastEventTime desc', () => {
  const { mergeRecentSessions } = loadModule()
  const now = 1_700_000_000_000
  const entries = [
    { sessionId: 'a', live: true,  persisted: false, hasUserMessage: true, lastEventTime: now - 5000 },
    { sessionId: 'b', live: false, persisted: true,  hasUserMessage: true, lastEventTime: now - 1000 },
    { sessionId: 'c', live: true,  persisted: false, hasUserMessage: true, lastEventTime: now - 9000 },
  ]
  const rows = mergeRecentSessions(entries)
  assert.deepEqual(rows.map((r) => r.sessionId), ['b', 'a', 'c'])
})

test('mergeRecentSessions: filters out empty (hasUserMessage=false) sessions except the active one', () => {
  const { mergeRecentSessions } = loadModule()
  const entries = [
    { sessionId: 'a', live: true, hasUserMessage: false, lastEventTime: 3 },
    { sessionId: 'b', live: true, hasUserMessage: true,  lastEventTime: 2 },
    { sessionId: 'c', live: true, hasUserMessage: false, lastEventTime: 1 }, // this is what "+" just landed on
  ]
  const rows = mergeRecentSessions(entries, { activeSessionId: 'c' })
  // b (has msg) and c (active tiebreaker) both survive; a is filtered
  assert.deepEqual(rows.map((r) => r.sessionId).sort(), ['b', 'c'])
})

test('mergeRecentSessions: drops stale ghosts (live=false && persisted=false)', () => {
  const { mergeRecentSessions } = loadModule()
  const entries = [
    { sessionId: 'a', live: false, persisted: false, hasUserMessage: true, lastEventTime: 99 },
    { sessionId: 'b', live: true,                    hasUserMessage: true, lastEventTime: 1 },
  ]
  const rows = mergeRecentSessions(entries)
  assert.deepEqual(rows.map((r) => r.sessionId), ['b'])
})

test('mergeRecentSessions: active session floats above ties', () => {
  const { mergeRecentSessions } = loadModule()
  const t = 1000
  const entries = [
    { sessionId: 'a', live: true, hasUserMessage: true, lastEventTime: t },
    { sessionId: 'b', live: true, hasUserMessage: true, lastEventTime: t },
  ]
  const rows = mergeRecentSessions(entries, { activeSessionId: 'b' })
  assert.equal(rows[0].sessionId, 'b')
})

test('mergeRecentSessions: not-an-array → empty list', () => {
  const { mergeRecentSessions } = loadModule()
  assert.deepEqual(mergeRecentSessions(null), [])
  assert.deepEqual(mergeRecentSessions(undefined), [])
  assert.deepEqual(mergeRecentSessions('nope'), [])
})

test('mergeRecentSessions: real-world mix — persisted, live-running, empty-active', () => {
  const { mergeRecentSessions } = loadModule()
  const now = 1_700_000_000_000
  const entries = [
    { sessionId: 'persistedA', live: false, persisted: true, hasUserMessage: true, lastEventTime: now - 3_600_000 },
    { sessionId: 'liveRun',    live: true,  persisted: false, hasUserMessage: true, running: true, lastEventTime: now - 30_000 },
    { sessionId: 'emptyNew',   live: true,  persisted: false, hasUserMessage: false, lastEventTime: now - 1_000 },
    { sessionId: 'orphan',     live: false, persisted: false, hasUserMessage: true, lastEventTime: now },
  ]
  const rows = mergeRecentSessions(entries, { activeSessionId: 'emptyNew' })
  // orphan dropped (stale ghost); emptyNew survives as active; sort by rel-time
  assert.deepEqual(rows.map((r) => r.sessionId), ['emptyNew', 'liveRun', 'persistedA'])
})

// ----- findReusableEmptySession --------------------------------------------

test('findReusableEmptySession: returns the id of a live, not-running, no-message session', () => {
  const { findReusableEmptySession } = loadModule()
  const entries = [
    { sessionId: 'busy',   live: true,  running: true,  hasUserMessage: false, lastEventTime: 5 },
    { sessionId: 'empty',  live: true,  running: false, hasUserMessage: false, lastEventTime: 3 },
    { sessionId: 'filled', live: true,  running: false, hasUserMessage: true,  lastEventTime: 4 },
  ]
  assert.equal(findReusableEmptySession(entries), 'empty')
})

test('findReusableEmptySession: prefers the most-recent empty session', () => {
  const { findReusableEmptySession } = loadModule()
  const entries = [
    { sessionId: 'old', live: true, running: false, hasUserMessage: false, lastEventTime: 1 },
    { sessionId: 'new', live: true, running: false, hasUserMessage: false, lastEventTime: 999 },
  ]
  assert.equal(findReusableEmptySession(entries), 'new')
})

test('findReusableEmptySession: returns null when no empty session exists', () => {
  const { findReusableEmptySession } = loadModule()
  const entries = [
    { sessionId: 'a', live: true, running: false, hasUserMessage: true, lastEventTime: 1 },
    { sessionId: 'b', live: true, running: true,  hasUserMessage: false, lastEventTime: 2 },
    { sessionId: 'c', live: false, persisted: true, hasUserMessage: true, lastEventTime: 3 },
  ]
  assert.equal(findReusableEmptySession(entries), null)
})

test('findReusableEmptySession: null on bad input', () => {
  const { findReusableEmptySession } = loadModule()
  assert.equal(findReusableEmptySession(null), null)
  assert.equal(findReusableEmptySession(undefined), null)
  assert.equal(findReusableEmptySession([]), null)
})

// ----- filterEmptySessions (extracted for Mission + Quick-Chat) --------------
// C-P0-1 + task #69 empty-filter reuse: the same predicate that trims the
// sidebar Recent list now feeds Mission Control's projections. If either
// consumer diverges the sidebar and Mission will show different session
// counts on the same boot — the exact bug this task fixes.

test('filterEmptySessions: drops hasUserMessage=false rows except the active one', () => {
  const { filterEmptySessions } = loadModule()
  const entries = [
    { sessionId: 'a', live: true, hasUserMessage: false, lastEventTime: 3 },
    { sessionId: 'b', live: true, hasUserMessage: true,  lastEventTime: 2 },
    { sessionId: 'c', live: true, hasUserMessage: false, lastEventTime: 1 },
  ]
  const rows = filterEmptySessions(entries, { activeSessionId: 'c' })
  assert.deepEqual(rows.map((r) => r.sessionId).sort(), ['b', 'c'])
})

test('filterEmptySessions: drops stale ghosts (live=false && persisted=false)', () => {
  const { filterEmptySessions } = loadModule()
  const entries = [
    { sessionId: 'ghost', live: false, persisted: false, hasUserMessage: true, lastEventTime: 9 },
    { sessionId: 'ok',    live: true,                    hasUserMessage: true, lastEventTime: 1 },
  ]
  assert.deepEqual(filterEmptySessions(entries).map((r) => r.sessionId), ['ok'])
})

test('filterEmptySessions: preserves ordering (sorting is caller responsibility)', () => {
  const { filterEmptySessions } = loadModule()
  const entries = [
    { sessionId: 'a', live: true, hasUserMessage: true, lastEventTime: 3 },
    { sessionId: 'b', live: true, hasUserMessage: true, lastEventTime: 1 },
    { sessionId: 'c', live: true, hasUserMessage: true, lastEventTime: 2 },
  ]
  assert.deepEqual(filterEmptySessions(entries).map((r) => r.sessionId), ['a', 'b', 'c'])
})

test('filterEmptySessions: hasUserMessage=undefined is treated as unknown-keep', () => {
  const { filterEmptySessions } = loadModule()
  // The Mission-side fallback path (session/list without chat's local flag)
  // must not silently drop rows just because the enrichment step never ran.
  const entries = [
    { sessionId: 'unknown', live: true, lastEventTime: 1 },
    { sessionId: 'explicitEmpty', live: true, hasUserMessage: false, lastEventTime: 2 },
  ]
  assert.deepEqual(filterEmptySessions(entries).map((r) => r.sessionId), ['unknown'])
})

test('filterEmptySessions: bad input → empty list', () => {
  const { filterEmptySessions } = loadModule()
  assert.deepEqual(filterEmptySessions(null), [])
  assert.deepEqual(filterEmptySessions('nope'), [])
})

test('mergeRecentSessions still shares the filterEmptySessions predicate', () => {
  // Behavioural equivalence check — if someone tightens or loosens the filter
  // in one place, the two lists will diverge. This ensures the refactor
  // didn't change what mergeRecentSessions returns.
  const { mergeRecentSessions, filterEmptySessions } = loadModule()
  const entries = [
    { sessionId: 'ghost', live: false, persisted: false, hasUserMessage: true, lastEventTime: 9 },
    { sessionId: 'active-empty', live: true, hasUserMessage: false, lastEventTime: 5 },
    { sessionId: 'real', live: true, hasUserMessage: true, lastEventTime: 2 },
    { sessionId: 'stale-empty', live: true, hasUserMessage: false, lastEventTime: 1 },
  ]
  const merged = mergeRecentSessions(entries, { activeSessionId: 'active-empty' })
  const filtered = filterEmptySessions(entries, { activeSessionId: 'active-empty' })
  assert.deepEqual(merged.map((r) => r.sessionId).sort(), filtered.map((r) => r.sessionId).sort())
})

// Round-3 root-cause coverage. Mixed fixtures the real app actually sends
// (chat-side sessions Map projection + daemon session/list, both partially
// annotated) — the filter must not silently keep the smoke-* pile just
// because hasUserMessage never made it onto the entry.
test('filterEmptySessions: three-state fixture (flag / no-flag+events=0 / no-flag+unknown-events)', () => {
  const { filterEmptySessions } = loadModule()
  const entries = [
    // (1) explicit flag — behaves as before
    { sessionId: 'flag-real', live: true, hasUserMessage: true, lastEventTime: 9 },
    { sessionId: 'flag-empty', live: true, hasUserMessage: false, lastEventTime: 8 },
    // (2) no flag but eventCount === 0 — the escape hatch drops these
    { sessionId: 'smoke-a', live: true, eventCount: 0, lastEventTime: 7 },
    { sessionId: 'smoke-b', live: true, persisted: true, eventCount: 0, lastEventTime: 6 },
    // (3) no flag AND unknown events — keep it (be conservative, unknown ≠ empty)
    { sessionId: 'unknown-a', live: true, lastEventTime: 5 },
    { sessionId: 'unknown-b', persisted: true, lastEventTime: 4 },
    // (4) eventCount > 0 with no flag — has activity, keep it
    { sessionId: 'active-nofield', live: true, eventCount: 12, lastEventTime: 3 },
  ]
  const kept = filterEmptySessions(entries).map((r) => r.sessionId).sort()
  assert.deepEqual(kept, ['active-nofield', 'flag-real', 'unknown-a', 'unknown-b'])
})

test('filterEmptySessions: active session survives even when eventCount=0 (just-clicked "+")', () => {
  const { filterEmptySessions } = loadModule()
  const entries = [
    { sessionId: 'just-new', live: true, eventCount: 0, lastEventTime: 1 },
    { sessionId: 'smoke-x', live: true, eventCount: 0, lastEventTime: 2 },
  ]
  const kept = filterEmptySessions(entries, { activeSessionId: 'just-new' })
  assert.deepEqual(kept.map((r) => r.sessionId), ['just-new'])
})
