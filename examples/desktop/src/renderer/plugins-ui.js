// Plugins tab renderer: reads window.dsh.plugins.list() and paints the
// effective plugin table; toggles/adds mutate the overlay via the preload
// bridge, then a single "Apply + restart" click respawns the daemon so the
// changes take effect.
//
// Design notes:
//   - The tab keeps a "dirty" flag; toggles do NOT auto-restart because the
//     daemon respawn cost is high enough that batching wins during setup.
//   - Vibe entry point is gated on plugins.list().vibeCapable so the mock
//     profile shows it visibly disabled with a tooltip explanation, rather
//     than hiding it entirely.
//   - Adding a plugin is a small prompt-flow: user types id + name; we do
//     the light validation and pass through to plugins.add(). The demo
//     doesn't have a package browser — that's a future enhancement.

'use strict'

;(function () {
  const state = {
    dirty: false,
    lastList: null,
    lastDiagnostics: [],
    lastRuntime: null,
  }

  // B-P0-1 fix (2026-07-16): the runtime column used to render the raw
  // internal state names (`active`, `absent`, `pending`, …), which read as
  // "nothing installed" for a first-time user. Translate each state to a
  // plain-language phrase with an optional hint clarifying the failure mode.
  // Raw states remain on the hover for operators. English kept to match the
  // demo-audience default (see C-P0-2 ruling 2026-07-16).
  const RUNTIME_LABEL = {
    active: { text: 'Running' },
    loading: { text: 'Loading' },
    pending: { text: 'Waiting on deps', hint: 'blocked until another plugin loads' },
    failed: { text: 'Failed', hint: 'see the diagnostic row below' },
    disposed: { text: 'Disposed' },
    unloading: { text: 'Unloading' },
    absent: { text: 'Not loaded', hint: 'Apply + restart runtime to activate' },
  }

  const tbody = document.getElementById('plugins-tbody')
  const meta = document.getElementById('plugins-meta')
  const applyBtn = document.getElementById('plugins-apply')
  const refreshBtn = document.getElementById('plugins-refresh')
  const addBtn = document.getElementById('plugins-add')
  const vibeBtn = document.getElementById('plugins-vibe')
  const sidebarNote = document.getElementById('plugins-sidebar-note')
  // Diagnostics summary strip at the top of the plugin body. Created lazily
  // if the host document didn't declare it (keeps the index.html edit small).
  let diagStrip = document.getElementById('plugins-diagnostics')
  if (!diagStrip) {
    const body = document.querySelector('.plugins-body')
    if (body) {
      diagStrip = document.createElement('div')
      diagStrip.id = 'plugins-diagnostics'
      diagStrip.className = 'plugins-diagnostics'
      body.insertBefore(diagStrip, body.firstChild)
    }
  }
  // A3 effect-heuristics info bar. Sits above the diagnostics strip. Same
  // lazy-create pattern: declaring it in index.html isn't required, so this
  // file stays the only touchpoint when the summary shape evolves.
  let summaryBar = document.getElementById('plugins-summary')
  if (!summaryBar) {
    const body = document.querySelector('.plugins-body')
    if (body) {
      summaryBar = document.createElement('div')
      summaryBar.id = 'plugins-summary'
      summaryBar.className = 'plugins-summary'
      body.insertBefore(summaryBar, diagStrip || body.firstChild)
    }
  }

  function setDirty(dirty) {
    state.dirty = dirty
    applyBtn.disabled = !dirty
    sidebarNote.textContent = dirty
      ? 'Overlay edited. Apply to restart the runtime.'
      : 'No unsaved changes.'
    sidebarNote.classList.toggle('dirty', dirty)
  }

  function renderMeta(list) {
    const bits = []
    bits.push(`profile: <code>${escapeHtml(list.profileName || '')}</code>`)
    bits.push(`base leaf: <code>${escapeHtml(list.base)}</code>`)
    bits.push(list.overlayExists
      ? `overlay: <code>${escapeHtml(list.overlayPath)}</code>`
      : `overlay: <em class="muted">(none — using base directly)</em>`)
    bits.push(list.vibeCapable
      ? `vibe: <span class="ok">available</span>`
      : `vibe: <span class="muted">disabled (switch to a vibe-capable profile)</span>`)
    meta.innerHTML = bits.join(' &nbsp;·&nbsp; ')
  }

  // Group diagnostics by id (for row anchoring) + `overall` (for the strip).
  function bucketDiagnostics(diags) {
    const byId = new Map()
    const overall = []
    for (const d of diags) {
      if (d.scope === 'overall' && !d.id) { overall.push(d); continue }
      const key = d.id || `line-${d.line}`
      if (!byId.has(key)) byId.set(key, [])
      byId.get(key).push(d)
    }
    return { byId, overall }
  }

  // A3 effect-heuristics bar. Not a diagnostics surface — every field is an
  // at-a-glance fact. The near-name conflict field only appears when there's
  // a pair to surface; likewise the tool-count warning.
  function renderSummaryBar(summary) {
    if (!summaryBar) return
    if (!summary) { summaryBar.innerHTML = ''; return }
    const bits = []
    // Preflight (2026-07-18) blind-test #9a: dropped the "enabled X of Y"
    // field here because the diagnostics strip below already prints
    // "X enabled · Y running · Z not loaded". Two adjacent cards saying the
    // same number reads as cognitive-load noise. The strip carries the
    // authoritative count; the summary bar keeps only the CONDITIONAL
    // surfaces (conflicts, tool-count warnings) that don't appear elsewhere.
    if (summary.conflicts && summary.conflicts.length > 0) {
      const pairs = summary.conflicts.map((c) => {
        const label = c.kind === 'prefix' ? 'prefix overlap' : 'near-name'
        return `<span class="conflict-item" title="${escapeHtml(label)}">${escapeHtml(c.a)}↔${escapeHtml(c.b)}</span>`
      }).join(' ')
      bits.push(
        `<span class="field warn" title="Two enabled ids look like typos of each other. Rename one, or disable the extra.">` +
          `<span class="label">possible conflict:</span>` +
          `<span class="value">${pairs}</span>` +
          `</span>`,
      )
    }
    if (summary.toolWarning) {
      bits.push(
        `<span class="field warn" title="Many tools in the same context can dilute model attention. Consider a slimmer overlay for this role.">` +
          `<span class="label">tool count:</span>` +
          `<span class="value">${summary.toolWarning.count} > ${summary.toolWarning.threshold}</span>` +
          `</span>`,
      )
    }
    summaryBar.innerHTML = bits.join('')
  }

  function renderDiagnosticsStrip(diags) {
    if (!diagStrip) return
    // B-P0-1 fix: keep configuration status
    // and runtime status as separate facts on one line so they can't
    // contradict. The previous shape shouted "Configuration OK" in bright
    // green while every runtime cell below showed ABSENT — the user reads
    // that as "the tool is lying to me". The new shape is
    //   "5 enabled · 3 running · 2 not loaded"
    // one number per state, mismatch tint (warn) whenever running != enabled.
    // Config-side diagnostics still take precedence when present (they hide
    // this row's OK story behind their own error/warn count).
    //
    // Follow-up: on stdio profiles there
    // is no daemon connection at all — `plugins/list` isn't returning
    // MethodNotFound, main-side plugins:listRuntime returns
    // `{supported:false, reason:'no-daemon'}` up front. Fold that into the
    // existing 'unknown' status (per team-lead: no fourth state) but vary
    // the phrase so the user sees "runtime state unavailable (no daemon on
    // this profile)" instead of the generic "runtime status unknown".
    const runtimeSnapshot = summarizeRuntimeHealth()
    if (diags.length === 0) {
      diagStrip.innerHTML = ''
      if (runtimeSnapshot.status === 'unknown') {
        diagStrip.className = 'plugins-diagnostics muted'
        diagStrip.textContent = globalThis.PluginRuntimeFold
          ? globalThis.PluginRuntimeFold.unknownReasonPhrase(runtimeSnapshot, state.lastRuntime)
          : 'runtime status unknown'
        return
      }
      diagStrip.className = 'plugins-diagnostics ' +
        // Preflight (2026-07-18) blind-test #9b: the earlier
        // `active ? ok : warn` mapping painted an orange border whenever
        // running != enabled. But "3 running out of 5 enabled" during a
        // fresh boot is not a warning — the daemon is just still spinning
        // up. Team-lead call: keep ok tint for a clean roll-up, drop the
        // colour class entirely for the partial-yet-not-erroring case so
        // it reads as neutral information, not a problem.
        (runtimeSnapshot.status === 'active' ? 'ok' : '')
      diagStrip.textContent = globalThis.PluginRuntimeFold
        ? globalThis.PluginRuntimeFold.healthPhrase(runtimeSnapshot)
        : `${runtimeSnapshot.expected} enabled · ${runtimeSnapshot.active} running`
      return
    }
    const errors = diags.filter((d) => d.severity === 'error')
    const warns = diags.filter((d) => d.severity === 'warn')
    diagStrip.className = 'plugins-diagnostics ' + (errors.length > 0 ? 'error' : 'warn')
    const parts = []
    if (errors.length > 0) parts.push(`<strong>${errors.length} error${errors.length === 1 ? '' : 's'}</strong>`)
    if (warns.length > 0) parts.push(`${warns.length} warning${warns.length === 1 ? '' : 's'}`)
    // Include the whole-list heuristics inline; the per-row ones are anchored
    // to their row in renderTable.
    const overall = diags.filter((d) => d.scope === 'overall')
    const overallLine = overall.map((d) => escapeHtml(d.message)).join(' · ')
    diagStrip.innerHTML = parts.join(' &nbsp;·&nbsp; ') +
      (overallLine ? ` &nbsp;·&nbsp; <span class="muted">${overallLine}</span>` : '')
  }

  // Roll up the last runtime snapshot into a compact health status the strip
  // and future callers can read. `unknown` == daemon has not reported yet;
  // `active` == every enabled row shows as active/loading in the runtime;
  // `partial` == some enabled rows are absent/pending so the config is not
  // fully in effect. See B-P0-1 in docs/product-flow-review.md.
  function summarizeRuntimeHealth() {
    const list = state.lastList
    const runtime = state.lastRuntime
    if (!runtime || runtime.supported !== true || !globalThis.PluginRuntimeFold || !list) {
      return { status: 'unknown', active: 0, pending: 0, notLoaded: 0, expected: 0 }
    }
    // Fold + healthSnapshot live in plugin-runtime-fold.js so the bucketing
    // and phrasing can be exercised under node --test without JSDOM. See
    // test/plugin-runtime-fold.test.js `healthSnapshot` cases.
    const fold = globalThis.PluginRuntimeFold.foldRuntime(list.entries || [], runtime.plugins || [])
    return globalThis.PluginRuntimeFold.healthSnapshot(fold)
  }

  function renderTable(list, diagsById) {
    tbody.innerHTML = ''
    // The runtime column is folded in from state.lastRuntime.plugins when
    // the daemon supports plugins/list; otherwise it stays absent (dash).
    // The fold logic itself lives in plugin-runtime-fold.js so it can be
    // exercised under node --test.
    const runtimeSupported = state.lastRuntime && state.lastRuntime.supported === true
    const fold = runtimeSupported && globalThis.PluginRuntimeFold
      ? globalThis.PluginRuntimeFold.foldRuntime(list.entries, state.lastRuntime.plugins || [])
      : { rows: list.entries.map((e) => ({ ...e, runtime: null })), extras: [] }
    for (const entry of fold.rows) {
      const tr = document.createElement('tr')
      tr.dataset.pluginId = entry.id
      if (entry.disabled) tr.classList.add('disabled')
      const diags = diagsById.get(entry.id) || []
      if (diags.some((d) => d.severity === 'error')) tr.classList.add('has-error')
      else if (diags.some((d) => d.severity === 'warn')) tr.classList.add('has-warn')

      const cbCell = document.createElement('td')
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.checked = !entry.disabled
      cb.addEventListener('change', async () => {
        try {
          await window.dsh.plugins.toggle(entry.id, !cb.checked)
          tr.classList.toggle('disabled', !cb.checked)
          setDirty(true)
          // Re-validate silently after every edit so cross-row heuristics
          // (near-duplicates, disabled → tool count) reflect the new state.
          void revalidate()
        } catch (err) {
          cb.checked = !entry.disabled // roll back the UI
          alert(`toggle failed: ${err.message}`)
        }
      })
      cbCell.appendChild(cb)
      tr.appendChild(cbCell)

      const idCell = document.createElement('td')
      idCell.textContent = entry.id
      idCell.className = 'mono'
      tr.appendChild(idCell)

      const nameCell = document.createElement('td')
      nameCell.textContent = entry.name
      nameCell.className = 'mono muted'
      tr.appendChild(nameCell)

      const srcCell = document.createElement('td')
      srcCell.className = 'source-cell'
      srcCell.textContent = entry.source
      if (entry.source === 'user') srcCell.classList.add('user')
      tr.appendChild(srcCell)

      // Runtime column: absent when the daemon lacks plugins/list; otherwise
      // one of active/loading/pending/failed/…/absent from the fold, with a
      // yellow dot when the runtime disagrees with the authored state.
      //
      // Wording (B-P0-1 fix, 2026-07-16): the raw states used to render
      // verbatim in the cell — a user opening Plugins for the first time
      // read "ABSENT" for every row and thought nothing had installed at
      // all, while the strip above read "Configuration OK". We translate
      // each state to a plain-language phrase now, with the raw name kept
      // as the hover so operators can still read the wire truth.
      const rtCell = document.createElement('td')
      rtCell.className = 'runtime-cell'
      if (!entry.runtime) {
        rtCell.textContent = '—'
        rtCell.classList.add('muted')
        // The per-row dash and the strip above share the same "why is this
        // unknown" reasoning — see unknownStripText. Match the phrasing so
        // hover on any cell answers the same question the strip does.
        const rt = state.lastRuntime || {}
        if (rt.reason === 'no-daemon') {
          rtCell.title = 'No daemon on this profile, so no live state is available.'
        } else if (rt.reason === 'MethodNotFound') {
          rtCell.title = 'This runtime does not implement plugins/list, so no live state is available.'
        } else {
          rtCell.title = 'No live state available yet.'
        }
      } else {
        const label = document.createElement('span')
        label.className = `runtime-state runtime-${entry.runtime.state}`
        const friendly = RUNTIME_LABEL[entry.runtime.state] || entry.runtime.state
        label.textContent = friendly.text
        label.title = `runtime state: ${entry.runtime.state}`
        rtCell.appendChild(label)
        if (friendly.hint) {
          const hint = document.createElement('span')
          hint.className = 'runtime-state-hint muted'
          hint.textContent = ` · ${friendly.hint}`
          rtCell.appendChild(hint)
        }
        if (entry.runtime.mismatch) {
          const dot = document.createElement('span')
          dot.className = 'runtime-mismatch'
          dot.textContent = '● '
          dot.title = entry.runtime.reason || 'runtime disagrees with configuration'
          rtCell.insertBefore(dot, label)
          tr.classList.add('runtime-mismatch-row')
        }
        // A resolved fiber name that differs from the configured specifier
        // is useful for debugging; keep it in the hover.
        if (entry.runtime.name) rtCell.title = `runtime fiber: ${entry.runtime.name}`
      }
      tr.appendChild(rtCell)

      tbody.appendChild(tr)

      // Per-row diagnostic message sits in a follow-up row so the table
      // layout doesn't need a fifth column. `title` also carries the same
      // text for a hover tooltip.
      for (const d of diags) {
        const detail = document.createElement('tr')
        detail.className = 'plugin-diagnostic ' + d.severity
        const td = document.createElement('td')
        td.colSpan = 5
        td.textContent = (d.severity === 'error' ? '! ' : '· ') + d.message
        detail.appendChild(td)
        tbody.appendChild(detail)
      }

      // MCP-client entries expose an inline server-
      // config card as a follow-up row. The card renders the shallow
      // `config:` block (transport / serverName / command|url / env|headers)
      // and writes back through `plugins.setConfig` — this is the "装了没
      // 感觉、没入口配置" (installed but nothing to configure) gap the audit
      // called out.
      if (globalThis.__dshMcpConfigCard &&
          globalThis.__dshMcpConfigCard.isMcpClientRow(entry)) {
        const card = globalThis.__dshMcpConfigCard.buildMcpConfigCard(
          document, entry, {
            onCommit: async (cfg) => {
              await window.dsh.plugins.setConfig(entry.id, cfg)
              setDirty(true)
              // A silent revalidate so summary/diagnostic strips reflect
              // the write; full table redraw would collapse the open card.
              void revalidate()
            },
            onClear: async () => {
              await window.dsh.plugins.setConfig(entry.id, null)
              setDirty(true)
              void revalidate()
            },
          },
        )
        tbody.appendChild(card)
      }
    }
    // Runtime plugins the fs list did not claim (e.g. agent-spine bundle
    // members). Render as an informational tail block so the user can see
    // the whole live registry, not just the entries they authored.
    if (fold.extras.length > 0) {
      const head = document.createElement('tr')
      head.className = 'runtime-extras-head'
      const th = document.createElement('td')
      th.colSpan = 5
      th.textContent = `Runtime-loaded (not in overlay): ${fold.extras.length}`
      head.appendChild(th)
      tbody.appendChild(head)
      for (const rp of fold.extras) {
        const tr = document.createElement('tr')
        tr.className = 'runtime-extras-row'
        // The 5-column layout is [Enabled, ID, Package, Source, Runtime].
        // Extras have no user-authored id/checkbox, so Enabled + ID stay
        // blank — but the Package column DOES have a name (rp.name is the
        // runtime fiber name, e.g. `agent-spine`'s bundle members). A
        // previous version collapsed the first three cells into a single
        // colSpan=3 blank, which is what the user was seeing: 25 rows with
        // only RUNTIME / ACTIVE badges and no plugin name to identify them.
        const enabledTd = document.createElement('td')
        enabledTd.className = 'muted'
        tr.appendChild(enabledTd)
        const idTd = document.createElement('td')
        idTd.className = 'muted'
        tr.appendChild(idTd)
        const nameTd = document.createElement('td')
        nameTd.className = 'mono muted'
        nameTd.textContent = rp.name || ''
        tr.appendChild(nameTd)
        const srcTd = document.createElement('td'); srcTd.textContent = 'runtime'
        srcTd.className = 'source-cell'
        tr.appendChild(srcTd)
        const stateTd = document.createElement('td')
        stateTd.className = 'runtime-cell'
        const label = document.createElement('span')
        label.className = `runtime-state runtime-${rp.state}`
        label.textContent = rp.state
        stateTd.appendChild(label)
        stateTd.title = `runtime fiber: ${rp.name}`
        tr.appendChild(stateTd)
        tbody.appendChild(tr)
      }
    }
    if (list.entries.length === 0) {
      const tr = document.createElement('tr')
      const td = document.createElement('td')
      td.colSpan = 5
      td.className = 'empty'
      td.textContent = 'No entries — base leaf not found or empty.'
      tr.appendChild(td)
      tbody.appendChild(tr)
    }
  }

  async function refresh() {
    try {
      const list = await window.dsh.plugins.list()
      state.lastList = list
      renderMeta(list)
      const diagResult = await window.dsh.plugins.validate().catch(() => ({ diagnostics: [] }))
      state.lastDiagnostics = diagResult.diagnostics || []
      // Runtime column is best-effort: MethodNotFound / no daemon / crash all
      // collapse to `{ supported: false }` so the table still renders. The
      // yellow-dot mismatch signal only appears when the daemon supplied a
      // real answer.
      state.lastRuntime = await window.dsh.plugins.listRuntime().catch(() => ({ supported: false }))
      // publish the current mounted-plugin set to the global
      // known-plugins registry the inject classifier reads (family B/G
      // split). Only overwrite when the runtime actually answered — a
      // MethodNotFound fallback would otherwise clobber a stale-but-real
      // list on the next tab switch.
      if (state.lastRuntime && state.lastRuntime.supported === true &&
          Array.isArray(state.lastRuntime.plugins)) {
        window.__dshKnownPlugins = new Set(
          state.lastRuntime.plugins
            .map((p) => p && p.name)
            .filter((n) => typeof n === 'string' && n.length > 0),
        )
      }
      const { byId } = bucketDiagnostics(state.lastDiagnostics)
      renderSummaryBar(list.summary)
      renderDiagnosticsStrip(state.lastDiagnostics)
      renderTable(list, byId)
      vibeBtn.disabled = !list.vibeCapable
      vibeBtn.title = list.vibeCapable
        ? 'Start a chat with cordis_inspect / cordis_mount / cordis_unmount in scope.'
        : `Requires a vibe-capable profile (current: ${list.profileName}). Switch to "stdio-vibe-deepseek".`
      // Keep the Create-zone cards in sync with the (now-hidden) header
      // buttons. See src/renderer/plugin-market.js syncCreateZone.
      if (window.__dshMarket && typeof window.__dshMarket.syncCreateZone === 'function') {
        window.__dshMarket.syncCreateZone(list)
      }
    } catch (err) {
      meta.innerHTML = `<span class="error">plugin list unavailable: ${escapeHtml(err.message)}</span>`
    }
  }

  // Validate-only path — no list reflow. Used by toggle so the strip and
  // row highlights stay in sync without a full redraw. The row-diagnostic
  // detail rows are inside the same tbody so we do have to recompute those,
  // but the base entries themselves don't change.
  //
  // Toggle also flips the disabled flag on the effective entry list, which
  // changes the A3 summary (enabled count, conflicts among ENABLED ids). We
  // refetch the list so the summary bar tracks reality. This is one extra
  // IPC per toggle, which is fine — plugins:list is cached and cheap.
  async function revalidate() {
    if (!state.lastList) return
    try {
      const [freshList, diagResult] = await Promise.all([
        window.dsh.plugins.list().catch(() => state.lastList),
        window.dsh.plugins.validate(),
      ])
      state.lastList = freshList
      state.lastDiagnostics = diagResult.diagnostics || []
      const { byId } = bucketDiagnostics(state.lastDiagnostics)
      renderSummaryBar(freshList.summary)
      renderDiagnosticsStrip(state.lastDiagnostics)
      renderTable(freshList, byId)
    } catch (_) { /* validation is best-effort; a stale strip is fine */ }
  }

  async function apply() {
    applyBtn.disabled = true
    applyBtn.textContent = 'Restarting…'
    try {
      await window.dsh.plugins.restart()
      setDirty(false)
      applyBtn.textContent = 'Apply + restart'
      // A soft toast; the statusbar already reflects respawn state.
      sidebarNote.textContent = 'Runtime restarted with new overlay.'
    } catch (err) {
      applyBtn.textContent = 'Apply + restart'
      applyBtn.disabled = false
      alert(`restart failed: ${err.message}`)
    }
  }

  async function addPlugin() {
    // A modest inline prompt. The demo intentionally doesn't ship a package
    // picker; the user types a valid cordis plugin specifier (workspace
    // package name, absolute path, or relative path resolved against the
    // dev-clone root).
    const id = (window.prompt('Plugin id (short, unique):') || '').trim()
    if (!id) return
    const name = (window.prompt('Plugin package or path:', '@deepseek-ai/dsh-') || '').trim()
    if (!name) return
    try {
      await window.dsh.plugins.add(id, name)
      setDirty(true)
      await refresh()
    } catch (err) {
      alert(`add failed: ${err.message}`)
    }
  }

  async function vibe() {
    try {
      const { sessionId } = await window.dsh.plugins.vibeStart()
      // Return to the chat tab; renderer.js exposes selectSession so this
      // module can hand off cleanly. If for some reason it hasn't loaded
      // yet, we just switch the tab and let refreshSessionList pick it up.
      if (window.__dshTabs) window.__dshTabs.switchTo('chat')
      if (window.__dshChat && typeof window.__dshChat.selectSession === 'function') {
        await window.__dshChat.selectSession(sessionId)
      }
    } catch (err) {
      alert(`vibe failed: ${err.message}`)
    }
  }

  // Shared with market-ui, playground-ui, bench-page — see html-escape.js.
  const escapeHtml = (window.__dshHtmlEscape || {}).escapeHtml
    || ((s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])))

  refreshBtn.addEventListener('click', () => { void refresh() })
  applyBtn.addEventListener('click', () => { void apply() })
  addBtn.addEventListener('click', () => { void addPlugin() })
  vibeBtn.addEventListener('click', () => { void vibe() })

  // Boot probe (A2). Explicit user gesture — slow enough (a real daemon
  // boot) that we don't run it automatically. On success, the diagnostics
  // strip clears any prior boot warnings; on failure the fail-loud stderr
  // is anchored to the offending row.
  const probeBtn = document.getElementById('plugins-probe')
  if (probeBtn) {
    probeBtn.addEventListener('click', async () => {
      probeBtn.disabled = true
      const original = probeBtn.textContent
      probeBtn.textContent = 'Booting probe…'
      try {
        const result = await window.dsh.plugins.probe()
        // Merge probe diagnostics with the last static-validation set so the
        // strip shows both layers. Static diagnostics don't have an isBoot
        // marker; probe ones are prefixed 'boot:' in their message.
        const merged = [
          ...state.lastDiagnostics.filter((d) => !/^boot:/.test(d.message)),
          ...(result.diagnostics || []),
        ]
        state.lastDiagnostics = merged
        const { byId } = bucketDiagnostics(merged)
        renderDiagnosticsStrip(merged)
        if (state.lastList) renderTable(state.lastList, byId)
      } catch (err) {
        alert(`probe failed: ${err.message}`)
      } finally {
        probeBtn.disabled = false
        probeBtn.textContent = original
      }
    })
  }

  // Exposed so the tab-switch handler can lazy-load on first activation and
  // the boot flow can force a refresh after onboarding writes an overlay.
  window.__dshPlugins = { refresh, setDirty }

  // First render happens when the user opens the tab; nothing eager here so
  // a slow plugins:list on the daemon doesn't block chat.
})()
