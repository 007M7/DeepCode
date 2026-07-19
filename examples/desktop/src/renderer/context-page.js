// Context page controller — (#179-A Ledger surface, renamed to
// Context per team-lead 2026-07-17). Renders the L0/L1 stream described
// in docs/design-refs/ia-design-pack-179.md §3 "Ledger — the context
// surface" using the pure projections from context-page-model.js.
//
// Data source is the active session's `meta.cachedEvents` on
// window.__dshChat (identical wire the Context Rail drawer reads), so the
// page reflects the same truth the chat stream and rail dots do — no new
// IPC. When no session is active OR the session has zero events, the
// page shows an empty state with buttons that call the DSH_QA=1 fixture
// seams already added on test-real (`__dshQaSeedSession`,
// `__dshQaPlayFixture`) so a viewer without an API key can still see the
// page shape.
//
// Layer contract per docs/design-refs/density-layering-spec.md:
//
//   L0 — one row per turn boundary, single-line, identity + 3 metric
//        counters (inject/compact/recall) + budget% + sparkline pip.
//   L1 — inline expansion (native <details>) with 4 chip groups:
//        shadowing tri-state (display + control stub), injection roster,
//        recall config summary, compact policy display. Each group cites
//        its SDK-support status honestly.
//   L2 — `{ }` opens the existing tool-cards JSON drawer against the
//        cached events for that turn window (no new drawer surface).
//   L3 — an "Open Rail" button reuses the Context Rail drawer already
//        wired up by renderer.js; clicking a row in L0 also
//        scrolls the Chat stream to the first event of that turn.
//
// SDK-support legend at the page bottom names every knob's status (live,
// restart-required, upstream-pending) with the corresponding G-number so
// the researcher never wonders "did that dropdown actually do anything?"

'use strict'
;(function () {

  if (typeof window === 'undefined') return

  const state = {
    // Cached shadowing selection is a display stub — the runtime doesn't
    // honour it until session/set-compact-policy exists (gap G2). We
    // still hold the value in memory so a `Save as profile` YAML export
    // reflects the researcher's stated intent.
    shadowing: 'auto',
    // Track how many injection scopes the user has flipped off in this
    // session so the "Save as profile" button carries the right list.
    injectionScopes: new Map(), // plugin → boolean (default true = allow)
    // Cache of the last rendered rows for the sparkline scale. Stored so
    // a row expansion doesn't force a full re-project.
    lastRows: [],
  }

  let els = null

  function $ (id) { return document.getElementById(id) }
  function el (tag, cls, text) {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }

  function mount () {
    const pane = document.querySelector('.pane[data-pane="context"]')
    if (!pane) return
    if (pane.dataset.mounted === '1') { refresh(); return }
    pane.dataset.mounted = '1'

    els = {
      pane,
      // Body is the grid container; we toggle `.is-empty` on it so CSS can
      // collapse the two-column skeleton to a single stack when there are no
      // rows to show (#14, empty-layout fix).
      body: pane.querySelector('.context-page-body'),
      empty: pane.querySelector('#context-page-empty'),
      list: pane.querySelector('#context-page-list'),
      legend: pane.querySelector('#context-page-legend'),
      subtitle: pane.querySelector('#context-page-subtitle'),
      openRail: pane.querySelector('#context-page-open-rail'),
      saveProfile: pane.querySelector('#context-page-save-profile'),
      loadSample: pane.querySelector('#context-page-load-sample'),
      loadWorkflow: pane.querySelector('#context-page-load-workflow'),
      // lane-ctx-deep additions:
      topStrip: pane.querySelector('[data-context-topstrip]'),
      windowBarTrack: pane.querySelector('#context-window-bar-track'),
      windowBarLegend: pane.querySelector('#context-window-bar-legend'),
      windowBarSummary: pane.querySelector('#context-window-bar-summary'),
      interventionTrack: pane.querySelector('#context-intervention-track'),
      interventionSummary: pane.querySelector('#context-intervention-summary'),
    }

    if (els.openRail) {
      els.openRail.addEventListener('click', () => {
        const railBtn = document.getElementById('ctx-rail-btn')
        if (railBtn) railBtn.click()
      })
    }
    if (els.saveProfile) {
      els.saveProfile.addEventListener('click', onSaveProfile)
    }
    if (els.loadSample) {
      els.loadSample.addEventListener('click', () => playFixture('1.7-compact-three-events.json'))
    }
    if (els.loadWorkflow) {
      els.loadWorkflow.addEventListener('click', () => playFixture('1.3-A-inject-session-start.json'))
    }

    renderLegend()
    refresh()
  }

  function playFixture (name) {
    const play = window.__dshQaPlayFixture
    if (typeof play === 'function') {
      // The seam already creates a fresh session and returns after the
      // events are dispatched into the reducer, so we just wait and
      // re-render — no state juggling required here.
      play(name).then(() => setTimeout(refresh, 60))
    } else {
      appendStatus('Load-sample fixtures require DSH_QA=1 (developer mode).')
    }
  }

  function appendStatus (text) {
    if (!els) return
    const note = el('div', 'context-page-status muted', text)
    if (els.list) {
      els.list.innerHTML = ''
      els.list.appendChild(note)
    }
  }

  function activeEvents () {
    const chat = window.__dshChat
    if (!chat) return []
    // Preferred: read straight from the live sessions map so we get the
    // fresh cachedEvents ring even between session/list refreshes.
    const sid = typeof chat.getActiveSessionId === 'function' ? chat.getActiveSessionId() : null
    if (!sid || typeof chat.getSessions !== 'function') return []
    // getSessions() drops live-only fields — but we need cachedEvents,
    // which lives on the sessions Map. Reach into the underlying state
    // via a private accessor when available; fall back to no data.
    // Renderer exposes __dshChat.getEventsForActive as a stable seam:
    if (typeof chat.getEventsForActive === 'function') {
      return chat.getEventsForActive() || []
    }
    // Fallback: use the private state getter renderer.js sets up. This
    // path is DSH_QA-only (dev builds); production always has the seam.
    if (window.__dshRendererState && window.__dshRendererState.sessions) {
      const meta = window.__dshRendererState.sessions.get(sid)
      return (meta && Array.isArray(meta.cachedEvents)) ? meta.cachedEvents : []
    }
    return []
  }

  function refresh () {
    if (!els) return
    const events = activeEvents()
    const model = window.__dshContextPageModel
    if (!model) {
      appendStatus('context-page-model.js failed to load — page is inert.')
      return
    }

    if (!events.length) {
      renderEmpty()
      return
    }
    if (els.empty) els.empty.hidden = true
    // Body has rows — restore the two-column layout (#14).
    if (els.body) els.body.classList.remove('is-empty')
    if (els.list) els.list.hidden = false

    // lane-ctx-deep F1 + F3: render the top strip (window bar +
    // intervention markers) alongside the per-turn rows.
    renderWindowBar(events)
    renderInterventionStrip(events)
    if (els.topStrip) els.topStrip.hidden = false

    const rows = model.projectTurnRows(events)
    state.lastRows = rows
    if (els.subtitle) {
      const closed = rows.filter((r) => r.closed).length
      const open = rows.length - closed
      const tail = open > 0 ? ` (turn ${rows[rows.length - 1].turn} in-flight)` : ''
      els.subtitle.textContent = `${rows.length} turn${rows.length === 1 ? '' : 's'} of context history · ${closed} closed${tail}`
    }
    renderRows(rows, events, model)
  }

  // ---- lane-ctx-deep F1: Window occupancy stacked bar ----------------------

  function renderWindowBar (events) {
    if (!els || !els.windowBarTrack) return
    const api = window.__dshContextWindowBreakdown
    if (!api || typeof api.computeWindowBreakdown !== 'function') return
    // Pull the wire budget from the active session if we can — mirrors
    // context-meter's promotion path so the "% of budget" number reads the
    // same number the statusbar shows.
    const budgetTokens = readActiveBudgetTokens()
    const view = api.computeWindowBreakdown(events, budgetTokens ? { budgetTokens } : undefined)
    const track = els.windowBarTrack
    track.innerHTML = ''
    // Render five stacked segments in FAMILY_ORDER — zero-token slices get
    // a 0-width segment so the CSS grid keeps its shape (helps DOM tests
    // count the number of segments deterministically).
    for (const slice of view.slices) {
      const seg = document.createElement('div')
      seg.className = `context-window-seg context-window-seg--${slice.family}`
      seg.style.setProperty('--seg-pct', `${Math.max(0, slice.pct)}%`)
      seg.dataset.family = slice.family
      seg.dataset.tokens = String(slice.tokens)
      seg.dataset.pct = String(slice.pct)
      const suffix = slice.family === 'tool_defs' && view.toolsFromCalls
        ? ' (estimated from tool/call names)'
        : slice.family === 'thinking' && view.mode === 'approx'
        ? ' (approx)'
        : ''
      seg.title = `${slice.label}: ${slice.tokens} tok (${slice.pct}%${suffix})`
      seg.setAttribute('aria-label', seg.title)
      track.appendChild(seg)
    }
    if (els.windowBarLegend) {
      els.windowBarLegend.innerHTML = ''
      for (const slice of view.slices) {
        const row = document.createElement('span')
        row.className = `context-window-legend-item context-window-legend-item--${slice.family}`
        const dot = document.createElement('span')
        dot.className = `context-window-legend-dot context-window-legend-dot--${slice.family}`
        const label = document.createElement('span')
        label.className = 'context-window-legend-label'
        label.textContent = slice.label
        const value = document.createElement('span')
        value.className = 'context-window-legend-value muted'
        value.textContent = slice.tokens > 0
          ? `${slice.tokens.toLocaleString()} tok · ${slice.pct}%`
          : '0'
        row.appendChild(dot); row.appendChild(label); row.appendChild(value)
        els.windowBarLegend.appendChild(row)
      }
    }
    if (els.windowBarSummary) {
      const bs = view.budgetSource === 'server' ? '' : ' (assumed)'
      const modeTag = view.mode === 'precise' ? '' : ' · approx'
      els.windowBarSummary.textContent = `${view.totalTokens.toLocaleString()} tok / ${view.budget.toLocaleString()} tok${bs} · ${view.budgetPct}% of budget${modeTag}`
    }
  }

  function readActiveBudgetTokens () {
    const meter = window.__dshContextMeter
    const chat = window.__dshChat
    if (!meter || !chat || typeof chat.getActiveSessionId !== 'function') return null
    const sid = chat.getActiveSessionId()
    if (!sid) return null
    // Renderer stores per-session context trackers on the state map; peek at
    // the snapshot when we can, otherwise fall back to null (which the
    // model translates to the 128k assumed budget).
    if (window.__dshRendererState && window.__dshRendererState.sessions) {
      const meta = window.__dshRendererState.sessions.get(sid)
      if (meta && meta.contextTracker && typeof meta.contextTracker.snapshot === 'function') {
        const snap = meta.contextTracker.snapshot()
        if (snap && snap.budgetSource === 'server' && Number.isFinite(snap.budget)) return snap.budget
      }
    }
    return null
  }

  // ---- lane-ctx-deep F3: Intervention marker strip ------------------------

  function renderInterventionStrip (events) {
    if (!els || !els.interventionTrack) return
    const api = window.__dshInterventionTimeline
    if (!api || typeof api.collectInterventions !== 'function') return
    const markers = api.collectInterventions(events)
    const track = els.interventionTrack
    track.innerHTML = ''

    if (markers.length === 0) {
      if (els.interventionSummary) els.interventionSummary.textContent = 'no interventions this session'
      const empty = document.createElement('div')
      empty.className = 'context-intervention-empty muted small'
      empty.textContent = 'No edit-rerun, fork, or steer events yet.'
      track.appendChild(empty)
      return
    }

    // The strip is a timeline: position each marker by its seq relative to
    // min/max seq so early interventions cluster left and late ones cluster
    // right. Density permitting, this reads like a Perforce swarm marker
    // strip — a scannable audit of user overrides.
    const minSeq = markers[0].seq
    const maxSeq = markers[markers.length - 1].seq
    const span = Math.max(1, maxSeq - minSeq)

    for (const m of markers) {
      const pct = span > 0 ? ((m.seq - minSeq) / span) * 100 : 50
      const marker = document.createElement('button')
      marker.type = 'button'
      marker.className = `context-intervention-marker context-intervention-marker--${m.kind}`
      marker.style.setProperty('--marker-pos', `${pct}%`)
      marker.dataset.kind = m.kind
      marker.dataset.seq = String(m.seq)
      marker.dataset.turn = String(m.turn)
      marker.textContent = m.glyph
      const previewLine = m.preview ? ` — ${m.preview}` : ''
      marker.title = `${m.label} · turn ${m.turn} · seq ${m.seq}${previewLine}`
      marker.setAttribute('aria-label', marker.title)
      marker.addEventListener('click', () => jumpToInterventionSeq(m.seq))
      track.appendChild(marker)
    }

    // Summary line — count per kind. Uses the model's summariser so tests
    // can lock the same shape.
    if (els.interventionSummary) {
      const roll = api.summariseInterventions(markers)
      const parts = roll.map((r) => `${r.count} ${r.label.toLowerCase()}${r.count === 1 ? '' : 's'}`)
      els.interventionSummary.textContent = parts.length > 0 ? parts.join(' · ') : 'no interventions'
    }
  }

  function jumpToInterventionSeq (seq) {
    // Same pattern as buildJumpBtn — switch to Chat, then scroll to the
    // stream row with the matching data-seq (or data-first-seq for turn
    // headers).
    const tabs = window.__dshTabs
    if (tabs && typeof tabs.switchTo === 'function') tabs.switchTo('chat')
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const stream = document.getElementById('stream')
      if (!stream) return
      const target = stream.querySelector(`[data-seq="${seq}"]`)
        || stream.querySelector(`[data-first-seq="${seq}"]`)
      if (target && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    }))
  }

  function renderEmpty () {
    if (!els) return
    if (els.topStrip) els.topStrip.hidden = true
    if (els.list) {
      els.list.innerHTML = ''
      // Hide the empty rows container so it doesn't reserve grid track
      // width and reopen the "left hole" the empty layout fix targets (#14).
      els.list.hidden = true
    }
    if (els.empty) els.empty.hidden = false
    // Collapse the body grid to a single column so the empty card + SDK card
    // stack as one document flow (#14). Populated state re-adds two columns.
    if (els.body) els.body.classList.add('is-empty')
    if (els.subtitle) {
      // Single source of truth for the "no activity" line; the empty card
      // used to repeat this and was trimmed to just the actionable copy.
      els.subtitle.textContent = 'No context activity yet — start a chat, or load a sample session below.'
    }
  }

  // ---- Rows ---------------------------------------------------------------

  function renderRows (rows, events, model) {
    if (!els.list) return
    els.list.innerHTML = ''
    const line = model.computeBudgetSparkline(rows)
    // Map turn → sparkline entry for the row's inline mini-bar; the whole
    // series is normalised so a low-budget session still shows variation.
    const byTurn = new Map()
    for (const p of line) byTurn.set(p.turn, p)

    for (const row of rows) {
      els.list.appendChild(buildRow(row, byTurn.get(row.turn), events, model))
    }
  }

  function buildRow (row, spark, events, model) {
    const details = el('details', 'context-page-row')
    details.dataset.turn = String(row.turn)
    details.dataset.firstSeq = String(row.firstSeq)
    if (!row.closed) details.dataset.open = 'running'

    const summary = el('summary', 'context-page-row-summary')
    // identity + gist + 2 metrics. We show 3 tiny
    // counters after the identity to preserve the row's structure
    // (inject / compact / recall) — collectively they read as "context
    // deltas this turn", i.e. one gist. Budget is the extra metric.
    const turnCell = el('span', 'context-page-row-turn')
    turnCell.textContent = row.closed ? `turn ${row.turn}` : `turn ${row.turn} · running`
    summary.appendChild(turnCell)

    const counters = el('span', 'context-page-row-counters')
    counters.appendChild(buildCounter('+', row.injectCount, 'inject', 'injection events'))
    counters.appendChild(buildCounter('-', row.compactCount, 'compact', 'compact events'))
    counters.appendChild(buildCounter('~', row.recallCount, 'recall', 'recall tool calls'))
    summary.appendChild(counters)

    const budget = el('span', 'context-page-row-budget')
    const pctText = row.budget > 0 ? `${row.budgetPct}%` : '—'
    const budgetSourceHint = row.budgetSource === 'assumed' ? ' (assumed budget)' : ''
    budget.textContent = pctText
    budget.title = `Context usage ${pctText} of ${row.budget} tokens${budgetSourceHint}`
    if (row.budgetSource === 'assumed') budget.classList.add('is-assumed')
    if (row.budgetPct >= 80) budget.classList.add('is-high')
    if (row.budgetPct >= 95) budget.classList.add('is-critical')
    summary.appendChild(budget)

    // Sparkline pip — a single vertical bar whose height mirrors this
    // row's normalised budget. Aggregated left-to-right down the page,
    // the pips form the sparkline itself. CSS-only, no SVG.
    if (spark) {
      const pip = el('span', 'context-page-row-spark')
      pip.style.setProperty('--pip-h', `${Math.round(spark.height * 100)}%`)
      pip.title = `Row ${row.turn}: ${spark.pct}% of budget`
      summary.appendChild(pip)
    }

    // Right-side actions: JSON drawer + jump to seq. Sits inside <summary>
    // so it's always visible on L0 without opening the row.
    const actions = el('span', 'context-page-row-actions')
    actions.appendChild(buildJsonBtn(row, events))
    actions.appendChild(buildJumpBtn(row))
    // Prevent the action click from toggling the <details> — clicking the
    // JSON button should NOT expand/collapse the row.
    actions.addEventListener('click', (e) => e.stopPropagation())
    summary.appendChild(actions)

    details.appendChild(summary)

    // L1 expansion body — four chip groups + a note strip. Built lazily
    // on first open so a long session doesn't build 40 chip rosters just
    // to have them collapsed by default.
    details.addEventListener('toggle', () => {
      if (details.open && !details.dataset.hydrated) {
        const body = buildRowBody(row, events, model)
        details.appendChild(body)
        details.dataset.hydrated = '1'
      }
    })

    return details
  }

  function buildCounter (glyph, count, kind, title) {
    const s = el('span', `context-page-counter context-page-counter--${kind}`)
    s.textContent = `${glyph}${count}`
    s.title = `${count} ${title}`
    if (count === 0) s.classList.add('is-zero')
    return s
  }

  function buildJsonBtn (row, events) {
    const btn = el('button', 'context-page-json-btn ghost small')
    btn.type = 'button'
    btn.textContent = '{ }'
    btn.title = `Open the underlying context events for turn ${row.turn}`
    btn.setAttribute('aria-label', `Open JSON for turn ${row.turn}`)
    btn.addEventListener('click', () => openJson(row, events))
    return btn
  }

  function buildJumpBtn (row) {
    const btn = el('button', 'context-page-jump-btn ghost small')
    btn.type = 'button'
    btn.textContent = '→ chat'
    btn.title = `Scroll the chat stream to seq ${row.firstSeq}`
    btn.setAttribute('aria-label', `Jump to seq ${row.firstSeq}`)
    btn.addEventListener('click', () => {
      const tabs = window.__dshTabs
      if (tabs && typeof tabs.switchTo === 'function') tabs.switchTo('chat')
      // Two-frame wait so the chat pane is visible before scrolling.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const stream = document.getElementById('stream')
        if (!stream) return
        const target = stream.querySelector(`[data-seq="${row.firstSeq}"]`)
          || stream.querySelector(`[data-first-seq="${row.firstSeq}"]`)
        if (target && typeof target.scrollIntoView === 'function') {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }
      }))
    })
    return btn
  }

  function openJson (row, events) {
    const tc = window.__dshToolCards
    if (!tc || typeof tc.openJsonDrawer !== 'function') return
    // Filter events to only what fell in this row's turn window; the
    // researcher usually wants the injections + compact events for the
    // turn, not the whole prompt/response stream.
    const inWindow = events.filter((ev) => {
      if (!ev || typeof ev.seq !== 'number') return false
      return ev.seq >= row.firstSeq && ev.seq <= row.lastSeq
    })
    tc.openJsonDrawer({
      title: `context turn ${row.turn} — seq ${row.firstSeq}-${row.lastSeq}`,
      call: null,
      result: {
        turn: row.turn,
        injectCount: row.injectCount,
        compactCount: row.compactCount,
        recallCount: row.recallCount,
        budget: { tokens: row.tokens, total: row.budget, pct: row.budgetPct, source: row.budgetSource },
        events: inWindow,
      },
    })
  }

  // ---- L1 body ------------------------------------------------------------

  function buildRowBody (row, events, model) {
    const body = el('div', 'context-page-row-body')
    body.appendChild(buildShadowingGroup(row))
    body.appendChild(buildInjectionRosterGroup(row, events, model))
    body.appendChild(buildRecallGroup(row, events, model))
    body.appendChild(buildCompactPolicyGroup(row, events, model))
    return body
  }

  function buildShadowingGroup (row) {
    const wrap = el('section', 'context-page-group context-page-group--shadowing')
    const title = el('h4', 'context-page-group-title', 'Shadowing')
    // Preflight (2026-07-18) blind-test #5: black-terminology tooltips —
    // 'Shadowing' means nothing to a first-time user. Explain it in-place.
    title.title = 'Shadowing = the daemon compacts older turns so newer ones fit the model window. The tri-state below picks who triggers it.'
    wrap.appendChild(title)
    const status = el('span', 'context-page-status-chip context-page-status-chip--restart', 'restart-required · G2')
    status.title = 'restart-required = editable, applied on next session restart. G2 = gap #2 in the design pack — session/set-compact-policy is not on the wire yet.'
    wrap.appendChild(status)

    const opts = ['auto', 'manual', 'off']
    const group = el('div', 'context-page-tri')
    for (const mode of opts) {
      const btn = el('button', 'context-page-tri-btn ghost small')
      btn.type = 'button'
      btn.textContent = mode
      btn.dataset.mode = mode
      if (state.shadowing === mode) btn.classList.add('is-active')
      btn.addEventListener('click', () => {
        state.shadowing = mode
        for (const b of group.querySelectorAll('.context-page-tri-btn')) {
          b.classList.toggle('is-active', b.dataset.mode === mode)
        }
      })
      group.appendChild(btn)
    }
    wrap.appendChild(group)

    const note = el('div', 'context-page-group-note muted small')
    note.textContent = 'auto = daemon compacts when the context meter crosses its threshold. manual = only the Compact button fires. off = never compact.'
    wrap.appendChild(note)
    return wrap
  }

  function buildInjectionRosterGroup (row, events, model) {
    const wrap = el('section', 'context-page-group context-page-group--roster')
    const title = el('h4', 'context-page-group-title', 'Injections this turn')
    title.title = 'Injections = system prompts / plugin context that got prepended to the model prompt for this turn.'
    wrap.appendChild(title)
    const status = el('span', 'context-page-status-chip context-page-status-chip--pending', 'upstream-pending · G4')
    status.title = 'upstream-pending = no wire method yet; the panel shows what plugins would inject, but there is no plugin/set-injection-scope method to change it. G4 = gap #4 in the design pack.'
    wrap.appendChild(status)

    if (row.injectCount === 0) {
      const empty = el('div', 'context-page-group-note muted small', 'No injections landed in this turn.')
      wrap.appendChild(empty)
      return wrap
    }

    const list = el('div', 'context-page-roster')
    // Deterministic sort: count desc, then plugin name asc.
    const sorted = row.injects.slice().sort((a, b) => (b.count - a.count) || a.plugin.localeCompare(b.plugin))
    for (const slice of sorted) {
      list.appendChild(buildRosterRow(slice))
    }
    wrap.appendChild(list)
    return wrap
  }

  function buildRosterRow (slice) {
    const row = el('div', 'context-page-roster-row')
    const nameBtn = el('button', 'context-page-roster-name ghost small')
    nameBtn.type = 'button'
    nameBtn.textContent = slice.plugin
    nameBtn.title = `Open the Plugins tab for ${slice.plugin}`
    nameBtn.addEventListener('click', () => {
      const tabs = window.__dshTabs
      if (tabs && typeof tabs.switchTo === 'function') tabs.switchTo('plugins')
    })
    row.appendChild(nameBtn)

    const count = el('span', 'context-page-roster-count', `× ${slice.count}`)
    count.title = `${slice.count} injection${slice.count === 1 ? '' : 's'} at seqs ${slice.seqs.join(', ')}`
    row.appendChild(count)

    // Toggle stub — G4 pending. The click is captured in state so a
    // "Save as profile" YAML has something to serialise; the runtime is
    // unaware today.
    const toggle = el('label', 'context-page-roster-toggle')
    const cb = el('input')
    cb.type = 'checkbox'
    const current = state.injectionScopes.has(slice.plugin) ? state.injectionScopes.get(slice.plugin) : true
    cb.checked = current
    cb.addEventListener('change', () => {
      state.injectionScopes.set(slice.plugin, cb.checked)
    })
    const cbLabel = el('span', 'muted small', 'allow')
    toggle.appendChild(cb)
    toggle.appendChild(cbLabel)
    row.appendChild(toggle)

    return row
  }

  function buildRecallGroup (row, events, model) {
    const wrap = el('section', 'context-page-group context-page-group--recall')
    const title = el('h4', 'context-page-group-title', 'Recall')
    title.title = 'Recall = tool calls that pulled memory / prior-turn snippets back into the current context.'
    wrap.appendChild(title)
    const status = el('span', 'context-page-status-chip context-page-status-chip--pending', 'upstream-pending · G3')
    status.title = 'upstream-pending = no wire method yet; the panel lists recall calls but cannot adjust the gate. G3 = gap #3 in the design pack — session/set-recall-config not on the wire.'
    wrap.appendChild(status)

    const inWindow = events.filter((ev) => ev && ev.type === 'tool/call' && model.RECALL_TOOL_NAMES.has(ev.data && ev.data.name) && ev.seq >= row.firstSeq && ev.seq <= row.lastSeq)
    const cfg = model.summarizeRecallConfig(inWindow)
    if (cfg.total === 0) {
      wrap.appendChild(el('div', 'context-page-group-note muted small', 'No recall in this turn.'))
      return wrap
    }
    const list = el('div', 'context-page-recall-list')
    for (const t of cfg.tools) {
      const r = el('div', 'context-page-recall-row')
      r.appendChild(el('span', 'context-page-recall-name', t.name))
      r.appendChild(el('span', 'context-page-recall-count', `× ${t.count}`))
      if (t.sampleArgs) {
        const pre = el('code', 'context-page-recall-args', t.sampleArgs.length > 100 ? t.sampleArgs.slice(0, 99) + '…' : t.sampleArgs)
        r.appendChild(pre)
      }
      list.appendChild(r)
    }
    wrap.appendChild(list)
    return wrap
  }

  function buildCompactPolicyGroup (row, events, model) {
    const wrap = el('section', 'context-page-group context-page-group--compact')
    const title = el('h4', 'context-page-group-title', 'Compact policy')
    title.title = 'Compact = fold older turns into a summary so the newer ones fit the model window. Policy = which model+budget the daemon uses for that fold.'
    wrap.appendChild(title)

    // Prefer the policy inferred from this row's compact events; fall
    // back to the session-wide latest so a turn with no compact still
    // shows what the current policy is.
    const inWindow = events.filter((ev) => ev && ev.type === 'compact/summary' && ev.seq >= row.firstSeq && ev.seq <= row.lastSeq)
    const policy = model.summarizeCompactPolicy(inWindow.length ? inWindow : events)

    if (!policy) {
      const status = el('span', 'context-page-status-chip context-page-status-chip--live', 'live · session/compact')
      status.title = 'The Compact button on the statusbar drives session/compact — this policy field will populate after the first compact lands.'
      wrap.appendChild(status)
      wrap.appendChild(el('div', 'context-page-group-note muted small', 'Policy not yet observed on this session.'))
      return wrap
    }

    const statusText = policy.source === 'manual' ? 'live · manual trigger' : (policy.source === 'auto' ? 'live · auto compaction' : 'live · trigger unclear')
    const status = el('span', 'context-page-status-chip context-page-status-chip--live', statusText)
    status.title = 'session/compact is live on the wire; per-turn compact events already flow.'
    wrap.appendChild(status)

    const list = el('dl', 'context-page-policy')
    appendPolicyRow(list, 'model', policy.model || 'unknown')
    appendPolicyRow(list, 'maxTokens', policy.maxTokens != null ? String(policy.maxTokens) : 'unknown')
    if (policy.shadowedTokens != null) appendPolicyRow(list, 'compacted', `${policy.shadowedTokens} tok`)
    appendPolicyRow(list, 'source', policy.source)
    wrap.appendChild(list)

    const restart = el('div', 'context-page-group-note muted small', 'Editing model/maxTokens applies on restart (gap G2).')
    wrap.appendChild(restart)
    return wrap
  }

  function appendPolicyRow (dl, label, value) {
    const dt = el('dt', 'context-page-policy-key', label)
    const dd = el('dd', 'context-page-policy-val', value)
    dl.appendChild(dt)
    dl.appendChild(dd)
  }

  // ---- Legend + Save profile ---------------------------------------------

  function renderLegend () {
    if (!els || !els.legend) return
    els.legend.innerHTML = ''
    const model = window.__dshContextPageModel
    if (!model) return
    const items = model.capabilitiesLegend()
    for (const item of items) {
      const row = el('div', `context-page-legend-row context-page-legend-row--${item.status}`)
      const dot = el('span', `context-page-legend-dot context-page-legend-dot--${item.status}`)
      row.appendChild(dot)
      row.appendChild(el('span', 'context-page-legend-name', item.knob))
      const statusLabel = item.gap
        ? `${humanStatus(item.status)} · ${item.gap}`
        : humanStatus(item.status)
      row.appendChild(el('span', 'context-page-legend-status muted small', statusLabel))
      row.appendChild(el('span', 'context-page-legend-note muted small', item.note))
      els.legend.appendChild(row)
    }
  }

  function humanStatus (status) {
    if (status === 'live') return 'live'
    if (status === 'restart-required') return 'restart-required'
    if (status === 'upstream-pending') return 'upstream-pending'
    return status
  }

  function onSaveProfile () {
    const model = window.__dshContextPageModel
    if (!model) return
    // Snapshot the display state into the YAML shape.
    const events = activeEvents()
    const policy = model.summarizeCompactPolicy(events) || {}
    const roster = model.buildInjectionRoster(events, { isFirstTurn: false })
    const scopes = roster.map((r) => ({
      plugin: r.plugin,
      allow: state.injectionScopes.has(r.plugin) ? !!state.injectionScopes.get(r.plugin) : true,
    }))
    const yaml = model.serializeProfileYAML({
      name: `context-profile-turn${state.lastRows.length}`,
      shadowing: state.shadowing,
      compactModel: policy.model || null,
      compactMaxTokens: policy.maxTokens || null,
      compactSource: policy.source || 'unknown',
      injectionScopes: scopes,
    })
    // The download path uses a Blob + <a download> — no main-process
    // round-trip, no filesystem write from the renderer. Save-as target
    // matches `~/.dsh/profiles/*.yaml` by naming convention.
    try {
      const blob = new Blob([yaml], { type: 'application/x-yaml;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'context-profile.yaml'
      document.body.appendChild(a)
      a.click()
      a.remove()
      // The URL stays valid for one navigation; revoke after a beat so
      // repeated clicks don't leak object URLs.
      setTimeout(() => URL.revokeObjectURL(url), 1500)
    } catch (_) {
      // Fallback: dump into the JSON drawer so the researcher can copy it
      // even when the download path is unavailable (e.g. sandboxed shell).
      const tc = window.__dshToolCards
      if (tc && typeof tc.openJsonDrawer === 'function') {
        tc.openJsonDrawer({ title: 'context-profile.yaml (copy from here)', call: null, result: yaml })
      }
    }
  }

  // ---- Wiring -------------------------------------------------------------

  window.__dshContextPage = {
    show () {
      mount()
      refresh()
    },
    refresh,
  }

  // Auto-mount when the DOM's ready so tab-switch doesn't have to wait
  // on the first render. Guarded so re-loading the module in a live
  // Electron window doesn't double-bind.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true })
  } else {
    mount()
  }

})()
