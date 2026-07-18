// mock-fixtures.js — Debug menu mock functions (extracted from renderer.js,
// F-05).
//
// These 23 functions used to live inline in renderer.js as the "mock wall"
// (near line 5450). They all follow the same pattern: synthesize a
// tool/call → tool/result pair (or an interrupt) and route it through
// onSessionEvent / onInterruptIncoming so the mocked card renders through
// the exact same dispatch path a real wire event would. The Debug popover
// (gated on DSH_QA=1) wires each button to the matching function below.
//
// The extract is deliberately non-IIFE so the top-level `function foo()`
// declarations land on the global scope where renderer.js's listener
// bindings resolve them by name (`addEventListener('click', mockApproval)`).
// index.html loads this file BEFORE renderer.js, so the names are hoisted
// by the time renderer.js's boot code runs.
//
// Unqualified identifiers inside the function bodies (state, streamEl,
// appendSystem, onSessionEvent, onInterruptIncoming) resolve dynamically at
// call time via the shared global scope — renderer.js owns those and this
// file just consumes them, matching the existing renderer.js-as-shell shape
// (see test/renderer-collisions.test.js allow-list rationale).

'use strict';

// -- interrupts (approval / question) ---------------------------------------

function mockApproval() {
  onInterruptIncoming({
    interruptId: `mock-${Date.now()}`,
    sessionId: state.activeSessionId,
    kind: 'approval',
    spec: {
      toolCallId: 'mock-call-1',
      options: [
        { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject once', kind: 'reject_once' },
      ],
    },
  })
}
function mockQuestion() {
  onInterruptIncoming({
    interruptId: `mock-${Date.now()}`,
    sessionId: state.activeSessionId,
    kind: 'form',
    spec: {
      title: 'Which framework?',
      message: 'Pick one; add other if you like.',
      options: [
        { label: 'React' }, { label: 'Vue' }, { label: 'Svelte' },
      ],
    },
  })
}

// -- mock widget injection ---------------------------------------------------
// Fires a synthetic tool/call → tool/result sequence so the widget renders
// through the same dispatch path the real wire will use. See
// docs/widget-channel-design.md §7 for the runtime-side changes that make
// this path real (adds `card: 'widget'` to ToolResultView).

function injectMockWidget(name, widget) {
  const sid = state.activeSessionId
  if (!sid) {
    appendSystem('start a session first')
    return
  }
  const callId = `mock-widget-${Date.now()}`
  onSessionEvent(sid, {
    type: 'tool/call',
    seq: -1, time: Date.now(),
    data: { turn: 0, step: 0, callId, name, arguments: JSON.stringify(widget && widget.data ? { preview: 'see widget' } : {}) },
  })
  onSessionEvent(sid, {
    type: 'tool/result',
    seq: -1, time: Date.now(),
    data: {
      turn: 0, step: 0, callId,
      content: [{ type: 'text', text: `[widget rendered inline: ${widget.kind}/${widget.id}]` }],
      isError: false,
      meta: { card: 'widget', widget },
    },
  })
}

function mockWidgetTable() {
  injectMockWidget('mock:show_table', {
    kind: 'table', id: 'q4_revenue',
    data: {
      columns: [
        { key: 'product', label: 'Product' },
        { key: 'q3', label: 'Q3', align: 'right' },
        { key: 'q4', label: 'Q4', align: 'right' },
        { key: 'delta', label: 'Δ', align: 'right' },
      ],
      rows: [
        { product: 'Alpha', q3: 42.1, q4: 51.8, delta: '+9.7' },
        { product: 'Beta',  q3: 88.0, q4: 76.4, delta: '-11.6' },
        { product: 'Gamma', q3: 12.3, q4: 19.7, delta: '+7.4' },
      ],
      caption: 'Revenue in USDm — mock data',
    },
    actions: [
      { id: 'chart', label: 'Show as chart', prompt: 'Chart Q3 vs Q4 revenue by product', variant: 'primary' },
      { id: 'export', label: 'Export CSV', prompt: 'Export this table as CSV' },
    ],
  })
}

function mockWidgetChart() {
  injectMockWidget('mock:show_chart', {
    kind: 'chart', id: 'q4_revenue_chart',
    data: {
      chartType: 'bar',
      labels: ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'],
      series: [
        { name: 'Q3', values: [42.1, 88.0, 12.3, 27.5, 65.0] },
        { name: 'Q4', values: [51.8, 76.4, 19.7, 31.0, 71.5] },
      ],
      xAxis: 'Product', yAxis: 'Revenue (USDm)',
    },
    actions: [
      { id: 'line', label: 'Line view', prompt: 'Redraw as a line chart' },
      { id: 'drill', label: 'Drill into Beta', prompt: 'Show me the monthly breakdown for Beta' },
    ],
  })
}

// -- mock render-intent cards -----------------------------------------------
// Fires synthetic tool/call → tool/result pairs so the diff/terminal cards
// render through the same dispatch path the real wire uses. The render intents
// (`card: 'terminal' | 'diff'`) are already produced by bash + fs today; this
// mock exists so the desktop shell can be demo'd without booting the runtime.

function injectMockToolResult({ name, args, meta, content, isError = false }) {
  const sid = state.activeSessionId
  if (!sid) {
    appendSystem('start a session first')
    return
  }
  const callId = `mock-${name}-${Date.now()}`
  onSessionEvent(sid, {
    type: 'tool/call',
    seq: -1, time: Date.now(),
    data: { turn: 0, step: 0, callId, name, arguments: JSON.stringify(args || {}) },
  })
  onSessionEvent(sid, {
    type: 'tool/result',
    seq: -1, time: Date.now(),
    data: { turn: 0, step: 0, callId, content, isError, meta },
  })
  return callId
}

function mockCardTerminal() {
  injectMockToolResult({
    name: 'bash',
    args: { command: "printf 'hello\\nworld\\n' && ls -la /nope" },
    meta: {
      card: 'terminal',
      output: 'hello\nworld\nls: /nope: No such file or directory\n',
      exitCode: 1,
    },
    content: [{ type: 'text', text: '[terminal rendered inline]' }],
    isError: false,
  })
}

function mockCardDiff() {
  injectMockToolResult({
    name: 'edit',
    args: { file_path: 'src/greet.js', old_string: '…', new_string: '…' },
    meta: {
      card: 'diff',
      title: 'Edit src/greet.js',
      diffs: [{
        path: 'src/greet.js',
        oldText: "function greet(who) {\n  return 'hi ' + who\n}\n",
        newText: "function greet(who) {\n  return `hello, ${who}!`\n}\n",
      }],
    },
    content: [{ type: 'text', text: '[diff rendered inline]' }],
    isError: false,
  })
}

function mockCardDiffWrite() {
  injectMockToolResult({
    name: 'write',
    args: { file_path: 'docs/notes.md' },
    meta: {
      card: 'diff',
      title: 'Write docs/notes.md',
      diffs: [{
        path: 'docs/notes.md',
        oldText: null,
        newText: '# Notes\n\n- one\n- two\n- three\n',
      }],
    },
    content: [{ type: 'text', text: '[diff rendered inline]' }],
    isError: false,
  })
}

// exercise the new CodeSandbox layout:
// three files with distant changes so the tree column appears + each file
// shows multiple hunks (@@ headers) collapsed by default. The 3rd file has
// far-separated changes so its @@ header numbering is exercised.
function mockCardDiffMulti() {
  const bigOld = []
  const bigNew = []
  for (let i = 0; i < 8; i++) bigOld.push(`ctx-head-${i}`), bigNew.push(`ctx-head-${i}`)
  bigOld.push('const legacyName = "old-value"')
  bigNew.push('const modernName = "new-value"')
  for (let i = 0; i < 15; i++) bigOld.push(`ctx-mid-${i}`), bigNew.push(`ctx-mid-${i}`)
  bigOld.push('return legacyName')
  bigNew.push('return modernName')
  for (let i = 0; i < 6; i++) bigOld.push(`ctx-tail-${i}`), bigNew.push(`ctx-tail-${i}`)

  injectMockToolResult({
    name: 'edit',
    args: { file_path: 'src/config.ts' },
    meta: {
      card: 'diff',
      title: 'Refactor: rename legacyName → modernName across 3 files',
      diffs: [
        {
          path: 'src/config.ts',
          oldText: bigOld.join('\n'),
          newText: bigNew.join('\n'),
        },
        {
          path: 'src/util/format.ts',
          oldText: 'export function fmt(x) {\n  return String(x).toUpperCase()\n}\n',
          newText: 'export function fmt(x: unknown): string {\n  if (x == null) return ""\n  return String(x).toUpperCase()\n}\n',
        },
        {
          path: 'docs/CHANGELOG.md',
          oldText: null,
          newText: '# Changelog\n\n## Unreleased\n\n- Renamed `legacyName` → `modernName`\n- `fmt(x)` handles `null`/`undefined` gracefully\n',
        },
      ],
    },
    content: [{ type: 'text', text: '[3-file diff rendered with tree]' }],
    isError: false,
  })
}

function mockCodeDispatch() {
  const sid = state.activeSessionId
  if (!sid) {
    appendSystem('start a session first')
    return
  }
  const parentCallId = injectMockToolResult({
    name: 'run_code',
    args: { code: "await bash({command:'ls'}); await read({file_path:'/etc/hosts'})" },
    meta: undefined,
    content: [{ type: 'text', text: '[code mode dispatched 3 sub-calls]' }],
    isError: false,
  })
  // Now fire three tool/code-dispatch sub-events anchored to the parent.
  const now = Date.now()
  const dispatches = [
    { name: 'bash',  isError: false, resultSummary: 'listed 12 entries' },
    { name: 'read',  isError: false, resultSummary: 'read 168 lines' },
    { name: 'edit',  isError: true,  resultSummary: 'no match for old_string' },
  ]
  for (const d of dispatches) {
    onSessionEvent(sid, {
      type: 'tool/code-dispatch',
      seq: -1, time: now,
      data: {
        parentCallId,
        subCallId: `sub-${Math.random().toString(36).slice(2, 8)}`,
        name: d.name,
        arguments: {},
        isError: d.isError,
        resultSummary: d.resultSummary,
      },
    })
  }
}

// -- context lane mocks ------------------------------------------
// Drive the recall card + compact card DOM without a live daemon. Same
// event-injection shape as the other mocks — feeds through onSessionEvent
// so the dispatch pathway is exercised, not a private code path.

function mockRecall() {
  const sid = state.activeSessionId
  if (!sid) { appendSystem('start a session first'); return }
  const callId = `mock-recall-${Date.now()}`
  onSessionEvent(sid, {
    type: 'tool/call',
    seq: -1, time: Date.now(),
    data: {
      turn: 0, step: 0, callId, name: 'history_search',
      arguments: JSON.stringify({ query: 'authentication config', limit: 5 }),
    },
  })
  // Small delay so a viewer sees the "recalling…" pending state flip.
  setTimeout(() => {
    onSessionEvent(sid, {
      type: 'tool/result',
      seq: -1, time: Date.now(),
      data: {
        turn: 0, step: 0, callId,
        isError: false,
        content: [{
          type: 'text',
          text: [
            '3 matches found:',
            '',
            '  [seq 42] user: how do we handle OAuth?',
            '  [seq 44] assistant: we redirect via /auth/callback and…',
            '  [seq 91] tool/edit: services/auth.ts — added the client-id lookup',
          ].join('\n'),
        }],
      },
    })
  }, 350)
}

function mockCompactSummary() {
  const sid = state.activeSessionId
  if (!sid) { appendSystem('start a session first'); return }
  const now = Date.now()
  onSessionEvent(sid, { type: 'compact/start', seq: -1, time: now, data: { turn: 0 } })
  onSessionEvent(sid, {
    type: 'compact/summary',
    seq: -1, time: now,
    data: {
      summary: [{
        type: 'text',
        text: [
          'The user asked about OAuth handling. We walked through',
          '/auth/callback wiring, added a client-id lookup in',
          'services/auth.ts, and confirmed the DeepSeek issuer URL.',
          'Open item: retry policy on 401 (deferred).',
        ].join(' '),
      }],
      shadowedRange: { start: 10, end: 90 },
      shadowedSeqs: Array.from({ length: 27 }, (_, i) => 10 + i),
      shadowedTokenCount: 4820,
      model: 'mock-summarizer',
    },
  })
  onSessionEvent(sid, { type: 'compact/end', seq: -1, time: now, data: { turn: 0 } })
}

function mockWidgetOptions() {
  injectMockWidget('mock:ask_options', {
    kind: 'options', id: 'framework_pick',
    data: {
      question: 'Which framework should we scaffold with?',
      options: [
        { id: 'react',   label: 'React',   hint: 'Familiar, huge ecosystem' },
        { id: 'vue',     label: 'Vue',     hint: 'Composition API, gentle curve' },
        { id: 'svelte',  label: 'Svelte',  hint: 'Compile-time, no vDOM' },
        { id: 'vanilla', label: 'Vanilla', hint: 'No framework — smallest surface' },
      ],
      footer: 'Click an option to send its choice as a prompt.',
    },
    actions: [
      { id: 'react',   prompt: "Let's use React.",   label: 'React' },
      { id: 'vue',     prompt: "Let's use Vue.",     label: 'Vue' },
      { id: 'svelte',  prompt: "Let's use Svelte.",  label: 'Svelte' },
      { id: 'vanilla', prompt: "Skip the framework — vanilla JS.", label: 'Vanilla' },
    ],
  })
}

// Form-variety demo: exercises every REAL verb + a RECORD-ONLY verb + a
// deliberately broken action, so a Debug walkthrough sees the whole verb
// catalog in one card. Written for the DSH context — not a copy of the
// next-action-ui-lab mock bank. See docs/ui-refs-distilled.md §3-E.
function mockWidgetVerbs() {
  injectMockWidget('mock:verb_catalog', {
    kind: 'kv', id: 'verb_catalog_demo',
    data: {
      entries: [
        { key: 'prompt',         value: 'sends a message as if you typed it' },
        { key: 'open_link',      value: 'opens a URL in your default browser' },
        { key: 'open_artifact',  value: 'opens the artifact preview page' },
        { key: 'switch_session', value: 'jumps you to another live session' },
        { key: 'note',           value: 'record-only — logs a devtools event' },
      ],
    },
    actions: [
      { id: 'prompt', verb: 'prompt', label: 'Send a prompt',
        variant: 'primary', prompt: 'Walk me through what each action verb does.' },
      { id: 'link', verb: 'open_link', label: 'Open the design doc',
        url: 'https://github.com/deepseek-ai/deepseek-harness' },
      { id: 'artifact', verb: 'open_artifact', label: 'Open the mock artifact',
        artifactId: 'sample.html' },
      { id: 'note', verb: 'note', label: 'Note only (record)',
        note: 'user reviewed the verb catalog' },
    ],
  })
}

// Broken-action demo: two intentionally malformed actions so the disabled
// state is visible at a glance. Pattern from next-action-ui-lab: better a
// button that says "unsupported" than one that looks live and does nothing.
function mockWidgetBroken() {
  injectMockWidget('mock:broken_verbs', {
    kind: 'kv', id: 'broken_verbs_demo',
    data: {
      entries: [
        { key: 'unknown-verb', value: 'action.verb = "teleport" — not in catalog' },
        { key: 'missing-url',  value: 'action.verb = "open_link" but url is empty' },
        { key: 'ok-fallback',  value: 'action with no verb defaults to "prompt"' },
      ],
    },
    actions: [
      { id: 'teleport', verb: 'teleport', label: 'Teleport somewhere' },
      { id: 'broken-link', verb: 'open_link', label: 'Open (no URL)', url: '' },
      { id: 'fallback', label: 'Ask about verbs',
        prompt: 'Which action verbs are safe to use in a widget?' },
    ],
  })
}

// -- P1 batch C: mock buttons for panels-c-controller.js -------------------
// These fire tool/call + tool/result pairs through the shared dispatch path.
// The controller's onNotify listener picks the results up and rewrites the
// res box into a panels-c card. Debug menu only — real callers just emit the
// same shapes on the wire.

function mockWebSearch() {
  injectMockToolResult({
    name: 'web_search',
    args: { query: 'DSH desktop demo' },
    content: [{ type: 'text', text: JSON.stringify({
      results: [
        { title: 'DeepSeek Harness',   url: 'https://github.com/deepseek-ai/deepseek-harness', snippet: 'Modular agent runtime with a cordis-based plugin system.' },
        { title: 'ACP client protocol', url: 'https://spec.acp.dev/', snippet: 'The agent–client protocol used by external editors.' },
        { title: 'Claude Code',         url: 'https://claude.com/claude-code', snippet: 'Anthropic\'s reference CLI harness with skills and hooks.' },
      ],
    }) }],
  })
}

function mockSkill() {
  injectMockToolResult({
    name: 'skill',
    args: { name: 'verify' },
    content: [{ type: 'text', text: '# verify\n\nSkill body: exercises the change end-to-end.\n\n## Steps\n\n1. Read the diff.\n2. Drive the affected flow.\n3. Report observed behaviour.' }],
  })
}

function mockWorkflow() {
  injectMockToolResult({
    name: 'workflow',
    args: {
      name: 'ship-a-fix',
      phases: [
        { id: 'plan',   label: 'Plan',   status: 'done'    },
        { id: 'code',   label: 'Code',   status: 'done'    },
        { id: 'review', label: 'Review', status: 'running' },
        { id: 'merge',  label: 'Merge',  status: 'pending' },
      ],
    },
    content: [{ type: 'text', text: 'Workflow started. Review phase in progress.' }],
  })
}

function mockTaskLifecycle() {
  // Simulate a task_list snapshot, then two output ticks, then a kill.
  injectMockToolResult({
    name: 'task_list',
    args: {},
    content: [{ type: 'text', text: JSON.stringify({
      tasks: [
        { id: 'T-build',  name: 'npm run build', status: 'running', summary: 'compiling…' },
        { id: 'T-test',   name: 'node --test',   status: 'running', summary: '' },
        { id: 'T-dev',    name: 'vite dev',      status: 'running', summary: 'HMR ready on :5173' },
      ],
    }) }],
  })
  setTimeout(() => {
    injectMockToolResult({
      name: 'task_output',
      args: { taskId: 'T-build' },
      content: [{ type: 'text', text: 'built in 4.2s\nassets: 32' }],
    })
  }, 400)
  setTimeout(() => {
    injectMockToolResult({
      name: 'task_kill',
      args: { taskId: 'T-dev' },
      content: [{ type: 'text', text: 'ok' }],
    })
  }, 800)
}

// -- Batch 3: workflow 五族 + subagent fixture loaders. Each
// button pulls its inlined fixture from __dshDebugFixtures, mounts the
// workflow / subagent card into the Context Rail drawer body (batch 2's
// shared canvas), and — for the workflow variants — pipes the fixture's
// `events` array through onSessionEvent so the rail sees a green workflow
// dot and the tool/call marker in the stream lines up. The card lands in
// the drawer rather than the stream because §1.6 wants the workflow view
// as its own canvas alongside the timeline; a small "workflow ↗" line
// still lands in the stream so a reader knows where to look.
function mountBatch3Card(builderResult, { title, summaryLine, autoOpen = true } = {}) {
  const drawer = document.getElementById('context-rail-drawer')
  const body = document.getElementById('context-rail-drawer-body')
  if (!drawer || !body) return
  // Open the drawer if it's closed AND the caller wants auto-open. Team-lead
  // ruled (2026-07-17): subagent events don't auto-pop the rail — inline
  // trace is the primary render; the rail is L3 auxiliary. The
  // debug workflow buttons keep auto-open because clicking "mock workflow"
  // has no other visible effect.
  if (autoOpen && drawer.hidden) {
    drawer.hidden = false
    drawer.setAttribute('aria-hidden', 'false')
    const btn = document.getElementById('ctx-rail-btn')
    if (btn) btn.setAttribute('aria-expanded', 'true')
  }
  // Drop a stream marker FIRST so the follow-on refreshRailIfOpen tick
  // (triggered by onSessionEvent → updateContextMeter → refreshRailIfOpen)
  // finishes before we mount, otherwise it stomps our body back to the
  // rail projection and the drawer looks empty. mountBatch3Card runs
  // after the fixture events; this system-message tick is the LAST rail
  // refresh in the sequence, so the mount below sticks until the user
  // clicks Rail again.
  const sid = state.activeSessionId
  if (sid) {
    onSessionEvent(sid, {
      type: 'system/message',
      seq: -1,
      time: Date.now(),
      data: { text: `${title}${summaryLine ? ` — ${summaryLine}` : ''} · opened in Context Rail →` },
    })
  }
  // Replace the rail projection with the new card wrapped in a labelled
  // section. Clicking Rail again refreshes back to the timeline via
  // refreshRail(); the workflow view is a debug-driven view that stays
  // pinned until either another workflow load or a rail refresh.
  body.innerHTML = ''
  const wrap = document.createElement('div')
  wrap.className = 'context-rail-batch3-mount'
  const hdr = document.createElement('div')
  hdr.className = 'context-rail-batch3-header'
  hdr.textContent = title
  wrap.appendChild(hdr)
  wrap.appendChild(builderResult)
  body.appendChild(wrap)
}

function loadWorkflowFixture(key, kindLabel) {
  const fixtures = window.__dshDebugFixtures
  const view = window.__dshWorkflowView
  if (!fixtures || !view) { appendSystem('debug fixtures / workflow view unavailable'); return }
  const fx = fixtures.get(key)
  if (!fx) { appendSystem(`no fixture: ${key}`); return }
  const sid = state.activeSessionId
  // Fixture may carry an `events` array — pipe those through so the rail
  // sees the workflow tool/call and the stream shows the seed row. For the
  // seq fixture that's a tool/call + a handful of mock/workflow-step ticks;
  // the ticks don't render as stream cards themselves (renderer ignores
  // unknown event types) but the tool/call does and the rail classifier
  // now recognises the workflow family.
  if (sid && Array.isArray(fx.events)) {
    for (const ev of fx.events) onSessionEvent(sid, ev)
  }
  const card = view.buildWorkflowCard(document, fx.workflow, {
    isMock: fx._mock === true,
    showReplayBar: true,
    onStepClick: (stepId) => appendSystem(`step ${stepId} clicked`),
    onReplayMove: (stepId) => appendSystem(`replay → ${stepId}`),
  })
  const prog = view.summariseWorkflowProgress(fx.workflow)
  mountBatch3Card(card, {
    title: `workflow · ${kindLabel} · ${fx.workflow.name}`,
    summaryLine: `${prog.done}/${prog.total} done${prog.running ? `, ${prog.running} running` : ''}${prog.failed ? `, ${prog.failed} failed` : ''}`,
  })
}

function loadSubagentFixture() {
  const fixtures = window.__dshDebugFixtures
  const view = window.__dshSubagentView
  if (!fixtures || !view) { appendSystem('debug fixtures / subagent view unavailable'); return }
  const seq = fixtures.get('subagentReturn')
  if (!Array.isArray(seq) || seq.length === 0) { appendSystem('no subagent fixture'); return }
  // The 1.4 fixture is a flat array. First entry is the subagent.started
  // notification, last is subagent.finished; middle entries are the child
  // session events. Split them so buildSubagentCard sees the shape it
  // expects.
  const started = seq.find(e => e && e.method === 'subagent.started')
  const finished = seq.find(e => e && e.method === 'subagent.finished')
  const childEvents = seq.filter(e => e && !e.method)
  const spec = {
    parentSessionId: (started && started.params && started.params.parentSessionId) || '',
    childSessionId: (started && started.params && started.params.childSessionId) || '',
    provider: (finished && finished.params && finished.params.provider) || 'in-process',
    status: (finished && finished.params && finished.params.status) || 'running',
    childEvents,
    lastAssistantMessage: (finished && finished.params && finished.params.lastAssistantMessage) || null,
  }
  const card = view.buildSubagentCard(document, spec, {})
  // Team-lead ruling (2026-07-17): subagent events don't auto-pop the rail
  // — inline trace is the primary render, rail is L3 auxiliary.
  // The debug button still mounts the card into the rail body so it's
  // available when the user opens the rail themselves.
  mountBatch3Card(card, { title: `subagent · ${spec.childSessionId}`, autoOpen: false })
  appendSystem(`subagent fixture loaded (open Context Rail to view)`)
}
