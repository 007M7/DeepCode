// turn-flow-glyph.js — inline "shape of this turn" chip for the turn
// footer. Task #201; design definitive in docs/design-refs/trace-viz-forms.md
// §4d ("Per-turn flow glyph — verdict: yes, this is the differentiator
// worth building"). A ~120×20 SVG chain of dots connected by hairlines,
// one dot per loop step, colored by step kind (llm / tool / subagent /
// compact / error). Hovering a dot shows its step name; clicking the
// glyph dispatches a `dsh-open-turn-trace` CustomEvent so the caller
// can open the L3 trace drawer that already lives below the footer.
//
// Rationale (trace-viz-forms §4d):
//   1. the turn container already carries the trace inline — a shape-at-
//      a-glance in the footer lets the reader spot "this turn ran the
//      tool loop 6 times" without scrolling
//   2. it turns the trace into a *visual property of the conversation*,
//      not a separate view — DSH's product bet is that trace flows
//      inline, graph on demand at L3
//   3. costs almost nothing to draw with hand-rolled SVG (~50 LOC)
//
// Zero deps by mandate — we do not adopt mermaid / react-flow / cytoscape
// / d3 for this glyph (§5 rendering-tech recommendation).
//
// Pure export shape:
//
//   deriveGlyphSpec(steps) → { dots: [{kind, label, index}], count }
//     `steps` is the array assembled on `meta.turnSteps` — each element
//     is the trace-step record built by beginTraceStep/finishTraceStep
//     (turn/step/summary/outputs/events). Returns null when no steps.
//
//   buildTurnFlowGlyph(doc, spec, opts?) → <svg class='turn-flow-glyph'>
//     opts.onOpen: optional callback (fires the dsh-open-turn-trace
//     event by default). opts.title: aria-label + <title> text for the
//     whole glyph (default: "turn flow — N steps").
//
// Kind derivation (§4d palette): step outputs/events determine kind in
// priority order — errors first (so a red dot dominates and the reader
// spots the fault instantly), then subagent, compact, tool, llm. A
// pure-reasoning step (no outputs, no tool calls) falls back to `llm`
// because reasoning-only turns are still "the model thinking".

'use strict'

// Palette from trace-viz-forms.md §4d. Order in this map is priority
// order for kind derivation — first match wins. Values are token names
// resolved to CSS custom properties by the renderer; the raw hex
// fallbacks in the shipped stylesheet come from the DSH neutral token
// set (see style.css §turn-flow-glyph).
const STEP_KIND_ORDER = ['error', 'subagent', 'compact', 'tool', 'llm']

function isSubagentEvent(ev) {
  const t = ev && ev.type
  return t && typeof t === 'string' && t.indexOf('subagent') === 0
}
function isCompactEvent(ev) {
  const t = ev && ev.type
  return t && typeof t === 'string' && (t === 'compact/summary' || t.indexOf('compact/') === 0)
}
function isErrorEvent(ev) {
  if (!ev || typeof ev !== 'object') return false
  const t = ev.type
  if (typeof t === 'string' && (t === 'error' || t.indexOf('/error') !== -1)) return true
  const d = ev.data || ev
  return !!(d && typeof d === 'object' && d.error && (d.error.message || d.error.code))
}
function isToolCallOutput(ev) {
  return ev && ev.type === 'tool/call'
}
function isAssistantOutput(ev) {
  return ev && ev.type === 'assistant/message'
}

function stepKind(step) {
  if (!step || typeof step !== 'object') return 'llm'
  const events = Array.isArray(step.events) ? step.events : []
  const outputs = Array.isArray(step.outputs) ? step.outputs : []
  // Priority: error > subagent > compact > tool > llm.
  if (events.some(isErrorEvent) || outputs.some(isErrorEvent)) return 'error'
  if (events.some(isSubagentEvent)) return 'subagent'
  if (events.some(isCompactEvent)) return 'compact'
  if (outputs.some(isToolCallOutput)) return 'tool'
  if (outputs.some(isAssistantOutput)) return 'llm'
  return 'llm'
}

function stepLabel(step) {
  if (!step) return 'step'
  const s = step.summary && typeof step.summary === 'string' ? step.summary.trim() : ''
  const kind = stepKind(step)
  const num = (step.turn !== null && step.turn !== undefined && step.step !== null && step.step !== undefined)
    ? `${step.turn}.${step.step}`
    : (step.step !== null && step.step !== undefined ? `?.${step.step}` : '?')
  return s ? `${kind} · step ${num} — ${s}` : `${kind} · step ${num}`
}

/**
 * Derive the ordered dot list from a turn's trace-step records.
 * Returns null when the turn recorded no steps (single-shot chat with no
 * tool loop → nothing worth drawing; caller should not mount a glyph).
 *
 * Also returns null when the turn recorded fewer than 2 steps regardless
 * of payload signal (user 2026-07-18 echo-profile screenshot): a single-
 * dot glyph in a fixed 120×24 frame reads as "one point floating in a
 * grey box" — no shape-of-loop information, and the arbitrary indent
 * pushes surrounding metrics off-baseline. The minimum-information
 * threshold is "≥2 steps"; a lone step's information lives one layer
 * down in the trace drawer.
 *
 * @param {Array<object>|null|undefined} steps
 * @returns {{dots: Array<{kind:string,label:string,index:number}>, count:number}|null}
 */
function deriveGlyphSpec(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return null
  const dots = []
  for (let i = 0; i < steps.length; i++) {
    const kind = stepKind(steps[i])
    if (STEP_KIND_ORDER.indexOf(kind) === -1) continue
    dots.push({ kind, label: stepLabel(steps[i]), index: i })
  }
  if (dots.length === 0) return null
  // Minimum information threshold: a single-dot glyph is a rectangular
  // frame containing one point — it takes footer real-estate without
  // carrying loop-shape information the reader can act on, and its
  // horizontal centering inside the 120px frame looks like a random
  // indent next to the neighboring chips (user 2026-07-18 実機 screenshot
  // showed the lone dot floating with `↑20 ↓58` awkwardly offset).
  // Threshold is strict: <2 dots → null, even when the single step
  // carries outputs/events. Those are still reachable via the trace
  // drawer summary immediately below.
  if (dots.length < 2) return null
  return { dots, count: dots.length }
}

// Layout constants — tuned to §4d "~120×20" and hardened to spec §7:
//   * Fixed width (W) — regardless of step count, the glyph occupies the
//     same horizontal slot so the footer row does not jitter as new steps
//     stream in. Steps redistribute within the fixed frame.
//   * Fixed height (H) — bumped to 24 to satisfy spec §7 minimum click
//     target for clickable UI (the whole glyph opens the L3 drawer).
//   * All paddings/gaps are drawn from the 4px grid.
const DOT_R = 3            // radius in svg user units
const H = 24               // total glyph height (≥24 for click-target)
const W = 120              // fixed width — no row jitter as steps stream
const PAD_X = 8            // left/right internal padding (4px grid)
const MAX_STEP = 16        // upper bound on dot spacing at low counts

// computeWidth is retained for API stability (tests import it) and to make
// the fixed-frame contract explicit: caller can rely on a single
// horizontal footprint no matter the step count.
function computeWidth(_count) { return W }

/**
 * Build the SVG DOM node. All coloring goes through CSS custom
 * properties resolved on `.turn-flow-glyph-dot.kind-<kind>` — see
 * style.css §turn-flow-glyph. This means light/dark theming is handed
 * off to the tokens, not hard-coded in the SVG.
 *
 * @param {Document} doc
 * @param {{dots:Array<{kind:string,label:string,index:number}>,count:number}} spec
 * @param {{title?:string, onOpen?:(e:Event)=>void}} [opts]
 */
function buildTurnFlowGlyph(doc, spec, opts) {
  if (!spec || !Array.isArray(spec.dots) || spec.dots.length === 0) return null
  const NS = 'http://www.w3.org/2000/svg'
  const title = (opts && opts.title) || `turn flow — ${spec.count} step${spec.count === 1 ? '' : 's'}`
  const svg = doc.createElementNS(NS, 'svg')
  svg.setAttribute('class', 'turn-flow-glyph')
  svg.setAttribute('width', String(W))
  svg.setAttribute('height', String(H))
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svg.setAttribute('role', 'button')
  svg.setAttribute('tabindex', '0')
  svg.setAttribute('aria-label', title)
  const titleEl = doc.createElementNS(NS, 'title')
  titleEl.textContent = title
  svg.appendChild(titleEl)

  // Layout dots within the fixed W frame. At low step counts we honor
  // MAX_STEP so a 2-dot glyph reads as "two dots, close together" rather
  // than "one dot on each edge". At high counts we squeeze evenly. Row
  // stays a fixed width regardless (spec §7 — no width jitter).
  const usableWidth = W - PAD_X * 2 - DOT_R * 2
  let step = 0
  if (spec.count > 1) {
    step = Math.min(usableWidth / (spec.count - 1), MAX_STEP)
  }
  const groupWidth = step * (spec.count - 1)
  // Center the dot group horizontally in the fixed frame.
  const originX = PAD_X + DOT_R + (usableWidth - groupWidth) / 2
  // Vertically center dots (row is 24px, dots sit on the mid-line).
  const cy = H / 2

  // Connector polyline first so dots draw on top.
  if (spec.count > 1) {
    const pts = []
    for (let i = 0; i < spec.count; i++) {
      const cx = originX + i * step
      pts.push(`${cx.toFixed(2)},${cy.toFixed(2)}`)
    }
    const line = doc.createElementNS(NS, 'polyline')
    line.setAttribute('class', 'turn-flow-glyph-line')
    line.setAttribute('points', pts.join(' '))
    line.setAttribute('fill', 'none')
    svg.appendChild(line)
  }

  for (let i = 0; i < spec.dots.length; i++) {
    const dot = spec.dots[i]
    const cx = spec.count > 1 ? originX + i * step : W / 2
    const c = doc.createElementNS(NS, 'circle')
    c.setAttribute('class', `turn-flow-glyph-dot kind-${dot.kind}`)
    c.setAttribute('cx', cx.toFixed(2))
    c.setAttribute('cy', cy.toFixed(2))
    c.setAttribute('r', String(DOT_R))
    c.setAttribute('data-step-index', String(dot.index))
    const t = doc.createElementNS(NS, 'title')
    t.textContent = dot.label
    c.appendChild(t)
    svg.appendChild(c)
  }

  const fire = (e) => {
    if (typeof opts?.onOpen === 'function') { opts.onOpen(e); return }
    const detail = { source: 'turn-flow-glyph' }
    const CE = (typeof doc.defaultView !== 'undefined' && doc.defaultView && doc.defaultView.CustomEvent)
      || (typeof CustomEvent !== 'undefined' ? CustomEvent : null)
    if (CE) svg.dispatchEvent(new CE('dsh-open-turn-trace', { detail, bubbles: true }))
  }
  svg.addEventListener('click', fire)
  svg.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire(e) }
  })

  return svg
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    deriveGlyphSpec, buildTurnFlowGlyph, stepKind, stepLabel, computeWidth, STEP_KIND_ORDER,
  }
}
if (typeof window !== 'undefined') {
  window.__dshTurnFlowGlyph = { deriveGlyphSpec, buildTurnFlowGlyph }
}
