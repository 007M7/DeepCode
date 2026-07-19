// trace-timeline.js — Task #203, view B (Gantt/waterfall)
//
// Pure module + DOM/SVG glue for the "Timeline" tab of the trace tri-view.
// One shared wall-clock x-axis; each step is a parent bar and each event
// inside the step is a child row (bar when the event has a duration —
// tool/call→tool/result pairs, request/header→assistant/message — or a
// hairline marker when it's point-in-time).
//
// **DSH-specific enhancement, not LangSmith parity.** LangSmith folds
// concurrency into the tree via inline waterfall bars — no separate Gantt
// tab. We keep this Timeline tab because researchers explicitly asked for
// a standalone concurrency-gap surface (docs/design-refs/trace-viz-forms.md
// §e). Do not "align this away" during future LangSmith-parity passes: the
// tree tab already has its own inline waterfall; this Gantt tab is the
// step-level session view that Langfuse ships as `Timeline`, not something
// LangSmith would recognize.
//
// The layout is deliberately naive: no libraries, no build step; hand-rolled
// SVG so CSS variables theme it the same way as the rest of the shell. The
// input shape mirrors what `trace-aggregator.aggregateSteps` returns — a
// `step-record` (`{turn, step, startTime, endTime, events, ...}`) or a list
// of them (session scope). Layout math is separated from DOM so the
// scale/row-assignment can be unit-tested without a document.
//
// Anti-goals: not a full charting library. No zoom (the tree column stays
// at the left; time span is the whole records range; if the researcher
// needs more zoom, they open a step's own trace card). No pan. No hover
// legend beyond title tooltips. That's deliberate — this is the "spot a
// concurrency gap or long tail" surface, not a profiler.

'use strict'

;(function () {

// ─── pure layout math ────────────────────────────────────────────────────
//
// buildTimelineRows(records) → { rows, startTime, endTime, totalMs }
//
// `records` is a step-record or an array of them (: session scope
// passes many; per-turn scope passes one). Each returned row is:
//   { depth: 0|1, kind: 'step'|'event', label, startTime, endTime|null,
//     seq, type, family }
// Rows are in traversal order (each step, then its events in seq order).
// startTime/endTime are absolute wall-clock ms; `totalMs` is the span from
// the earliest event to the latest end. If everything shares the same
// timestamp (paused fixture, malformed wire), `totalMs` clamps to 1 so
// the SVG scale never divides by zero.

function buildTimelineRows(input) {
  const records = normaliseRecords(input)
  const rows = []
  let earliest = null
  let latest = null
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue
    const start = numericOrNull(rec.startTime)
    const end = numericOrNull(rec.endTime)
    if (start !== null) earliest = earliest === null ? start : Math.min(earliest, start)
    if (end !== null) latest = latest === null ? end : Math.max(latest, end)
    rows.push({
      depth: 0,
      kind: 'step',
      label: labelForStep(rec),
      startTime: start,
      endTime: end,
      seq: numericOrNull(rec.startSeq),
      endSeq: numericOrNull(rec.endSeq),
      type: 'step',
      family: 'step',
    })
    // Merge outputs + events (dedup by seq: outputs is a subset of events).
    const seen = new Set()
    const inner = []
    for (const list of [rec.inputs, rec.events]) {
      if (!Array.isArray(list)) continue
      for (const ev of list) {
        if (!ev || typeof ev !== 'object') continue
        const sq = numericOrNull(ev.seq)
        const key = sq !== null ? `s${sq}` : `t${ev.type}|${inner.length}`
        if (seen.has(key)) continue
        seen.add(key)
        inner.push(ev)
      }
    }
    // tool/call → tool/result pairing: the call row absorbs the result
    // timestamp as its endTime and the result event is skipped as a row
    // (it's implicit in the bar's right edge).
    const paired = pairToolCallResult(inner)
    for (const ev of paired) {
      const evStart = numericOrNull(ev.time)
      const evEnd = numericOrNull(ev._pairEndTime)
      if (evStart !== null) earliest = earliest === null ? evStart : Math.min(earliest, evStart)
      const finalEnd = evEnd !== null ? evEnd : evStart
      if (finalEnd !== null) latest = latest === null ? finalEnd : Math.max(latest, finalEnd)
      rows.push({
        depth: 1,
        kind: 'event',
        label: labelForEvent(ev),
        startTime: evStart,
        endTime: evEnd,
        seq: numericOrNull(ev.seq),
        type: ev.type,
        family: familyForEvent(ev),
      })
    }
  }
  if (earliest === null) earliest = 0
  if (latest === null) latest = earliest
  let totalMs = latest - earliest
  if (totalMs <= 0) totalMs = 1
  return { rows, startTime: earliest, endTime: latest, totalMs }
}

function normaliseRecords(input) {
  if (Array.isArray(input)) return input
  if (input && typeof input === 'object') return [input]
  return []
}

function numericOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function labelForStep(rec) {
  const t = numericOrNull(rec.turn)
  const s = numericOrNull(rec.step)
  const head = (t !== null && s !== null) ? `step ${t}.${s}`
    : (s !== null ? `step ?.${s}` : 'step ?')
  const dur = numericOrNull(rec.durationMs)
  const durTxt = dur !== null ? ` · ${formatMs(dur)}` : ''
  const sum = typeof rec.summary === 'string' && rec.summary ? ` — ${trim(rec.summary, 30)}` : ''
  return `${head}${sum}${durTxt}`
}

function labelForEvent(ev) {
  const t = typeof ev.type === 'string' ? ev.type : '(untyped)'
  const d = ev.data || {}
  if (ev.type === 'tool/call' && typeof d.name === 'string') return `tool: ${d.name}`
  if (ev.type === 'assistant/message') return 'assistant/message'
  if (ev.type === 'request/header') return 'request/header'
  if (ev.type === 'assistant/chunk') return 'assistant/chunk'
  if (ev.type === 'compact/summary') return 'compact/summary'
  if (typeof ev.type === 'string' && ev.type.startsWith('hook/')) return ev.type
  return t
}

// Family tags map to CSS classes so bars pick up the same palette the tool
// cards / trace pane use. Deliberately small — the color story is family,
// not per-event-type — so a Gantt row reads at a glance.
function familyForEvent(ev) {
  const t = ev && ev.type
  if (t === 'tool/call' || t === 'tool/result') return 'tool'
  if (t === 'assistant/message' || t === 'assistant/chunk' || t === 'request/header') return 'llm'
  if (t === 'compact/summary') return 'compact'
  if (t === 'subagent.started' || t === 'subagent.finished') return 'subagent'
  if (typeof t === 'string' && t.startsWith('hook/')) return 'hook'
  if (t === 'user/message' || t === 'context/message' || t === 'steering/message') return 'input'
  return 'event'
}

// Match every tool/call to the immediately-following tool/result with the
// same callId (if any). The result event carries a startTime near the call
// PLUS `data.meta.durationMs` in some fixtures; we prefer the result's own
// `time` because it's the wire truth. When a call has no matching result
// (still running), endTime stays null and the renderer draws it open-ended.
function pairToolCallResult(events) {
  const byCallId = new Map()
  const skipSet = new Set()
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]
    if (ev && ev.type === 'tool/call' && ev.data && typeof ev.data.callId === 'string') {
      byCallId.set(ev.data.callId, i)
    } else if (ev && ev.type === 'tool/result' && ev.data && typeof ev.data.callId === 'string') {
      const callIdx = byCallId.get(ev.data.callId)
      if (callIdx !== undefined) {
        const callEv = events[callIdx]
        const resultTime = numericOrNull(ev.time)
        if (resultTime !== null) callEv._pairEndTime = resultTime
        skipSet.add(i)
      }
    }
  }
  const out = []
  for (let i = 0; i < events.length; i++) if (!skipSet.has(i)) out.push(events[i])
  return out
}

// ─── scale + geometry ────────────────────────────────────────────────────

// Compute a linear x-scale from (startTime, endTime) → (0, width).
// Clamps out-of-range values so a misdated event never overflows the SVG.
function makeXScale(startTime, totalMs, width) {
  const w = Math.max(1, width)
  return function (t) {
    if (typeof t !== 'number' || !Number.isFinite(t)) return 0
    const ratio = (t - startTime) / totalMs
    if (ratio <= 0) return 0
    if (ratio >= 1) return w
    return ratio * w
  }
}

function formatMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function trim(s, n) {
  if (typeof s !== 'string') return ''
  const collapsed = s.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= n) return collapsed
  return collapsed.slice(0, n - 1) + '…'
}

// ─── DOM / SVG rendering ─────────────────────────────────────────────────
//
// renderTimeline(doc, input, opts) → HTMLElement
//   - `opts.onSeqClick(seq)` — hook fires when a bar/label is clicked;
//     the caller can then deep-link into the conversation stream.
//   - `opts.width` — total pixel width including the label column
//     (default 720). The label column is fixed at 220px; the bar area
//     takes the remainder minus the axis margin.
//   - `opts.rowHeight` — px per row (default 18).
//   - `opts.nowMs` — optional live cursor position (wall-clock ms). When
//     supplied AND falls inside the span, a hairline is drawn at that x.

function renderTimeline(doc, input, opts) {
  const options = opts || {}
  const { rows, startTime, totalMs } = buildTimelineRows(input)
  const width = typeof options.width === 'number' && options.width > 200 ? options.width : 720
  const rowH = typeof options.rowHeight === 'number' && options.rowHeight > 8 ? options.rowHeight : 18
  const labelW = 220
  const rightPad = 12
  const topPad = 26 // room for axis ticks
  const barAreaW = Math.max(200, width - labelW - rightPad)
  const height = topPad + rows.length * rowH + 12
  const xScale = makeXScale(startTime, totalMs, barAreaW)

  const wrap = doc.createElement('div')
  wrap.className = 'trace-timeline'
  wrap.setAttribute('data-total-ms', String(totalMs))

  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'trace-timeline-svg')
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', `Timeline of ${rows.length} rows over ${formatMs(totalMs)}`)

  // Axis ticks — 4 evenly-spaced marks along the bar area, labelled with
  // elapsed ms/s from the earliest event.
  const axis = svgGroup(doc, 'trace-timeline-axis')
  const ticks = 4
  for (let i = 0; i <= ticks; i++) {
    const x = labelW + (i / ticks) * barAreaW
    const line = svgEl(doc, 'line', {
      x1: x, y1: topPad - 4, x2: x, y2: height - 4,
      class: 'trace-timeline-tick',
    })
    axis.appendChild(line)
    const label = svgEl(doc, 'text', {
      x: x + 3, y: 12, class: 'trace-timeline-tick-label',
    })
    label.textContent = formatMs((i / ticks) * totalMs)
    axis.appendChild(label)
  }
  svg.appendChild(axis)

  // Rows.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const y = topPad + i * rowH
    const g = svgGroup(doc, `trace-timeline-row family-${row.family} depth-${row.depth}`)
    g.setAttribute('data-seq', row.seq !== null ? String(row.seq) : '')
    g.setAttribute('data-kind', row.kind)

    // Label column (tree indent preserved).
    const labelText = svgEl(doc, 'text', {
      x: 8 + row.depth * 12, y: y + rowH * 0.72,
      class: 'trace-timeline-label',
    })
    labelText.textContent = trim(row.label, 36)
    const labelTitle = svgEl(doc, 'title', {})
    labelTitle.textContent = row.label
    labelText.appendChild(labelTitle)
    g.appendChild(labelText)

    // Bar or marker in the bar area.
    if (row.startTime !== null) {
      const x1 = labelW + xScale(row.startTime)
      const rawEnd = row.endTime !== null ? row.endTime : row.startTime
      const x2 = labelW + xScale(rawEnd)
      const barW = Math.max(row.endTime === null ? 2 : 3, x2 - x1)
      const barY = y + 4
      const barH = rowH - 8
      const bar = svgEl(doc, 'rect', {
        x: x1, y: barY, width: barW, height: barH,
        rx: 2, ry: 2,
        class: `trace-timeline-bar family-${row.family} kind-${row.kind}`,
      })
      const title = svgEl(doc, 'title', {})
      const dur = row.endTime !== null && row.startTime !== null
        ? formatMs(row.endTime - row.startTime)
        : 'point'
      title.textContent = `${row.label} · ${dur}`
      bar.appendChild(title)
      g.appendChild(bar)
    }

    // Whole row click → seq deep-link.
    if (row.seq !== null && typeof options.onSeqClick === 'function') {
      // the bar had a callback but
      // no `.selected` reflex, so QA-CDP saw "click zero visible effect".
      // Add a mutex `.selected` marker across the timeline's rows so the
      // reader always sees which bar drove the right-side detail pane.
      g.setAttribute('tabindex', '0')
      g.style.cursor = 'pointer'
      const selectAndDispatch = function () {
        try {
          const prev = svg.querySelectorAll
            ? svg.querySelectorAll('.trace-timeline-row.selected')
            : []
          if (prev && prev.forEach) prev.forEach(function (r) { r.classList && r.classList.remove('selected') })
        } catch (_) { /* test doc lacks querySelectorAll — safe */ }
        if (g.classList && typeof g.classList.add === 'function') g.classList.add('selected')
        options.onSeqClick(row.seq, row)
      }
      g.addEventListener('click', selectAndDispatch)
      g.addEventListener('keydown', function (ev) {
        if (ev && (ev.key === 'Enter' || ev.key === ' ')) {
          ev.preventDefault()
          selectAndDispatch()
        }
      })
    }
    svg.appendChild(g)
  }

  // Signal badges — small filled circles hanging off the right edge of the
  // label column for any row whose seq matches a detected/emitted signal.
  // The `signals` option is a bySeq Map from trace-signal-detect.js. We keep
  // this render entirely optional so tests + non-signal callers stay
  // untouched; when no map is supplied nothing is drawn. See L-2 in
  // docs/upstream-ledger.md for the RFC that would move detection upstream.
  if (options.signals && typeof options.signals.get === 'function') {
    const badgesG = svgGroup(doc, 'trace-timeline-badges')
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      if (row.seq === null) continue
      const sigs = options.signals.get(row.seq)
      if (!sigs || !sigs.length) continue
      const y = topPad + i * rowH + rowH * 0.5
      // Stack badges horizontally so multiple signals on one seq stay
      // readable. The seed x sits just inside the label column so the
      // badge visually "labels" the row without eating bar space.
      let bx = labelW - 10
      for (const sig of sigs) {
        const cls = (typeof window !== 'undefined' && window.__dshTraceSignalDetect)
          ? window.__dshTraceSignalDetect.classFor(sig.signal)
          : (typeof require !== 'undefined' ? require('./trace-signal-detect.js').classFor(sig.signal) : 'sig-generic')
        const tip = (typeof window !== 'undefined' && window.__dshTraceSignalDetect)
          ? window.__dshTraceSignalDetect.tooltipFor(sig)
          : (typeof require !== 'undefined' ? require('./trace-signal-detect.js').tooltipFor(sig) : sig.signal)
        const badge = svgEl(doc, 'circle', {
          cx: bx, cy: y, r: 4,
          class: `trace-timeline-signal-badge ${cls}`,
        })
        const title = svgEl(doc, 'title', {})
        title.textContent = tip
        badge.appendChild(title)
        badgesG.appendChild(badge)
        bx -= 10
      }
    }
    svg.appendChild(badgesG)
  }

  // Live cursor: hairline at nowMs during streaming.
  if (typeof options.nowMs === 'number' && Number.isFinite(options.nowMs)) {
    const nx = labelW + xScale(options.nowMs)
    if (nx >= labelW && nx <= labelW + barAreaW) {
      const cursor = svgEl(doc, 'line', {
        x1: nx, y1: topPad - 4, x2: nx, y2: height - 4,
        class: 'trace-timeline-now-cursor',
      })
      svg.appendChild(cursor)
    }
  }

  wrap.appendChild(svg)
  return wrap
}

// Export SVG as a self-contained string (with a minimal inline stylesheet so
// the exported file is legible when opened outside the app). Callers wire
// this to a download button — researchers asked for vector exports.
function exportTimelineSVG(doc, input, opts) {
  const el = renderTimeline(doc, input, opts)
  const svg = el.querySelector('svg')
  if (!svg) return ''
  const style = doc.createElementNS('http://www.w3.org/2000/svg', 'style')
  style.textContent = TIMELINE_EXPORT_STYLE
  svg.insertBefore(style, svg.firstChild)
  return svg.outerHTML
}

const TIMELINE_EXPORT_STYLE = `
.trace-timeline-svg { font: 11px system-ui, sans-serif; background: #fff; }
.trace-timeline-tick { stroke: #d0d0d5; stroke-width: 0.5; stroke-dasharray: 2 3; }
.trace-timeline-tick-label { fill: #6b6b70; font-size: 10px; }
.trace-timeline-label { fill: #1d1d1f; font-size: 11px; }
.trace-timeline-row.depth-0 .trace-timeline-label { font-weight: 600; }
.trace-timeline-bar.family-step { fill: #b0b4bd; }
.trace-timeline-bar.family-llm { fill: #7c3aed; }
.trace-timeline-bar.family-tool { fill: #b45309; }
.trace-timeline-bar.family-subagent { fill: #d0a97b; }
.trace-timeline-bar.family-compact { fill: #ea580c; }
.trace-timeline-bar.family-input { fill: #6b6b70; }
.trace-timeline-bar.family-hook { fill: #475569; }
.trace-timeline-bar.family-event { fill: #98989d; }
.trace-timeline-now-cursor { stroke: #dc2626; stroke-width: 1; }
`

// ─── SVG helpers ─────────────────────────────────────────────────────────

const SVGNS = 'http://www.w3.org/2000/svg'

function svgEl(doc, tag, attrs) {
  const el = doc.createElementNS(SVGNS, tag)
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      el.setAttribute(k, String(attrs[k]))
    }
  }
  return el
}

function svgGroup(doc, cls) {
  const g = doc.createElementNS(SVGNS, 'g')
  if (cls) g.setAttribute('class', cls)
  return g
}

// ─── exports ─────────────────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildTimelineRows,
    pairToolCallResult,
    makeXScale,
    familyForEvent,
    labelForEvent,
    labelForStep,
    formatMs,
    renderTimeline,
    exportTimelineSVG,
  }
}
if (typeof window !== 'undefined') {
  window.__dshTraceTimeline = {
    buildTimelineRows,
    pairToolCallResult,
    makeXScale,
    familyForEvent,
    labelForEvent,
    labelForStep,
    formatMs,
    renderTimeline,
    exportTimelineSVG,
  }
}

})()
