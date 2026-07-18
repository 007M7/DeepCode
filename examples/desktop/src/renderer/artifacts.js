// Renderer-side artifact card: inline entry point in the chat stream that
// opens the artifact in the system browser. Deliberately not a webview — the
// demo shell only hosts the entry point per the RFC (2026-07-13 §Deliberate
// exclusions, "No embedded GUI pane").
//
// Density-spec §2 L0 shape (user-flagged 2026-07-18): each artifact renders
// as a single ~28px row — small icon + filename + kind/version chips + live
// dot + tiny right-aligned `open ↗` link. Clicking the row toggles a native
// <details> L1 body that carries the full path and the ghost "Open in
// browser" button. Consecutive .artifact-card siblings render as a visual
// group (shared border, zero gap between rows) via CSS `:has()`.
//
// Two triggers:
//   1. tool/result carrying a file write inside the artifact dir (detected
//      by main.js and re-broadcast as `artifact:event`).
//   2. debug menu "mock: artifact" button (window.dsh.mockArtifact).
//
// De-dup: one card per artifactId per stream. If a re-declare fires the
// existing card bumps its version + flashes.

'use strict'

;(function () {
  const streamEl = () => document.getElementById('stream')

  // artifactId -> DOM element, so a same-path re-declare updates in place.
  const cards = new Map()

  // Kind-to-SVG map — inline stroke icons (currentColor, 1.6px stroke) so
  // artifact rows match the minimalist icon language rather than sitting
  // on emoji glyphs. Fallback is the paperclip glyph used elsewhere for
  // context-family cards.
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

  function ensureCard(entry) {
    const existing = cards.get(entry.artifactId)
    if (existing) {
      updateCard(existing, entry)
      return existing
    }
    const el = renderCard(entry)
    cards.set(entry.artifactId, el)
    const s = streamEl()
    if (s) appendGrouped(s, el)
    scrollToBottom()
    return el
  }

  // Fuse consecutive artifact cards into an `.artifact-group` wrapper so
  // the list reads as one clumped block. The stream itself has a 12px
  // flex `gap` that a plain negative margin can't undo; the wrapper owns
  // its own zero-gap layout so grouped rows sit flush.
  function appendGrouped(stream, el) {
    const last = stream.lastElementChild
    if (last && last.classList && last.classList.contains('artifact-group')) {
      last.appendChild(el)
      return
    }
    if (last && last.classList && last.classList.contains('artifact-card')) {
      // Previous artifact is a lone card — promote it and the new one
      // into a fresh group.
      const group = document.createElement('div')
      group.className = 'artifact-group'
      stream.replaceChild(group, last)
      group.appendChild(last)
      group.appendChild(el)
      return
    }
    stream.appendChild(el)
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
    // <details> is the L0 row shell. `open=false` keeps rows collapsed by
    // default; clicking anywhere on the <summary> toggles the L1 body.
    const el = document.createElement('details')
    el.className = 'artifact-card'
    el.dataset.artifactId = entry.artifactId
    el.dataset.version = String(entry.version || 1)

    // ---- L0 summary row ------------------------------------------------
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

    const verEl = document.createElement('span')
    verEl.className = 'artifact-version'
    verEl.textContent = `v${entry.version || 1}`

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

    // ---- L1 inline body (lazy content, structure is there for a11y) ----
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
    // Reflow trick so re-adding the class re-triggers the animation for a
    // rapid second update.
    void el.offsetWidth
    setTimeout(() => el.classList.remove('artifact-flash'), 900)
  }

  function onArtifactEvent(entry) {
    if (!entry || !entry.artifactId) return
    ensureCard(entry)
  }

  // Debug menu button — mocks a write into the artifact dir via IPC.
  function bindMockButton() {
    const btn = document.getElementById('mock-artifact')
    if (!btn) return
    btn.addEventListener('click', async () => {
      btn.disabled = true
      try {
        await window.dsh.mockArtifact()
      } catch (err) {
        console.error('mockArtifact failed', err)
      } finally {
        btn.disabled = false
      }
    })
  }

  // Wire up once the DOM + preload bridge are ready. The renderer script tag
  // is loaded after this one, so we just register the listener eagerly.
  if (window.dsh && typeof window.dsh.onArtifact === 'function') {
    window.dsh.onArtifact(onArtifactEvent)
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindMockButton)
  } else {
    bindMockButton()
  }

  // Expose the small API for the smoke tests + potential renderer-side reuse.
  window.__dshArtifacts = { onArtifactEvent, cards }
})()
