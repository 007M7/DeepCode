// trace-graph.js — Task #203, view C (agent node graph).
//
// Renders a DAG of the trace as SVG: nodes = llm-step / tool / subagent /
// compact events; edges = control flow (sequential order within a step,
// plus fan-out from a spawn_agent tool/call to the started subagent's
// first event).
//
// Layout: hand-rolled BFS-level layering.
//   - Nodes are grouped into levels by graph position (parent → child; a
//     level is one deeper than its highest-level predecessor).
//   - Within a level, nodes are ordered by wire seq so the visual reading
//     order matches the transcript.
//   - Columns are evenly spaced across level height; rows within a
//     column are spaced compact — the reader complaint at Mission Topology
//     was "huge whitespace between nodes". We use a tight 44px gap
//     between rows and 130px between levels, tuned so a 3-level 6-node
//     graph fills a 600×260 viewport comfortably.
//
// Vendoring note: the task suggested elkjs. In this offline development
// environment, elkjs cannot be fetched fresh and vendoring a 1.4MB
// bundle for a demo shell is heavy. The hand-rolled layered layout is
// the documented fallback and is honest about it — this file's
// `layoutMode = 'bfs-layered-fallback'` surfaces in the report.
//
// Interactions: node click → onSeqClick(seq); node hover → mini metadata
// popover (name / duration / tokens if available); wheel-zoom + drag-pan on
// the SVG viewBox. Nodes for still-running events pulse with a border
// animation (respects prefers-reduced-motion via CSS).

'use strict'

;(function () {

// ─── graph construction ──────────────────────────────────────────────────
//
// buildGraph(input) → { nodes, edges, levels, layoutMode }
//
// `input` is a step-record or list. Each interesting event becomes a node.
// Filtering is intentional — we skip assistant/chunk and hook/* rows so the
// graph reads at a glance; the timeline view keeps the full detail.
//
// Node shape:
//   { id, seq, family, glyph, label, startTime, endTime|null, tokens|null,
//     status: 'ok'|'running'|'err' }
// Edge shape:
//   { from, to, kind: 'seq'|'fan-out'|'return' }

const NODE_FAMILY = {
  step: { glyph: '●', label: 'step' },
  llm: { glyph: '◆', label: 'llm' },
  tool: { glyph: '▲', label: 'tool' },
  subagent: { glyph: '◉', label: 'subagent' },
  compact: { glyph: '◇', label: 'compact' },
  fork: { glyph: '⑂', label: 'fork' },
}

function buildGraph(input) {
  const records = normaliseRecords(input)
  const nodes = []
  const edges = []
  let prevStepId = null

  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue
    const stepId = `step:${rec.turn}.${rec.step}:${numericOrNull(rec.startSeq)}`
    nodes.push({
      id: stepId,
      seq: numericOrNull(rec.startSeq),
      family: 'step',
      glyph: NODE_FAMILY.step.glyph,
      label: labelForStep(rec),
      startTime: numericOrNull(rec.startTime),
      endTime: numericOrNull(rec.endTime),
      durationMs: numericOrNull(rec.durationMs),
      tokens: rec._stepUsage || null,
      status: rec.open ? 'running' : 'ok',
    })
    if (prevStepId) edges.push({ from: prevStepId, to: stepId, kind: 'seq' })

    // Walk this step's events. Only "interesting" families become nodes;
    // assistant/chunk + hook/* stay latent (visible in Timeline / Tree).
    const events = collectStepEvents(rec)
    let prevInStep = stepId
    for (const ev of events) {
      const family = familyForEventNode(ev)
      if (!family) continue
      const spec = NODE_FAMILY[family] || NODE_FAMILY.step
      const nodeId = `ev:${family}:${numericOrNull(ev.seq)}`
      nodes.push({
        id: nodeId,
        seq: numericOrNull(ev.seq),
        family,
        glyph: spec.glyph,
        label: labelForEventNode(ev, family),
        startTime: numericOrNull(ev.time),
        endTime: numericOrNull(ev._pairEndTime),
        durationMs: durationForEventNode(ev),
        tokens: tokensForEventNode(ev),
        status: 'ok',
      })
      edges.push({ from: prevInStep, to: nodeId, kind: 'seq' })
      // Subagent fan-out: a spawn_agent tool/call links out to a stub
      // "sub" node in the same level column (visual cue that this call
      // branches off).
      if (family === 'tool' && ev.data && ev.data.name === 'spawn_agent') {
        const subId = `sub:${numericOrNull(ev.seq)}`
        nodes.push({
          id: subId,
          seq: numericOrNull(ev.seq),
          family: 'subagent',
          glyph: NODE_FAMILY.subagent.glyph,
          label: 'subagent (spawned)',
          startTime: numericOrNull(ev.time),
          endTime: null,
          durationMs: null,
          tokens: null,
          status: 'ok',
        })
        edges.push({ from: nodeId, to: subId, kind: 'fan-out' })
      }
      prevInStep = nodeId
    }
    prevStepId = stepId
  }

  const levels = assignLevels(nodes, edges)
  return {
    nodes,
    edges,
    levels,
    layoutMode: 'bfs-layered-fallback',
  }
}

function collectStepEvents(rec) {
  const seen = new Set()
  const out = []
  for (const list of [rec.events, rec.outputs, rec.inputs]) {
    if (!Array.isArray(list)) continue
    for (const ev of list) {
      if (!ev || typeof ev !== 'object') continue
      const key = typeof ev.seq === 'number' ? `s${ev.seq}` : `t${ev.type}|${out.length}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(ev)
    }
  }
  // Preserve wire order.
  out.sort(function (a, b) {
    const as = numericOrNull(a.seq)
    const bs = numericOrNull(b.seq)
    if (as === null && bs === null) return 0
    if (as === null) return 1
    if (bs === null) return -1
    return as - bs
  })
  return pairToolCallResultInGraph(out)
}

function pairToolCallResultInGraph(events) {
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
        if (ev.data.isError) callEv._pairIsError = true
        skipSet.add(i)
      }
    }
  }
  const out = []
  for (let i = 0; i < events.length; i++) if (!skipSet.has(i)) out.push(events[i])
  return out
}

function familyForEventNode(ev) {
  const t = ev && ev.type
  if (t === 'assistant/message' || t === 'request/header') return 'llm'
  if (t === 'tool/call') return 'tool'
  if (t === 'compact/summary') return 'compact'
  if (t === 'subagent.started' || t === 'subagent.finished') return 'subagent'
  return null
}

function labelForEventNode(ev, family) {
  const d = ev.data || {}
  if (family === 'tool') {
    const name = typeof d.name === 'string' ? d.name : 'tool'
    return name
  }
  if (family === 'llm') {
    if (ev.type === 'request/header' && d.header && typeof d.header.model === 'string') {
      return d.header.model
    }
    return 'llm'
  }
  if (family === 'subagent') return ev.type
  if (family === 'compact') return 'compact'
  return ev.type || 'event'
}

function durationForEventNode(ev) {
  if (!ev) return null
  const s = numericOrNull(ev.time)
  const e = numericOrNull(ev._pairEndTime)
  if (s !== null && e !== null) return e - s
  return null
}

function tokensForEventNode(ev) {
  const d = ev && ev.data
  if (!d) return null
  if (ev.type === 'assistant/message' && d.usage) {
    const u = d.usage
    const inTok = typeof u.inputTokens === 'number' ? u.inputTokens : null
    const outTok = typeof u.outputTokens === 'number' ? u.outputTokens : null
    if (inTok === null && outTok === null) return null
    return { input: inTok, output: outTok }
  }
  return null
}

// ─── layer assignment ────────────────────────────────────────────────────
//
// assignLevels(nodes, edges) → [[nodeId, nodeId, …], …]
//
// BFS from roots (nodes with no incoming edges). Each node's level is one
// more than the max of its predecessors' levels; this handles the sequence
// spine plus fan-out branches cleanly without a real topological sort.

function assignLevels(nodes, edges) {
  const inbound = new Map()
  const outbound = new Map()
  for (const n of nodes) { inbound.set(n.id, []); outbound.set(n.id, []) }
  for (const e of edges) {
    if (inbound.has(e.to)) inbound.get(e.to).push(e.from)
    if (outbound.has(e.from)) outbound.get(e.from).push(e.to)
  }
  const level = new Map()
  const queue = []
  for (const n of nodes) {
    if ((inbound.get(n.id) || []).length === 0) {
      level.set(n.id, 0)
      queue.push(n.id)
    }
  }
  let guard = 0
  while (queue.length && guard++ < 10000) {
    const id = queue.shift()
    const l = level.get(id) || 0
    for (const child of outbound.get(id) || []) {
      const cur = level.has(child) ? level.get(child) : -1
      const next = Math.max(cur, l + 1)
      if (next !== cur) {
        level.set(child, next)
        queue.push(child)
      }
    }
  }
  // Any node still missing (shouldn't happen for a DAG, but guard) goes on
  // its own trailing row.
  let maxLevel = 0
  for (const v of level.values()) if (v > maxLevel) maxLevel = v
  for (const n of nodes) if (!level.has(n.id)) level.set(n.id, ++maxLevel)
  const levels = []
  for (let i = 0; i <= maxLevel; i++) levels.push([])
  for (const n of nodes) levels[level.get(n.id)].push(n.id)
  // Stabilise column order by seq for readable left-to-right reading.
  for (const col of levels) {
    col.sort(function (a, b) {
      const na = nodes.find(function (n) { return n.id === a })
      const nb = nodes.find(function (n) { return n.id === b })
      const as = na && na.seq !== null ? na.seq : Infinity
      const bs = nb && nb.seq !== null ? nb.seq : Infinity
      return as - bs
    })
  }
  return levels
}

// ─── DOM rendering ───────────────────────────────────────────────────────

const SVGNS = 'http://www.w3.org/2000/svg'

// Layout constants — tuned for the "no huge whitespace" complaint at
// Mission Topology (the reader kept saying nodes floated too far apart).
const COL_GAP = 140
const ROW_GAP = 44
const NODE_R = 14
const PAD = 30

function renderGraph(doc, input, opts) {
  const options = opts || {}
  const g = buildGraph(input)
  const positions = computePositions(g)
  const width = Math.max(400, positions.width)
  const height = Math.max(200, positions.height)

  const wrap = doc.createElement('div')
  wrap.className = 'trace-graph'
  wrap.setAttribute('data-layout-mode', g.layoutMode)

  const svg = doc.createElementNS(SVGNS, 'svg')
  svg.setAttribute('class', 'trace-graph-svg')
  const initialViewBox = `0 0 ${width} ${height}`
  svg.setAttribute('viewBox', initialViewBox)
  svg.setAttribute('width', String(Math.min(width, 900)))
  svg.setAttribute('height', String(Math.min(height, 500)))
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', `Agent graph: ${g.nodes.length} nodes, ${g.edges.length} edges`)

  // Edges first so they sit under nodes.
  const edgesG = svgGroup(doc, 'trace-graph-edges')
  for (const edge of g.edges) {
    const from = positions.by.get(edge.from)
    const to = positions.by.get(edge.to)
    if (!from || !to) continue
    const path = svgEl(doc, 'path', {
      d: cubicPath(from.x, from.y, to.x, to.y),
      class: `trace-graph-edge kind-${edge.kind}`,
      fill: 'none',
    })
    edgesG.appendChild(path)
  }
  svg.appendChild(edgesG)

  const nodesG = svgGroup(doc, 'trace-graph-nodes')
  for (const node of g.nodes) {
    const pos = positions.by.get(node.id)
    if (!pos) continue
    const nodeG = svgGroup(doc, `trace-graph-node family-${node.family} status-${node.status}`)
    nodeG.setAttribute('data-seq', node.seq !== null ? String(node.seq) : '')
    nodeG.setAttribute('transform', `translate(${pos.x}, ${pos.y})`)
    if (typeof options.onSeqClick === 'function' && node.seq !== null) {
      // -07-17 (D2): the callback was already wired,
      // but the node had no visible selected state and no explicit cursor,
      // so QA-CDP + reader alike could not tell that a click landed. Give
      // the node a `.selected` reflex so the reader has feedback while the
      // callback also drives the right-side detail pane. selectNode is
      // scoped to `nodesG` so a re-render (view switch) rebuilds cleanly.
      nodeG.setAttribute('tabindex', '0')
      nodeG.style.cursor = 'pointer'
      const selectAndDispatch = function () {
        try {
          const prev = nodesG.querySelectorAll
            ? nodesG.querySelectorAll('.trace-graph-node.selected')
            : []
          if (prev && prev.forEach) prev.forEach(function (n) { n.classList && n.classList.remove('selected') })
        } catch (_) { /* jsdom / test doc lacks querySelectorAll — safe */ }
        if (nodeG.classList && typeof nodeG.classList.add === 'function') {
          nodeG.classList.add('selected')
        }
        options.onSeqClick(node.seq, node)
      }
      nodeG.addEventListener('click', selectAndDispatch)
      nodeG.addEventListener('keydown', function (ev) {
        if (ev && (ev.key === 'Enter' || ev.key === ' ')) {
          ev.preventDefault()
          selectAndDispatch()
        }
      })
    }
    const circle = svgEl(doc, 'circle', {
      cx: 0, cy: 0, r: NODE_R,
      class: `trace-graph-node-body family-${node.family}`,
    })
    nodeG.appendChild(circle)
    const glyph = svgEl(doc, 'text', {
      x: 0, y: 4, class: 'trace-graph-node-glyph',
      'text-anchor': 'middle',
    })
    glyph.textContent = node.glyph
    nodeG.appendChild(glyph)
    const label = svgEl(doc, 'text', {
      x: 0, y: NODE_R + 14, class: 'trace-graph-node-label',
      'text-anchor': 'middle',
    })
    label.textContent = trim(node.label, 20)
    nodeG.appendChild(label)
    // Tooltip title (native SVG title = hover mini-metadata card).
    const title = svgEl(doc, 'title', {})
    title.textContent = titleFor(node)
    nodeG.appendChild(title)
    nodesG.appendChild(nodeG)
  }
  svg.appendChild(nodesG)

  // Pan (drag) + zoom (wheel) via viewBox mutation. Lightweight, no dep.
  installPanZoom(svg, width, height)

  wrap.appendChild(svg)
  return wrap
}

function titleFor(node) {
  const bits = [node.label, node.family]
  if (node.durationMs !== null) bits.push(formatMs(node.durationMs))
  if (node.tokens) {
    const parts = []
    if (typeof node.tokens.input === 'number') parts.push(`↑${node.tokens.input}`)
    if (typeof node.tokens.output === 'number') parts.push(`↓${node.tokens.output}`)
    if (parts.length) bits.push(parts.join(' '))
  }
  if (node.seq !== null) bits.push(`seq ${node.seq}`)
  return bits.join(' · ')
}

function cubicPath(x1, y1, x2, y2) {
  // Horizontal cubic curve — control points at 45% of the horizontal
  // distance, so short edges stay taut and long edges bow gently.
  const dx = Math.max(30, Math.abs(x2 - x1) * 0.45)
  const c1x = x1 + dx
  const c2x = x2 - dx
  return `M${x1},${y1} C${c1x},${y1} ${c2x},${y2} ${x2},${y2}`
}

function computePositions(g) {
  const by = new Map()
  const levels = g.levels
  let maxRows = 0
  for (const col of levels) if (col.length > maxRows) maxRows = col.length
  const nodeById = new Map()
  for (const n of g.nodes) nodeById.set(n.id, n)
  for (let i = 0; i < levels.length; i++) {
    const col = levels[i]
    const x = PAD + i * COL_GAP + NODE_R
    const totalH = col.length * ROW_GAP
    const startY = PAD + Math.max(0, (maxRows - col.length) * ROW_GAP / 2)
    for (let j = 0; j < col.length; j++) {
      const y = startY + j * ROW_GAP + NODE_R
      by.set(col[j], { x, y, level: i, row: j })
    }
  }
  const width = PAD * 2 + levels.length * COL_GAP + NODE_R
  const height = PAD * 2 + maxRows * ROW_GAP + NODE_R + 22
  return { by, width, height }
}

// Pan (mouse drag on background) + zoom (wheel on SVG) with viewBox math.
// Keeps interactions local to the SVG so it composes inside any container.
function installPanZoom(svg, initialW, initialH) {
  let vb = { x: 0, y: 0, w: initialW, h: initialH }
  let dragging = null

  svg.addEventListener('wheel', function (ev) {
    ev.preventDefault()
    const scale = ev.deltaY > 0 ? 1.12 : 1 / 1.12
    // Zoom around the SVG center (approx — no client-rect math to keep
    // the module dep-free).
    const cx = vb.x + vb.w / 2
    const cy = vb.y + vb.h / 2
    vb.w *= scale
    vb.h *= scale
    vb.x = cx - vb.w / 2
    vb.y = cy - vb.h / 2
    if (vb.w < 60) { vb.w = 60; vb.h = 60 * (initialH / initialW) }
    if (vb.w > initialW * 6) { vb.w = initialW * 6; vb.h = vb.w * (initialH / initialW) }
    svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`)
  }, { passive: false })

  svg.addEventListener('mousedown', function (ev) {
    if (ev.target !== svg && !ev.target.classList.contains('trace-graph-edges')) return
    dragging = { x: ev.clientX, y: ev.clientY, vb: { x: vb.x, y: vb.y } }
    svg.style.cursor = 'grabbing'
  })
  svg.addEventListener('mousemove', function (ev) {
    if (!dragging) return
    const sx = vb.w / (svg.clientWidth || initialW)
    const sy = vb.h / (svg.clientHeight || initialH)
    vb.x = dragging.vb.x - (ev.clientX - dragging.x) * sx
    vb.y = dragging.vb.y - (ev.clientY - dragging.y) * sy
    svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`)
  })
  svg.addEventListener('mouseup', function () { dragging = null; svg.style.cursor = '' })
  svg.addEventListener('mouseleave', function () { dragging = null; svg.style.cursor = '' })
}

// Export SVG string with an inline stylesheet so it opens legibly outside
// the app.
function exportGraphSVG(doc, input, opts) {
  const el = renderGraph(doc, input, opts)
  const svg = el.querySelector('svg')
  if (!svg) return ''
  const style = doc.createElementNS(SVGNS, 'style')
  style.textContent = GRAPH_EXPORT_STYLE
  svg.insertBefore(style, svg.firstChild)
  return svg.outerHTML
}

const GRAPH_EXPORT_STYLE = `
.trace-graph-svg { font: 11px system-ui, sans-serif; background: #fff; }
.trace-graph-edge { stroke: #98989d; stroke-width: 1.2; }
.trace-graph-edge.kind-fan-out { stroke: #d0a97b; stroke-dasharray: 3 3; }
.trace-graph-node-body { stroke: #1d1d1f; stroke-width: 1.2; }
.trace-graph-node-body.family-step { fill: #e6e7ea; }
.trace-graph-node-body.family-llm { fill: #d9c8f3; }
.trace-graph-node-body.family-tool { fill: #f0c88a; }
.trace-graph-node-body.family-subagent { fill: #eecfa1; }
.trace-graph-node-body.family-compact { fill: #f5a97b; }
.trace-graph-node-glyph { font-weight: 600; fill: #1d1d1f; font-size: 12px; }
.trace-graph-node-label { font-size: 10px; fill: #1d1d1f; }
`

// ─── shared helpers ──────────────────────────────────────────────────────

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
  if (t !== null && s !== null) return `step ${t}.${s}`
  if (s !== null) return `step ?.${s}`
  return 'step ?'
}

function formatMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function trim(s, n) {
  if (typeof s !== 'string') return ''
  const c = s.replace(/\s+/g, ' ').trim()
  if (c.length <= n) return c
  return c.slice(0, n - 1) + '…'
}

function svgEl(doc, tag, attrs) {
  const el = doc.createElementNS(SVGNS, tag)
  if (attrs) {
    for (const k of Object.keys(attrs)) el.setAttribute(k, String(attrs[k]))
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
    buildGraph,
    assignLevels,
    computePositions,
    familyForEventNode,
    labelForEventNode,
    renderGraph,
    exportGraphSVG,
    NODE_FAMILY,
  }
}
if (typeof window !== 'undefined') {
  window.__dshTraceGraph = {
    buildGraph,
    assignLevels,
    computePositions,
    familyForEventNode,
    labelForEventNode,
    renderGraph,
    exportGraphSVG,
    NODE_FAMILY,
  }
}

})()
