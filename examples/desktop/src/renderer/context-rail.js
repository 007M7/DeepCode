// Context Rail — (demo 批 2 §1.2 shared canvas).
//
// The rail is a right-side drawer that projects a session's event stream
// onto a vertical timeline of context-changing dots (inject / compact /
// recall / steer). §1.2 declares this rail is the shared canvas for §1.2
// (context changes), §1.6 (workflow steps), and §1.7 (compact segments).
//
// This batch implements §1.2 + §1.7 slices (workflow dots reserved for
// batch 3 — the classifier already knows the family, they just don't
// arrive on wire yet; see strategy list §1.6 "wire 空档").
//
// Two exports:
//   classifyEventForRail(event) — pure; returns a dot family + label or
//   null when the event doesn't earn a rail dot.
//   summariseByTurn(events) — pure; per-turn inject/compact/recall/steer
//   counters for §1.2's "⇅ context — 注入 N · 压缩 M · 召回 K" badge.
//   buildRail(doc, events, {onDotClick}) — renders a vertical timeline.

'use strict'

// Recall tool-name set — kept in sync with renderer.js:RECALL_TOOL_NAMES.
// Named with a module-local prefix so it doesn't collide with the top-level
// `RECALL_TOOL_NAMES` declared in renderer.js (both files load as classic
// script tags into one shared global scope; a duplicate const is a hard
// SyntaxError. See test/renderer-collisions.test.js).
const RAIL_RECALL_TOOL_NAMES = new Set(['history_read', 'history_search'])

/**
 * @param {object} event   a SessionEvent (needs .type, .seq, .time, .data)
 * @returns {object|null}  {family, seq, time, label, plugin?, spanEnd?}
 */
function classifyEventForRail(event) {
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') return null
  const data = event.data || {}
  const seq = typeof event.seq === 'number' ? event.seq : 0
  const time = typeof event.time === 'number' ? event.time : 0

  if (event.type === 'context/message') {
    const src = data.source
    const plugin = src && src.kind === 'plugin' && typeof src.plugin === 'string' ? src.plugin
      : src && src.kind === 'user' ? 'user'
      : 'other'
    const preview = summarizeBlocks(data.content, 40)
    return { family: 'inject', seq, time, label: `inject · ${plugin} · ${preview}`, plugin }
  }
  if (event.type === 'steering/message') {
    return { family: 'steering', seq, time, label: `steer · ${summarizeBlocks(data.content, 40)}` }
  }
  if (event.type === 'compact/summary') {
    const r = data.shadowedRange
    const spanEnd = r && Number.isFinite(r.end) ? r.end : seq
    const n = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : null
    return {
      family: 'compact', seq, time,
      label: n !== null ? `compact · shadowed ${n} events` : `compact · seq ${r ? r.start : '?'}–${spanEnd}`,
      spanEnd,
    }
  }
  if (event.type === 'tool/call' && RAIL_RECALL_TOOL_NAMES.has(data.name)) {
    return { family: 'recall', seq, time, label: `recall · ${data.name}`, plugin: data.name }
  }
  // §1.6 workflow — batch 3 recognises the `workflow` tool call as the anchor
  // for a workflow card (kind comes from arguments.kind). The mock/workflow-step
  // ticks and subagent.started/finished events feed the same green rail family
  // so a viewer sees "workflow began here" without every step becoming a dot.
  if (event.type === 'tool/call' && data.name === 'workflow') {
    let wfName = ''
    let kind = ''
    if (typeof data.arguments === 'string') {
      try { const p = JSON.parse(data.arguments); wfName = p.name || ''; kind = p.kind || '' } catch (_) {}
    } else if (data.arguments && typeof data.arguments === 'object') {
      wfName = data.arguments.name || ''
      kind = data.arguments.kind || ''
    }
    const label = wfName ? `workflow · ${wfName}${kind ? ` (${kind})` : ''}` : 'workflow'
    return { family: 'workflow', seq, time, label }
  }
  // §1.4 subagent lifecycle — the fixtures inline subagent.started as a
  // pseudo-event with type='_notification' method='subagent.started'; when
  // the debug loader stamps them into the cachedEvents ring we still want
  // a rail dot so parallel subagents show up on the timeline.
  if (event.type === '_notification' && typeof event.method === 'string' && event.method.startsWith('subagent.')) {
    const p = event.params || {}
    const which = event.method.slice('subagent.'.length)
    const label = `subagent · ${which} · ${p.childSessionId ? railShortId(p.childSessionId) : '?'}`
    return { family: 'subagent', seq, time, label }
  }
  return null
}

function railShortId(id) {
  if (!id) return '?'
  return id.length > 10 ? id.slice(0, 4) + '…' + id.slice(-4) : id
}

function summarizeBlocks(blocks, max) {
  if (!Array.isArray(blocks)) return ''
  const text = blocks
    .map((b) => (b && b.type === 'text' && typeof b.text === 'string') ? b.text : '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return '(empty)'
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

/**
 * @param {Array<object>} events  session events, seq-ordered, incl. turn/end
 * @returns {Array<{turn, inject, compact, recall, steer, firstSeq, lastSeq}>}
 */
function summariseByTurn(events) {
  if (!Array.isArray(events)) return []
  const groups = []
  let current = null
  const start = (turn) => ({ turn, inject: 0, compact: 0, recall: 0, steer: 0, firstSeq: 0, lastSeq: 0 })
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    if (!current) current = start((ev.data && ev.data.turn) || 0)
    const seq = typeof ev.seq === 'number' ? ev.seq : 0
    if (!current.firstSeq) current.firstSeq = seq
    current.lastSeq = seq
    const dot = classifyEventForRail(ev)
    if (dot) {
      if (dot.family === 'inject')   current.inject++
      if (dot.family === 'compact')  current.compact++
      if (dot.family === 'recall')   current.recall++
      if (dot.family === 'steering') current.steer++
      if (dot.family === 'workflow') { current.workflow = (current.workflow || 0) + 1 }
      if (dot.family === 'subagent') { current.subagent = (current.subagent || 0) + 1 }
    }
    if (ev.type === 'turn/end') {
      current.turn = (ev.data && ev.data.turn) || current.turn
      groups.push(current)
      current = null
    }
  }
  if (current && (current.inject || current.compact || current.recall || current.steer)) {
    groups.push(current)
  }
  return groups
}

/**
 * @param {Document} doc
 * @param {Array<object>} events
 * @param {{onDotClick?: (dot: object) => void}} [opts]
 * @returns {HTMLElement}
 */
function buildRail(doc, events, opts) {
  const wrap = doc.createElement('div')
  wrap.className = 'context-rail'
  const dots = []
  if (Array.isArray(events)) {
    for (const ev of events) {
      const dot = classifyEventForRail(ev)
      if (dot) dots.push(dot)
    }
  }
  if (dots.length === 0) {
    const empty = doc.createElement('div')
    empty.className = 'context-rail-empty'
    empty.textContent = 'No context events yet — inject/compact/recall dots will appear here.'
    wrap.appendChild(empty)
    return wrap
  }
  const timeline = doc.createElement('div')
  timeline.className = 'context-rail-timeline'
  for (const dot of dots) {
    const row = doc.createElement('button')
    row.type = 'button'
    row.className = `context-rail-dot context-rail-dot--${dot.family}`
    row.dataset.seq = String(dot.seq)
    row.dataset.family = dot.family
    row.setAttribute('title', dot.label)
    const glyph = doc.createElement('span')
    glyph.className = 'context-rail-dot-glyph'
    row.appendChild(glyph)
    const label = doc.createElement('span')
    label.className = 'context-rail-dot-label'
    label.textContent = dot.label
    row.appendChild(label)
    if (dot.family === 'compact' && Number.isFinite(dot.spanEnd) && dot.spanEnd !== dot.seq) {
      const span = doc.createElement('span')
      span.className = 'context-rail-dot-span'
      span.textContent = `→ seq ${dot.spanEnd}`
      row.appendChild(span)
    }
    if (opts && typeof opts.onDotClick === 'function') {
      row.addEventListener('click', () => opts.onDotClick(dot))
    }
    timeline.appendChild(row)
  }
  wrap.appendChild(timeline)
  return wrap
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { classifyEventForRail, summariseByTurn, buildRail }
}
if (typeof window !== 'undefined') {
  window.__dshContextRail = { classifyEventForRail, summariseByTurn, buildRail }
}
