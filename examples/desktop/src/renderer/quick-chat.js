// Quick chat overlay — a Row-list style floating composer that appears over any
// pane and either (a) drops the user into a recent session or (b) mints a new
// one seeded with their prompt, then closes and switches to the Chat tab.
//
// Design notes:
//   - Overlay lives as a plain div inside the app layout, not a separate
//     BrowserWindow. A second BrowserWindow would need its own preload +
//     ipcRenderer channel and a second copy of the session cache; that's a
//     lot of surface for a UI affordance. Using a full-screen scrim div gives
//     us the same visual and every existing IPC method is reachable directly.
//   - Global shortcut is registered in main.js via `globalShortcut`; main
//     sends `quickchat:toggle` on the IPC channel, which we bind below.
//   - `Escape` closes without sending. `Enter` sends; `Shift+Enter` newline.
//   - The "recent 5 sessions" list is derived from window.__dshChat state.
//     If that helper isn't ready yet (very early boot), the list is simply
//     empty — the composer still works.

/* global window, document */

;(function () {
  'use strict'

  // Small helper reused from other modules — avoids a hard dependency on any
  // one of them so quick-chat can boot even if a sibling script errored.
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

  // Pick the N most recent sessions the sidebar knows about, prefering the
  // ones with real turn activity (running/live > persisted) so the list
  // isn't dominated by empty stubs from `New session` clicks. Empty sessions
  // (`hasUserMessage === false`) are dropped up front — the sidebar filters
  // them the same way (panels-c.filterEmptySessions), so the two lists agree.
  // Exported for tests via `window.__dshQuickChatInternals`.
  function pickRecentSessions(entries, limit = 5) {
    if (!Array.isArray(entries)) return []
    // Filter empty stubs first so they don't take slots from real sessions.
    // Rows that predate the `hasUserMessage` flag pass through (undefined ≠ false).
    // In production panels-c.js loads first (see index.html); the test harness
    // doesn't load it, so we fall back to the inline predicate — same rule.
    const PC = window.__dshPanelsC
    const filtered = PC && typeof PC.filterEmptySessions === 'function'
      ? PC.filterEmptySessions(entries)
      : entries.filter((e) => e && e.hasUserMessage !== false)
    // Rank on three keys, in order: is-running, is-live, most-recent-activity.
    // Comparator returns non-zero the moment a higher-precedence key breaks
    // the tie, so a running session with old activity still beats a fresh
    // idle one — that matches user intent ("give me what I'm doing now").
    const scored = filtered.slice()
    scored.sort((a, b) => {
      const runA = a.running ? 1 : 0, runB = b.running ? 1 : 0
      if (runA !== runB) return runB - runA
      const liveA = a.live ? 1 : 0, liveB = b.live ? 1 : 0
      if (liveA !== liveB) return liveB - liveA
      const tA = typeof a.lastEventTime === 'number' ? a.lastEventTime : 0
      const tB = typeof b.lastEventTime === 'number' ? b.lastEventTime : 0
      return tB - tA
    })
    return scored.slice(0, limit)
  }

  // Expose the pure helper for `node --test` — the test file requires this
  // via a light shim (see test/quick-chat.test.js) so we don't have to
  // migrate the whole module out of the script-tag world.
  window.__dshQuickChatInternals = { pickRecentSessions }

  let overlayEl = null
  let inputEl = null
  let recentEl = null
  let open = false

  function ensureDom() {
    if (overlayEl) return
    overlayEl = el('div', { className: 'quickchat-scrim', hidden: true, 'data-quickchat': '' })
    overlayEl.addEventListener('click', (e) => {
      // Click on the scrim (outside the card) closes; clicks inside the card
      // bubble past this because .quickchat-card stops them.
      if (e.target === overlayEl) hide()
    })

    const card = el('div', { className: 'quickchat-card', onclick: (e) => e.stopPropagation() })

    // Brand-marked head: a 16px logo anchors "this is DSH's floating chat"
    // without shouting. Logo is a plain <img> so it inherits the file:// base
    // like the rest of the renderer; alt="" because the adjacent title says it.
    const logo = document.createElement('img')
    logo.className = 'quickchat-brand-logo'
    logo.src = '../../assets/logo.png'
    logo.width = 16
    logo.height = 16
    logo.alt = ''
    logo.setAttribute('aria-hidden', 'true')
    const headBar = el('div', { className: 'quickchat-head' }, [
      logo,
      el('span', { className: 'quickchat-title', text: 'Quick chat' }),
      el('span', { className: 'quickchat-hint muted', text: 'Enter to send · ESC to close' }),
      el('button', {
        className: 'quickchat-close ghost small',
        'aria-label': 'Close quick chat',
        title: 'Close (ESC)',
        onclick: () => hide(),
      }, ['×']),
    ])

    recentEl = el('div', { className: 'quickchat-recent', 'aria-label': 'Recent sessions' })

    inputEl = el('textarea', {
      className: 'quickchat-input',
      rows: '3',
      placeholder: 'Ask DSH anything…',
      'aria-label': 'Quick chat prompt',
    })
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); hide(); return }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit() }
    })

    const sendBtn = el('button', {
      className: 'quickchat-send primary',
      title: 'Send (Enter)',
      'aria-label': 'Send message',
      onclick: () => { void submit() },
    })
    // A rounded up-arrow — the reference design uses the same glyph in the floating
    // composer. Kept as inline SVG so it colors with currentColor.
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    arrow.setAttribute('viewBox', '0 0 20 20')
    arrow.setAttribute('width', '16')
    arrow.setAttribute('height', '16')
    arrow.setAttribute('aria-hidden', 'true')
    arrow.innerHTML =
      '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M10 16V4M5 9l5-5 5 5"/>'
    sendBtn.appendChild(arrow)

    const composer = el('div', { className: 'quickchat-composer' }, [inputEl, sendBtn])

    card.appendChild(headBar)
    card.appendChild(recentEl)
    card.appendChild(composer)
    overlayEl.appendChild(card)
    document.body.appendChild(overlayEl)
  }

  function refreshRecent() {
    if (!recentEl) return
    recentEl.innerHTML = ''
    const chat = window.__dshChat
    if (!chat) return
    // Prefer enriched entries (carry `hasUserMessage` so pickRecentSessions
    // can drop empty stubs). Older shells expose only getEntries — that's
    // fine, entries without the flag pass through unfiltered.
    let entries = []
    if (typeof chat.getEnrichedEntries === 'function') {
      entries = chat.getEnrichedEntries() || []
    } else if (typeof chat.getEntries === 'function') {
      entries = chat.getEntries() || []
    }
    const rows = pickRecentSessions(entries, 5)
    if (rows.length === 0) {
      recentEl.appendChild(el('div', { className: 'quickchat-recent-empty muted',
        text: 'No recent sessions yet — your first prompt will start one.' }))
      return
    }
    // Reuse the sidebar's canonical formatter so quick-chat rows read the
    // same as the Recent list: real title, or `未命名 · <rel>` for smoke
    // fixtures / (shortId) fallbacks. Never `Session ${sid.slice(0,8)}` —
    // that leaked technical noise + collided on same-prefix ids.
    const P = window.__dshPanelsC
    const nowMs = Date.now()
    recentEl.appendChild(el('div', { className: 'quickchat-recent-head muted', text: 'Recent sessions' }))
    for (const entry of rows) {
      const sid = entry.sessionId || entry.id
      const smart = P && typeof P.smartSessionTitle === 'function'
        ? P.smartSessionTitle({ ...entry, sessionId: sid }, nowMs)
        : { text: entry.title || entry.header?.title || 'Untitled', isUntitled: !entry.title }
      const titleClass = 'quickchat-recent-title' + (smart.isUntitled ? ' quickchat-recent-title-untitled' : '')
      const dot = entry.running ? el('span', { className: 'quickchat-recent-dot live' }) : null
      const row = el('button', {
        className: 'quickchat-recent-row',
        type: 'button',
        title: `Open ${smart.text}`,
        onclick: () => { void jumpToSession(sid) },
      }, [
        dot,
        el('span', { className: titleClass, text: smart.text }),
        el('span', { className: 'quickchat-recent-id muted', text: String(sid).slice(0, 8) }),
      ])
      recentEl.appendChild(row)
    }
  }

  async function jumpToSession(sid) {
    hide()
    try {
      if (window.__dshTabs && typeof window.__dshTabs.switchTo === 'function') {
        window.__dshTabs.switchTo('chat')
      }
      if (window.__dshChat && typeof window.__dshChat.selectSession === 'function') {
        await window.__dshChat.selectSession(sid)
      }
    } catch (err) { console.error('quick-chat jump failed:', err) }
  }

  async function submit() {
    if (!inputEl) return
    const text = inputEl.value.trim()
    if (!text) return
    inputEl.value = ''
    hide()
    // Mint a fresh session and route the prompt through it. We deliberately
    // do NOT reuse the currently-open session in the main chat pane — the reference design's
    // quick chat is understood as "a new thread"; overloading an active one
    // would surprise users who wanted a side channel.
    try {
      const { id } = await window.dsh.newSession()
      if (window.__dshTabs && typeof window.__dshTabs.switchTo === 'function') {
        window.__dshTabs.switchTo('chat')
      }
      if (window.__dshChat && typeof window.__dshChat.selectSession === 'function') {
        await window.__dshChat.selectSession(id)
      }
      await window.dsh.sendPrompt(id, text)
    } catch (err) {
      console.error('quick-chat submit failed:', err)
      // C22 (drift cycle 18): non-blocking modal instead of native alert.
      // Native alert() would freeze the quickchat overlay mid-typing.
      const notify = window.__dshRenderer && window.__dshRenderer.notifyDialog
      if (notify) notify(`Send failed: ${err.message}`)
      else alert(`Send failed: ${err.message}`)
    }
  }

  function show() {
    ensureDom()
    if (open) return
    open = true
    refreshRecent()
    overlayEl.hidden = false
    // Delay focus until after the class flip so the CSS transition can grab
    // its start state cleanly.
    requestAnimationFrame(() => {
      overlayEl.classList.add('quickchat-open')
      if (inputEl) inputEl.focus()
    })
  }

  function hide() {
    if (!open || !overlayEl) return
    open = false
    overlayEl.classList.remove('quickchat-open')
    overlayEl.hidden = true
    if (inputEl) inputEl.value = ''
  }

  function toggle() { open ? hide() : show() }

  window.__dshQuickChat = { show, hide, toggle, refreshRecent }

  // The header trigger button lives in the chat pane; it's optional (the
  // shortcut always works even if the button isn't present).
  //
  // Bind path forks on document.readyState so we work whether this script
  // loaded before or after DOMContentLoaded — the previous version relied
  // on the DOMContentLoaded event, but this script is at the bottom of the
  // HTML, so on some fast paths the event has already fired by the time
  // we register for it and the button silently never wires. Guarded by
  // readyState so we don't double-bind.
  function bindHeader() {
    const btn = document.getElementById('quickchat-open')
    if (btn && !btn.dataset.qcBound) {
      btn.dataset.qcBound = '1'
      btn.addEventListener('click', toggle)
    }
    if (window.dsh && typeof window.dsh.onQuickChatToggle === 'function') {
      window.dsh.onQuickChatToggle(() => toggle())
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindHeader)
  } else {
    bindHeader()
  }
})()
