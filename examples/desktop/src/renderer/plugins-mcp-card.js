// Plugins tab · MCP-server config card.
//
// Renders an inline non-modal config panel for `dsh-mcp-client` patch rows.
// One patch = one MCP server; the card writes the shallow `config:` sub-block
// the parser at src/main/plugins.js:parseShallowConfig understands, then the
// user clicks "Apply + restart" on the tab to respawn the daemon.
//
// Why a card (not a modal, not another tab)? The team-lead spec §7 bans
// centered/floating cards in stream/list flows; the Installed table already
// renders per-row diagnostic follow-up rows (`plugin-diagnostic`) as a
// full-width band under their anchor row. This card follows the same
// pattern: it is a `<tr>` with `colSpan=5` that sits directly under the
// `dsh-mcp-client` row, expands inline via a `<details>` toggle, and is
// clearly attributed to its parent row via a border-left edge.
//
// The transport radio flips which fields are relevant:
//   - stdio         → serverName, command, args[], env{}, cwd
//   - streamable-http → serverName, url, headers{}
// Both share `serverName` (the tool-name prefix — `mcp__<serverName>__…`);
// the field is required and is the only value that can never round-trip as
// empty (the include plugin would reject the entry at boot).
//
// The card is a pure DOM builder — takes the current row + its config value
// and a `commit(newConfig)` callback. Renderer wiring (which pulls the
// current overlay via `window.dsh.plugins.list()` and posts back via
// `plugins.setConfig(id, next)`) lives in plugins-ui.js.

'use strict'

;(function () {
  // Public surface: buildMcpConfigCard(doc, row, api) → HTMLTableRowElement
  // The returned <tr> spans the plugin table's five columns (Enabled / ID /
  // Package / Source / Runtime) so it lines up with the anchor row above.
  //
  //   doc  : Document reference (test injection point; production = document)
  //   row  : the effective plugin entry ({id, name, disabled, source, config?})
  //   api  : {
  //            onCommit: async (nextConfig) => void  // → plugins.setConfig
  //            onClear:  async () => void            // → plugins.setConfig(null)
  //          }
  function buildMcpConfigCard(doc, row, api) {
    const tr = doc.createElement('tr')
    tr.className = 'plugin-mcp-card'
    tr.dataset.pluginId = row.id
    const td = doc.createElement('td')
    td.colSpan = 5
    tr.appendChild(td)

    const wrap = doc.createElement('details')
    wrap.className = 'mcp-config-wrap'
    // Default open so the user immediately sees the card is configurable —
    // the point of P0-1 is that today it looks like nothing configures.
    // Once the user has committed once (config is non-empty) we still keep
    // it open; the summary carries a serverName preview so a folded card
    // still tells the user WHICH server they configured.
    wrap.open = true
    td.appendChild(wrap)

    const summary = doc.createElement('summary')
    summary.className = 'mcp-config-summary'
    const summaryGlyph = doc.createElement('span')
    summaryGlyph.className = 'mcp-config-glyph mono muted'
    summaryGlyph.textContent = 'MCP'
    const summaryLabel = doc.createElement('span')
    summaryLabel.className = 'mcp-config-label'
    summaryLabel.textContent = 'server config'
    const summaryPreview = doc.createElement('span')
    summaryPreview.className = 'mcp-config-preview mono muted'
    summaryPreview.textContent = summarize(row.config || null)
    summary.appendChild(summaryGlyph)
    summary.appendChild(summaryLabel)
    summary.appendChild(summaryPreview)
    // Restart-required badge (matches the Context page G2 convention — an
    // overlay write is a static change until the runtime reboots). Renders
    // as a chip-tier pill; §7 codified waiver `chip-tier` covers the
    // padding/gap.
    const restartBadge = doc.createElement('span')
    restartBadge.className = 'mcp-config-restart-badge chip-tier'
    restartBadge.textContent = 'restart required'
    restartBadge.title = 'MCP server config lands in the overlay yml. ' +
      'Click "Apply + restart" on the Plugins tab for the daemon to reconnect.'
    summary.appendChild(restartBadge)
    wrap.appendChild(summary)

    const body = doc.createElement('div')
    body.className = 'mcp-config-body'
    wrap.appendChild(body)

    // ---- form state ------------------------------------------------------
    // Start from the current config, defaulted to stdio (the more common
    // transport for the fixtures the audit lists — github, everything,
    // filesystem all ship stdio servers). `state` is the working copy the
    // controls mutate; committing calls onCommit(state) so main.js writes it.
    const initial = row.config && typeof row.config === 'object' ? row.config : {}
    const state = {
      transport: initial.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
      serverName: typeof initial.serverName === 'string' ? initial.serverName : '',
      command: typeof initial.command === 'string' ? initial.command : '',
      args: Array.isArray(initial.args) ? initial.args.slice() : [],
      env: initial.env && typeof initial.env === 'object' ? { ...initial.env } : {},
      cwd: typeof initial.cwd === 'string' ? initial.cwd : '',
      url: typeof initial.url === 'string' ? initial.url : '',
      headers: initial.headers && typeof initial.headers === 'object' ? { ...initial.headers } : {},
    }

    // ---- transport toggle -----------------------------------------------
    const transportRow = doc.createElement('div')
    transportRow.className = 'mcp-config-row transport'
    const transportLabel = doc.createElement('label')
    transportLabel.className = 'mcp-config-key mono muted'
    transportLabel.textContent = 'transport'
    transportRow.appendChild(transportLabel)
    const transportGroup = doc.createElement('div')
    transportGroup.className = 'mcp-config-radio-group'
    for (const opt of ['stdio', 'streamable-http']) {
      const wrap = doc.createElement('label')
      wrap.className = 'mcp-config-radio'
      const input = doc.createElement('input')
      input.type = 'radio'
      input.name = `mcp-transport-${row.id}`
      input.value = opt
      input.checked = state.transport === opt
      input.addEventListener('change', () => {
        if (input.checked) {
          state.transport = opt
          renderTransportFields()
          dirty(true)
        }
      })
      const span = doc.createElement('span')
      span.className = 'mono'
      span.textContent = opt
      wrap.appendChild(input)
      wrap.appendChild(span)
      transportGroup.appendChild(wrap)
    }
    transportRow.appendChild(transportGroup)
    body.appendChild(transportRow)

    // ---- serverName (shared by both transports) --------------------------
    const nameRow = doc.createElement('div')
    nameRow.className = 'mcp-config-row'
    const nameLabel = doc.createElement('label')
    nameLabel.className = 'mcp-config-key mono muted'
    nameLabel.textContent = 'serverName'
    nameLabel.title = 'Namespace prefix for tools this server exposes: ' +
      'the model sees them as mcp__<serverName>__<toolName>.'
    const nameInput = doc.createElement('input')
    nameInput.type = 'text'
    nameInput.className = 'mcp-config-input mono'
    nameInput.value = state.serverName
    nameInput.placeholder = 'e.g. github, everything, filesystem'
    nameInput.spellcheck = false
    nameInput.autocomplete = 'off'
    nameInput.addEventListener('input', () => {
      state.serverName = nameInput.value.trim()
      dirty(true)
    })
    nameRow.appendChild(nameLabel)
    nameRow.appendChild(nameInput)
    body.appendChild(nameRow)

    // ---- transport-specific fields --------------------------------------
    const transportBody = doc.createElement('div')
    transportBody.className = 'mcp-config-transport-body'
    body.appendChild(transportBody)

    function renderTransportFields() {
      transportBody.innerHTML = ''
      if (state.transport === 'stdio') {
        transportBody.appendChild(stringField(doc, 'command', 'command', state, {
          placeholder: 'e.g. npx, node, python',
          hint: 'Executable that speaks MCP over stdio. Absolute path OK.',
          onCommit: () => dirty(true),
        }))
        transportBody.appendChild(listField(doc, 'args', 'args', state, {
          placeholder: 'e.g. @modelcontextprotocol/server-github',
          hint: 'Positional arguments passed to the command, one per row.',
          onCommit: () => dirty(true),
        }))
        transportBody.appendChild(mapField(doc, 'env', 'env', state, {
          keyPlaceholder: 'GITHUB_TOKEN',
          valuePlaceholder: 'ghp_…',
          hint: 'Env vars visible to the subprocess. Secrets scrubbed from logs.',
          onCommit: () => dirty(true),
        }))
        transportBody.appendChild(stringField(doc, 'cwd', 'cwd (optional)', state, {
          placeholder: 'working directory (defaults to the daemon cwd)',
          hint: 'Working directory for the subprocess.',
          onCommit: () => dirty(true),
        }))
      } else {
        transportBody.appendChild(stringField(doc, 'url', 'url', state, {
          placeholder: 'https://mcp.example.com/rpc',
          hint: 'HTTPS endpoint that speaks Streamable HTTP MCP.',
          onCommit: () => dirty(true),
        }))
        transportBody.appendChild(mapField(doc, 'headers', 'headers', state, {
          keyPlaceholder: 'Authorization',
          valuePlaceholder: 'Bearer …',
          hint: 'HTTP headers sent with every request. Secrets scrubbed from logs.',
          onCommit: () => dirty(true),
        }))
      }
    }
    renderTransportFields()

    // ---- footer: actions -------------------------------------------------
    const footer = doc.createElement('div')
    footer.className = 'mcp-config-footer'
    const status = doc.createElement('span')
    status.className = 'mcp-config-status muted'
    status.textContent = ''
    const spacer = doc.createElement('span')
    spacer.className = 'mcp-config-spacer'
    const clearBtn = doc.createElement('button')
    clearBtn.type = 'button'
    clearBtn.className = 'mcp-config-clear'
    clearBtn.textContent = 'Clear'
    clearBtn.title = 'Drop the config sub-block from this patch entirely.'
    clearBtn.addEventListener('click', async () => {
      clearBtn.disabled = true
      status.textContent = 'Clearing…'
      try {
        await api.onClear()
        status.textContent = 'Cleared — apply to restart.'
      } catch (err) {
        status.textContent = `clear failed: ${err.message || err}`
      } finally {
        clearBtn.disabled = false
      }
    })
    const saveBtn = doc.createElement('button')
    saveBtn.type = 'button'
    saveBtn.className = 'mcp-config-save primary'
    saveBtn.textContent = 'Save'
    saveBtn.title = 'Write this MCP-server config into the overlay yml. ' +
      'Runtime picks it up on the next Apply + restart.'
    saveBtn.disabled = true
    saveBtn.addEventListener('click', async () => {
      const validation = validate(state)
      if (validation.error) {
        status.textContent = validation.error
        status.classList.add('error')
        return
      }
      status.classList.remove('error')
      saveBtn.disabled = true
      status.textContent = 'Saving…'
      try {
        const cfg = pack(state)
        await api.onCommit(cfg)
        status.textContent = 'Saved — apply to restart.'
        summaryPreview.textContent = summarize(cfg)
      } catch (err) {
        status.textContent = `save failed: ${err.message || err}`
        saveBtn.disabled = false
      }
    })
    footer.appendChild(status)
    footer.appendChild(spacer)
    footer.appendChild(clearBtn)
    footer.appendChild(saveBtn)
    body.appendChild(footer)

    function dirty(isDirty) {
      saveBtn.disabled = !isDirty
      if (isDirty) status.textContent = 'Unsaved changes'
      status.classList.remove('error')
    }

    return tr
  }

  // ---- pure helpers (exported for tests) ---------------------------------

  // Compact one-line summary that reads in the summary bar even when the
  // card is folded. Empty configs render as an explicit "(unconfigured)"
  // — a null-object is a valid state (the user installed but hasn't filled
  // anything in yet) that the audit's §2 gap ("装了没入口") captures.
  function summarize(config) {
    if (!config || typeof config !== 'object' || !Object.keys(config).length) {
      return '(unconfigured)'
    }
    const name = config.serverName ? String(config.serverName) : '(no serverName)'
    if (config.transport === 'streamable-http') {
      const target = config.url ? String(config.url) : '(no url)'
      return `${name} · http · ${target}`
    }
    const cmd = config.command ? String(config.command) : '(no command)'
    return `${name} · stdio · ${cmd}`
  }

  // Coerce the working state into the shape parseShallowConfig round-trips.
  // Strips empty fields so the yml stays tidy — an all-blank env map
  // renders no `env:` block at all.
  function pack(state) {
    const cfg = {}
    cfg.transport = state.transport
    if (state.serverName) cfg.serverName = state.serverName
    if (state.transport === 'stdio') {
      if (state.command) cfg.command = state.command
      if (state.args && state.args.length > 0) cfg.args = state.args.filter((a) => a !== '')
      if (state.env && Object.keys(state.env).length > 0) {
        const env = {}
        for (const k of Object.keys(state.env)) {
          if (k && state.env[k] !== undefined) env[k] = String(state.env[k])
        }
        if (Object.keys(env).length > 0) cfg.env = env
      }
      if (state.cwd) cfg.cwd = state.cwd
    } else {
      if (state.url) cfg.url = state.url
      if (state.headers && Object.keys(state.headers).length > 0) {
        const headers = {}
        for (const k of Object.keys(state.headers)) {
          if (k && state.headers[k] !== undefined) headers[k] = String(state.headers[k])
        }
        if (Object.keys(headers).length > 0) cfg.headers = headers
      }
    }
    return cfg
  }

  // Validation that stops the save when the include plugin would reject the
  // entry at load. Every check is a fail-loud pre-flight; the tab does not
  // silently commit a broken config and let the runtime crash later.
  function validate(state) {
    if (!state.serverName) return { error: 'serverName is required (used as the mcp__<name>__ prefix).' }
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(state.serverName)) {
      return { error: 'serverName must be 1–32 chars [A-Za-z0-9_-].' }
    }
    if (state.transport === 'stdio') {
      if (!state.command) return { error: 'command is required for stdio transport.' }
    } else {
      if (!state.url) return { error: 'url is required for streamable-http transport.' }
      if (!/^https?:\/\//.test(state.url)) {
        return { error: 'url must start with http:// or https://.' }
      }
    }
    return { error: null }
  }

  // ---- reusable field renderers -----------------------------------------

  function stringField(doc, key, label, state, opts) {
    const row = doc.createElement('div')
    row.className = 'mcp-config-row'
    const lbl = doc.createElement('label')
    lbl.className = 'mcp-config-key mono muted'
    lbl.textContent = label
    if (opts.hint) lbl.title = opts.hint
    const input = doc.createElement('input')
    input.type = 'text'
    input.className = 'mcp-config-input mono'
    input.value = state[key] || ''
    input.placeholder = opts.placeholder || ''
    input.spellcheck = false
    input.autocomplete = 'off'
    input.addEventListener('input', () => {
      state[key] = input.value
      opts.onCommit && opts.onCommit()
    })
    row.appendChild(lbl)
    row.appendChild(input)
    return row
  }

  function listField(doc, key, label, state, opts) {
    const row = doc.createElement('div')
    row.className = 'mcp-config-row list'
    const lbl = doc.createElement('label')
    lbl.className = 'mcp-config-key mono muted'
    lbl.textContent = label
    if (opts.hint) lbl.title = opts.hint
    row.appendChild(lbl)
    const body = doc.createElement('div')
    body.className = 'mcp-config-list-body'
    row.appendChild(body)

    function repaint() {
      body.innerHTML = ''
      for (let i = 0; i < state[key].length; i++) {
        const itemRow = doc.createElement('div')
        itemRow.className = 'mcp-config-list-item'
        const input = doc.createElement('input')
        input.type = 'text'
        input.className = 'mcp-config-input mono'
        input.value = state[key][i]
        input.placeholder = opts.placeholder || ''
        input.spellcheck = false
        input.autocomplete = 'off'
        input.addEventListener('input', () => {
          state[key][i] = input.value
          opts.onCommit && opts.onCommit()
        })
        const rm = doc.createElement('button')
        rm.type = 'button'
        rm.className = 'mcp-config-list-remove'
        rm.textContent = 'remove'
        rm.addEventListener('click', () => {
          state[key].splice(i, 1)
          repaint()
          opts.onCommit && opts.onCommit()
        })
        itemRow.appendChild(input)
        itemRow.appendChild(rm)
        body.appendChild(itemRow)
      }
      const add = doc.createElement('button')
      add.type = 'button'
      add.className = 'mcp-config-list-add'
      add.textContent = '+ add'
      add.addEventListener('click', () => {
        state[key].push('')
        repaint()
        opts.onCommit && opts.onCommit()
      })
      body.appendChild(add)
    }
    repaint()
    return row
  }

  function mapField(doc, key, label, state, opts) {
    const row = doc.createElement('div')
    row.className = 'mcp-config-row map'
    const lbl = doc.createElement('label')
    lbl.className = 'mcp-config-key mono muted'
    lbl.textContent = label
    if (opts.hint) lbl.title = opts.hint
    row.appendChild(lbl)
    const body = doc.createElement('div')
    body.className = 'mcp-config-map-body'
    row.appendChild(body)

    function repaint() {
      body.innerHTML = ''
      const keys = Object.keys(state[key])
      for (const k of keys) {
        const itemRow = doc.createElement('div')
        itemRow.className = 'mcp-config-map-item'
        const keyInput = doc.createElement('input')
        keyInput.type = 'text'
        keyInput.className = 'mcp-config-input mono'
        keyInput.value = k
        keyInput.placeholder = opts.keyPlaceholder || 'key'
        keyInput.spellcheck = false
        keyInput.autocomplete = 'off'
        keyInput.addEventListener('change', () => {
          const nk = keyInput.value.trim()
          if (nk === k) return
          const value = state[key][k]
          delete state[key][k]
          if (nk) state[key][nk] = value
          repaint()
          opts.onCommit && opts.onCommit()
        })
        const valInput = doc.createElement('input')
        valInput.type = 'text'
        valInput.className = 'mcp-config-input mono'
        valInput.value = state[key][k] || ''
        valInput.placeholder = opts.valuePlaceholder || 'value'
        valInput.spellcheck = false
        valInput.autocomplete = 'off'
        valInput.addEventListener('input', () => {
          state[key][k] = valInput.value
          opts.onCommit && opts.onCommit()
        })
        const rm = doc.createElement('button')
        rm.type = 'button'
        rm.className = 'mcp-config-map-remove'
        rm.textContent = 'remove'
        rm.addEventListener('click', () => {
          delete state[key][k]
          repaint()
          opts.onCommit && opts.onCommit()
        })
        itemRow.appendChild(keyInput)
        itemRow.appendChild(valInput)
        itemRow.appendChild(rm)
        body.appendChild(itemRow)
      }
      const add = doc.createElement('button')
      add.type = 'button'
      add.className = 'mcp-config-map-add'
      add.textContent = '+ add'
      add.addEventListener('click', () => {
        // Seed a placeholder key so the new row is editable immediately
        // without a validation warning; the user renames it in place.
        let name = 'KEY'
        let n = 1
        while (Object.prototype.hasOwnProperty.call(state[key], name)) {
          n += 1
          name = `KEY_${n}`
        }
        state[key][name] = ''
        repaint()
        opts.onCommit && opts.onCommit()
      })
      body.appendChild(add)
    }
    repaint()
    return row
  }

  // Detect whether an entry row should host an MCP config card. The name
  // check is package-string-based so a workspace clone (`@deepseek-ai/dsh-
  // mcp-client`) and a manually pinned path both work. Case-insensitive so
  // hand-authored variants line up.
  function isMcpClientRow(entry) {
    if (!entry || typeof entry.name !== 'string') return false
    const name = entry.name.toLowerCase()
    return /mcp-client|dsh-mcp/.test(name)
  }

  // ---- exports ----------------------------------------------------------
  const API = { buildMcpConfigCard, summarize, pack, validate, isMcpClientRow }
  if (typeof module !== 'undefined' && module.exports) module.exports = API
  if (typeof window !== 'undefined') window.__dshMcpConfigCard = API
})()
