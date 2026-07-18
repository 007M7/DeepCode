// Playground renderer (B1-B3). Drives the isolated scratch runtime through
// window.dsh.playground.*, painting a chat stream + a compact plugin list
// side by side. The pane is a peer of the Plugins pane; the "Playground"
// button in the Plugins header enters it, "Discard" or "Apply" leaves it.
//
// The chat stream reuses the same DOM shape as the main Chat pane's stream,
// but stripped down: text bubbles + tool-call summaries. It is a simple
// notify-consumer — we don't hook artifacts or widgets here (a playground
// session is meant to sanity-check a plugin lineup, not to be a full second
// chat surface).
//
// Compare drawer (B4-shaped, minimal): pick a live session, its first user
// message is copied into the playground input and sent. A read-only strip
// of the live session's events pastes next to the fresh playground stream
// so the user sees "same prompt, two overlays" side by side. Real fork
// replay lives behind `session/fork`; when that lands we swap to a real
// per-turn diff.

'use strict'

;(function () {
  const state = {
    running: false,
    sessionId: null,
    starting: false,
    compareOpen: false,
    compareSessionId: null,
  }

  const els = {
    // Buttons in the Plugins pane
    enter: document.getElementById('plugins-playground'),
    // Playground pane
    pane: document.querySelector('[data-pane="playground"]'),
    apply: document.getElementById('playground-apply'),
    discard: document.getElementById('playground-discard'),
    compare: document.getElementById('playground-compare'),
    stream: document.getElementById('playground-stream'),
    input: document.getElementById('playground-input'),
    send: document.getElementById('playground-send'),
    pluginsTbody: document.getElementById('playground-plugins-tbody'),
    meta: document.getElementById('playground-meta'),
    // Compare drawer
    drawer: document.getElementById('playground-compare-drawer'),
    drawerSelect: document.getElementById('playground-compare-select'),
    drawerClose: document.getElementById('playground-compare-close'),
    drawerLive: document.getElementById('playground-compare-live'),
    drawerPlayground: document.getElementById('playground-compare-playground'),
  }

  // Guard: if a required element is missing, skip wiring so the file remains
  // safe to load even in trimmed test harnesses of the renderer.
  if (!els.pane || !els.enter) {
    // Nothing to do — the Playground DOM isn't present in this build.
    return
  }

  // Bind the "Playground" button in the Plugins pane header to start the
  // scratch runtime and switch tabs.
  els.enter.addEventListener('click', async () => {
    if (state.starting || state.running) return
    state.starting = true
    els.enter.disabled = true
    els.enter.textContent = 'Booting playground…'
    try {
      await window.dsh.playground.start()
      state.running = true
      const s = await window.dsh.playground.newSession()
      state.sessionId = s.id
      appendMeta(`session ${state.sessionId} · daemon booted`)
      switchToPlaygroundPane()
      await refreshPluginList()
    } catch (err) {
      appendError(`playground failed to start: ${err.message}`)
    } finally {
      state.starting = false
      els.enter.disabled = false
      els.enter.textContent = 'Playground'
    }
  })

  els.discard.addEventListener('click', async () => {
    try { await window.dsh.playground.discard() } catch (_) {}
    resetPlaygroundState()
    if (window.__dshTabs) window.__dshTabs.switchTo('plugins')
  })

  els.apply.addEventListener('click', async () => {
    els.apply.disabled = true
    els.apply.textContent = 'Applying…'
    try {
      await window.dsh.playground.apply()
      resetPlaygroundState()
      if (window.__dshTabs) window.__dshTabs.switchTo('plugins')
      if (window.__dshPlugins) window.__dshPlugins.refresh()
    } catch (err) {
      appendError(`apply failed: ${err.message}`)
    } finally {
      els.apply.disabled = false
      els.apply.textContent = 'Apply this configuration'
    }
  })

  els.send.addEventListener('click', () => { void sendPrompt() })
  els.input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault()
      void sendPrompt()
    }
  })

  async function sendPrompt() {
    const text = els.input.value.trim()
    if (!text || !state.sessionId) return
    els.input.value = ''
    appendUser(text)
    try {
      await window.dsh.playground.prompt(state.sessionId, text)
    } catch (err) {
      appendError(`prompt failed: ${err.message}`)
    }
  }

  // Notify consumer — same shape as the main runtime's onNotify.
  window.dsh.playground.onNotify(({ method, params }) => {
    if (method === 'session.event' && params && params.event) {
      routeEvent(params.event, els.stream, params.sessionId)
      if (state.compareOpen && params.sessionId === state.sessionId) {
        // Mirror the same event into the compare drawer's playground column
        // so users viewing the drawer don't miss frames.
        routeEvent(params.event, els.drawerPlayground, params.sessionId)
      }
    }
  })
  window.dsh.playground.onCrash((info) => {
    appendError(`playground daemon crashed: ${JSON.stringify(info)}`)
    resetPlaygroundState()
  })

  // A tiny event router — text, tool_call summary, tool_result summary.
  // Anything else prints a compact tag with the type. Kept independent of
  // renderer.js so a playground surface renders even before the main chat
  // pane has painted anything.
  function routeEvent(event, container, sessionId) {
    if (!event) return
    const t = event.type || event.kind || ''
    if (t === 'message/assistant' || t === 'assistant/message') {
      // v2 events sometimes ship the assistant text under `content[]`.
      const text = extractText(event)
      if (text) appendAssistant(container, text)
      return
    }
    if (t === 'tool/call') {
      const name = event.tool || event.name || 'tool'
      const args = event.args ? shortJson(event.args) : ''
      appendToolCall(container, `[tool call] ${name}(${args})`)
      return
    }
    if (t === 'tool/result') {
      appendToolResult(container, `[tool result] ${extractText(event) || '(non-text)'}`)
      return
    }
    if (t === 'turn/end') {
      appendMeta(`turn/end · ${event.reason || 'ok'}`, container)
      return
    }
    // Fallback: compact type badge.
    appendMeta(`(${t})`, container)
  }

  function extractText(event) {
    if (typeof event.text === 'string') return event.text
    if (Array.isArray(event.content)) {
      return event.content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('')
    }
    return ''
  }
  function shortJson(o) {
    try {
      const s = JSON.stringify(o)
      return s.length > 60 ? s.slice(0, 57) + '…' : s
    } catch (_) { return '<unrepresentable>' }
  }

  // ---- render helpers ------------------------------------------------------

  function appendUser(text) { append('user', text, els.stream) }
  function appendAssistant(container, text) { append('assistant', text, container) }
  function appendToolCall(container, text) { append('tool-call', text, container) }
  function appendToolResult(container, text) { append('tool-result', text, container) }
  function appendMeta(text, container) {
    append('meta', text, container || els.stream)
  }
  function appendError(text) { append('error', text, els.stream) }

  function append(kind, text, container) {
    const div = document.createElement('div')
    div.className = `bubble bubble-${kind}`
    div.textContent = text
    container.appendChild(div)
    container.scrollTop = container.scrollHeight
  }

  function switchToPlaygroundPane() {
    // renderer.js exposes a general-purpose tab switcher keyed on data-pane;
    // reuse it. When name isn't the label of a sidebar tab button, that's
    // fine — the button set clears its .active class and the panel toggle
    // is driven by data-pane alone. We keep the plugins tab-panel visible
    // in the sidebar so the user has a "back" affordance via the tab-nav.
    if (window.__dshTabs) window.__dshTabs.switchTo('playground')
    // Sidebar keeps showing the plugins panel — the pane switcher already
    // hides the chat panel, but the plugins panel data-tab-panel="plugins"
    // won't match "playground" and gets hidden too. Re-show it so the
    // "Refresh / Apply + restart" buttons stay reachable while the user is
    // in the playground.
    const pluginsPanel = document.querySelector('[data-tab-panel="plugins"]')
    if (pluginsPanel) pluginsPanel.hidden = false
    const pluginsBtn = document.querySelector('.tab-btn[data-tab="plugins"]')
    if (pluginsBtn) pluginsBtn.classList.add('active')
  }

  function resetPlaygroundState() {
    state.running = false
    state.sessionId = null
    state.starting = false
    if (els.stream) els.stream.innerHTML = ''
    if (els.pluginsTbody) els.pluginsTbody.innerHTML = ''
    if (els.meta) els.meta.innerHTML = ''
    closeCompareDrawer()
  }

  async function refreshPluginList() {
    try {
      const list = await window.dsh.playground.list()
      if (els.meta) {
        els.meta.innerHTML =
          `<span class="muted">scratch overlay:</span> <code>${escapeHtml(list.scratchOverlayPath)}</code>`
      }
      renderPluginList(list.entries || [])
    } catch (err) {
      appendError(`playground list failed: ${err.message}`)
    }
  }

  function renderPluginList(entries) {
    if (!els.pluginsTbody) return
    els.pluginsTbody.innerHTML = ''
    for (const e of entries) {
      const tr = document.createElement('tr')
      if (e.disabled) tr.classList.add('disabled')
      const on = document.createElement('td')
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.checked = !e.disabled
      cb.addEventListener('change', async () => {
        cb.disabled = true
        try {
          await window.dsh.playground.toggle(e.id, !cb.checked)
          // Restart is done server-side; the isolated daemon comes back with
          // the new overlay on the same scratch dir. Refresh the list to
          // reflect any downstream state changes (e.g. dependent entries
          // that failed to boot).
          await refreshPluginList()
          appendMeta(`scratch daemon reloaded — ${e.id} is now ${cb.checked ? 'on' : 'off'}`)
          // On restart the isolated daemon has a fresh session-space; mint
          // a new session so subsequent prompts don't hit an orphan id.
          const s = await window.dsh.playground.newSession()
          state.sessionId = s.id
        } catch (err) {
          cb.checked = !cb.checked
          appendError(`toggle failed: ${err.message}`)
        } finally { cb.disabled = false }
      })
      on.appendChild(cb)
      tr.appendChild(on)
      const idc = document.createElement('td')
      idc.className = 'mono'
      idc.textContent = e.id
      tr.appendChild(idc)
      els.pluginsTbody.appendChild(tr)
    }
  }

  // ---- compare drawer ------------------------------------------------------
  //
  // "Test with a past session" (B4). The 80% version of a real fork-replay:
  // we pick a live session, paint its recorded events read-only on the left,
  // extract the FIRST user message, and re-send just that text into the
  // playground session on the right. Users see "same prompt, new overlay"
  // side by side, which is what most plugin-tuning questions actually need.
  //
  // NOT a real fork replay:
  //   - We only re-send the first user prompt. Multi-turn conversations, the
  //     tool-call transcript, and any injected context cards from the live
  //     session do NOT reach the playground. If the live conversation drifted
  //     across five turns before hitting the plugin under test, the compare
  //     will diverge earlier than the live one did.
  //   - The playground runs an isolated daemon (see src/main/playground.js).
  //     Cross-daemon fork is not on the wire — session/fork inside the same
  //     daemon works, but the whole point of the playground is to try a
  //     different plugin set, so a real fork would need daemon-to-daemon
  //     session transfer. Deferred until that wire exists.
  //
  // The pure extraction helpers live in ./compare-history.js so the flow can
  // be unit-tested without booting Electron.

  // Access the pure helpers. Loaded before playground-ui.js in index.html.
  const CH = (typeof window !== 'undefined' && window.__dshCompareHistory)
    || { findFirstUserMessage: null, extractText: null, normaliseEventsResponse: null }

  els.compare.addEventListener('click', async () => { await openCompareDrawer() })
  els.drawerClose.addEventListener('click', closeCompareDrawer)

  async function openCompareDrawer() {
    els.drawer.hidden = false
    state.compareOpen = true
    // Auto-start the playground if the user hit "Compare" before entering
    // the Playground pane. Compare needs a live playground session on the
    // right column; without one the "re-send" step no-ops.
    if (!state.running && !state.starting) {
      try {
        state.starting = true
        await window.dsh.playground.start()
        state.running = true
        const s = await window.dsh.playground.newSession()
        state.sessionId = s.id
        appendMeta(`playground booted for compare · session ${short(state.sessionId)}`)
      } catch (err) {
        appendMeta(`compare: could not boot playground — ${err.message}`, els.drawerPlayground)
      } finally { state.starting = false }
    }
    // Populate the picker with the live runtime's sessions. If the runtime
    // isn't up we surface an empty select rather than fail.
    try {
      const sessions = await window.dsh.listSessions()
      els.drawerSelect.innerHTML = ''
      const optNone = document.createElement('option')
      optNone.value = ''
      optNone.textContent = '(select a session)'
      els.drawerSelect.appendChild(optNone)
      for (const s of sessions) {
        const opt = document.createElement('option')
        opt.value = s.sessionId
        opt.textContent = s.title
          ? `${s.title} — ${short(s.sessionId)}`
          : short(s.sessionId)
        els.drawerSelect.appendChild(opt)
      }
    } catch (_) { /* leave empty */ }
    els.drawerSelect.onchange = async () => {
      const sid = els.drawerSelect.value
      state.compareSessionId = sid || null
      els.drawerLive.innerHTML = ''
      els.drawerPlayground.innerHTML = ''
      if (!sid) return
      // Pull the live history and paint it into the left column. Pick out
      // the first user message so we can re-send it into the playground.
      let events
      try { events = await window.dsh.sessionEvents(sid, {}) }
      catch (err) {
        appendMeta(`compare: could not load live history — ${err.message}`, els.drawerLive)
        return
      }
      const list = CH.normaliseEventsResponse
        ? CH.normaliseEventsResponse(events)
        : (Array.isArray(events) ? events : (events && events.events) || [])
      for (const e of list) routeEvent(e, els.drawerLive, sid)
      // Find the first user prompt and echo it into the playground. The pure
      // helper handles both the v2 `message/user` shape and the legacy
      // `user/message` one, and picks text out of either scalar `text` or
      // v2 content-block arrays.
      const hit = CH.findFirstUserMessage
        ? CH.findFirstUserMessage(list)
        : findFirstUserFallback(list)
      const firstText = hit ? hit.text : null
      if (firstText && state.sessionId) {
        appendMeta(
          `re-sending first user message from ${short(sid)}. ` +
          `Only the first prompt is replayed — see the compare-drawer comment ` +
          `in playground-ui.js for why this is not a real fork.`,
          els.drawerPlayground,
        )
        // TODO(playground-fork): once the daemon supports cross-daemon
        // session transfer, wire this to session/fork so subsequent turns
        // and tool results replay too. Design note in comment above.
        try { await window.dsh.playground.prompt(state.sessionId, firstText) }
        catch (err) {
          appendMeta(`playground prompt failed: ${err.message}`, els.drawerPlayground)
        }
      } else {
        appendMeta(`no user message found in ${short(sid)} — nothing to re-send`, els.drawerPlayground)
      }
    }
  }

  // Fallback for the case the pure module didn't load (e.g. index.html trimmed
  // in a test harness). Same behaviour, in-line.
  function findFirstUserFallback(list) {
    const u = list.find((e) => {
      const kind = e && (e.type || e.kind)
      return kind === 'message/user' || kind === 'user/message'
    })
    if (!u) return null
    const t = extractText(u)
    return t ? { event: u, text: t, index: list.indexOf(u) } : null
  }

  function closeCompareDrawer() {
    els.drawer.hidden = true
    state.compareOpen = false
    state.compareSessionId = null
  }

  function short(id) { return typeof id === 'string' ? id.slice(0, 8) : '' }
  // Shared with market-ui, plugins-ui, bench-page — see html-escape.js.
  const escapeHtml = (window.__dshHtmlEscape || {}).escapeHtml
    || ((s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])))

  // Exposed so other modules can drive the pane if needed.
  window.__dshPlayground = { refreshPluginList, resetPlaygroundState }
})()
