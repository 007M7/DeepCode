// Tool render-intent cards: turns the `tool/result.meta` render-intent view
// (`ToolResultView` in packages/core/tools/src/presentation.ts) into inline DOM.
//
// Design contract (see docs/capability-ui-coverage.md §2 for the audit that
// drove this):
//   - Input is a `view` object with `card: 'terminal' | 'diff'`; output is DOM.
//   - Everything textual goes through `textContent`; no `innerHTML` from
//     any field the tool controls. Same safety edge as `widgets.js`.
//   - Unknown-shape input yields a plain fallback — never throws — because
//     any tool can synthesise a view and we don't want a bad shape to break
//     the stream.
//
// Wire arrival (already on the wire today; the renderer just wasn't reading
// the card discriminant beyond `widget`):
//   session.event { type: 'tool/result',
//     data: { meta: { card: 'terminal', output?, exitCode?, signal? } } }
//   session.event { type: 'tool/result',
//     data: { meta: { card: 'diff', title?, diffs: [{path, oldText|null, newText}] } } }
//
// Also owns the per-tool "family" band (icon + left border colour): a data
// map keyed by model-visible tool name. Unknown names fall through with no
// family styling — matches the `card: 'generic'` render intent.
//
// Also owns `tool/code-dispatch` fan-out: appends a sub-row inside the
// enclosing `run_code` tool block for every sub-call fired via Code Mode
// (packages/core/tools/src/code-mode.ts emits `parentCallId + subCallId`).

'use strict'

// -- per-tool family map -----------------------------------------------------
// Keyed by model-visible tool name (`tool/call.name`). New tools fall through
// to `null`, which the caller treats as "no family styling" (== generic card).
// Icons are single glyphs so no font work is needed; colours are CSS class
// names resolved in style.css so a theme swap is a one-file change.
// Icons here are typographic monochrome glyphs (no color-emoji). The visual
// identity of a family is now carried by the coloured left border + the label
// text; the glyph column exists only so families visually align at consistent
// width. Any change here should keep the character width at exactly one
// column (a two-char glyph pushes the row layout).
const TOOL_FAMILIES = Object.freeze({
  // bash family
  bash:           { icon: '>', className: 'family-bash', label: 'bash' },
  // fs family
  read:           { icon: '=', className: 'family-fs',   label: 'fs' },
  write:          { icon: '=', className: 'family-fs',   label: 'fs' },
  edit:           { icon: '=', className: 'family-fs',   label: 'fs' },
  // web family
  web_search:     { icon: '@', className: 'family-web',  label: 'web' },
  web_fetch:      { icon: '@', className: 'family-web',  label: 'web' },
  // skill loader
  skill:          { icon: '*', className: 'family-skill', label: 'skill' },
  // subagent
  subagent:       { icon: '&', className: 'family-subagent', label: 'subagent' },
  // todo write
  todo_write:     { icon: '#', className: 'family-todo', label: 'todo' },
  // cordis self-inspection
  cordis_inspect: { icon: '~', className: 'family-cordis', label: 'cordis' },
  cordis_mount:   { icon: '~', className: 'family-cordis', label: 'cordis' },
  cordis_unmount: { icon: '~', className: 'family-cordis', label: 'cordis' },
  // Code Mode dispatcher (fan-out target)
  run_code:       { icon: '$', className: 'family-code', label: 'code' },
})

/**
 * Look up the family descriptor for a tool name. Returns `null` for tools
 * that have no assigned family (the caller renders a generic card).
 * @param {string} name
 * @returns {{ icon: string, className: string, label: string } | null}
 */
function toolFamilyFor(name) {
  if (typeof name !== 'string') return null
  return TOOL_FAMILIES[name] || null
}

// -- terminal card -----------------------------------------------------------

/**
 * Render a `TerminalResultView` into a DOM node. Shape:
 *   { card: 'terminal', title?, output?, exitCode?, signal? }
 * A capable UI shows `output` in a monospace block with an exit-status pill.
 * @param {object} view
 * @returns {HTMLElement}
 */
function renderTerminalCard(view) {
  const el = document.createElement('div')
  el.className = 'card-terminal'
  // mirror the family hook the enclosing `.tool-block`
  // already carries so a probe that walks straight into the card node knows
  // it's a terminal-family surface without climbing back up the DOM.
  el.setAttribute('data-tool-card-family', 'bash')
  const output = view && typeof view.output === 'string' ? view.output : ''

  const pre = document.createElement('pre')
  pre.className = 'card-terminal-output'
  pre.textContent = output || '(no output)'
  el.appendChild(pre)

  const footer = document.createElement('div')
  footer.className = 'card-terminal-footer'

  if (view && Number.isFinite(view.exitCode)) {
    const badge = document.createElement('span')
    const ok = view.exitCode === 0
    badge.className = 'card-badge ' + (ok ? 'ok' : 'err')
    badge.textContent = ok ? `exit 0` : `exit ${view.exitCode}`
    footer.appendChild(badge)
  }
  if (view && typeof view.signal === 'string' && view.signal) {
    const chip = document.createElement('span')
    chip.className = 'card-badge sig'
    chip.textContent = view.signal
    footer.appendChild(chip)
  }
  if (footer.children.length > 0) el.appendChild(footer)

  return el
}

// -- diff card (CodeSandbox layout) ------------------------------------------
//
// Layout follows strategy-feature-list.md §1.5 (老板 CodeSandbox 定调):
//   - ≥2 files → left column shows a file tree (path + `+N −M`), right pane
//     shows the currently-selected file's diff. Clicking a tree row swaps
//     pane content in place (never rebuild the whole card — the parent's
//     `.tool-block` state is fragile enough already).
//   - 1 file  → no tree, just the pane inline (avoid the noise of a one-row
//     column). File header still shows the path + counts so readers can
//     tell what changed without opening every hunk.
//   - Every hunk is a `<details>` closed by default with a `@@ old,+n new,+m @@`
//     summary. The FIRST hunk in the selected file opens by default so the
//     card isn't "empty at first glance"; the rest wait for a click.
//   - Beyond `HUNK_CAP` hunks (currently 20) the tail collapses behind a
//     "还有 N 段，展开" reveal — matches 老板 "绝不全塞满" rule.
//
// The old flat "one file after another with every line always shown" layout
// (batch A) is retired.

const HUNK_CAP = 20
// Number of context lines to keep on either side of a run of add/del rows
// when hunkizing. Standard `diff -U3` convention.
const HUNK_CTX = 3

/**
 * Render a `DiffResultView` into a DOM node. Shape:
 *   { card: 'diff', title?, diffs: [{ path, oldText: string|null, newText: string }] }
 * `oldText === null` means new-file (every line is an addition). Otherwise we
 * run a line-level LCS to build a unified-style hunk.
 * @param {object} view
 * @returns {HTMLElement}
 */
function renderDiffCard(view) {
  const el = document.createElement('div')
  el.className = 'card-diff'
  // mirror the family hook the enclosing `.tool-block`
  // carries. fs-family (read/write/edit) is the sole diff-card source.
  el.setAttribute('data-tool-card-family', 'fs')

  if (view && typeof view.title === 'string' && view.title) {
    const title = document.createElement('div')
    title.className = 'card-diff-title'
    title.textContent = view.title
    el.appendChild(title)
  }

  const diffs = view && Array.isArray(view.diffs) ? view.diffs : []
  if (diffs.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'card-diff-empty'
    empty.textContent = '(no changes)'
    el.appendChild(empty)
    return el
  }

  // Precompute per-file line arrays + hunks + counts once so the tree can
  // show `+N −M` without re-diffing on every click. Feed the same shape into
  // the pane renderer whether or not we build a tree.
  const files = diffs.map((d) => prepareDiffFile(d))

  const body = document.createElement('div')
  body.className = 'card-diff-body-wrap'
  if (files.length > 1) body.classList.add('has-tree')

  let pane = null

  if (files.length > 1) {
    const tree = document.createElement('div')
    tree.className = 'card-diff-tree'
    const treeHeader = document.createElement('div')
    treeHeader.className = 'card-diff-tree-header'
    treeHeader.textContent = `${files.length} files changed`
    tree.appendChild(treeHeader)
    const rows = []
    files.forEach((f, i) => {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'card-diff-tree-row' + (i === 0 ? ' active' : '')
      const path = document.createElement('span')
      path.className = 'card-diff-tree-path'
      path.textContent = f.path
      const count = document.createElement('span')
      count.className = 'card-diff-tree-count'
      count.textContent = f.isNew ? 'new' : `+${f.plus} −${f.minus}`
      row.append(path, count)
      row.addEventListener('click', () => {
        if (row.classList.contains('active')) return
        for (const other of rows) other.classList.remove('active')
        row.classList.add('active')
        // Swap pane content in place. Rebuilding the whole card would drop
        // the `.tool-block` open state and any drawer wiring on the summary.
        pane.textContent = ''
        pane.appendChild(renderDiffPane(f))
      })
      rows.push(row)
      tree.appendChild(row)
    })
    body.appendChild(tree)
  }

  pane = document.createElement('div')
  pane.className = 'card-diff-pane'
  pane.appendChild(renderDiffPane(files[0]))
  body.appendChild(pane)
  el.appendChild(body)

  return el
}

// Turn a raw diff entry into the shape the pane + tree both consume. Pulled
// out so the tree can print `+N −M` without touching DOM, and so the pane
// can rehydrate on tree click without re-doing the LCS.
function prepareDiffFile(d) {
  const isNew = d && d.oldText === null
  const oldLines = isNew || !d ? [] : splitLines(String(d.oldText))
  const newLines = d ? splitLines(String(d.newText || '')) : []
  const lines = isNew
    ? newLines.map((l) => ({ kind: 'add', text: l }))
    : diffLines(oldLines, newLines)
  const hunks = hunkize(lines, HUNK_CTX)
  let plus = 0, minus = 0
  for (const ln of lines) {
    if (ln.kind === 'add') plus++
    else if (ln.kind === 'del') minus++
  }
  return {
    path: String(d && d.path != null ? d.path : '(unknown)'),
    isNew,
    lines,
    hunks,
    plus,
    minus,
  }
}

// Render a single file's pane: header (path + counts + `new` badge if
// applicable) + hunk-by-hunk body with tail-fold at HUNK_CAP.
function renderDiffPane(f) {
  const wrap = document.createElement('div')
  wrap.className = 'card-diff-file'

  const header = document.createElement('div')
  header.className = 'card-diff-file-header'
  const path = document.createElement('span')
  path.className = 'card-diff-file-path'
  path.textContent = f.path
  header.appendChild(path)

  const stats = document.createElement('span')
  stats.className = 'card-diff-file-stats'
  if (f.isNew) {
    const badge = document.createElement('span')
    badge.className = 'card-badge ok'
    badge.textContent = 'new'
    stats.appendChild(badge)
  }
  if (f.plus + f.minus > 0) {
    const s = document.createElement('span')
    s.className = 'card-diff-file-count'
    s.textContent = `+${f.plus} −${f.minus}`
    stats.appendChild(s)
  }
  header.appendChild(stats)
  wrap.appendChild(header)

  const body = document.createElement('div')
  body.className = 'card-diff-body'

  // No hunks means either "all context" (identical files, oldText===newText)
  // or a truly empty file — either way we skip the "@@" scaffolding and
  // render the raw lines. Keeps single-hunk edits looking uncluttered.
  if (f.hunks.length === 0) {
    for (const ln of f.lines) body.appendChild(renderDiffLine(ln))
    wrap.appendChild(body)
    return wrap
  }

  const visible = Math.min(f.hunks.length, HUNK_CAP)
  for (let i = 0; i < visible; i++) {
    body.appendChild(renderHunk(f.hunks[i], /* openByDefault= */ i === 0))
  }
  if (f.hunks.length > HUNK_CAP) {
    const tail = f.hunks.length - HUNK_CAP
    const reveal = document.createElement('button')
    reveal.type = 'button'
    reveal.className = 'card-diff-hunk-more'
    reveal.textContent = `Show ${tail} more hunk${tail === 1 ? '' : 's'}`
    reveal.addEventListener('click', () => {
      reveal.remove()
      for (let i = HUNK_CAP; i < f.hunks.length; i++) {
        body.appendChild(renderHunk(f.hunks[i], /* openByDefault= */ false))
      }
    })
    body.appendChild(reveal)
  }

  wrap.appendChild(body)
  return wrap
}

// Render one hunk as a <details> so the summary (@@ … @@) is always visible
// and the content collapses out of the way by default.
function renderHunk(h, openByDefault) {
  const det = document.createElement('details')
  det.className = 'card-diff-hunk'
  if (openByDefault) det.setAttribute('open', '')
  const sum = document.createElement('summary')
  sum.className = 'card-diff-hunk-summary'
  sum.textContent = h.header
  det.appendChild(sum)
  const inner = document.createElement('div')
  inner.className = 'card-diff-hunk-body'
  for (const ln of h.lines) inner.appendChild(renderDiffLine(ln))
  det.appendChild(inner)
  return det
}

function renderDiffLine(ln) {
  const row = document.createElement('div')
  row.className = 'card-diff-line ' + (ln.kind === 'add' ? 'add' : ln.kind === 'del' ? 'del' : 'ctx')
  const sigil = document.createElement('span')
  sigil.className = 'card-diff-sigil'
  sigil.textContent = ln.kind === 'add' ? '+' : ln.kind === 'del' ? '-' : ' '
  const text = document.createElement('span')
  text.className = 'card-diff-text'
  text.textContent = ln.text
  row.appendChild(sigil)
  row.appendChild(text)
  return row
}

/**
 * Turn a flat unified-diff line list into contiguous hunks with `ctx` head/tail
 * context. Emits `{header, lines, oldStart, oldCount, newStart, newCount}` per
 * hunk so the header can print the canonical `@@ -a,b +c,d @@` shape.
 *
 * A file with zero add/del rows (identical) yields `[]`. Two runs of changes
 * separated by more than 2*ctx context rows become two hunks; less than that
 * and they merge (matches how `diff -U3` behaves).
 *
 * @param {Array<{kind:string,text:string}>} lines
 * @param {number} ctx  — context rows kept on either side of a change run
 * @returns {Array<{header:string, lines:Array, oldStart:number, oldCount:number, newStart:number, newCount:number}>}
 */
function hunkize(lines, ctx) {
  if (!Array.isArray(lines) || lines.length === 0) return []
  const c = Number.isFinite(ctx) && ctx >= 0 ? Math.floor(ctx) : HUNK_CTX

  // First pass: find each "change" (add/del) index. If none, no hunks.
  const changeIdxs = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind === 'add' || lines[i].kind === 'del') changeIdxs.push(i)
  }
  if (changeIdxs.length === 0) return []

  // Cluster the change indices: a gap of more than 2*ctx pure-context rows
  // between two changes splits into separate hunks (each hunk gets `ctx` tail
  // on the earlier + `ctx` head on the later without overlap).
  const clusters = []
  let cur = [changeIdxs[0]]
  for (let k = 1; k < changeIdxs.length; k++) {
    const gap = changeIdxs[k] - changeIdxs[k - 1] - 1
    if (gap > 2 * c) {
      clusters.push(cur)
      cur = [changeIdxs[k]]
    } else {
      cur.push(changeIdxs[k])
    }
  }
  clusters.push(cur)

  // For each cluster, expand outward by ctx (clamped to file bounds) to grab
  // context lines, then slice + emit.
  const out = []
  // Running old/new line counters so hunk headers use the canonical shape.
  let oldLine = 1
  let newLine = 1
  let cursor = 0 // walking over `lines` to keep old/new counters accurate
  for (const cluster of clusters) {
    const start = Math.max(0, cluster[0] - c)
    const end = Math.min(lines.length, cluster[cluster.length - 1] + 1 + c)

    // Advance old/new counters up to `start` (rows we're skipping between
    // the last hunk and this one — all ctx rows given how we cluster).
    while (cursor < start) {
      const kind = lines[cursor].kind
      if (kind !== 'add') oldLine++
      if (kind !== 'del') newLine++
      cursor++
    }

    const slice = lines.slice(start, end)
    let oldCount = 0, newCount = 0
    for (const ln of slice) {
      if (ln.kind !== 'add') oldCount++
      if (ln.kind !== 'del') newCount++
    }
    const oldStart = oldLine
    const newStart = newLine
    const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`
    out.push({ header, lines: slice, oldStart, oldCount, newStart, newCount })

    // Advance the counters past this hunk so the next cluster's header is
    // correctly numbered.
    for (const ln of slice) {
      if (ln.kind !== 'add') oldLine++
      if (ln.kind !== 'del') newLine++
    }
    cursor = end
  }
  return out
}

// Split on \n keeping the split explicit; an empty string yields `[]` so a
// zero-line file doesn't render as one empty context line.
function splitLines(s) {
  if (s === '') return []
  return s.split('\n')
}

// Line-level Myers-lite: LCS via classic DP. O(n*m) memory — fine for the
// demo's file sizes (edit tool typically feeds hundreds of lines, not
// megabytes). Returns an ordered array of {kind, text}.
function diffLines(a, b) {
  const n = a.length
  const m = b.length
  if (n === 0) return b.map((t) => ({ kind: 'add', text: t }))
  if (m === 0) return a.map((t) => ({ kind: 'del', text: t }))

  // dp[i][j] = LCS length of a[i..] and b[j..]
  const dp = new Array(n + 1)
  for (let i = 0; i <= n; i++) dp[i] = new Int32Array(m + 1)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: 'ctx', text: a[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ kind: 'del', text: a[i] }); i++ }
    else { out.push({ kind: 'add', text: b[j] }); j++ }
  }
  while (i < n) { out.push({ kind: 'del', text: a[i] }); i++ }
  while (j < m) { out.push({ kind: 'add', text: b[j] }); j++ }
  return out
}

// -- durationMs pill ---------------------------------------------------------
//
// `tool/result.data.durationMs` (audit doc §2.3 GAP T1) is the tool's
// wall-clock runtime as measured by the agent loop. When present, we surface
// it as a small pill in the enclosing `.tool-block` summary line so a reader
// can spot slow tools without expanding the block. The value can also arrive
// nested under `meta.durationMs` — both are read, `data.durationMs` wins.

/**
 * Format a millisecond duration into a compact human label. The scales are
 * chosen to match how a reader eyeballs "was that snappy?":
 *   `<1000ms` → `NNNms`  (bash echoes, small edits)
 *   `<60s`    → `N.Ns`   (typical tool call)
 *   `<60m`    → `NmNNs`  (a slow long-poll or a big diff)
 *   otherwise → `NhNNm`  (background-agent territory)
 *
 * Non-finite / negative inputs return an empty string so the caller can
 * skip appending the pill entirely without a special case.
 * @param {number} ms
 * @returns {string}
 */
function formatDurationLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rs = Math.round(s - m * 60)
  if (m < 60) return `${m}m${String(rs).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  const rm = m - h * 60
  return `${h}h${String(rm).padStart(2, '0')}m`
}

/**
 * Extract a `durationMs` value from a `tool/result` event's data payload.
 * Reads two shapes (matches the audit doc §2.3 line 336):
 *   data.durationMs           — top-level (the shape agent-loop emits today)
 *   data.meta.durationMs      — nested under render-intent meta
 * Returns a non-negative finite number, or null if neither present or usable.
 * @param {object} data
 * @returns {number | null}
 */
function durationFromToolResult(data) {
  if (!data || typeof data !== 'object') return null
  const top = Number(data.durationMs)
  if (Number.isFinite(top) && top >= 0) return top
  const meta = data.meta
  if (meta && typeof meta === 'object') {
    const nested = Number(meta.durationMs)
    if (Number.isFinite(nested) && nested >= 0) return nested
  }
  return null
}

/**
 * Insert (or update) a duration pill inside a `.tool-block` summary line.
 * Idempotent — calling twice with the same block replaces the pill's text
 * rather than appending a second one (so a re-render on replay stays clean).
 * No-op when `durationMs` isn't finite / non-negative.
 *
 * @param {HTMLElement} toolBlockEl — the `<details>.tool-block` node
 * @param {number|null|undefined} durationMs
 * @returns {HTMLElement | null} the pill node (or null if not inserted)
 */
function applyToolDuration(toolBlockEl, durationMs) {
  if (!toolBlockEl || typeof toolBlockEl.querySelector !== 'function') return null
  const label = formatDurationLabel(durationMs)
  if (!label) return null
  const summary = toolBlockEl.querySelector('summary')
  if (!summary) return null
  let pill = summary.querySelector('.tool-duration')
  if (!pill) {
    pill = document.createElement('span')
    pill.className = 'tool-duration'
    summary.appendChild(pill)
  }
  pill.textContent = label
  pill.setAttribute('title', `tool ran for ${label}`)
  return pill
}

// -- JSON drawer (strategy §1.5 "看 JSON" 角标) ------------------------------
//
// Every tool card grows a small `{ }` badge on its summary line. Clicking it
// opens a right-side drawer holding the raw `tool/call.arguments` +
// `tool/result.{content,meta,isError,error}` JSON.
//
// The drawer itself lives at `#tool-json-drawer` in index.html so there's only
// one, no matter how many tool cards are on screen. This module just fills its
// content + toggles a class; CSS handles the 40% slide-in. Escape + backdrop
// click close.
//
// Deliberately not a native <dialog>: we want the main flow to stay clickable
// and scrollable while the drawer is up (老板 "非阻塞卡" / "抽屉 pin 时可保持
// 打开切消息" rule, strategy §Placement / §1.7).

// Return a small `{ }` button. The caller (renderer.js appendToolCall) hangs
// it on the tool block's summary line and wires the onClick to look up the
// call/result payload for the given callId. Kept as a factory so we don't
// couple this module to the renderer's payload store.
function renderJsonBadge(onClick) {
  // Same headless guard as openJsonDrawer below: the renderer test harness
  // stubs a window but no document, and the caller is null-tolerant.
  if (typeof document === 'undefined') return null
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'tool-json-badge'
  btn.textContent = '{ }'
  btn.title = 'Show raw JSON (call + result)'
  btn.setAttribute('aria-label', 'Show raw JSON for this tool call')
  btn.addEventListener('click', (e) => {
    // Stop the click from reaching the enclosing <summary>, which would
    // toggle the <details> open/close — a jarring side-effect for the
    // reader who just wanted the JSON.
    if (e && typeof e.stopPropagation === 'function') e.stopPropagation()
    if (e && typeof e.preventDefault === 'function') e.preventDefault()
    if (typeof onClick === 'function') onClick(e)
  })
  return btn
}

// Idempotently populate the drawer with call + result JSON and slide it in.
// `title` is a short label ("tool: bash"); either payload may be null/absent
// (call-only if result hasn't landed yet).
//
// lane-p0-inspector: this is now a thin adapter. When the unified Inspector
// is loaded (the real app — window.__dshInspector), the call routes there so
// every `{ }` badge / raw-JSON badge lands in the one Pretty/Raw/JSON drawer
// instead of this tool-only two-pane one. `event`/`tab` are the new
// pass-throughs (verbatim source event + initial tab); older callers that
// pass only {title, call, result} still work. The legacy #tool-json-drawer
// path below stays intact for node unit tests + early boot (inspector absent).
function openJsonDrawer({ title, call, result, event, tab } = {}) {
  const ins = (typeof window !== 'undefined') ? window.__dshInspector : null
  if (ins && typeof ins.openFromDrawer === 'function') {
    return ins.openFromDrawer({ title, call, result, event, tab })
  }
  const drawer = typeof document !== 'undefined' && document.getElementById
    ? document.getElementById('tool-json-drawer') : null
  if (!drawer) return null

  const titleEl = drawer.querySelector('.tool-json-drawer-title')
  if (titleEl) titleEl.textContent = String(title || 'tool JSON')

  const callPre = drawer.querySelector('[data-json-pane="call"]')
  const resultPre = drawer.querySelector('[data-json-pane="result"]')
  if (callPre) callPre.textContent = formatJson(call, '(no call payload captured)')
  if (resultPre) resultPre.textContent = formatJson(result, '(result pending)')

  // per-block controls (pretty⇅raw · copy · download)
  // on each drawer section. Idempotent: buildOrRefreshDrawerControls tears
  // down any prior controls before mounting fresh ones — same drawer node
  // is reused across every open() call so we can't leak dupes.
  const pc = typeof window !== 'undefined' ? window.__dshPayloadControls : null
  if (pc && typeof pc.attachPayloadControls === 'function') {
    buildOrRefreshDrawerControls(drawer, 'call', call, pc)
    buildOrRefreshDrawerControls(drawer, 'result', result, pc)
  }

  drawer.classList.add('open')
  drawer.setAttribute('aria-hidden', 'false')
  // Escape key closes. Bound to `document` so the drawer works even when
  // the focus is still in the chat input; removed on close so we don't leak
  // listeners on repeated open/close cycles.
  const escHandler = (e) => {
    if (e && e.key === 'Escape') closeJsonDrawer()
  }
  drawer._escHandler = escHandler
  document.addEventListener('keydown', escHandler)
  return drawer
}

function closeJsonDrawer() {
  const drawer = typeof document !== 'undefined' && document.getElementById
    ? document.getElementById('tool-json-drawer') : null
  if (!drawer) return
  drawer.classList.remove('open')
  drawer.setAttribute('aria-hidden', 'true')
  const esc = drawer._escHandler
  if (esc) {
    document.removeEventListener('keydown', esc)
    drawer._escHandler = null
  }
}

// mount per-block controls (pretty⇅raw · copy ·
// download) into a drawer section, replacing any earlier controls the
// previous open() call left behind. `paneKind` matches the [data-json-
// pane] attribute in index.html ('call' or 'result'); `payload` is the
// raw JS value to render + copy + download. `pc` is
// window.__dshPayloadControls injected by the caller.
function buildOrRefreshDrawerControls(drawer, paneKind, payload, pc) {
  const preEl = drawer.querySelector(`[data-json-pane="${paneKind}"]`)
  if (!preEl) return
  const section = preEl.closest ? preEl.closest('.tool-json-section') : preEl.parentElement
  if (!section) return
  // Tear down any prior controls before re-mounting — the drawer is a
  // singleton so back-to-back openJsonDrawer() calls would stack duplicate
  // control clusters otherwise.
  const existing = section.querySelector('.tool-json-section-controls[data-drawer-controls]')
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing)
  // 2026-07-18 P0 hotfix: mount the util's controls INSIDE a
  // `.tool-json-section-controls` strip that lives between the summary
  // and the <pre>. The strip is a flex row that right-aligns the button
  // cluster; the earlier shape inserted the controls directly as a
  // section child and used `float:right + margin-top:-18px` to pull them
  // up onto the summary line — which overlapped the summary's meta
  // annotation `(content · meta · isError · error · durationMs)` (the
  // exact P0 the user hit). Keeping controls in their own row eliminates
  // the overlap without hiding the affordance.
  const host = document.createElement('div')
  host.className = 'tool-json-section-controls'
  host.setAttribute('data-drawer-controls', paneKind)
  const ret = pc.attachPayloadControls(host, { getRaw: () => payload, kind: paneKind, filename: `${paneKind}-payload.json` })
  if (!ret) return
  // Discard the util's internal <pre> — the section already has one.
  if (ret.preEl && ret.preEl.parentNode) ret.preEl.parentNode.removeChild(ret.preEl)
  // Insert the strip between the section's summary and the pre so it
  // reads as its own row.
  section.insertBefore(host, preEl)
}

// Format any JS value as pretty JSON for the drawer, degrading gracefully.
// Strings that already parse as JSON are re-parsed so the user sees indented
// content, not a one-line escape soup — same trick renderer.js safePretty
// uses on the inline args block.
function formatJson(v, emptyMsg) {
  if (v == null) return String(emptyMsg || '')
  if (typeof v === 'string') {
    try { return JSON.stringify(JSON.parse(v), null, 2) } catch { return v }
  }
  try { return JSON.stringify(v, null, 2) } catch { return String(v) }
}

// -- code-dispatch fan-out ---------------------------------------------------

/**
 * Append a sub-call row to a parent `run_code` tool block. The row is a small
 * indented line summarising the sub-tool call — a full nested card would drown
 * the stream when Code Mode fans out to a dozen calls.
 * @param {HTMLElement} parentResBox — the `.result` div of the enclosing run_code call
 * @param {{ name: string, subCallId: string, isError: boolean, resultSummary?: string }} event
 * @returns {HTMLElement}
 */
function appendCodeDispatch(parentResBox, event) {
  // Lazily promote the .result box: if the parent still has its "..." placeholder,
  // clear it before hosting sub-rows so the placeholder doesn't sit above them.
  let list = parentResBox.querySelector && parentResBox.querySelector('.card-code-dispatch')
  if (!list) {
    parentResBox.textContent = ''
    list = document.createElement('div')
    list.className = 'card-code-dispatch'
    const header = document.createElement('div')
    header.className = 'card-code-dispatch-header'
    header.textContent = 'sub-calls'
    list.appendChild(header)
    parentResBox.appendChild(list)
  }
  const row = document.createElement('div')
  row.className = 'card-code-dispatch-row ' + (event && event.isError ? 'err' : 'ok')
  const branch = document.createElement('span')
  branch.className = 'card-code-dispatch-branch'
  branch.textContent = '└─' // └─
  const name = document.createElement('span')
  name.className = 'card-code-dispatch-name'
  name.textContent = String(event && event.name != null ? event.name : '(unknown)')
  const dot = document.createElement('span')
  dot.className = 'card-code-dispatch-dot'
  dot.textContent = event && event.isError ? '✗' : '✓' // ✗/✓
  const summary = document.createElement('span')
  summary.className = 'card-code-dispatch-summary'
  const s = event && typeof event.resultSummary === 'string' ? event.resultSummary : ''
  summary.textContent = s
  row.append(branch, dot, name, summary)
  list.appendChild(row)
  return row
}

// -- exports -----------------------------------------------------------------
// Dual export shape mirrors widgets.js: CommonJS for node:test, window for
// the renderer. The renderer script tag runs before renderer.js so the
// `window.__dshToolCards` handle is ready when the dispatch site needs it.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TOOL_FAMILIES,
    toolFamilyFor,
    renderTerminalCard,
    renderDiffCard,
    appendCodeDispatch,
    diffLines,
    splitLines,
    hunkize,
    HUNK_CAP,
    formatDurationLabel,
    durationFromToolResult,
    applyToolDuration,
    renderJsonBadge,
    openJsonDrawer,
    closeJsonDrawer,
  }
}
if (typeof window !== 'undefined') {
  window.__dshToolCards = {
    TOOL_FAMILIES,
    toolFamilyFor,
    renderTerminalCard,
    renderDiffCard,
    appendCodeDispatch,
    hunkize,
    HUNK_CAP,
    formatDurationLabel,
    durationFromToolResult,
    applyToolDuration,
    renderJsonBadge,
    openJsonDrawer,
    closeJsonDrawer,
  }
}
