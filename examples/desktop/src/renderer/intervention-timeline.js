// Human-intervention timeline projections — pure model behind the Context
// page's intervention marker strip (lane-ctx-deep, task #51 F3).
//
// Three intervention kinds surface as markers on the Context page's top
// axis. Each marker carries an anchor (turn number + first seq) so the UI
// can jump the Chat stream to the exact turn on click:
//
//   - edit-rerun  — a `user/message` event that carries a `data.editRerun`
//                    envelope (renderer.js seeds this shape when a user hits
//                    the tool-edit-rerun panel) OR whose plugin source is
//                    `edit-rerun`. Falls back to a heuristic when the
//                    envelope's absent: adjacent user/message + user/message
//                    with identical `data.origSeq` fields.
//   - fork        — a `session/fork` marker (renderer maintains a
//                    `forkMarkers` map in state; when the daemon reports
//                    a fork the event stream carries `context/message` with
//                    source={kind:'fork', ...}). We also accept the raw
//                    daemon event type `session/forked` for symmetry.
//   - steer       — a `steering/message` event.
//
// The projection returns markers in seq order — the marker strip renders
// them left-to-right along a horizontal axis. Multiple markers on the same
// turn stack into a badge; the UI resolves stacking, this model just emits
// each marker once.
//
// Pure module. Coverage in test/intervention-timeline.test.js.

'use strict'

const KIND_LABELS = Object.freeze({
  'edit-rerun': 'Edit & re-run',
  'fork':       'Fork',
  'steer':      'Steer',
})

const KIND_GLYPHS = Object.freeze({
  'edit-rerun': '↺',
  'fork':       'Y',
  'steer':      '↷',
})

/**
 * @typedef {Object} InterventionMarker
 * @property {'edit-rerun'|'fork'|'steer'} kind
 * @property {string} label   Human-readable name.
 * @property {string} glyph   1-2 character glyph for the marker dot.
 * @property {number} seq     Event seq the marker anchors on.
 * @property {number} turn    Turn number the marker belongs to (0 for pre-first-turn).
 * @property {number} time    Wire event time (ms epoch).
 * @property {string} preview One-line preview text; empty when nothing sensible to show.
 */

function isEditRerun(ev) {
  if (!ev || ev.type !== 'user/message') return false
  const d = ev.data || {}
  if (d && d.editRerun) return true
  const src = d.source
  if (src && src.kind === 'plugin' && (src.plugin === 'edit-rerun' || src.plugin === 'tool-edit-rerun')) return true
  return false
}

function isFork(ev) {
  if (!ev || typeof ev.type !== 'string') return false
  if (ev.type === 'session/forked' || ev.type === 'session/fork') return true
  if (ev.type === 'context/message') {
    const src = ev.data && ev.data.source
    if (src && src.kind === 'fork') return true
    if (src && src.kind === 'plugin' && src.plugin === 'fork') return true
  }
  return false
}

function isSteer(ev) {
  return !!(ev && ev.type === 'steering/message')
}

function shortText(blocks) {
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const b of blocks) {
    if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  const joined = parts.join(' ')
  const trimmed = joined.replace(/\s+/g, ' ').trim()
  return trimmed.length > 80 ? trimmed.slice(0, 77) + '…' : trimmed
}

function previewFor(ev, kind) {
  if (!ev) return ''
  const d = ev.data || {}
  if (kind === 'edit-rerun') {
    if (d.editRerun && typeof d.editRerun.reason === 'string') return d.editRerun.reason
    if (d.editRerun && typeof d.editRerun.origSeq === 'number') return `orig seq ${d.editRerun.origSeq}`
    return shortText(d.content)
  }
  if (kind === 'fork') {
    if (typeof d.parentSeq === 'number') return `from seq ${d.parentSeq}`
    const src = d.source
    if (src && src.kind === 'fork' && typeof src.parentSeq === 'number') return `from seq ${src.parentSeq}`
    return shortText(d.content)
  }
  if (kind === 'steer') return shortText(d.content)
  return ''
}

/**
 * Compute the sorted marker list for a session's cached events. Every
 * marker's `turn` field reflects the turn window it belongs to (0 for
 * events before the first turn/end). The UI uses `turn+firstSeq` to jump
 * the Chat stream to the right bubble.
 *
 * @param {Array<object>} events
 * @returns {Array<InterventionMarker>}
 */
function collectInterventions(events) {
  if (!Array.isArray(events)) return []
  const out = []
  let turn = 0
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    let kind = null
    if (isEditRerun(ev)) kind = 'edit-rerun'
    else if (isFork(ev)) kind = 'fork'
    else if (isSteer(ev)) kind = 'steer'
    if (kind) {
      const seq = Number.isFinite(ev.seq) ? ev.seq : 0
      const time = Number.isFinite(ev.time) ? ev.time : 0
      out.push({
        kind,
        label: KIND_LABELS[kind],
        glyph: KIND_GLYPHS[kind],
        seq,
        turn,
        time,
        preview: previewFor(ev, kind),
      })
    }
    if (ev.type === 'turn/end') {
      const nextTurn = (ev.data && typeof ev.data.turn === 'number') ? (ev.data.turn + 1) : (turn + 1)
      turn = nextTurn
    }
  }
  // Deterministic order by seq — assumes cachedEvents is already seq-ordered
  // (renderer stores them in order), but sort explicitly for safety.
  out.sort((a, b) => a.seq - b.seq)
  return out
}

/**
 * Roll up the marker list into per-kind totals for a short legend line.
 * Empty kinds are omitted so the legend doesn't advertise "0 forks".
 * @param {Array<InterventionMarker>} markers
 * @returns {Array<{kind:string, label:string, count:number}>}
 */
function summariseInterventions(markers) {
  if (!Array.isArray(markers)) return []
  const counts = new Map()
  for (const m of markers) {
    if (!m) continue
    counts.set(m.kind, (counts.get(m.kind) || 0) + 1)
  }
  const out = []
  for (const kind of ['edit-rerun', 'fork', 'steer']) {
    const n = counts.get(kind) || 0
    if (n > 0) out.push({ kind, label: KIND_LABELS[kind], count: n })
  }
  return out
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    collectInterventions,
    summariseInterventions,
    isEditRerun, isFork, isSteer,
    KIND_LABELS, KIND_GLYPHS,
  }
}
if (typeof window !== 'undefined') {
  window.__dshInterventionTimeline = {
    collectInterventions,
    summariseInterventions,
    isEditRerun, isFork, isSteer,
    KIND_LABELS, KIND_GLYPHS,
  }
}
