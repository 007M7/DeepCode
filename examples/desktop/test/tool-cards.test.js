// Tool render-intent cards unit tests. Runs under `node --test`, no Electron.
//
// Shares the DOM-shim approach with widgets.test.js — see that file's
// comments for why we hand-roll a `document` instead of pulling in jsdom.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

function makeShim() {
  function make(tagName) {
    const el = {
      tagName: String(tagName).toUpperCase(),
      children: [],
      attrs: {},
      style: {},
      dataset: {},
      classList: {
        _s: new Set(),
        add(...names) { for (const n of names) this._s.add(n) },
        remove(...names) { for (const n of names) this._s.delete(n) },
        contains(n) { return this._s.has(n) },
        toggle(n) { if (this._s.has(n)) this._s.delete(n); else this._s.add(n) },
      },
      _text: '',
      get textContent() { return this._text },
      set textContent(v) { this._text = String(v); this.children = [] },
      set className(v) { this._className = String(v); for (const c of String(v).split(/\s+/)) this.classList.add(c) },
      get className() { return this._className || '' },
      setAttribute(k, v) { this.attrs[k] = String(v) },
      appendChild(c) { this.children.push(c); return c },
      append(...cs) { for (const c of cs) this.children.push(c) },
      addEventListener() { /* no-op */ },
      querySelector(sel) {
        // Only supports simple class selectors we use ('.card-code-dispatch').
        const cls = String(sel).replace(/^\./, '')
        function search(node) {
          if (!node || !node.children) return null
          for (const c of node.children) {
            if (c.classList && c.classList.contains(cls)) return c
            const hit = search(c)
            if (hit) return hit
          }
          return null
        }
        return search(this)
      },
    }
    return el
  }
  const doc = {
    createElement: (t) => make(t),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
  }
  return { doc }
}

function loadCards() {
  const p = require.resolve('../src/renderer/tool-cards.js')
  delete require.cache[p]
  return require('../src/renderer/tool-cards.js')
}

function walk(node, pred, out = []) {
  if (!node || !node.tagName) return out
  if (pred(node)) out.push(node)
  for (const c of node.children || []) walk(c, pred, out)
  return out
}

// ----- families --------------------------------------------------------------

test('toolFamilyFor: bash/edit/read/web_search/skill/subagent/todo_write/cordis_*/run_code all map', () => {
  global.document = makeShim().doc
  const { toolFamilyFor } = loadCards()
  assert.equal(toolFamilyFor('bash').className, 'family-bash')
  assert.equal(toolFamilyFor('edit').className, 'family-fs')
  assert.equal(toolFamilyFor('read').className, 'family-fs')
  assert.equal(toolFamilyFor('write').className, 'family-fs')
  assert.equal(toolFamilyFor('web_search').className, 'family-web')
  assert.equal(toolFamilyFor('web_fetch').className, 'family-web')
  assert.equal(toolFamilyFor('skill').className, 'family-skill')
  assert.equal(toolFamilyFor('subagent').className, 'family-subagent')
  assert.equal(toolFamilyFor('todo_write').className, 'family-todo')
  assert.equal(toolFamilyFor('cordis_inspect').className, 'family-cordis')
  assert.equal(toolFamilyFor('cordis_mount').className, 'family-cordis')
  assert.equal(toolFamilyFor('run_code').className, 'family-code')
})

test('toolFamilyFor: unknown tool name returns null (generic fall-through)', () => {
  global.document = makeShim().doc
  const { toolFamilyFor } = loadCards()
  assert.equal(toolFamilyFor('made_up_tool'), null)
  assert.equal(toolFamilyFor(undefined), null)
  assert.equal(toolFamilyFor(''), null)
})

// ----- terminal card ---------------------------------------------------------

test('terminal card: stamps `data-tool-card-family="bash"` so QA probes can find it', () => {
  // Round-visual N1 (2026-07-16). Terminal cards are dispatched only from
  // bash-family tool/results, so the hook is hard-coded to 'bash'. See the
  // matching hook on the parent `.tool-block` inside renderer.js
  // appendToolCall — probes that walk into the card node directly still get
  // the family without climbing back up the DOM.
  global.document = makeShim().doc
  const { renderTerminalCard } = loadCards()
  const el = renderTerminalCard({ card: 'terminal', output: 'ok', exitCode: 0 })
  assert.equal(el.attrs['data-tool-card-family'], 'bash')
})

test('diff card: stamps `data-tool-card-family="fs"` so QA probes can find it', () => {
  // Round-visual N1: diff cards fire only from fs-family (read/write/edit)
  // tool/results. Same rationale as the terminal-card hook.
  global.document = makeShim().doc
  const { renderDiffCard } = loadCards()
  const el = renderDiffCard({ card: 'diff', diffs: [] })
  assert.equal(el.attrs['data-tool-card-family'], 'fs')
})

test('terminal card: renders output verbatim in a <pre> with an exit-0 badge', () => {
  global.document = makeShim().doc
  const { renderTerminalCard } = loadCards()
  const el = renderTerminalCard({ card: 'terminal', output: 'hello\nworld', exitCode: 0 })
  const pres = walk(el, (n) => n.tagName === 'PRE')
  assert.equal(pres.length, 1)
  assert.equal(pres[0]._text, 'hello\nworld')
  const badges = walk(el, (n) => n.classList && n.classList.contains('card-badge'))
  assert.equal(badges.length, 1)
  assert.match(badges[0]._text, /exit 0/)
  assert.ok(badges[0].classList.contains('ok'))
})

test('terminal card: non-zero exit code uses the err class + shows the code', () => {
  global.document = makeShim().doc
  const { renderTerminalCard } = loadCards()
  const el = renderTerminalCard({ card: 'terminal', output: 'boom', exitCode: 137 })
  const badge = walk(el, (n) => n.classList && n.classList.contains('card-badge'))[0]
  assert.ok(badge.classList.contains('err'))
  assert.equal(badge._text, 'exit 137')
})

test('terminal card: signal chip alongside missing exitCode', () => {
  global.document = makeShim().doc
  const { renderTerminalCard } = loadCards()
  const el = renderTerminalCard({ card: 'terminal', output: '', signal: 'SIGTERM' })
  const sig = walk(el, (n) => n.classList && n.classList.contains('sig'))
  assert.equal(sig.length, 1)
  assert.equal(sig[0]._text, 'SIGTERM')
})

test('terminal card: missing output renders a placeholder, not an empty pre', () => {
  global.document = makeShim().doc
  const { renderTerminalCard } = loadCards()
  const el = renderTerminalCard({ card: 'terminal', exitCode: 0 })
  const pre = walk(el, (n) => n.tagName === 'PRE')[0]
  assert.equal(pre._text, '(no output)')
})

// ----- diff card -------------------------------------------------------------

test('diff card: new-file (oldText === null) renders every line as an addition', () => {
  global.document = makeShim().doc
  const { renderDiffCard } = loadCards()
  const el = renderDiffCard({
    card: 'diff',
    title: 'Write foo.txt',
    diffs: [{ path: 'foo.txt', oldText: null, newText: 'a\nb\nc' }],
  })
  const adds = walk(el, (n) => n.classList && n.classList.contains('add') && n.classList.contains('card-diff-line'))
  assert.equal(adds.length, 3)
  const dels = walk(el, (n) => n.classList && n.classList.contains('del') && n.classList.contains('card-diff-line'))
  assert.equal(dels.length, 0)
  const newBadge = walk(el, (n) => n.classList && n.classList.contains('ok') && n._text === 'new')
  assert.equal(newBadge.length, 1)
})

test('diff card: single-line replace shows one del + one add + surrounding context', () => {
  global.document = makeShim().doc
  const { renderDiffCard } = loadCards()
  const el = renderDiffCard({
    card: 'diff',
    diffs: [{ path: 'x.txt', oldText: 'alpha\nbeta\ngamma', newText: 'alpha\nBETA\ngamma' }],
  })
  const rows = walk(el, (n) => n.classList && n.classList.contains('card-diff-line'))
  const kinds = rows.map((r) => (r.classList.contains('add') ? 'add' : r.classList.contains('del') ? 'del' : 'ctx'))
  // LCS: ctx alpha, del beta, add BETA, ctx gamma
  assert.deepEqual(kinds, ['ctx', 'del', 'add', 'ctx'])
})

test('diff card: empty diffs list renders a "(no changes)" placeholder', () => {
  global.document = makeShim().doc
  const { renderDiffCard } = loadCards()
  const el = renderDiffCard({ card: 'diff', diffs: [] })
  const empties = walk(el, (n) => n.classList && n.classList.contains('card-diff-empty'))
  assert.equal(empties.length, 1)
})

test('diff card: title is shown when present, omitted when absent', () => {
  global.document = makeShim().doc
  const { renderDiffCard } = loadCards()
  const withTitle = renderDiffCard({ card: 'diff', title: 'Edit foo', diffs: [] })
  const titles = walk(withTitle, (n) => n.classList && n.classList.contains('card-diff-title'))
  assert.equal(titles.length, 1)
  assert.equal(titles[0]._text, 'Edit foo')
  const noTitle = renderDiffCard({ card: 'diff', diffs: [] })
  const emptyTitles = walk(noTitle, (n) => n.classList && n.classList.contains('card-diff-title'))
  assert.equal(emptyTitles.length, 0)
})

test('diffLines: order and kinds match the classic LCS backtrack', () => {
  global.document = makeShim().doc
  const { diffLines } = loadCards()
  const out = diffLines(['a', 'b', 'c'], ['a', 'x', 'c'])
  assert.deepEqual(out, [
    { kind: 'ctx', text: 'a' },
    { kind: 'del', text: 'b' },
    { kind: 'add', text: 'x' },
    { kind: 'ctx', text: 'c' },
  ])
  assert.deepEqual(diffLines([], ['a']), [{ kind: 'add', text: 'a' }])
  assert.deepEqual(diffLines(['a'], []), [{ kind: 'del', text: 'a' }])
  assert.deepEqual(diffLines([], []), [])
})

// ----- code-dispatch fan-out -------------------------------------------------

test('appendCodeDispatch: first call clears placeholder + creates the list header', () => {
  global.document = makeShim().doc
  const { appendCodeDispatch } = loadCards()
  const box = document.createElement('div')
  box.textContent = '…'
  appendCodeDispatch(box, { name: 'bash', subCallId: 'sc1', isError: false, resultSummary: 'ok' })
  const header = walk(box, (n) => n.classList && n.classList.contains('card-code-dispatch-header'))
  assert.equal(header.length, 1)
  const rows = walk(box, (n) => n.classList && n.classList.contains('card-code-dispatch-row'))
  assert.equal(rows.length, 1)
  assert.ok(rows[0].classList.contains('ok'))
  const name = walk(rows[0], (n) => n.classList && n.classList.contains('card-code-dispatch-name'))[0]
  assert.equal(name._text, 'bash')
})

test('appendCodeDispatch: second call reuses the same list (no double header)', () => {
  global.document = makeShim().doc
  const { appendCodeDispatch } = loadCards()
  const box = document.createElement('div')
  appendCodeDispatch(box, { name: 'read', subCallId: 'a', isError: false, resultSummary: 'ok' })
  appendCodeDispatch(box, { name: 'edit', subCallId: 'b', isError: true,  resultSummary: 'no match' })
  const headers = walk(box, (n) => n.classList && n.classList.contains('card-code-dispatch-header'))
  assert.equal(headers.length, 1, 'header should not duplicate')
  const rows = walk(box, (n) => n.classList && n.classList.contains('card-code-dispatch-row'))
  assert.equal(rows.length, 2)
  assert.ok(rows[1].classList.contains('err'))
})

// ----- durationMs pill (Ticket D) -------------------------------------------

test('formatDurationLabel: sub-second stays in ms, 1s < X < 60s uses N.Ns', () => {
  global.document = makeShim().doc
  const { formatDurationLabel } = loadCards()
  assert.equal(formatDurationLabel(0), '0ms')
  assert.equal(formatDurationLabel(37), '37ms')
  assert.equal(formatDurationLabel(999), '999ms')
  assert.equal(formatDurationLabel(1000), '1.0s')
  assert.equal(formatDurationLabel(1500), '1.5s')
  assert.equal(formatDurationLabel(59900), '59.9s')
})

test('formatDurationLabel: minute + hour scales use compound labels', () => {
  global.document = makeShim().doc
  const { formatDurationLabel } = loadCards()
  assert.equal(formatDurationLabel(60_000), '1m00s')
  assert.equal(formatDurationLabel(75_000), '1m15s')
  assert.equal(formatDurationLabel(59 * 60_000 + 30_000), '59m30s')
  assert.equal(formatDurationLabel(60 * 60_000), '1h00m')
  assert.equal(formatDurationLabel(3 * 60 * 60_000 + 7 * 60_000), '3h07m')
})

test('formatDurationLabel: rejects non-finite / negative to empty string', () => {
  global.document = makeShim().doc
  const { formatDurationLabel } = loadCards()
  assert.equal(formatDurationLabel(undefined), '')
  assert.equal(formatDurationLabel(null), '')
  assert.equal(formatDurationLabel(NaN), '')
  assert.equal(formatDurationLabel(-1), '')
  assert.equal(formatDurationLabel('37'), '')
})

test('durationFromToolResult: reads data.durationMs, then meta.durationMs, else null', () => {
  global.document = makeShim().doc
  const { durationFromToolResult } = loadCards()
  assert.equal(durationFromToolResult({ durationMs: 42 }), 42)
  assert.equal(durationFromToolResult({ meta: { durationMs: 88 } }), 88)
  // Top-level wins when both present — matches audit doc: data.durationMs is
  // the canonical source; meta.durationMs is only a nesting fallback.
  assert.equal(durationFromToolResult({ durationMs: 10, meta: { durationMs: 999 } }), 10)
  assert.equal(durationFromToolResult({}), null)
  assert.equal(durationFromToolResult(null), null)
  assert.equal(durationFromToolResult({ durationMs: -5 }), null)
  assert.equal(durationFromToolResult({ meta: { durationMs: NaN } }), null)
})

// Shim `closest` + a `summary` child so applyToolDuration can drive the
// browser lookup path the renderer uses. The shim's element factory doesn't
// wire a `.closest`, so we hang one on the details node explicitly.
function makeToolBlockShim() {
  const { doc } = makeShim()
  global.document = doc
  const details = doc.createElement('details')
  details.classList.add('tool-block')
  const summary = doc.createElement('summary')
  details.appendChild(summary)
  // Support the two-step lookup path used by the renderer (`closest`
  // finds the enclosing block; `querySelector('summary')` finds the row).
  details.closest = (sel) => (sel === '.tool-block' ? details : null)
  details.querySelector = (sel) => (sel === 'summary' ? summary : null)
  return { details, summary }
}

test('applyToolDuration: appends a .tool-duration pill with the formatted label', () => {
  const { applyToolDuration } = loadCards()
  const { details, summary } = makeToolBlockShim()
  const pill = applyToolDuration(details, 1500)
  assert.ok(pill, 'pill returned')
  assert.ok(summary.children.includes(pill))
  assert.equal(pill._text, '1.5s')
  assert.ok(pill.classList.contains('tool-duration'))
  assert.equal(pill.attrs.title, 'tool ran for 1.5s')
})

test('applyToolDuration: idempotent — second call updates label, no duplicate pill', () => {
  const { applyToolDuration } = loadCards()
  const { details, summary } = makeToolBlockShim()
  // Wire summary.querySelector so the second call finds the existing pill.
  const originalQS = summary.querySelector
  summary.querySelector = (sel) => {
    if (sel === '.tool-duration') {
      return summary.children.find((c) => c.classList && c.classList.contains('tool-duration')) || null
    }
    return originalQS ? originalQS.call(summary, sel) : null
  }
  applyToolDuration(details, 250)
  applyToolDuration(details, 60_000)
  const pills = summary.children.filter((c) => c.classList && c.classList.contains('tool-duration'))
  assert.equal(pills.length, 1, 'pill should update in place')
  assert.equal(pills[0]._text, '1m00s')
})

test('applyToolDuration: no-op on missing / bad inputs — no pill inserted', () => {
  const { applyToolDuration } = loadCards()
  const { details, summary } = makeToolBlockShim()
  assert.equal(applyToolDuration(details, undefined), null)
  assert.equal(applyToolDuration(details, -1), null)
  assert.equal(applyToolDuration(null, 100), null)
  assert.equal(summary.children.length, 0)
})

// ----- hunkize (Ticket #139 / clause 1.5 v2) --------------------------------

test('hunkize: identical files (all ctx) → no hunks', () => {
  global.document = makeShim().doc
  const { hunkize } = loadCards()
  const lines = [
    { kind: 'ctx', text: 'a' },
    { kind: 'ctx', text: 'b' },
    { kind: 'ctx', text: 'c' },
  ]
  assert.deepEqual(hunkize(lines, 3), [])
  assert.deepEqual(hunkize([], 3), [])
})

test('hunkize: single change gets ctx head + tail; header uses canonical shape', () => {
  global.document = makeShim().doc
  const { hunkize } = loadCards()
  const lines = [
    { kind: 'ctx', text: 'a' },
    { kind: 'ctx', text: 'b' },
    { kind: 'del', text: 'old' },
    { kind: 'add', text: 'new' },
    { kind: 'ctx', text: 'c' },
    { kind: 'ctx', text: 'd' },
  ]
  const hunks = hunkize(lines, 2)
  assert.equal(hunks.length, 1)
  assert.equal(hunks[0].lines.length, 6)
  // old side: a,b,old,c,d = 5 rows starting at line 1
  // new side: a,b,new,c,d = 5 rows starting at line 1
  assert.equal(hunks[0].header, '@@ -1,5 +1,5 @@')
})

test('hunkize: two clusters far apart split into two hunks with fresh headers', () => {
  global.document = makeShim().doc
  const { hunkize } = loadCards()
  // Build: 3 ctx, 1 add, 10 ctx (gap > 2*ctx=6), 1 del, 3 ctx
  const lines = []
  for (let i = 0; i < 3; i++) lines.push({ kind: 'ctx', text: `h${i}` })
  lines.push({ kind: 'add', text: 'A' })
  for (let i = 0; i < 10; i++) lines.push({ kind: 'ctx', text: `m${i}` })
  lines.push({ kind: 'del', text: 'D' })
  for (let i = 0; i < 3; i++) lines.push({ kind: 'ctx', text: `t${i}` })
  const hunks = hunkize(lines, 3)
  assert.equal(hunks.length, 2, 'gap > 2*ctx → split')
  // First hunk: h0,h1,h2,A,m0,m1,m2 = 7 rows; old=6 (no A), new=7
  assert.equal(hunks[0].header, '@@ -1,6 +1,7 @@')
  // Second hunk starts after the 10-ctx gap. Old:new counter positions:
  //   before hunk1: old=0,new=0. After hunk1's 7 rows (6 old, 7 new): old=6,new=7.
  //   Then hunk2 head-skip walks `end`=7 → next cluster start. We're
  //   asserting the header exists + shape parses; exact numbers depend on
  //   the internal counter which we already exercise via the first hunk.
  assert.match(hunks[1].header, /^@@ -\d+,\d+ \+\d+,\d+ @@$/)
})

test('hunkize: two changes close together stay in one hunk', () => {
  global.document = makeShim().doc
  const { hunkize } = loadCards()
  const lines = [
    { kind: 'ctx', text: 'a' },
    { kind: 'add', text: 'A' },
    { kind: 'ctx', text: 'b' },
    { kind: 'ctx', text: 'c' },
    { kind: 'del', text: 'D' },
    { kind: 'ctx', text: 'd' },
  ]
  // ctx=3 → gap between A(idx1) and D(idx4) is 2 rows ≤ 2*3 → same hunk.
  const hunks = hunkize(lines, 3)
  assert.equal(hunks.length, 1)
})

// ----- diff card CodeSandbox layout -----------------------------------------

test('diff card: single file → no file tree, pane inline', () => {
  global.document = makeShim().doc
  const { renderDiffCard } = loadCards()
  const el = renderDiffCard({
    card: 'diff',
    diffs: [{ path: 'a.js', oldText: 'x', newText: 'y' }],
  })
  const trees = walk(el, (n) => n.classList && n.classList.contains('card-diff-tree'))
  assert.equal(trees.length, 0, 'no tree for 1 file')
  const panes = walk(el, (n) => n.classList && n.classList.contains('card-diff-pane'))
  assert.equal(panes.length, 1)
})

test('diff card: multi-file renders file tree + pane (default first file active)', () => {
  global.document = makeShim().doc
  const { renderDiffCard } = loadCards()
  const el = renderDiffCard({
    card: 'diff',
    diffs: [
      { path: 'a.js', oldText: 'x', newText: 'y' },
      { path: 'b.js', oldText: null, newText: 'new file' },
      { path: 'c.js', oldText: '1\n2', newText: '1\n2\n3' },
    ],
  })
  const trees = walk(el, (n) => n.classList && n.classList.contains('card-diff-tree'))
  assert.equal(trees.length, 1)
  const rows = walk(el, (n) => n.classList && n.classList.contains('card-diff-tree-row'))
  assert.equal(rows.length, 3, '3 tree rows')
  const active = rows.filter((r) => r.classList.contains('active'))
  assert.equal(active.length, 1)
  assert.strictEqual(active[0], rows[0], 'first row starts active')
  // File paths shown in tree
  const paths = walk(el, (n) => n.classList && n.classList.contains('card-diff-tree-path')).map((n) => n._text)
  assert.deepEqual(paths, ['a.js', 'b.js', 'c.js'])
  // Counts: new file gets 'new'; others get +N −M
  const counts = walk(el, (n) => n.classList && n.classList.contains('card-diff-tree-count')).map((n) => n._text)
  assert.equal(counts[1], 'new')
  assert.match(counts[0], /^\+\d+ −\d+$/)
})

test('diff card: hunk cap — 25 hunks renders 20 + reveal button for the tail', () => {
  global.document = makeShim().doc
  const { renderDiffCard, HUNK_CAP } = loadCards()
  // Build oldText/newText that produce many distant hunks: change every 20 lines
  // (gap way bigger than 2*ctx=6) so hunkize splits them.
  const N = 25
  const oldLines = []
  const newLines = []
  for (let i = 0; i < N; i++) {
    // Each block: 10 identical ctx rows, then 1 changed row.
    for (let j = 0; j < 10; j++) {
      oldLines.push(`p${i}-${j}`)
      newLines.push(`p${i}-${j}`)
    }
    oldLines.push(`OLD-${i}`)
    newLines.push(`NEW-${i}`)
  }
  const el = renderDiffCard({
    card: 'diff',
    diffs: [{ path: 'big.txt', oldText: oldLines.join('\n'), newText: newLines.join('\n') }],
  })
  const hunkDetails = walk(el, (n) => n.classList && n.classList.contains('card-diff-hunk'))
  assert.equal(hunkDetails.length, HUNK_CAP, `first ${HUNK_CAP} hunks rendered`)
  const reveal = walk(el, (n) => n.classList && n.classList.contains('card-diff-hunk-more'))
  assert.equal(reveal.length, 1)
  assert.match(reveal[0]._text, /Show 5 more hunks/)
})

test('diff card: first hunk opens by default, rest closed', () => {
  global.document = makeShim().doc
  const { renderDiffCard } = loadCards()
  // Two well-separated changes → two hunks.
  const oldLines = ['a', 'b', 'c', 'X',       'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'Y', 'n']
  const newLines = ['a', 'b', 'c', 'X-mod',   'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'Y-mod', 'n']
  const el = renderDiffCard({
    card: 'diff',
    diffs: [{ path: 'multi.txt', oldText: oldLines.join('\n'), newText: newLines.join('\n') }],
  })
  const hunkDetails = walk(el, (n) => n.classList && n.classList.contains('card-diff-hunk'))
  assert.equal(hunkDetails.length, 2, 'expected 2 hunks')
  assert.ok('open' in hunkDetails[0].attrs, 'first hunk open by default')
  assert.ok(!('open' in hunkDetails[1].attrs), 'second hunk closed')
})

// ----- JSON badge + drawer --------------------------------------------------

test('renderJsonBadge: returns a "{ }" button that fires onClick without bubbling', () => {
  global.document = makeShim().doc
  const { renderJsonBadge } = loadCards()
  let clicked = 0
  const btn = renderJsonBadge(() => { clicked++ })
  assert.equal(btn.tagName, 'BUTTON')
  assert.equal(btn._text, '{ }')
  assert.ok(btn.classList.contains('tool-json-badge'))
  // Simulate a click: the badge attaches its own listener via addEventListener;
  // the shim's addEventListener is a no-op, so we invoke the stored handler
  // directly. Verifying onClick fires + stopPropagation is invoked.
  let stopped = 0, prevented = 0
  const fakeEvent = {
    stopPropagation() { stopped++ },
    preventDefault() { prevented++ },
  }
  // The badge wraps the caller's onClick; we can't reach it via the shim.
  // Instead verify the wrapper by re-wiring the addEventListener to capture.
  // Reload with a document that records handlers.
  const doc = makeShim().doc
  global.document = doc
  const { renderJsonBadge: rjb2 } = loadCards()
  let handlers = []
  const origMake = doc.createElement
  doc.createElement = (t) => {
    const el = origMake(t)
    el.addEventListener = (evt, fn) => { if (evt === 'click') handlers.push(fn) }
    return el
  }
  const btn2 = rjb2(() => { clicked++ })
  assert.equal(handlers.length, 1, 'click handler registered')
  handlers[0](fakeEvent)
  assert.equal(clicked, 1)
  assert.equal(stopped, 1, 'propagation stopped')
  assert.equal(prevented, 1, 'default prevented')
  // Cleanup so later tests get a fresh document.
  global.document = undefined
})

// Shim a minimal drawer + getElementById for openJsonDrawer / closeJsonDrawer.
function makeDrawerShim() {
  const { doc } = makeShim()
  global.document = doc
  const drawer = doc.createElement('aside')
  drawer.id = 'tool-json-drawer'
  const title = doc.createElement('div')
  title.className = 'tool-json-drawer-title'
  drawer.appendChild(title)
  const callPre = doc.createElement('pre')
  callPre.className = 'tool-json-pane call'
  callPre.attrs['data-json-pane'] = 'call'
  drawer.appendChild(callPre)
  const resultPre = doc.createElement('pre')
  resultPre.className = 'tool-json-pane result'
  resultPre.attrs['data-json-pane'] = 'result'
  drawer.appendChild(resultPre)
  // classList tracking
  drawer.setAttribute = (k, v) => { drawer.attrs[k] = String(v) }
  // querySelector: handle .class and [data-json-pane="x"]
  drawer.querySelector = (sel) => {
    if (sel === '.tool-json-drawer-title') return title
    const m = /^\[data-json-pane="(\w+)"\]$/.exec(sel)
    if (m) return m[1] === 'call' ? callPre : resultPre
    return null
  }
  doc.getElementById = (id) => (id === 'tool-json-drawer' ? drawer : null)
  // Record document-level listeners so we can assert cleanup.
  const listeners = { keydown: [] }
  doc.addEventListener = (evt, fn) => { (listeners[evt] || (listeners[evt] = [])).push(fn) }
  doc.removeEventListener = (evt, fn) => {
    const arr = listeners[evt]
    if (!arr) return
    const i = arr.indexOf(fn)
    if (i >= 0) arr.splice(i, 1)
  }
  return { doc, drawer, title, callPre, resultPre, listeners }
}

test('openJsonDrawer: fills title + call + result and adds `open` class', () => {
  const { drawer, title, callPre, resultPre } = makeDrawerShim()
  const { openJsonDrawer } = loadCards()
  const ret = openJsonDrawer({
    title: 'tool: bash',
    call: '{"command":"ls"}',
    result: { ok: true, content: [{ type: 'text', text: 'a\nb' }] },
  })
  assert.strictEqual(ret, drawer)
  assert.equal(title._text, 'tool: bash')
  assert.match(callPre._text, /"command": "ls"/)
  assert.match(resultPre._text, /"ok": true/)
  assert.ok(drawer.classList.contains('open'))
  assert.equal(drawer.attrs['aria-hidden'], 'false')
})

test('openJsonDrawer: missing payloads render explicit placeholders (no crash)', () => {
  const { callPre, resultPre } = makeDrawerShim()
  const { openJsonDrawer } = loadCards()
  openJsonDrawer({ title: 't', call: null, result: undefined })
  assert.equal(callPre._text, '(no call payload captured)')
  assert.equal(resultPre._text, '(result pending)')
})

test('closeJsonDrawer: removes `open`, aria-hidden true, unbinds keydown', () => {
  const { drawer, listeners } = makeDrawerShim()
  const { openJsonDrawer, closeJsonDrawer } = loadCards()
  openJsonDrawer({ title: 't', call: {}, result: {} })
  assert.equal((listeners.keydown || []).length, 1, 'esc handler bound on open')
  closeJsonDrawer()
  assert.ok(!drawer.classList.contains('open'))
  assert.equal(drawer.attrs['aria-hidden'], 'true')
  assert.equal((listeners.keydown || []).length, 0, 'esc handler unbound on close')
})

test('openJsonDrawer: missing drawer element in DOM returns null (guard)', () => {
  const { doc } = makeShim()
  global.document = doc
  doc.getElementById = () => null
  const { openJsonDrawer, closeJsonDrawer } = loadCards()
  assert.equal(openJsonDrawer({ title: 't' }), null)
  // closeJsonDrawer should be a no-op too, not throw.
  closeJsonDrawer()
})

// 2026-07-18 P0 hotfix (payload-controls drawer overlap): the earlier
// buildOrRefreshDrawerControls inserted the util's controls cluster as a
// bare child of `.tool-json-section` and relied on `float:right +
// margin-top:-18px` to shove it onto the <summary> baseline — which
// overlapped the summary's meta annotation
// `(content · meta · isError · error · durationMs)` (the actual P0 the
// user hit). The hotfix wraps controls in a
// `.tool-json-section-controls` strip that sits between summary and pre
// as its own flex row. This test locks the new structural invariant so
// nobody re-introduces the direct-child insertion.
test('openJsonDrawer: drawer controls sit in .tool-json-section-controls strip (not as bare section child)', () => {
  const { drawer, callPre, resultPre } = makeDrawerShim()
  const pcApi = require('../src/renderer/payload-controls.js')
  global.window = { __dshPayloadControls: pcApi }
  // Give the pre nodes a synthetic .tool-json-section closest() so
  // buildOrRefreshDrawerControls can locate the section wrapper.
  const doc = global.document
  function wireSection(section, preNode) {
    section.className = 'tool-json-section'
    section.children = []
    section.appendChild = (n) => { section.children.push(n); n.parentNode = section; return n }
    section.appendChild(preNode)
    preNode.closest = (sel) => (sel === '.tool-json-section' ? section : null)
    section.querySelector = (sel) => {
      if (sel.startsWith('.tool-json-section-controls')) {
        return section.children.find(c => (c.className || '').includes('tool-json-section-controls')) || null
      }
      return null
    }
    section.insertBefore = (n, ref) => {
      const idx = section.children.indexOf(ref)
      section.children.splice(idx >= 0 ? idx : section.children.length, 0, n)
      n.parentNode = section
    }
    // matches the removeChild contract our dedupe path calls into
    const origRemoveChild = (c) => { const i = section.children.indexOf(c); if (i >= 0) section.children.splice(i, 1) }
    section.removeChild = origRemoveChild
  }
  const callSection = doc.createElement('details')
  wireSection(callSection, callPre)
  const resultSection = doc.createElement('details')
  wireSection(resultSection, resultPre)

  const { openJsonDrawer } = loadCards()
  openJsonDrawer({ title: 't', call: { name: 'bash' }, result: { content: 'ok' } })

  // Contract 1: the controls live in a `.tool-json-section-controls` strip.
  const callStrip = callSection.children.find(c => (c.className || '').includes('tool-json-section-controls'))
  const resultStrip = resultSection.children.find(c => (c.className || '').includes('tool-json-section-controls'))
  assert.ok(callStrip, 'call section grew a controls strip wrapper')
  assert.ok(resultStrip, 'result section grew a controls strip wrapper')

  // Contract 2: NO bare `.payload-controls` child directly under the section
  // (would revert to the float:right + margin-top:-18px overlap regime).
  const bareCallCtrl = callSection.children.find(c => (c.className || '').includes('payload-controls') && !(c.className || '').includes('tool-json-section-controls'))
  const bareResultCtrl = resultSection.children.find(c => (c.className || '').includes('payload-controls') && !(c.className || '').includes('tool-json-section-controls'))
  assert.equal(bareCallCtrl, undefined, 'no bare payload-controls under call section')
  assert.equal(bareResultCtrl, undefined, 'no bare payload-controls under result section')

  // Contract 3: strip carries `data-drawer-controls` marker so idempotent
  // re-open tears down the prior strip cleanly.
  assert.equal(callStrip.attrs['data-drawer-controls'], 'call')
  assert.equal(resultStrip.attrs['data-drawer-controls'], 'result')

  // Contract 4: re-open replaces the strip in place — no duplicate.
  openJsonDrawer({ title: 't', call: { name: 'edit' }, result: { content: 'ok2' } })
  const callStrips = resultSection.children.filter(c => (c.className || '').includes('tool-json-section-controls'))
  assert.ok(callStrips.length <= 1, `re-open must not stack strips (got ${callStrips.length})`)

  delete global.window
})
