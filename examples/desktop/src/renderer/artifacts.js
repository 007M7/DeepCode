// Renderer-side artifact card: inline entry point in the chat stream that
// opens the artifact in the system browser. Deliberately not a webview — the
// demo shell only hosts the entry point per the RFC (2026-07-13 §Deliberate
// exclusions, "No embedded GUI pane").
//
// Two triggers:
//   1. tool/result carrying a file write inside the artifact dir (detected
//      by main.js and re-broadcast as `artifact:event`).
//   2. debug menu "mock: artifact" button (window.dsh.mockArtifact).
//
// Card layout:
//   [icon] filename.html · html            v3   [ Open in browser ]
//                          (kind badge)
// Live indicator dot: green when the shell's server has broadcast a version
// bump within the last 2s (live reload just fired).
//
// De-dup: one card per artifactId per stream. If a re-declare fires the
// existing card bumps its version + flashes.

'use strict'

;(function () {
  const streamEl = () => document.getElementById('stream')

  // artifactId -> DOM element, so a same-path re-declare updates in place.
  const cards = new Map()

  // Kind-to-SVG map — inline stroke icons (currentColor, 1.6px stroke) so
  // artifact cards match the minimalist icon language rather than sitting
  // on emoji glyphs. Fallback below in ensureCard() falls back to the
  // paperclip glyph used elsewhere for context-family cards.
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
    if (s) s.appendChild(el)
    scrollToBottom()
    return el
  }

  function renderCard(entry) {
    const el = document.createElement('div')
    el.className = 'artifact-card'
    el.dataset.artifactId = entry.artifactId
    el.dataset.version = String(entry.version || 1)

    const iconEl = document.createElement('span')
    iconEl.className = 'artifact-icon'
    iconEl.innerHTML = ICON_SVG[entry.kind] || ICON_FALLBACK

    const bodyEl = document.createElement('div')
    bodyEl.className = 'artifact-body'
    const nameEl = document.createElement('div')
    nameEl.className = 'artifact-name'
    nameEl.textContent = entry.artifactId
    nameEl.title = entry.path || entry.artifactId
    const metaEl = document.createElement('div')
    metaEl.className = 'artifact-meta'
    metaEl.innerHTML = ''
    const kindEl = document.createElement('span')
    kindEl.className = 'artifact-kind'
    kindEl.textContent = entry.kind || 'file'
    const verEl = document.createElement('span')
    verEl.className = 'artifact-version'
    verEl.textContent = `v${entry.version || 1}`
    const dotEl = document.createElement('span')
    dotEl.className = 'artifact-live-dot'
    dotEl.title = 'live: SSE reload channel active'
    metaEl.append(kindEl, verEl, dotEl)
    bodyEl.append(nameEl, metaEl)

    const openBtn = document.createElement('button')
    openBtn.type = 'button'
    openBtn.className = 'artifact-open primary'
    openBtn.textContent = 'Open in browser'
    openBtn.addEventListener('click', async () => {
      openBtn.disabled = true
      try {
        const r = await window.dsh.openArtifact(entry.artifactId)
        if (r && r.ok) {
          openBtn.textContent = 'Opened ↗'
          setTimeout(() => { openBtn.textContent = 'Open in browser'; openBtn.disabled = false }, 1500)
        } else {
          openBtn.textContent = 'Failed'
          setTimeout(() => { openBtn.textContent = 'Open in browser'; openBtn.disabled = false }, 1500)
        }
      } catch (err) {
        openBtn.textContent = 'Error'
        console.error('openArtifact failed', err)
        setTimeout(() => { openBtn.textContent = 'Open in browser'; openBtn.disabled = false }, 1500)
      }
    })

    el.append(iconEl, bodyEl, openBtn)
    // Kick a fresh-flash so the arrival is noticeable.
    flash(el)
    return el
  }

  function updateCard(el, entry) {
    el.dataset.version = String(entry.version || 1)
    const ver = el.querySelector('.artifact-version')
    if (ver) ver.textContent = `v${entry.version || 1}`
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
