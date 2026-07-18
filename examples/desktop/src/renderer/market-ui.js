// Plugins tab · Browse subview (plugin marketplace, demo-tier curated index).
//
// Row-list style row list layout (2026-07-16 redesign lane):
//   ┌────────────────────────────────────────────────────────────┐
//   │ Plugin marketplace                                         │  ← big title
//   │ Curated demo index — install writes a user overlay patch.  │  ← subtitle
//   │ [ Search plugins…                                       ]  │  ← search
//   │                                                            │
//   │ Installed  ● ● ● ● ●                              5 active │  ← icon strip
//   │ ─────────────────────────────────────────────────────────  │
//   │ ⬛  Web tools                                    [Install]  │
//   │     Model-facing web_search and web_fetch tools…           │  ← row card
//   │ ⬛  Filesystem tools                       [Installed ✓]    │
//   │     Read/write files with an approval-gated seam…          │
//   └────────────────────────────────────────────────────────────┘
//
// This module intentionally does NOT modify plugins-ui.js — the playground
// agent holds edits on that file. Instead it grafts a subnav onto the
// existing Plugins pane at load time, wraps the current table in an
// "Installed" panel, and adds a sibling "Browse" panel that renders the
// market index as a Row-list style row list.
//
// All layout uses CSS variables (var(--bg), var(--border), var(--accent),
// var(--ok), var(--tool), var(--error), var(--muted), var(--text)) so it
// re-skins for free under the redesign lane's dsv4 theme swap.
//
// Install/uninstall calls the market IPC, which mutates the user overlay
// through the same plugins.addPatch/togglePatch path plugins.js writes to,
// then this module asks plugins-ui to refresh (so the Installed panel picks
// up the change) and flips its own `dirty` flag so "Apply + restart" lights
// up in the sidebar exactly as it would after a manual toggle.
//
// See config/plugin-index.json for the curated index shape.

'use strict'

;(function () {
  const state = {
    lastList: null, // last market:list response
    initialized: false,
    query: '',      // current search string (case-insensitive substring match)
  }

  // ---- DOM scaffolding ----------------------------------------------------
  //
  // Grafting rather than editing index.html: we wrap the existing table in an
  // "Installed" panel, insert a "Browse" panel next to it, and put a subnav
  // in the header row. All idempotent — safe to call once at DOMContentLoaded.
  function ensureScaffold() {
    if (state.initialized) return
    const pane = document.querySelector('.pane[data-pane="plugins"]')
    if (!pane) return
    const body = pane.querySelector('.plugins-body')
    const meta = document.getElementById('plugins-meta')
    const table = document.getElementById('plugins-table')
    if (!body || !meta || !table) return

    // "创造" (Create) zone — the DSH-native block that sits above the
    // Installed / Browse subnav. This is what the plugins page is *for*:
    // Vibe (agent writes a plugin for itself) and Playground (try before
    // apply). Two big cards that mirror the header buttons; keeping the
    // header buttons around because they're keyboard-reachable from the
    // Installed table workflow — the cards are the discoverable entry.
    const createZone = document.createElement('section')
    createZone.className = 'plugins-create-zone'
    createZone.dataset.zone = 'create'
    createZone.innerHTML = `
      <div class="create-zone-head">
        <h2 class="create-zone-title">Create</h2>
        <p class="create-zone-sub muted">DSH-only: let the agent write a plugin for itself, or try one before you apply it.</p>
      </div>
      <div class="create-zone-cards">
        <button class="create-card" data-create="vibe" type="button">
          <span class="create-card-glyph" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none"
                 stroke="currentColor" stroke-width="1.5"
                 stroke-linecap="round" stroke-linejoin="round">
              <path d="M6 3h9l4 4v14H6z"/>
              <path d="M14 3v5h5"/>
              <path d="M9.5 14.5c1-1.2 2.2-1.2 3 0s2 1.2 3 0"/>
              <circle cx="10.5" cy="11" r="0.6" fill="currentColor"/>
              <circle cx="13.5" cy="11" r="0.6" fill="currentColor"/>
            </svg>
          </span>
          <span class="create-card-body">
            <span class="create-card-title">Vibe a plugin</span>
            <span class="create-card-sub">Let the agent write a plugin for you — right in this session.</span>
            <span class="create-card-hint muted">
              Start a chat scoped with the self-referential cordis toolset; the agent authors and installs a new plugin without leaving the session.
            </span>
          </span>
          <span class="create-card-cta">
            <span class="create-card-cta-label">Start</span>
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none"
                 stroke="currentColor" stroke-width="1.6"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M5 3l5 5-5 5"/>
            </svg>
          </span>
        </button>
        <button class="create-card" data-create="playground" type="button">
          <span class="create-card-glyph" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none"
                 stroke="currentColor" stroke-width="1.5"
                 stroke-linecap="round" stroke-linejoin="round">
              <rect x="3.5" y="4.5" width="17" height="14" rx="2"/>
              <path d="M3.5 8.5h17"/>
              <path d="M6.5 6.4v.05M9 6.4v.05"/>
              <path d="M9 13.5l2.5 2 4-4.5"/>
            </svg>
          </span>
          <span class="create-card-body">
            <span class="create-card-title">Playground</span>
            <span class="create-card-sub">Try an overlay in an isolated runtime — apply when you like it.</span>
            <span class="create-card-hint muted">
              A scratch runtime: edit the overlay, send a message, see the effect. Nothing is written back until you hit Apply.
            </span>
          </span>
          <span class="create-card-cta">
            <span class="create-card-cta-label">Open</span>
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none"
                 stroke="currentColor" stroke-width="1.6"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M5 3l5 5-5 5"/>
            </svg>
          </span>
        </button>
      </div>
    `
    body.insertBefore(createZone, body.firstChild)

    // Delegate clicks to the header buttons so we don't duplicate the
    // vibe/playground handlers (which sit in plugins-ui.js / renderer.js).
    // If the header button is disabled we surface that on the card too,
    // and `syncCreateZone` (called from plugins-ui.js on each refresh) keeps
    // the disabled state and reason in sync.
    //
    // B-P0-2 fix (2026-07-16): the Vibe card used to grey out with a note
    // reading "切到 stdio-vibe-deepseek 开启" — but nothing in the shell
    // actually switched profiles for you, and the Profile dropdown sits
    // three panels away. A first-time user read the hint, went hunting,
    // couldn't find that entry, and gave up. When the card is gated on a
    // profile switch, clicking it now offers to flip the profile directly
    // via the runtime supervisor. On success the runtime restart triggers
    // the normal refresh chain and the card unlocks.
    for (const card of createZone.querySelectorAll('.create-card')) {
      card.addEventListener('click', async () => {
        if (card.dataset.create === 'vibe' && card.getAttribute('data-disabled') === 'gate') {
          const target = card.dataset.vibeSwitchTo
          if (!target) return
          const label = card.querySelector('.create-card-cta-label')
          const original = label ? label.textContent : ''
          if (label) label.textContent = 'Switching…'
          try {
            await window.dsh.startRuntime(target)
            // The runtime status listener + refreshSessionList clear will
            // repaint everything; also poke the plugins module explicitly so
            // syncCreateZone runs against the new profileName without waiting
            // for a tab click.
            if (window.__dshPlugins && typeof window.__dshPlugins.refresh === 'function') {
              await window.__dshPlugins.refresh()
            }
          } catch (err) {
            alert(`Profile switch failed: ${err && err.message ? err.message : err}`)
          } finally {
            if (label) label.textContent = original
          }
          return
        }
        if (card.hasAttribute('data-disabled')) return
        const target = card.dataset.create === 'vibe'
          ? document.getElementById('plugins-vibe')
          : document.getElementById('plugins-playground')
        if (target && !target.disabled) target.click()
      })
    }

    // Subview tabs sit below the Create zone. The Create zone stays visible
    // across both subviews — it's the page identity, not tab content. The
    // Installed meta strip + diagnostics remain scoped to the Installed panel.
    const subnav = document.createElement('div')
    subnav.className = 'plugins-subnav'
    subnav.innerHTML = `
      <button class="plugins-subnav-btn active" data-subview="installed">Installed</button>
      <button class="plugins-subnav-btn" data-subview="browse">Browse</button>
    `
    body.insertBefore(subnav, meta)

    // Wrap existing installed elements in a panel div so we can hide them
    // wholesale. The diagnostics strip is created lazily by plugins-ui.js;
    // we grab it if present + move it into the panel too.
    const installedPanel = document.createElement('div')
    installedPanel.className = 'plugins-subpanel installed'
    installedPanel.dataset.subview = 'installed'
    const diag = document.getElementById('plugins-diagnostics')
    if (diag) installedPanel.appendChild(diag)
    installedPanel.appendChild(meta)
    installedPanel.appendChild(table)
    body.appendChild(installedPanel)

    // Browse panel: Row-list style header + search + installed-strip + row list.
    // Structure is fixed here; renderMeta/renderInstalledStrip/renderList
    // only touch the inner children by id.
    const browsePanel = document.createElement('div')
    browsePanel.className = 'plugins-subpanel browse'
    browsePanel.dataset.subview = 'browse'
    browsePanel.hidden = true
    browsePanel.innerHTML = `
      <header class="market-hero">
        <h2 class="market-hero-title">Plugin marketplace</h2>
        <p class="market-hero-sub">
          Curated demo index. Installing writes a user overlay patch — same data
          as the Installed tab. For hand-written or one-off plugins, use
          <em>Vibe a plugin</em> in the Playground instead.
        </p>
        <div class="market-search">
          <input type="search" id="market-search-input"
                 placeholder="Search plugins by name, description, or tag…"
                 autocomplete="off" spellcheck="false" />
          <span class="market-meta" id="market-meta"></span>
        </div>
      </header>
      <section class="market-installed-strip" id="market-installed-strip"></section>
      <div class="market-divider" role="separator" aria-hidden="true"></div>
      <div id="market-import-mount"></div>
      <div class="market-divider" role="separator" aria-hidden="true"></div>
      <ul class="market-list" id="market-list" role="list"></ul>
    `
    body.appendChild(browsePanel)

    // "Import from…" panel between the installed strip
    // and the curated list. Answers the audit's §3.1 gap ("can I bring in an
    // open-source project?") by writing directly through plugins.add. The
    // module ships as a separate file so tests can drive the pure DOM builder
    // without wiring up the whole Browse subview.
    if (globalThis.__dshMarketImport && typeof globalThis.__dshMarketImport.buildImportPanel === 'function') {
      const mount = browsePanel.querySelector('#market-import-mount')
      if (mount) {
        const panel = globalThis.__dshMarketImport.buildImportPanel(document, {
          onImport: async ({ id, name }) => {
            await window.dsh.plugins.add(id, name)
            if (window.__dshPlugins && typeof window.__dshPlugins.setDirty === 'function') {
              window.__dshPlugins.setDirty(true)
            }
            await refresh()
            if (window.__dshPlugins && typeof window.__dshPlugins.refresh === 'function') {
              void window.__dshPlugins.refresh()
            }
          },
        })
        mount.appendChild(panel)
      }
    }

    for (const btn of subnav.querySelectorAll('.plugins-subnav-btn')) {
      btn.addEventListener('click', () => switchSubview(btn.dataset.subview))
    }

    const search = browsePanel.querySelector('#market-search-input')
    search.addEventListener('input', () => {
      state.query = search.value.trim().toLowerCase()
      renderListBody()
    })

    state.initialized = true
  }

  function switchSubview(name) {
    for (const btn of document.querySelectorAll('.plugins-subnav-btn')) {
      btn.classList.toggle('active', btn.dataset.subview === name)
    }
    for (const panel of document.querySelectorAll('.plugins-subpanel')) {
      panel.hidden = panel.dataset.subview !== name
    }
    if (name === 'browse') void refresh()
  }

  // ---- market rendering ---------------------------------------------------

  function permBadgeClass(perm) {
    switch (perm) {
      case 'net': return 'perm-net'
      case 'fs': return 'perm-fs'
      case 'subprocess': return 'perm-subprocess'
      default: return 'perm-other'
    }
  }

  function permLabel(perm) {
    switch (perm) {
      case 'net': return 'needs network'
      case 'fs': return 'reads/writes files'
      case 'subprocess': return 'spawns processes'
      default: return perm
    }
  }

  function renderMeta(list) {
    const el = document.getElementById('market-meta')
    if (!el) return
    const bits = []
    bits.push(`source <code>${escapeHtml(list.source)}</code>`)
    if (list.updatedAt) bits.push(`updated ${escapeHtml(list.updatedAt)}`)
    bits.push(`${list.rows.length} plugin${list.rows.length === 1 ? '' : 's'}`)
    if (list.skipped && list.skipped.length > 0) {
      bits.push(`<span class="warn">${list.skipped.length} skipped</span>`)
    }
    el.innerHTML = bits.join(' · ')
  }

  // Row-list style icon row: small square avatars for every installed plugin,
  // hover for title. Clicking scrolls the row list to that plugin so users
  // can drill from "what's on" → "what does this one do?" without leaving the
  // Browse subview. Empty state = a hint rather than an empty band.
  function renderInstalledStrip(list) {
    const strip = document.getElementById('market-installed-strip')
    if (!strip) return
    const installed = list.rows.filter((r) => r.status === 'installed' || r.status === 'disabled')
    strip.innerHTML = ''
    const header = document.createElement('div')
    header.className = 'market-installed-header'
    const label = document.createElement('span')
    label.className = 'market-installed-label'
    label.textContent = 'Installed'
    const count = document.createElement('span')
    count.className = 'market-installed-count muted'
    count.textContent = installed.length === 0
      ? 'nothing installed yet'
      : `${installed.length} active`
    header.appendChild(label)
    header.appendChild(count)
    strip.appendChild(header)

    if (installed.length === 0) return

    const icons = document.createElement('div')
    icons.className = 'market-installed-icons'
    for (const entry of installed) {
      const row = entry.row
      const btn = document.createElement('button')
      btn.className = 'market-installed-icon' + (entry.status === 'disabled' ? ' is-disabled' : '')
      btn.type = 'button'
      btn.title = `${row.title}${entry.status === 'disabled' ? ' (disabled)' : ''} — click to view details`
      btn.textContent = initialsFor(row.title)
      btn.addEventListener('click', () => scrollToRow(row.id))
      icons.appendChild(btn)
    }
    strip.appendChild(icons)
  }

  // Row card: one horizontal card per plugin. Icon (left) + name/description
  // (center, grows) + permissions + install button (right). Keeps everything
  // above the fold at 1024px without wrapping the primary action off-screen.
  function renderRow(entry) {
    const row = entry.row
    const li = document.createElement('li')
    li.className = 'market-row'
    li.dataset.marketId = row.id
    if (entry.status === 'installed') li.classList.add('is-installed')
    if (entry.status === 'disabled') li.classList.add('is-disabled')

    const permsHtml = (row.permissions || []).map((p) =>
      `<span class="market-perm ${permBadgeClass(p)}" title="${escapeHtml(permLabel(p))}">${escapeHtml(p)}</span>`
    ).join('')

    let primaryLabel = 'Install'
    let primaryClass = 'primary'
    let primaryDisabled = ''
    if (entry.status === 'installed') {
      primaryLabel = 'Installed ✓'
      primaryClass = 'ghost is-installed'
      primaryDisabled = 'disabled'
    } else if (entry.status === 'disabled') {
      primaryLabel = 'Enable'
      primaryClass = 'primary is-disabled'
    }

    const canUninstall = entry.installSource === 'user'
    const uninstallBtn = canUninstall
      ? `<button class="ghost market-uninstall" data-action="uninstall"
                title="Remove the overlay patch that installed this plugin.">Uninstall</button>`
      : (entry.installSource === 'base'
        ? `<span class="muted market-basehint"
                 title="This entry ships with the base leaf; disable it from the Installed tab if you don't want it.">ships in base</span>`
        : '')

    li.innerHTML = `
      <div class="market-row-icon" aria-hidden="true">${escapeHtml(initialsFor(row.title))}</div>
      <div class="market-row-body">
        <div class="market-row-topline">
          <h3 class="market-row-title">${escapeHtml(row.title)}</h3>
          <span class="market-row-package"><code>${escapeHtml(row.package)}</code></span>
          <span class="market-row-author muted">by ${escapeHtml(row.author || 'unknown')}</span>
        </div>
        <p class="market-row-desc">${escapeHtml(row.description)}</p>
        ${permsHtml ? `<div class="market-row-perms">${permsHtml}</div>` : ''}
      </div>
      <div class="market-row-actions">
        <button class="${primaryClass} market-primary" data-action="install" ${primaryDisabled}>${primaryLabel}</button>
        ${uninstallBtn}
      </div>
    `

    const installBtn = li.querySelector('[data-action="install"]')
    if (installBtn && entry.status !== 'installed') {
      installBtn.addEventListener('click', () => onInstall(row.id, installBtn))
    }
    const uninBtn = li.querySelector('[data-action="uninstall"]')
    if (uninBtn) uninBtn.addEventListener('click', () => onUninstall(row.id, uninBtn))
    return li
  }

  // Match query against title, id, description, author, tags. Empty query
  // returns everything. Kept in the render layer because it's purely a view
  // filter; state.lastList stays untouched so refresh() doesn't have to
  // re-hydrate on every keystroke.
  function matchesQuery(entry, q) {
    if (!q) return true
    const row = entry.row
    const hay = [
      row.title, row.id, row.description, row.author,
      ...(row.tags || []),
    ].join(' ').toLowerCase()
    return hay.includes(q)
  }

  function renderListBody() {
    const list = state.lastList
    const ul = document.getElementById('market-list')
    if (!ul || !list) return
    ul.innerHTML = ''
    const filtered = list.rows.filter((e) => matchesQuery(e, state.query))
    if (filtered.length === 0) {
      const empty = document.createElement('li')
      empty.className = 'market-empty'
      empty.textContent = state.query
        ? `No plugins match “${state.query}”.`
        : 'No plugins in the curated index.'
      ul.appendChild(empty)
      return
    }
    for (const entry of filtered) ul.appendChild(renderRow(entry))
  }

  function scrollToRow(id) {
    const ul = document.getElementById('market-list')
    if (!ul) return
    const li = ul.querySelector(`[data-market-id="${cssEscape(id)}"]`)
    if (!li) return
    li.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    li.classList.add('is-highlight')
    setTimeout(() => li.classList.remove('is-highlight'), 900)
  }

  async function refresh() {
    ensureScaffold()
    try {
      const list = await window.dsh.market.list()
      state.lastList = list
      renderMeta(list)
      renderInstalledStrip(list)
      renderListBody()
    } catch (err) {
      const ul = document.getElementById('market-list')
      if (ul) {
        ul.innerHTML = ''
        const box = document.createElement('li')
        box.className = 'market-error'
        box.textContent = `market unavailable: ${err.message}`
        ul.appendChild(box)
      }
    }
  }

  async function onInstall(id, btn) {
    const original = btn.textContent
    btn.disabled = true
    btn.textContent = 'Installing…'
    try {
      await window.dsh.market.install(id)
      // Nudge the shared "dirty" flag so the sidebar's Apply button lights
      // up. plugins-ui exports setDirty for exactly this cross-module case.
      if (window.__dshPlugins && typeof window.__dshPlugins.setDirty === 'function') {
        window.__dshPlugins.setDirty(true)
      }
      await refresh()
      if (window.__dshPlugins && typeof window.__dshPlugins.refresh === 'function') {
        void window.__dshPlugins.refresh()
      }
    } catch (err) {
      btn.disabled = false
      btn.textContent = original
      alert(`install failed: ${err.message}`)
    }
  }

  async function onUninstall(id, btn) {
    if (!window.confirm('Remove this plugin from the user overlay?')) return
    const original = btn.textContent
    btn.disabled = true
    btn.textContent = 'Removing…'
    try {
      await window.dsh.market.uninstall(id)
      if (window.__dshPlugins && typeof window.__dshPlugins.setDirty === 'function') {
        window.__dshPlugins.setDirty(true)
      }
      await refresh()
      if (window.__dshPlugins && typeof window.__dshPlugins.refresh === 'function') {
        void window.__dshPlugins.refresh()
      }
    } catch (err) {
      btn.disabled = false
      btn.textContent = original
      alert(`uninstall failed: ${err.message}`)
    }
  }

  // ---- helpers ------------------------------------------------------------

  // Shared with playground-ui, plugins-ui, bench-page — see html-escape.js.
  const escapeHtml = (window.__dshHtmlEscape || {}).escapeHtml
    || ((s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])))

  // CSS.escape polyfill for the older harnesses; safe for our id shapes.
  function cssEscape(s) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(s)
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&')
  }

  function initialsFor(title) {
    const words = String(title || '').split(/\s+/).filter(Boolean)
    if (words.length === 0) return '·'
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
    return (words[0][0] + words[1][0]).toUpperCase()
  }

  // Kick scaffold on load; render on first Browse open. Kept out of the
  // eager path so a slow market:list doesn't block the tab.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureScaffold, { once: true })
  } else {
    ensureScaffold()
  }

  // Called by plugins-ui.js after it reads plugins.list() so the Vibe card
  // reflects the same gate as the header button. Playground has no runtime
  // gate right now, so it stays enabled unless the header button is disabled
  // by other code (kept in sync for symmetry).
  //
  // B-P0-2 (2026-07-16): when Vibe is gated on a non-vibe-capable profile,
  // annotate the card with the target vibe profile so the click handler can
  // switch to it directly instead of asking the user to hunt through the
  // dropdown. The target is looked up from window.dsh.listProfiles(); when
  // no vibe-capable profile is registered, the hint falls back to the older
  // "add a vibe-capable profile" wording so users don't chase a phantom.
  async function syncCreateZone(list) {
    let vibeTarget = null
    if (window.dsh && typeof window.dsh.listProfiles === 'function') {
      try {
        const registered = await window.dsh.listProfiles()
        if (Array.isArray(registered)) {
          // Prefer stdio-vibe-deepseek explicitly (matches the profile name
          // main.js:588 hard-codes in the error path); otherwise pick the
          // first entry whose id contains "vibe".
          const preferred = registered.find((p) => p && p.id === 'stdio-vibe-deepseek')
          const fallback = registered.find((p) => p && typeof p.id === 'string' && p.id.includes('vibe'))
          const pick = preferred || fallback
          if (pick) vibeTarget = pick.id
        }
      } catch (_) { /* leave null; the card falls back to the guidance hint */ }
    }
    for (const card of document.querySelectorAll('.plugins-create-zone .create-card')) {
      const btnId = card.dataset.create === 'vibe' ? 'plugins-vibe' : 'plugins-playground'
      const btn = document.getElementById(btnId)
      const disabled = !!(btn && btn.disabled)
      // The CTA label lives on a separate span so we can flip it when a card's
      // state changes (Start / Switch profile / Unavailable) without
      // rebuilding the button. Cached here so all three branches below can
      // reach for it consistently.
      const ctaLabel = card.querySelector('.create-card-cta-label')
      const defaultCtaText = card.dataset.create === 'vibe' ? 'Start' : 'Open'
      // Vibe also carries a reason string via list.vibeCapable/profileName; we
      // surface that inline instead of just greying out silently.
      if (card.dataset.create === 'vibe' && list && !list.vibeCapable) {
        card.setAttribute('data-disabled', 'gate')
        card.setAttribute('aria-disabled', 'true')
        const hint = card.querySelector('.create-card-hint')
        if (vibeTarget) {
          card.dataset.vibeSwitchTo = vibeTarget
          // NEW-6.1 fix (2026-07-16): drop the "Click to switch" imperative
          // — the CTA chip on the right already says "Switch profile", so
          // the hint should be a stateful description like Playground's.
          // Two cards, same interaction grammar: read hint, act on chip.
          if (hint) hint.textContent = `Current profile can't self-write plugins. Switch to "${vibeTarget}" to enable Vibe.`
          if (ctaLabel) ctaLabel.textContent = 'Switch profile'
        } else {
          delete card.dataset.vibeSwitchTo
          // No target profile registered — no action to take. Fall back to
          // the hard-disabled state so the chip hides (nothing to click).
          card.setAttribute('data-disabled', 'unavailable')
          if (hint) hint.textContent = `Need a vibe-capable profile (current: ${list.profileName || 'unknown'}). Register one in config/ first.`
          if (ctaLabel) ctaLabel.textContent = 'Unavailable'
        }
      } else if (disabled) {
        card.setAttribute('data-disabled', 'runtime')
        card.setAttribute('aria-disabled', 'true')
        delete card.dataset.vibeSwitchTo
        if (ctaLabel) ctaLabel.textContent = defaultCtaText
      } else {
        card.removeAttribute('data-disabled')
        card.removeAttribute('aria-disabled')
        delete card.dataset.vibeSwitchTo
        if (ctaLabel) ctaLabel.textContent = defaultCtaText
      }
    }
  }

  window.__dshMarket = { refresh, switchSubview, syncCreateZone }
})()
