// Renderer-side Devtools panel controller (devtools-panel lane).
//
// Self-contained IIFE that installs its own `window.dsh.onNotify` listener,
// buffers every `session.event`, and renders them into a right-hand drawer
// with type-chip filters + text search + per-entry expandable JSON. Nothing
// in renderer.js is modified beyond the shared notification bus subscription
// (already public); the drawer DOM is appended lazily on first paint.
//
// Design contract:
//   - Drawer is off by default; user toggles via header gear button or ⌥D.
//   - All rendering goes through DOM APIs — no innerHTML from event payloads
//     — matching the same safety edge as widgets.js and tool-cards.js.
//   - Uses the pure model in devtools-model.js for buffering + filtering +
//     formatting so the controller stays a thin DOM/event glue.
//   - Ring buffer is 500 entries; when full, the oldest drops silently.
//
// See docs/capability-ui-coverage.md P2-1 for the audit row that motivated
// this ("full request header / hook trail invisible in the current shell").
//
// User-facing framing: this is the audit view. Every event the runtime
// shipped over the wire lands here — the panel is the visible embodiment of
// the "model-visible ⟺ logged" contract.

'use strict'

;(function () {
  if (typeof globalThis === 'undefined' || !globalThis.DevtoolsModel) {
    console.warn('[devtools] DevtoolsModel helper missing; controller inert')
    return
  }
  const M = globalThis.DevtoolsModel

  // Per-controller state. The buffer is shared across all sessions — the
  // Devtools view is intentionally global (a session-scoped filter is
  // available via the text search box).
  const buffer = M.createBuffer(M.DEFAULT_CAP)
  const state = {
    preset: 'All',
    typeFilter: new Set(), // empty = no restriction
    surfaceFilter: new Set(), // empty = no restriction
    text: '',
    open: false,
    expanded: new Set(), // entry ids currently expanded (survive re-render)
    autoscroll: true,
  }

  // Lazy DOM refs, resolved by ensureMounted().
  const dom = {
    drawer: null,
    toggleBtn: null,
    listEl: null,
    chipsEl: null,
    searchEl: null,
    presetsEl: null,
    surfacesEl: null,
    countEl: null,
    clearBtn: null,
    autoscrollEl: null,
  }

  // -- mount -----------------------------------------------------------------

  function ensureMounted() {
    if (dom.drawer) return
    installToggleButton()
    installDrawer()
    installKeybinding()
  }

  /** Header gear button — lives next to the mock buttons in the chat pane. */
  function installToggleButton() {
    const debugBar = document.querySelector('.pane[data-pane="chat"] .header .debug')
    if (!debugBar) return
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.id = 'devtools-toggle'
    btn.className = 'ghost devtools-toggle'
    btn.title = 'Toggle Devtools panel (⌥D)'
    btn.textContent = 'devtools'
    btn.addEventListener('click', () => toggle())
    debugBar.appendChild(btn)
    dom.toggleBtn = btn
  }

  /** Right-anchored drawer. Sibling of `.app` so it can slide over content. */
  function installDrawer() {
    const drawer = document.createElement('aside')
    drawer.className = 'devtools-drawer'
    drawer.setAttribute('aria-label', 'Devtools event log')
    drawer.hidden = true

    // Header: title + close + count.
    const head = document.createElement('div')
    head.className = 'devtools-head'
    const title = document.createElement('div')
    title.className = 'devtools-title'
    title.textContent = 'Devtools · event log'
    const count = document.createElement('div')
    count.className = 'devtools-count muted'
    count.textContent = ''
    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'ghost devtools-close'
    closeBtn.title = 'Close (⌥D)'
    closeBtn.textContent = '×'
    closeBtn.addEventListener('click', () => hide())
    // "Full trace" button opens the session-scope tri-view
    // (Tree / Timeline / Graph over every step in the buffer). Sits
    // between the count and the close button so it's the last obvious
    // affordance before you dismiss the drawer.
    const fullTraceBtn = document.createElement('button')
    fullTraceBtn.type = 'button'
    fullTraceBtn.className = 'ghost small devtools-full-trace-btn'
    fullTraceBtn.textContent = 'Full trace'
    fullTraceBtn.title = 'Open the tri-view over the whole session (Tree / Timeline / Graph)'
    fullTraceBtn.addEventListener('click', () => openFullTraceOverlay())
    head.append(title, count, fullTraceBtn, closeBtn)
    dom.countEl = count

    // Preset row: audit-view chips.
    const presets = document.createElement('div')
    presets.className = 'devtools-presets'
    for (const name of Object.keys(M.PRESETS)) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'devtools-preset' + (name === state.preset ? ' active' : '')
      b.dataset.preset = name
      b.textContent = name
      b.addEventListener('click', () => setPreset(name))
      presets.appendChild(b)
    }
    dom.presetsEl = presets

    // Surface-filter row. Three chips — current / shadowed /
    // log-only — mirror the three-way partition every event lands in. Clicking
    // a chip toggles its inclusion; empty selection = no restriction. Badge
    // counts get refreshed each render via renderSurfaces().
    const surfaces = document.createElement('div')
    surfaces.className = 'devtools-surfaces'
    const surfLabel = document.createElement('span')
    surfLabel.className = 'devtools-surfaces-label muted small'
    surfLabel.textContent = 'surface'
    surfaces.appendChild(surfLabel)
    for (const s of M.SURFACES) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'devtools-surface devtools-surface-' + surfaceSlug(s)
      b.dataset.surface = s
      b.title = surfaceTitle(s)
      const label = document.createElement('span')
      label.className = 'devtools-surface-label'
      label.textContent = s
      const badge = document.createElement('span')
      badge.className = 'devtools-surface-badge'
      badge.textContent = '0'
      b.append(label, badge)
      b.addEventListener('click', () => toggleSurface(s))
      surfaces.appendChild(b)
    }
    dom.surfacesEl = surfaces

    // Search row.
    const searchRow = document.createElement('div')
    searchRow.className = 'devtools-search-row'
    const search = document.createElement('input')
    search.type = 'text'
    search.className = 'devtools-search'
    search.placeholder = 'Search type / session / payload…'
    search.addEventListener('input', () => {
      state.text = search.value
      rerender()
    })
    const clearBtn = document.createElement('button')
    clearBtn.type = 'button'
    clearBtn.className = 'ghost devtools-clear'
    clearBtn.textContent = 'clear log'
    clearBtn.title = 'Empty the ring buffer.'
    clearBtn.addEventListener('click', () => {
      M.clearBuffer(buffer)
      state.expanded.clear()
      rerender()
    })
    const autoscrollLabel = document.createElement('label')
    autoscrollLabel.className = 'devtools-autoscroll'
    autoscrollLabel.title = 'Follow the tail as new events arrive.'
    const autoscrollInput = document.createElement('input')
    autoscrollInput.type = 'checkbox'
    autoscrollInput.checked = state.autoscroll
    autoscrollInput.addEventListener('change', () => {
      state.autoscroll = autoscrollInput.checked
    })
    autoscrollLabel.append(autoscrollInput, document.createTextNode(' auto-scroll'))
    searchRow.append(search, clearBtn, autoscrollLabel)
    dom.searchEl = search
    dom.clearBtn = clearBtn
    dom.autoscrollEl = autoscrollInput

    // Type-chip row (populated at render time from the buffer).
    const chips = document.createElement('div')
    chips.className = 'devtools-chips'
    dom.chipsEl = chips

    // List.
    const list = document.createElement('div')
    list.className = 'devtools-list'
    dom.listEl = list

    drawer.append(head, presets, surfaces, searchRow, chips, list)
    document.body.appendChild(drawer)
    dom.drawer = drawer
  }

  /** ⌥D toggles the drawer. Case-insensitive on the physical key. */
  function installKeybinding() {
    document.addEventListener('keydown', (ev) => {
      if (!ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return
      const k = (ev.key || '').toLowerCase()
      if (k === 'd' || k === '∂') { // macOS: Alt+D → ∂ when unshifted
        ev.preventDefault()
        toggle()
      }
    })
  }

  // -- open / close ----------------------------------------------------------

  function show() {
    ensureMounted()
    if (!dom.drawer) return
    state.open = true
    dom.drawer.hidden = false
    document.body.classList.add('devtools-open')
    if (dom.toggleBtn) dom.toggleBtn.classList.add('active')
    rerender()
  }
  function hide() {
    state.open = false
    if (dom.drawer) dom.drawer.hidden = true
    document.body.classList.remove('devtools-open')
    if (dom.toggleBtn) dom.toggleBtn.classList.remove('active')
  }
  function toggle() { state.open ? hide() : show() }

  // --: full-session trace overlay -------------------------------
  //
  // The devtools drawer is our natural session-scope entry: it already
  // holds every event the runtime shipped. When the user clicks "Full
  // trace" we aggregate the buffer into step-records for the current
  // session and open a lightweight overlay carrying the tri-view (Tree
  // stub / Timeline / Graph). The overlay is a plain <dialog>-style
  // element — no framework, no scrim library — so it composes with the
  // existing drawer without race conditions.

  function openFullTraceOverlay() {
    const tri = (typeof window !== 'undefined' && window.__dshTraceTriView) || null
    if (!tri) return
    const events = []
    let sessionId = ''
    for (const e of buffer.entries) {
      if (!sessionId && e.sessionId) sessionId = e.sessionId
      if (!sessionId || e.sessionId === sessionId) {
        if (e.event) events.push(e.event)
      }
    }
    const records = tri.sessionTraceRecords(events)
    const overlay = document.createElement('div')
    overlay.className = 'devtools-full-trace-overlay'
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-label', 'Full session trace')
    const scrim = document.createElement('div')
    scrim.className = 'devtools-full-trace-scrim'
    scrim.addEventListener('click', function () { closeOverlay(overlay) })
    const card = document.createElement('div')
    card.className = 'devtools-full-trace-card'
    const head = document.createElement('div')
    head.className = 'devtools-full-trace-head'
    const title = document.createElement('div')
    title.className = 'devtools-full-trace-title'
    title.textContent = `Full trace · ${records.length} step${records.length === 1 ? '' : 's'}`
    if (sessionId) title.title = `session ${sessionId}`
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'ghost small'
    close.textContent = 'Close'
    close.addEventListener('click', function () { closeOverlay(overlay) })
    head.append(title, close)
    card.appendChild(head)
    const view = tri.buildTriView(document, {
      records,
      scope: 'session',
      defaultView: records.length > 0 ? 'timeline' : 'tree',
      onSeqClick: function (seq) {
        // Deep-link back to the stream even from session scope; the
        // overlay stays open so the reader can compare.
        if (typeof window !== 'undefined' && typeof window.__dshDeepLinkToSeq === 'function') {
          window.__dshDeepLinkToSeq(seq)
        }
      },
    })
    card.appendChild(view)
    overlay.append(scrim, card)
    document.body.appendChild(overlay)
    document.addEventListener('keydown', overlayEsc)

    function overlayEsc(ev) {
      if (ev && ev.key === 'Escape') { closeOverlay(overlay); document.removeEventListener('keydown', overlayEsc) }
    }
  }

  function closeOverlay(overlay) {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay)
  }

  // -- filters ---------------------------------------------------------------

  function setPreset(name) {
    state.preset = M.PRESETS[name] ? name : 'All'
    // Preset selection is orthogonal to the type-chip set — a user can pick
    // "Approvals" and then also toggle chips to narrow further; clearing the
    // chip filter is the "reset" affordance.
    if (dom.presetsEl) {
      for (const btn of dom.presetsEl.querySelectorAll('.devtools-preset')) {
        btn.classList.toggle('active', btn.dataset.preset === state.preset)
      }
    }
    rerender()
  }

  function toggleType(type) {
    if (state.typeFilter.has(type)) state.typeFilter.delete(type)
    else state.typeFilter.add(type)
    rerender()
  }

  function toggleSurface(name) {
    if (!M.SURFACES.includes(name)) return
    if (state.surfaceFilter.has(name)) state.surfaceFilter.delete(name)
    else state.surfaceFilter.add(name)
    rerender()
  }

  function surfaceSlug(s) { return s === 'log-only' ? 'log-only' : s }
  function surfaceTitle(s) {
    if (s === 'current') return 'Events still on the chat surface (default view).'
    if (s === 'shadowed') return 'Events replaced by a compact summary — still in the log, no longer on the chat surface.'
    return 'Events that never rendered on the chat surface (hooks, approvals, request headers, sandbox mode, step bookkeeping, code dispatch).'
  }

  // -- render ---------------------------------------------------------------

  function rerender() {
    if (!state.open || !dom.drawer) return
    const all = M.getAll(buffer)
    const shadowedSeqs = M.buildShadowedSet(all)
    renderChips(all)
    renderSurfaces(all, shadowedSeqs)
    renderList(all, shadowedSeqs)
    renderCount(all, shadowedSeqs)
  }

  function renderCount(all, shadowedSeqs) {
    if (!dom.countEl) return
    const filtered = M.filterEntries(all, {
      preset: state.preset,
      types: state.typeFilter,
      surfaces: state.surfaceFilter,
      shadowedSeqs,
      text: state.text,
    })
    const cap = buffer.cap
    dom.countEl.textContent = `${filtered.length} / ${all.length} (cap ${cap})`
  }

  function renderSurfaces(all, shadowedSeqs) {
    if (!dom.surfacesEl) return
    const counts = M.countsBySurface(all, shadowedSeqs)
    for (const btn of dom.surfacesEl.querySelectorAll('.devtools-surface')) {
      const name = btn.dataset.surface
      btn.classList.toggle('active', state.surfaceFilter.has(name))
      const badge = btn.querySelector('.devtools-surface-badge')
      if (badge) badge.textContent = String(counts[name] || 0)
    }
  }

  function renderChips(all) {
    if (!dom.chipsEl) return
    const types = M.collectTypes(all)
    dom.chipsEl.innerHTML = ''
    if (types.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'devtools-chips-empty muted'
      empty.textContent = 'no events buffered yet'
      dom.chipsEl.appendChild(empty)
      return
    }
    for (const t of types) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'devtools-chip' + (state.typeFilter.has(t) ? ' active' : '')
      chip.dataset.type = t
      chip.textContent = t
      chip.addEventListener('click', () => toggleType(t))
      dom.chipsEl.appendChild(chip)
    }
    if (state.typeFilter.size > 0) {
      const reset = document.createElement('button')
      reset.type = 'button'
      reset.className = 'devtools-chip-reset ghost'
      reset.textContent = 'reset types'
      reset.addEventListener('click', () => {
        state.typeFilter.clear()
        rerender()
      })
      dom.chipsEl.appendChild(reset)
    }
  }

  function renderList(all, shadowedSeqs) {
    if (!dom.listEl) return
    const filtered = M.filterEntries(all, {
      preset: state.preset,
      types: state.typeFilter,
      surfaces: state.surfaceFilter,
      shadowedSeqs,
      text: state.text,
    })
    dom.listEl.innerHTML = ''
    if (filtered.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'devtools-list-empty muted'
      empty.textContent = all.length === 0
        ? 'Waiting for events… trigger a turn or a plugin action.'
        : 'No events match the current filter.'
      dom.listEl.appendChild(empty)
      return
    }
    for (const e of filtered) dom.listEl.appendChild(renderRow(e, shadowedSeqs))
    if (state.autoscroll) {
      dom.listEl.scrollTop = dom.listEl.scrollHeight
    }
  }

  function renderRow(entry, shadowedSeqs) {
    const row = document.createElement('details')
    // Two accents encode two orthogonal things:
    //   - left-border colour = event family (assistant/tool/hook/…), matching
    //     the t159 row grammar in renderer.js so the devtools timeline and the
    //     trace panes read as the same visual language;
    //   - the surface pill (small, in the summary) + the row's background wash
    //     communicate the ticket #128 three-way partition (current/shadowed/
    //     log-only). Chip filters and surface counts drive on the same class.
    const surface = M.deriveSurface(entry.event || entry, shadowedSeqs)
    const family = familyForType(entry.type)
    row.className = 'devtools-row'
      + ' devtools-row-surface-' + surfaceSlug(surface)
      + ' devtools-row-family-' + family
    row.dataset.surface = surface
    row.dataset.family = family
    row.dataset.entryId = String(entry.id)
    if (state.expanded.has(entry.id)) row.open = true
    row.addEventListener('toggle', () => {
      if (row.open) state.expanded.add(entry.id)
      else state.expanded.delete(entry.id)
    })

    // L0 row grammar: glyph column · type · gist
    // ····· surface pill · seq · time · { }-badge.  Everything past the type
    // is right-aligned so the row scans as a mini-waterfall.  No emoji: the
    // glyph is one monochrome typographic character (see glyphForType).
    const summary = document.createElement('summary')
    summary.className = 'devtools-row-summary'
    summary.tabIndex = 0 // rows focusable, Enter=L1

    const glyph = document.createElement('span')
    glyph.className = 'devtools-row-glyph'
    glyph.textContent = glyphForType(entry.type)

    const type = document.createElement('span')
    type.className = 'devtools-row-type ' + classForType(entry.type)
    type.textContent = entry.type

    const sess = document.createElement('span')
    sess.className = 'devtools-row-session muted'
    sess.textContent = entry.sessionId ? entry.sessionId.slice(0, 8) : ''
    sess.title = entry.sessionId || ''

    const seq = document.createElement('span')
    seq.className = 'devtools-row-seq muted'
    seq.textContent = entry.seq != null ? `#${entry.seq}` : ''

    const surfPill = document.createElement('span')
    surfPill.className = 'devtools-row-surface devtools-surface-' + surfaceSlug(surface)
    surfPill.textContent = surface
    surfPill.title = surfaceTitle(surface)

    const time = document.createElement('span')
    time.className = 'devtools-row-time'
    time.textContent = M.formatTime(entry.time)

    // Universal `{ }` badge: opens the tool-cards side
    // drawer with this event's raw JSON — L2 reachable without opening L1.
    const rawBadge = buildRawJsonBadge(entry)

    summary.append(glyph, type, sess, seq, surfPill, time)
    if (rawBadge) summary.appendChild(rawBadge)
    row.appendChild(summary)

    // L2 body: header line with a copy-JSON button, then the pretty-printed
    // wire payload. Mirrors renderer.js renderTraceEventRow's L2 head layout
    // so the two surfaces feel like one system. The header is inside the
    // details body so it only takes space when the row is open.
    const body = document.createElement('div')
    body.className = 'devtools-row-body'
    const l2Head = document.createElement('div')
    l2Head.className = 'devtools-row-l2-head'
    const l2Label = document.createElement('span')
    l2Label.className = 'devtools-row-l2-label muted'
    l2Label.textContent = 'raw event JSON'
    const pre = document.createElement('pre')
    pre.className = 'devtools-row-pre'
    pre.textContent = M.formatJSON(entry.event)
    const copyBtn = document.createElement('button')
    copyBtn.type = 'button'
    copyBtn.className = 'devtools-row-copy'
    copyBtn.textContent = 'copy'
    copyBtn.title = 'Copy raw JSON'
    copyBtn.addEventListener('click', (e) => {
      if (e && e.stopPropagation) e.stopPropagation()
      const text = pre.textContent || ''
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          () => {
            copyBtn.textContent = 'copied'
            setTimeout(() => { copyBtn.textContent = 'copy' }, 900)
          },
          () => {
            copyBtn.textContent = 'err'
            setTimeout(() => { copyBtn.textContent = 'copy' }, 900)
          },
        )
      } else {
        copyBtn.textContent = 'n/a'
        setTimeout(() => { copyBtn.textContent = 'copy' }, 900)
      }
    })
    l2Head.append(l2Label, copyBtn)
    body.append(l2Head, pre)
    row.appendChild(body)
    return row
  }

  /**
   * Universal `{ }` L2 badge —: raw JSON drawer must be
   * reachable in one click without opening L1. Mirrors renderer.js's
   * buildRawJsonBadge so the two surfaces route to the same tool-cards
   * side-drawer with the same visuals. Falls silently to no-op when the
   * tool-cards helper isn't wired (test harness / early boot).
   */
  function buildRawJsonBadge(entry) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'tool-json-badge devtools-row-raw-badge'
    btn.textContent = '{ }'
    btn.title = 'Show raw JSON (this event) in side drawer'
    if (btn.setAttribute) btn.setAttribute('aria-label', 'Show raw JSON for this event')
    btn.addEventListener('click', (e) => {
      if (e && e.stopPropagation) e.stopPropagation()
      if (e && e.preventDefault) e.preventDefault()
      const tc = window.__dshToolCards
      if (tc && typeof tc.openJsonDrawer === 'function') {
        const label = entry.type ? String(entry.type) : 'event'
        tc.openJsonDrawer({ title: label, call: null, result: entry.event })
      }
    })
    return btn
  }

  /**
   * Family bucket for the coloured left-edge — parallels renderer.js's
   * traceEventClass so the devtools row edge and the trace-pane row edge
   * agree on what "assistant" / "tool" / "context" / "hook" / "meta" look
   * like. Anything unmatched falls to 'generic'.
   */
  function familyForType(t) {
    if (typeof t !== 'string') return 'generic'
    if (t === 'assistant/message' || t === 'assistant/chunk' || t === 'assistant/reasoning') return 'assistant'
    if (t === 'tool/call' || t === 'tool/result' || t.startsWith('tool/')) return 'tool'
    if (t === 'user/message' || t === 'context/message' || t === 'steering/message'
        || t === 'compact/summary' || t.startsWith('compact/')) return 'context'
    if (t.startsWith('hook/')) return 'hook'
    if (t.startsWith('approval/') || t.startsWith('permission/')) return 'approval'
    if (t === 'request/header' || t === 'request/header-delta'
        || t === 'step/start' || t === 'step/end'
        || t === 'turn/start' || t === 'turn/end'
        || t.startsWith('step/') || t.startsWith('turn/') || t.startsWith('request/')) return 'meta'
    if (t.startsWith('bash/')) return 'bash'
    return 'generic'
  }

  /**
   * Single monochrome typographic character per event type — matches
   * traceEventGlyph in renderer.js. Fixed 1-char column so rows align
   * regardless of type-string width. No emoji (memory: dsh-product-strategy
   * §UI 视觉禁令).
   */
  function glyphForType(t) {
    if (!t || typeof t !== 'string') return '·'
    if (t === 'assistant/message') return '*'
    if (t === 'assistant/chunk') return '.'
    if (t === 'assistant/reasoning') return '~'
    if (t === 'tool/call') return '>'
    if (t === 'tool/result') return '<'
    if (t === 'user/message') return '@'
    if (t === 'context/message' || t === 'steering/message') return '+'
    if (t.startsWith('compact/')) return '#'
    if (t.startsWith('hook/')) return '!'
    if (t.startsWith('approval/') || t.startsWith('permission/')) return '?'
    if (t === 'request/header' || t === 'request/header-delta') return '='
    if (t.startsWith('step/') || t.startsWith('turn/')) return '|'
    if (t.startsWith('bash/')) return '$'
    if (t.startsWith('tool/')) return '>'
    return '·'
  }

  /**
   * Family class for colour-coding the type label — matches the visual family
   * bands already used by tool cards. Prefix-driven so new event families
   * inherit a reasonable default.
   */
  function classForType(t) {
    if (typeof t !== 'string') return 'devtools-type-generic'
    if (t.startsWith('hook/')) return 'devtools-type-hook'
    if (t.startsWith('approval/')) return 'devtools-type-approval'
    if (t.startsWith('permission/')) return 'devtools-type-approval'
    if (t.startsWith('request/')) return 'devtools-type-request'
    if (t.startsWith('bash/')) return 'devtools-type-bash'
    if (t.startsWith('tool/')) return 'devtools-type-tool'
    if (t.startsWith('assistant/')) return 'devtools-type-assistant'
    if (t.startsWith('turn/') || t.startsWith('step/')) return 'devtools-type-flow'
    if (t.startsWith('compact/')) return 'devtools-type-compact'
    return 'devtools-type-generic'
  }

  // -- dispatch --------------------------------------------------------------

  function handleNotify(payload) {
    if (!payload || typeof payload !== 'object') return
    const { method, params } = payload
    if (method !== 'session.event') return
    const sessionId = params && params.sessionId
    const event = params && params.event
    if (!event) return
    M.addEvent(buffer, { sessionId, event })
    // Skip re-render when the drawer is closed — the buffer keeps growing
    // silently so opening later shows the full log.
    if (state.open) rerender()
  }

  function wire() {
    ensureMounted()
    if (!window.dsh || typeof window.dsh.onNotify !== 'function') {
      console.warn('[devtools] window.dsh.onNotify unavailable; controller inert')
      return
    }
    window.dsh.onNotify(handleNotify)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire)
  } else {
    wire()
  }

  // Public seams for mocks, tests, and future integration.
  globalThis.DevtoolsPanel = Object.freeze({
    _buffer: buffer,
    _state: state,
    _handleNotify: handleNotify,
    show, hide, toggle,
    rerender,
  })
})()
