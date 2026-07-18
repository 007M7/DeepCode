// Hub page — DOM controller. Reads window.dsh.hub / window.dsh.plugins,
// projects the merged row set through hub-model.js, and paints one section
// per asset kind with plugin-first ordering. Every write action rounds
// through the preload IPC — this module never touches the filesystem.
//
// The seven sections (in paint order):
//   Plugins (hero) → Skills → Prompts → Rubrics → Profiles → Datasets → Scripts
//
// Interaction grammar per row: View (L1 preview), Edit (L2 drawer with save-
// as-new-version), Try in Playground (plugins only; other kinds show an
// honest "coming with Playground upgrade" stub), Versions (list of .bak
// files with diff-vs-current preview). Scripts add a "Run…" action that
// opens the streaming-output modal.
//
// See src/renderer/hub-model.js for the pure model + docs/design-refs for
// the L0/L1/L2 grammar and the SDK gap ledger this page terminates.

'use strict'

;(function () {
  // In the renderer (plain <script>), hub-model.js attaches itself to
  // globalThis; in node --test we require it. Either resolves to the same
  // frozen API object.
  const H = (typeof globalThis !== 'undefined' && globalThis.HubModel)
    ? globalThis.HubModel
    : (typeof require === 'function' ? require('./hub-model.js') : null)
  if (!H) { console.warn('hub-model not available; hub page inert'); return }

  const pane = document.querySelector('[data-pane="hub"]')
  if (!pane) return // pane not mounted; page inert on this build

  // Per-page state kept tiny — the source of truth is the file store on disk.
  const state = {
    rows: [],
    activePluginList: null, // last plugins.list() so we can add the runtime column
    activeRunId: null,      // one in-flight script run at a time
    activeRunEvents: null,  // stdout/stderr buffer during a live run
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
    ))
  }

  function fmtTime(iso) {
    if (!iso) return ''
    // Preflight (2026-07-18): guard Y2K threshold to catch iso strings that
    // parse into pre-2000 dates (fixture-relative or numeric-string times).
    try {
      const t = new Date(iso).getTime()
      if (!Number.isFinite(t) || t < 946684800000 /* 2000-01-01 UTC */) return ''
      return new Date(t).toLocaleString()
    } catch (_) { return String(iso) }
  }

  // Section header — glyph + label + subtitle + count chip + section actions.
  // The count chip is one of the "小巧思" the brief asked for: an at-a-glance
  // read on how many of each asset the researcher has.
  function renderSectionHead(kind, count) {
    const meta = H.KIND_META[kind]
    const chip = `<span class="hub-count-chip" title="rows in this section">${count}</span>`
    const actions = []
    // "New from template" is offered for the text-file kinds (prompt/rubric/
    // skill/profile). Plugins are added via the existing Plugins tab flow;
    // datasets grow from script runs / session exports; scripts grow via
    // paste-into-editor.
    if (['prompt', 'rubric', 'skill', 'profile'].includes(kind)) {
      actions.push(`<button class="ghost small hub-new-btn" data-kind="${kind}" title="Create a new ${kind} from a starter template">New from template</button>`)
    }
    if (kind === 'script') {
      actions.push(`<button class="ghost small hub-new-btn" data-kind="script" title="Paste a Python/Node/shell script into the local script store">Register script…</button>`)
    }
    if (kind === 'plugin') {
      actions.push(`<button class="ghost small hub-open-plugins-tab" title="Full plugin management lives in the Plugins tab">Open Plugins tab →</button>`)
    }
    return `
      <header class="hub-section-head" data-hub-kind="${kind}">
        <span class="hub-section-glyph" aria-hidden="true">${meta.glyph}</span>
        <div class="hub-section-lead">
          <div class="hub-section-title">${esc(meta.label)} ${chip}</div>
          <div class="hub-section-sub muted">${esc(meta.sub)}</div>
        </div>
        <div class="hub-section-actions">${actions.join('')}</div>
      </header>
    `
  }

  // L0 row — glyph + name + kind/version chip + right-aligned action buttons.
  // The L1 preview lives in a follow-up <details> element inserted by the
  // click handler so the row itself stays a single-line-height density.
  function renderRow(row) {
    const meta = H.KIND_META[row.kind]
    const glyph = `<span class="hub-row-glyph" aria-hidden="true">${meta.glyph}</span>`
    const name = `<span class="hub-row-name">${esc(row.name)}</span>`
    const chips = []
    chips.push(`<span class="hub-chip hub-chip-kind">${esc(row.kind)}</span>`)
    chips.push(`<span class="hub-chip hub-chip-version" title="version label">${esc(row.version)}</span>`)
    if (row.kind === 'plugin' && row.runtimeLabel) {
      chips.push(`<span class="hub-chip hub-chip-runtime hub-chip-${row.runtimeState || 'unknown'}" title="live runtime status">${esc(row.runtimeLabel)}</span>`)
    }
    if (row.kind === 'plugin' && row.source === 'user') {
      chips.push(`<span class="hub-chip hub-chip-user" title="added to the user overlay">user</span>`)
    }
    if (row.kind === 'dataset' && Number.isFinite(row.rowCount)) {
      chips.push(`<span class="hub-chip hub-chip-rows" title="row count">${row.rowCount.toLocaleString()} rows</span>`)
    }
    if (row.kind === 'script') {
      chips.push(`<span class="hub-chip hub-chip-lang" title="script language">${esc(row.lang || 'python')}</span>`)
      if (row.lastStatus) {
        chips.push(`<span class="hub-chip hub-chip-status hub-chip-${row.lastStatus}" title="last run outcome">${esc(row.lastStatus)}</span>`)
      }
    }
    const actions = [
      `<button class="ghost small hub-row-view"  data-kind="${row.kind}" data-name="${esc(row.name)}" title="Preview inline (L1)">View</button>`,
      `<button class="ghost small hub-row-edit"  data-kind="${row.kind}" data-name="${esc(row.name)}" title="Open the drawer editor (L2)">Edit</button>`,
    ]
    if (row.kind === 'script') {
      actions.push(`<button class="primary small hub-row-run"  data-kind="script" data-name="${esc(row.name)}" title="Open the execution modal">Run…</button>`)
    } else if (row.kind === 'plugin') {
      actions.push(`<button class="ghost small hub-row-playground" data-kind="plugin" data-name="${esc(row.name)}" title="Try this plugin in an isolated Playground runtime">Try in Playground</button>`)
    } else {
      actions.push(`<button class="ghost small hub-row-playground-stub" title="Loading ${row.kind} into Playground arrives with the Playground upgrade">Try in Playground</button>`)
    }
    actions.push(`<button class="ghost small hub-row-versions" data-kind="${row.kind}" data-name="${esc(row.name)}" title="List prior .bak versions">Versions</button>`)
    return `
      <li class="hub-row" data-hub-row="${row.kind}:${esc(row.name)}">
        <div class="hub-row-line">
          ${glyph}${name}
          <div class="hub-row-chips">${chips.join('')}</div>
          <div class="hub-row-actions">${actions.join('')}</div>
        </div>
        <div class="hub-row-follow" hidden></div>
      </li>
    `
  }

  function renderSection(kind, rows) {
    if (rows.length === 0) {
      return `
        <section class="hub-section hub-section-empty" data-hub-section="${kind}">
          ${renderSectionHead(kind, 0)}
          <div class="hub-empty muted">No ${kind} assets yet — use the section actions to create one.</div>
        </section>
      `
    }
    return `
      <section class="hub-section" data-hub-section="${kind}">
        ${renderSectionHead(kind, rows.length)}
        <ul class="hub-rows">${rows.map(renderRow).join('')}</ul>
      </section>
    `
  }

  function renderSdkLegend() {
    const items = H.sdkLegend().map((l) => {
      const badge = l.status === 'wire'
        ? '<span class="hub-legend-badge wire" title="live wire-backed">wire</span>'
        : `<span class="hub-legend-badge file" title="file-tier demo (gap ${l.gap || '—'})">file-tier</span>`
      const gap = l.gap ? ` <span class="muted">(${l.gap})</span>` : ''
      return `<li><code>${esc(l.id)}</code>${badge}${gap} <span class="muted">— ${esc(l.note)}</span></li>`
    }).join('')
    return `
      <footer class="hub-sdk-legend" aria-label="SDK gap ledger">
        <div class="hub-sdk-title muted">SDK legend — which actions are wire-backed today vs demo-tier file IO:</div>
        <ul class="hub-sdk-list">${items}</ul>
      </footer>
    `
  }

  // Full page paint. Kept as one big innerHTML swap because the row count is
  // small (dozens, not thousands) and rerender-on-write is simpler than
  // surgical diff. Event listeners re-attach via delegation on the pane.
  function paint() {
    const rows = H.sortHubRows(state.rows)
    const counts = H.sectionCounts(rows)
    const sections = H.KIND_ORDER.map((kind) => {
      const kindRows = rows.filter((r) => r.kind === kind)
      return renderSection(kind, kindRows)
    }).join('')
    const totalCount = rows.length
    const banner = `
      <header class="hub-page-head">
        <div class="hub-page-lead">
          <div class="page-title">Hub</div>
          <div class="page-sub muted">
            Extensibility-first asset catalog. Everything at DSH is a plugin;
            other assets are part of the plugin ecosystem. ${totalCount} rows
            across ${H.KIND_ORDER.length} kinds.
          </div>
        </div>
        <div class="hub-page-actions">
          <button id="hub-refresh" class="ghost small" title="Reload rows from disk">Refresh</button>
        </div>
      </header>
    `
    pane.innerHTML = `
      <div class="hub-scroll">
        ${banner}
        <div class="hub-sections">${sections}</div>
        ${renderSdkLegend()}
      </div>
    `
  }

  // ---------------------------------------------------------------------
  // Row action handlers — event delegation on the pane so re-renders don't
  // strand listeners. Handlers keep the row's <details> pane in sync but
  // never mutate `state.rows` directly; refresh() is the single write path.
  // ---------------------------------------------------------------------
  pane.addEventListener('click', async (e) => {
    const t = e.target
    if (!(t instanceof HTMLElement)) return
    if (t.id === 'hub-refresh') { await refresh(); return }
    if (t.classList.contains('hub-open-plugins-tab')) {
      if (window.__dshTabs) window.__dshTabs.switchTo('plugins')
      return
    }
    if (t.classList.contains('hub-new-btn')) {
      await newFromTemplate(t.dataset.kind)
      return
    }
    const rowLi = t.closest('.hub-row')
    if (!rowLi) return
    const kind = t.dataset.kind
    const name = t.dataset.name
    const follow = rowLi.querySelector('.hub-row-follow')
    if (t.classList.contains('hub-row-view')) {
      await viewRow(kind, name, follow)
    } else if (t.classList.contains('hub-row-edit')) {
      await editRow(kind, name, follow)
    } else if (t.classList.contains('hub-row-versions')) {
      await versionsRow(kind, name, follow)
    } else if (t.classList.contains('hub-row-playground')) {
      if (window.__dshTabs) window.__dshTabs.switchTo('plugins')
    } else if (t.classList.contains('hub-row-playground-stub')) {
      follow.hidden = false
      follow.innerHTML = `<div class="hub-inline-note muted">Loading a ${esc(kind)} into Playground arrives with the Playground upgrade. Today, edit the file directly and Playground reads it on next run.</div>`
    } else if (t.classList.contains('hub-row-run')) {
      await openRunModal(name)
    }
  })

  async function viewRow(kind, name, follow) {
    if (kind === 'plugin') {
      // Plugin rows have no editable file body in the demo tier — we show
      // the runtime state + package/id row instead. The Plugins tab still
      // owns the full edit surface; this preview is the L1 read.
      const row = state.rows.find((r) => r.kind === 'plugin' && r.name === name)
      follow.hidden = false
      follow.innerHTML = `
        <div class="hub-preview hub-preview-plugin">
          <div class="hub-preview-title">${esc(name)}</div>
          <div class="hub-preview-meta muted">
            source: ${esc(row && row.source ? row.source : 'base')} ·
            runtime: ${esc(row && row.runtimeLabel ? row.runtimeLabel : 'unknown')}
          </div>
          <div class="hub-inline-note muted">Full editing for plugins lives in the Plugins tab — this row is a live-status view.</div>
        </div>
      `
      return
    }
    if (kind === 'dataset') {
      const res = await window.dsh.hub.read(kind, name)
      if (!res.ok) { follow.hidden = false; follow.innerHTML = `<div class="hub-error">${esc(res.reason)}</div>`; return }
      renderDatasetPreview(follow, name, res.body)
      return
    }
    const res = await window.dsh.hub.read(kind, name)
    follow.hidden = false
    if (!res.ok) { follow.innerHTML = `<div class="hub-error">${esc(res.reason)}</div>`; return }
    follow.innerHTML = `
      <pre class="hub-preview-body"><code>${esc(res.body)}</code></pre>
    `
  }

  function renderDatasetPreview(follow, name, jsonl) {
    const rowCount = H.countJsonlRows(jsonl)
    const rows = H.previewDatasetRows(jsonl, 3)
    const columns = H.chipColumnsFor(rows)
    const chips = columns.chips.map((c) => `<span class="hub-chip hub-chip-column">${esc(c)}</span>`).join('')
    const previews = rows.map((row, i) => {
      const cells = []
      for (const chipCol of columns.chips) {
        const val = row[chipCol]
        const short = val === undefined ? '<em class="muted">—</em>'
          : (typeof val === 'string' ? esc(val).slice(0, 80)
            : esc(JSON.stringify(val)).slice(0, 80))
        cells.push(`<div class="hub-preview-cell"><span class="hub-preview-cell-key">${esc(chipCol)}</span><span class="hub-preview-cell-val">${short}</span></div>`)
      }
      return `<div class="hub-dataset-row"><div class="muted">row ${i + 1}</div>${cells.join('')}</div>`
    }).join('')
    follow.hidden = false
    follow.innerHTML = `
      <div class="hub-preview hub-preview-dataset">
        <div class="hub-preview-meta muted">${rowCount.toLocaleString()} rows · columns: ${chips || '<em>none</em>'}</div>
        <div class="hub-dataset-rows">${previews || '<div class="muted">dataset is empty</div>'}</div>
      </div>
    `
  }

  async function editRow(kind, name, follow) {
    if (kind === 'plugin') {
      follow.hidden = false
      follow.innerHTML = `<div class="hub-inline-note muted">Plugin overlay lives in the Plugins tab — <a href="#" class="hub-goto-plugins">go there</a>.</div>`
      follow.querySelector('.hub-goto-plugins').addEventListener('click', (e) => {
        e.preventDefault()
        if (window.__dshTabs) window.__dshTabs.switchTo('plugins')
      })
      return
    }
    const res = await window.dsh.hub.read(kind, name)
    if (!res.ok) { follow.hidden = false; follow.innerHTML = `<div class="hub-error">${esc(res.reason)}</div>`; return }
    follow.hidden = false
    follow.innerHTML = `
      <div class="hub-editor">
        <div class="hub-editor-head">
          <div class="hub-editor-title">${esc(name)} <span class="muted">(${esc(kind)})</span></div>
          <div class="hub-editor-actions">
            <button class="ghost small hub-editor-cancel">Cancel</button>
            <button class="primary small hub-editor-save">Save as new version</button>
          </div>
        </div>
        <textarea class="hub-editor-body" spellcheck="false">${esc(res.body)}</textarea>
        <div class="hub-editor-note muted">Saving writes the current file and archives the prior contents to a .bak sibling.</div>
      </div>
    `
    const ta = follow.querySelector('.hub-editor-body')
    follow.querySelector('.hub-editor-cancel').addEventListener('click', () => { follow.hidden = true; follow.innerHTML = '' })
    follow.querySelector('.hub-editor-save').addEventListener('click', async () => {
      const body = ta.value
      const saved = await window.dsh.hub.write(kind, name, body)
      if (!saved.ok) {
        alert(`save failed: ${saved.reason}`)
        return
      }
      follow.querySelector('.hub-editor-note').textContent =
        `Saved — ${saved.versions.length} version(s) on disk.`
      await refresh()
    })
  }

  async function versionsRow(kind, name, follow) {
    const res = await window.dsh.hub.versions(kind, name)
    if (!res.ok) { follow.hidden = false; follow.innerHTML = `<div class="hub-error">${esc(res.reason)}</div>`; return }
    follow.hidden = false
    if (!res.versions || res.versions.length <= 1) {
      follow.innerHTML = `<div class="hub-inline-note muted">Only the current version exists on disk. Save an edit to create a .bak sibling.</div>`
      return
    }
    const items = res.versions.map((v) => `
      <li class="hub-version-row">
        <span class="hub-version-label">${esc(v.label)}</span>
        <span class="hub-version-mtime muted">${esc(fmtTime(v.mtime))}</span>
        <button class="ghost small hub-version-preview" data-kind="${kind}" data-path="${esc(v.path)}" title="View this version's contents">Preview</button>
      </li>
    `).join('')
    follow.innerHTML = `
      <div class="hub-versions">
        <div class="hub-versions-title muted">${res.versions.length} version${res.versions.length === 1 ? '' : 's'} on disk</div>
        <ul class="hub-versions-list">${items}</ul>
        <div class="hub-version-preview-target"></div>
      </div>
    `
    for (const btn of follow.querySelectorAll('.hub-version-preview')) {
      btn.addEventListener('click', async () => {
        const target = follow.querySelector('.hub-version-preview-target')
        target.innerHTML = '<div class="muted">loading…</div>'
        const vres = await window.dsh.hub.readVersion(btn.dataset.kind, btn.dataset.path)
        target.innerHTML = vres.ok
          ? `<pre class="hub-preview-body"><code>${esc(vres.body)}</code></pre>`
          : `<div class="hub-error">${esc(vres.reason)}</div>`
      })
    }
  }

  async function newFromTemplate(kind) {
    const name = (window.prompt(`New ${kind} name (a-z, hyphens):`) || '').trim()
    if (!name) return
    const body = defaultBodyFor(kind, name)
    const res = await window.dsh.hub.write(kind, name, body)
    if (!res.ok) { alert(`create failed: ${res.reason}`); return }
    await refresh()
  }

  function defaultBodyFor(kind, name) {
    if (kind === 'prompt') return `# ${name}\n\nSystem-prompt fragment. Edit me.\n`
    if (kind === 'skill') return `---\nname: ${name}\ndescription: A new skill.\n---\n\n# ${name}\n\nDescribe what this skill does.\n`
    if (kind === 'rubric') return `id: ${name}\ndescription: 'A new rubric.'\nexecutor:\n  kind: regex\n  pattern: '.*'\nexpected:\n  resolved: true\n  score: 1.0\n`
    if (kind === 'profile') return `name: ${name}\ntransport: daemon\nmodel: deepseek-chat\nplugins: []\n`
    if (kind === 'script') return `#!/usr/bin/env python3\n# ${name}.py — describe me.\n# argv[1] = input JSONL path, argv[2] = output JSONL path\nimport sys, json\nwith open(sys.argv[1]) as fi, open(sys.argv[2], 'w') as fo:\n    n = 0\n    for line in fi:\n        line = line.strip()\n        if not line: continue\n        fo.write(line + '\\n')\n        n += 1\n    print(json.dumps({\"written\": n, \"dropped\": 0, \"notes\": \"passthrough\"}))\n`
    return ''
  }

  // ---------------------------------------------------------------------
  // Script run modal — three input tabs (Recent sessions / Dataset / File)
  // mapped to the single hub.script.run wire shape. Stdout streams into
  // the output panel; on exit we render the diff-summary chip and offer a
  // "Save output as new dataset version" chip.
  // ---------------------------------------------------------------------
  async function openRunModal(scriptName) {
    let modal = document.getElementById('hub-run-modal')
    if (modal) modal.remove()
    modal = document.createElement('div')
    modal.id = 'hub-run-modal'
    modal.className = 'hub-run-modal'
    const datasets = state.rows.filter((r) => r.kind === 'dataset')
    const dsOptions = datasets.map((d) => `<option value="${esc(d.name)}">${esc(d.name)} (${d.rowCount != null ? d.rowCount.toLocaleString() : '?'} rows)</option>`).join('')
    modal.innerHTML = `
      <div class="hub-run-scrim"></div>
      <div class="hub-run-card">
        <header class="hub-run-head">
          <div class="hub-run-title">Run <code>${esc(scriptName)}</code></div>
          <button class="ghost small hub-run-close" title="Close">Close</button>
        </header>
        <section class="hub-run-body">
          <div class="hub-run-inputs">
            <div class="hub-run-tabs" role="tablist">
              <button class="hub-run-tab active" data-input="dataset">Dataset</button>
              <button class="hub-run-tab" data-input="file">Local JSONL file</button>
              <button class="hub-run-tab" data-input="inline">Paste inline</button>
            </div>
            <div class="hub-run-tab-body" data-panel="dataset">
              <label class="field"><span>Pick a dataset row</span>
                <select id="hub-run-dataset">${dsOptions || '<option value="">— no datasets yet —</option>'}</select>
              </label>
            </div>
            <div class="hub-run-tab-body" data-panel="file" hidden>
              <label class="field"><span>Absolute path to a JSONL file</span>
                <input id="hub-run-file" type="text" placeholder="/path/to/rows.jsonl" />
              </label>
            </div>
            <div class="hub-run-tab-body" data-panel="inline" hidden>
              <label class="field"><span>Paste JSONL rows (one per line)</span>
                <textarea id="hub-run-inline" rows="4" spellcheck="false" placeholder='{"messages": [...]}'></textarea>
              </label>
            </div>
          </div>
          <div class="hub-run-security-note muted">
            Runs locally with your user permissions. Only run scripts you (or a
            teammate you trust) wrote. See the SDK legend for the isolated-daemon
            upgrade path.
          </div>
          <div class="hub-run-actions">
            <button id="hub-run-cancel" class="ghost small" hidden>Cancel run</button>
            <button id="hub-run-start" class="primary small">Run</button>
          </div>
        </section>
        <section class="hub-run-output" hidden>
          <div class="hub-run-status" id="hub-run-status">idle</div>
          <pre class="hub-run-stdout" id="hub-run-stdout"></pre>
          <pre class="hub-run-stderr" id="hub-run-stderr" hidden></pre>
          <div class="hub-run-summary" id="hub-run-summary" hidden></div>
        </section>
      </div>
    `
    document.body.appendChild(modal)
    // Tab switching inside the modal.
    for (const tab of modal.querySelectorAll('.hub-run-tab')) {
      tab.addEventListener('click', () => {
        for (const t of modal.querySelectorAll('.hub-run-tab')) t.classList.toggle('active', t === tab)
        for (const p of modal.querySelectorAll('.hub-run-tab-body')) p.hidden = p.dataset.panel !== tab.dataset.input
      })
    }
    modal.querySelector('.hub-run-scrim').addEventListener('click', close)
    modal.querySelector('.hub-run-close').addEventListener('click', close)
    modal.querySelector('#hub-run-start').addEventListener('click', () => start(scriptName, modal))
    modal.querySelector('#hub-run-cancel').addEventListener('click', () => cancel(modal))
    function close() {
      // Cancel a live run if the user closes mid-stream so we don't leak
      // a background child process.
      if (state.activeRunId) cancel(modal)
      modal.remove()
    }
  }

  async function start(scriptName, modal) {
    const activeTab = modal.querySelector('.hub-run-tab.active')
    const kind = activeTab.dataset.input
    let input
    if (kind === 'dataset') {
      const sel = modal.querySelector('#hub-run-dataset').value
      if (!sel) { alert('Pick a dataset first, or upload a JSONL file.'); return }
      input = { kind: 'dataset', name: sel }
    } else if (kind === 'file') {
      const p = modal.querySelector('#hub-run-file').value.trim()
      if (!p) { alert('Enter a JSONL file path.'); return }
      input = { kind: 'file', path: p }
    } else {
      const body = modal.querySelector('#hub-run-inline').value
      input = { kind: 'inline', body }
    }
    const runId = 'r-' + Math.random().toString(36).slice(2, 10)
    state.activeRunId = runId
    state.activeRunEvents = { stdout: '', stderr: '' }
    modal.querySelector('.hub-run-output').hidden = false
    modal.querySelector('#hub-run-status').textContent = 'starting…'
    modal.querySelector('#hub-run-stdout').textContent = ''
    modal.querySelector('#hub-run-stderr').textContent = ''
    modal.querySelector('#hub-run-stderr').hidden = true
    modal.querySelector('#hub-run-summary').hidden = true
    modal.querySelector('#hub-run-start').disabled = true
    modal.querySelector('#hub-run-cancel').hidden = false

    const res = await window.dsh.hub.script.run({ scriptName, input, runId })
    if (!res.ok) {
      modal.querySelector('#hub-run-status').textContent = `failed to spawn: ${res.reason}`
      modal.querySelector('#hub-run-start').disabled = false
      modal.querySelector('#hub-run-cancel').hidden = true
      state.activeRunId = null
      return
    }
    modal.querySelector('#hub-run-status').textContent = `running (runId ${res.runId})`
  }

  async function cancel(modal) {
    if (!state.activeRunId) return
    await window.dsh.hub.script.cancel(state.activeRunId)
    if (modal) modal.querySelector('#hub-run-status').textContent = 'cancelled'
    state.activeRunId = null
  }

  // Wire the streaming events. The preload bridge routes hub:scriptEvent to
  // this listener; we demux by runId so a second modal opening doesn't cross
  // streams. Attached at module load — `onScriptEvent` is idempotent from
  // the preload perspective (adds a listener; return value is a disposer we
  // don't hold on to for the demo lifetime).
  if (window.dsh && window.dsh.hub && typeof window.dsh.hub.onScriptEvent === 'function') {
    window.dsh.hub.onScriptEvent((payload) => {
      if (!payload || payload.runId !== state.activeRunId) return
      const modal = document.getElementById('hub-run-modal')
      if (!modal) return
      if (payload.stream === 'stdout') {
        state.activeRunEvents.stdout += payload.chunk
        modal.querySelector('#hub-run-stdout').textContent = state.activeRunEvents.stdout
      } else if (payload.stream === 'stderr') {
        state.activeRunEvents.stderr += payload.chunk
        const el = modal.querySelector('#hub-run-stderr')
        el.hidden = false
        el.textContent = state.activeRunEvents.stderr
      } else if (payload.stream === 'exit') {
        const status = modal.querySelector('#hub-run-status')
        const summaryEl = modal.querySelector('#hub-run-summary')
        status.textContent = payload.code === 0
          ? `finished · exit 0`
          : `finished · exit ${payload.code}${payload.signal ? ' · ' + payload.signal : ''}`
        // Row-count delta chip. We don't know the input row count from here
        // (main computed it internally); the summary object carries what we
        // need for the demo.
        const summary = payload.summary || { written: null, dropped: null, notes: '' }
        const inputRows = summary.dropped != null && summary.written != null
          ? summary.written + summary.dropped
          : NaN
        summaryEl.hidden = false
        summaryEl.innerHTML = `
          <div class="hub-run-summary-line"><strong>Summary:</strong>
            ${esc(H.formatDiffSummary({ inputRows, summary, outputRows: payload.outputRows }))}
          </div>
          <div class="hub-run-summary-meta muted">output: <code>${esc(payload.outputPath || '')}</code></div>
        `
        modal.querySelector('#hub-run-start').disabled = false
        modal.querySelector('#hub-run-cancel').hidden = true
        state.activeRunId = null
        // Refresh so the script row's lastStatus updates and any new dataset
        // artefacts (a future step of the demo) light up.
        void refresh()
      }
    })
  }

  // ---------------------------------------------------------------------
  // Refresh — pulls the hub asset list + plugin runtime state and paints.
  // Plugins are merged into the row set here so the Plugins section stays
  // wire-backed (source of truth = daemon), not file-tier.
  // ---------------------------------------------------------------------
  async function refresh() {
    const rows = []
    try {
      const hubList = await window.dsh.hub.list()
      for (const r of hubList.rows || []) rows.push(H.normaliseRow(r.kind, r))
    } catch (err) {
      // Non-fatal: paint the page with whatever we have (probably nothing).
      console.warn('hub.list failed:', err.message)
    }
    // Merge plugin runtime rows. The Plugins tab already knows how to read
    // this shape; we lift it verbatim so the Hub's row grammar matches.
    try {
      const list = await window.dsh.plugins.list()
      state.activePluginList = list
      const runtime = await window.dsh.plugins.listRuntime().catch(() => ({ supported: false }))
      for (const entry of (list.entries || [])) {
        const runtimeState = runtime.supported && Array.isArray(runtime.plugins)
          ? (runtime.plugins.find((p) => (p.name || '').includes(entry.id))?.state || null)
          : null
        rows.push(H.normaliseRow('plugin', {
          name: entry.id,
          description: entry.name || '',
          path: entry.name || '',
          source: entry.source || 'base',
          runtimeState,
          runtimeLabel: runtimeState || (runtime.supported ? 'not loaded' : 'unknown'),
        }))
      }
    } catch (err) {
      console.warn('plugins.list failed inside hub:', err.message)
    }
    state.rows = rows
    paint()
  }

  // Public API — the tab switcher in renderer.js calls show() on activation.
  window.__dshHub = {
    show: () => { void refresh() },
    refresh,
    // Test seam: allow the QA driver to seed rows without touching disk.
    __setRows: (rows) => { state.rows = rows.map((r) => H.normaliseRow(r.kind, r)); paint() },
  }
})()
