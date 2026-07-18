// Widget renderer: turns a WidgetSpec (JSON) into an inline DOM node.
//
// Design contract (see docs/widget-channel-design.md, and the verb catalog
// in next-actions.js):
//   - Input is JSON, output is DOM. No dynamic script, no innerHTML from
//     spec strings; every string goes through textContent.
//   - `spec.actions[]` becomes a row of buttons. Each action carries a
//     `verb` (see next-actions.js VERBS) drawn from a small catalog of
//     REAL side-effects (`prompt` / `open_link` / `open_artifact` /
//     `switch_session`) plus one RECORD-ONLY verb (`note`, log-only).
//     Legacy actions with no `verb` default to `prompt` for back-compat.
//   - Unknown verbs OR actions missing required payload fields render as
//     DISABLED buttons with an "unsupported action" tooltip. A button that
//     looks live but does nothing is the failure mode we're guarding
//     against (see next-action-ui-lab SKILL.md Part 1 for the pattern).
//   - Unknown `kind` falls through to a muted "unsupported widget" box.
//     Never throws — a widget-blind fallback must always be visible.
//
// Wire arrival (real path, once runtime lands `card: 'widget'` in
// tool render intent):
//   session.event { type: 'tool/result', data: { meta: WidgetResultView } }
//   where meta = { card: 'widget', title?, widget: WidgetSpec }
// The renderer receives just the WidgetSpec, not the wrapping meta.

'use strict'

// Pull the verb catalog + validator from next-actions.js. We do it via the
// same window/module dual-attach trick layout-heuristics uses so tests can
// require this file directly. Widgets refuse to render actions the catalog
// doesn't know about — but they never throw. See the contract at top-of-file.
const NA = (typeof module !== 'undefined' && module.exports)
  ? require('./next-actions.js')
  : (typeof globalThis !== 'undefined' && globalThis.NextActions)
      ? globalThis.NextActions
      : null

/**
 * Render a widget spec into a fresh DOM element.
 * @param {object} spec — WidgetSpec ({ kind, id, data, actions? })
 * @param {object} api  — { sessionId, sendPrompt(sessionId, text), ...verbs }
 * @returns {HTMLElement}
 */
function renderWidget(spec, api) {
  if (!spec || typeof spec !== 'object' || typeof spec.kind !== 'string') {
    return renderUnsupported('(malformed widget)')
  }

  // Validate the envelope up front. `broken` on the spec itself (bad kind /
  // missing id) draws a red-tinted error card that still tries to render the
  // body; broken *actions* just disable their buttons. This matches the
  // next-action-ui-lab pattern of "fail LOUD at the envelope, fail SILENT
  // per-action" — a spec-level failure indicates a producer bug we want
  // yelling; a broken button indicates the model wrote a bad wire.
  const validation = NA ? NA.validateWidgetSpec(spec) : { valid: true, issues: [] }

  const wrap = document.createElement('div')
  wrap.className = `widget widget-${spec.kind}`
  wrap.dataset.widgetId = spec.id || ''
  if (!validation.valid) {
    wrap.classList.add('widget-broken')
    wrap.setAttribute('data-broken', '1')
    // Envelope-level notice on top so reviewers see the diagnosis at a
    // glance. Individual action-level issues stay on their button tooltip.
    const specIssues = validation.issues.filter((i) =>
      i.severity === 'broken' && !/^actions\[/.test(i.field))
    if (specIssues.length > 0) {
      const banner = document.createElement('div')
      banner.className = 'widget-broken-banner'
      banner.textContent = 'broken widget: ' + specIssues.map((i) => i.message).join('; ')
      wrap.appendChild(banner)
    }
  }

  let body
  switch (spec.kind) {
    case 'table':   body = renderTable(spec.data);   break
    case 'chart':   body = renderChart(spec.data);   break
    case 'options': body = renderOptions(spec.data); break
    case 'kv':      body = renderKv(spec.data);      break
    default:        body = renderUnsupported(spec.kind)
  }
  wrap.appendChild(body)

  if (Array.isArray(spec.actions) && spec.actions.length > 0) {
    wrap.appendChild(renderActions(spec.actions, api))
  }

  // Option-pick delegation: a click on an options-widget row bubbles a
  // custom event; we route it to the matching action's verb (via the same
  // dispatcher renderActions uses). Falling back to a synthesized prompt
  // means a bare options widget still works.
  wrap.addEventListener('widget-option-picked', (ev) => {
    const detail = ev.detail || {}
    const action = Array.isArray(spec.actions)
      ? spec.actions.find((a) => a && a.id === detail.optionId)
      : null
    if (action) {
      dispatchVerb(action, api)
      return
    }
    // No matching action — synthesize a prompt from the picked label so
    // bare options widgets stay useful. Legacy behavior.
    const prompt = detail.label ? String(detail.label) : String(detail.optionId || '')
    if (prompt && api && typeof api.sendPrompt === 'function' && api.sessionId) {
      void api.sendPrompt(api.sessionId, prompt)
    }
  })
  return wrap
}

// -- table --------------------------------------------------------------------

function renderTable(data) {
  const container = document.createElement('div')
  container.className = 'widget-body'
  if (!data || !Array.isArray(data.columns) || !Array.isArray(data.rows)) {
    return renderUnsupported('table: missing columns/rows')
  }
  const table = document.createElement('table')
  const thead = document.createElement('thead')
  const trh = document.createElement('tr')
  for (const col of data.columns) {
    const th = document.createElement('th')
    th.textContent = col.label != null ? String(col.label) : String(col.key)
    if (col.align) th.style.textAlign = col.align
    trh.appendChild(th)
  }
  thead.appendChild(trh)
  table.appendChild(thead)

  const tbody = document.createElement('tbody')
  for (const row of data.rows) {
    const tr = document.createElement('tr')
    for (const col of data.columns) {
      const td = document.createElement('td')
      const v = row ? row[col.key] : ''
      td.textContent = v == null ? '' : String(v)
      if (col.align) td.style.textAlign = col.align
      tr.appendChild(td)
    }
    tbody.appendChild(tr)
  }
  table.appendChild(tbody)
  container.appendChild(table)

  if (data.caption) {
    const cap = document.createElement('div')
    cap.className = 'widget-caption'
    cap.textContent = data.caption
    container.appendChild(cap)
  }
  return container
}

// -- chart --------------------------------------------------------------------

function renderChart(data) {
  const container = document.createElement('div')
  container.className = 'widget-body'
  if (!data || !Array.isArray(data.labels) || !Array.isArray(data.series) || data.series.length === 0) {
    return renderUnsupported('chart: missing labels/series')
  }
  // Hand-drawn SVG. Kept dependency-free on purpose: this widget is meant to
  // "read at a glance"; anything richer belongs in an artifact.
  const W = 660, H = 200, PAD_L = 40, PAD_R = 12, PAD_T = 12, PAD_B = 32
  const innerW = W - PAD_L - PAD_R
  const innerH = H - PAD_T - PAD_B
  const chartType = data.chartType === 'line' ? 'line' : 'bar'

  const allValues = data.series.flatMap((s) => (Array.isArray(s.values) ? s.values : []))
  // C23 (drift cycle 18): NA fallback — a series carrying only null/undefined
  // (or a non-numeric shape) previously blew through `Math.max(0, ...)` and
  // yielded a broken chart (NaN axis, invisible bars). Now we filter to
  // finite numbers, warn once, and fall back to a flat 0-baseline so the
  // chart still renders — no bars visible, but the axis and legend are
  // intact and the surrounding widget doesn't crash.
  const numericValues = allValues.filter((v) => typeof v === 'number' && Number.isFinite(v))
  if (numericValues.length === 0 && allValues.length > 0) {
    console.warn('widgets.js chart: no finite numeric values in series, falling back to flat baseline')
  }
  const maxV = Math.max(0, ...numericValues)
  const yTop = maxV === 0 ? 1 : maxV * 1.1
  // D35 (drift cycle 18): chart series colors read from CSS tokens
  // (--chart-series-0..3) so widgets.js and any other chart consumer
  // share one palette. Series 0 keeps `--accent` for continuity with
  // the rest of the app; the remaining three live in style.css and
  // can be re-themed without touching this file.
  const seriesColors = [
    'var(--chart-series-0)',
    'var(--chart-series-1)',
    'var(--chart-series-2)',
    'var(--chart-series-3)',
  ]

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svg.setAttribute('width', '100%')
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
  svg.classList.add('widget-chart-svg')

  // Y axis line + label
  const axis = document.createElementNS('http://www.w3.org/2000/svg', 'line')
  axis.setAttribute('x1', PAD_L); axis.setAttribute('y1', PAD_T)
  axis.setAttribute('x2', PAD_L); axis.setAttribute('y2', PAD_T + innerH)
  axis.setAttribute('stroke', 'var(--border)'); axis.setAttribute('stroke-width', '1')
  svg.appendChild(axis)
  const xAxis = document.createElementNS('http://www.w3.org/2000/svg', 'line')
  xAxis.setAttribute('x1', PAD_L); xAxis.setAttribute('y1', PAD_T + innerH)
  xAxis.setAttribute('x2', PAD_L + innerW); xAxis.setAttribute('y2', PAD_T + innerH)
  xAxis.setAttribute('stroke', 'var(--border)'); xAxis.setAttribute('stroke-width', '1')
  svg.appendChild(xAxis)

  // Y ticks (0, mid, top)
  for (const t of [0, 0.5, 1]) {
    const y = PAD_T + innerH - t * innerH
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text')
    label.setAttribute('x', PAD_L - 6); label.setAttribute('y', y + 3)
    label.setAttribute('text-anchor', 'end')
    label.setAttribute('font-size', '10'); label.setAttribute('fill', 'var(--muted)')
    label.textContent = String(Math.round(yTop * t))
    svg.appendChild(label)
  }

  const N = data.labels.length
  const bandW = N > 0 ? innerW / N : innerW
  const seriesCount = data.series.length

  data.series.forEach((series, si) => {
    const color = seriesColors[si % seriesColors.length]
    const values = Array.isArray(series.values) ? series.values : []
    if (chartType === 'bar') {
      const barW = Math.max(2, (bandW * 0.7) / seriesCount)
      values.forEach((v, i) => {
        const h = (Math.max(0, v) / yTop) * innerH
        const x = PAD_L + i * bandW + (bandW - barW * seriesCount) / 2 + si * barW
        const y = PAD_T + innerH - h
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
        rect.setAttribute('x', x); rect.setAttribute('y', y)
        rect.setAttribute('width', barW); rect.setAttribute('height', h)
        rect.setAttribute('fill', color); rect.setAttribute('rx', '2')
        svg.appendChild(rect)
      })
    } else {
      let d = ''
      values.forEach((v, i) => {
        const x = PAD_L + (i + 0.5) * bandW
        const y = PAD_T + innerH - (Math.max(0, v) / yTop) * innerH
        d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1) + ' '
      })
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', d.trim())
      path.setAttribute('fill', 'none')
      path.setAttribute('stroke', color)
      path.setAttribute('stroke-width', '2')
      path.setAttribute('stroke-linejoin', 'round')
      svg.appendChild(path)
      // markers
      values.forEach((v, i) => {
        const x = PAD_L + (i + 0.5) * bandW
        const y = PAD_T + innerH - (Math.max(0, v) / yTop) * innerH
        const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
        c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', '2.5')
        c.setAttribute('fill', color)
        svg.appendChild(c)
      })
    }
  })

  // X axis labels
  data.labels.forEach((lab, i) => {
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text')
    t.setAttribute('x', PAD_L + (i + 0.5) * bandW)
    t.setAttribute('y', PAD_T + innerH + 14)
    t.setAttribute('text-anchor', 'middle')
    t.setAttribute('font-size', '10'); t.setAttribute('fill', 'var(--muted)')
    t.textContent = String(lab)
    svg.appendChild(t)
  })

  // Legend
  if (seriesCount > 1) {
    const legend = document.createElement('div')
    legend.className = 'widget-chart-legend'
    data.series.forEach((s, si) => {
      const item = document.createElement('span')
      item.className = 'widget-chart-legend-item'
      const swatch = document.createElement('span')
      swatch.className = 'widget-chart-swatch'
      swatch.style.background = seriesColors[si % seriesColors.length]
      const name = document.createElement('span')
      name.textContent = s.name || `series ${si + 1}`
      item.append(swatch, name)
      legend.appendChild(item)
    })
    container.appendChild(legend)
  }
  container.appendChild(svg)
  return container
}

// -- options ------------------------------------------------------------------

function renderOptions(data) {
  const container = document.createElement('div')
  container.className = 'widget-body'
  if (!data || !Array.isArray(data.options)) {
    return renderUnsupported('options: missing options[]')
  }
  if (data.question) {
    const q = document.createElement('div')
    q.className = 'widget-options-q'
    q.textContent = data.question
    container.appendChild(q)
  }
  const list = document.createElement('div')
  list.className = 'widget-options-list'
  for (const opt of data.options) {
    const row = document.createElement('button')
    row.className = 'widget-option'
    row.type = 'button'
    row.dataset.optionId = opt.id || ''
    const label = document.createElement('div')
    label.className = 'widget-option-label'
    label.textContent = opt.label != null ? String(opt.label) : String(opt.id)
    row.appendChild(label)
    if (opt.hint) {
      const hint = document.createElement('div')
      hint.className = 'widget-option-hint'
      hint.textContent = opt.hint
      row.appendChild(hint)
    }
    // Note: `options` buttons pull their prompt from the associated
    // WidgetAction if the producer registered one; otherwise they emit a
    // default "I choose X" prompt so a bare options widget is still useful.
    row.addEventListener('click', () => {
      // If actions include an id matching this option, that action's prompt
      // wins. Otherwise, synthesize.
      row.dispatchEvent(new CustomEvent('widget-option-picked', {
        bubbles: true,
        detail: { optionId: opt.id, label: opt.label },
      }))
    })
    list.appendChild(row)
  }
  container.appendChild(list)
  if (data.footer) {
    const f = document.createElement('div')
    f.className = 'widget-caption'
    f.textContent = data.footer
    container.appendChild(f)
  }
  return container
}

// -- kv (compact fact card) ---------------------------------------------------

function renderKv(data) {
  const container = document.createElement('div')
  container.className = 'widget-body'
  if (!data || !Array.isArray(data.entries)) {
    return renderUnsupported('kv: missing entries[]')
  }
  const dl = document.createElement('dl')
  dl.className = 'widget-kv'
  for (const e of data.entries) {
    const dt = document.createElement('dt')
    dt.textContent = e.key != null ? String(e.key) : ''
    const dd = document.createElement('dd')
    dd.textContent = e.value != null ? String(e.value) : ''
    if (e.hint) dd.title = String(e.hint)
    dl.append(dt, dd)
  }
  container.appendChild(dl)
  return container
}

// -- actions row --------------------------------------------------------------
//
// Each action is a small verb envelope. The dispatcher below is the single
// point that touches the outside world; if verbs multiply (adding
// `open_workflow`, `run_skill`) they land here, nowhere else. RECORD-ONLY
// verbs (currently just `note`) fire a devtools-visible CustomEvent instead
// of an IPC and keep the user's world unchanged.

function renderActions(actions, api) {
  const row = document.createElement('div')
  row.className = 'widget-actions'
  for (const a of actions) {
    row.appendChild(renderActionButton(a, api))
  }
  return row
}

/**
 * Render one action button. Broken actions (unknown verb / missing payload)
 * render as disabled with a tooltip explaining why — deliberately visible so
 * the widget author sees the mistake without having to click.
 */
function renderActionButton(a, api) {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = a && a.label != null ? String(a.label) : String((a && a.id) || 'action')
  const variant = a && a.variant
  b.className = variant === 'primary'
    ? 'primary'
    : (variant === 'danger' ? 'danger' : 'ghost')
  const cls = NA ? NA.classifyAction(a) : { verb: { real: true }, broken: false, reason: null }
  if (cls.broken) {
    b.disabled = true
    b.classList.add('widget-action-broken')
    b.title = `unsupported action — ${cls.reason || 'broken'}`
    b.setAttribute('aria-disabled', 'true')
  } else if (cls.verb && cls.verb.real === false) {
    // Record-only: visually distinct (subtler) so users can tell it will not
    // send anything, but still clickable — pressing it logs the note.
    b.classList.add('widget-action-record')
    b.title = 'record-only (logs to devtools; nothing is sent)'
  }
  b.addEventListener('click', () => {
    if (b.disabled) return
    dispatchVerb(a, api)
  })
  return b
}

/**
 * Fire the verb behind an action. All side-effects funnel through here.
 * Legacy actions (no verb) fall back to `prompt` semantics.
 */
function dispatchVerb(action, api) {
  if (!action || typeof action !== 'object') return
  const cls = NA ? NA.classifyAction(action) : { verb: { kind: 'prompt', real: true }, broken: false }
  if (cls.broken) return
  const verb = cls.verb ? cls.verb.kind : 'prompt'
  const a = api || {}
  switch (verb) {
    case 'prompt': {
      const text = String(action.prompt || '')
      if (text && typeof a.sendPrompt === 'function' && a.sessionId) {
        void a.sendPrompt(a.sessionId, text)
      }
      break
    }
    case 'open_link': {
      const url = String(action.url || '')
      if (!url) break
      if (typeof a.openLink === 'function') { void a.openLink(url); break }
      // Fallback to window.dsh directly so tests that only stub sendPrompt
      // still see the try; in the shell this is the preload-backed path.
      const dsh = (typeof window !== 'undefined') ? window.dsh : null
      if (dsh && typeof dsh.openExternalUrl === 'function') void dsh.openExternalUrl(url)
      break
    }
    case 'open_artifact': {
      const id = String(action.artifactId || '')
      if (!id) break
      if (typeof a.openArtifact === 'function') { void a.openArtifact(id); break }
      const dsh = (typeof window !== 'undefined') ? window.dsh : null
      if (dsh && typeof dsh.openArtifact === 'function') void dsh.openArtifact(id)
      break
    }
    case 'switch_session': {
      const sid = String(action.sessionId || '')
      if (!sid) break
      if (typeof a.switchSession === 'function') { void a.switchSession(sid); break }
      // No preload equivalent — renderer.js binds `switchSession` via the
      // api arg. Log-only when absent so the click isn't wholly silent.
      recordNote(a, `switch_session requested to ${sid} (no handler wired)`)
      break
    }
    case 'note': {
      const msg = String(action.note || action.label || 'note')
      recordNote(a, msg)
      break
    }
    default:
      // Unreachable in practice; the classifier would have marked it broken.
      break
  }
}

/**
 * Fire a devtools-visible CustomEvent recording a record-only action. The
 * devtools panel subscribes to `dsh:widget-note` and appends the message to
 * its event stream. No user-world state changes.
 */
function recordNote(api, message) {
  const detail = {
    note: String(message || ''),
    sessionId: api && api.sessionId ? api.sessionId : null,
    at: Date.now(),
  }
  if (typeof document !== 'undefined' && document.body && typeof CustomEvent === 'function') {
    document.body.dispatchEvent(new CustomEvent('dsh:widget-note', { detail }))
  }
  // Also give tests a hook without touching the DOM.
  if (api && typeof api.onNote === 'function') api.onNote(detail)
}

// -- unsupported --------------------------------------------------------------

function renderUnsupported(reason) {
  const el = document.createElement('div')
  el.className = 'widget-unsupported'
  el.textContent = `unsupported widget: ${reason}`
  return el
}

// -- export -------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderWidget, dispatchVerb, renderActionButton }
} else {
  // Attach to window so renderer.js can pick it up (both are loaded as
  // classic scripts).
  window.__dshWidgets = { renderWidget, dispatchVerb, renderActionButton }
}
