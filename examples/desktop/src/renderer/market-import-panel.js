// Plugins tab · Browse subview · "Import from…" panel.
//
// Audit `docs/plugin-mcp-audit.md` §3.1 said the market can only install curated
// index rows: user asked "can I bring in an open-source project?" — no. Kernel-
// side, cordis leaf entries have three shapes (see src/main/plugin-validation.js
// classifyName): `package` for `@scope/pkg`, `relative-path` for `./…`, and
// `absolute-path` for `/…`. `plugins.add(id, name, config?)` already writes any
// of them via the overlay patch stack — the gap is UI: no field for the user to
// pick a shape, so the market has been "curated only" in practice.
//
// This panel offers three shapes as a segmented control:
//   · Workspace package — the audit's minimum ask (bare `@deepseek-ai/dsh-*`).
//     A raw text input scoped to the workspace-package convention.
//   · Local path       — either a `./` relative path or an absolute path
//     (dropped straight into `name`); classified downstream.
//   · Git URL          — deliberately disabled, tooltip explains "coming soon"
//     (no kernel clone-and-mount pipeline yet; see audit §3.1 row 4).
//
// One patch per import; id is user-provided (must be unique across the base
// leaf + overlay; the main-process handler at src/main/main.js:550 rejects
// duplicates). No config here — the MCP-server card handles configuration for
// dsh-mcp-client rows separately.

'use strict'

;(function () {
  // Public surface:
  //   buildImportPanel(doc, api) → HTMLElement
  //     · doc: Document ref (test injection point)
  //     · api: { onImport: async ({ id, name }) => void  ; called with the
  //                          user's typed row; parent wires this to
  //                          window.dsh.plugins.add + market refresh }
  function buildImportPanel(doc, api) {
    const wrap = doc.createElement('section')
    wrap.className = 'market-import-panel'

    const header = doc.createElement('div')
    header.className = 'market-import-header'
    const title = doc.createElement('h3')
    title.className = 'market-import-title'
    title.textContent = 'Import from…'
    const sub = doc.createElement('p')
    sub.className = 'market-import-sub muted'
    sub.textContent = 'Bring in a plugin outside the curated index — pick a source shape below and fill in the fields.'
    header.appendChild(title)
    header.appendChild(sub)
    wrap.appendChild(header)

    // Segmented control: workspace-pkg / local-path / git-url.
    const seg = doc.createElement('div')
    seg.className = 'market-import-seg'
    seg.setAttribute('role', 'tablist')
    const shapes = [
      { key: 'workspace', label: 'workspace pkg', title: 'Bare package specifier from the workspace, e.g. @deepseek-ai/dsh-echo.' },
      { key: 'path',      label: 'local path',    title: 'Relative (./…) or absolute path to a cordis plugin folder or file.' },
      { key: 'git',       label: 'git URL',       title: 'Coming soon — kernel spike needed for clone → install → mount.', disabled: true },
    ]
    const state = { shape: 'workspace' }
    const shapeButtons = []
    for (const s of shapes) {
      const btn = doc.createElement('button')
      btn.type = 'button'
      btn.className = 'market-import-seg-btn' + (s.key === state.shape ? ' active' : '') + (s.disabled ? ' disabled' : '')
      btn.dataset.shape = s.key
      btn.textContent = s.label
      btn.title = s.title
      btn.setAttribute('role', 'tab')
      btn.setAttribute('aria-selected', String(s.key === state.shape))
      if (s.disabled) {
        btn.setAttribute('aria-disabled', 'true')
        btn.disabled = true
      } else {
        btn.addEventListener('click', () => {
          state.shape = s.key
          for (const b of shapeButtons) {
            const on = b.dataset.shape === s.key
            b.classList.toggle('active', on)
            b.setAttribute('aria-selected', String(on))
          }
          renderForm()
        })
      }
      shapeButtons.push(btn)
      seg.appendChild(btn)
    }
    wrap.appendChild(seg)

    // Form body (rebuilt when shape flips).
    const form = doc.createElement('div')
    form.className = 'market-import-form'
    wrap.appendChild(form)

    // Status line + submit button.
    const footer = doc.createElement('div')
    footer.className = 'market-import-footer'
    const status = doc.createElement('span')
    status.className = 'market-import-status muted'
    const spacer = doc.createElement('span')
    spacer.className = 'market-import-spacer'
    const submitBtn = doc.createElement('button')
    submitBtn.type = 'button'
    submitBtn.className = 'primary market-import-submit'
    submitBtn.textContent = 'Import'
    submitBtn.disabled = true
    submitBtn.addEventListener('click', async () => {
      const validation = validate(state)
      if (validation.error) {
        status.textContent = validation.error
        status.classList.add('error')
        return
      }
      status.classList.remove('error')
      submitBtn.disabled = true
      status.textContent = 'Importing…'
      try {
        const importedId = state.id
        await api.onImport({ id: importedId, name: state.name })
        // Clear the inputs so the next import starts from a fresh state; the
        // shape stays selected because the user was probably about to add
        // another entry of the same kind. renderForm() runs markDirty(),
        // which resets the status line — set the success message AFTER that
        // so it survives.
        state.id = ''
        state.name = ''
        renderForm()
        status.classList.remove('error')
        status.textContent = `Imported "${importedId}" — apply to restart.`
      } catch (err) {
        status.classList.add('error')
        status.textContent = `import failed: ${err && err.message ? err.message : err}`
        submitBtn.disabled = false
      }
    })
    footer.appendChild(status)
    footer.appendChild(spacer)
    footer.appendChild(submitBtn)
    wrap.appendChild(footer)

    function markDirty() {
      const v = validate(state)
      submitBtn.disabled = !!v.error
      if (v.error) {
        status.textContent = ''
        status.classList.remove('error')
      } else {
        status.textContent = ''
        status.classList.remove('error')
      }
    }

    function renderForm() {
      form.innerHTML = ''
      state.id = state.id || ''
      state.name = state.name || ''
      // ID field is shared across all shapes (cordis patch id, must be
      // unique across the base leaf + overlay).
      form.appendChild(field(doc, {
        label: 'id',
        placeholder: 'unique-id (e.g. gh-mcp, my-echo)',
        hint: 'Unique key for this overlay patch. Must not collide with the base leaf.',
        value: state.id,
        onInput: (v) => { state.id = v.trim(); markDirty() },
      }))
      if (state.shape === 'workspace') {
        form.appendChild(field(doc, {
          label: 'package',
          placeholder: '@deepseek-ai/dsh-echo',
          hint: 'A workspace package specifier — must resolve on the daemon\'s node module path.',
          value: state.name,
          onInput: (v) => { state.name = v.trim(); markDirty() },
        }))
      } else if (state.shape === 'path') {
        form.appendChild(field(doc, {
          label: 'path',
          placeholder: './packages/my-plugin  or  /abs/path/to/plugin',
          hint: 'Relative to the leaf file (starts with ./ or ../), or an absolute path.',
          value: state.name,
          onInput: (v) => { state.name = v; markDirty() }, // path preserves whitespace-adjacent chars
        }))
      } else if (state.shape === 'git') {
        const note = doc.createElement('div')
        note.className = 'market-import-note muted'
        note.textContent = 'Git URL import is coming soon — the kernel needs a clone-and-mount pipeline first (audit §3.1). For now, git-clone the plugin manually and import it via "local path".'
        form.appendChild(note)
      }
      markDirty()
    }
    renderForm()

    return wrap
  }

  // Reusable labeled input row. Kept private to this module because the
  // Plugins-tab-wide `stringField` in plugins-mcp-card.js is scoped to the
  // MCP config card grammar (has hint titles on labels, mono value inputs);
  // the import panel uses a more prosaic column-label layout to match the
  // marketplace hero grammar.
  function field(doc, opts) {
    const row = doc.createElement('div')
    row.className = 'market-import-row'
    const lbl = doc.createElement('label')
    lbl.className = 'market-import-label mono muted'
    lbl.textContent = opts.label
    if (opts.hint) lbl.title = opts.hint
    const input = doc.createElement('input')
    input.type = 'text'
    input.className = 'market-import-input mono'
    input.value = opts.value || ''
    input.placeholder = opts.placeholder || ''
    input.spellcheck = false
    input.autocomplete = 'off'
    input.addEventListener('input', () => opts.onInput(input.value))
    row.appendChild(lbl)
    row.appendChild(input)
    return row
  }

  // Validate — returns { error: null } on ready-to-submit. Empty fields are
  // silent (no error message shown) but disable Submit; explicit shape
  // violations light the error tone.
  function validate(state) {
    if (!state.id) return { error: '' } // silent
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(state.id)) {
      return { error: 'id must be 1–64 chars [A-Za-z0-9_.-]' }
    }
    if (state.shape === 'workspace') {
      if (!state.name) return { error: '' }
      if (!/^@?[A-Za-z0-9_./-]+$/.test(state.name)) {
        return { error: 'package must be a valid npm specifier (letters, digits, _./-, optional @scope).' }
      }
      // Enforce the workspace convention rather than silently accepting a
      // path-shaped value in this branch — the "local path" tab is the
      // right home for that.
      if (state.name.startsWith('.') || state.name.startsWith('/')) {
        return { error: 'path-shaped values belong under "local path".' }
      }
    } else if (state.shape === 'path') {
      if (!state.name) return { error: '' }
      const isRel = state.name.startsWith('./') || state.name.startsWith('../')
      const isAbs = state.name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(state.name)
      if (!isRel && !isAbs) {
        return { error: 'path must start with ./ or ../ (relative) or / (absolute).' }
      }
    } else {
      return { error: '' } // git-URL branch cannot submit yet
    }
    return { error: null }
  }

  // ---- exports ------------------------------------------------------------
  const API = { buildImportPanel, validate }
  if (typeof module !== 'undefined' && module.exports) module.exports = API
  if (typeof window !== 'undefined') window.__dshMarketImport = API
})()
