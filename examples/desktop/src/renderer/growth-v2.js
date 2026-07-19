// Growth — rubric-evolution time-series view.
//
// This page was the "compact-window evolution log" (task #140). It has been
// re-authored as a rubric-score time-series view backed by the rubric-fusion
// event log. Horizontal axis = time (day) or harness version; each series =
// one rubric-dim; y = mean-01 score (or pass-rate, toggled by the header
// chip). Filter chips: harness version / model / data mix.
//
// This makes the page answer the question "is the harness getting better or
// worse over time, and on which rubric?" — which is what researchers
// actually need to see when they look at a Growth tab.
//
// Data source: window.__dshRubricFusion. Seed loaded once from
// window.__dshRubricFusionSeed if not already primed by another view.

'use strict'
;(function () {

const state = {
  by: 'day',                 // 'day' | 'version'
  metric: 'mean01',          // 'mean01' | 'passRate'
  groupBy: 'dim',            // 'dim' | 'rubric'
  filters: {                 // active filter chip values (null = all)
    harnessVersion: null,
    model: null,
    dataMix: null,
  },
  seeded: false,
}

let els = null

function fusion() {
  return typeof window !== 'undefined' ? window.__dshRubricFusion : null
}

function seedOnce() {
  const f = fusion()
  if (!f || state.seeded) return
  const seed = window.__dshRubricFusionSeed
  if (seed) f.loadFixture(seed)
  state.seeded = true
}

function $(id) { return document.getElementById(id) }
function el(tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

function mount() {
  const pane = document.querySelector('.pane[data-pane="growth"]')
  if (!pane) return
  pane.innerHTML = ''

  const header = el('header', 'header')
  const lead = el('div', 'header-lead')
  const title = el('div', 'page-title', 'Growth')
  const chip = el('span', 'demo-tier-chip')
  chip.textContent = 'demo · fusion'
  chip.title = 'Time-series driven from the rubric-fusion event log (docs/rubric-fusion-fixture.json).'
  title.appendChild(chip)
  lead.appendChild(title)
  lead.appendChild(el('div', 'page-sub muted', 'Rubric-score evolution over time. Each line is one rubric dim; toggle mean vs pass-rate, and bucket by day or by harness version.'))
  header.appendChild(lead)

  const acts = el('div', 'header-actions')
  const byDay = el('button', 'ghost small growth-fusion-by-chip active', 'By day')
  byDay.type = 'button'; byDay.dataset.by = 'day'
  const byVersion = el('button', 'ghost small growth-fusion-by-chip', 'By version')
  byVersion.type = 'button'; byVersion.dataset.by = 'version'
  const mMean = el('button', 'ghost small growth-fusion-metric-chip active', 'Mean score')
  mMean.type = 'button'; mMean.dataset.metric = 'mean01'
  const mPass = el('button', 'ghost small growth-fusion-metric-chip', 'Pass-rate')
  mPass.type = 'button'; mPass.dataset.metric = 'passRate'
  acts.append(byDay, byVersion, mMean, mPass)
  header.appendChild(acts)
  pane.appendChild(header)

  const body = el('section', 'growth-fusion-body')

  // Filter chip row.
  const filterRow = el('div', 'growth-fusion-filter-row')
  filterRow.id = 'growth-fusion-filter-row'
  body.appendChild(filterRow)

  // Empty state.
  const empty = el('div', 'growth-fusion-empty muted')
  empty.id = 'growth-fusion-empty'
  empty.textContent = 'No rubric scores yet. Once a run scores against a rubric, the curve will land here.'
  empty.hidden = true
  body.appendChild(empty)

  // Chart host.
  const chart = el('div', 'growth-fusion-chart')
  chart.id = 'growth-fusion-chart'
  body.appendChild(chart)

  // Legend + summary.
  const legend = el('div', 'growth-fusion-legend')
  legend.id = 'growth-fusion-legend'
  body.appendChild(legend)

  pane.appendChild(body)

  els = { pane, filterRow, chart, legend, empty, byDay, byVersion, mMean, mPass }

  for (const btn of [byDay, byVersion]) {
    btn.addEventListener('click', () => {
      state.by = btn.dataset.by
      byDay.classList.toggle('active', state.by === 'day')
      byVersion.classList.toggle('active', state.by === 'version')
      render()
    })
  }
  for (const btn of [mMean, mPass]) {
    btn.addEventListener('click', () => {
      state.metric = btn.dataset.metric
      mMean.classList.toggle('active', state.metric === 'mean01')
      mPass.classList.toggle('active', state.metric === 'passRate')
      render()
    })
  }
}

async function show() {
  if (!els) mount()
  seedOnce()
  const f = fusion()
  if (f && typeof f.subscribe === 'function' && !state._subscribed) {
    f.subscribe(() => { if (els) render() })
    state._subscribed = true
  }
  render()
}

function render() {
  if (!els) return
  const f = fusion()
  if (!f) { els.empty.hidden = false; return }

  renderFilterRow(f)

  const opts = {
    by: state.by,
    groupBy: state.groupBy,
    filter: {
      harnessVersion: state.filters.harnessVersion || undefined,
      model: state.filters.model || undefined,
      dataMix: state.filters.dataMix || undefined,
    },
  }
  const data = f.timeSeriesFor(opts)
  els.empty.hidden = data.xAxis.length > 0
  els.chart.innerHTML = ''
  els.legend.innerHTML = ''
  if (!data.xAxis.length) return

  renderChart(data)
  renderLegend(data)
}

function renderFilterRow(f) {
  els.filterRow.innerHTML = ''
  const events = f.listEvents({})
  const versions = new Set(), models = new Set(), mixes = new Set()
  for (const e of events) {
    if (e.harnessVersion) versions.add(e.harnessVersion)
    if (e.model) models.add(e.model)
    if (e.dataMix) mixes.add(e.dataMix)
  }
  els.filterRow.appendChild(makeFilterGroup('Harness', 'harnessVersion', Array.from(versions).sort()))
  els.filterRow.appendChild(makeFilterGroup('Model', 'model', Array.from(models).sort()))
  els.filterRow.appendChild(makeFilterGroup('Data mix', 'dataMix', Array.from(mixes).sort()))
}

function makeFilterGroup(label, key, values) {
  const group = el('div', 'growth-fusion-filter-group')
  group.appendChild(el('span', 'growth-fusion-filter-label muted small', label))
  const allBtn = el('button', 'ghost small growth-fusion-filter-chip' + (state.filters[key] == null ? ' active' : ''), 'all')
  allBtn.type = 'button'
  allBtn.addEventListener('click', () => { state.filters[key] = null; render() })
  group.appendChild(allBtn)
  for (const v of values) {
    const b = el('button', 'ghost small growth-fusion-filter-chip' + (state.filters[key] === v ? ' active' : ''), v)
    b.type = 'button'
    b.addEventListener('click', () => { state.filters[key] = v; render() })
    group.appendChild(b)
  }
  return group
}

// Line-chart SVG. X is index into xAxis (equal spacing); Y is metric on 0-1
// scale (pass-rate) or normalized mean-01 (same 0-1 range so a single Y
// axis reads both metrics).
function renderChart(data) {
  const W = 720
  const H = 240
  const padL = 40, padR = 24, padT = 16, padB = 40
  const svgNS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(svgNS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svg.setAttribute('class', 'growth-fusion-chart-svg')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', `Rubric score evolution over ${data.xAxis.length} ${state.by === 'day' ? 'days' : 'versions'}`)

  const xCount = data.xAxis.length
  const xStep = xCount > 1 ? (W - padL - padR) / (xCount - 1) : 0
  const xFor = (i) => padL + i * xStep
  const yFor = (v) => padT + (1 - v) * (H - padT - padB)

  // gridlines at 0/0.5/1
  for (const [v, label] of [[0, '0'], [0.5, '0.5'], [1, '1']]) {
    const y = yFor(v)
    const ln = document.createElementNS(svgNS, 'line')
    ln.setAttribute('x1', padL); ln.setAttribute('x2', W - padR)
    ln.setAttribute('y1', y); ln.setAttribute('y2', y)
    ln.setAttribute('class', 'growth-fusion-grid')
    svg.appendChild(ln)
    const t = document.createElementNS(svgNS, 'text')
    t.setAttribute('x', padL - 6); t.setAttribute('y', y + 4)
    t.setAttribute('text-anchor', 'end')
    t.setAttribute('class', 'growth-fusion-axis-tick')
    t.textContent = label
    svg.appendChild(t)
  }

  // x-axis labels (subsample if > 8)
  const maxLabels = 8
  const stride = Math.max(1, Math.ceil(xCount / maxLabels))
  for (let i = 0; i < xCount; i++) {
    if (i % stride !== 0 && i !== xCount - 1) continue
    const t = document.createElementNS(svgNS, 'text')
    t.setAttribute('x', xFor(i)); t.setAttribute('y', H - padB + 16)
    t.setAttribute('text-anchor', 'middle')
    t.setAttribute('class', 'growth-fusion-axis-tick')
    t.textContent = data.xAxis[i]
    svg.appendChild(t)
  }

  // series
  const palette = [
    'var(--dsh-viz-1, #7a5af8)',
    'var(--dsh-viz-2, #ffb347)',
    'var(--dsh-viz-3, #79d17b)',
    'var(--dsh-viz-4, #f96e6e)',
    'var(--dsh-viz-5, #71c9ce)',
    'var(--dsh-viz-6, #e0aaff)',
    'var(--dsh-viz-7, #c0c0c0)',
    'var(--dsh-viz-8, #ffd166)',
  ]
  data._colors = {}
  data.series.forEach((series, si) => {
    const color = palette[si % palette.length]
    data._colors[series.key] = color
    // Map series points (sparse — some buckets missing) to indices on xAxis
    const pointIdx = series.points.map(p => ({ x: data.xAxis.indexOf(p.x), v: state.metric === 'passRate' ? p.passRate : p.mean01 }))
      .filter(p => p.x >= 0 && p.v != null)
    if (pointIdx.length >= 2) {
      const poly = document.createElementNS(svgNS, 'polyline')
      poly.setAttribute('points', pointIdx.map(p => `${xFor(p.x)},${yFor(p.v)}`).join(' '))
      poly.setAttribute('fill', 'none')
      poly.setAttribute('stroke', color)
      poly.setAttribute('stroke-width', '2')
      poly.setAttribute('class', 'growth-fusion-line')
      svg.appendChild(poly)
    }
    for (const p of pointIdx) {
      const c = document.createElementNS(svgNS, 'circle')
      c.setAttribute('cx', xFor(p.x))
      c.setAttribute('cy', yFor(p.v))
      c.setAttribute('r', '3.5')
      c.setAttribute('fill', color)
      c.setAttribute('class', 'growth-fusion-dot')
      svg.appendChild(c)
    }
  })

  els.chart.appendChild(svg)
}

function renderLegend(data) {
  const wrap = el('div', 'growth-fusion-legend-wrap')
  for (const series of data.series) {
    const color = (data._colors || {})[series.key] || '#7a5af8'
    const item = el('div', 'growth-fusion-legend-item')
    const swatch = el('span', 'growth-fusion-legend-swatch')
    swatch.style.background = color
    item.appendChild(swatch)
    item.appendChild(el('span', 'growth-fusion-legend-label small', series.label))
    const nPoints = series.points.length
    item.appendChild(el('span', 'muted tiny', ` · ${nPoints} pt${nPoints === 1 ? '' : 's'}`))
    wrap.appendChild(item)
  }
  els.legend.appendChild(wrap)
}

const api = { mount, show, render, _state: state }
if (typeof window !== 'undefined') window.__dshGrowthV2 = api

})()
