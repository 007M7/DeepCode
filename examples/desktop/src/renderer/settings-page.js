// Settings page:
//   1. Model pricing table — every model in the default price-table is one
//      row; input+output columns are editable, edits persist to
//      localStorage via settings-model.setOverride and the trace cost badges
//      pick them up through window.__dshPriceTable at read time.
//   2. API keys — display-only presence chart for the four env vars the
//      shell talks to (DEEPSEEK, OPENAI, ANTHROPIC, service token). NEVER
//      renders a key value; only "set" / "not set". Personal vs. service
//      concept is explained in one paragraph.
//
// This module is a pure DOM controller reading from settings-model.js
// (pure) and window.__dshPriceTable (in-memory table). No fetches; the
// key-presence read comes through window.dsh.runtimeStatus (which the
// main process already computes when starting a runtime — DEEPSEEK-only
// today; the other three fall through to "not set").

'use strict'
;(function () {
  const rootId = 'settings-pane'

  // Two-decimal fixed formatter used by the input display value. The
  // stored value stays as a number; only the visible text is truncated
  // so the researcher sees clean rate columns.
  function fmt(n) {
    if (typeof n !== 'number' || !isFinite(n)) return ''
    return n.toFixed(2)
  }

  function renderPricingRow(model, defaultRow, overrideRow) {
    const tr = document.createElement('tr')
    tr.dataset.model = model
    if (overrideRow && (overrideRow.input != null || overrideRow.output != null)) {
      tr.classList.add('settings-price-row--override')
    }
    const nameCell = document.createElement('td')
    nameCell.className = 'settings-price-model mono'
    nameCell.textContent = model
    tr.appendChild(nameCell)

    for (const field of ['input', 'output']) {
      const cell = document.createElement('td')
      cell.className = 'settings-price-cell'
      const input = document.createElement('input')
      input.type = 'number'
      input.step = '0.01'
      input.min = '0'
      input.className = 'settings-price-input mono'
      input.dataset.field = field
      const cur = (overrideRow && overrideRow[field] != null) ? overrideRow[field] : (defaultRow && defaultRow[field])
      input.value = fmt(cur)
      const marker = document.createElement('span')
      marker.className = 'settings-price-marker'
      marker.title = 'This value overrides the default; press Reset to remove.'
      marker.textContent = 'edited'
      if (!(overrideRow && overrideRow[field] != null)) marker.hidden = true
      cell.appendChild(input)
      cell.appendChild(marker)
      tr.appendChild(cell)
    }

    const actions = document.createElement('td')
    actions.className = 'settings-price-actions'
    const reset = document.createElement('button')
    reset.className = 'ghost small'
    reset.type = 'button'
    reset.textContent = 'Reset'
    reset.title = 'Clear override for this model. Rate returns to the default table.'
    reset.disabled = !overrideRow || (overrideRow.input == null && overrideRow.output == null)
    reset.dataset.action = 'reset'
    actions.appendChild(reset)
    tr.appendChild(actions)

    return tr
  }

  function renderPricingTable(container, defaultTable, model) {
    const body = container.querySelector('[data-settings-price-tbody]')
    if (!body) return
    body.innerHTML = ''
    const overrides = model.readOverrides()
    const pricing = (defaultTable && defaultTable.pricing) || {}
    // Union of default-table rows and any overrides that were added for a
    // model the default table doesn't ship — the researcher may have
    // added a custom row via localStorage; we still render it so it can
    // be reset back to nothing.
    const models = new Set([...Object.keys(pricing), ...Object.keys(overrides)])
    const sorted = Array.from(models).sort()
    for (const m of sorted) {
      body.appendChild(renderPricingRow(m, pricing[m], overrides[m]))
    }
  }

  // render keys as a resource table with the
  // LangSmith Settings > API Keys columns (Name / Tier / Description /
  // Presence / Last used). Falls back to the legacy <ul> when the
  // <tbody> is missing so the migration is defensive against a stripped
  // index.html.
  function renderKeys(container, keys) {
    const tbody = container.querySelector('[data-settings-keys-tbody]')
    if (tbody) {
      tbody.innerHTML = ''
      for (const row of keys) {
        const tr = document.createElement('tr')
        tr.className = 'settings-key-tr'
        tr.dataset.key = row.name

        const nameCell = document.createElement('td')
        nameCell.className = 'settings-key-name mono'
        nameCell.textContent = row.name
        tr.appendChild(nameCell)

        const tierCell = document.createElement('td')
        const tierChip = document.createElement('span')
        tierChip.className = `settings-key-tier settings-key-tier--${row.tier}`
        tierChip.textContent = row.tier
        tierCell.appendChild(tierChip)
        tr.appendChild(tierCell)

        const descCell = document.createElement('td')
        descCell.className = 'settings-key-desc'
        descCell.textContent = row.description || ''
        tr.appendChild(descCell)

        const presenceCell = document.createElement('td')
        presenceCell.className = 'settings-key-presence'
        const dot = document.createElement('span')
        dot.className = `settings-key-dot settings-key-dot--${row.present ? 'on' : 'off'}`
        dot.title = row.present
          ? 'Environment variable is set — value never displayed here.'
          : 'Environment variable is not set.'
        const label = document.createElement('span')
        label.className = 'settings-key-status muted'
        label.textContent = row.present ? 'set' : 'not set'
        presenceCell.appendChild(dot)
        presenceCell.appendChild(label)
        tr.appendChild(presenceCell)

        const lastUsedCell = document.createElement('td')
        lastUsedCell.className = 'settings-key-lastused muted mono'
        lastUsedCell.textContent = row.lastUsed || '—'
        tr.appendChild(lastUsedCell)

        tbody.appendChild(tr)
      }
      return
    }
    // Legacy <ul> fallback — kept for defensiveness only.
    const list = container.querySelector('[data-settings-keys-list]')
    if (!list) return
    list.innerHTML = ''
    for (const row of keys) {
      const li = document.createElement('li')
      li.className = 'settings-key-row'
      const dot = document.createElement('span')
      dot.className = `settings-key-dot settings-key-dot--${row.present ? 'on' : 'off'}`
      const name = document.createElement('span')
      name.className = 'settings-key-name mono'
      name.textContent = row.name
      const tier = document.createElement('span')
      tier.className = `settings-key-tier settings-key-tier--${row.tier}`
      tier.textContent = row.tier
      const status = document.createElement('span')
      status.className = 'settings-key-status muted'
      status.textContent = row.present ? 'set' : 'not set'
      li.appendChild(dot)
      li.appendChild(name)
      li.appendChild(tier)
      li.appendChild(status)
      list.appendChild(li)
    }
  }

  // Optional pages (lane-nav-optional). Render a checkbox row for each
  // page listed in nav-config-model's OPTIONAL_PAGES. `checked=true`
  // means the page is CURRENTLY VISIBLE (not in the hiddenPages array).
  // On toggle, write the updated array back through window.dsh.nav.set
  // and ask the renderer to re-apply the sidebar filter so the change
  // takes effect without a reload.
  async function readCurrentHidden() {
    try {
      if (window.dsh && window.dsh.nav && typeof window.dsh.nav.getHiddenPages === 'function') {
        const res = await window.dsh.nav.getHiddenPages()
        const M = window.__dshNavConfigModel
        return M ? M.resolveHiddenPages(res || {}) : (Array.isArray(res && res.hiddenPages) ? res.hiddenPages : [])
      }
    } catch (_) { /* fall through */ }
    const M = window.__dshNavConfigModel
    return M ? M.DEFAULT_HIDDEN.slice() : []
  }

  function renderOptionalRow(page, isVisible) {
    const li = document.createElement('li')
    li.className = 'settings-optional-row'
    li.dataset.pageId = page.id
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.checked = !!isVisible
    checkbox.id = `settings-optional-${page.id}`
    checkbox.dataset.pageId = page.id
    const label = document.createElement('label')
    label.className = 'settings-optional-label'
    label.setAttribute('for', checkbox.id)
    const name = document.createElement('span')
    name.className = 'settings-optional-name'
    name.textContent = page.label
    const hint = document.createElement('span')
    hint.className = 'settings-optional-hint muted'
    hint.textContent = page.hint
    label.appendChild(name)
    label.appendChild(hint)
    li.appendChild(checkbox)
    li.appendChild(label)
    return li
  }

  async function renderOptionalPages(container) {
    const list = container.querySelector('[data-settings-optional-list]')
    if (!list) return
    const M = window.__dshNavConfigModel
    if (!M) return
    const currentHidden = await readCurrentHidden()
    const hiddenSet = new Set(currentHidden)
    list.innerHTML = ''
    for (const page of M.OPTIONAL_PAGES) {
      list.appendChild(renderOptionalRow(page, !hiddenSet.has(page.id)))
    }
  }

  async function readKeyPresence() {
    // Only DEEPSEEK is knowable today because the main process spawns
    // stdio-deepseek with that key threaded through the profile. Other
    // vars aren't inspected by the shell — leave them as `false` until
    // a `keys/list` seam exists (adjacent to G8 runtime/list).
    const presence = {
      DEEPSEEK_API_KEY: false,
      OPENAI_API_KEY: false,
      ANTHROPIC_API_KEY: false,
      DSH_SERVICE_TOKEN: false,
    }
    try {
      if (window.dsh && typeof window.dsh.runtimeStatus === 'function') {
        const s = await window.dsh.runtimeStatus()
        // runtimeStatus doesn't ship key-presence today; heuristic: if
        // the mounted profile is one that requires DEEPSEEK_API_KEY and
        // the runtime came up ok, the key must have been present. This
        // is honest-mocking: we say "detected via startup" so the reader
        // knows we didn't peek at the value.
        if (s && s.status === 'ok' && typeof s.profile === 'string'
            && s.profile.includes('deepseek')) {
          presence.DEEPSEEK_API_KEY = true
        }
      }
    } catch (_) {}
    return presence
  }

  async function refresh(root) {
    if (!root) return
    const priceContainer = root.querySelector('[data-settings-pricing]')
    const keysContainer = root.querySelector('[data-settings-keys]')
    const optionalContainer = root.querySelector('[data-settings-optional-pages]')
    const model = window.__dshSettingsModel
    if (!model) return
    if (priceContainer) {
      // Feed the RAW default table (before overrides) to the row builder
      // so it can render "override" markers vs. base cells. The
      // renderer stashes the pristine copy on
      // window.__dshPriceTableDefault (published by price-table.js at
      // load time); fall through to the live table if that seam is
      // missing (unit test / stripped bundle).
      const defaults = window.__dshPriceTableDefault
        || window.__dshPriceTable
        || { pricing: {} }
      renderPricingTable(priceContainer, defaults, model)
    }
    if (keysContainer) {
      const presence = await readKeyPresence()
      const rows = model.classifyKeys(presence)
      renderKeys(keysContainer, rows)
    }
    if (optionalContainer) {
      await renderOptionalPages(optionalContainer)
    }
  }

  function attachListeners(root) {
    const priceBody = root.querySelector('[data-settings-price-tbody]')
    if (priceBody && !priceBody.__dshBound) {
      priceBody.__dshBound = true
      priceBody.addEventListener('change', (ev) => {
        const t = ev.target
        if (!(t instanceof HTMLInputElement) || !t.classList.contains('settings-price-input')) return
        const tr = t.closest('tr')
        if (!tr) return
        const modelName = tr.dataset.model
        const field = t.dataset.field
        const raw = t.value.trim()
        const model = window.__dshSettingsModel
        if (!model || !modelName || !field) return
        const patch = {}
        if (raw === '') {
          patch[field] = null
        } else {
          const n = Number(raw)
          if (!isFinite(n) || n < 0) return
          patch[field] = n
        }
        model.setOverride(modelName, patch)
        void refresh(root)
      })
      priceBody.addEventListener('click', (ev) => {
        const t = ev.target
        if (!(t instanceof HTMLButtonElement) || t.dataset.action !== 'reset') return
        const tr = t.closest('tr')
        if (!tr) return
        const modelName = tr.dataset.model
        const model = window.__dshSettingsModel
        if (!model || !modelName) return
        model.setOverride(modelName, null)
        void refresh(root)
      })
    }
    // Optional pages checkbox listener — one delegated handler for all
    // rows. The bound flag guards a double-bind if show() runs twice
    // (which happens when the researcher visits Settings after having
    // opened it once already, since renderer.js:switchTo('settings')
    // calls show() unconditionally).
    const optionalList = root.querySelector('[data-settings-optional-list]')
    if (optionalList && !optionalList.__dshBound) {
      optionalList.__dshBound = true
      optionalList.addEventListener('change', async (ev) => {
        const t = ev.target
        if (!(t instanceof HTMLInputElement) || t.type !== 'checkbox') return
        const pageId = t.dataset.pageId
        const M = window.__dshNavConfigModel
        if (!pageId || !M) return
        // Read current, compute next, persist, re-apply filter.
        const current = await readCurrentHidden()
        const next = M.toggleOptionalPage(current, pageId, t.checked)
        try {
          if (window.dsh && window.dsh.nav && typeof window.dsh.nav.setHiddenPages === 'function') {
            await window.dsh.nav.setHiddenPages(next)
          }
        } catch (_) { /* IPC absent — the DOM class flip below still updates the sidebar for this session */ }
        if (window.__dshNavFilter && typeof window.__dshNavFilter.apply === 'function') {
          await window.__dshNavFilter.apply()
        }
      })
    }
  }

  async function show() {
    const root = document.getElementById(rootId)
    if (!root) return
    attachListeners(root)
    await refresh(root)
  }

  if (typeof window !== 'undefined') {
    window.__dshSettings = { show, refresh: () => show() }
  }
})();
