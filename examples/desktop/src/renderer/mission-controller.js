// Mission Control controller. Owns the mission-model state, listens for
// notifications the renderer forwards to us via `window.__dshMission.
// notify(...)`, refreshes the session list snapshot on `session.finished`
// / `subagent.*`, and drives the three subviews.
//
// Layout inside the Mission pane:
//   +----------------------------------------------------------+
//   |  [summary chips]      [ticker: recent events across all] |
//   +----------------------------------------------------------+
//   |  [subview switch: Tree · Topology · Board]               |
//   +----------------------------------------------------------+
//   |  <active subview mounted here>                            |
//   +----------------------------------------------------------+
//
// The controller is IIFE-style so it can safely load after renderer.js has
// declared `window.dsh` + `window.__dshChat`. Renderer.js calls back into
// us via `window.__dshMission.notify(method, params)` so we don't have to
// know how it dispatches its own event stream.

'use strict'

;(function () {
  const state = MissionModel.createMissionState()
  let activeSubview = 'tree'
  let treeView = null
  let topoView = null
  let boardView = null
  let containers = null
  let elements = null
  let scheduled = false
  let lastRender = 0
  const RENDER_INTERVAL_MS = 400

  function onSelectSession(sessionId) {
    if (!sessionId) return
    // Switch back to the Chat tab and focus this session.
    if (window.__dshTabs) window.__dshTabs.switchTo('chat')
    if (window.__dshChat && typeof window.__dshChat.selectSession === 'function') {
      void window.__dshChat.selectSession(sessionId)
    }
  }

  function scheduleRender() {
    if (scheduled) return
    scheduled = true
    // Coalesce bursts of notifications: draw at most every RENDER_INTERVAL_MS.
    // rAF would be cheaper on paint but events land per-frame during a
    // running turn and we want the tree/topology counts to keep ticking
    // even when the tab is hidden briefly (rAF pauses in background tabs).
    const wait = Math.max(0, RENDER_INTERVAL_MS - (Date.now() - lastRender))
    setTimeout(() => {
      scheduled = false
      lastRender = Date.now()
      renderAll()
    }, wait)
  }

  function renderAll() {
    if (!elements) return
    // Suggestion bar visibility: shown whenever no session has been observed
    // yet. This is where doc §5 wants the "用示例数据预览" quiet button to
    // live — not on the top-right Debug bar. The bar is idempotent: clicking
    // the button drops mock data through the same injectMockScenario path,
    // so the model + all three subviews light up together.
    if (elements.suggestBar) {
      const empty = state.sessions.size === 0
      elements.suggestBar.hidden = !empty
    }
    // Only paint the currently-visible subview to save work.
    if (activeSubview === 'tree' && treeView) treeView.render(MissionModel.projectTreeRows(state))
    if (activeSubview === 'topo' && topoView) topoView.render(MissionModel.projectTopology(state))
    if (activeSubview === 'board' && boardView) boardView.render(MissionModel.projectBoard(state))
    renderSummary()
    renderTicker()
  }

  function renderSummary() {
    const summary = MissionModel.projectSummary(state)
    elements.summary.innerHTML = ''
    const chip = (label, value, cls) => {
      const c = document.createElement('div')
      c.className = 'mission-chip' + (cls ? ' ' + cls : '')
      const v = document.createElement('div')
      v.className = 'mission-chip-value'
      v.textContent = String(value)
      const l = document.createElement('div')
      l.className = 'mission-chip-label'
      l.textContent = label
      c.append(v, l)
      return c
    }
    elements.summary.appendChild(chip('Sessions', summary.totalSessions))
    elements.summary.appendChild(chip('Running', summary.runningSessions, summary.runningSessions > 0 ? 'running' : ''))
    elements.summary.appendChild(chip('Events today', summary.recentEvents))
    elements.summary.appendChild(chip('Tool calls', summary.totalToolCalls))
    if (summary.todosInProgress > 0 || summary.todosPending > 0) {
      elements.summary.appendChild(chip('Todos', `${summary.todosInProgress}/${summary.todosPending + summary.todosInProgress}`, 'todos'))
    }
  }

  function renderTicker() {
    const items = MissionModel.projectTicker(state, 10)
    elements.ticker.innerHTML = ''
    if (items.length === 0) {
      const hint = document.createElement('span')
      hint.className = 'mission-ticker-hint'
      hint.textContent = 'No recent activity'
      elements.ticker.appendChild(hint)
      return
    }
    for (const t of items) {
      const li = document.createElement('span')
      li.className = 'mission-ticker-item'
      const badge = document.createElement('span')
      badge.className = 'mission-ticker-badge'
      badge.textContent = t.sessionTitle.slice(0, 12)
      badge.title = 'jump to ' + t.sessionId
      badge.addEventListener('click', () => onSelectSession(t.sessionId))
      li.appendChild(badge)
      const text = document.createElement('span')
      text.className = 'mission-ticker-text'
      text.textContent = t.summary || t.type
      li.appendChild(text)
      elements.ticker.appendChild(li)
    }
  }

  function switchTo(subview) {
    activeSubview = subview
    for (const key of ['tree', 'topo', 'board']) {
      const btn = elements.tabs[key]
      if (btn) btn.classList.toggle('active', key === subview)
      const c = containers[key]
      if (c) c.hidden = key !== subview
    }
    renderAll()
  }

  function mount() {
    const pane = document.querySelector('[data-pane="mission"]')
    if (!pane) return
    const body = pane.querySelector('.mission-body')
    if (!body) return
    // Summary bar
    const summary = pane.querySelector('#mission-summary')
    const ticker = pane.querySelector('#mission-ticker')
    // Subview switcher
    const tabs = {
      tree: pane.querySelector('[data-mission-tab="tree"]'),
      topo: pane.querySelector('[data-mission-tab="topo"]'),
      board: pane.querySelector('[data-mission-tab="board"]'),
    }
    containers = {
      tree: pane.querySelector('[data-mission-panel="tree"]'),
      topo: pane.querySelector('[data-mission-panel="topo"]'),
      board: pane.querySelector('[data-mission-panel="board"]'),
    }
    // Suggestion bar (doc §5): a one-line explainer + a quiet "预览" button
    // that seeds the mock scenario. Sits between the summary/ticker top bar
    // and the subview tabs so it's the first thing a fresh user sees. Hidden
    // once the state has any session. Built once here; renderAll toggles it.
    const suggestBar = document.createElement('div')
    suggestBar.className = 'mission-suggest-bar'
    suggestBar.hidden = true
    suggestBar.innerHTML = `
      <div class="mission-suggest-body">
        <div class="mission-suggest-title">No long-running tasks yet</div>
        <div class="mission-suggest-hint">
          Mission Control folds cross-session progress, subagent topology and todo boards into one view.
          Real activity fills in automatically; load a sample scenario to preview the shape:
        </div>
      </div>
      <button class="mission-suggest-btn ghost small" type="button" data-mission-mock-seed>
        <span>Load sample data</span>
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none"
             stroke="currentColor" stroke-width="1.6"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 8h10M9 4l4 4-4 4"/>
        </svg>
      </button>
    `
    // Insert between topbar and subview tabs.
    const tabsRow = pane.querySelector('.mission-subview-tabs')
    if (tabsRow) body.insertBefore(suggestBar, tabsRow)
    else body.appendChild(suggestBar)
    suggestBar.querySelector('[data-mission-mock-seed]')
      .addEventListener('click', injectMockScenario)

    elements = { summary, ticker, tabs, suggestBar }
    treeView = MissionTree.createMissionTreeView(containers.tree, { onSelect: onSelectSession })
    topoView = MissionTopo.createMissionTopoView(containers.topo, { onSelect: onSelectSession })
    boardView = MissionBoard.createMissionBoardView(containers.board, { onSelect: onSelectSession })
    for (const key of Object.keys(tabs)) {
      if (tabs[key]) tabs[key].addEventListener('click', () => switchTo(key))
    }
    // Mock button — injects a canned scenario so someone can demo the view
    // without connecting to the daemon.
    const mockBtn = pane.querySelector('#mock-mission')
    if (mockBtn) mockBtn.addEventListener('click', injectMockScenario)
    // Refresh sessions manually.
    const refreshBtn = pane.querySelector('#mission-refresh')
    if (refreshBtn) refreshBtn.addEventListener('click', () => {
      if (window.__dshChat && typeof window.__dshChat.refreshSessionList === 'function') {
        void window.__dshChat.refreshSessionList()
      }
    })
    switchTo('tree')
    // Prime with whatever session list the chat pane already fetched.
    // Prefer the live sessions Map (added 2026-07-16 for C-P0-1): the
    // chat pane's `state.sessions` reflects turn/start-driven `running`
    // flips, which the periodic session/list snapshot lags behind. Fall
    // back to the raw entries array for older builds.
    seedFromChat()
  }

  // C-P0-1 fix (2026-07-16): the Mission Control top bar used to read
  // "Sessions 0 · Running 0" while the sidebar showed 7 live sessions and
  // Session Tree marked one 'turn in flight'. Same daemon, same wire, two
  // views disagreed. Root cause was double: (a) Mission never pulled the
  // live sessions Map that chat maintains — chat's `state.sessions.get(id).
  // running` flips on turn/start before the next session/list snapshot
  // arrives; (b) session/list ships every persisted session including
  // 50+ smoke-st ghosts, so the counters were dominated by empty rows the
  // sidebar had already filtered out (via panels-c.filterEmptySessions).
  //
  // Fix: pull the enriched entries from chat (getSessions() prefers meta
  // that already has hasUserMessage flipped correctly), override running=
  // true for the actively-in-flight session, then run the same empty
  // filter the sidebar uses so the two views count the same rows. The
  // filter lives in panels-c.filterEmptySessions — shared with quick-chat
  // and (soon) growth so no view drifts out of sync.
  function seedFromChat() {
    if (!window.__dshChat) return
    const entries = enrichedEntriesFromChat()
    if (!Array.isArray(entries)) return
    MissionModel.applySessionList(state, filterEntries(entries))
    scheduleRender()
  }

  // Pull the entry array chat is currently rendering. Prefer getSessions()
  // (Map-derived, carries the live running flag) over getEntries() (the raw
  // server snapshot, which lags turn/start by up to session-list-poll-ms).
  // Force running=true on the actively-in-flight session so Missions can't
  // read as idle while chat's Cancel button is enabled.
  function enrichedEntriesFromChat() {
    let entries = null
    const chat = window.__dshChat
    if (!chat) return null
    if (typeof chat.getSessions === 'function') entries = chat.getSessions()
    else if (typeof chat.getEnrichedEntries === 'function') entries = chat.getEnrichedEntries()
    else if (typeof chat.getEntries === 'function') entries = chat.getEntries()
    if (!Array.isArray(entries)) return null
    if (typeof chat.getInflightTurn === 'function' &&
        typeof chat.getActiveSessionId === 'function' &&
        chat.getInflightTurn()) {
      const activeId = chat.getActiveSessionId()
      entries = entries.map((e) => (
        e && e.sessionId === activeId ? { ...e, running: true } : e
      ))
    }
    return entries
  }

  // Empty-filter shared with the sidebar's mergeRecentSessions (
  // extended to Mission for C-P0-1). When panels-c isn't loaded (test path)
  // we return the array as-is; production always has it.
  function filterEntries(entries) {
    const P = window.__dshPanelsC
    if (!P || typeof P.filterEmptySessions !== 'function') return entries
    const chat = window.__dshChat
    const activeId = chat && typeof chat.getActiveSessionId === 'function'
      ? chat.getActiveSessionId()
      : null
    return P.filterEmptySessions(entries, { activeSessionId: activeId })
  }

  // -- notification intake ---------------------------------------------------

  function notify(method, params) {
    if (!method || !params) return
    if (method === 'session.event') {
      MissionModel.applyEvent(state, params.sessionId, params.event)
    } else if (method === 'session.finished') {
      const rec = state.sessions.get(params.sessionId)
      if (rec) rec.running = false
    } else if (method === 'subagent.started') {
      MissionModel.applySubagentEdge(state, {
        parentSessionId: params.parentSessionId,
        childSessionId: params.childSessionId,
        status: 'started',
      })
    } else if (method === 'subagent.finished') {
      // We don't get parentSessionId on finished (only childSessionId +
      // status). Look it up from the state we already keep.
      const child = state.sessions.get(params.childSessionId)
      const parentId = child ? child.parentSession : null
      if (parentId) {
        MissionModel.applySubagentEdge(state, {
          parentSessionId: parentId,
          childSessionId: params.childSessionId,
          status: 'finished',
        })
      } else if (child) {
        child.running = false
      }
    } else if (method === 'session.list') {
      // Renderer sends us its cached list whenever it refreshes. Prefer the
      // chat-side enriched view (has hasUserMessage flipped for live sessions,
      // running=true forced on the in-flight one) so this Mission view stays
      // one-to-one with the sidebar. Fall back to the raw params.entries when
      // the chat module isn't reachable (tests, early boot).
      const enriched = enrichedEntriesFromChat()
      const source = Array.isArray(enriched) && enriched.length > 0
        ? enriched
        : (Array.isArray(params.entries) ? params.entries : [])
      MissionModel.applySessionList(state, filterEntries(source))
    }
    scheduleRender()
  }

  // -- mock scenario ---------------------------------------------------------

  // Injects a synthetic 3-level, 8-node graph with mixed running/idle
  // sessions and a few todo lists, so the three subviews are demonstrable
  // without connecting to the daemon.
  function injectMockScenario() {
    const now = Date.now()
    const list = [
      { id: 'root',   title: 'Refactor auth module',       parent: null,  seed: null, running: true,  age: 90 },
      { id: 'plan',   title: 'plan: enumerate call sites', parent: 'root', seed: 4,   running: false, age: 60 },
      { id: 'edits',  title: 'apply edits in packages/',   parent: 'root', seed: 12,  running: true,  age: 5  },
      { id: 'tests',  title: 'run tests + fix breakage',   parent: 'root', seed: 20,  running: true,  age: 2  },
      { id: 'lint',   title: 'lint sweep',                 parent: 'edits', seed: 6,  running: false, age: 15 },
      { id: 'audit',  title: 'audit remaining TODOs',      parent: 'plan', seed: 3,   running: false, age: 45 },
      { id: 'ship',   title: 'draft PR + release notes',   parent: 'root', seed: 25,  running: false, age: 30 },
      { id: 'orphan', title: 'stray research session',     parent: 'ghost', seed: 1,  running: false, age: 120 },
    ]
    const entries = list.map((r) => ({
      sessionId: r.id,
      header: { version: 0, id: r.id, createdAt: now - r.age * 60_000, parentSession: r.parent || undefined, seedLength: r.seed || undefined },
      title: r.title,
      running: r.running,
      lastEventTime: now - r.age * 1_000,
      live: true, persisted: true,
    }))
    MissionModel.applySessionList(state, entries)
    // Add some events so counters have shape.
    const evt = (id, type, extra) => MissionModel.applyEvent(state, id, {
      type, time: now - Math.floor(Math.random() * 60_000),
      data: extra || {},
    })
    for (const id of ['root', 'plan', 'edits', 'tests']) {
      evt(id, 'turn/start', { turn: 0, trigger: {} })
      evt(id, 'user/message', { content: [{ type: 'text', text: 'seed prompt' }], source: 'user' })
    }
    for (let i = 0; i < 5; i++) {
      evt('edits', 'tool/call', { turn: 0, step: 0, callId: `c${i}`, name: 'edit_file', arguments: JSON.stringify({ path: `packages/auth/src/foo-${i}.ts` }) })
    }
    for (let i = 0; i < 3; i++) {
      evt('tests', 'tool/call', { turn: 0, step: 0, callId: `t${i}`, name: 'bash', arguments: JSON.stringify({ cmd: 'pnpm test' }) })
    }
    MissionModel.applyEvent(state, 'edits', {
      type: 'todo/write', time: now,
      data: { todos: [
        { content: 'Rewrite auth middleware', status: 'completed' },
        { content: 'Migrate session store', status: 'in_progress' },
        { content: 'Update integration tests', status: 'pending' },
        { content: 'Add rate-limit config', status: 'pending' },
      ] },
    })
    MissionModel.applyEvent(state, 'plan', {
      type: 'todo/write', time: now,
      data: { todos: [
        { content: 'List public endpoints', status: 'completed' },
        { content: 'Identify redirect chains', status: 'completed' },
        { content: 'Note protocol version bumps', status: 'in_progress' },
      ] },
    })
    MissionModel.applyEvent(state, 'root', {
      type: 'todo/write', time: now,
      data: { todos: [
        { content: 'Approve final PR', status: 'pending' },
      ] },
    })
    // Sprinkle a few subagent edges to grow the graph in a way that the
    // topology view can show. (Some already come from parent chains in
    // session/list; these mirror the wire notifications a real daemon would
    // send.)
    MissionModel.applySubagentEdge(state, { parentSessionId: 'root', childSessionId: 'edits', status: 'started' })
    MissionModel.applySubagentEdge(state, { parentSessionId: 'edits', childSessionId: 'lint', status: 'finished' })
    renderAll()
  }

  const api = { notify, mount, injectMockScenario, seedFromChat, _state: state }
  if (typeof window !== 'undefined') window.__dshMission = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})()
