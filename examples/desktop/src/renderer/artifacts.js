// Renderer-side artifact card: inline entry point in the chat stream that
// opens the artifact in the system browser. Deliberately not a webview —
// the demo shell only hosts the entry point per the RFC (2026-07-13
// §Deliberate exclusions, "No embedded GUI pane").
//
// Density-spec §2 L0 shape (user-flagged 2026-07-18): each artifact
// renders as a single ~28px row — small icon + filename + kind/version
// chips + live dot + tiny right-aligned `open ↗` link. Clicking the row
// toggles a native <details> L1 body that carries the full path and the
// ghost "Open in browser" button. Consecutive .artifact-card siblings
// render as a visual group (shared border, zero gap between rows) via
// CSS `:has()`.
//
// V2 (lane-artifact-v2, 2026-07-19): the group container grew a top
// tab-bar (List / Board / Timeline) so the same artifact stream can be
// viewed three ways without leaving the chat. Clicking the L0
// `.artifact-version` chip on any List row expands an inline evolution
// chain (chain rendered by artifacts-board.js). History is kept per
// artifactId as versions arrive; blob content is captured when supplied
// by the event so the fixture demo can render real per-hop diffs — for
// the real runtime the pre-latest blobs aren't preserved, so the diff
// panes show an honest "content not preserved" note there.
//
// Two triggers:
//   1. tool/result carrying a file write inside the artifact dir
//      (detected by main.js and re-broadcast as `artifact:event`).
//   2. debug menu "mock: artifact" button (window.dsh.mockArtifact).
//
// De-dup: one card per artifactId per stream. If a re-declare fires the
// existing card bumps its version + flashes.

'use strict'

;(function () {
  const streamEl = () => document.getElementById('stream')

  // Session-scoped state. Both `cards` (artifactId -> DOM element) and
  // `history` (artifactId -> [{ version, seenAt, kind, path, blob? }, …])
  // used to be module-level singletons, which meant switching from
  // session A (three versions of foo.md) to session B (a fresh foo.md)
  // and back showed the B versions inside A's Board/Timeline. Bucketing
  // by sessionId isolates each session's stream while keeping the
  // per-session state addressable when the user tabs back to A.
  //
  // Sentinel `__default__` receives artifact events that arrive before
  // any session id is known (typical for early boot / debug fixture
  // buttons). Once a real sessionId flows in, that bucket is orphaned;
  // it never leaks across real sessions.
  const DEFAULT_SESSION = '__default__'
  const bySession = new Map() // sessionId -> { cards, history, panelEl, currentView }
  let activeSessionId = DEFAULT_SESSION

  function ensureBucket(sid) {
    let b = bySession.get(sid)
    if (!b) {
      b = { cards: new Map(), history: new Map(), panelEl: null, currentView: 'list' }
      bySession.set(sid, b)
    }
    return b
  }
  function bucket() { return ensureBucket(activeSessionId) }
  // Accessors kept so the rest of the file reads naturally.
  const cards = { get: (id) => bucket().cards.get(id), set: (id, v) => bucket().cards.set(id, v) }
  const history = {
    get: (id) => bucket().history.get(id),
    set: (id, v) => bucket().history.set(id, v),
    entries: () => bucket().history.entries(),
    clear: () => bucket().history.clear(),
  }
  function setActiveSession(sid) {
    const next = typeof sid === 'string' && sid ? sid : DEFAULT_SESSION
    if (next === activeSessionId) return
    activeSessionId = next
    // Ensure the incoming session's bucket exists so subsequent event/
    // switchView calls don't race on an unset entry.
    ensureBucket(next)
  }

  // Kind-to-SVG map — inline stroke icons (currentColor, 1.6px stroke)
  // so artifact rows match the minimalist icon language rather than
  // sitting on emoji glyphs. Fallback is the paperclip glyph used
  // elsewhere for context-family cards.
  const ICON_SVG = {
    html:
      '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">'
      + '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" '
      + 'd="M11 3H5.5A1.5 1.5 0 0 0 4 4.5v11A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5V8zM11 3v4a1 1 0 0 0 1 1h4"/>'
      + '</svg>',
    svg:
      '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">'
      + '<rect x="3" y="4" width="14" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/>'
      + '<circle cx="7" cy="8" r="1.4" fill="none" stroke="currentColor" stroke-width="1.4"/>'
      + '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M4 14l4-4 3 3 3-3 3 3"/>'
      + '</svg>',
    md:
      '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">'
      + '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" '
      + 'd="M11 3H5.5A1.5 1.5 0 0 0 4 4.5v11A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5V8zM11 3v4a1 1 0 0 0 1 1h4M7 11h6M7 13h4"/>'
      + '</svg>',
  }
  const ICON_FALLBACK =
    '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">'
    + '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" '
    + 'd="M14.5 8.5 8 15a3 3 0 0 1-4.2-4.2l7-7a2 2 0 0 1 2.8 2.8L7.5 12.5a1 1 0 0 1-1.4-1.4L12 5.5"/>'
    + '</svg>'

  function scrollToBottom() {
    const s = streamEl()
    if (s) s.scrollTop = s.scrollHeight
  }

  function recordHistory(entry) {
    const id = entry.artifactId
    const version = entry.version || 1
    const rec = {
      artifactId: id,
      version,
      seenAt: entry.seenAt || Date.now(),
      kind: entry.kind,
      path: entry.path,
    }
    // Fixture / server-side blob capture. The real ArtifactServer does
    // not include content in its `artifact:event` payload; the fixture
    // does. When present we retain it so the evolution diff panes can
    // render real per-hop line diffs.
    if (typeof entry.blob === 'string') rec.blob = entry.blob
    const arr = history.get(id) || []
    // De-dup on version — a re-broadcast of the same version shouldn't
    // double-count in the timeline. Latest wins for the seenAt/blob
    // fields so a corrected blob overwrites the placeholder.
    const idx = arr.findIndex((r) => r.version === version)
    if (idx >= 0) arr[idx] = { ...arr[idx], ...rec }
    else arr.push(rec)
    history.set(id, arr)
  }

  function ensureCard(entry) {
    recordHistory(entry)
    const existing = cards.get(entry.artifactId)
    if (existing) {
      updateCard(existing, entry)
      // If the evolution strip for this card is expanded, refresh it so
      // the new version appears in the chain without a manual re-click.
      refreshEvolutionIfOpen(existing, entry)
      // View-level projections re-render on demand — the Board / Timeline
      // views read live state on switch, so a dropped-in event during
      // those views repaints the panel body.
      if (bucket().currentView !== 'list') refreshView()
      return existing
    }
    const el = renderCard(entry)
    cards.set(entry.artifactId, el)
    const s = streamEl()
    if (s) appendGrouped(s, el)
    if (bucket().currentView !== 'list') refreshView()
    scrollToBottom()
    return el
  }

  // Fuse consecutive artifact cards into an `.artifact-group` wrapper so
  // the list reads as one clumped block. The stream itself has a 12px
  // flex `gap` that a plain negative margin can't undo; the wrapper owns
  // its own zero-gap layout so grouped rows sit flush.
  //
  // V2 note: the group itself lives inside `.artifact-panel` — a single
  // container above the stream position where the first artifact would
  // land, hosting the List/Board/Timeline tab bar. All subsequent
  // artifacts append into the same group so the tab-bar covers one
  // coherent event stream per session.
  function appendGrouped(stream, el) {
    // First artifact of the session: build the panel + tab bar and
    // append it to the stream. The panel owns a `.artifact-group` in
    // its body which the List view uses as-is.
    const b = bucket()
    if (!b.panelEl || !b.panelEl.isConnected) {
      b.panelEl = buildPanel()
      stream.appendChild(b.panelEl)
    }
    // Remove the cold-clone empty-state hint (if present) once we have
    // a real artifact to show. Introduced by lane-usability-fix so
    // seedBoardFixture's placeholder gets swept when a real artifact
    // event arrives.
    const emptyHint = b.panelEl.querySelector('[data-role="empty-state"]')
    if (emptyHint && emptyHint.parentNode) emptyHint.parentNode.removeChild(emptyHint)
    const groupHost = b.panelEl.querySelector('.artifact-group')
    groupHost.appendChild(el)
  }

  function buildPanel() {
    const panel = document.createElement('div')
    panel.className = 'artifact-panel'
    panel.dataset.view = 'list'

    const tabBar = document.createElement('div')
    tabBar.className = 'artifact-panel-tabs'
    tabBar.setAttribute('role', 'tablist')
    for (const v of ['list', 'board', 'timeline']) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'artifact-panel-tab'
      btn.dataset.view = v
      btn.setAttribute('role', 'tab')
      btn.setAttribute('aria-selected', v === 'list' ? 'true' : 'false')
      btn.textContent = v[0].toUpperCase() + v.slice(1)
      btn.addEventListener('click', () => switchView(v))
      tabBar.appendChild(btn)
    }
    panel.appendChild(tabBar)

    const body = document.createElement('div')
    body.className = 'artifact-panel-body'
    // The List view surface — the auto-grouped rows continue to render
    // here directly, so downstream QA that inspects `.artifact-group`
    // keeps working unchanged.
    const group = document.createElement('div')
    group.className = 'artifact-group'
    body.appendChild(group)
    panel.appendChild(body)
    return panel
  }

  function switchView(v) {
    const b = bucket()
    if (v === b.currentView) return
    b.currentView = v
    if (!b.panelEl) return
    b.panelEl.dataset.view = v
    for (const tab of b.panelEl.querySelectorAll('.artifact-panel-tab')) {
      tab.setAttribute('aria-selected', tab.dataset.view === v ? 'true' : 'false')
    }
    refreshView()
  }

  function refreshView() {
    const b = bucket()
    if (!b.panelEl) return
    const body = b.panelEl.querySelector('.artifact-panel-body')
    if (!body) return
    // The List view is stable DOM (the auto-grouped card rows). Board
    // and Timeline are re-rendered from state on every switch — cheap,
    // since the entry count for a demo session is small and this keeps
    // the projection honest as new events arrive.
    const listGroup = body.querySelector('.artifact-group')
    const stale = body.querySelectorAll('.artifact-board, .artifact-timeline')
    for (const s of stale) s.remove()
    if (b.currentView === 'list') {
      if (listGroup) listGroup.hidden = false
      return
    }
    if (listGroup) listGroup.hidden = true

    const entries = collectLatestEntries()
    const board = window.__dshArtifactsBoard
    if (!board) return  // module hasn't loaded yet; safe no-op
    // Adapter so artifacts-board's Timeline sees a Map-shaped `history`
    // (get / entries) even though ours is session-scoped through a
    // bucket. Snapshot the current session's Map so the renderer can't
    // observe writes from a subsequent session switch mid-render.
    const historyMap = b.history
    const view = b.currentView === 'board'
      ? board.renderBoard(entries, { openArtifact: (id) => window.dsh && window.dsh.openArtifact(id) })
      : board.renderTimeline(entries, {
          openArtifact: (id) => window.dsh && window.dsh.openArtifact(id),
          history: historyMap,
        })
    body.appendChild(view)
  }

  // Snapshot the latest-version entry per artifactId — that's what
  // Board tiles show. Timeline reads full history separately.
  function collectLatestEntries() {
    const out = []
    for (const [id, arr] of history.entries()) {
      if (!arr || arr.length === 0) continue
      const latest = arr.reduce((a, b) => (a.version >= b.version ? a : b))
      out.push({
        artifactId: id,
        version: latest.version,
        kind: latest.kind,
        path: latest.path,
        seenAt: latest.seenAt,
        blob: latest.blob,
      })
    }
    return out
  }

  function invokeOpen(entry, actionEl, restoreLabel) {
    if (!actionEl) return
    actionEl.setAttribute('aria-disabled', 'true')
    actionEl.classList.add('is-busy')
    const done = (label) => {
      actionEl.textContent = label
      setTimeout(() => {
        actionEl.textContent = restoreLabel
        actionEl.removeAttribute('aria-disabled')
        actionEl.classList.remove('is-busy')
      }, 1500)
    }
    Promise.resolve()
      .then(() => window.dsh.openArtifact(entry.artifactId))
      .then((r) => {
        if (r && r.ok) done('opened ↗')
        else done('failed')
      })
      .catch((err) => {
        console.error('openArtifact failed', err)
        done('error')
      })
  }

  function renderCard(entry) {
    // <details> is the L0 row shell. `open=false` keeps rows collapsed
    // by default; clicking anywhere on the <summary> toggles the L1
    // body.
    const el = document.createElement('details')
    el.className = 'artifact-card'
    el.dataset.artifactId = entry.artifactId
    el.dataset.version = String(entry.version || 1)

    // ---- L0 summary row -----------------------------------------------
    const summary = document.createElement('summary')
    summary.className = 'artifact-row'

    const iconEl = document.createElement('span')
    iconEl.className = 'artifact-icon'
    iconEl.innerHTML = ICON_SVG[entry.kind] || ICON_FALLBACK

    const nameEl = document.createElement('span')
    nameEl.className = 'artifact-name'
    nameEl.textContent = entry.artifactId
    nameEl.title = entry.path || entry.artifactId

    const kindEl = document.createElement('span')
    kindEl.className = 'artifact-kind'
    kindEl.textContent = entry.kind || 'file'

    // Version chip: promoted from a static span to a <button> in V2 so
    // clicking it opens the inline evolution strip. Preserves the same
    // class name so the row layout / stylesheet locks still hold.
    const verEl = document.createElement('button')
    verEl.type = 'button'
    verEl.className = 'artifact-version'
    verEl.textContent = `v${entry.version || 1}`
    verEl.title = 'View version history'
    verEl.setAttribute('aria-label', `View version history for ${entry.artifactId}`)
    verEl.addEventListener('click', (e) => {
      // Prevent both the <details> toggle and the row default so the
      // chip acts as its own trigger.
      e.preventDefault()
      e.stopPropagation()
      toggleEvolution(el, entry)
    })

    const dotEl = document.createElement('span')
    dotEl.className = 'artifact-live-dot'
    dotEl.title = 'live: SSE reload channel active'

    // Right-side tiny "open ↗" link — density-spec §2: L0 actions are
    // icon/link scale, not primary buttons.
    const openLink = document.createElement('a')
    openLink.className = 'artifact-open-link'
    openLink.href = '#'
    openLink.textContent = 'open ↗'
    openLink.title = 'Open artifact in system browser'
    openLink.setAttribute('role', 'button')
    openLink.setAttribute('aria-label', `Open ${entry.artifactId} in system browser`)
    openLink.addEventListener('click', (e) => {
      // Prevent both the anchor navigation and the <details> toggle so
      // clicking the link opens the browser without expanding the row.
      e.preventDefault()
      e.stopPropagation()
      if (openLink.getAttribute('aria-disabled') === 'true') return
      invokeOpen(entry, openLink, 'open ↗')
    })

    summary.append(iconEl, nameEl, kindEl, verEl, dotEl, openLink)

    // ---- L1 inline body (lazy content, structure is there for a11y) ---
    const body = document.createElement('div')
    body.className = 'artifact-body-l1'
    const pathRow = document.createElement('div')
    pathRow.className = 'artifact-body-path'
    const pathLabel = document.createElement('span')
    pathLabel.className = 'artifact-body-path-label'
    pathLabel.textContent = 'path'
    const pathVal = document.createElement('code')
    pathVal.className = 'artifact-body-path-val'
    pathVal.textContent = entry.path || entry.artifactId
    pathRow.append(pathLabel, pathVal)

    const actionRow = document.createElement('div')
    actionRow.className = 'artifact-body-actions'
    const openBtn = document.createElement('button')
    openBtn.type = 'button'
    openBtn.className = 'artifact-open ghost small'
    openBtn.textContent = 'Open in browser'
    openBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (openBtn.getAttribute('aria-disabled') === 'true') return
      invokeOpen(entry, openBtn, 'Open in browser')
    })
    actionRow.append(openBtn)

    body.append(pathRow, actionRow)

    el.append(summary, body)
    // Kick a fresh-flash so the arrival is noticeable.
    flash(el)
    return el
  }

  // The evolution strip is a sibling under the card root, appended below
  // the L1 body. Toggle: create on first click, remove on second. Sits
  // outside the <details> body deliberately so the version chip acts
  // independently of the row's open/close state — a user can inspect
  // the version chain without expanding the path/actions body.
  //
  // Layout note: the strip is a child of the <details> element in the
  // DOM, and a closed <details> hides all non-<summary> children per
  // the HTML spec (no `display:` override wins against that). So the
  // toggle-on branch also opens the details so the strip actually
  // renders. The path + Open-in-browser row happen to appear too — an
  // acceptable side effect since the user just declared interest in
  // this artifact by clicking its version chip.
  function toggleEvolution(cardEl, entry) {
    const existing = cardEl.querySelector(':scope > .artifact-evolution')
    if (existing) {
      existing.remove()
      cardEl.classList.remove('has-evolution')
      return
    }
    const board = window.__dshArtifactsBoard
    if (!board) return
    const strip = board.renderEvolution(entry, history.get(entry.artifactId) || [])
    cardEl.append(strip)
    cardEl.classList.add('has-evolution')
    cardEl.open = true
  }

  function refreshEvolutionIfOpen(cardEl, entry) {
    const existing = cardEl.querySelector(':scope > .artifact-evolution')
    if (!existing) return
    const board = window.__dshArtifactsBoard
    if (!board) return
    const fresh = board.renderEvolution(entry, history.get(entry.artifactId) || [])
    existing.replaceWith(fresh)
  }

  function updateCard(el, entry) {
    el.dataset.version = String(entry.version || 1)
    const ver = el.querySelector('.artifact-version')
    if (ver) ver.textContent = `v${entry.version || 1}`
    const pathVal = el.querySelector('.artifact-body-path-val')
    if (pathVal && entry.path) pathVal.textContent = entry.path
    flash(el)
  }

  function flash(el) {
    el.classList.add('artifact-flash')
    // Reflow trick so re-adding the class re-triggers the animation for
    // a rapid second update.
    void el.offsetWidth
    setTimeout(() => el.classList.remove('artifact-flash'), 900)
  }

  // Debug menu button — seeds the board/timeline/evolution demo. The
  // real ArtifactServer broadcasts fs writes with no blob content, so
  // cold-clone researchers never see the Board/Timeline/Evolution
  // views' actual affordances. We route the multi-kind, multi-version
  // fixture through the same onArtifactEvent entry the real wire uses
  // so all three tabs light up via the production code path. When the
  // seed is unavailable we fall back to the original IPC single-file
  // mock.
  function bindMockButton() {
    const btn = document.getElementById('mock-artifact')
    if (!btn) return
    btn.addEventListener('click', async () => {
      btn.disabled = true
      try {
        const seed = typeof window !== 'undefined' ? window.__dshArtifactBoardSeed : null
        if (seed && Array.isArray(seed.artifacts) && seed.artifacts.length) {
          seedBoardFixture(seed.artifacts)
        } else if (window.dsh && typeof window.dsh.mockArtifact === 'function') {
          await window.dsh.mockArtifact()
        }
      } catch (err) {
        console.error('mockArtifact / seed failed', err)
      } finally {
        btn.disabled = false
      }
    })
  }

  // Feed the board fixture through the same onArtifactEvent path the
  // real ArtifactServer uses. `seenAt` is re-anchored to "moments ago"
  // so relative-time labels don't read as ~430d against the frozen
  // fixture timestamps. Idempotent: ensureCard() de-dups on artifactId,
  // recordHistory() de-dups on (artifactId, version).
  function seedBoardFixture(list) {
    if (!Array.isArray(list) || !list.length) return
    const base = Date.now() - list.length * 60_000
    list.forEach((raw, i) => {
      onArtifactEvent({ ...raw, seenAt: base + i * 60_000 })
    })
  }

  // Cold-clone empty state: mount the panel scaffold on stream init so
  // researchers can see List/Board/Timeline tabs (and the "no artifacts
  // yet" hint) exist even before the first artifact:event lands. Until
  // now the panel only appeared after the first artifact — new users
  // saw a blank pane and had no idea the surface existed. Scoped to the
  // active session bucket so switching sessions before any artifact
  // fires still gets its own empty panel per session.
  function ensureEmptyPanel() {
    const s = streamEl()
    if (!s) return
    const b = bucket()
    if (b.panelEl && b.panelEl.isConnected) return
    b.panelEl = buildPanel()
    // Inject a muted empty-state hint into the List body. Removed on
    // first appendGrouped() call so real artifacts land in a clean host.
    const body = b.panelEl.querySelector('.artifact-panel-body')
    if (body) {
      const hint = document.createElement('div')
      hint.className = 'artifact-panel-empty muted small'
      hint.dataset.role = 'empty-state'
      hint.textContent = 'No artifacts yet — try “artifact” in the Debug menu, or run a session that writes to .artifacts/.'
      body.appendChild(hint)
    }
    s.appendChild(b.panelEl)
  }

  // Wire up once the DOM + preload bridge are ready. The renderer script
  // tag is loaded after this one, so we just register the listener
  // eagerly.
  if (window.dsh && typeof window.dsh.onArtifact === 'function') {
    window.dsh.onArtifact(onArtifactEvent)
  }
  function initDom() {
    bindMockButton()
    ensureEmptyPanel()
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDom)
  } else {
    initDom()
  }

  // Route artifact events on a session id if the payload carries one.
  // Real ArtifactServer broadcasts include `sessionId` on the entry when
  // the writing turn was scoped to a session; fixture events also stamp
  // it. When missing, we keep writing into the DEFAULT_SESSION bucket
  // (early boot / debug button fixtures).
  function onArtifactEvent(entry) {
    if (!entry || !entry.artifactId) return
    if (typeof entry.sessionId === 'string' && entry.sessionId) {
      setActiveSession(entry.sessionId)
    }
    ensureCard(entry)
  }

  // Expose the small API for the smoke tests + potential renderer-side
  // reuse. `history` and `switchView` join the surface so fixture
  // drivers can inspect state and QA can screenshot each view directly.
  // Session-scoping (P1-4): `setActiveSession(sid)` is called by the
  // renderer's selectSession() to swap buckets on session switch, and
  // exposed to tests that drive multiple sessions.
  window.__dshArtifacts = {
    onArtifactEvent,
    cards,
    history,
    switchView,
    seedBoardFixture,
    ensureEmptyPanel,
    getView: () => bucket().currentView,
    setActiveSession,
    getActiveSessionId: () => activeSessionId,
    // Test hook: raw session bucket map so unit tests can assert
    // isolation without threading fixtures through the DOM.
    _bySession: bySession,
  }
})()
