// Runtimes page.
//
// One row per known runtime — each row expands into a capability matrix,
// profile leaf path, socket path, adapter chip strip. The renderer feeds
// the page from the same seams the sidebar already reads:
//
//   - window.dsh.listProfiles()     — list of profile ids the daemon knows
//   - window.dsh.runtimeStatus()    — { profile, model, status } for the
//                                     currently mounted runtime
//   - state.serverCapabilities      — the capability bag captured in the
//                                     initialize handshake (Ticket G)
//   - window.dsh.playground.list()  — isolated daemon(s) currently up
//
// This page now has two tabs:
//   - Rubric grid (default): the researcher-facing red/green matrix — one
//     row per rubric dim, one column per rollout, cells colored by pass/
//     fail. Click a cell → jump to that turn's trace. Data source is the
//     rubric-fusion event log.
//   - Status: the original composition — profile list + isolated-daemon
//     section — for wire/adapter debugging.
//
// This module is a pure DOM controller: no fetches, no timers other than a
// single refresh interval bound to the page's visibility. It exposes
// window.__dshRuntimes = { show(), refresh() } so renderer.js can call
// show() from switchTo('runtimes') without knowing the internals.

'use strict'
;(function () {
  const rootId = 'runtimes-pane'
  let currentTab = 'rubric-grid'
  let fusionSeeded = false

  function fusion() {
    return typeof window !== 'undefined' ? window.__dshRubricFusion : null
  }

  function seedFusionOnce() {
    const f = fusion()
    if (!f || fusionSeeded) return
    const seed = typeof window !== 'undefined' ? window.__dshRubricFusionSeed : null
    if (seed) f.loadFixture(seed)
    fusionSeeded = true
  }

  // Human-readable label for each capability bit. Kept in sync with
  // src/renderer/capabilities.js CAPABILITY_KEYS — the six bits the shell
  // actually gates on today. Ordering mirrors the module's canonical
  // order so a shot of this page is diffable against a shot of the
  // capabilities test file.
  const CAPABILITY_LABELS = {
    cancel: 'cancel',
    sessionQuery: 'session query',
    setConfig: 'set-config',
    fork: 'session fork',
    plugins: 'plugins',
    compact: 'compact',
  }

  // Adapter dot palette — mirrors the adapter matrix.
  // The list is static because listProfiles() doesn't expose adapter kind
  // today; every profile that mounts a stdio bridge (stdio-*) advertises
  // the same three adapters, and daemon-* profiles advertise the two
  // in-process adapters. This is a locally-derived best-effort; when
  // `runtime/list` (G8) lands upstream, replace this with the wire truth.
  function adaptersFor(profileId) {
    if (!profileId) return []
    if (profileId.startsWith('stdio-deepseek') || profileId.includes('deepseek')) {
      return ['deepseek', 'openai', 'anthropic']
    }
    if (profileId.startsWith('stdio-vibe')) {
      return ['deepseek', 'openai', 'anthropic', 'cordis']
    }
    if (profileId.startsWith('daemon-vibe')) return ['echo', 'cordis']
    if (profileId.startsWith('daemon-echo')) return ['echo']
    return ['echo']
  }

  // Bulld one row for a profile. Row is a details/summary so the L2 body
  // stays folded until the researcher opens it — matches
  // (default L0, expand for L1/L2 on demand).
  function renderProfileRow(profile, live, capabilities) {
    const isLive = live && live.profile === profile.id
    const li = document.createElement('details')
    li.className = 'runtime-row'
    if (isLive) li.classList.add('runtime-row--live')
    li.dataset.profile = profile.id
    li.open = isLive

    const sum = document.createElement('summary')
    sum.className = 'runtime-row-head'
    const status = document.createElement('span')
    status.className = `runtime-row-dot ${isLive ? 'runtime-row-dot--live' : 'runtime-row-dot--idle'}`
    status.title = isLive ? 'This is the mounted runtime.' : 'Profile is registered but not mounted.'
    sum.appendChild(status)
    const nameCol = document.createElement('span')
    nameCol.className = 'runtime-row-name'
    nameCol.textContent = profile.label || profile.id
    sum.appendChild(nameCol)
    const idCol = document.createElement('span')
    idCol.className = 'runtime-row-id muted'
    idCol.textContent = profile.id
    sum.appendChild(idCol)

    // Adapter dots (green if the profile is live, muted otherwise). Purely
    // visual: this is a locally-composed hint until G8 lands.
    const adapters = adaptersFor(profile.id)
    const adapterStrip = document.createElement('span')
    adapterStrip.className = 'runtime-row-adapters'
    for (const a of adapters) {
      const dot = document.createElement('span')
      dot.className = `runtime-adapter-dot runtime-adapter-dot--${isLive ? 'on' : 'off'}`
      dot.title = a
      dot.textContent = a
      adapterStrip.appendChild(dot)
    }
    sum.appendChild(adapterStrip)

    if (isLive && live.model) {
      const model = document.createElement('span')
      model.className = 'runtime-row-model muted'
      model.textContent = live.model
      sum.appendChild(model)
    }
    li.appendChild(sum)

    const body = document.createElement('div')
    body.className = 'runtime-row-body'

    // Capability matrix — only meaningful for the live profile because
    // capabilities are declared in the initialize handshake, and we only
    // handshake with one daemon at a time. For non-live rows, we render
    // dashes: "capability set: unknown until this profile mounts".
    const capsHead = document.createElement('div')
    capsHead.className = 'runtime-row-section-head'
    capsHead.textContent = 'capabilities'
    body.appendChild(capsHead)
    const capsGrid = document.createElement('div')
    capsGrid.className = 'runtime-caps-grid'
    for (const [key, label] of Object.entries(CAPABILITY_LABELS)) {
      const cell = document.createElement('div')
      cell.className = 'runtime-cap-cell'
      const dot = document.createElement('span')
      dot.className = 'runtime-cap-dot'
      const lbl = document.createElement('span')
      lbl.className = 'runtime-cap-label'
      lbl.textContent = label
      cell.appendChild(dot)
      cell.appendChild(lbl)
      if (!isLive) {
        dot.classList.add('runtime-cap-dot--unknown')
        cell.title = 'Unknown until this profile mounts.'
      } else if (!capabilities) {
        // Live but no capability bag on record — a v1 daemon that never
        // shipped `capabilities`. Fail-safe: assume all bits on, per the
        // capabilities module's default posture.
        dot.classList.add('runtime-cap-dot--on')
        cell.title = 'v1 daemon: no capability envelope declared, assumed on.'
      } else {
        const on = capabilities[key] !== false
        dot.classList.add(on ? 'runtime-cap-dot--on' : 'runtime-cap-dot--off')
        cell.title = on ? 'Declared true at initialize.' : 'Declared false at initialize.'
      }
      capsGrid.appendChild(cell)
    }
    body.appendChild(capsGrid)

    // Metadata rows. profile leaf path is a display-only string — the
    // main-side profiles.js:leafPathFor is the wire authority; the badge
    // hint here is "you get to see the truth of where this loads from".
    const meta = document.createElement('dl')
    meta.className = 'runtime-row-meta'
    const rows = [
      ['profile leaf', profile.leaf || profile.id + '.yml'],
      ['transport', profile.id.startsWith('daemon-') ? 'unix socket' : 'stdio bridge'],
    ]
    if (isLive) {
      rows.push(['model', live.model || '—'])
      rows.push(['status', live.status || '—'])
    }
    for (const [k, v] of rows) {
      const dt = document.createElement('dt')
      dt.textContent = k
      const dd = document.createElement('dd')
      dd.textContent = v
      dd.className = 'mono'
      meta.appendChild(dt)
      meta.appendChild(dd)
    }
    body.appendChild(meta)

    li.appendChild(body)
    return li
  }

  // Isolated-daemon section — reads Playground's list handle. The demo
  // path is deliberately sparse: one entry per live isolated daemon, with
  // Enter/Destroy buttons stubbed to plain switchTo('plugins') because
  // Playground is where the daemon can actually be driven. This is the
  // handoff surface, not a duplicate controller.
  async function renderIsolatedSection(container) {
    container.innerHTML = ''
    let entries = []
    try {
      if (window.dsh && window.dsh.playground && typeof window.dsh.playground.list === 'function') {
        const res = await window.dsh.playground.list()
        // Playground list shape varies by version; be defensive.
        if (Array.isArray(res)) entries = res
        else if (res && Array.isArray(res.sessions)) entries = res.sessions
        else if (res && Array.isArray(res.instances)) entries = res.instances
      }
    } catch (_) {
      // Playground list is best-effort — a missing handle is not an error;
      // the section falls through to the empty state.
    }

    const head = document.createElement('div')
    head.className = 'runtime-row-section-head'
    head.textContent = 'isolated daemons'
    container.appendChild(head)

    if (!entries.length) {
      const empty = document.createElement('div')
      empty.className = 'runtimes-isolated-empty muted'
      empty.textContent = 'No isolated daemon running. Start one from Plugins → Playground.'
      container.appendChild(empty)
      return
    }

    const ul = document.createElement('ul')
    ul.className = 'runtimes-isolated-list'
    for (const e of entries) {
      const li = document.createElement('li')
      li.className = 'runtimes-isolated-row'
      const dot = document.createElement('span')
      dot.className = 'runtime-row-dot runtime-row-dot--live'
      const label = document.createElement('span')
      label.className = 'runtimes-isolated-label'
      label.textContent = 'Playground scratch daemon'
      const sock = document.createElement('span')
      sock.className = 'runtimes-isolated-socket muted mono'
      sock.textContent = e.socketPath || e.socket || '(socket path unknown)'
      const ttl = document.createElement('span')
      ttl.className = 'runtimes-isolated-ttl muted'
      ttl.textContent = 'TTL: until Playground discards it'
      const actions = document.createElement('span')
      actions.className = 'runtimes-isolated-actions'
      const enter = document.createElement('button')
      enter.className = 'ghost small'
      enter.textContent = 'Enter'
      enter.title = 'Jump to Plugins → Playground to drive this daemon.'
      enter.addEventListener('click', () => {
        if (window.__dshTabs) window.__dshTabs.switchTo('plugins')
      })
      const destroy = document.createElement('button')
      destroy.className = 'ghost small'
      destroy.textContent = 'Destroy'
      destroy.title = 'Discard from Playground surface.'
      destroy.addEventListener('click', () => {
        if (window.__dshTabs) window.__dshTabs.switchTo('plugins')
      })
      actions.appendChild(enter)
      actions.appendChild(destroy)
      li.appendChild(dot)
      li.appendChild(label)
      li.appendChild(sock)
      li.appendChild(ttl)
      li.appendChild(actions)
      ul.appendChild(li)
    }
    container.appendChild(ul)
  }

  /**
   * Repaint the entire page. Called on show() and whenever the caller
   * knows the underlying seams changed (profile switch, initialize,
   * playground list update).
   *
   * @param {HTMLElement} root
   */
  async function refresh(root) {
    if (!root) return
    const list = root.querySelector('[data-runtimes-list]')
    const isolated = root.querySelector('[data-runtimes-isolated]')
    if (!list || !isolated) return
    list.innerHTML = ''

    let profiles = []
    let live = null
    try {
      if (window.dsh && typeof window.dsh.listProfiles === 'function') {
        profiles = await window.dsh.listProfiles()
      }
    } catch (_) { profiles = [] }
    try {
      if (window.dsh && typeof window.dsh.runtimeStatus === 'function') {
        live = await window.dsh.runtimeStatus()
      }
    } catch (_) { live = null }

    // Server capabilities come from the renderer state module which
    // captured them at initialize. Read through the __dshRenderer bridge
    // — a stable seam that predates this page.
    const capabilities = (window.__dshRenderer && typeof window.__dshRenderer.getServerCapabilities === 'function')
      ? window.__dshRenderer.getServerCapabilities()
      : null

    if (!profiles.length) {
      const empty = document.createElement('div')
      empty.className = 'runtimes-empty muted'
      empty.textContent = 'No profiles registered. Add one under ~/.dsh-desktop/profiles/*.yaml.'
      list.appendChild(empty)
    } else {
      for (const p of profiles) list.appendChild(renderProfileRow(p, live, capabilities))
    }

    await renderIsolatedSection(isolated)
  }

  async function show() {
    const root = document.getElementById(rootId)
    if (!root) return
    ensureTabStrip(root)
    seedFusionOnce()
    if (currentTab === 'rubric-grid') {
      await renderRubricGrid(root)
    } else {
      await refresh(root)
    }
  }

  // Inject a two-tab strip into the header-actions once. Idempotent.
  function ensureTabStrip(root) {
    if (root.querySelector('[data-runtimes-tabs]')) return
    const acts = root.querySelector('.header-actions')
    if (!acts) return
    const strip = document.createElement('div')
    strip.className = 'runtimes-tabs'
    strip.setAttribute('data-runtimes-tabs', '')
    const gridBtn = document.createElement('button')
    gridBtn.type = 'button'
    gridBtn.className = 'ghost small runtimes-tab active'
    gridBtn.dataset.runtimesTab = 'rubric-grid'
    gridBtn.textContent = 'Rubric grid'
    gridBtn.title = 'Rollout × rubric-dim red/green matrix (default).'
    const statusBtn = document.createElement('button')
    statusBtn.type = 'button'
    statusBtn.className = 'ghost small runtimes-tab'
    statusBtn.dataset.runtimesTab = 'status'
    statusBtn.textContent = 'Status'
    statusBtn.title = 'Profiles, adapter capabilities, isolated daemons.'
    strip.append(gridBtn, statusBtn)
    // Insert before the existing legend chip so the tabs sit at the head.
    acts.insertBefore(strip, acts.firstChild)

    strip.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-runtimes-tab]')
      if (!btn) return
      currentTab = btn.dataset.runtimesTab
      for (const b of strip.querySelectorAll('.runtimes-tab')) b.classList.toggle('active', b === btn)
      void show()
    })
  }

  // ---------- Rubric grid tab ----------

  async function renderRubricGrid(root) {
    const bodyList = root.querySelector('[data-runtimes-list]')
    const bodyIsolated = root.querySelector('[data-runtimes-isolated]')
    if (bodyList) bodyList.innerHTML = ''
    if (bodyIsolated) bodyIsolated.innerHTML = ''
    // We drop grid output into the .runtimes-list slot so no HTML
    // template edit is needed — the isolated-daemon slot stays empty on
    // this tab (that section only makes sense under Status).
    const host = bodyList
    if (!host) return
    const f = fusion()
    if (!f) {
      host.appendChild(muted('Rubric fusion store not loaded.'))
      return
    }
    const rubrics = f.listRubrics()
    if (!rubrics.length) {
      host.appendChild(muted('No rubrics registered. Author one under Rubrics → Create from scratch, or load the fusion fixture.'))
      return
    }
    // Header row: one card per rubric.
    for (const rubric of rubrics) {
      const grid = f.rolloutGridFor(rubric.id, null)
      const card = document.createElement('section')
      card.className = 'rubric-grid-card'
      card.setAttribute('data-testid', 'rubric-grid-card-' + rubric.id)
      const head = document.createElement('header')
      head.className = 'rubric-grid-head'
      head.appendChild(spanCls('rubric-grid-name', rubric.name))
      head.appendChild(spanCls('rubric-grid-desc muted small', rubric.description || ''))
      head.appendChild(spanCls('rubric-grid-rubric-id muted tiny', 'rubric: ' + rubric.id))
      card.appendChild(head)

      if (!grid.rollouts.length) {
        card.appendChild(muted('No rollouts scored against this rubric yet.'))
      } else {
        card.appendChild(renderGridTable(grid))
      }
      host.appendChild(card)
    }
  }

  function renderGridTable(grid) {
    const wrap = document.createElement('div')
    wrap.className = 'rubric-grid-table-wrap'
    const table = document.createElement('table')
    table.className = 'rubric-grid-table'
    // Header row: rollouts across the top.
    const thead = document.createElement('thead')
    const hrow = document.createElement('tr')
    const corner = document.createElement('th')
    corner.className = 'rubric-grid-corner'
    corner.textContent = 'dim ╲ rollout'
    hrow.appendChild(corner)
    for (const r of grid.rollouts) {
      const th = document.createElement('th')
      th.className = 'rubric-grid-col-head'
      th.textContent = String(r)
      hrow.appendChild(th)
    }
    thead.appendChild(hrow)
    table.appendChild(thead)
    const tbody = document.createElement('tbody')
    for (const dim of grid.dims) {
      const trow = document.createElement('tr')
      const rh = document.createElement('th')
      rh.className = 'rubric-grid-row-head'
      rh.textContent = dim.label
      rh.title = dim.type
      trow.appendChild(rh)
      for (const r of grid.rollouts) {
        const cell = grid.cells.find(c => c.dimId === dim.id && c.rolloutIdx === r)
        const td = document.createElement('td')
        td.className = 'rubric-grid-cell'
        if (!cell || cell.passed == null) {
          td.classList.add('rubric-grid-cell--empty')
          td.title = 'No score.'
        } else if (cell.passed) {
          td.classList.add('rubric-grid-cell--pass')
          td.title = `pass · session ${cell.sessionId} · turn ${cell.turnId}`
        } else {
          td.classList.add('rubric-grid-cell--fail')
          td.title = `fail · session ${cell.sessionId} · turn ${cell.turnId}`
        }
        if (cell && cell.sessionId && cell.turnId) {
          td.setAttribute('data-session-id', cell.sessionId)
          td.setAttribute('data-turn-id', cell.turnId)
          td.setAttribute('role', 'button')
          td.setAttribute('tabindex', '0')
          const jumpTo = () => jumpToTrace(cell.sessionId, cell.turnId)
          td.addEventListener('click', jumpTo)
          td.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jumpTo() } })
        }
        trow.appendChild(td)
      }
      tbody.appendChild(trow)
    }
    table.appendChild(tbody)
    wrap.appendChild(table)
    return wrap
  }

  function jumpToTrace(sessionId, turnId) {
    // Signal via the existing tab switcher; downstream trace/tracing page
    // can pick this event up. We don't hardcode the trace page URL — the
    // shell owns navigation.
    if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent('dsh:rubric-cell-jump', { detail: { sessionId, turnId } }))
    }
    if (window.__dshTabs && typeof window.__dshTabs.switchTo === 'function') {
      window.__dshTabs.switchTo('tracing')
    }
  }

  function muted(text) {
    const div = document.createElement('div')
    div.className = 'muted small'
    div.textContent = text
    return div
  }

  function spanCls(cls, text) {
    const s = document.createElement('span')
    s.className = cls
    s.textContent = text
    return s
  }

  if (typeof window !== 'undefined') {
    window.__dshRuntimes = { show, refresh: () => show() }
  }
})();
