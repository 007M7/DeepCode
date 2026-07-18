// Renderer-side controller for P1 batch C: workflow/tasks/web/skill/resume.
//
// Self-contained IIFE that installs its own `window.dsh.onNotify` listener +
// mounts a bottom "Background tasks" drawer + adds a "History" group to the
// sidebar. Nothing in renderer.js is modified beyond three thin wire-lines
// (a resumeSession IPC bridge and a hook after refreshSessionList).
//
// Six event/tool surfaces get dedicated rendering:
//   - tool `web_search` result   → structured result-list card (URL links)
//   - tool `skill` result        → "skill loaded: <name>" badge + folded body
//   - tool `workflow` call/result → orchestration skeleton card
//   - tools `task_output/list/kill` → background-task drawer (aggregated view)
//   - `session/list` history split → sidebar "History" section (resume-capable)
//   - Debug mock buttons for the workflow surface (upstream workflow/* events
//     don't hit the wire today; the mock proves the card path)
//
// Wire-up model: our onNotify listener runs AFTER renderer.js's own listener
// because our <script> tag sits after ./renderer.js in index.html; both
// listeners see every notification, and DOM writes we do here re-target the
// same `resBox` renderer.js populated. Any tool without an override falls back
// to renderer.js's plain text — no interference.
//
// See docs/capability-ui-coverage.md §2 (rows for web_search/skill/workflow/
// task_*), §3 for the resume gap, and panels-c.js for the pure module.

'use strict'

;(function () {
  if (typeof globalThis === 'undefined' || !globalThis.__dshPanelsC) {
    console.warn('[panels-c] pure module missing; controller inert')
    return
  }
  if (!globalThis.window || !globalThis.window.dsh) {
    // Loaded outside an Electron renderer (e.g. accidentally imported into a
    // test). Nothing to do.
    return
  }
  const P = globalThis.__dshPanelsC

  // Track callId → toolName so tool/result can dispatch by tool name (renderer.js
  // has this info on the same map, but reaching into its state module is
  // brittle — keeping our own tracker matches the visibility-controller model).
  /** @type {Map<string, {name: string, args: string}>} */
  const callIndex = new Map()

  // Background task state — accumulated across task_* tool calls on the active
  // session. Cleared on session switch so history from a different session
  // doesn't linger.
  let taskState = { tasks: new Map() }
  let activeSessionId = null

  // History section state — retired. The unified Recent list in renderer.js
  // owns the collapse/expand toggle now (state.sessionsExpanded there). Kept
  // as a comment marker so the retirement of `renderHistorySection` below
  // reads as intentional rather than accidental dead code.

  // ---- helpers -------------------------------------------------------------

  function toolBlockFor(callId) {
    return document.querySelector(`.tool-block[data-call-id="${cssEscape(callId)}"]`)
  }
  function resBoxFor(callId) {
    const block = toolBlockFor(callId)
    return block ? block.querySelector('.result') : null
  }
  function cssEscape(s) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s)
    return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c.charCodeAt(0).toString(16) + ' ')
  }

  // Renderer.js exports its state module handles via window.__dshChat at the
  // end of bootUi. Use whatever the current activeSession is via the DOM
  // (the .msg blocks live inside #stream but session id is only on the
  // sidebar's <li.active>). Fallback to the last-seen id from event traffic.
  function currentActiveSessionId() {
    const li = document.querySelector('.sessions li.active')
    if (li && li.title) return li.title
    return activeSessionId
  }

  function scrollTasksToBottom(el) {
    if (el) el.scrollTop = el.scrollHeight
  }

  // ---- web_search override -------------------------------------------------

  function renderWebSearchInto(resBox, view) {
    resBox.textContent = ''
    const card = document.createElement('div')
    card.className = 'card-web-search'

    const head = document.createElement('div')
    head.className = 'card-web-search-head'
    head.textContent = `web results (${view.results.length})`
    card.appendChild(head)

    if (view.results.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'card-web-search-empty muted'
      empty.textContent = 'No parseable results — see raw tool output below.'
      card.appendChild(empty)
      const pre = document.createElement('pre')
      pre.className = 'card-web-search-raw'
      pre.textContent = view.raw
      card.appendChild(pre)
      resBox.appendChild(card)
      return
    }

    const list = document.createElement('ol')
    list.className = 'card-web-search-list'
    for (const r of view.results) {
      const li = document.createElement('li')
      li.className = 'card-web-search-item'
      const a = document.createElement('a')
      a.className = 'card-web-search-title'
      // href is set to '#' — the actual open is routed through shell.openExternal
      // in main via ipc:openExternal so URL scheme is centrally whitelisted.
      a.href = '#'
      a.textContent = r.title
      a.title = r.url
      a.addEventListener('click', (ev) => {
        ev.preventDefault()
        void window.dsh.openExternalUrl(r.url).catch((err) => {
          console.warn('[panels-c] openExternal failed', err)
        })
      })
      const url = document.createElement('div')
      url.className = 'card-web-search-url muted'
      url.textContent = r.url
      const sn = document.createElement('div')
      sn.className = 'card-web-search-snippet'
      sn.textContent = r.snippet
      li.append(a, url, sn)
      list.appendChild(li)
    }
    card.appendChild(list)
    resBox.appendChild(card)
  }

  // ---- skill override ------------------------------------------------------

  function renderSkillInto(resBox, view) {
    resBox.textContent = ''
    const card = document.createElement('details')
    card.className = 'card-skill'
    card.open = false

    const summary = document.createElement('summary')
    summary.className = 'card-skill-summary'
    const icon = document.createElement('span')
    icon.className = 'card-skill-icon'
    // Book glyph — inline SVG (1.6px stroke, currentColor). Replaces an
    // earlier emoji glyph so all "loaded skill" badges read as flat line-art
    // matching the rest of the shell's icon system.
    icon.innerHTML =
      '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">'
      + '<path fill="none" stroke="currentColor" stroke-width="1.6" '
      + 'stroke-linecap="round" stroke-linejoin="round" '
      + 'd="M4 5.5A1.5 1.5 0 0 1 5.5 4h3A1.5 1.5 0 0 1 10 5.5v10A1.5 1.5 0 0 0 8.5 14h-3A1.5 1.5 0 0 1 4 15.5zM10 5.5A1.5 1.5 0 0 1 11.5 4h3A1.5 1.5 0 0 1 16 5.5v10A1.5 1.5 0 0 0 14.5 14h-3A1.5 1.5 0 0 1 10 15.5z"/>'
      + '</svg>'
    const label = document.createElement('span')
    label.className = 'card-skill-label'
    label.textContent = view.name ? `skill loaded: ${view.name}` : 'skill loaded'
    const size = document.createElement('span')
    size.className = 'card-skill-size muted'
    size.textContent = view.body ? `${view.body.length} chars` : ''
    summary.append(icon, label, size)
    card.appendChild(summary)

    if (view.body) {
      const body = document.createElement('pre')
      body.className = 'card-skill-body'
      body.textContent = view.body
      card.appendChild(body)
    }
    resBox.appendChild(card)
  }

  // ---- workflow override ---------------------------------------------------

  function renderWorkflowInto(resBox, view, { pending = false } = {}) {
    resBox.textContent = ''
    const card = document.createElement('div')
    card.className = 'card-workflow'

    const head = document.createElement('div')
    head.className = 'card-workflow-head'
    const title = document.createElement('span')
    title.className = 'card-workflow-title'
    title.textContent = view.name ? `workflow: ${view.name}` : 'workflow'
    const chip = document.createElement('span')
    chip.className = 'card-workflow-chip muted'
    // The workflow tool's Cordis-side events don't cross the JSON-RPC wire
    // today (see coverage doc §1 "workflow/* Cordis events"). We surface this
    // limitation on the card rather than silently faking progress.
    chip.textContent = pending ? 'running…' : 'events not wired'
    chip.title = 'workflow/* Cordis events aren\'t on the JSON-RPC wire today'
    head.append(title, chip)
    card.appendChild(head)

    if (view.phases.length > 0) {
      const list = document.createElement('ol')
      list.className = 'card-workflow-phases'
      for (const p of view.phases) {
        const li = document.createElement('li')
        li.className = `card-workflow-phase status-${p.status}`
        const dot = document.createElement('span')
        dot.className = 'card-workflow-phase-dot'
        dot.textContent = p.status === 'done' ? '✓'
          : p.status === 'failed' ? '✗'
            : p.status === 'running' ? '⋯' : '·'
        const lbl = document.createElement('span')
        lbl.className = 'card-workflow-phase-label'
        lbl.textContent = p.label
        li.append(dot, lbl)
        list.appendChild(li)
      }
      card.appendChild(list)
    } else {
      const empty = document.createElement('div')
      empty.className = 'card-workflow-empty muted'
      empty.textContent = 'No declared phases.'
      card.appendChild(empty)
    }

    resBox.appendChild(card)
  }

  // ---- background tasks drawer --------------------------------------------

  function ensureTasksDrawer() {
    let drawer = document.getElementById('panels-c-tasks-drawer')
    if (drawer) return drawer

    // Mount into the chat pane so its lifecycle follows the chat surface.
    // Positioned via CSS as a small dock above the composer footer.
    const chatPane = document.querySelector('.pane[data-pane="chat"]')
    if (!chatPane) return null

    drawer = document.createElement('div')
    drawer.id = 'panels-c-tasks-drawer'
    drawer.className = 'panels-c-tasks-drawer'
    drawer.hidden = true

    const head = document.createElement('div')
    head.className = 'panels-c-tasks-head'
    const title = document.createElement('span')
    title.className = 'panels-c-tasks-title'
    title.textContent = 'Background tasks'
    const count = document.createElement('span')
    count.className = 'panels-c-tasks-count muted'
    count.textContent = '0'
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'panels-c-tasks-toggle ghost'
    toggle.textContent = 'Hide'
    toggle.addEventListener('click', () => {
      const body = drawer.querySelector('.panels-c-tasks-body')
      const collapsed = body.classList.toggle('collapsed')
      toggle.textContent = collapsed ? 'Show' : 'Hide'
    })
    head.append(title, count, toggle)

    const body = document.createElement('div')
    body.className = 'panels-c-tasks-body'
    drawer.append(head, body)

    // Insert before the composer footer.
    const composer = chatPane.querySelector('.composer')
    if (composer) chatPane.insertBefore(drawer, composer)
    else chatPane.appendChild(drawer)
    return drawer
  }

  function renderTasksDrawer() {
    const drawer = ensureTasksDrawer()
    if (!drawer) return
    const body = drawer.querySelector('.panels-c-tasks-body')
    const count = drawer.querySelector('.panels-c-tasks-count')
    if (!body || !count) return

    const entries = Array.from(taskState.tasks.values())
    if (entries.length === 0) {
      drawer.hidden = true
      body.textContent = ''
      count.textContent = '0'
      return
    }
    drawer.hidden = false
    // Show most-recent first — lastUpdate is an ISO string, string compare
    // works for the ISO format the reducer emits.
    entries.sort((a, b) => String(b.lastUpdate).localeCompare(String(a.lastUpdate)))
    count.textContent = String(entries.length)

    body.textContent = ''
    for (const t of entries) {
      const row = document.createElement('div')
      row.className = `panels-c-task-row status-${t.status}`
      const status = document.createElement('span')
      status.className = 'panels-c-task-status'
      status.textContent = statusGlyph(t.status)
      status.title = t.status
      const id = document.createElement('span')
      id.className = 'panels-c-task-id'
      id.textContent = t.id
      const name = document.createElement('span')
      name.className = 'panels-c-task-name'
      name.textContent = t.name || ''
      const summary = document.createElement('span')
      summary.className = 'panels-c-task-summary muted'
      summary.textContent = t.summary || ''
      row.append(status, id, name, summary)
      body.appendChild(row)
    }
    scrollTasksToBottom(body)
  }

  function statusGlyph(s) {
    if (s === 'done') return '✓'
    if (s === 'failed') return '✗'
    if (s === 'killed') return '⊘'
    if (s === 'running') return '⋯'
    return '·'
  }

  // ---- sidebar history section (retired) ----------------------------------
  //
  // The sidebar used to render a separate "History" list here for persisted-
  // but-not-live sessions, sitting below the "Sessions" list. That split
  // leaked a runtime impl detail (live vs. persisted) as a group header.
  // renderer.js's `renderSessionList` now emits a single unified "Recent"
  // list that includes both kinds and marks resume-vs-live per row (see
  // panels-c.js `mergeRecentSessions`). This function is kept as a no-op
  // shim so the existing event-dispatch call sites don't need to grow
  // conditional guards — deleting it would ripple across the notify path.

  function renderHistorySection() {
    // A previous section may still be in the DOM if the controller ran under
    // an older renderer.js — remove it once so the two lists never coexist.
    const stale = document.getElementById('panels-c-history')
    if (stale) stale.remove()
  }

  // ---- event dispatch ------------------------------------------------------

  function handleToolCall(sessionId, data) {
    if (!data || typeof data.callId !== 'string') return
    callIndex.set(data.callId, { name: String(data.name || ''), args: String(data.arguments || '') })

    if (sessionId !== currentActiveSessionId()) return

    // Workflow gets a pre-populated skeleton at call time — the result-time
    // pass upgrades it if we can parse phases from the output.
    if (data.name === 'workflow') {
      const resBox = resBoxFor(data.callId)
      if (resBox) {
        const view = P.foldWorkflowCall({ args: data.arguments })
        renderWorkflowInto(resBox, view, { pending: true })
      }
    }

    // Task-family tools also inform the drawer state on call.
    if (data.name === 'task_output' || data.name === 'task_list' || data.name === 'task_kill') {
      taskState = P.updateBackgroundTasks(taskState, {
        toolName: data.name, callId: data.callId,
        args: data.arguments, phase: 'call',
      })
      renderTasksDrawer()
    }
  }

  function handleToolResult(sessionId, data) {
    if (!data || typeof data.callId !== 'string') return
    const entry = callIndex.get(data.callId)
    if (!entry) return
    const { name, args } = entry
    const isError = !!data.isError
    const content = data.content

    // Update background task state first so the drawer reflects even
    // errored/isError=true results.
    if (name === 'task_output' || name === 'task_list' || name === 'task_kill') {
      taskState = P.updateBackgroundTasks(taskState, {
        toolName: name, callId: data.callId,
        args, content, isError, phase: 'result',
      })
      renderTasksDrawer()
    }

    if (sessionId !== currentActiveSessionId()) return

    // Skip the resBox override when renderer.js already routed to a widget or
    // known card (diff/terminal) — those already have first-class rendering
    // and we should not stomp them. Detect by checking whether the resBox
    // currently hosts a first-class card node.
    const resBox = resBoxFor(data.callId)
    if (!resBox) return
    const firstChild = resBox.firstElementChild
    if (firstChild) {
      const cls = firstChild.className || ''
      if (/^(?:widget|card-terminal|card-diff)\b/.test(cls)) return
    }

    if (name === 'web_search' && !isError) {
      renderWebSearchInto(resBox, P.foldWebSearchResults(content))
      return
    }
    if (name === 'skill' && !isError) {
      renderSkillInto(resBox, P.foldSkillLoad({ args, content }))
      return
    }
    if (name === 'workflow') {
      // Parse result body for phase updates; if the tool didn't ship any
      // structured phases we keep the call-time skeleton but flip the chip.
      const view = P.foldWorkflowCall({ args })
      renderWorkflowInto(resBox, view, { pending: false })
      return
    }
  }

  function handleSessionListUpdate() {
    // Called after renderer.js refreshes state.entries. Also self-called on
    // subagent.started/finished since those trigger a refresh downstream.
    renderHistorySection()
  }

  function handleSessionSwitch() {
    // Poll for the active session on every render — cheap; also clears task
    // state so a different session's drawer doesn't leak in.
    const nextId = currentActiveSessionId()
    if (nextId && nextId !== activeSessionId) {
      activeSessionId = nextId
      taskState = { tasks: new Map() }
      renderTasksDrawer()
    }
  }

  // ---- listener install ----------------------------------------------------

  window.dsh.onNotify(({ method, params }) => {
    if (!params) return
    if (method === 'session.event') {
      const { sessionId, event } = params
      if (!event) return
      handleSessionSwitch()
      if (event.type === 'tool/call') handleToolCall(sessionId, event.data || event)
      else if (event.type === 'tool/result') handleToolResult(sessionId, event.data || event)
    } else if (method === 'subagent.started' || method === 'subagent.finished' || method === 'session.finished') {
      // These triggers a session/list refresh downstream; the history section
      // will pick up the change on the next tick after renderer.js completes.
      queueMicrotask(() => {
        handleSessionSwitch()
        renderHistorySection()
      })
    }
  })

  // Kick a first render after boot so the sidebar History section appears
  // once the initial session/list poll arrives. renderer.js polls once at
  // ~500ms boot delay, so wait a beat longer.
  setTimeout(() => {
    handleSessionSwitch()
    renderHistorySection()
  }, 800)
})()
