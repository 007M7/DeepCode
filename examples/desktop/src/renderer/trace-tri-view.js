// trace-tri-view.js — Task #203 view-toggle container.
//
// Wraps a trace card (Tree, already rendered by renderer.js), a Timeline
// (trace-timeline.js), and a Graph (trace-graph.js) behind view-mode chips
// [Tree | Timeline | Graph], modelled on the LangSmith waterfall-toggle
// pattern (§2, §4 of langsmith-tracing-study.md).
//
// Two mount sites:
//   1) Turn footer — wrapping a single step record inside the existing
//      <details.turn-trace-drawer>. See renderer.js finishTurnContainer.
//   2) Session scope — a "Full trace" button opens a full-session drawer
//      that aggregates every step in the current session. Same tri-view,
//      wider fixture.
//
// The container is DOM/state-only; the pure layout modules stay drivable
// from tests without a document.

'use strict'

;(function () {
  const VIEWS = ['tree', 'timeline', 'graph']

  function buildTriView(doc, spec) {
    // spec:
    //   { treeEl: HTMLElement,           // pre-rendered trace card / tree
    //     records: object|Array<object>, // step-record(s) driving Timeline/Graph
    //     onSeqClick?: (seq, meta) => void,
    //     nowMs?: number,                // live cursor for Timeline
    //     defaultView?: 'tree'|'timeline'|'graph',
    //     scope?: 'turn'|'session',      // affects labels only
    //     sessionId?: string,            // #205: scopes Feedback annotation lookup
    //   }
    const wrap = doc.createElement('div')
    wrap.className = 'trace-tri-view'
    wrap.dataset.scope = spec.scope || 'turn'

    const chips = doc.createElement('div')
    chips.className = 'trace-tri-chips'
    chips.setAttribute('role', 'tablist')

    // the tri-view now hosts a right-side detail pane. The
    // panels + detail slot sit side by side; the detail slot stays with
    // the same node selection across view switches (LangSmith parity).
    const stage = doc.createElement('div')
    stage.className = 'trace-tri-stage'
    const panels = doc.createElement('div')
    panels.className = 'trace-tri-panels'
    const detailSlot = doc.createElement('div')
    detailSlot.className = 'trace-tri-detail'
    detailSlot.hidden = true
    stage.appendChild(panels)
    stage.appendChild(detailSlot)

    const btns = {}
    const panelEls = {}
    for (const view of VIEWS) {
      const btn = doc.createElement('button')
      btn.type = 'button'
      btn.className = `trace-tri-chip chip-${view}`
      btn.setAttribute('role', 'tab')
      btn.dataset.view = view
      btn.textContent = view === 'tree' ? 'Tree' : (view === 'timeline' ? 'Timeline' : 'Graph')
      btn.addEventListener('click', function () { setView(view) })
      chips.appendChild(btn)
      btns[view] = btn

      const panel = doc.createElement('div')
      panel.className = `trace-tri-panel panel-${view}`
      panel.setAttribute('role', 'tabpanel')
      panel.dataset.view = view
      panel.hidden = true
      panels.appendChild(panel)
      panelEls[view] = panel
    }

    // Export button — download the current view as SVG (Timeline / Graph
    // only). Researchers asked for vector exports so they can drop trace
    // shots into papers without a screenshot artifact.
    const exportBtn = doc.createElement('button')
    exportBtn.type = 'button'
    exportBtn.className = 'trace-tri-export ghost small'
    exportBtn.textContent = 'Export SVG'
    exportBtn.title = 'Download the current view as an SVG file'
    exportBtn.addEventListener('click', function () { exportCurrent() })
    chips.appendChild(exportBtn)

    // tree-side toolbar sits
    // above the pre-rendered tree card. Filter is a plain text-input that
    // hides trace-event-rows whose type doesn't include the query;
    // Waterfall toggle flips a class on the tree card so span bars vanish
    // when the researcher wants pure structure; Expand-all / Collapse-all
    // walk every `<details>` inside the tree once.  Settings is a UX seam
    // (opens the researcher-facing settings panel via window.__dshOpenTraceSettings
    // if present; falls back to a no-op tooltip when not wired yet).
    const treeToolbar = buildTreeToolbar(doc, spec)
    panelEls.tree.appendChild(treeToolbar.el)
    if (spec.treeEl) {
      panelEls.tree.appendChild(spec.treeEl)
      treeToolbar.attach(spec.treeEl)
    } else {
      const stub = doc.createElement('div')
      stub.className = 'trace-tri-stub'
      stub.textContent = 'Tree view is per-turn. Open a turn footer drawer to see it.'
      panelEls.tree.appendChild(stub)
    }

    // Timeline + Graph — lazy: only build when first shown, so an untoggled
    // drawer doesn't pay for the SVG walk.
    let builtTimeline = false
    let builtGraph = false
    // click on a Timeline bar / Graph node opens the detail
    // pane populated by the node's step-record. This wraps the caller's
    // seq-click so deep-linking to the conversation stream still fires.
    function handleNodeClick(seq, meta) {
      if (typeof spec.onSeqClick === 'function') {
        try { spec.onSeqClick(seq, meta) } catch (_) { /* deep-link is optional */ }
      }
      openDetailForSeq(seq, meta)
    }
    function ensureTimeline() {
      if (builtTimeline) return
      builtTimeline = true
      const T = (typeof window !== 'undefined' && window.__dshTraceTimeline) || null
      if (!T) { panelEls.timeline.textContent = 'trace-timeline.js not loaded'; return }
      const el = T.renderTimeline(doc, spec.records || [], {
        onSeqClick: handleNodeClick,
        nowMs: typeof spec.nowMs === 'number' ? spec.nowMs : undefined,
        width: spec.scope === 'session' ? 860 : 720,
      })
      panelEls.timeline.appendChild(el)
    }
    function ensureGraph() {
      if (builtGraph) return
      builtGraph = true
      const G = (typeof window !== 'undefined' && window.__dshTraceGraph) || null
      if (!G) { panelEls.graph.textContent = 'trace-graph.js not loaded'; return }
      const el = G.renderGraph(doc, spec.records || [], { onSeqClick: handleNodeClick })
      panelEls.graph.appendChild(el)
    }

    // build/populate the right-side detail pane from a step
    // record matching this seq. Prefers exact seq matches (rec.startSeq)
    // but falls back to the record whose seq range contains the click.
    function openDetailForSeq(seq, meta) {
      const D = (typeof window !== 'undefined' && window.__dshTraceDetailPane) || null
      if (!D || typeof D.buildDetailPane !== 'function') return
      const records = Array.isArray(spec.records) ? spec.records
        : (spec.records ? [spec.records] : [])
      const rec = pickRecordForSeq(records, seq) || (records.length ? records[0] : null)
      if (!rec) return
      // Drift-review 2026-07-17: detach any stale annotation listener the
      // previous detail pane attached to `document` before we throw its DOM
      // away, otherwise reopening the detail pane over a long session grows
      // the `dsh:annotation-updated` listener set without bound.
      detachDetailListener(detailSlot)
      while (detailSlot.firstChild) detailSlot.removeChild(detailSlot.firstChild)
      const closeBtn = doc.createElement('button')
      closeBtn.type = 'button'
      closeBtn.className = 'ghost small trace-tri-detail-close'
      closeBtn.textContent = 'Close'
      closeBtn.title = 'Close detail pane'
      closeBtn.addEventListener('click', function () { closeDetail() })
      detailSlot.appendChild(closeBtn)
      const pane = D.buildDetailPane(doc, {
        record: rec,
        sessionId: spec.sessionId || null,
        // Field §3 P0 #5 (2026-07-17): thread the SessionHeader through so
        // the Attributes Runtime group can surface cwd. Callers set
        // `spec.sessionHeader` (renderer.js openTraceDetail) from
        // state.sessions.get(sid).header; missing header falls to '—' in
        // the Attributes row.
        sessionHeader: spec.sessionHeader || null,
        title: titleForRec(rec, meta),
        subtitle: subtitleForRec(rec),
        defaultTab: 'output',
      })
      if (pane) detailSlot.appendChild(pane)
      detailSlot.hidden = false
      wrap.classList.add('has-detail')
    }
    function closeDetail() {
      // Same listener-cleanup discipline as openDetailForSeq: the pane may
      // have subscribed to document-level annotation events, and dropping
      // its DOM alone would leak the callback.
      detachDetailListener(detailSlot)
      while (detailSlot.firstChild) detailSlot.removeChild(detailSlot.firstChild)
      detailSlot.hidden = true
      wrap.classList.remove('has-detail')
    }

    function setView(view) {
      if (!VIEWS.includes(view)) view = 'tree'
      for (const v of VIEWS) {
        const active = v === view
        btns[v].classList.toggle('active', active)
        btns[v].setAttribute('aria-selected', active ? 'true' : 'false')
        panelEls[v].hidden = !active
      }
      exportBtn.hidden = view === 'tree'
      if (view === 'timeline') ensureTimeline()
      if (view === 'graph') ensureGraph()
    }

    function exportCurrent() {
      const active = wrap.querySelector('.trace-tri-chip.active')
      const view = active && active.dataset.view ? active.dataset.view : 'timeline'
      if (view === 'tree') return
      const mod = view === 'timeline'
        ? (typeof window !== 'undefined' && window.__dshTraceTimeline)
        : (typeof window !== 'undefined' && window.__dshTraceGraph)
      if (!mod) return
      const fn = view === 'timeline' ? mod.exportTimelineSVG : mod.exportGraphSVG
      const svgText = fn(doc, spec.records || [], { onSeqClick: null })
      if (!svgText) return
      downloadSvg(doc, svgText, `dsh-trace-${view}-${Date.now()}.svg`)
    }

    wrap.appendChild(chips)
    wrap.appendChild(stage)

    setView(spec.defaultView && VIEWS.includes(spec.defaultView) ? spec.defaultView : 'tree')

    return wrap
  }

  function downloadSvg(doc, svgText, filename) {
    try {
      const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' })
      const url = (typeof URL !== 'undefined' && URL.createObjectURL) ? URL.createObjectURL(blob) : null
      if (!url) return
      const a = doc.createElement('a')
      a.href = url
      a.download = filename
      doc.body.appendChild(a)
      a.click()
      setTimeout(function () {
        try { doc.body.removeChild(a) } catch (_) {}
        if (URL.revokeObjectURL) URL.revokeObjectURL(url)
      }, 0)
    } catch (_) { /* best-effort — no user-visible error */ }
  }

  // ─── session-scope trace derivation ───────────────────────────────────
  //
  // sessionTraceRecords(events) → step-record[]
  //
  // Runs trace-aggregator over a session's full event list. Callers use it
  // to feed the Timeline/Graph views when the "Full trace" button opens.
  // Kept here so the DOM shell only imports one module.

  function sessionTraceRecords(events) {
    const agg = (typeof window !== 'undefined' && window.__dshTraceAgg) || null
    if (!agg || typeof agg.aggregateSteps !== 'function') return []
    return agg.aggregateSteps(Array.isArray(events) ? events : [])
  }

  // Pick the step-record whose seq range contains `seq`, preferring an
  // exact startSeq match. Falls back to the closest containing range, then
  // to the last record before `seq`. Returns null when nothing matches.
  function pickRecordForSeq(records, seq) {
    if (!Array.isArray(records) || !records.length) return null
    if (typeof seq !== 'number' || !Number.isFinite(seq)) return records[0] || null
    for (const rec of records) if (rec && rec.startSeq === seq) return rec
    for (const rec of records) {
      if (!rec) continue
      const s = Number.isFinite(rec.startSeq) ? rec.startSeq : -Infinity
      const e = Number.isFinite(rec.endSeq) ? rec.endSeq : Infinity
      if (seq >= s && seq <= e) return rec
    }
    let best = null
    for (const rec of records) {
      if (!rec) continue
      if (Number.isFinite(rec.startSeq) && rec.startSeq <= seq) {
        if (!best || rec.startSeq >= best.startSeq) best = rec
      }
    }
    return best || records[0] || null
  }

  function titleForRec(rec, meta) {
    if (!rec) return 'Detail'
    const stepPart = (Number.isFinite(rec.turn) && Number.isFinite(rec.step))
      ? `step ${rec.turn}.${rec.step}`
      : (Number.isFinite(rec.step) ? `step ?.${rec.step}` : 'step ?')
    if (meta && meta.name) return `${stepPart} · ${meta.name}`
    if (rec.summary) return `${stepPart} · ${trimSummary(rec.summary)}`
    return stepPart
  }
  function subtitleForRec(rec) {
    if (!rec) return ''
    const parts = []
    if (Number.isFinite(rec.startSeq)) parts.push(`seq ${rec.startSeq}${Number.isFinite(rec.endSeq) ? '–' + rec.endSeq : ''}`)
    if (Number.isFinite(rec.durationMs)) parts.push(`${rec.durationMs}ms`)
    return parts.join(' · ')
  }
  function trimSummary(s) {
    const agg = (typeof window !== 'undefined' && window.__dshTraceAgg) || null
    if (agg && typeof agg.trimSummary === 'function') return agg.trimSummary(s) || ''
    if (typeof s !== 'string') return ''
    return s.length > 60 ? s.slice(0, 57) + '…' : s
  }

  // Detach any lingering `dsh:annotation-updated` listener the previous
  // detail pane subscribed to.  The pane records its listener as
  // `_detailPaneListener` on its host node with the target it registered
  // against as `_detailPaneListenerTarget`; without cleanup, reopening the
  // pane over a long session grows the listener set without bound (drift
  // reviewer 2026-07-17).  Safe to call when nothing is mounted.
  function detachDetailListener(slot) {
    if (!slot || !slot.querySelectorAll) return
    const panes = slot.querySelectorAll('.trace-detail-pane')
    if (!panes || !panes.length) return
    for (const pane of panes) {
      const listener = pane && pane._detailPaneListener
      const target = pane && pane._detailPaneListenerTarget
      if (listener && target && typeof target.removeEventListener === 'function') {
        try { target.removeEventListener('dsh:annotation-updated', listener) }
        catch (_) { /* listener removal is best-effort */ }
      }
      if (pane) { pane._detailPaneListener = null; pane._detailPaneListenerTarget = null }
    }
  }

  // Tree-side toolbar.  Pure DOM builder — takes
  // the container doc + the tri-view spec, returns { el, attach(treeEl) }.
  // Not exported globally because it's a UI helper local to this shell;
  // tests reach it via buildTriView + queryAll.  Behavior:
  //   filter input → hides trace-event-row/summary whose text does not
  //     include the query (case-insensitive).  Empty query restores all.
  //   waterfall toggle → toggles .waterfall-off on the tree card so
  //     .trace-event-bar-track fades out; structure stays.
  //   expand-all / collapse-all → walks every <details> inside the tree
  //     and sets .open on/off in one pass.
  //   settings → calls window.__dshOpenTraceSettings?.() if present.
  function buildTreeToolbar(doc, spec) {
    const el = doc.createElement('div')
    el.className = 'trace-tree-toolbar'
    el.setAttribute('role', 'toolbar')
    el.setAttribute('aria-label', 'Tree view toolbar')

    // Filter — text input with typographic magnifier as its label.
    const filter = doc.createElement('input')
    filter.type = 'search'
    filter.className = 'trace-tree-filter mono'
    filter.placeholder = 'filter…'
    filter.setAttribute('aria-label', 'Filter tree rows')

    // Waterfall toggle — LangSmith "Waterfall" chip on the tree panel.
    const wf = doc.createElement('button')
    wf.type = 'button'
    wf.className = 'trace-tree-tool trace-tree-waterfall active'
    wf.textContent = 'Waterfall'
    wf.title = 'Show/hide the inline waterfall bars on tree rows'
    wf.setAttribute('aria-pressed', 'true')

    // Expand-all / Collapse-all — walk every <details> in the tree.
    const expandAll = doc.createElement('button')
    expandAll.type = 'button'
    expandAll.className = 'trace-tree-tool trace-tree-expand'
    expandAll.textContent = 'Expand all'
    expandAll.title = 'Expand every row in the tree'
    const collapseAll = doc.createElement('button')
    collapseAll.type = 'button'
    collapseAll.className = 'trace-tree-tool trace-tree-collapse'
    collapseAll.textContent = 'Collapse all'
    collapseAll.title = 'Collapse every row in the tree'

    // Settings — opens researcher settings pane when wired; otherwise
    // the button reads as a live seam so the shape stays honest.
    const settings = doc.createElement('button')
    settings.type = 'button'
    settings.className = 'trace-tree-tool trace-tree-settings'
    settings.textContent = 'Settings'
    settings.title = 'Open trace-view settings (density, columns, chunk fold)'

    el.appendChild(filter)
    el.appendChild(wf)
    el.appendChild(expandAll)
    el.appendChild(collapseAll)
    el.appendChild(settings)

    let treeRoot = null
    function attach(treeEl) { treeRoot = treeEl }

    function walkDetails(cb) {
      if (!treeRoot || typeof treeRoot.querySelectorAll !== 'function') return
      const list = treeRoot.querySelectorAll('details, .trace-card, .trace-event-row')
      if (!list || !list.forEach) return
      list.forEach(function (d) { try { cb(d) } catch (_) {} })
    }

    filter.addEventListener('input', function () {
      if (!treeRoot || typeof treeRoot.querySelectorAll !== 'function') return
      const q = String(filter.value || '').trim().toLowerCase()
      const rows = treeRoot.querySelectorAll('.trace-event-row')
      if (!rows || !rows.forEach) return
      rows.forEach(function (row) {
        if (!q) { row.hidden = false; return }
        const txt = String(row.textContent || '').toLowerCase()
        row.hidden = !txt.includes(q)
      })
    })

    wf.addEventListener('click', function () {
      if (!treeRoot || !treeRoot.classList) return
      const has = typeof treeRoot.classList.contains === 'function' && treeRoot.classList.contains('waterfall-off')
      if (has) treeRoot.classList.remove('waterfall-off')
      else treeRoot.classList.add('waterfall-off')
      const on = !has ? false : true
      // on = new "waterfall visible" state after this click.
      if (on) { wf.classList.add('active'); wf.setAttribute('aria-pressed', 'true') }
      else    { wf.classList.remove('active'); wf.setAttribute('aria-pressed', 'false') }
    })

    expandAll.addEventListener('click', function () { walkDetails(function (d) { d.open = true }) })
    collapseAll.addEventListener('click', function () { walkDetails(function (d) { d.open = false }) })

    settings.addEventListener('click', function () {
      if (typeof window !== 'undefined' && typeof window.__dshOpenTraceSettings === 'function') {
        try { window.__dshOpenTraceSettings() } catch (_) {}
      }
    })

    return { el, attach }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildTriView, sessionTraceRecords, pickRecordForSeq, buildTreeToolbar, detachDetailListener, VIEWS }
  }
  if (typeof window !== 'undefined') {
    window.__dshTraceTriView = { buildTriView, sessionTraceRecords, pickRecordForSeq, buildTreeToolbar, detachDetailListener, VIEWS }
  }
})()
