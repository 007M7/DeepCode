// Compact-card three-tab shell —, revised for #162.
//
// Strategy list §1.7 originally asked for 压前原文 / 压后摘要 / 策略与账.
// keep three tabs but **replace the
// 压前原文 tab with a 前后对照 (before→after diff) tab** so the compact
// card lives up to what a research reader wants — "show me what got
// compressed away and what the summary retained, side by side."
// (The Before-only tab was thin: it just linked to the P0-1 shadowed
// expander with no compressed-side context.)
//
// Current three tabs:
//
//   1. **Diff (前后对照)** — two columns: shadowed events on the left,
//      summary ContentBlock text on the right, with a compression-ratio
//      header row above ("N events / T tok → S tok  ~R.R×"). Fixtures
//      inline `_shadowedPreview: [{seq,type,gist}]` for demo rendering;
//      real wire falls back to the P0-1 lazy expander
//      (session/events{seq}) — see
//      + jsonrpc/src/server.ts:479-492.
//   2. **Summary** — the `summary: ContentBlock[]` the summarizer emitted
//      (same text the pre-tab-refactor compact card already showed).
//   3. **Policy & accounting** — `model`, `maxTokens`, `shadowedRange`,
//      plus the recovered trigger kind (`on-demand` / `pre-step` / `idle`).
//
// This module stays DOM-agnostic where it matters for tests: the pure
// helpers `classifyTriggerKind`, `formatStrategyRows`, and (new for)
// `buildDiffModel` all return plain shapes. `mountTabs` still touches the
// DOM but takes callbacks so the P0-1 shadowed expander and ContentBlock
// rendering stay in renderer.js.

'use strict'

/**
 * @param {unknown} trigger  turn/start.data.trigger for the enclosing turn
 * @returns {'on-demand'|'pre-step'|'idle'}
 */
function classifyTriggerKind(trigger) {
  if (!trigger || typeof trigger !== 'object') return 'idle'
  if (trigger.kind === 'injection') {
    const src = trigger.source
    if (src && src.kind === 'plugin' && src.plugin === 'compact') return 'on-demand'
    return 'idle'
  }
  if (trigger.kind === 'user') return 'pre-step'
  return 'idle'
}

const TRIGGER_LABELS = {
  'on-demand': 'on-demand (user/tool-invoked session/compact)',
  'pre-step':  'pre-step (safety valve fired mid-turn)',
  'idle':      'idle (other call paths)',
}

/**
 * Flatten compact/summary.data + triggerKind into label→value rows for the
 * "策略与账" tab. Missing fields drop rows (no invented placeholders).
 *
 * @param {object} data
 * @param {'on-demand'|'pre-step'|'idle'} triggerKind
 * @returns {Array<{label:string, value:string}>}
 */
function formatStrategyRows(data, triggerKind) {
  const rows = []
  rows.push({ label: 'Trigger', value: TRIGGER_LABELS[triggerKind] || triggerKind })
  if (typeof data.model === 'string' && data.model) {
    rows.push({ label: 'Summary model', value: data.model })
  }
  if (Number.isFinite(data.maxTokens) && data.maxTokens > 0) {
    rows.push({ label: 'Summary cap', value: `≤${data.maxTokens} tok` })
  }
  const r = data.shadowedRange
  if (r && Number.isFinite(r.start) && Number.isFinite(r.end)) {
    rows.push({ label: 'Compacted range', value: `seq ${r.start} – ${r.end}` })
  }
  if (Number.isFinite(data.shadowedTokenCount)) {
    rows.push({ label: 'Compacted volume', value: `${data.shadowedTokenCount} tok` })
  }
  if (Array.isArray(data.shadowedSeqs)) {
    rows.push({ label: 'Event count', value: `${data.shadowedSeqs.length} events` })
  }
  const reason = typeof data.reason === 'string' ? data.reason.trim() : ''
  if (reason) rows.push({ label: 'User reason', value: reason })
  return rows
}

/**
 * Build a plain-object model for the Diff tab (前后对照). Rendering is
 * left to renderer.js so this module stays DOM-agnostic and tests can
 * assert on the model directly.
 *
 * Left column — one row per shadowed event. Priority order:
 *   1) data._shadowedPreview  (fixture-provided; array of {seq,type,gist})
 *   2) data.shadowedSeqs      (real wire; opaque list — expander needed)
 *   3) data.shadowedRange     (range-only; empty list + note)
 *
 * Right column — text extracted from `data.summary` (ContentBlock[]).
 * Extraction is done here so both the header ratio and the body share one
 * source of truth. `extractText` is injected by the caller so we don't
 * duplicate renderer.js textFromContentBlocks.
 *
 * Header — {events, beforeTokens, afterTokens, ratio}:
 *   events       = shadowedSeqs.length (or preview.length)
 *   beforeTokens = data.shadowedTokenCount (or data.tokens; may be null)
 *   afterTokens  = summary text length ÷ 4 rounded up  (chars→tokens
 *                  approximation, matches the trace-samples token math)
 *   ratio        = beforeTokens / afterTokens  (null when either side
 *                  unknown or afterTokens=0)
 *
 * @param {object} data  compact/summary.data
 * @param {(blocks: unknown) => string} extractText  ContentBlock→text
 * @returns {{
 *   header: {events:number|null, beforeTokens:number|null, afterTokens:number|null, ratio:number|null},
 *   left:   {source:'preview'|'seqs'|'range'|'empty', rows:Array<{seq:number,type:string,gist:string}>, seqs:number[]|null, range:{start:number,end:number}|null},
 *   right:  {text:string}
 * }}
 */
function buildDiffModel(data, extractText) {
  const summaryText = typeof extractText === 'function'
    ? String(extractText(data && data.summary) || '')
    : ''
  const afterTokens = summaryText ? Math.ceil(summaryText.length / 4) : null
  let beforeTokens = null
  if (data && Number.isFinite(data.shadowedTokenCount)) beforeTokens = data.shadowedTokenCount
  else if (data && Number.isFinite(data.tokens)) beforeTokens = data.tokens

  let events = null
  let left
  if (data && Array.isArray(data._shadowedPreview) && data._shadowedPreview.length > 0) {
    const rows = data._shadowedPreview.map((row) => ({
      seq: Number.isFinite(row && row.seq) ? row.seq : 0,
      type: typeof (row && row.type) === 'string' ? row.type : '',
      gist: typeof (row && row.gist) === 'string' ? row.gist : '',
    }))
    events = rows.length
    left = { source: 'preview', rows, seqs: null, range: null }
  } else if (data && Array.isArray(data.shadowedSeqs) && data.shadowedSeqs.length > 0) {
    events = data.shadowedSeqs.length
    left = { source: 'seqs', rows: [], seqs: data.shadowedSeqs.slice(), range: null }
  } else if (data && data.shadowedRange
      && Number.isFinite(data.shadowedRange.start)
      && Number.isFinite(data.shadowedRange.end)) {
    const r = data.shadowedRange
    events = Math.max(0, r.end - r.start + 1)
    left = { source: 'range', rows: [], seqs: null, range: { start: r.start, end: r.end } }
  } else {
    left = { source: 'empty', rows: [], seqs: null, range: null }
  }

  let ratio = null
  if (Number.isFinite(beforeTokens) && Number.isFinite(afterTokens) && afterTokens > 0) {
    ratio = beforeTokens / afterTokens
  }

  return {
    header: { events, beforeTokens, afterTokens, ratio },
    left,
    right: { text: summaryText },
  }
}


/**
 * Build the three-tab DOM shell inside `parent`. Callers fill each tab
 * body via callbacks so this module doesn't re-implement the P0-1
 * shadowed-events expander or ContentBlock rendering.
 *
 * Tabs are keyboard-navigable (aria-selected + Arrow keys). Default open
 * = "Summary" so a scan lands on the compacted result just like the
 * pre-refactor card did.
 *
 * @param {HTMLElement} parent
 * @param {object} opts
 * @param {Document} [opts.document]  test harness passes this; production
 *   falls back to parent.ownerDocument or globalThis.document.
 * @param {'pre'|'post'|'meta'} [opts.initial='post']
 * @param {(bodyEl: HTMLElement) => void} [opts.fillPre]
 * @param {(bodyEl: HTMLElement) => void} [opts.fillPost]
 * @param {(bodyEl: HTMLElement) => void} [opts.fillMeta]
 * @param {(bodyEl: HTMLElement) => void} [opts.fillConfig]  lane-ctx-deep F2 —
 *   optional 4th tab "Config". Omit to keep the pre-fix three-tab shape
 *   (the strip auto-hides the tab when the fill callback is not passed).
 * @returns {{ preBody: HTMLElement, postBody: HTMLElement, metaBody: HTMLElement, configBody: HTMLElement|null }}
 */
function mountTabs(parent, opts) {
  // Resolve doc without touching a bare `document` binding (renderer harness
  // wraps this module in a Function scope where `document` isn't visible).
  const doc = (opts && opts.document)
    || parent.ownerDocument
    || (typeof globalThis !== 'undefined' && globalThis.document)
    || null
  if (!doc) throw new Error('mountTabs: no document available (pass opts.document)')

  const wrap = doc.createElement('div')
  wrap.className = 'compact-card-tabs'
  const strip = doc.createElement('div')
  strip.className = 'compact-card-tabstrip'
  strip.setAttribute('role', 'tablist')
  const initial = (opts && opts.initial) || 'post'
  const hasConfig = opts && typeof opts.fillConfig === 'function'
  const tabs = [
    { id: 'pre',  label: 'Diff' },
    { id: 'post', label: 'Summary' },
    { id: 'meta', label: 'Policy & accounting' },
  ]
  if (hasConfig) tabs.push({ id: 'config', label: 'Config' })
  const bodies = {}
  const buttons = {}
  for (const t of tabs) {
    const btn = doc.createElement('button')
    btn.type = 'button'
    btn.className = 'compact-card-tab'
    btn.textContent = t.label
    btn.setAttribute('role', 'tab')
    btn.id = `compact-tab-${t.id}-${Math.random().toString(36).slice(2, 8)}`
    const isActive = t.id === initial
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false')
    btn.tabIndex = isActive ? 0 : -1
    strip.appendChild(btn)
    buttons[t.id] = btn
    const body = doc.createElement('div')
    body.className = 'compact-card-tabpanel'
    body.setAttribute('role', 'tabpanel')
    body.setAttribute('aria-labelledby', btn.id)
    body.hidden = !isActive
    bodies[t.id] = body
  }
  const activate = (id) => {
    for (const t of tabs) {
      const on = t.id === id
      buttons[t.id].setAttribute('aria-selected', on ? 'true' : 'false')
      buttons[t.id].tabIndex = on ? 0 : -1
      bodies[t.id].hidden = !on
    }
  }
  strip.addEventListener('click', (ev) => {
    const target = ev && ev.target
    if (!target) return
    const id = target === buttons.pre ? 'pre'
      : target === buttons.post ? 'post'
      : target === buttons.meta ? 'meta'
      : (hasConfig && target === buttons.config) ? 'config' : null
    if (id) activate(id)
  })
  strip.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return
    const order = hasConfig ? ['pre', 'post', 'meta', 'config'] : ['pre', 'post', 'meta']
    const active = order.find((id) => buttons[id].getAttribute('aria-selected') === 'true') || 'post'
    const idx = order.indexOf(active)
    const next = ev.key === 'ArrowRight' ? order[(idx + 1) % order.length] : order[(idx + order.length - 1) % order.length]
    activate(next)
    if (typeof buttons[next].focus === 'function') buttons[next].focus()
    if (typeof ev.preventDefault === 'function') ev.preventDefault()
  })
  wrap.appendChild(strip)
  wrap.appendChild(bodies.pre)
  wrap.appendChild(bodies.post)
  wrap.appendChild(bodies.meta)
  if (hasConfig) wrap.appendChild(bodies.config)
  parent.appendChild(wrap)
  if (opts && typeof opts.fillPre  === 'function') opts.fillPre(bodies.pre)
  if (opts && typeof opts.fillPost === 'function') opts.fillPost(bodies.post)
  if (opts && typeof opts.fillMeta === 'function') opts.fillMeta(bodies.meta)
  if (hasConfig) opts.fillConfig(bodies.config)
  return {
    preBody: bodies.pre,
    postBody: bodies.post,
    metaBody: bodies.meta,
    configBody: hasConfig ? bodies.config : null,
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { classifyTriggerKind, formatStrategyRows, buildDiffModel, mountTabs, TRIGGER_LABELS }
}
if (typeof window !== 'undefined') {
  window.__dshCompactCard = { classifyTriggerKind, formatStrategyRows, buildDiffModel, mountTabs, TRIGGER_LABELS }
}
