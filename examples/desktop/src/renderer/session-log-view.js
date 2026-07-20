// session-log-view.js — lane-p1-tabs.
//
// The Chat pane's Log tab: a full-HISTORY event log for the ACTIVE session,
// distinct from the global devtools ring buffer (500-entry, cross-session).
// It replays the session's complete event stream through
// `window.dsh.sessionEvents(sessionId)` — the same paginated window walk
// renderer.js uses for chat replay — then merges live events arriving while
// the tab is open so the log tails in real time.
//
// UI grammar is borrowed from devtools-panel.js so the two logs feel like
// one family:
//   - type-filter chips (one per distinct event type in the log)
//   - a text search box (matches type / seq / pretty JSON)
//   - each row is `seq · type · summary`, expandable to a payload preview,
//     with a `{ }` badge that opens window.__dshInspector anchored to that
//     event.
//
// Filtering reuses DevtoolsModel.filterEntries (pure, unit-tested) so the
// AND-composition of chips + search matches the devtools panel exactly. The
// entry shape ({ id, seq, type, time, event }) mirrors DevtoolsModel's
// normalizeEntry so the shared filter works verbatim.
//
// Large sessions: the log renders lazily. It holds the full entry list in
// memory (bounded by whatever the daemon window-walk returned) but only
// paints `PAGE` rows at a time, with a "Load more" affordance that reveals
// the next page by seq. This keeps first paint cheap on a 5k-event session
// without a virtual scroller.
//
// Pure helpers (normalizeLogEntry / mergeLiveEntry / distinctTypes /
// pageSlice) run under node --test with no DOM; the controller (mount /
// renderInto / open) needs a document.

'use strict'

;(function () {
  // Rows painted per page. A session with thousands of events still first-
  // paints one page; "Load more" reveals the next PAGE by ascending seq.
  const PAGE = 200

  // ─── pure helpers ──────────────────────────────────────────────────────

  // Normalize a raw wire event into the entry shape the filter + row
  // renderer consume. Mirrors DevtoolsModel.normalizeEntry's field set
  // ({ id, time, sessionId, type, seq, event }) so DevtoolsModel.filterEntries
  // works on our entries unchanged. `id` here is the seq when present (stable
  // across re-render and dedup) falling back to a monotonic counter the
  // caller supplies.
  function normalizeLogEntry(event, fallbackId) {
    const ev = (event && typeof event === 'object') ? event : {}
    const type = (typeof ev.type === 'string' && ev.type) ? ev.type : '(unknown)'
    const seq = Number.isFinite(ev.seq) ? ev.seq : null
    const time = Number.isFinite(ev.time) ? ev.time : null
    const id = seq !== null ? seq : fallbackId
    return { id, seq, type, time, sessionId: '', event: ev }
  }

  // Merge a live entry into an existing (seq-sorted) list, deduping by seq.
  // An event with no seq always appends (can't dedup a seq-less event). An
  // event whose seq already exists replaces the prior copy in place (the
  // daemon may re-emit a fuller payload for the same seq during a live turn).
  // Returns the same array reference for caller convenience.
  function mergeLiveEntry(entries, entry) {
    if (!Array.isArray(entries) || !entry) return entries || []
    if (entry.seq === null || entry.seq === undefined) {
      entries.push(entry)
      return entries
    }
    for (let i = 0; i < entries.length; i++) {
      if (entries[i] && entries[i].seq === entry.seq) {
        entries[i] = entry
        return entries
      }
    }
    // Insert keeping ascending-seq order. Most live events land at the tail,
    // so scan from the end.
    let i = entries.length - 1
    while (i >= 0 && entries[i] && Number.isFinite(entries[i].seq) && entries[i].seq > entry.seq) i--
    entries.splice(i + 1, 0, entry)
    return entries
  }

  // Distinct event types across the entry list, sorted, for the chip row.
  // Same contract as DevtoolsModel.collectTypes.
  function distinctTypes(entries) {
    const s = new Set()
    for (const e of entries) if (e && e.type) s.add(e.type)
    return Array.from(s).sort()
  }

  // One-line summary for a row. Prefers a human field on the payload
  // (text / content / summary / name / stopReason), falling back to the
  // trace aggregator's trimSummary when loaded, then a bare type echo.
  function summarizeEntry(entry) {
    const ev = entry && entry.event ? entry.event : {}
    const data = (ev.data && typeof ev.data === 'object') ? ev.data : ev
    let raw = ''
    if (typeof data.text === 'string') raw = data.text
    else if (typeof data.content === 'string') raw = data.content
    else if (Array.isArray(data.content)) {
      raw = data.content.map((c) => (c && typeof c.text === 'string') ? c.text : '').join(' ')
    } else if (typeof data.summary === 'string') raw = data.summary
    else if (typeof data.name === 'string') raw = data.name
    else if (typeof data.stopReason === 'string' || typeof data.stop_reason === 'string') {
      raw = data.stopReason || data.stop_reason
    } else if (typeof data.delta === 'string') raw = data.delta
    raw = String(raw || '').replace(/\s+/g, ' ').trim()
    if (!raw) return ''
    return raw.length > 80 ? raw.slice(0, 79) + '…' : raw
  }

  // Slice the filtered list to the first `count` rows (lazy paging). Returns
  // { rows, hasMore, total }. `count` is clamped to at least PAGE.
  function pageSlice(filtered, count) {
    const total = filtered.length
    const shown = Math.min(total, Math.max(PAGE, count || PAGE))
    return { rows: filtered.slice(0, shown), hasMore: shown < total, total, shown }
  }

  // ─── controller (DOM) ────────────────────────────────────────────────────

  // Per-container controller state, keyed off the container element so a
  // remount reuses the same instance.
  const controllers = new WeakMap()

  function makeController(container) {
    const doc = container.ownerDocument
      || (typeof window !== 'undefined' && window.document)
      || (typeof document !== 'undefined' ? document : null)
    const state = {
      sessionId: null,
      entries: [],          // full seq-sorted entry list
      fallbackId: -1,       // decreasing counter for seq-less events
      typeFilter: new Set(),// active chip types; empty = all
      text: '',
      pageCount: PAGE,
      // element handles, built once
      chipsEl: null,
      searchEl: null,
      listEl: null,
      countEl: null,
      moreBtn: null,
    }

    function nextFallbackId() { state.fallbackId -= 1; return state.fallbackId }

    // Build the static shell (search row + chips row + list + footer). Called
    // once; subsequent renders only repaint chips/list.
    function buildShell() {
      container.textContent = ''
      const head = doc.createElement('div')
      head.className = 'session-log-head'

      const search = doc.createElement('input')
      search.type = 'search'
      search.className = 'session-log-search'
      search.placeholder = 'Search type / seq / payload…'
      search.setAttribute('aria-label', 'Search session log')
      search.addEventListener('input', function () {
        state.text = search.value || ''
        state.pageCount = PAGE
        renderList()
      })
      state.searchEl = search

      const count = doc.createElement('span')
      count.className = 'session-log-count muted'
      state.countEl = count

      head.appendChild(search)
      head.appendChild(count)

      const chips = doc.createElement('div')
      chips.className = 'session-log-chips'
      chips.setAttribute('role', 'group')
      chips.setAttribute('aria-label', 'Filter by event type')
      state.chipsEl = chips

      const list = doc.createElement('div')
      list.className = 'session-log-list'
      list.setAttribute('role', 'log')
      state.listEl = list

      const more = doc.createElement('button')
      more.type = 'button'
      more.className = 'session-log-more ghost small'
      more.textContent = 'Load more'
      more.hidden = true
      more.addEventListener('click', function () {
        state.pageCount += PAGE
        renderList()
      })
      state.moreBtn = more

      container.appendChild(head)
      container.appendChild(chips)
      container.appendChild(list)
      container.appendChild(more)
    }

    function toggleType(t) {
      if (state.typeFilter.has(t)) state.typeFilter.delete(t)
      else state.typeFilter.add(t)
      state.pageCount = PAGE
      renderChips()
      renderList()
    }

    function renderChips() {
      if (!state.chipsEl) return
      state.chipsEl.textContent = ''
      const types = distinctTypes(state.entries)
      if (types.length === 0) {
        const empty = doc.createElement('span')
        empty.className = 'session-log-chips-empty muted'
        empty.textContent = 'no events yet'
        state.chipsEl.appendChild(empty)
        return
      }
      for (const t of types) {
        const chip = doc.createElement('button')
        chip.type = 'button'
        chip.className = 'session-log-chip' + (state.typeFilter.has(t) ? ' active' : '')
        chip.dataset.type = t
        chip.textContent = t
        chip.addEventListener('click', function () { toggleType(t) })
        state.chipsEl.appendChild(chip)
      }
    }

    function filtered() {
      const M = (typeof window !== 'undefined' && window.DevtoolsModel) || null
      if (M && typeof M.filterEntries === 'function') {
        return M.filterEntries(state.entries, { types: state.typeFilter, text: state.text })
      }
      // Fallback (module not loaded — lean test env): type set + substring.
      const q = String(state.text || '').trim().toLowerCase()
      const typeSet = state.typeFilter.size > 0 ? state.typeFilter : null
      return state.entries.filter(function (e) {
        if (typeSet && !typeSet.has(e.type)) return false
        if (q) {
          const hay = (String(e.type) + ' ' + String(e.seq) + ' ' + JSON.stringify(e.event || {})).toLowerCase()
          if (!hay.includes(q)) return false
        }
        return true
      })
    }

    function renderList() {
      if (!state.listEl) return
      state.listEl.textContent = ''
      const rows = filtered()
      const { rows: page, hasMore, total, shown } = pageSlice(rows, state.pageCount)
      for (const entry of page) {
        state.listEl.appendChild(buildRow(entry))
      }
      if (state.countEl) {
        state.countEl.textContent = total === state.entries.length
          ? `${total} events`
          : `${total} / ${state.entries.length} events`
      }
      if (state.moreBtn) {
        state.moreBtn.hidden = !hasMore
        state.moreBtn.textContent = hasMore ? `Load more (${total - shown} hidden)` : 'Load more'
      }
      if (page.length === 0) {
        const empty = doc.createElement('div')
        empty.className = 'session-log-empty muted'
        empty.textContent = state.entries.length === 0
          ? 'No events in this session yet.'
          : 'No events match the current filter.'
        state.listEl.appendChild(empty)
      }
    }

    function buildRow(entry) {
      const row = doc.createElement('details')
      row.className = 'session-log-row'
      if (entry.seq !== null && entry.seq !== undefined) row.dataset.seq = String(entry.seq)
      row.dataset.type = entry.type

      const summary = doc.createElement('summary')
      summary.className = 'session-log-row-summary'

      const seqEl = doc.createElement('span')
      seqEl.className = 'session-log-seq mono'
      seqEl.textContent = entry.seq !== null && entry.seq !== undefined ? String(entry.seq) : '—'

      const typeEl = doc.createElement('span')
      typeEl.className = 'session-log-type mono'
      typeEl.textContent = entry.type

      const sumEl = doc.createElement('span')
      sumEl.className = 'session-log-summary'
      sumEl.textContent = summarizeEntry(entry)

      summary.appendChild(seqEl)
      summary.appendChild(typeEl)
      summary.appendChild(sumEl)

      // { } inspector badge — opens the unified inspector anchored to this
      // event. attachInspectBadge resolves the target at click time, so we
      // hand it a closure returning { event }. Falls back to a bare button
      // wired to open() when attachInspectBadge is unavailable.
      const insp = (typeof window !== 'undefined' && window.__dshInspector) || null
      if (insp && typeof insp.attachInspectBadge === 'function') {
        insp.attachInspectBadge(summary, function () {
          return { event: entry.event, tab: 'pretty', title: `seq ${entry.seq} · ${entry.type}` }
        })
      } else if (insp && typeof insp.open === 'function') {
        const badge = doc.createElement('button')
        badge.type = 'button'
        badge.className = 'inspect-badge'
        badge.textContent = '{ }'
        badge.title = 'Inspect · Pretty / Raw / JSON'
        badge.addEventListener('click', function (e) {
          if (e && e.stopPropagation) e.stopPropagation()
          if (e && e.preventDefault) e.preventDefault()
          insp.open({ event: entry.event, tab: 'pretty', title: `seq ${entry.seq} · ${entry.type}` })
        })
        summary.appendChild(badge)
      }

      row.appendChild(summary)

      // Expanded body: a pretty-printed payload preview. Built lazily on
      // first toggle so a filter over thousands of rows doesn't pay the
      // JSON.stringify cost up front.
      const body = doc.createElement('div')
      body.className = 'session-log-row-body'
      let filled = false
      row.addEventListener('toggle', function () {
        if (row.open && !filled) {
          filled = true
          const pre = doc.createElement('pre')
          pre.className = 'session-log-payload mono'
          pre.textContent = formatPayload(entry.event)
          body.appendChild(pre)
        }
      })
      row.appendChild(body)
      return row
    }

    // ─── data lifecycle ─────────────────────────────────────────────────

    // Replay the session's full history through the sessionEvents window
    // walk, then paint. Bounded by the daemon's window cap (same walk as
    // renderer.js replayHistory). `seedEvents` is the in-memory cache the
    // caller already holds (state.sessions[sid].cachedEvents): we paint it
    // immediately so the log isn't blank while the walk runs, and keep
    // whichever source ends up with more entries — mirroring replayHistory's
    // "more events wins" rule so a live-only session (daemon hasn't persisted
    // it yet) still shows its full history.
    async function loadHistory(sessionId, seedEvents) {
      state.fallbackId = -1
      const seed = Array.isArray(seedEvents) ? seedEvents : []
      state.entries = seed.map((ev) => normalizeLogEntry(ev, nextFallbackId()))
      renderChips()
      renderList()
      const bridge = (typeof window !== 'undefined' && window.dsh && window.dsh.sessionEvents)
        ? window.dsh.sessionEvents
        : null
      if (!bridge) return
      let listing
      try { listing = await bridge(sessionId, {}) }
      catch (_) { return }
      if (state.sessionId !== sessionId) return // switched away mid-fetch
      if (!listing || !Array.isArray(listing.events) || listing.events.length === 0) return
      const WINDOW = 50
      const total = listing.events.length
      const maxRounds = Math.ceil(total / WINDOW) + 2
      const collected = []
      const seen = new Set()
      let cursor = listing.events[total - 1].seq
      let rounds = 0
      let progressed = true
      while (cursor >= 0 && rounds < maxRounds && progressed) {
        rounds++
        progressed = false
        let chunk
        try { chunk = await bridge(sessionId, { seq: cursor, before: WINDOW, after: 0 }) }
        catch (_) { break }
        if (state.sessionId !== sessionId) return
        if (!chunk || !Array.isArray(chunk.events) || chunk.events.length === 0) break
        const beforeSize = collected.length
        for (const ev of chunk.events) {
          if (typeof ev.seq !== 'number' || seen.has(ev.seq)) continue
          seen.add(ev.seq)
          collected.push(ev)
        }
        if (collected.length > beforeSize) progressed = true
        if (collected.length >= total) break
        const nextStart = typeof chunk.startSeq === 'number' ? chunk.startSeq : chunk.events[0].seq
        if (nextStart <= 0) break
        const nextCursor = nextStart - 1
        if (nextCursor >= cursor) break
        cursor = nextCursor
      }
      collected.sort((a, b) => (a.seq || 0) - (b.seq || 0))
      // "More events wins" (replayHistory parity): keep the seed when it has
      // at least as many entries as the wire walk, so a live-only session
      // isn't blanked by a daemon that returns nothing. Preserve any live
      // events that merged into the seed while the walk was in flight.
      if (collected.length > state.entries.length) {
        state.entries = collected.map((ev) => normalizeLogEntry(ev, nextFallbackId()))
        renderChips()
        renderList()
      }
    }

    // Point the log at a session: rebuild shell if needed, kick history load.
    // `seedEvents` is the caller's in-memory cache for immediate paint.
    function setSession(sessionId, seedEvents) {
      if (!state.chipsEl) buildShell()
      state.sessionId = sessionId || null
      state.pageCount = PAGE
      if (!sessionId) {
        state.entries = []
        renderChips(); renderList()
        return
      }
      void loadHistory(sessionId, seedEvents)
    }

    // A live event landed for a session. Merge it if it belongs to the
    // session we're showing; ignore otherwise. Repaints coalesced by the
    // caller (renderer.js already rAF-throttles chat surface refreshes).
    function onLiveEvent(sessionId, event) {
      if (!sessionId || sessionId !== state.sessionId) return
      const entry = normalizeLogEntry(event, nextFallbackId())
      mergeLiveEntry(state.entries, entry)
      // A brand-new type means the chip row grew.
      renderChips()
      renderList()
    }

    return { setSession, onLiveEvent, _state: state }
  }

  function formatPayload(event) {
    // Reuse the inspector/devtools JSON formatter when present so the payload
    // preview matches the { } drawer; fall back to a guarded stringify.
    const M = (typeof window !== 'undefined' && window.DevtoolsModel) || null
    if (M && typeof M.formatJSON === 'function') return M.formatJSON(event)
    try { return JSON.stringify(event, null, 2) }
    catch (_) { return String(event) }
  }

  // Get (or lazily create) the controller bound to a container element.
  function controllerFor(container) {
    if (!container) return null
    let c = controllers.get(container)
    if (!c) { c = makeController(container); controllers.set(container, c) }
    return c
  }

  // ─── public API ──────────────────────────────────────────────────────

  // renderSessionLog(container, { sessionId, seedEvents }) — (re)point the
  // Log view at a session. Idempotent per container; a session switch re-runs
  // the history replay. `seedEvents` (the caller's in-memory cache) paints
  // immediately so the log isn't blank while the wire walk runs. Safe to call
  // when sessionId is falsy (renders the empty state).
  function renderSessionLog(container, opts) {
    const c = controllerFor(container)
    if (!c) return
    const o = opts || {}
    c.setSession(o.sessionId || null, o.seedEvents || null)
  }

  // ingestLiveEvent(container, sessionId, event) — merge a live event into an
  // open Log view. No-op when the event is for another session.
  function ingestLiveEvent(container, sessionId, event) {
    const c = controllers.get(container)
    if (!c) return
    c.onLiveEvent(sessionId, event)
  }

  const api = {
    // pure
    normalizeLogEntry, mergeLiveEntry, distinctTypes, summarizeEntry, pageSlice,
    // controller
    renderSessionLog, ingestLiveEvent,
    PAGE,
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (typeof window !== 'undefined') window.__dshSessionLogView = api
})()
