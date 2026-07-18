// Layout controller: renderer-side glue that wires layout-heuristics.js to
// the DOM. Self-contained IIFE, does not touch renderer.js state or code.
//
// What it owns:
//   - one LayoutHintTracker instance per active session (auto-reset on
//     session change; we detect a session switch by watching for the
//     `session/list` refresh + the current title element's dataset).
//   - a small indicator button injected into `.header` that shows the
//     current layout with a click-to-lock dropdown.
//   - body-class toggling: adds `layout-<hint>` to <body>, removing the
//     other layout classes first. CSS variables in style.css react.
//   - a `dsh:layout-hint` DOM event fired on <body> whenever the hint
//     changes, so other IIFEs (e.g. artifacts.js expanding into a right
//     rail once artifact hint is active) can subscribe without coupling.
//
// It piggybacks on the same window.dsh.onNotify channel renderer.js uses,
// so we don't need any protocol changes.
//
// A manual lock is remembered per session id — flipping to another session
// starts fresh in auto mode. That matches the intuition: "I locked this
// conversation into code-review", not "I locked the whole app".

'use strict'

;(function () {
  if (typeof window === 'undefined' || !window.LayoutHeuristics) return
  const { LayoutHintTracker, LAYOUTS } = window.LayoutHeuristics

  const LAYOUT_LABELS = {
    'chat':        'chat',
    'code-review': 'code review',
    'artifact':    'artifact',
    'monitor':     'monitor',
  }
  // Layout glyphs are inline-SVG paths rather than emoji so they inherit
  // the button's currentColor and match the minimalist-skill icon language
  // (1.6px stroke, no color). `iconSvg(name)` returns the HTML string so
  // callers can inject via innerHTML alongside the label text.
  const LAYOUT_ICON_PATHS = {
    'chat':        'M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v6A1.5 1.5 0 0 1 14.5 13H8l-3 3v-3H5.5A1.5 1.5 0 0 1 4 11.5z',
    'code-review': 'M4 4h9a1 1 0 0 1 1 1v6l3 3v-9a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2zm2 3h6M6 10h6M6 13h4',
    'artifact':    'M10 3a7 7 0 1 0 4.9 12A2 2 0 0 0 13 13h-1a2 2 0 0 1-2-2 2 2 0 0 1 2-2h3a2 2 0 0 0 2-2 5 5 0 0 0-7-4z',
    'monitor':     'M3 5h14v9H3zM3 15h14M7 17h6',
  }
  function iconSvg(name) {
    const d = LAYOUT_ICON_PATHS[name] || 'M4 4h12v12H4z'
    return '<svg viewBox="0 0 20 20" width="12" height="12" aria-hidden="true" '
      + 'style="vertical-align:-2px;margin-right:4px">'
      + `<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="${d}"/>`
      + '</svg>'
  }
  // Small padlock glyph shown on the button when a manual lock is set.
  const LOCK_SVG =
    '<svg viewBox="0 0 20 20" width="10" height="10" aria-hidden="true" '
    + 'style="vertical-align:-1px;margin-left:4px">'
    + '<rect x="5" y="9" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/>'
    + '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M7 9V7a3 3 0 0 1 6 0v2"/>'
    + '</svg>'

  // Per-session tracker so switching sessions doesn't leak signals.
  // Map<sessionId, LayoutHintTracker>
  const trackers = new Map()
  // Map<sessionId, string>  — manual lock persisted per session.
  const lockedHints = new Map()

  let activeSessionId = null
  let indicatorEl = null
  let dropdownEl = null
  let currentBodyClass = null

  function trackerFor(sessionId) {
    let t = trackers.get(sessionId)
    if (!t) {
      t = new LayoutHintTracker()
      const locked = lockedHints.get(sessionId)
      if (locked) t.lock(locked)
      trackers.set(sessionId, t)
    }
    return t
  }

  // -- DOM: indicator + dropdown --------------------------------------------

  function ensureIndicator() {
    if (indicatorEl && document.body.contains(indicatorEl)) return indicatorEl
    const header = document.querySelector('.header')
    if (!header) return null

    const wrap = document.createElement('div')
    wrap.className = 'layout-indicator'
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'layout-indicator-btn ghost'
    btn.title = 'current layout — click to lock/unlock'

    const dd = document.createElement('div')
    dd.className = 'layout-indicator-dropdown'
    dd.hidden = true

    for (const hint of LAYOUTS) {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'layout-indicator-item'
      item.dataset.hint = hint
      item.innerHTML = `${iconSvg(hint)}${LAYOUT_LABELS[hint]}`
      item.addEventListener('click', (e) => {
        e.stopPropagation()
        chooseLayout(hint)
        dd.hidden = true
      })
      dd.appendChild(item)
    }
    const auto = document.createElement('button')
    auto.type = 'button'
    auto.className = 'layout-indicator-item layout-indicator-auto'
    auto.textContent = '↻ auto'
    auto.addEventListener('click', (e) => {
      e.stopPropagation()
      unlockLayout()
      dd.hidden = true
    })
    dd.appendChild(auto)

    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      dd.hidden = !dd.hidden
    })
    document.addEventListener('click', () => { dd.hidden = true })

    wrap.append(btn, dd)
    // Anchor to the right side of the header (after the debug row so
    // nothing needs to shuffle). If .debug exists, sit after it; else
    // append to the header directly.
    const debug = header.querySelector('.debug')
    if (debug && debug.parentNode === header) header.insertBefore(wrap, debug.nextSibling)
    else header.appendChild(wrap)

    indicatorEl = btn
    dropdownEl = dd
    return btn
  }

  function paintIndicator() {
    const btn = ensureIndicator()
    if (!btn) return
    // Falls back to the NO_SESSION tracker so the pre-session pick still
    // shows in the button label and the dropdown's selected-item marker.
    const t = activeSessionId != null ? trackerFor(activeSessionId) : trackerFor(NO_SESSION)
    const hint = t ? t.currentHint() : 'chat'
    const locked = t ? t.isLocked() : false
    btn.innerHTML = `${iconSvg(hint)}${LAYOUT_LABELS[hint] || hint}${locked ? LOCK_SVG : ''}`
    btn.classList.toggle('locked', locked)
    // Also mark the selected item in the dropdown.
    if (dropdownEl) {
      for (const item of dropdownEl.querySelectorAll('.layout-indicator-item')) {
        item.classList.toggle('active', item.dataset.hint === hint)
      }
    }
  }

  // -- body class management -------------------------------------------------

  // Short human-readable "what changes visually" line per bucket. Shown as
  // a transient toast on every switch so the user has immediate confirmation
  // the change took effect — an empty-stream chat is otherwise visually
  // identical between layout-chat and layout-code-review, and issue #2 was
  // "切来切去都没反应" precisely because the tell was invisible until a diff
  // arrived.
  const LAYOUT_TOAST_MSG = {
    'chat':        'Layout: chat — standard 780px column',
    'code-review': 'Layout: code review — wider stream, tool blocks auto-open',
    'artifact':    'Layout: artifact — right rail reserved for previews',
    'monitor':     'Layout: monitor — compact density, smooth-follow tail',
  }
  function showLayoutToast(hint) {
    let toast = document.getElementById('layout-toast')
    if (!toast) {
      toast = document.createElement('div')
      toast.id = 'layout-toast'
      toast.className = 'layout-toast'
      document.body.appendChild(toast)
    }
    toast.textContent = LAYOUT_TOAST_MSG[hint] || `Layout: ${hint}`
    toast.classList.remove('show')
    // Force reflow so the class re-add re-triggers the CSS transition even
    // when the same layout is picked twice in a row.
    void toast.offsetWidth
    toast.classList.add('show')
    clearTimeout(showLayoutToast._t)
    showLayoutToast._t = setTimeout(() => toast.classList.remove('show'), 1600)
  }

  // Insert a small placeholder into the reserved artifact rail so switching
  // into `artifact` has a visible effect even when no artifact card exists
  // yet. Removed on switch back to other layouts so nothing lingers.
  function ensureArtifactRailPlaceholder() {
    const main = document.querySelector('.main')
    if (!main) return
    let slot = document.querySelector('.layout-rail-slot')
    if (currentBodyClass !== 'layout-artifact') {
      if (slot) slot.remove()
      return
    }
    if (!slot) {
      slot = document.createElement('div')
      slot.className = 'layout-rail-slot'
      slot.innerHTML =
        '<div class="layout-rail-empty">' +
        '<div class="layout-rail-title">Artifact rail</div>' +
        '<div class="layout-rail-sub">Files the model writes into<br><code>.artifacts/</code> preview here.</div>' +
        '</div>'
      main.appendChild(slot)
    }
  }

  // the "Layout: chat —
  // standard 780px column" toast used to fire on every applyBodyClass call —
  // boot, session-switch, session.event replay — even when nothing about the
  // layout changed. A first-time user saw a mysterious pill hovering on the
  // fresh window and again after every New session click. Fix:
  //   - `silent: true` suppresses the toast entirely (used by boot()).
  //   - Otherwise, toast only fires when the layout actually CHANGED or the
  //     caller passed `force: true` (a click on the already-active dropdown
  //     item still deserves the feedback that the click landed —
  //     chooseLayout / unlockLayout set force so they retain the behavior).
  function applyBodyClass(hint, opts) {
    const silent = !!(opts && opts.silent)
    const force = !!(opts && opts.force)
    const next = `layout-${hint}`
    const changed = next !== currentBodyClass
    if (!silent && (changed || force)) {
      showLayoutToast(hint)
    }
    if (!changed) {
      ensureArtifactRailPlaceholder()
      return
    }
    for (const h of LAYOUTS) document.body.classList.remove(`layout-${h}`)
    document.body.classList.add(next)
    currentBodyClass = next
    forceToolBlocksOpenIfNeeded()
    ensureArtifactRailPlaceholder()
    document.body.dispatchEvent(new CustomEvent('dsh:layout-hint', {
      detail: { hint, sessionId: activeSessionId },
    }))
  }

  // In code-review layout we auto-open new .tool-block <details> so diffs are
  // visible without a click. If the user manually closes one we honor it
  // (data-user-collapsed marker set by our own click listener).
  function forceToolBlocksOpenIfNeeded() {
    if (currentBodyClass !== 'layout-code-review') return
    for (const el of document.querySelectorAll('.tool-block')) {
      if (!el.dataset.userCollapsed) el.setAttribute('open', '')
    }
  }
  function bindToolBlockAutoOpen() {
    const stream = document.getElementById('stream')
    if (!stream) return
    // MutationObserver: any newly-added .tool-block gets stamped `open` when
    // we're in code-review mode.
    const mo = new MutationObserver((records) => {
      if (currentBodyClass !== 'layout-code-review') return
      for (const rec of records) {
        for (const node of rec.addedNodes) {
          if (!node || node.nodeType !== 1) continue
          if (node.classList && node.classList.contains('tool-block') && !node.dataset.userCollapsed) {
            node.setAttribute('open', '')
          }
          const nested = node.querySelectorAll ? node.querySelectorAll('.tool-block') : []
          for (const el of nested) if (!el.dataset.userCollapsed) el.setAttribute('open', '')
        }
      }
    })
    mo.observe(stream, { childList: true, subtree: true })
    // Delegate a toggle listener so a manual close sticks — otherwise the
    // next diff event would re-open it.
    stream.addEventListener('toggle', (e) => {
      const t = e.target
      if (!t || !t.classList || !t.classList.contains('tool-block')) return
      if (!t.open) t.dataset.userCollapsed = '1'
      else delete t.dataset.userCollapsed
    }, true)
  }

  // Fallback lock-key used before the first session exists. `null` is a
  // legal Map key so this coexists with per-session locks — when a real
  // session is later activated, its own tracker takes over, but the visual
  // hint stays put because applyBodyClass() has already flipped the body
  // class. Without this the whole dropdown looked broken on the empty-state
  // welcome screen (no active session yet, so every item silently no-op'd).
  const NO_SESSION = null

  function chooseLayout(hint) {
    const key = activeSessionId != null ? activeSessionId : NO_SESSION
    const t = trackerFor(key)
    t.lock(hint)
    lockedHints.set(key, hint)
    // user-driven pick deserves the toast even if the pick
    // matches the current layout — otherwise the click looks broken.
    applyBodyClass(hint, { force: true })
    paintIndicator()
  }

  function unlockLayout() {
    const key = activeSessionId != null ? activeSessionId : NO_SESSION
    const t = trackerFor(key)
    t.unlock()
    lockedHints.delete(key)
    // Re-render with whatever the tracker settled at (`chat` after reset).
    // Force the toast: the user just clicked "↻ auto" and needs feedback.
    applyBodyClass(t.currentHint(), { force: true })
    paintIndicator()
  }

  // -- session-switch detection ---------------------------------------------
  //
  // renderer.js doesn't emit a session-change event, so we watch its
  // #session-title element via MutationObserver + we peek at its title
  // attribute (which renderer.js sets to the session id). Cheap, and it
  // never fights renderer state.

  function bindSessionWatcher() {
    const titleEl = document.getElementById('session-title')
    if (!titleEl) return
    const detect = () => {
      // renderer.js `li.title = id` on sidebar entries, and sets
      // titleEl.textContent to a slice of the id. The most reliable
      // signal is the .active sidebar entry's `title` attribute.
      const active = document.querySelector('#sessions li.active')
      const sid = active ? active.title : null
      if (sid && sid !== activeSessionId) onSessionChanged(sid)
    }
    // Poll on any DOM mutation in the sidebar; MutationObserver fires
    // once per batch so this is cheap.
    const mo = new MutationObserver(detect)
    mo.observe(document.getElementById('sessions') || document.body, {
      subtree: true, childList: true, attributes: true,
    })
    // Also re-check whenever the title changes.
    new MutationObserver(detect).observe(titleEl, {
      subtree: true, characterData: true, childList: true,
    })
    detect()
  }

  function onSessionChanged(sid) {
    activeSessionId = sid
    const t = trackerFor(sid)
    applyBodyClass(t.currentHint())
    paintIndicator()
  }

  // -- runtime hooks --------------------------------------------------------

  function handleNotify({ method, params }) {
    if (!params) return
    if (method === 'session.event') {
      const sid = params.sessionId
      if (!sid) return
      const t = trackerFor(sid)
      const result = t.push(params.event)
      if (sid === activeSessionId) {
        if (result.changed) applyBodyClass(t.currentHint())
        // Refresh the indicator on every push so the little glyph stays
        // in step even during the debounce ramp.
        paintIndicator()
      }
    }
  }

  function pollSessionMeta() {
    // Poll `listSessions()` once every 3s to feed running=? into the
    // per-session trackers' meta. This is what unlocks the monitor gate
    // on long-running turns.
    if (!window.dsh || typeof window.dsh.listSessions !== 'function') return
    const tick = async () => {
      try {
        const list = await window.dsh.listSessions()
        if (Array.isArray(list)) {
          for (const entry of list) {
            const t = trackers.get(entry.sessionId)
            if (t) t.setMeta({
              title: entry.title,
              running: !!entry.running,
              header: entry.header || {},
            })
          }
        }
      } catch (_) { /* ignore */ }
    }
    setInterval(tick, 3000)
    setTimeout(tick, 400)
  }

  // -- boot -----------------------------------------------------------------

  function boot() {
    // Default body class so CSS variables have something to attach to
    // from the first paint. `silent:true` skips the toast — boot is not
    // user intent, and the pill was showing up on every fresh-eyes walkthrough
    // as "Layout: chat — standard 780px column" hovering on an empty pane
    applyBodyClass('chat', { silent: true })
    ensureIndicator()
    bindSessionWatcher()
    bindToolBlockAutoOpen()
    if (window.dsh && typeof window.dsh.onNotify === 'function') {
      window.dsh.onNotify(handleNotify)
    }
    pollSessionMeta()
    paintIndicator()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
