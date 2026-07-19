// Tracing page controller —. Renders the LangSmith-style project
// runs table (§11.1 of docs/design-refs/langsmith-tracing-study.md) at the
// L0 altitude: one row per session, scanning columns for Name / Most Recent
// Run / Trace Count / Error Rate / P50 / P99 / Total Tokens / Total Cost.
//
// Data path (no new IPC):
//
//   __dshChat.getSessions()               -> {id, title, meta bits} list
//   __dshChat.getEventsForSession(id)     -> cachedEvents array
//   __dshTracingIndexModel.projectSessionRows(...)  -> rows[]
//   __dshEffectivePriceTable()            -> price table for cost column
//
// Interactions:
//
//   - Search box (Name-only, case-insensitive, no debounce needed for <100
//     rows — the tracing page is a project-scale table, not a live tail).
//   - Columns menu: checkbox per column, persisted to localStorage under
//     `dsh.tracing.columns.v1`. New columns land visible by default so a
//     later release doesn't come up mysteriously narrow for old users.
//   - Row click: pulls the session's cachedEvents through
//     __dshTraceTriView.sessionTraceRecords(), swaps the table for the
//     tri-view panels (Timeline / Graph default; Tree stub notes per-turn
//     scope), and shows a breadcrumb Back to the table.
//
// Layer contract per docs/design-refs/density-layering-spec.md §7:
//   - Numeric columns right-align with `tabular-nums` (see style.css).
//   - Row hover only when the row is clickable (i.e. always here).
//   - Row height ~32px so ten sessions fit above the fold on a 800px pane.
//   - No fabricated data. Missing metrics render as '—' — the model
//     already substitutes `null` and formatCell converts it here.

'use strict'
;(function () {

  if (typeof window === 'undefined') return

  const state = {
    // Latest projection of rows (name-filtered against the search box).
    rows: [],
    // Latest raw sessions -> row map (unfiltered) for the Columns menu
    // toggle. Recomputed on every show().
    allRows: [],
    // Column visibility prefs; loaded from localStorage on first render.
    columnPrefs: null,
    // Current search query. Reset on tab switch away? No — LangSmith
    // preserves filters across visits and users repeatedly asked for the
    // same discipline in the pi study (§13.4). Keep it sticky.
    query: '',
    // Currently-drilled session id (row click); null when the table is
    // visible. Restored to null on Back.
    drillId: null,
    // Cleanup for the outside-click handler that closes the Columns menu.
    columnsMenuCleanup: null,
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
    const pane = document.querySelector('.pane[data-pane="tracing"]')
    if (!pane) return null
    if (pane.dataset.mounted === '1') return pane
    pane.dataset.mounted = '1'

    els = {
      pane,
      search: pane.querySelector('#tracing-page-search'),
      columnsBtn: pane.querySelector('#tracing-page-columns-btn'),
      columnsMenu: pane.querySelector('#tracing-page-columns-menu'),
      tableWrap: pane.querySelector('#tracing-page-table-wrap'),
      table: pane.querySelector('#tracing-page-table'),
      thead: pane.querySelector('#tracing-page-thead-row'),
      tbody: pane.querySelector('#tracing-page-tbody'),
      empty: pane.querySelector('#tracing-page-empty'),
      breadcrumb: pane.querySelector('#tracing-page-breadcrumb'),
      breadcrumbTitle: pane.querySelector('#tracing-page-breadcrumb-title'),
      back: pane.querySelector('#tracing-page-back'),
      detail: pane.querySelector('#tracing-page-detail'),
    }

    // Search box — Name filter, no debounce (input is coarse-grained and
    // the row set is small).
    if (els.search) {
      els.search.addEventListener('input', function () {
        state.query = els.search.value || ''
        renderTable()
      })
    }

    // Columns menu — outside click closes; checkbox change writes prefs +
    // re-renders header/body.
    if (els.columnsBtn && els.columnsMenu) {
      els.columnsBtn.addEventListener('click', function (ev) {
        ev.stopPropagation()
        toggleColumnsMenu()
      })
    }

    // Back button — leaves the drill view, restores the table.
    if (els.back) {
      els.back.addEventListener('click', function () { closeDrill() })
    }

    return pane
  }

  // ─── column prefs ─────────────────────────────────────────────────────

  function loadPrefs () {
    const M = window.__dshTracingIndexModel
    if (!M) return {}
    const store = (typeof localStorage !== 'undefined') ? localStorage : null
    return M.loadColumnPrefs(store)
  }
  function savePrefs (prefs) {
    const M = window.__dshTracingIndexModel
    if (!M) return
    const store = (typeof localStorage !== 'undefined') ? localStorage : null
    M.saveColumnPrefs(store, prefs)
  }

  function toggleColumnsMenu () {
    if (!els || !els.columnsMenu || !els.columnsBtn) return
    const open = !els.columnsMenu.hidden
    if (open) { closeColumnsMenu(); return }
    populateColumnsMenu()
    els.columnsMenu.hidden = false
    els.columnsBtn.setAttribute('aria-expanded', 'true')
    // Outside-click closer: mousedown so we win over the checkbox's click
    // event (which itself keeps the menu open via stopPropagation).
    const onDoc = function (ev) {
      if (!els.columnsMenu.contains(ev.target) && ev.target !== els.columnsBtn) {
        closeColumnsMenu()
      }
    }
    document.addEventListener('mousedown', onDoc)
    state.columnsMenuCleanup = function () {
      document.removeEventListener('mousedown', onDoc)
    }
  }
  function closeColumnsMenu () {
    if (!els || !els.columnsMenu || !els.columnsBtn) return
    els.columnsMenu.hidden = true
    els.columnsBtn.setAttribute('aria-expanded', 'false')
    if (state.columnsMenuCleanup) { state.columnsMenuCleanup(); state.columnsMenuCleanup = null }
  }
  function populateColumnsMenu () {
    if (!els || !els.columnsMenu) return
    const M = window.__dshTracingIndexModel
    if (!M) return
    els.columnsMenu.innerHTML = ''
    for (const col of M.COLUMNS) {
      const row = el('label', 'tracing-page-columns-menu-row')
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.checked = !!(state.columnPrefs && state.columnPrefs[col.id])
      cb.dataset.columnId = col.id
      // The Name column is the row identity; hiding it makes the table
      // read as a "rows of numbers with no key" list, which is a bug
      // researchers ask about repeatedly. Force it visible + disable so
      // the affordance is discoverable but unusable.
      if (col.id === 'name') {
        cb.checked = true
        cb.disabled = true
        cb.title = 'Name is required — it identifies the row.'
      }
      cb.addEventListener('change', function () {
        if (col.id === 'name') return  // guarded above but belt-and-suspenders
        state.columnPrefs[col.id] = cb.checked
        savePrefs(state.columnPrefs)
        renderTable()
      })
      row.appendChild(cb)
      row.appendChild(el('span', 'tracing-page-columns-menu-label', col.label))
      // Clicks on the label bubble to the checkbox natively; clicks on the
      // menu shouldn't bubble to `document` and close the menu.
      row.addEventListener('mousedown', function (ev) { ev.stopPropagation() })
      els.columnsMenu.appendChild(row)
    }
  }

  // ─── row projection ───────────────────────────────────────────────────

  function projectAllRows () {
    const M = window.__dshTracingIndexModel
    const Chat = window.__dshChat
    if (!M || !Chat || typeof Chat.getSessions !== 'function') return []
    const sessions = Chat.getSessions() || []
    const priceTable = (typeof window.__dshEffectivePriceTable === 'function')
      ? window.__dshEffectivePriceTable()
      : (window.__dshPriceTable || null)
    const list = []
    for (const s of sessions) {
      // __dshChat.getSessions() ships each session under `sessionId`
      // (not `id`); normalize to what the model expects.
      const sid = s && (s.sessionId || s.id)
      if (!sid) continue
      const events = (typeof Chat.getEventsForSession === 'function')
        ? Chat.getEventsForSession(sid)
        : []
      list.push({
        id: sid,
        title: s.title || sid,
        // Field §3 P0 #5 (2026-07-17): forward SessionHeader so the row
        // projector can pick cwd for the row hover title. `s.header`
        // comes from __dshChat.getSessions() (renderer.js:6572) which
        // relays meta.header verbatim; undefined for sessions without a
        // known header (fresh runs, some fixtures).
        header: s.header || null,
        meta: { lastEventTime: s.lastEventTime },
        events,
      })
    }
    // Filter empty sessions off the top: a persisted session with
    // eventCount:0 and no cached events would render a full row of
    // dashes and dilute the scanning surface. Same discipline as
    // Recent list rule "no empty rows" (panels-c.filterEmptySessions).
    // We keep sessions with any cached event OR any positive
    // lastEventTime, since an event might have arrived after our last
    // list refresh but before we opened the session.
    const nonEmpty = list.filter((s) => {
      if (s.events && s.events.length > 0) return true
      if (s.meta && typeof s.meta.lastEventTime === 'number' && s.meta.lastEventTime > 0) return true
      return false
    })
    return M.projectSessionRows(nonEmpty, { priceTable })
  }

  function sortRows (rows) {
    // Default sort: most-recent-run descending. Sessions without a time
    // sink to the bottom. Matches LangSmith's default project view.
    return rows.slice().sort((a, b) => {
      const ta = (typeof a.mostRecentTime === 'number') ? a.mostRecentTime : -Infinity
      const tb = (typeof b.mostRecentTime === 'number') ? b.mostRecentTime : -Infinity
      if (ta === tb) return (a.name || '').localeCompare(b.name || '')
      return tb - ta
    })
  }

  // ─── rendering ────────────────────────────────────────────────────────

  function visibleColumns () {
    const M = window.__dshTracingIndexModel
    const prefs = state.columnPrefs || {}
    return M.COLUMNS.filter((c) => c.id === 'name' || prefs[c.id])
  }

  function renderHead (cols) {
    if (!els || !els.thead) return
    els.thead.innerHTML = ''
    for (const c of cols) {
      const th = el('th', 'tracing-page-th', c.label)
      th.dataset.columnId = c.id
      if (c.numeric) th.classList.add('num')
      els.thead.appendChild(th)
    }
  }

  function renderTable () {
    if (!els) return
    const M = window.__dshTracingIndexModel
    if (!M) return
    const cols = visibleColumns()
    renderHead(cols)

    const filtered = M.filterByName(state.allRows, state.query)
    state.rows = sortRows(filtered)

    els.tbody.innerHTML = ''
    for (const row of state.rows) {
      const tr = el('tr', 'tracing-page-row')
      tr.dataset.sessionId = row.id
      tr.tabIndex = 0
      tr.setAttribute('role', 'button')
      // Field §3 P0 #5 (2026-07-17): fold cwd into the hover title so the
      // researcher scanning the tracing index sees "which working dir this
      // session was created in" without opening the drill. Falls back to
      // the bare `Open …` label when cwd is absent (undefined header, or
      // legacy sessions predating the field).
      tr.title = row.cwd
        ? `Open ${row.name || row.id} in tri-view\ncwd: ${row.cwd}`
        : `Open ${row.name || row.id} in tri-view`
      for (const c of cols) {
        const td = el('td', 'tracing-page-td')
        if (c.numeric) td.classList.add('num')
        td.dataset.columnId = c.id
        td.textContent = M.formatCell(row, c.id)
        tr.appendChild(td)
      }
      tr.addEventListener('click', function () {
        markRowSelected(tr)
        openDrill(row.id, row.name)
      })
      tr.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault()
          markRowSelected(tr)
          openDrill(row.id, row.name)
        }
      })
      els.tbody.appendChild(tr)
    }

    const showEmpty = state.rows.length === 0
    els.empty.hidden = !showEmpty
    els.table.hidden = showEmpty
  }

  // ─── drill: tri-view for one session ──────────────────────────────────

  // rows had no `.selected` reflex,
  // so a reader who clicked lost track of which trajectory drove the
  // detail view. Give the row a distinct class the CSS lights up in
  // accent-soft; siblings clear on the way in so exactly one row wears
  // the state.
  function markRowSelected (tr) {
    if (!els || !els.tbody) return
    const prev = els.tbody.querySelectorAll('.tracing-page-row.selected')
    if (prev && prev.forEach) prev.forEach(function (r) { r.classList.remove('selected') })
    if (tr && tr.classList) {
      tr.classList.add('selected')
      tr.setAttribute('aria-selected', 'true')
    }
  }

  function openDrill (sessionId, name) {
    if (!els || !sessionId) return
    const Chat = window.__dshChat
    const Tri = window.__dshTraceTriView
    if (!Chat || !Tri || typeof Tri.buildTriView !== 'function') return

    state.drillId = sessionId
    // Swap the table for the detail view. Breadcrumb reappears; back
    // button restores.
    els.tableWrap.hidden = true
    els.breadcrumb.hidden = false
    els.breadcrumbTitle.textContent = name || sessionId
    els.detail.hidden = false
    els.detail.innerHTML = ''

    const events = (typeof Chat.getEventsForSession === 'function')
      ? Chat.getEventsForSession(sessionId)
      : []
    const records = (typeof Tri.sessionTraceRecords === 'function')
      ? Tri.sessionTraceRecords(events)
      : []
    // Field §3 P0 #5 (2026-07-17): pick the session's header off __dshChat
    // so the tri-view's detail pane can surface cwd in the Runtime group.
    // Header missing → detail pane treats cwd as absent.
    let sessionHeader = null
    if (typeof Chat.getSessions === 'function') {
      const rows = Chat.getSessions()
      const row = Array.isArray(rows) ? rows.find(r => r && r.sessionId === sessionId) : null
      sessionHeader = row && row.header ? row.header : null
    }
    const tri = Tri.buildTriView(document, {
      // treeEl intentionally omitted — the tri-view falls through to a
      // "per-turn" stub, which is the correct shape at session scope
      // (the tree card belongs to a single turn's footer drawer).
      records,
      scope: 'session',
      // Timeline is the useful default at session scope — it gives the
      // researcher a Gantt read of every step in the run, which is the
      // primary reason to open a session from the project table.
      defaultView: 'timeline',
      sessionId,
      sessionHeader,
      onSeqClick: function (seq) {
        // Deep-link stays best-effort. The Chat pane is offscreen while
        // the tracing tab is active, so the click primarily updates the
        // tri-view's own detail slot (openDetailForSeq does that inline).
        if (typeof window.__dshDeepLinkToSeq === 'function') {
          try { window.__dshDeepLinkToSeq(seq) } catch (_) {}
        }
      },
    })
    els.detail.appendChild(tri)
  }

  function closeDrill () {
    if (!els) return
    state.drillId = null
    els.detail.hidden = true
    els.detail.innerHTML = ''
    els.breadcrumb.hidden = true
    els.breadcrumbTitle.textContent = ''
    els.tableWrap.hidden = false
  }

  // ─── public: switchTo hook fires this on tab entry ────────────────────

  function show () {
    const pane = mount()
    if (!pane) return
    if (!state.columnPrefs) state.columnPrefs = loadPrefs()
    // Restore the query into the input on tab re-entry so the visible
    // filter and the internal state agree.
    if (els.search) els.search.value = state.query || ''
    // Fresh row projection every show(): the sidebar's session list may
    // have grown and any live turn on the currently-focused session
    // ticks cachedEvents forward.
    state.allRows = projectAllRows()
    // If we're mid-drill on a session that no longer exists (rare —
    // daemon dropped it), bail back to the table.
    if (state.drillId && !state.allRows.some((r) => r.id === state.drillId)) {
      closeDrill()
    }
    if (state.drillId) {
      // Already drilled — keep the tri-view visible; refresh the
      // breadcrumb title in case the session title changed.
      const row = state.allRows.find((r) => r.id === state.drillId)
      if (row) els.breadcrumbTitle.textContent = row.name || row.id
    } else {
      renderTable()
      // lazy hydrate rows whose
      // `cachedEvents` is empty. After a runtime restart every session
      // starts blank (renderer.js `onInitialized` wipes state.sessions);
      // the sidebar shows rows but every Tracing metric projects to '—'
      // because there's nothing to aggregate. Kick a background fetch
      // per empty row, re-project + re-render when any of them lands.
      void hydrateEmptyRows()
    }
  }

  // F-2 hydrate helper — see show(). Walks state.allRows serially so
  // pressure on the daemon stays predictable (each hydrate itself paginates
  // the 50-event window walk in __dshChat.hydrateSessionEvents). Coalesced
  // re-render fires every 150ms while backfills land, so a 24-session
  // sidebar repaints a handful of times, not 24. Silently no-ops when the
  // seam isn't installed (loadRenderer harness in tests).
  let hydrateRenderPending = false
  function scheduleRerender () {
    if (hydrateRenderPending) return
    hydrateRenderPending = true
    setTimeout(function () {
      hydrateRenderPending = false
      if (state.drillId) return  // user drilled while we were hydrating
      state.allRows = projectAllRows()
      renderTable()
    }, 150)
  }
  async function hydrateEmptyRows () {
    const Chat = window.__dshChat
    if (!Chat || typeof Chat.hydrateSessionEvents !== 'function') return
    // Snapshot the ids at entry so a mid-hydrate refresh (turn/end on
    // another session) can't reorder the loop's target set. "All metrics
    // null" is the sentinel for an unhydrated row: mostRecentTime is
    // allowed to be non-null (from session/list's lastEventTime), but the
    // core aggregate columns (traceCount, totalTokens) both being null
    // means we have no cached events to project over.
    const ids = state.allRows
      .filter(function (r) {
        return r && r.traceCount === null && r.totalTokens === null
      })
      .map(function (r) { return r.id })
    for (const id of ids) {
      try { await Chat.hydrateSessionEvents(id) }
      catch (_) { /* keep walking — one bad session doesn't sink the sweep */ }
      scheduleRerender()
    }
  }

  // expose `openDrill` so the empty-state
  // "See a full trace" flow (renderer.js) can auto-land the user inside the
  // tri-view instead of on the index. Auto-drill only fires when the caller
  // has a valid sessionId; the internal path already handles refresh + rehydrate.
  window.__dshTracingPage = { show, closeDrill, openDrill }

  // Runtime → Rubric grid cell click dispatches `dsh:rubric-cell-jump`. The
  // upstream fires with { sessionId, turnId } detail and calls __dshTabs to
  // switch, but drops the ids. Wire the drill here so clicking a cell
  // actually lands the user inside that session's trace — the whole value
  // prop of the grid.
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('dsh:rubric-cell-jump', function (ev) {
      const detail = ev && ev.detail
      if (!detail || !detail.sessionId) return
      try { openDrill(detail.sessionId) } catch (_) { /* drill unavailable — swallow */ }
    })
  }
})()
