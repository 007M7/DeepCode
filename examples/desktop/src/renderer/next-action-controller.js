// next-action-controller.js — renderer-side glue that paints the composer
// chip row from the next-actions.js pure engine. Self-contained IIFE; does
// not touch renderer.js state or code.
//
// What it owns:
//   - One NextActionTracker per active session id, so switching sessions
//     never leaks suggestions across conversations.
//   - The `#next-action-chips` row above the composer: hidden when there
//     are zero chips, painted from the tracker on every relevant event.
//   - Per-chip ✕ dismiss buttons that pin a chip id into the tracker's
//     dismiss set (per-session, transient — a session switch resets it).
//   - The verb dispatcher: prompt / open_link / open_artifact /
//     switch_session all funnel through the same handler widgets.js uses,
//     so the two systems stay in sync.
//
// Session switch detection piggybacks on the same DOM hook layout-controller
// uses (the `.active` entry's title attribute in `#sessions`). No new
// coupling to renderer.js internals.

'use strict'

;(function () {
  if (typeof window === 'undefined' || !window.NextActions) return
  const { NextActionTracker, classifyAction } = window.NextActions

  const trackers = new Map()   // sessionId -> NextActionTracker
  let activeSessionId = null
  let rowEl = null
  let bound = false

  function trackerFor(sid) {
    let t = trackers.get(sid)
    if (!t) { t = new NextActionTracker(); trackers.set(sid, t) }
    return t
  }

  function ensureRow() {
    if (rowEl && document.body.contains(rowEl)) return rowEl
    rowEl = document.getElementById('next-action-chips')
    return rowEl
  }

  function paint() {
    const row = ensureRow()
    if (!row) return
    row.textContent = ''
    if (!activeSessionId) { row.hidden = true; return }
    const t = trackerFor(activeSessionId)
    const chips = t.suggest()
    if (!chips || chips.length === 0) { row.hidden = true; return }
    row.hidden = false
    for (const chip of chips) row.appendChild(chipEl(chip, t))
  }

  function chipEl(chip, tracker) {
    const wrap = document.createElement('span')
    wrap.className = 'next-action-chip'
    wrap.dataset.chipId = chip.id
    wrap.dataset.chipVerb = chip.verb || 'prompt'

    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'next-action-chip-btn'
    btn.textContent = chip.label || chip.id
    if (chip.hint) btn.title = chip.hint

    // Mark broken chips (e.g. a rule fired but payload missing) so the row
    // never sports a button that pattern-matches "live but silent". Uses
    // the same classifier widgets.js uses.
    const cls = classifyAction({
      verb: chip.verb,
      prompt: chip.prompt,
      url: chip.url,
      artifactId: chip.artifactId,
      sessionId: chip.sessionId,
      note: chip.note,
    })
    if (cls.broken) {
      btn.disabled = true
      btn.classList.add('next-action-chip-broken')
      btn.title = `unsupported chip — ${cls.reason || 'broken'}`
    } else if (cls.verb && cls.verb.real === false) {
      btn.classList.add('next-action-chip-record')
    }

    btn.addEventListener('click', () => {
      if (btn.disabled) return
      fireVerb(chip)
    })

    const x = document.createElement('button')
    x.type = 'button'
    x.className = 'next-action-chip-dismiss'
    x.setAttribute('aria-label', 'Dismiss this suggestion')
    x.textContent = '×'
    x.title = "don't suggest this again in this session"
    x.addEventListener('click', (e) => {
      e.stopPropagation()
      tracker.dismiss(chip.id)
      paint()
    })

    wrap.append(btn, x)
    return wrap
  }

  function fireVerb(chip) {
    const dsh = window.dsh
    const sid = activeSessionId
    switch (chip.verb) {
      case 'prompt':
      case undefined:
      case null: {
        const t = String(chip.prompt || '')
        if (t && dsh && typeof dsh.sendPrompt === 'function' && sid) {
          void dsh.sendPrompt(sid, t)
        }
        break
      }
      case 'open_link': {
        const url = String(chip.url || '')
        if (url && dsh && typeof dsh.openExternalUrl === 'function') void dsh.openExternalUrl(url)
        break
      }
      case 'open_artifact': {
        const id = String(chip.artifactId || '')
        if (id && dsh && typeof dsh.openArtifact === 'function') void dsh.openArtifact(id)
        break
      }
      case 'switch_session': {
        // No preload primitive; nudge the sidebar to click the item. The
        // renderer's own selectSession is not exported, so we fall through
        // to a synthetic click on the matching li.
        const sidTarget = String(chip.sessionId || '')
        const li = document.querySelector(`#sessions li[title="${cssEscape(sidTarget)}"]`)
        if (li) li.click()
        break
      }
      case 'note': {
        // Record-only: emit a devtools-friendly CustomEvent, no user-world change.
        const detail = { note: String(chip.note || chip.label || 'note'), sessionId: sid, at: Date.now() }
        if (document.body && typeof CustomEvent === 'function') {
          document.body.dispatchEvent(new CustomEvent('dsh:next-action-note', { detail }))
        }
        break
      }
      default: break
    }
  }

  // Minimal CSS.escape shim so this works in older test envs. The renderer
  // context has CSS.escape, so this only matters for defensiveness.
  function cssEscape(s) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s)
    return String(s).replace(/["\\]/g, '\\$&')
  }

  // -- session watch --------------------------------------------------------

  function detectSession() {
    const active = document.querySelector('#sessions li.active')
    const sid = active ? active.title : null
    if (sid !== activeSessionId) {
      activeSessionId = sid
      paint()
    }
  }

  function bindSessionWatcher() {
    const sessions = document.getElementById('sessions')
    if (!sessions) return
    new MutationObserver(detectSession).observe(sessions, {
      subtree: true, childList: true, attributes: true,
    })
    detectSession()
  }

  // -- runtime hook ---------------------------------------------------------

  function handleNotify({ method, params }) {
    if (!params || method !== 'session.event') return
    const sid = params.sessionId
    if (!sid) return
    const t = trackerFor(sid)
    t.push(params.event)
    if (sid === activeSessionId) paint()
  }

  // -- boot -----------------------------------------------------------------

  function boot() {
    if (bound) return
    bound = true
    ensureRow()
    bindSessionWatcher()
    if (window.dsh && typeof window.dsh.onNotify === 'function') {
      window.dsh.onNotify(handleNotify)
    }
    paint()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
