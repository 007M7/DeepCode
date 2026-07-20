// Rubrics page — catalog-first evaluator library.
//
// Layout (top-to-bottom in the main pane):
//   1. Page header: "Rubrics" title + task-count subtitle (28 subtasks, 7 groups)
//   2. Grouped tile grid — one row per task category, each tile = a rubric
//      with checklist preview, executor kind, and "Attach to Bench" chip.
//   3. Fallback CTA below the fold: "Create from scratch" (two cards — LLM-judge
//      and Code executor). Follows the LangSmith §9.2 evaluator-catalog rule
//      that "from scratch" is a fallback CTA, not the hero.
//   4. Rubric detail view (activates on tile click) — L1 checklist render,
//      L2 raw SKILL.md drawer with copy-to-clipboard, version chip.
//
// Data flow:
//   - Fixture rubrics live at fixtures/rubrics/*.md and are shipped as script
//     tags on the page (fetched via the __dshRubricsFixtures blob so we avoid
//     the CSP file:// gotchas). The renderer parses them via
//     rubrics-model.parseRubricFile then buildCatalog.
//   - User-authored rubrics under .dsh/rubrics/ would come via a preload IPC
//     (G1 gap); the demo synthesizes an empty overlay so the UX is complete.
//
// This module registers `window.__dshRubrics` with `mount()` + `show()` +
// `renderCatalog()` (test hook). renderer.js's tab switcher calls .show() on
// activation.

/* global window, document */

;(function () {
  'use strict'

  // The pure model is loaded via a preceding `<script>` tag — read from
  // the global it exports. The require() branch is only for node --test.
  const model = (typeof window !== 'undefined' && window.__dshRubricsModel)
    ? window.__dshRubricsModel
    : (typeof require === 'function' ? require('./rubrics-model.js') : {})

  // Fusion store — same singleton used by Growth/Runtime; seeded once on
  // first render so the three views share the exact same event log.
  const fusion = (typeof window !== 'undefined' && window.__dshRubricFusion)
    ? window.__dshRubricFusion
    : null
  let fusionSeeded = false
  function seedFusionOnce() {
    if (fusionSeeded || !fusion) return
    const seed = (typeof window !== 'undefined' && window.__dshRubricFusionSeed) || null
    if (seed) fusion.loadFixture(seed)
    fusionSeeded = true
  }

  // Renderer state — kept minimal + re-derivable, per the same pattern as
  // pr-page.js. Every write triggers a re-render of the affected region.
  const state = {
    rubrics: [],           // parsed fixture + overlay rubrics
    catalog: [],           // buildCatalog(rubrics) — grouped view
    active: null,          // currently-focused rubric id (for detail view)
    editMode: false,       // in the L2 drawer, is the raw editor active?
    createForm: null,      // Create-from-scratch draft; null when the form
                           // is closed. Shape: {
                           //   name, group, executor, colorDot,
                           //   dimName, dimType, min, max, values, labels,
                           //   hintClassId?, hintPromptSummary?
                           // }.
    dismissedHints: new Set(),  // similar-session hint class ids the user
                                // dismissed this session.
  }

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

  // Load bundled fixture rubrics. The main process exposes them via IPC as
  // an array of raw file bodies; if that seam isn't wired (demo/test), we
  // fall back to the four names via a __dshRubricsSeed global that the
  // debug-fixtures harness populates for CDP tests.
  async function loadFixtures() {
    if (window.dsh && window.dsh.rubrics && typeof window.dsh.rubrics.list === 'function') {
      try {
        const list = await window.dsh.rubrics.list()
        if (Array.isArray(list) && list.length) return list
      } catch (_) { /* fall through */ }
    }
    if (Array.isArray(window.__dshRubricsSeed)) return window.__dshRubricsSeed.slice()
    return []
  }

  function templateBadge(templateId) {
    const t = model.TEMPLATES && model.TEMPLATES[templateId]
    const name = t ? t.name : templateId
    return el('span', { className: 'rubric-tpl-badge', 'data-tpl': templateId, text: name })
  }

  function renderTile(rubric) {
    const preview = model.checklistPreview(rubric)
    return el('button', {
      className: 'rubric-tile',
      'data-rubric-id': rubric.id,
      type: 'button',
      onclick: () => openDetail(rubric.id),
    }, [
      el('div', { className: 'rubric-tile-head' }, [
        el('span', { className: 'rubric-tile-name', text: rubric.name }),
        templateBadge(rubric.template),
      ]),
      el('div', { className: 'rubric-tile-desc muted small', text: rubric.description || '' }),
      el('div', { className: 'rubric-tile-preview', text: preview || 'No checklist items.' }),
      renderTileStatsStrip(rubric),
      el('div', { className: 'rubric-tile-foot' }, [
        el('span', { className: 'rubric-tile-executor muted small', text: rubric.executor === 'code' ? 'Code executor' : 'LLM-as-judge' }),
        el('span', { className: 'rubric-tile-attach chip small', text: 'Attach to Bench' }),
      ]),
    ])
  }

  // Recent-scores mini strip — total scored + pass-rate% + 8 sparkline
  // pass/fail dots. Reads from the fusion event log. Renders an empty
  // placeholder when there are no scores yet (keeps tile height stable).
  function renderTileStatsStrip(rubric) {
    if (!fusion) return el('div', { className: 'rubric-tile-stats empty' })
    const stats = fusion.recentScoresFor(rubric.id, 8)
    if (!stats || !stats.total) {
      return el('div', { className: 'rubric-tile-stats empty muted small', text: 'No scores yet' })
    }
    const pct = Math.round(stats.passRate * 100)
    const dots = stats.latest.slice().reverse().map(evt => el('span', {
      className: 'rubric-tile-stats-dot ' + (evt.passed ? 'pass' : 'fail'),
      title: evt.dimId + ' · ' + (evt.passed ? 'pass' : 'fail'),
    }))
    return el('div', { className: 'rubric-tile-stats', 'data-testid': 'tile-stats-' + rubric.id }, [
      el('span', { className: 'rubric-tile-stats-total small', text: stats.total + ' scored' }),
      el('span', { className: 'rubric-tile-stats-rate small' + (pct >= 50 ? ' pass' : ' fail'), text: pct + '% pass' }),
      el('span', { className: 'rubric-tile-stats-spark' }, dots),
    ])
  }

  function renderGroupSection(group) {
    const isEmpty = !group.rubrics.length
    const rows = isEmpty
      ? [el('div', { className: 'rubric-group-empty muted small',
          text: 'No rubrics in this group yet. Fork a catalog rubric or create from scratch below.' })]
      : group.rubrics.map(renderTile)
    return el('section', { className: 'rubric-group', 'data-group-id': group.category.id }, [
      el('header', { className: 'rubric-group-head' }, [
        el('div', { className: 'rubric-group-title', text: group.category.name }),
        el('div', { className: 'rubric-group-hint muted small', text: group.category.hint }),
        el('div', { className: 'rubric-group-count muted small',
          text: group.category.subtasks && group.category.subtasks.length
            ? group.category.subtasks.length + ' subtasks'
            : '' }),
      ]),
      el('div', { className: 'rubric-group-grid' }, rows),
    ])
  }

  function renderFallbackCTA() {
    return el('section', { className: 'rubric-fallback' }, [
      el('div', { className: 'rubric-fallback-head' }, [
        el('div', { className: 'rubric-fallback-title muted small', text: 'Create from scratch' }),
        el('div', { className: 'rubric-fallback-hint muted small', text: 'Start blank when the catalog does not cover your evaluation.' }),
      ]),
      el('div', { className: 'rubric-fallback-cards' }, [
        el('button', {
          className: 'rubric-fallback-card',
          type: 'button',
          onclick: () => openCreateForm('llm-judge'),
        }, [
          el('div', { className: 'rubric-fallback-icon', text: '✦' }),
          el('div', { className: 'rubric-fallback-card-title', text: 'LLM-as-Judge rubric' }),
          el('div', { className: 'rubric-fallback-card-desc muted small', text: 'Write a prompt-based scorer. Pick a dimension type (Continuous / Categorical / Boolean) — the judge model emits values that match.' }),
        ]),
        el('button', {
          className: 'rubric-fallback-card',
          type: 'button',
          onclick: () => openCreateForm('code'),
        }, [
          el('div', { className: 'rubric-fallback-icon', text: '{ }' }),
          el('div', { className: 'rubric-fallback-card-title', text: 'Code executor rubric' }),
          el('div', { className: 'rubric-fallback-card-desc muted small', text: 'Write a Python or JavaScript function. Same dimension-type primitives; runs in the isolated daemon.' }),
        ]),
      ]),
      // Create form drops in below the cards when active.  This mirrors
      // LangSmith's "Creating new feedback config" popover shape (see
      // docs/design-refs/langsmith-live//15-create-feedback-form.png)
      // but rendered inline rather than as an overlay so the fallback
      // context stays visible.
      state.createForm ? renderCreateForm() : null,
    ])
  }

  // ------- Create-from-scratch form (typed rubric primitive) -------

  function openCreateForm(executorKind) {
    state.createForm = {
      name: 'new-rubric',
      group: 'code-gen',
      executor: executorKind || 'llm-judge',
      colorDot: '#7a5af8',
      dimName: 'quality',
      dimType: 'continuous',
      min: 0,
      max: 1,
      values: ['bad', 'ok', 'good'],
      labels: { true: 'true', false: 'false' },
    }
    renderCatalog()
    // Scroll to the form after paint so the reader lands on it.
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        const f = document.querySelector('.rubric-create-form')
        if (f && typeof f.scrollIntoView === 'function') {
          try { f.scrollIntoView({ behavior: 'smooth', block: 'center' }) } catch (_) { /* ignore */ }
        }
      })
    }
  }

  function closeCreateForm() {
    state.createForm = null
    renderCatalog()
  }

  function updateCreateForm(patch) {
    state.createForm = { ...state.createForm, ...patch }
    // Only rerender the form region (cheap enough) — full renderCatalog
    // repaints everything including the group grid, which is fine at demo
    // scale and keeps the code straightforward.
    renderCatalog()
  }

  function renderCreateForm() {
    const cf = state.createForm
    if (!cf) return null
    const DIM_TYPES = (model.DIMENSION_TYPES || [
      { id: 'continuous', label: 'Continuous' },
      { id: 'categorical', label: 'Categorical' },
      { id: 'boolean', label: 'Boolean' },
    ])
    // Feedback Tag row — name + color-dot picker (LangSmith parity).  The
    // color dot is purely presentational (frontmatter-only) so we render
    // a small palette rather than a full color picker.
    const nameInput = el('input', {
      type: 'text',
      className: 'rubric-create-input',
      value: cf.dimName,
      placeholder: 'Enter feedback tag',
    })
    nameInput.addEventListener('input', () => updateCreateForm({ dimName: nameInput.value }))
    const colorRow = el('div', { className: 'rubric-create-color-row' })
    const colors = ['#7a5af8', '#e0aaff', '#ffb347', '#79d17b', '#f96e6e', '#71c9ce', '#c0c0c0']
    for (const c of colors) {
      const dot = el('button', {
        type: 'button',
        className: 'rubric-create-color-dot' + (c === cf.colorDot ? ' active' : ''),
        'data-color': c,
        'aria-label': 'Color ' + c,
        title: c,
        onclick: () => updateCreateForm({ colorDot: c }),
      })
      dot.style.background = c
      colorRow.appendChild(dot)
    }

    // Type dropdown.
    const typeSel = el('select', { className: 'rubric-create-select' })
    for (const t of DIM_TYPES) {
      const opt = el('option', { value: t.id, text: t.label })
      if (cf.dimType === t.id) opt.selected = true
      typeSel.appendChild(opt)
    }
    typeSel.addEventListener('change', () => updateCreateForm({ dimType: typeSel.value }))

    // Type-specific fields.
    const typeFields = renderCreateFormTypeFields(cf)

    // Save + Cancel row.  Save writes an in-memory rubric so the catalog
    // picks it up immediately; a real disk write awaits the G1
    // library/put wire method — surfaced as a muted note next to the
    // button (same pattern openBlank uses for raw-editor saves).
    const saveBtn = el('button', {
      type: 'button',
      className: 'primary small rubric-create-save',
      text: 'Save',
      onclick: () => saveCreateForm(),
    })
    const cancelBtn = el('button', {
      type: 'button',
      className: 'ghost small rubric-create-cancel',
      text: 'Cancel',
      onclick: closeCreateForm,
    })

    return el('div', { className: 'rubric-create-form', role: 'form',
      'aria-label': 'Creating new feedback config' }, [
      el('div', { className: 'rubric-create-head' }, [
        el('button', {
          type: 'button', className: 'ghost small rubric-create-back',
          'aria-label': 'Back', title: 'Close (Esc)',
          text: '‹', onclick: closeCreateForm,
        }),
        el('span', { className: 'rubric-create-title', text: 'Creating new feedback config' }),
      ]),
      el('div', { className: 'rubric-create-body' }, [
        el('label', { className: 'rubric-create-label small', text: 'Feedback Tag' }),
        el('div', { className: 'rubric-create-tag-row' }, [colorRow, nameInput]),
        el('label', { className: 'rubric-create-label small', text: 'Type' }),
        typeSel,
        typeFields,
      ]),
      el('div', { className: 'rubric-create-actions' }, [
        saveBtn,
        cancelBtn,
        el('span', { className: 'muted tiny',
          text: 'Demo: saves to memory. Persistent write awaits G1 library/put.' }),
      ]),
    ])
  }

  function renderCreateFormTypeFields(cf) {
    if (cf.dimType === 'continuous') {
      const minInp = el('input', { type: 'number', className: 'rubric-create-input',
        value: String(cf.min), step: 'any' })
      minInp.addEventListener('change', () => {
        const n = Number(minInp.value)
        if (Number.isFinite(n)) updateCreateForm({ min: n })
      })
      const maxInp = el('input', { type: 'number', className: 'rubric-create-input',
        value: String(cf.max), step: 'any' })
      maxInp.addEventListener('change', () => {
        const n = Number(maxInp.value)
        if (Number.isFinite(n)) updateCreateForm({ max: n })
      })
      return el('div', { className: 'rubric-create-type-fields rubric-create-continuous' }, [
        el('label', { className: 'rubric-create-label small', text: 'Minimum' }),
        minInp,
        el('label', { className: 'rubric-create-label small', text: 'Maximum' }),
        maxInp,
      ])
    }
    if (cf.dimType === 'categorical') {
      const csv = (cf.values || []).join(', ')
      const inp = el('input', { type: 'text', className: 'rubric-create-input',
        value: csv, placeholder: 'e.g. bad, ok, good' })
      inp.addEventListener('input', () => {
        const parsed = inp.value.split(',').map(s => s.trim()).filter(Boolean)
        state.createForm = { ...state.createForm, values: parsed.length ? parsed : ['bad', 'ok', 'good'] }
        // Skip full re-render on every keystroke to avoid stealing input
        // focus; user sees the effect on save/type-toggle.
      })
      return el('div', { className: 'rubric-create-type-fields rubric-create-categorical' }, [
        el('label', { className: 'rubric-create-label small', text: 'Values (comma-separated)' }),
        inp,
        el('div', { className: 'rubric-create-hint muted tiny',
          text: 'The judge emits one of these strings; export preserves the enum text.' }),
      ])
    }
    // boolean
    const trueInp = el('input', { type: 'text', className: 'rubric-create-input',
      value: (cf.labels && cf.labels.true) || 'true' })
    trueInp.addEventListener('input', () => {
      state.createForm = { ...state.createForm,
        labels: { ...cf.labels, true: trueInp.value || 'true' } }
    })
    const falseInp = el('input', { type: 'text', className: 'rubric-create-input',
      value: (cf.labels && cf.labels.false) || 'false' })
    falseInp.addEventListener('input', () => {
      state.createForm = { ...state.createForm,
        labels: { ...cf.labels, false: falseInp.value || 'false' } }
    })
    return el('div', { className: 'rubric-create-type-fields rubric-create-boolean' }, [
      el('label', { className: 'rubric-create-label small', text: 'True label' }),
      trueInp,
      el('label', { className: 'rubric-create-label small', text: 'False label' }),
      falseInp,
    ])
  }

  // Build a SKILL.md body for the current draft — deterministic so the
  // pure model round-trips it via parseRubricFile.
  function draftAsMarkdown(cf) {
    const dimSpec = buildDraftDimensionLine(cf)
    return [
      '---',
      'name: ' + slug(cf.dimName),
      'group: ' + cf.group,
      'template: fixed',
      'executor: ' + (cf.executor || 'llm-judge'),
      'version: draft',
      'description: Draft — created via Rubrics · Create from scratch',
      '---',
      '',
      '## Dimensions',
      '- ' + dimSpec,
      '',
      '## Checklist',
      '- ',
      '',
    ].join('\n')
  }

  function buildDraftDimensionLine(cf) {
    const id = slug(cf.dimName)
    if (cf.dimType === 'continuous') {
      return `${id} :: continuous :: ${cf.min}-${cf.max} :: ${cf.dimName}`
    }
    if (cf.dimType === 'categorical') {
      const vals = (cf.values || ['bad', 'ok', 'good']).join(',')
      return `${id} :: categorical :: ${vals} :: ${cf.dimName}`
    }
    const t = (cf.labels && cf.labels.true) || 'true'
    const f = (cf.labels && cf.labels.false) || 'false'
    return `${id} :: boolean :: ${t}/${f} :: ${cf.dimName}`
  }

  function slug(s) {
    return String(s || 'unnamed').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed'
  }

  function saveCreateForm() {
    const cf = state.createForm
    if (!cf) return
    const raw = draftAsMarkdown(cf)
    const parsed = model.parseRubricFile(raw)
    if (!parsed) return
    // In-memory insertion — persistent write goes through the (still
    // TBD) G1 seam.  Two-line note in the button row keeps the user
    // aware of the boundary.
    const idx = state.rubrics.findIndex(r => r.id === parsed.id)
    if (idx >= 0) state.rubrics.splice(idx, 1, parsed)
    else state.rubrics.push(parsed)
    state.catalog = model.buildCatalog(state.rubrics)
    // Try the optional wire method if the preload seam exists.  This is
    // the G1 library/put that will land the file under user rubric dir.
    if (typeof window !== 'undefined' && window.dsh && window.dsh.rubrics && typeof window.dsh.rubrics.save === 'function') {
      try { void window.dsh.rubrics.save({ name: parsed.name, body: raw }) } catch (_) { /* best-effort */ }
    }
    // Tell the annotation drawer to score against this rubric — the
    // reader can now click "Rate trajectory" and see the new dim
    // controls immediately (Continuous button row / Categorical enum /
    // Boolean toggle).
    if (typeof window !== 'undefined' && window.__dshAnnotation && typeof window.__dshAnnotation.setActiveRubric === 'function') {
      try { window.__dshAnnotation.setActiveRubric(parsed) } catch (_) { /* ignore */ }
    }
    closeCreateForm()
    // Fire a signal so other lanes can react (e.g. Bench builder listing
    // an "attached" rubric).  Follows the same pattern as the existing
    // dsh:rubric-attach event.
    if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent('dsh:rubric-created', { detail: { rubricId: parsed.id, rubric: parsed } }))
    }
  }

  function renderCatalog() {
    const host = document.getElementById('rubrics-catalog')
    if (!host) return
    seedFusionOnce()
    host.replaceChildren()
    const hint = renderSimilarSessionsHint()
    if (hint) host.appendChild(hint)
    for (const group of state.catalog) host.appendChild(renderGroupSection(group))
    host.appendChild(renderFallbackCTA())
  }

  // "Detected N similar sessions this week" hint card. Reads similarClasses
  // from the fusion store (heuristic detection is a TODO — fixture drives
  // the shape today). Dismissable per-class.
  function renderSimilarSessionsHint() {
    if (!fusion) return null
    const classes = fusion.detectSimilarSessions()
    const cls = classes.find(c => !state.dismissedHints.has(c.id))
    if (!cls) return null
    return el('div', { className: 'rubric-hint-card', 'data-testid': 'rubric-hint-card', role: 'note' }, [
      el('span', { className: 'rubric-hint-icon', text: '·' }),
      el('div', { className: 'rubric-hint-body' }, [
        el('span', { className: 'rubric-hint-title', text: `Detected ${cls.count} similar sessions this week` }),
        el('span', { className: 'rubric-hint-sub', text: cls.promptSummary || 'These look like a repeated task class — a rubric would let you track it.' }),
      ]),
      el('button', {
        className: 'ghost small rubric-hint-cta',
        type: 'button',
        text: 'Enable a rubric',
        onclick: () => {
          openCreateForm('llm-judge')
          if (state.createForm) {
            state.createForm.dimName = 'task-class-' + cls.id.replace(/[^a-z0-9-]/gi, '-').toLowerCase()
            state.createForm.hintClassId = cls.id
            state.createForm.hintPromptSummary = cls.promptSummary || ''
            renderCatalog()
          }
        },
      }),
      el('button', {
        className: 'ghost small rubric-hint-dismiss',
        type: 'button',
        text: '×',
        title: 'Dismiss for this class',
        'aria-label': 'Dismiss',
        onclick: (e) => {
          e.stopPropagation()
          state.dismissedHints.add(cls.id)
          renderCatalog()
        },
      }),
    ])
  }

  function findRubric(id) {
    return state.rubrics.find(r => r.id === id) || null
  }

  function openDetail(id) {
    const rubric = findRubric(id)
    if (!rubric) return
    state.active = id
    state.editMode = false
    renderDetail()
    const drawer = document.getElementById('rubric-detail-drawer')
    if (drawer) {
      drawer.classList.add('open')
      drawer.setAttribute('aria-hidden', 'false')
    }
  }

  function closeDetail() {
    state.active = null
    state.editMode = false
    const drawer = document.getElementById('rubric-detail-drawer')
    if (drawer) {
      drawer.classList.remove('open')
      drawer.setAttribute('aria-hidden', 'true')
    }
  }

  function openBlank(executorKind) {
    // Stub — synthesize an unsaved draft the user can edit inline. Saving
    // needs the G1 library/put wire method; the demo shows the shape and
    // notes the seam.
    const draft = {
      id: '__draft__',
      name: 'new-rubric',
      group: 'code-gen',
      template: 'fixed',
      executor: executorKind || 'llm-judge',
      version: 'draft',
      description: 'Unsaved draft — this rubric will land in .dsh/rubrics/ once the G1 seam is wired.',
      checklist: [],
      raw: [
        '---',
        'name: new-rubric',
        'group: code-gen',
        'template: fixed',
        'executor: ' + (executorKind || 'llm-judge'),
        '---',
        '',
        '## Checklist',
        '- ',
      ].join('\n'),
    }
    // Insert-or-replace in state.rubrics so openDetail picks it up.
    const idx = state.rubrics.findIndex(r => r.id === '__draft__')
    if (idx >= 0) state.rubrics.splice(idx, 1)
    state.rubrics.push(draft)
    openDetail('__draft__')
  }

  function renderChecklistList(rubric) {
    const items = Array.isArray(rubric.checklist) ? rubric.checklist : []
    if (!items.length) return el('div', { className: 'muted small', text: 'No checklist items yet.' })
    return el('ol', { className: 'rubric-checklist' }, items.map(it =>
      el('li', { className: 'rubric-checklist-item', text: it })
    ))
  }

  function renderDetail() {
    const host = document.getElementById('rubric-detail-body')
    if (!host || !state.active) return
    const rubric = findRubric(state.active)
    if (!rubric) return
    host.replaceChildren()
    // Head strip: name + group + template + version
    host.appendChild(el('div', { className: 'rubric-detail-head' }, [
      el('div', { className: 'rubric-detail-name', text: rubric.name }),
      el('div', { className: 'rubric-detail-meta muted small' }, [
        el('span', { text: (model.getCategory(rubric.group) || {}).name || rubric.group }),
        el('span', { text: '·' }),
        templateBadge(rubric.template),
        el('span', { text: '·' }),
        el('span', { text: rubric.executor === 'code' ? 'Code executor' : 'LLM-as-judge' }),
        el('span', { text: '·' }),
        el('span', { className: 'rubric-detail-version', text: rubric.version || 'v1' }),
      ]),
    ]))
    if (rubric.description) {
      host.appendChild(el('p', { className: 'rubric-detail-desc muted small', text: rubric.description }))
    }
    // L1 checklist render (default view).
    host.appendChild(el('div', { className: 'rubric-detail-section-title small', text: 'Checklist' }))
    host.appendChild(renderChecklistList(rubric))
    // Action row: Attach to Bench, Edit, View raw.
    host.appendChild(el('div', { className: 'rubric-detail-actions' }, [
      el('button', {
        className: 'ghost small',
        type: 'button',
        text: 'Attach to Bench',
        title: 'Deep-links this rubric into the Bench experiment builder.',
        onclick: () => window.dispatchEvent(new CustomEvent('dsh:rubric-attach', { detail: { rubricId: rubric.id } })),
      }),
      el('button', {
        className: 'ghost small',
        type: 'button',
        text: state.editMode ? 'View' : 'Edit',
        onclick: () => { state.editMode = !state.editMode; renderRawPane(rubric) },
      }),
      el('button', {
        className: 'ghost small',
        type: 'button',
        text: 'Copy raw',
        onclick: async () => {
          if (navigator.clipboard) { try { await navigator.clipboard.writeText(rubric.raw || '') } catch (_) { /* ignore */ } }
        },
      }),
    ]))
    // L2 raw view / editor.
    host.appendChild(el('div', { className: 'rubric-detail-section-title small', text: 'Raw SKILL.md' }))
    host.appendChild(el('div', { id: 'rubric-raw-host' }))
    renderRawPane(rubric)
  }

  function renderRawPane(rubric) {
    const host = document.getElementById('rubric-raw-host')
    if (!host) return
    host.replaceChildren()
    if (state.editMode) {
      const ta = el('textarea', {
        className: 'rubric-raw-editor',
        rows: '18',
        spellcheck: 'false',
      })
      ta.value = rubric.raw || ''
      ta.addEventListener('input', () => { rubric.raw = ta.value })
      host.appendChild(ta)
      host.appendChild(el('div', { className: 'muted small' }, [
        el('span', { text: 'Editing in place. ' }),
        el('span', { text: 'Save requires the library/put wire method (G1); this demo persists edits in-memory only.' }),
      ]))
    } else {
      host.appendChild(el('pre', { className: 'rubric-raw-view', text: rubric.raw || '' }))
    }
  }

  async function refresh() {
    const raws = await loadFixtures()
    const parsed = raws.map(txt => model.parseRubricFile(txt)).filter(Boolean)
    state.rubrics = parsed
    state.catalog = model.buildCatalog(parsed)
    renderCatalog()
  }

  function show() {
    if (!state.rubrics.length) {
      void refresh()
    } else {
      renderCatalog()
    }
  }

  function mount() {
    // Wire the drawer close button + backdrop click.
    const closeBtn = document.getElementById('rubric-detail-close')
    if (closeBtn) closeBtn.addEventListener('click', closeDetail)
    const backdrop = document.getElementById('rubric-detail-backdrop')
    if (backdrop) backdrop.addEventListener('click', closeDetail)
    // Refresh button.
    const refreshBtn = document.getElementById('rubrics-refresh-btn')
    if (refreshBtn) refreshBtn.addEventListener('click', () => void refresh())
    // Total subtask badge in the header.
    const badge = document.getElementById('rubrics-subtask-badge')
    if (badge && model && model.totalSubtaskCount) {
      badge.textContent = model.totalSubtaskCount() + ' subtasks · 7 groups'
    }
  }

  // Shared Evals-pane rubric selector (lane-evals-merge, 2026-07-19).
  // When the researcher picks a rubric from the top selector, open that
  // rubric's detail drawer so the catalog view reflects the shared pick.
  // "All rubrics" (empty value) closes any open drawer to reset scope.
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('dsh:evals-rubric-change', (ev) => {
      const rid = ev && ev.detail && ev.detail.rubricId
      if (!rid) {
        try { closeDetail() } catch (_) {}
        return
      }
      // Only act when the Rubrics tab is the active Evals tab, otherwise
      // opening the drawer would flash behind another tab's body.
      const evalsPane = document.querySelector('.pane[data-pane="evals"]')
      if (evalsPane && evalsPane.dataset.evalsActive !== 'rubrics') return
      try { openDetail(rid) } catch (_) {}
    })
  }

  if (typeof window !== 'undefined') {
    window.__dshRubrics = { mount, show, refresh, renderCatalog, openDetail, closeDetail, openCreateForm, closeCreateForm, _state: state }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', mount, { once: true })
    } else {
      mount()
    }
  }

  // Test hook — expose the internals a jsdom-less test can drive. Kept
  // minimal and side-effect-free.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { _internal: { state, findRubric, openBlank, openCreateForm, closeCreateForm, saveCreateForm, draftAsMarkdown, buildDraftDimensionLine, slug } }
  }
})()
