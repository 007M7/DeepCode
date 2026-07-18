// Bench page renderer — DOM controller for the researcher experiment
// platform surface (#187, docs/design-refs/bench-design-pack-160.md).
//
// The pure data model lives in bench-model.js. This file owns the DOM:
// list rendering (L0), sub-tab filter, detail view (L1) with charts strip
// + grid/table for the three kinds, per-cell drill (L2 stub — click writes
// a lightweight trace shim into the pane), New-experiment kind picker,
// empty state, code_result.json export, and "re-score without re-run".
//
// Wire policy: today Bench is fixture-driven (mock-first). The pack §7
// tracks the seams G18 / G19 / G20 / G21 / G23 that will replace the
// loader once the daemon side lands. Every mock-flavoured chip in the UI
// says so explicitly ("local sequential run · G18/G19 pending upstream")
// per the honesty rule from the demo tier's mock-annotation contract.
//
// Charts are hand-rolled SVG so we don't pull a chart library into the
// dependency tree. Bars use CSS variables for accent/warn/success so the
// palette follows the light/dark theme without dedicated tokens.

'use strict'

;(function () {
  const M = (typeof require !== 'undefined')
    ? require('./bench-model.js')
    : window.__dshBenchModel
  const FIXTURE = (typeof require !== 'undefined')
    ? require('./bench-fixture.js')
    : window.__dshBenchFixture

  // ---- state --------------------------------------------------------------
  const state = M.createBenchState()
  let root = null      // <section data-pane="bench">
  let started = false
  let selectedCell = null  // { kind, ... } — for the drill panel

  // ---- boot ---------------------------------------------------------------
  function show() {
    if (!root) root = document.querySelector('[data-pane="bench"]')
    if (!root) return
    if (!started) {
      started = true
      // Load fixture on first show — empty state fallback happens
      // automatically if the fixture is missing.
      if (FIXTURE && Array.isArray(FIXTURE.experiments)) {
        M.loadExperiments(state, FIXTURE)
      }
    }
    render()
  }

  function render() {
    if (!root) return
    renderList()
    renderDetail()
  }

  // ---- L0 list rendering --------------------------------------------------
  function renderList() {
    const listEl = root.querySelector('[data-bench-list]')
    const countEl = root.querySelector('[data-bench-list-count]')
    if (!listEl) return
    const rows = M.projectL0Rows(state, { subTab: state.subTab })
    // Sub-tab chip active state.
    for (const chip of root.querySelectorAll('[data-bench-subtab]')) {
      const sel = chip.dataset.benchSubtab === state.subTab
      chip.classList.toggle('active', sel)
      chip.setAttribute('aria-selected', sel ? 'true' : 'false')
    }
    if (countEl) countEl.textContent = `${rows.length} ${rows.length === 1 ? 'experiment' : 'experiments'}`
    if (!rows.length) {
      listEl.innerHTML = ''
      const empty = renderEmpty()
      listEl.appendChild(empty)
      return
    }
    listEl.innerHTML = ''
    const tbl = document.createElement('div')
    tbl.className = 'bench-table'
    tbl.setAttribute('role', 'table')
    tbl.innerHTML = `
      <div class="bench-row bench-row-head" role="row">
        <span class="bench-col-kind"     role="columnheader">Kind</span>
        <span class="bench-col-name"     role="columnheader">Name</span>
        <span class="bench-col-status"   role="columnheader">Status</span>
        <span class="bench-col-progress" role="columnheader">Progress</span>
        <span class="bench-col-metric"   role="columnheader" title="Pass@k or ΔPass or σ(score)">Score</span>
        <span class="bench-col-metric"   role="columnheader" title="AveScore or ΔScore or median">Avg</span>
        <span class="bench-col-lat"      role="columnheader">P50 lat</span>
        <span class="bench-col-created"  role="columnheader">Created</span>
      </div>`
    for (const row of rows) tbl.appendChild(renderListRow(row))
    listEl.appendChild(tbl)
  }

  function renderListRow(row) {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'bench-row bench-row-data'
    el.setAttribute('role', 'row')
    el.dataset.benchExp = row.id
    if (state.selectedId === row.id) el.classList.add('selected')
    // Kind chip
    const kindLabel = row.kind === 'matrix' ? 'Matrix' : row.kind === 'ab' ? 'A/B' : 'Rep'
    // Status glyph
    const statusText = row.status === 'running' ? 'running' : row.status === 'queued' ? 'queued' : row.status === 'done' ? 'done' : row.status
    // Metric slots — vary by kind (pack §3 L0 columns)
    let scoreTxt = '—', avgTxt = '—'
    if (row.kind === 'matrix') {
      scoreTxt = fmtRatio(row.summary.passAtK, 2)
      if (row.summary.kUsed) scoreTxt = `Pass@${row.summary.kUsed} ${scoreTxt}`
      avgTxt = fmtRatio(row.summary.aveScore, 2)
    } else if (row.kind === 'ab') {
      scoreTxt = fmtDelta(row.summary.dPassRate, 2, 'ΔPass')
      avgTxt = fmtDelta(row.summary.dScore, 2, 'ΔScore')
    } else if (row.kind === 'rep') {
      scoreTxt = `σ ${fmtRatio(row.summary.sigma, 2)}`
      avgTxt = fmtRatio(row.summary.aveScore, 2)
    }
    const p50Ms = row.summary && Number.isFinite(row.summary.p50) ? row.summary.p50 : null
    const p50Txt = p50Ms == null ? '—' : `${(p50Ms / 1000).toFixed(1)}s`
    const p50Bucket = row.summary && row.summary.p50Bucket ? row.summary.p50Bucket : 'neutral'
    const created = row.createdAt ? relTime(row.createdAt) : '—'
    const progress = row.progress
      ? `${row.progress.done || 0}/${row.progress.total || 0}`
      : '—'
    el.innerHTML = `
      <span class="bench-col-kind" role="cell"><span class="bench-kind-chip bench-kind-${row.kind}">${kindLabel}</span></span>
      <span class="bench-col-name" role="cell">
        <span class="bench-row-name">${escapeHtml(row.name)}</span>
      </span>
      <span class="bench-col-status" role="cell">
        <span class="bench-status bench-status-${row.status}">${statusText}</span>
      </span>
      <span class="bench-col-progress" role="cell">${progress}</span>
      <span class="bench-col-metric" role="cell">${scoreTxt}</span>
      <span class="bench-col-metric" role="cell">${avgTxt}</span>
      <span class="bench-col-lat" role="cell"><span class="bench-lat bench-lat-${p50Bucket}">${p50Txt}</span></span>
      <span class="bench-col-created muted" role="cell">${created}</span>`
    el.addEventListener('click', () => {
      M.selectExperiment(state, row.id)
      selectedCell = null
      render()
      const detail = root.querySelector('[data-bench-detail]')
      if (detail && typeof detail.scrollIntoView === 'function') {
        detail.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    })
    return el
  }

  function renderEmpty() {
    const wrap = document.createElement('div')
    wrap.className = 'bench-empty'
    wrap.innerHTML = `
      <div class="bench-empty-title">No experiments in this view.</div>
      <div class="bench-empty-body muted">
        Bench runs one prompt-set against a grid of models, compares two plugin
        variants, or measures variance across N repetitions of the same input.
      </div>
      <div class="bench-empty-actions">
        <button class="ghost small" data-bench-action="new">New experiment</button>
        <button class="ghost small" data-bench-action="load-sample">Explore sample experiment</button>
      </div>`
    return wrap
  }

  // ---- L1 detail ----------------------------------------------------------
  function renderDetail() {
    const holder = root.querySelector('[data-bench-detail]')
    if (!holder) return
    if (!state.selectedId) {
      holder.innerHTML = `
        <div class="bench-detail-hint muted">
          Select an experiment above to see its charts, grid, and per-cell traces.
        </div>`
      return
    }
    const exp = M.getExperiment(state, state.selectedId)
    if (!exp) { holder.innerHTML = ''; return }
    const parts = []
    parts.push(renderDetailHeader(exp))
    parts.push(renderChartsStrip(exp))
    if (exp.kind === 'matrix') parts.push(renderMatrixGrid(exp))
    else if (exp.kind === 'ab') parts.push(renderABTable(exp))
    else if (exp.kind === 'rep') parts.push(renderRepetitionTable(exp))
    parts.push(renderConfigRecap(exp))
    if (selectedCell) parts.push(renderCellDrill(exp, selectedCell))
    holder.innerHTML = parts.join('\n')
    // Wire up post-render event handlers.
    for (const btn of holder.querySelectorAll('[data-bench-cell]')) {
      btn.addEventListener('click', () => {
        const kind = btn.dataset.benchCellKind
        if (kind === 'matrix') {
          const [pid, mid] = btn.dataset.benchCell.split('|')
          selectedCell = { kind: 'matrix-cell', promptId: pid, modelId: mid }
        } else if (kind === 'ab-row') {
          selectedCell = { kind: 'ab-row', promptId: btn.dataset.benchCell }
        } else if (kind === 'rep-run') {
          selectedCell = { kind: 'rep-run', idx: Number(btn.dataset.benchCell) }
        }
        render()
        const drill = root.querySelector('[data-bench-drill]')
        if (drill && typeof drill.scrollIntoView === 'function') {
          drill.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
      })
    }
    const exportBtn = holder.querySelector('[data-bench-export]')
    if (exportBtn) exportBtn.addEventListener('click', () => exportCodeResults(exp))
    const rescoreBtn = holder.querySelector('[data-bench-rescore]')
    if (rescoreBtn) rescoreBtn.addEventListener('click', () => showRescoreHint())
  }

  function renderDetailHeader(exp) {
    return `
      <header class="bench-detail-header">
        <div class="bench-detail-title">
          <span class="bench-kind-chip bench-kind-${exp.kind}">${exp.kind === 'matrix' ? 'Matrix' : exp.kind === 'ab' ? 'A/B' : 'Rep'}</span>
          <span class="bench-detail-name">${escapeHtml(exp.name)}</span>
        </div>
        <div class="bench-detail-actions">
          <button class="ghost small" data-bench-rescore title="Re-apply the rubric to stored trajectories — Bench's append-only advantage over one-shot for-loops.">Re-score without re-run</button>
          <button class="ghost small" data-bench-export title="Export per-cell code_result.json (DSBenchV2 shape) — bit-identical to DSBench so an experiment can graduate up.">Export code_result.json</button>
        </div>
      </header>
      <div class="bench-detail-sdk muted small">
        <span class="bench-sdk-legend" title="Bench is local-lite: sequential fixture-replay today. Server-side batching (bench/list-experiments = G19, bench/reevaluate = G18) is still pending upstream — see design-pack §7.">local sequential run · G18 / G19 pending upstream</span>
      </div>`
  }

  function renderChartsStrip(exp) {
    const charts = M.projectChartStrip(exp)
    if (!charts) return ''
    if (exp.kind === 'matrix') return renderMatrixCharts(charts)
    if (exp.kind === 'ab') return renderABCharts(charts)
    if (exp.kind === 'rep') return renderRepCharts(charts)
    return ''
  }

  function renderMatrixCharts(charts) {
    return `
      <section class="bench-charts">
        <div class="bench-chart">
          <div class="bench-chart-title">Feedback</div>
          ${barsGroup(charts.feedback.map(r => ({ label: r.label, primary: r.passRate, secondary: r.aveScore })), { primaryLabel: 'pass', secondaryLabel: 'score', max: 1 })}
        </div>
        <div class="bench-chart">
          <div class="bench-chart-title">Latency</div>
          ${barsGroup(charts.latency.map(r => ({ label: r.label, primary: r.p50, secondary: r.p99 })), { primaryLabel: 'P50', secondaryLabel: 'P99', fmt: fmtLatMs })}
        </div>
        <div class="bench-chart">
          <div class="bench-chart-title">Tokens</div>
          ${barsGroup(charts.tokens.map(r => ({ label: r.label, primary: r.tokIn, secondary: r.tokOut })), { primaryLabel: 'in', secondaryLabel: 'out', fmt: fmtIntShort })}
        </div>
      </section>`
  }

  function renderABCharts(charts) {
    return `
      <section class="bench-charts">
        <div class="bench-chart">
          <div class="bench-chart-title">Feedback (A vs B)</div>
          ${barsGroup(charts.feedback.map(r => ({ label: r.label, primary: r.passRate, secondary: r.aveScore })), { primaryLabel: 'pass', secondaryLabel: 'score', max: 1 })}
        </div>
        <div class="bench-chart">
          <div class="bench-chart-title">Latency (A vs B)</div>
          ${barsGroup(charts.latency.map(r => ({ label: r.label, primary: r.p50, secondary: r.p99 })), { primaryLabel: 'P50', secondaryLabel: 'P99', fmt: fmtLatMs })}
        </div>
        <div class="bench-chart">
          <div class="bench-chart-title">Tokens (A vs B)</div>
          ${barsGroup(charts.tokens.map(r => ({ label: r.label, primary: r.tokIn, secondary: r.tokOut })), { primaryLabel: 'in', secondaryLabel: 'out', fmt: fmtIntShort })}
        </div>
      </section>`
  }

  function renderRepCharts(charts) {
    return `
      <section class="bench-charts">
        <div class="bench-chart">
          <div class="bench-chart-title">Score histogram</div>
          ${histogramSvg(charts.histogram)}
        </div>
        <div class="bench-chart">
          <div class="bench-chart-title">Latency box-plot</div>
          ${boxplotSvg(charts.boxplot)}
        </div>
        <div class="bench-chart">
          <div class="bench-chart-title">Resolved / unresolved</div>
          ${stackedSvg(charts.resolvedStack)}
        </div>
      </section>`
  }

  // Two-series grouped bars. `rows` is `[{ label, primary, secondary }, …]`.
  function barsGroup(rows, opts) {
    if (!rows.length) return '<div class="bench-chart-empty muted small">no data</div>'
    const values = rows.flatMap(r => [Number(r.primary) || 0, Number(r.secondary) || 0])
    const max = (opts && opts.max) || Math.max(1e-6, ...values)
    const fmt = (opts && opts.fmt) || fmtRatio2
    const primaryLabel = opts && opts.primaryLabel || 'p'
    const secondaryLabel = opts && opts.secondaryLabel || 's'
    // Use explicit pixel heights (60px lane) so the flex-height chain doesn't
    // collapse the bars. Percent-of-parent worked in isolation but the pair's
    // parent is a column flex that only takes content height when
    // align-items != stretch.
    const H = 60
    const bars = rows.map(r => {
      const p = Math.max(0, Number(r.primary) || 0) / max
      const s = Math.max(0, Number(r.secondary) || 0) / max
      const pPx = Math.max(2, Math.round(p * H))
      const sPx = Math.max(2, Math.round(s * H))
      return `
        <div class="bench-bar-group" role="group" aria-label="${escapeAttr(r.label)}">
          <div class="bench-bar-pair" style="height:${H}px">
            <div class="bench-bar bench-bar-primary"   style="height:${pPx}px" title="${primaryLabel}: ${fmt(r.primary)}"></div>
            <div class="bench-bar bench-bar-secondary" style="height:${sPx}px" title="${secondaryLabel}: ${fmt(r.secondary)}"></div>
          </div>
          <div class="bench-bar-label">${escapeHtml(r.label)}</div>
        </div>`
    }).join('')
    return `
      <div class="bench-bars-wrap">
        <div class="bench-bars">${bars}</div>
        <div class="bench-bars-legend muted small">
          <span class="bench-legend-swatch bench-legend-primary"></span>${primaryLabel}
          <span class="bench-legend-swatch bench-legend-secondary"></span>${secondaryLabel}
        </div>
      </div>`
  }

  function histogramSvg(bins) {
    if (!bins || !bins.length) return '<div class="bench-chart-empty muted small">no data</div>'
    const max = Math.max(1, ...bins.map(b => b.count))
    const W = 160, H = 60, padL = 4, padR = 4, padT = 4, padB = 12
    const bw = (W - padL - padR) / bins.length
    const parts = bins.map((b, i) => {
      const h = ((b.count / max) * (H - padT - padB))
      const x = padL + i * bw
      const y = H - padB - h
      return `<rect x="${x + 1}" y="${y}" width="${bw - 2}" height="${h}" class="bench-hist-bar" />`
    }).join('')
    return `
      <svg class="bench-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="score histogram">
        <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" class="bench-svg-axis"/>
        ${parts}
        <text x="${padL}" y="${H - 1}" class="bench-svg-tick">0</text>
        <text x="${W - padR}" y="${H - 1}" class="bench-svg-tick" text-anchor="end">1</text>
      </svg>`
  }

  function boxplotSvg(bp) {
    if (!bp) return '<div class="bench-chart-empty muted small">no data</div>'
    const W = 160, H = 60, padL = 8, padR = 8
    const min = bp.min, max = bp.max
    const span = Math.max(1, max - min)
    const sc = (v) => padL + ((v - min) / span) * (W - padL - padR)
    const midY = H / 2
    return `
      <svg class="bench-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="latency box-plot">
        <line x1="${sc(bp.min)}" y1="${midY}" x2="${sc(bp.max)}" y2="${midY}" class="bench-svg-axis"/>
        <line x1="${sc(bp.min)}" y1="${midY - 6}" x2="${sc(bp.min)}" y2="${midY + 6}" class="bench-svg-axis"/>
        <line x1="${sc(bp.max)}" y1="${midY - 6}" x2="${sc(bp.max)}" y2="${midY + 6}" class="bench-svg-axis"/>
        <rect x="${sc(bp.q1)}" y="${midY - 10}" width="${Math.max(1, sc(bp.q3) - sc(bp.q1))}" height="20" class="bench-box-box"/>
        <line x1="${sc(bp.median)}" y1="${midY - 12}" x2="${sc(bp.median)}" y2="${midY + 12}" class="bench-box-median"/>
        <text x="${padL}" y="${H - 2}" class="bench-svg-tick">${fmtLatMs(bp.min)}</text>
        <text x="${W - padR}" y="${H - 2}" class="bench-svg-tick" text-anchor="end">${fmtLatMs(bp.max)}</text>
      </svg>`
  }

  function stackedSvg(stack) {
    if (!stack) return '<div class="bench-chart-empty muted small">no data</div>'
    const total = Math.max(1, stack.resolved + stack.unresolved)
    const W = 160, H = 60, padL = 8, padR = 8
    const width = W - padL - padR
    const resW = (stack.resolved / total) * width
    return `
      <svg class="bench-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="resolved stack">
        <rect x="${padL}" y="${H / 2 - 10}" width="${resW}" height="20" class="bench-stack-resolved"/>
        <rect x="${padL + resW}" y="${H / 2 - 10}" width="${width - resW}" height="20" class="bench-stack-unresolved"/>
        <text x="${padL}" y="${H - 4}" class="bench-svg-tick">✓ ${stack.resolved}</text>
        <text x="${W - padR}" y="${H - 4}" class="bench-svg-tick" text-anchor="end">✗ ${stack.unresolved}</text>
      </svg>`
  }

  // ---- Kind A: matrix grid ------------------------------------------------
  function renderMatrixGrid(exp) {
    const grid = M.projectMatrixGrid(exp)
    if (!grid.prompts.length) {
      return `<section class="bench-grid-wrap"><div class="bench-chart-empty muted small">Grid loads once the first prompt returns.</div></section>`
    }
    const cols = grid.models.length
    const head = grid.models.map(m => `<div class="bench-grid-h" role="columnheader">${escapeHtml(m.label || m.id)}</div>`).join('')
    const bodyRows = grid.rows.map(row => {
      const cells = row.cells.map((c, i) => renderMatrixCell(c, grid.models[i])).join('')
      return `
        <div class="bench-grid-row" role="row">
          <div class="bench-grid-h bench-grid-h-row" role="rowheader">${escapeHtml(row.prompt.label || row.prompt.id)}</div>
          ${cells}
        </div>`
    }).join('')
    const totalCells = grid.totals.map(t => `
      <div class="bench-grid-total" role="cell">
        <div class="bench-total-line"><span class="muted small">Pass@${t.kUsed}</span> ${fmtRatio(t.passAtK, 2)}</div>
        <div class="bench-total-line"><span class="muted small">Avg</span> ${fmtRatio(t.aveScore, 2)}</div>
        <div class="bench-total-line"><span class="muted small">Cost</span> ${fmtCost(t.totalCost)}</div>
        <div class="bench-total-line"><span class="muted small">P50</span> ${fmtLatMs(t.p50)}</div>
      </div>`).join('')
    return `
      <section class="bench-grid-wrap">
        <div class="bench-grid" style="grid-template-columns: minmax(140px, 1fr) repeat(${cols}, minmax(120px, 1fr))" role="grid" aria-label="matrix grid">
          <div class="bench-grid-h bench-grid-corner" role="columnheader"></div>
          ${head}
          ${bodyRows}
          <div class="bench-grid-h bench-grid-h-row bench-grid-total-lead" role="rowheader">Totals</div>
          ${totalCells}
        </div>
      </section>`
  }

  function renderMatrixCell(c, model) {
    if (!c) {
      return `<div class="bench-grid-cell bench-cell-empty" role="cell">—</div>`
    }
    if (c.status === 'queued') {
      return `<div class="bench-grid-cell bench-cell-queued" role="cell">queued</div>`
    }
    if (c.status === 'running') {
      return `<div class="bench-grid-cell bench-cell-running" role="cell">running… ${c.resolvedCount}/${c.N}</div>`
    }
    const glyph = c.resolvedCount > 0 ? '✓' : '✗'
    const scoreTxt = c.resolvedCount > 0 ? fmtRatio(c.score, 2) : '—'
    const tint = c.tintBucket || 'neutral'
    return `
      <button type="button" role="cell" class="bench-grid-cell bench-cell-ok bench-cell-tint-${tint}"
              data-bench-cell="${escapeAttr(c.promptId + '|' + c.modelId)}"
              data-bench-cell-kind="matrix"
              title="Click to drill into the trace">
        <span class="bench-cell-nn">${c.resolvedCount}/${c.N}</span>
        <span class="bench-cell-glyph">${glyph}</span>
        <span class="bench-cell-score">${scoreTxt}</span>
      </button>`
  }

  // ---- Kind B: A/B table --------------------------------------------------
  function renderABTable(exp) {
    const rows = M.projectABTable(exp)
    if (!rows.length) return '<div class="bench-chart-empty muted small">no A/B rows loaded</div>'
    const varA = exp.ab.variantA.label || 'A'
    const varB = exp.ab.variantB.label || 'B'
    const rowHtml = rows.map(r => {
      const dirGlyph = r.direction === 'up' ? '↑' : r.direction === 'down' ? '↓' : '·'
      const dirCls = `bench-ab-delta-${r.direction}`
      return `
        <button type="button" class="bench-ab-row" role="row"
                data-bench-cell="${escapeAttr(r.promptId)}"
                data-bench-cell-kind="ab-row">
          <span class="bench-ab-prompt" role="cell">${escapeHtml(r.promptId)}</span>
          <span class="bench-ab-cell" role="cell">${r.aResolved ? '✓' : '✗'}</span>
          <span class="bench-ab-cell" role="cell">${fmtRatio(r.aScore, 2)}</span>
          <span class="bench-ab-cell" role="cell">${r.bResolved ? '✓' : '✗'}</span>
          <span class="bench-ab-cell" role="cell">${fmtRatio(r.bScore, 2)}</span>
          <span class="bench-ab-cell ${dirCls}" role="cell">${dirGlyph} ${(r.delta >= 0 ? '+' : '') + r.delta.toFixed(2)}</span>
        </button>`
    }).join('')
    return `
      <section class="bench-ab">
        <div class="bench-ab-head" role="row">
          <span class="bench-ab-prompt" role="columnheader">prompt</span>
          <span class="bench-ab-cell" role="columnheader">${escapeHtml(varA)} resolved</span>
          <span class="bench-ab-cell" role="columnheader">${escapeHtml(varA)} score</span>
          <span class="bench-ab-cell" role="columnheader">${escapeHtml(varB)} resolved</span>
          <span class="bench-ab-cell" role="columnheader">${escapeHtml(varB)} score</span>
          <span class="bench-ab-cell" role="columnheader">Δ</span>
        </div>
        <div class="bench-ab-body" role="rowgroup">${rowHtml}</div>
        <div class="bench-ab-foot muted small">Click any row to open both traces side-by-side.</div>
      </section>`
  }

  // ---- Kind C: repetition Average|1..N table -----------------------------
  function renderRepetitionTable(exp) {
    const t = M.projectRepetitionTable(exp)
    if (!t.N) return '<div class="bench-chart-empty muted small">no repetitions loaded</div>'
    const cols = t.headers.length
    const head = `
      <div class="bench-rep-row bench-rep-head" role="row">
        <span class="bench-rep-dim" role="columnheader">Dimension</span>
        <span class="bench-rep-avg" role="columnheader">Average</span>
        ${t.headers.map(h => `<span class="bench-rep-col" role="columnheader">${escapeHtml(h)}</span>`).join('')}
      </div>`
    const rowsHtml = t.dims.map(d => {
      const cells = d.cells.map(c => {
        const passCls = c.pass ? 'bench-rep-cell-pass' : c.fail ? 'bench-rep-cell-fail' : ''
        return `<span class="bench-rep-col ${passCls}" role="cell">${escapeHtml(c.text)}</span>`
      }).join('')
      return `
        <div class="bench-rep-row" role="row">
          <span class="bench-rep-dim" role="rowheader">${escapeHtml(d.label)}</span>
          <span class="bench-rep-avg" role="cell">${escapeHtml(d.average)}</span>
          ${cells}
        </div>`
    }).join('')
    const list = t.list.map(r => `
      <button type="button" class="bench-rep-list-row"
              data-bench-cell="${r.idx}"
              data-bench-cell-kind="rep-run">
        <span class="bench-rep-list-idx">#${r.idx}</span>
        <span class="bench-rep-list-glyph">${r.resolved ? '✓' : '✗'}</span>
        <span class="bench-rep-list-score">${fmtRatio(r.score, 2)}</span>
        <span class="bench-rep-list-lat muted small">${fmtLatMs(r.latencyMs)}</span>
        <span class="bench-rep-list-open muted small">open trace ›</span>
      </button>`).join('')
    return `
      <section class="bench-rep">
        <div class="bench-rep-table" style="grid-template-columns: minmax(140px, 1.6fr) minmax(80px, 1fr) repeat(${cols}, minmax(60px, 1fr))" role="grid">
          ${head}
          ${rowsHtml}
        </div>
        <div class="bench-rep-list" role="list">${list}</div>
      </section>`
  }

  // ---- config recap + cell drill -----------------------------------------
  function renderConfigRecap(exp) {
    const c = exp.config || {}
    const parts = []
    if (c.profile) parts.push(`<span><span class="muted">profile</span> ${escapeHtml(c.profile)}</span>`)
    if (c.rubric && c.rubric.id) parts.push(`<span><span class="muted">rubric</span> ${escapeHtml(c.rubric.id)}</span>`)
    if (exp.promptSet && exp.promptSet.id) parts.push(`<span><span class="muted">prompt-set</span> ${escapeHtml(exp.promptSet.id)} ${escapeHtml(exp.promptSet.version || '')}</span>`)
    if (exp.N) parts.push(`<span><span class="muted">N</span> ${exp.N}</span>`)
    if (c.temperature != null) parts.push(`<span><span class="muted">temp</span> ${c.temperature}</span>`)
    if (c.plugin && c.plugin.id) parts.push(`<span><span class="muted">plugin</span> ${escapeHtml(c.plugin.id)} (vary ${escapeHtml(c.plugin.vary || '?')})</span>`)
    return `
      <details class="bench-config-recap">
        <summary class="muted small">Configuration recap</summary>
        <div class="bench-config-body">${parts.join('  ·  ')}</div>
      </details>`
  }

  function renderCellDrill(exp, cell) {
    if (!cell) return ''
    let title = '', body = '', codeResult = null, sessionId = null
    if (cell.kind === 'matrix-cell' && exp.matrix) {
      const key = `${cell.promptId}|${cell.modelId}`
      const c = exp.matrix.cells[key]
      if (!c) return ''
      title = `${cell.promptId} × ${cell.modelId}`
      const runs = c.runs.map((r, i) => renderRunLine(r, i + 1)).join('')
      body = `<div class="bench-drill-runs">${runs}</div>`
      const rep = c.resolvedCount > 0 ? c.runs.find(r => r.resolved) : c.runs[0]
      codeResult = rep ? M.makeCodeResult(rep) : null
      sessionId = rep ? rep.sessionId : null
    } else if (cell.kind === 'ab-row' && exp.ab) {
      const row = exp.ab.rows.find(r => r.promptId === cell.promptId)
      if (!row) return ''
      title = `A/B · ${cell.promptId}`
      body = `
        <div class="bench-drill-ab">
          <div class="bench-drill-ab-col">
            <div class="bench-drill-ab-h">${escapeHtml(exp.ab.variantA.label || 'A')}</div>
            ${renderRunLine(row.a, 'A')}
          </div>
          <div class="bench-drill-ab-col">
            <div class="bench-drill-ab-h">${escapeHtml(exp.ab.variantB.label || 'B')}</div>
            ${renderRunLine(row.b, 'B')}
          </div>
        </div>`
      codeResult = M.makeCodeResult(row.a)
    } else if (cell.kind === 'rep-run' && exp.rep) {
      const r = exp.rep.repetitions.find(rep => rep.idx === cell.idx)
      if (!r) return ''
      title = `Repetition #${cell.idx} of ${exp.rep.repetitions.length}`
      body = renderRunLine(r, cell.idx)
      codeResult = M.makeCodeResult(r)
      sessionId = r.sessionId
    }
    const crJson = codeResult ? JSON.stringify(codeResult, null, 2) : ''
    return `
      <section class="bench-drill" data-bench-drill>
        <div class="bench-drill-head">
          <div class="bench-drill-title">Trace · ${escapeHtml(title)}</div>
          <div class="bench-drill-actions muted small">
            ${sessionId ? `<span class="muted">session</span> <code>${escapeHtml(sessionId)}</code>` : ''}
            <span class="muted small">— trace panel opens in Chat when wire (G6 bench/replay) lands</span>
          </div>
        </div>
        <div class="bench-drill-body">
          ${body}
          ${crJson ? `
            <details class="bench-drill-code-result">
              <summary class="muted small">code_result.json</summary>
              <pre class="bench-code">${escapeHtml(crJson)}</pre>
            </details>` : ''}
        </div>
      </section>`
  }

  function renderRunLine(r, tag) {
    if (!r) return ''
    const status = r.resolved ? 'ok' : 'fail'
    return `
      <div class="bench-run-line bench-run-${status}">
        <span class="bench-run-tag">#${escapeHtml(String(tag))}</span>
        <span class="bench-run-glyph">${r.resolved ? '✓' : '✗'}</span>
        <span class="bench-run-score">${fmtRatio(r.score, 2)}</span>
        <span class="bench-run-lat muted small">${fmtLatMs(r.latencyMs)}</span>
        ${r.tokens ? `<span class="bench-run-tok muted small">${r.tokens.in || 0} in / ${r.tokens.out || 0} out</span>` : ''}
        ${Number.isFinite(r.cost) ? `<span class="bench-run-cost muted small">${fmtCost(r.cost)}</span>` : ''}
        ${r.reason ? `<span class="bench-run-reason muted small">${escapeHtml(r.reason)}</span>` : ''}
      </div>`
  }

  // ---- new-experiment kind picker + toolbar actions ----------------------
  function openKindPicker() {
    const modal = document.createElement('div')
    modal.className = 'bench-modal-scrim'
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    modal.innerHTML = `
      <div class="bench-modal">
        <header class="bench-modal-head">
          <div class="bench-modal-title">New experiment</div>
          <button class="ghost small" data-bench-close type="button">Close</button>
        </header>
        <div class="bench-kind-cards">
          <button type="button" class="bench-kind-card" data-bench-kind="matrix">
            <div class="bench-kind-card-title">Matrix</div>
            <div class="bench-kind-card-sub muted small">M × P × N grid, pass@k</div>
            <div class="bench-kind-card-body muted small">Run one prompt-set against a grid of models × N rollouts each; score with a rubric.</div>
          </button>
          <button type="button" class="bench-kind-card" data-bench-kind="ab">
            <div class="bench-kind-card-title">Plugin A/B</div>
            <div class="bench-kind-card-sub muted small">same P, N; plugin on/off</div>
            <div class="bench-kind-card-body muted small">Hold prompt-set + model + N constant; vary one plugin's mount state or version.</div>
          </button>
          <button type="button" class="bench-kind-card" data-bench-kind="rep">
            <div class="bench-kind-card-title">Repetition</div>
            <div class="bench-kind-card-sub muted small">same input, variance N</div>
            <div class="bench-kind-card-body muted small">One input × N rollouts under identical config; measure output variance and rubric-score dispersion.</div>
          </button>
        </div>
        <footer class="bench-modal-foot muted small">
          Configure step is stubbed for the demo — no daemon batch yet. The pack §7 tracks G20 / G21 for upstream.
        </footer>
      </div>`
    document.body.appendChild(modal)
    const close = () => modal.remove()
    modal.querySelector('[data-bench-close]').addEventListener('click', close)
    modal.addEventListener('click', (e) => { if (e.target === modal) close() })
    for (const btn of modal.querySelectorAll('[data-bench-kind]')) {
      btn.addEventListener('click', () => {
        const k = btn.dataset.benchKind
        close()
        // Pre-select an existing experiment of the picked kind if any, so the
        // user sees the shape immediately.
        const existing = M.projectL0Rows(state, { subTab: k }).map(r => r.id)
        if (existing.length) {
          M.setSubTab(state, k)
          M.selectExperiment(state, existing[0])
        } else {
          M.setSubTab(state, k)
        }
        render()
      })
    }
  }

  function exportCodeResults(exp) {
    const payload = collectCodeResults(exp)
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${exp.id}.code_result.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  function collectCodeResults(exp) {
    const out = { experimentId: exp.id, name: exp.name, kind: exp.kind, results: [] }
    if (exp.kind === 'matrix' && exp.matrix) {
      for (const key of Object.keys(exp.matrix.cells)) {
        const c = exp.matrix.cells[key]
        for (const r of c.runs) {
          out.results.push({
            promptId: c.promptId,
            modelId: c.modelId,
            runIdx: r.runIdx,
            codeResult: M.makeCodeResult(r),
          })
        }
      }
    } else if (exp.kind === 'ab' && exp.ab) {
      for (const row of exp.ab.rows) {
        out.results.push({ promptId: row.promptId, variant: 'a', codeResult: M.makeCodeResult(row.a) })
        out.results.push({ promptId: row.promptId, variant: 'b', codeResult: M.makeCodeResult(row.b) })
      }
    } else if (exp.kind === 'rep' && exp.rep) {
      for (const r of exp.rep.repetitions) {
        out.results.push({ idx: r.idx, codeResult: M.makeCodeResult(r) })
      }
    }
    return out
  }

  function showRescoreHint() {
    const holder = root.querySelector('[data-bench-detail]')
    if (!holder) return
    const banner = document.createElement('div')
    banner.className = 'bench-inline-banner'
    banner.textContent = 'Re-score without re-run: the demo tier applies the rubric to cached trajectories locally and produces a new experiment id whose runs point at the parent (parentExperimentId). The wire-level `bench/reevaluate` (G18) is pending upstream — this is one of two Bench differentiators over a for-loop.'
    holder.insertBefore(banner, holder.firstChild)
    setTimeout(() => banner.remove(), 6000)
  }

  // ---- toolbar wiring -----------------------------------------------------
  function wireToolbar() {
    if (!root) return
    for (const chip of root.querySelectorAll('[data-bench-subtab]')) {
      chip.addEventListener('click', () => {
        M.setSubTab(state, chip.dataset.benchSubtab)
        selectedCell = null
        render()
      })
    }
    const newBtn = root.querySelector('[data-bench-new]')
    if (newBtn) newBtn.addEventListener('click', () => openKindPicker())
    const exploreBtn = root.querySelector('[data-bench-explore]')
    if (exploreBtn) exploreBtn.addEventListener('click', () => {
      if (!state.experiments.size && FIXTURE) M.loadExperiments(state, FIXTURE)
      const first = state.order[0]
      if (first) M.selectExperiment(state, first)
      render()
    })
    // Delegated handler for the empty-state buttons.
    root.addEventListener('click', (e) => {
      const btn = e.target.closest && e.target.closest('[data-bench-action]')
      if (!btn) return
      if (btn.dataset.benchAction === 'new') openKindPicker()
      if (btn.dataset.benchAction === 'load-sample') {
        if (!state.experiments.size && FIXTURE) M.loadExperiments(state, FIXTURE)
        M.setSubTab(state, 'all')
        M.selectExperiment(state, state.order[0])
        render()
      }
    })
  }

  // ---- formatting helpers ------------------------------------------------
  function fmtRatio(v, n) { return Number.isFinite(v) ? Number(v).toFixed(n || 2) : '—' }
  function fmtRatio2(v) { return fmtRatio(v, 2) }
  function fmtDelta(v, n, prefix) {
    if (!Number.isFinite(v)) return '—'
    const abs = Math.abs(v).toFixed(n || 2)
    const sign = v > 0 ? '+' : v < 0 ? '-' : '±'
    return `${prefix ? prefix + ' ' : ''}${sign}${abs}`
  }
  function fmtLatMs(v) {
    if (!Number.isFinite(v)) return '—'
    if (v < 1000) return `${Math.round(v)}ms`
    return `${(v / 1000).toFixed(1)}s`
  }
  function fmtIntShort(v) {
    if (!Number.isFinite(v)) return '—'
    if (v < 1000) return String(Math.round(v))
    if (v < 10000) return `${(v / 1000).toFixed(1)}k`
    return `${Math.round(v / 1000)}k`
  }
  function fmtCost(v) {
    if (!Number.isFinite(v)) return '—'
    if (v === 0) return '$0.00'
    if (v < 0.01) return `$${v.toFixed(4)}`
    return `$${v.toFixed(2)}`
  }
  function relTime(ms) {
    if (!ms) return '—'
    const dt = Date.now() - ms
    if (dt < 60 * 1000) return 'just now'
    if (dt < 60 * 60 * 1000) return `${Math.round(dt / 60000)}m ago`
    if (dt < 24 * 60 * 60 * 1000) return `${Math.round(dt / 3600000)}h ago`
    if (dt < 30 * 24 * 60 * 60 * 1000) return `${Math.round(dt / 86400000)}d ago`
    return new Date(ms).toISOString().slice(0, 10)
  }
  // Bench-page previously had an escapeHtml that missed the ' character
  // AND aliased escapeAttr to it — so any single-quote in a fixture label
  // used inside a single-quoted attribute context (rows use single-quoted
  // attrs at bench-page.js:313/435/455) was echoed literally. Fixture
  // labels are trusted today, but the shared helper below covers all five
  // OWASP characters, closing the gap in place. See html-escape.js.
  const __esc = (window.__dshHtmlEscape || {})
  const escapeHtml = __esc.escapeHtml
    || ((s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])))
  const escapeAttr = __esc.escapeAttr || escapeHtml

  // ---- public surface ----------------------------------------------------
  const api = {
    show,
    render,
    // Test hook: expose the model + state for driving unit tests through the
    // rendered DOM if we ever want to. Today the pure model has its own
    // suite; leave this hook for the CDP demo-shots step.
    __state: state,
    __openKindPicker: openKindPicker,
  }
  if (typeof window !== 'undefined') {
    window.__dshBench = api
    // Wire the toolbar once the DOM is ready.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        root = document.querySelector('[data-pane="bench"]')
        wireToolbar()
      })
    } else {
      root = document.querySelector('[data-pane="bench"]')
      wireToolbar()
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})()
