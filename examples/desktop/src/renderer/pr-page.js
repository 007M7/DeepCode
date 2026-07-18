// Pull Requests page — Row-list style list view over `gh pr list` JSON.
//
// Layout (top-to-bottom):
//   1. Page header: "Pull Requests" + subtitle (repo slug or connect hint)
//   2. Search input + filter chips (All / Open / Mine)
//   3. Grouped list:
//        Open — one row per PR
//        Recently merged/closed — collapsed below
//   Each row: state dot · title · repo·branch subrow · relative time · diff totals · "Ask DSH".
//
// The renderer owns all DOM; main.js owns the gh spawn + 60s cache. The
// module registers a `mount()` function on window.__dshPRs that renderer.js's
// tab switcher calls whenever the tab activates, plus a fetch on first mount
// so the initial view isn't blank while the daemon is starting.

/* global window, document */

;(function () {
  'use strict'

  // Live state kept minimal: last fetched dataset + current filter + query.
  // The rendered DOM is re-derived on every change so the layout stays honest
  // (no cell-level updates to hunt through when the shape changes).
  const state = {
    data: null,       // { rows, repo, source, error, fetchedAt }
    filter: 'all',    // 'all' | 'open' | 'mine'
    query: '',        // free-text substring, case-insensitive
    viewer: '',       // gh viewer login (best-effort; empty ⇒ "mine" is empty)
    loading: false,
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') node.className = v
      else if (k === 'text') node.textContent = v
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v)
      else if (v === true) node.setAttribute(k, '')
      else if (v === false || v == null) { /* skip */ }
      else node.setAttribute(k, v)
    }
    for (const c of [].concat(children)) {
      if (c == null || c === false) continue
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
    }
    return node
  }

  // Small SVG helper — Row-list style PR mark with a branch curve. `stateDot`
  // decides the stroke colour via a CSS class; the icon itself stays neutral.
  function prIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('width', '16')
    svg.setAttribute('height', '16')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('class', 'pr-icon')
    svg.innerHTML =
      '<circle cx="4" cy="3" r="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
      '<circle cx="4" cy="13" r="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
      '<circle cx="12" cy="13" r="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
      '<path fill="none" stroke="currentColor" stroke-width="1.4" d="M4 4.6v6.8M4 5.4c0 3.4 4 3.4 4 6.4M12 11.4V8"/>' +
      '<path fill="none" stroke="currentColor" stroke-width="1.4" d="M10.6 6.4l1.4 1.4 1.4-1.4"/>'
    return svg
  }

  // Send arrow — visually mirrors the quick chat button. Reused by the
  // per-row "Ask DSH" so the arrow direction is consistent with the composer.
  function sendGlyph() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('width', '12')
    svg.setAttribute('height', '12')
    svg.setAttribute('aria-hidden', 'true')
    svg.innerHTML =
      '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M8 13V3M4 7l4-4 4 4"/>'
    return svg
  }

  // Relative time formatter — same logic as the pure module in main. Kept
  // duplicated here so the renderer stays script-tag-friendly (no require).
  function relTime(iso, now = new Date()) {
    if (!iso) return ''
    const t = Date.parse(iso)
    if (!Number.isFinite(t)) return ''
    const diff = Math.max(0, now.getTime() - t)
    const s = Math.floor(diff / 1000)
    if (s < 45) return 'just now'
    const m = Math.floor(s / 60); if (m < 60) return `${m}m`
    const h = Math.floor(m / 60); if (h < 24) return `${h}h`
    const d = Math.floor(h / 24); if (d < 7) return `${d}d`
    const w = Math.floor(d / 7); if (w < 5) return `${w}w`
    const mo = Math.floor(d / 30); if (mo < 12) return `${mo}mo`
    return `${Math.floor(d / 365)}y`
  }

  function renderRow(row, repoSlug) {
    // Row = a full-width button so ↑↓ arrow navigation with focus rings can
    // land later without restructuring the DOM. Body click opens the PR
    // externally; the trailing "Ask DSH" swallows its own click so it never
    // races the row.
    const dot = el('span', { className: `pr-state-dot pr-state-${row.stateDot}`, title: row.state })
    const title = el('span', { className: 'pr-title', text: row.title })
    const num = el('span', { className: 'pr-num', text: `#${row.number}` })
    const branch = el('span', { className: 'pr-branch', text: row.headRefName })
    const arrow = el('span', { className: 'pr-branch-sep', text: '→' })
    const base = el('span', { className: 'pr-base', text: row.baseRefName || 'master' })
    const repoLbl = el('span', {
      className: 'pr-repo muted',
      text: repoSlug || '',
    })
    // adds/dels — Reference apps render these right-aligned with a subtle green/red;
    // we do the same via .pr-diff-adds / .pr-diff-dels.
    const diff = el('span', { className: 'pr-diff' }, [
      el('span', { className: 'pr-diff-adds', text: `+${row.additions}` }),
      el('span', { className: 'pr-diff-dels', text: `−${row.deletions}` }),
    ])
    const rel = el('span', { className: 'pr-rel muted', text: relTime(row.updatedAt) })
    const author = row.authorLogin
      ? el('span', { className: 'pr-author muted', text: `@${row.authorLogin}` })
      : null

    const askBtn = el('button', {
      className: 'pr-ask ghost small',
      title: 'Start a DSH chat about this PR',
      'aria-label': `Ask DSH about PR #${row.number}`,
      onclick: (ev) => {
        ev.stopPropagation()
        void askDshAboutPR(row)
      },
    }, [sendGlyph(), el('span', { text: 'Ask DSH' })])

    const rowNode = el('button', {
      className: `pr-row pr-row-${row.stateDot}`,
      type: 'button',
      onclick: () => openPR(row),
    }, [
      el('span', { className: 'pr-row-lead' }, [prIcon(), dot]),
      el('span', { className: 'pr-row-body' }, [
        el('span', { className: 'pr-row-titleline' }, [title, num]),
        el('span', { className: 'pr-row-subline' }, [
          repoLbl,
          repoSlug ? el('span', { className: 'pr-dotsep', text: '·' }) : null,
          branch, arrow, base,
          author ? el('span', { className: 'pr-dotsep', text: '·' }) : null,
          author,
        ]),
      ]),
      el('span', { className: 'pr-row-trail' }, [diff, rel, askBtn]),
    ])
    return rowNode
  }

  async function openPR(row) {
    if (!row.url) return
    try { await window.dsh.openExternalUrl(row.url) }
    catch (err) { console.warn('openExternalUrl failed:', err) }
  }

  // "Ask DSH" is the interesting bit: instead of the reference design's "open review in
  // browser" we mint a new DSH session, seed it with a scoped prompt, and
  // switch to the Chat tab. This is the wedge we want people to notice on the
  // page — the PR list is an entry point into an agent, not a static list.
  async function askDshAboutPR(row) {
    try {
      const { id } = await window.dsh.newSession()
      const prompt = `Review PR #${row.number}: ${row.title}` +
        `\n\nBranch: ${row.headRefName} → ${row.baseRefName || 'master'}` +
        (row.url ? `\nLink: ${row.url}` : '') +
        `\n\nStart by summarizing the diff, then flag anything that needs a second look.`
      if (window.__dshChat && typeof window.__dshChat.selectSession === 'function') {
        // Register into the sidebar with a helpful title so the user can
        // recognize it in the session list.
        await window.__dshChat.selectSession(id)
      }
      if (window.__dshTabs && typeof window.__dshTabs.switchTo === 'function') {
        window.__dshTabs.switchTo('chat')
      }
      await window.dsh.sendPrompt(id, prompt)
    } catch (err) {
      console.error('Ask DSH failed:', err)
      alert(`Ask DSH failed: ${err.message}`)
    }
  }

  // Client-side filter: server returns everything, we sift here so the
  // filter chip is instant. `query` matches title, branch, author, PR#.
  function filterRows(rows) {
    const q = state.query.trim().toLowerCase()
    return rows.filter((r) => matchesFilter(r, state.filter, state.viewer) && matchesQuery(r, q))
  }

  // Pulled out of filterRows so the same predicates drive the chip counts
  // (below) and the visible list. Keeping them side-by-side means the count
  // beside a chip is always the size of the list you'd see after clicking it.
  function matchesFilter(r, filter, viewer) {
    if (r.dropped) return false
    if (filter === 'open' && r.state !== 'OPEN') return false
    if (filter === 'mine') {
      if (!viewer) return false
      if (r.authorLogin.toLowerCase() !== viewer.toLowerCase()) return false
    }
    return true
  }
  function matchesQuery(r, q) {
    if (!q) return true
    return (
      r.title.toLowerCase().includes(q) ||
      r.headRefName.toLowerCase().includes(q) ||
      r.authorLogin.toLowerCase().includes(q) ||
      String(r.number).includes(q)
    )
  }

  // Chip counts reflect "how many rows would this chip surface if you
  // pressed it *now*" — so they honour the current search query, not just
  // the raw dataset. That makes the count useful even when the user is
  // typing to narrow the list.
  function computeChipCounts(rows, viewer, query) {
    const q = (query || '').trim().toLowerCase()
    const live = rows.filter((r) => !r.dropped && matchesQuery(r, q))
    return {
      all:  live.length,
      open: live.filter((r) => r.state === 'OPEN').length,
      mine: viewer
        ? live.filter((r) => r.authorLogin.toLowerCase() === viewer.toLowerCase()).length
        : 0,
    }
  }

  // Update the counter pill on each filter chip. Hidden when the count is
  // zero to avoid stamping "0" onto a chip that just happens to be inactive.
  function renderChipCounts(counts) {
    for (const key of Object.keys(counts)) {
      const el = document.querySelector(`[data-pr-count-for="${key}"]`)
      if (!el) continue
      const n = counts[key]
      if (n > 0) { el.textContent = String(n); el.hidden = false }
      else       { el.textContent = ''; el.hidden = true }
    }
  }

  function renderEmpty(container, message, hint) {
    container.appendChild(el('div', { className: 'pr-empty' }, [
      el('div', { className: 'pr-empty-title', text: message }),
      hint ? el('div', { className: 'pr-empty-hint muted', text: hint }) : null,
    ]))
  }

  function renderConnectHint(container, reason) {
    container.appendChild(el('div', { className: 'pr-hint-banner' }, [
      el('span', { className: 'pr-hint-badge', text: 'demo data' }),
      el('span', { text: ' — install and sign in with the GitHub CLI to see live PRs (' }),
      el('code', { text: 'gh auth login' }),
      el('span', { text: `). Reason: ${reason || 'unknown'}` }),
    ]))
  }

  function renderList() {
    const list = document.getElementById('pr-list')
    const meta = document.getElementById('pr-meta')
    const subtitle = document.getElementById('pr-subtitle')
    if (!list || !meta || !subtitle) return
    list.innerHTML = ''
    meta.innerHTML = ''

    const d = state.data
    if (state.loading && !d) {
      subtitle.textContent = 'Loading…'
      renderEmpty(list, 'Fetching PRs…', 'This runs `gh pr list` in the current repo.')
      return
    }
    if (!d) {
      subtitle.textContent = 'Not loaded'
      return
    }

    subtitle.textContent = d.repo
      ? `${d.repo} — ${d.rows.length} PR${d.rows.length === 1 ? '' : 's'} loaded`
      : (d.source === 'demo'
          ? 'Not connected to a repo — showing demo data'
          : 'Loaded')

    if (d.source === 'demo') renderConnectHint(meta, d.error)

    // Chip counts are refreshed on every render — cheap since it's three
    // filter predicates over an in-memory array. Kept next to renderList
    // so any dataset change (fetch, filter, search) reflects in the pills.
    renderChipCounts(computeChipCounts(d.rows, state.viewer, state.query))

    const rows = filterRows(d.rows)
    const open = rows.filter((r) => r.state === 'OPEN')
    const closed = rows.filter((r) => r.state !== 'OPEN')

    if (open.length === 0 && closed.length === 0) {
      renderEmpty(list, state.query ? 'No PRs match your search.' : 'No PRs to show.',
        state.query ? 'Try clearing the search or switching the filter.' : null)
      return
    }
    if (open.length > 0) {
      list.appendChild(el('div', { className: 'pr-group-head', text: 'Open' }))
      const group = el('div', { className: 'pr-group' })
      for (const row of open) group.appendChild(renderRow(row, d.repo))
      list.appendChild(group)
    }
    if (closed.length > 0) {
      list.appendChild(el('div', { className: 'pr-group-head pr-group-head-closed', text: 'Recently merged or closed' }))
      const group = el('div', { className: 'pr-group' })
      for (const row of closed) group.appendChild(renderRow(row, d.repo))
      list.appendChild(group)
    }
  }

  async function fetchList(force) {
    if (state.loading) return
    state.loading = true
    renderList()
    try {
      const res = await (force ? window.dsh.prs.refresh() : window.dsh.prs.list())
      state.data = res || { rows: [], source: 'unknown' }
      state.viewer = res && res.viewer ? res.viewer : ''
    } catch (err) {
      // A hard failure still ends up as a demo-source dataset so the tab
      // never sits blank — the connect banner explains why.
      console.error('prs.list failed:', err)
      state.data = { rows: [], source: 'demo', error: err.message }
    } finally {
      state.loading = false
      renderList()
    }
  }

  function bindControls() {
    const search = document.getElementById('pr-search')
    if (search) {
      search.addEventListener('input', () => { state.query = search.value; renderList() })
    }
    for (const chip of document.querySelectorAll('.pr-filter-chip')) {
      chip.addEventListener('click', () => {
        state.filter = chip.dataset.prFilter
        // Keep visual state (`.active`) and ARIA state (`aria-selected`)
        // in lockstep — screen readers only pick up the second, the eye
        // only sees the first.
        for (const c of document.querySelectorAll('.pr-filter-chip')) {
          const isActive = c === chip
          c.classList.toggle('active', isActive)
          c.setAttribute('aria-selected', isActive ? 'true' : 'false')
        }
        renderList()
      })
    }
    // Two refresh entrypoints — sidebar icon-btn and header button — same
    // action. Binding both lets the user reach it from wherever they are
    // in the layout without needing to remember which side owns which.
    for (const id of ['pr-refresh', 'pr-refresh-btn']) {
      const btn = document.getElementById(id)
      if (btn) btn.addEventListener('click', () => { void fetchList(true) })
    }
  }

  // Guard the DOM-touching handle: when this file is required from node
  // --test the module boots for its pure helpers (`_internal` below), but
  // there is no `window` for us to hang mount/show/refresh on.
  if (typeof window !== 'undefined') {
    window.__dshPRs = {
      mount() {
        bindControls()
        // Kick a background fetch on first mount; subsequent tab switches use
        // the cached dataset unless the user hits Refresh (which forces).
        if (!state.data) void fetchList(false)
      },
      // Called by the tab switcher every time the user opens the tab. Cheap
      // when data is cached; kicks the first fetch if mount() ran before this
      // script's controls were reachable (script-order races leave state.data
      // null and the page stuck on "Not loaded" otherwise).
      show() {
        if (!state.data && !state.loading) { void fetchList(false); return }
        renderList()
      },
      // Test hook: forces a full reload from gh.
      refresh() { return fetchList(true) },
    }
  }

  // Pure-fn export seam for node --test. Matches mission-topo._internal:
  // ship only the deterministic helpers (matchesFilter / matchesQuery /
  // computeChipCounts / relTime) so tests can hit the branchy bits without
  // spinning up jsdom. Not touched by product code — the IIFE's closure
  // continues to serve the renderer.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { _internal: { matchesFilter, matchesQuery, computeChipCounts, relTime } }
  }
})()
