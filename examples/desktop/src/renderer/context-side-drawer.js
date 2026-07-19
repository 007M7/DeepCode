// context-side-drawer.js — right-side peek drawer for the Context page
// (fix/context-topright-panel). Mirrors the Chat pane's
// chat-side-drawer.js interaction syntax so users get one mental model
// for the "top-right icon → right drawer" pattern across pages.
//
// Peek scope (kept intentionally small — the full ledger stays in the
// existing two-column body below):
//   1. Window occupancy — one horizontal stacked bar + totals line,
//      re-projected from the same computeWindowBreakdown() the
//      main-page bar calls, so the two never disagree.
//   2. Interventions — a count + the last-3 marker labels; a "See all"
//      link scrolls the intervention strip in the main body into view.
//   3. Jump link — "Jump to full context page" scrolls to the top of
//      the two-column body (or does nothing gracefully when there is
//      no active session, in which case renderEmpty() is shown).
//
// Wiring: the toggle button (#context-side-drawer-btn) and close
// button (#context-side-drawer-close) are already in index.html. This
// module installs the click listeners on document-ready, plus a
// document-level Escape handler that closes the drawer when open.

'use strict'

;(function () {
  const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined'

  // --- pure derivation helpers (safe to export; unit-tested from Node) ---

  function buildPeek (events, options) {
    const opts = options || {}
    const evts = Array.isArray(events) ? events : []
    let occupancy = null
    const windowApi = opts.windowApi
    if (windowApi && typeof windowApi.computeWindowBreakdown === 'function') {
      const budget = Number.isFinite(opts.budgetTokens) ? { budgetTokens: opts.budgetTokens } : undefined
      const view = windowApi.computeWindowBreakdown(evts, budget)
      occupancy = {
        totalTokens: view.totalTokens || 0,
        budget: view.budget || 0,
        budgetPct: view.budgetPct || 0,
        mode: view.mode || 'approx',
        slices: (view.slices || []).map((s) => ({
          family: s.family, label: s.label, tokens: s.tokens || 0, pct: s.pct || 0,
        })),
      }
    }
    let interventions = null
    const interventionApi = opts.interventionApi
    if (interventionApi && typeof interventionApi.collectInterventions === 'function') {
      const markers = interventionApi.collectInterventions(evts) || []
      const tail = markers.slice(-3).map((m) => ({
        label: (m && (m.label || m.kind || m.type)) || 'marker',
        kind: (m && (m.kind || m.type)) || '',
      }))
      interventions = { count: markers.length, tail }
    }
    return { hasEvents: evts.length > 0, occupancy, interventions }
  }

  // --- DOM render -------------------------------------------------------

  function renderPeek (container, peek) {
    if (!container) return
    const doc = container.ownerDocument || document
    container.textContent = ''
    container.className = 'context-side-drawer-body'

    if (!peek || !peek.hasEvents) {
      const empty = doc.createElement('div')
      empty.className = 'context-side-drawer-empty'
      empty.textContent = 'No active session — load a sample from the ledger below to see window occupancy and interventions.'
      container.appendChild(empty)
      return
    }

    // Section: window occupancy
    if (peek.occupancy) {
      const section = doc.createElement('section')
      section.className = 'context-side-drawer-section context-side-drawer-section--occupancy'
      const title = doc.createElement('div')
      title.className = 'context-side-drawer-section-title'
      title.textContent = 'Window occupancy'
      section.appendChild(title)

      const bar = doc.createElement('div')
      bar.className = 'context-side-drawer-bar'
      for (const slice of peek.occupancy.slices) {
        const seg = doc.createElement('span')
        seg.className = `context-side-drawer-seg context-side-drawer-seg--${slice.family}`
        seg.style.setProperty('--seg-pct', `${Math.max(0, slice.pct)}%`)
        seg.dataset.family = slice.family
        seg.dataset.tokens = String(slice.tokens)
        seg.dataset.pct = String(slice.pct)
        seg.title = `${slice.label}: ${slice.tokens} tok (${slice.pct}%)`
        bar.appendChild(seg)
      }
      section.appendChild(bar)

      const summary = doc.createElement('div')
      summary.className = 'context-side-drawer-summary muted small'
      const modeTag = peek.occupancy.mode === 'precise' ? '' : ' · approx'
      summary.textContent = `${peek.occupancy.totalTokens.toLocaleString()} / ${peek.occupancy.budget.toLocaleString()} tok · ${peek.occupancy.budgetPct}%${modeTag}`
      section.appendChild(summary)
      container.appendChild(section)
    }

    // Section: interventions
    if (peek.interventions) {
      const section = doc.createElement('section')
      section.className = 'context-side-drawer-section context-side-drawer-section--interventions'
      const title = doc.createElement('div')
      title.className = 'context-side-drawer-section-title'
      title.textContent = 'Interventions'
      section.appendChild(title)

      const count = doc.createElement('div')
      count.className = 'context-side-drawer-count'
      count.textContent = peek.interventions.count === 0
        ? 'None this session'
        : `${peek.interventions.count} this session`
      section.appendChild(count)

      if (peek.interventions.tail.length > 0) {
        const list = doc.createElement('ul')
        list.className = 'context-side-drawer-marker-list'
        for (const m of peek.interventions.tail) {
          const li = doc.createElement('li')
          li.className = 'context-side-drawer-marker'
          if (m.kind) li.dataset.kind = m.kind
          li.textContent = m.label
          list.appendChild(li)
        }
        section.appendChild(list)
      }
      container.appendChild(section)
    }

    // Section: jump link
    const jump = doc.createElement('section')
    jump.className = 'context-side-drawer-section context-side-drawer-section--jump'
    const jumpBtn = doc.createElement('button')
    jumpBtn.type = 'button'
    jumpBtn.className = 'context-side-drawer-jump'
    jumpBtn.id = 'context-side-drawer-jump'
    jumpBtn.textContent = 'Jump to full context page'
    jump.appendChild(jumpBtn)
    container.appendChild(jump)
  }

  // --- wiring -----------------------------------------------------------

  function readActiveEvents () {
    if (!isBrowser) return []
    const chat = window.__dshChat
    if (!chat) return []
    if (typeof chat.getEventsForActive === 'function') {
      return chat.getEventsForActive() || []
    }
    const state = window.__dshRendererState
    if (state && state.sessions && typeof chat.getActiveSessionId === 'function') {
      const sid = chat.getActiveSessionId()
      const meta = sid ? state.sessions.get(sid) : null
      return (meta && Array.isArray(meta.cachedEvents)) ? meta.cachedEvents : []
    }
    return []
  }

  function readBudgetTokens () {
    if (!isBrowser) return null
    const state = window.__dshRendererState
    const chat = window.__dshChat
    if (!state || !state.sessions || !chat || typeof chat.getActiveSessionId !== 'function') return null
    const sid = chat.getActiveSessionId()
    if (!sid) return null
    const meta = state.sessions.get(sid)
    if (meta && meta.contextTracker && typeof meta.contextTracker.snapshot === 'function') {
      const snap = meta.contextTracker.snapshot()
      if (snap && snap.budgetSource === 'server' && Number.isFinite(snap.budget)) return snap.budget
    }
    return null
  }

  function isOpen (drawer) {
    return !!(drawer && !drawer.classList.contains('hidden'))
  }

  function setOpen (drawer, btn, open) {
    if (!drawer) return
    drawer.classList.toggle('hidden', !open)
    drawer.setAttribute('aria-hidden', open ? 'false' : 'true')
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false')
    if (open) refresh(drawer)
  }

  function refresh (drawer) {
    if (!drawer) return
    const body = drawer.querySelector('#context-side-drawer-body')
    if (!body) return
    const peek = buildPeek(readActiveEvents(), {
      windowApi: window.__dshContextWindowBreakdown,
      interventionApi: window.__dshInterventionTimeline,
      budgetTokens: readBudgetTokens(),
    })
    renderPeek(body, peek)

    // Wire the jump link after render (fresh DOM each refresh).
    const jump = body.querySelector('#context-side-drawer-jump')
    if (jump) {
      jump.addEventListener('click', () => {
        const target = document.querySelector('.pane[data-pane="context"] [data-context-topstrip]')
          || document.querySelector('.pane[data-pane="context"] .context-page-body')
        if (target && typeof target.scrollIntoView === 'function') {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
      })
    }
  }

  function install () {
    if (!isBrowser) return
    const btn = document.getElementById('context-side-drawer-btn')
    const drawer = document.getElementById('context-side-drawer')
    const closeBtn = document.getElementById('context-side-drawer-close')
    if (!btn || !drawer) return
    if (drawer.dataset.wired === '1') return
    drawer.dataset.wired = '1'

    btn.addEventListener('click', () => setOpen(drawer, btn, !isOpen(drawer)))
    if (closeBtn) closeBtn.addEventListener('click', () => setOpen(drawer, btn, false))
    document.addEventListener('keydown', (e) => {
      if (e && e.key === 'Escape' && isOpen(drawer)) setOpen(drawer, btn, false)
    })
  }

  if (isBrowser) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', install)
    } else {
      install()
    }
  }

  // Exports for tests + optional in-page introspection.
  const api = { buildPeek, renderPeek, install }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (isBrowser) window.__dshContextSideDrawer = api
})()
