// Annotation panel — RL trajectory + per-turn scoring UI (#191).
//
// Two entry points into the same underlying store:
//   (a) A "Rate trajectory" button on Chat header + a Rate icon on each
//       Recent list row → opens a compact scoring drawer (right side, non-
//       modal so the chat keeps reading).
//   (b) Full "Annotate" mode inside the Rubrics page's Sessions tab (a
//       dedicated in-line view listing all trajectories with their score
//       state; clicking one opens the same drawer).
//
// The drawer has three sections stacked top-to-bottom:
//   1. Trajectory header — session title, task-tag picker (7 groups → 28
//      subtasks), and the required overall verdict (bad/ok/good).
//   2. Per-turn cards — one per assistant turn; the 5 fixed dims each
//      rendered as a 1–5 button row; the PREVIOUS user feedback is pinned
//      to the left of each card as a quoted preview.
//   3. Keymap hint footer + completeness chip.
//
// Store shape: sessionId → sessionAnnotation (as defined by annotation-
// model.js). Persisted in localStorage for demo purposes; the G16
// annotation/put wire method would replace this seam.

/* global window, document, KeyboardEvent */

;(function () {
  'use strict'

  const model = (typeof window !== 'undefined' && window.__dshAnnotationModel)
    ? window.__dshAnnotationModel
    : (typeof require === 'function' ? require('./annotation-model.js') : {})
  const rubricsModel = (typeof window !== 'undefined' && window.__dshRubricsModel)
    ? window.__dshRubricsModel
    : (typeof require === 'function' ? require('./rubrics-model.js') : {})

  const STORAGE_KEY = 'dsh.annotations.v1'
  // Which rubric drives the scoring controls in the drawer. Default = the
  // 5-fixed multi-turn rubric so legacy behavior (1-5 button rows) stays
  // the out-of-box experience. Callers can switch via
  // `window.__dshAnnotation.setActiveRubric(rubric)` — the Rubrics page
  // Create form uses this after saving to open the drawer on the new
  // rubric.
  const DEFAULT_RUBRIC = {
    id: '__multi-turn__',
    name: 'multi-turn (5 fixed dims)',
    template: 'multi-turn',
    // dimensions omitted → dimensionsForRubric falls back to the 5 fixed
    // MULTI_TURN_DIMENSIONS. Kept explicit so a future refactor that drops
    // the fallback doesn't silently blank the drawer.
  }

  const state = {
    byId: new Map(),          // sessionId → sessionAnnotation
    activeSessionId: null,
    activeRubric: DEFAULT_RUBRIC,
    // The events for the active session, resolved just-in-time. For the demo
    // we accept a caller-provided events array OR read from the fixture.
    activeEvents: [],
    // Focus tracker for keyboard scoring: {turnIndex, dimIndex}.
    focus: { turnIndex: 0, dimIndex: 0 },
    // The full sample-sessions fixture (loaded lazily).
    fixtureSessions: null,
  }

  // Resolve the dim-spec list the drawer is currently scoring against.
  // Never returns [] — falls back to the 5 fixed dims so the drawer is
  // always usable, even when the caller hasn't picked a rubric yet.
  function activeDims() {
    const dims = rubricsModel.dimensionsForRubric
      ? rubricsModel.dimensionsForRubric(state.activeRubric)
      : rubricsModel.MULTI_TURN_DIMENSIONS
    return dims && dims.length ? dims : rubricsModel.MULTI_TURN_DIMENSIONS
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

  function persist() {
    try {
      const obj = {}
      for (const [id, ann] of state.byId) obj[id] = ann
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(obj))
    } catch (_) { /* localStorage may be disabled — degrade silently */ }
  }

  function hydrate() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const obj = JSON.parse(raw)
      for (const [id, ann] of Object.entries(obj || {})) state.byId.set(id, ann)
    } catch (_) { /* no-op */ }
  }

  function get(sessionId) {
    return state.byId.get(sessionId) || model.blankAnnotation(sessionId)
  }

  function write(ann) {
    // Demo-tier annotator stamp — G16 wire will replace 'local-user' with
    // the authenticated identity at the seam. The field is optional on the
    // shape; we default it here so exports and #205's Feedback tab always
    // have a value to show.
    const stamped = ann && !ann.annotator ? { ...ann, annotator: 'local-user' } : ann
    state.byId.set(stamped.sessionId, stamped)
    persist()
    // Push notify consumers (#205 Feedback tab is the first). We fire on
    // document so triview can subscribe once at module load without needing
    // to know the panel's lifecycle.
    if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
      document.dispatchEvent(new CustomEvent('dsh:annotation-updated', {
        detail: { sessionId: stamped.sessionId, ann: stamped },
      }))
    }
  }

  // Stable read interface for external consumers (#205 Feedback tab et al).
  // Never expose `state` — callers get a deep-enough snapshot to render but
  // cannot accidentally mutate the store. Returns `null` when no record
  // exists (as opposed to `get`, which returns a blank template).
  function read(sessionId) {
    const stored = state.byId.get(String(sessionId || ''))
    if (!stored) return null
    return JSON.parse(JSON.stringify(stored))
  }

  function readAll() {
    const out = new Map()
    for (const [id, ann] of state.byId) out.set(id, JSON.parse(JSON.stringify(ann)))
    return out
  }

  async function loadFixtureSessions() {
    if (state.fixtureSessions) return state.fixtureSessions
    if (window.dsh && window.dsh.annotationSamples && typeof window.dsh.annotationSamples.get === 'function') {
      try {
        const s = await window.dsh.annotationSamples.get()
        if (s && Array.isArray(s.sessions)) { state.fixtureSessions = s; return s }
      } catch (_) { /* fall through */ }
    }
    if (window.__dshAnnotationSamples) {
      state.fixtureSessions = window.__dshAnnotationSamples
      return state.fixtureSessions
    }
    // Empty fixture — the panel will render an empty-state row.
    state.fixtureSessions = { sessions: [], seedAnnotations: {} }
    return state.fixtureSessions
  }

  function resolveEventsFor(sessionId) {
    // 1) The chat state may hold the live events (renderer.js keeps
    //    state.entries.get(sessionId).events). If the app hook is present,
    //    prefer it — that's the "real session" path.
    if (window.__dshChatState && typeof window.__dshChatState.getEvents === 'function') {
      const ev = window.__dshChatState.getEvents(sessionId)
      if (Array.isArray(ev) && ev.length) return ev
    }
    // 2) Fixture fallback.
    const fx = state.fixtureSessions
    if (fx && Array.isArray(fx.sessions)) {
      const s = fx.sessions.find(x => x.sessionId === sessionId)
      if (s) return s.events || []
    }
    return []
  }

  // ---- Drawer scaffolding -------------------------------------------------

  function ensureDrawer() {
    let root = document.getElementById('annotation-drawer')
    if (root) return root
    root = el('aside', {
      id: 'annotation-drawer',
      className: 'annotation-drawer',
      'aria-hidden': 'true',
      'aria-label': 'Rate trajectory',
    })
    root.appendChild(el('div', { className: 'annotation-drawer-head' }, [
      el('div', { className: 'annotation-drawer-title', text: 'Rate trajectory' }),
      el('button', {
        type: 'button', id: 'annotation-drawer-close', className: 'ghost small',
        'aria-label': 'Close (Esc)', title: 'Close (Esc)', text: '×',
      }),
    ]))
    root.appendChild(el('div', { className: 'annotation-drawer-body', id: 'annotation-drawer-body' }))
    root.appendChild(el('footer', { className: 'annotation-drawer-foot' }, [
      el('div', { className: 'annotation-keymap muted small' }, [
        el('span', { text: 'Keys: ' }),
        el('kbd', { text: '1' }), el('span', { text: '–' }), el('kbd', { text: '5' }),
        el('span', { text: ' score focused dim · ' }),
        el('kbd', { text: '↑' }), el('kbd', { text: '↓' }),
        el('span', { text: ' change dim · ' }),
        el('kbd', { text: '←' }), el('kbd', { text: '→' }),
        el('span', { text: ' change turn · ' }),
        el('kbd', { text: 'B' }), el('kbd', { text: 'O' }), el('kbd', { text: 'G' }),
        el('span', { text: ' overall bad/ok/good · ' }),
        el('kbd', { text: 'Esc' }), el('span', { text: ' close' }),
      ]),
      el('div', { className: 'annotation-completeness', id: 'annotation-completeness-chip' }),
    ]))
    document.body.appendChild(root)
    // Wire the close button + Esc key.
    root.querySelector('#annotation-drawer-close').addEventListener('click', close)
    document.addEventListener('keydown', onKey)
    return root
  }

  function onKey(e) {
    const drawer = document.getElementById('annotation-drawer')
    if (!drawer || drawer.getAttribute('aria-hidden') !== 'false') return
    if (e.key === 'Escape') { close(); return }
    // Ignore keys when the focus is in a text input (task-tag picker uses
    // native <select>, which we want to leave to the browser).
    const active = document.activeElement
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return
    const sessionId = state.activeSessionId
    if (!sessionId) return
    const ann = get(sessionId)
    const turns = model.enumerateAssistantTurns(state.activeEvents)
    const dims = activeDims()
    const d = dims[state.focus.dimIndex]
    const t = turns[state.focus.turnIndex]
    // Typed keyboard scoring — the number keys 1..9 hit position N of the
    // dim's option set, whatever the primitive.  Continuous with integer
    // steps: N == numeric value (matches the legacy 1-5 grammar).
    // Categorical: N == enum index (1-based).  Boolean: 1 = true, 2 = false.
    if (t && d && /^[1-9]$/.test(e.key)) {
      const n = Number(e.key)
      const patch = valueForKey(d, n)
      if (patch !== undefined) {
        write(model.setTurnScore(ann, t.turnIndex, {
          dims: { [d.id]: patch },
          priorFeedback: t.priorFeedback,
        }, Date.now(), { dims }))
        renderBody()
      }
      e.preventDefault()
      return
    }
    if (e.key === 'ArrowDown') { state.focus.dimIndex = Math.min(dims.length - 1, state.focus.dimIndex + 1); renderBody(); e.preventDefault(); return }
    if (e.key === 'ArrowUp') { state.focus.dimIndex = Math.max(0, state.focus.dimIndex - 1); renderBody(); e.preventDefault(); return }
    if (e.key === 'ArrowRight') { state.focus.turnIndex = Math.min(turns.length - 1, state.focus.turnIndex + 1); state.focus.dimIndex = 0; renderBody(); e.preventDefault(); return }
    if (e.key === 'ArrowLeft') { state.focus.turnIndex = Math.max(0, state.focus.turnIndex - 1); state.focus.dimIndex = 0; renderBody(); e.preventDefault(); return }
    const overallByKey = { b: 'bad', o: 'ok', g: 'good', B: 'bad', O: 'ok', G: 'good' }
    if (overallByKey[e.key]) {
      write(model.setOverall(ann, overallByKey[e.key]))
      renderBody()
      e.preventDefault()
    }
  }

  // Map a 1-based number-key press to a value for a typed dim. Returns
  // `undefined` when the key is out of range for that primitive so the
  // caller can preserve the previous score untouched.
  function valueForKey(dim, n) {
    const spec = rubricsModel.normalizeDimSpec
      ? rubricsModel.normalizeDimSpec(dim) : dim
    if (!spec) return undefined
    if (spec.type === 'boolean') {
      if (n === 1) return true
      if (n === 2) return false
      return undefined
    }
    if (spec.type === 'categorical') {
      const v = spec.values[n - 1]
      return v == null ? undefined : v
    }
    // continuous — the digit maps directly to the numeric value when it
    // lies inside [min, max].  Otherwise treat as out-of-range.
    if (n < spec.min || n > spec.max) return undefined
    return n
  }

  function open(sessionId, opts) {
    hydrate()
    void loadFixtureSessions().then(() => {
      state.activeSessionId = sessionId
      state.activeEvents = (opts && Array.isArray(opts.events)) ? opts.events : resolveEventsFor(sessionId)
      // Seed the store from fixture seedAnnotations if we don't have any yet.
      if (!state.byId.has(sessionId) && state.fixtureSessions && state.fixtureSessions.seedAnnotations && state.fixtureSessions.seedAnnotations[sessionId]) {
        const seed = { sessionId, updatedAt: 0, ...state.fixtureSessions.seedAnnotations[sessionId] }
        state.byId.set(sessionId, seed)
        persist()
      }
      state.focus = { turnIndex: 0, dimIndex: 0 }
      const root = ensureDrawer()
      root.classList.add('open')
      root.setAttribute('aria-hidden', 'false')
      renderBody()
    })
  }

  function close() {
    const root = document.getElementById('annotation-drawer')
    if (!root) return
    root.classList.remove('open')
    root.setAttribute('aria-hidden', 'true')
    state.activeSessionId = null
    state.activeEvents = []
    // Repaint any completeness chips on Recent rows.
    paintCompletenessChips()
  }

  function verdictButton(currentVerdict, verdict, ann) {
    const active = currentVerdict === verdict
    return el('button', {
      type: 'button',
      className: 'annotation-verdict-btn' + (active ? ' active' : ''),
      'data-verdict': verdict,
      text: verdict,
      onclick: () => { write(model.setOverall(ann, verdict)); renderBody() },
    })
  }

  function renderTaskTagPicker(ann) {
    const cats = rubricsModel.TASK_CATEGORIES
    const groupSel = el('select', { className: 'annotation-task-group' })
    groupSel.appendChild(el('option', { value: '', text: '— pick a group —' }))
    for (const cat of cats) {
      const opt = el('option', { value: cat.id, text: cat.name })
      if (ann.taskGroup === cat.id) opt.selected = true
      groupSel.appendChild(opt)
    }
    const subSel = el('select', { className: 'annotation-task-subtask' })
    const populateSub = () => {
      subSel.replaceChildren(el('option', { value: '', text: '— pick a subtask —' }))
      const cat = rubricsModel.getCategory(groupSel.value)
      if (!cat) return
      for (const sub of cat.subtasks) {
        const opt = el('option', { value: sub, text: sub })
        if (ann.taskSubtask === sub) opt.selected = true
        subSel.appendChild(opt)
      }
    }
    populateSub()
    groupSel.addEventListener('change', () => {
      populateSub()
      write(model.setTaskTag(get(state.activeSessionId), groupSel.value || null, null))
      renderBody()
    })
    subSel.addEventListener('change', () => {
      write(model.setTaskTag(get(state.activeSessionId), groupSel.value || null, subSel.value || null))
    })
    return el('div', { className: 'annotation-tag-picker' }, [
      el('span', { className: 'annotation-tag-label muted small', text: 'Task tag' }),
      groupSel,
      subSel,
    ])
  }

  function renderScoreRow(turn, ann, turnIdx) {
    const dims = activeDims()
    const stored = (ann.turnScores || []).find(t => t.turnIndex === turn.turnIndex) || { dims: {} }
    const focused = state.focus.turnIndex === turnIdx
    return dims.map((d, dimIdx) => {
      const focusedRow = focused && state.focus.dimIndex === dimIdx
      const spec = rubricsModel.normalizeDimSpec
        ? rubricsModel.normalizeDimSpec(d) : d
      const label = el('div', {
        className: 'annotation-dim-label',
        text: spec.label || spec.id,
      })
      // Type badge — shows next to the label so a reader can tell which
      // primitive they're scoring against (Continuous/Categorical/Boolean).
      const badge = el('span', {
        className: 'annotation-dim-type-badge chip tiny',
        'data-dim-type': spec.type,
        text: spec.type,
      })
      label.appendChild(badge)
      const scores = renderScoreControls(spec, stored, turn, ann, turnIdx, dimIdx, dims)
      const row = el('div', {
        className: 'annotation-dim-row' + (focusedRow ? ' focused' : ''),
        'data-dim-id': spec.id,
        'data-dim-type': spec.type,
        title: spec.hint || '',
      }, [label, scores])
      return row
    })
  }

  // Render the actual scoring control for one dim.  Each primitive gets its
  // own DOM shape; every click routes through the same setTurnScore call
  // so the store shape stays uniform.
  function renderScoreControls(spec, stored, turn, ann, turnIdx, dimIdx, dims) {
    const cur = stored.dims[spec.id]
    if (spec.type === 'categorical') {
      return el('div', { className: 'annotation-dim-scores annotation-dim-categorical' },
        spec.values.map(v => el('button', {
          type: 'button',
          className: 'annotation-dim-score annotation-dim-score-cat' + (cur === v ? ' active' : ''),
          'data-value': v,
          text: v,
          onclick: () => {
            state.focus = { turnIndex: turnIdx, dimIndex: dimIdx }
            const next = model.setTurnScore(ann, turn.turnIndex,
              { dims: { [spec.id]: v }, priorFeedback: turn.priorFeedback },
              Date.now(), { dims })
            write(next)
            renderBody()
          },
        }))
      )
    }
    if (spec.type === 'boolean') {
      const labels = spec.labels || { true: 'true', false: 'false' }
      const pairs = [
        { key: 'true', value: true, label: labels.true },
        { key: 'false', value: false, label: labels.false },
      ]
      return el('div', { className: 'annotation-dim-scores annotation-dim-boolean' },
        pairs.map(p => el('button', {
          type: 'button',
          className: 'annotation-dim-score annotation-dim-score-bool' + (cur === p.value ? ' active' : ''),
          'data-value': p.key,
          text: p.label,
          onclick: () => {
            state.focus = { turnIndex: turnIdx, dimIndex: dimIdx }
            const next = model.setTurnScore(ann, turn.turnIndex,
              { dims: { [spec.id]: p.value }, priorFeedback: turn.priorFeedback },
              Date.now(), { dims })
            write(next)
            renderBody()
          },
        }))
      )
    }
    // continuous — small integer ranges (≤ 10 buttons) render as a button
    // row that reads the same as the legacy 1-5 grammar; larger ranges
    // fall back to a numeric input.
    const span = spec.max - spec.min
    const isIntegerButtons = Number.isInteger(spec.min) && Number.isInteger(spec.max) && span <= 9
    if (isIntegerButtons) {
      const values = []
      for (let v = spec.min; v <= spec.max; v++) values.push(v)
      return el('div', { className: 'annotation-dim-scores annotation-dim-continuous' },
        values.map(v => el('button', {
          type: 'button',
          className: 'annotation-dim-score' + (cur === v ? ' active' : ''),
          'data-value': v,
          text: String(v),
          onclick: () => {
            state.focus = { turnIndex: turnIdx, dimIndex: dimIdx }
            const next = model.setTurnScore(ann, turn.turnIndex,
              { dims: { [spec.id]: v }, priorFeedback: turn.priorFeedback },
              Date.now(), { dims })
            write(next)
            renderBody()
          },
        }))
      )
    }
    // Numeric input — the reader types a value inside [min, max].
    const inp = el('input', {
      type: 'number',
      className: 'annotation-dim-input',
      min: String(spec.min),
      max: String(spec.max),
      step: 'any',
      value: cur == null ? '' : String(cur),
      placeholder: `${spec.min}–${spec.max}`,
    })
    inp.addEventListener('change', () => {
      state.focus = { turnIndex: turnIdx, dimIndex: dimIdx }
      const raw = inp.value.trim()
      const patch = raw === '' ? null : Number(raw)
      const next = model.setTurnScore(ann, turn.turnIndex,
        { dims: { [spec.id]: patch }, priorFeedback: turn.priorFeedback },
        Date.now(), { dims })
      write(next)
      renderBody()
    })
    return el('div', { className: 'annotation-dim-scores annotation-dim-continuous annotation-dim-numeric' }, [
      inp,
      el('span', { className: 'annotation-dim-range muted tiny', text: `[${spec.min}, ${spec.max}]` }),
    ])
  }

  function renderTurnCard(turn, ann, idx) {
    const focused = state.focus.turnIndex === idx
    return el('article', {
      className: 'annotation-turn-card' + (focused ? ' focused' : ''),
      'data-turn-index': turn.turnIndex,
    }, [
      el('div', { className: 'annotation-turn-head' }, [
        el('span', { className: 'annotation-turn-idx muted small', text: 'Turn ' + (turn.turnIndex + 1) }),
        el('span', { className: 'annotation-turn-snippet small', text: turn.snippet }),
      ]),
      el('div', { className: 'annotation-turn-body' }, [
        el('aside', { className: 'annotation-prior-feedback' }, [
          el('div', { className: 'annotation-prior-label muted small', text: 'Prior feedback (pinned)' }),
          el('blockquote', { className: 'annotation-prior-text', text: turn.priorFeedback || '(none — first turn)' }),
        ]),
        el('div', { className: 'annotation-dims' }, renderScoreRow(turn, ann, idx)),
      ]),
    ])
  }

  function renderCompletenessChip(ann, totalTurns) {
    const chip = document.getElementById('annotation-completeness-chip')
    if (!chip) return
    const c = model.completeness(ann, totalTurns, { dims: activeDims() })
    chip.replaceChildren()
    const cls = c.complete ? 'chip small ok' : 'chip small'
    chip.appendChild(el('span', {
      className: cls,
      text: c.hasOverall
        ? `annotated ${c.annotatedTurns}/${c.totalTurns} turns`
        : `overall verdict required · ${c.annotatedTurns}/${c.totalTurns} turns`,
    }))
  }

  function renderBody() {
    const host = document.getElementById('annotation-drawer-body')
    if (!host) return
    host.replaceChildren()
    const sessionId = state.activeSessionId
    if (!sessionId) return
    const ann = get(sessionId)
    // Header block.
    host.appendChild(el('div', { className: 'annotation-head-block' }, [
      el('div', { className: 'annotation-session-id muted small', text: 'Session: ' + sessionId }),
      renderRubricPicker(),
      renderTaskTagPicker(ann),
      el('div', { className: 'annotation-overall' }, [
        el('span', { className: 'annotation-overall-label small', text: 'Overall verdict (required)' }),
        el('div', { className: 'annotation-verdict-row' }, [
          verdictButton(ann.overall, 'bad', ann),
          verdictButton(ann.overall, 'ok', ann),
          verdictButton(ann.overall, 'good', ann),
        ]),
      ]),
    ]))
    // Per-turn cards.
    const turns = model.enumerateAssistantTurns(state.activeEvents)
    const turnsHost = el('div', { className: 'annotation-turns' })
    if (!turns.length) {
      turnsHost.appendChild(el('div', { className: 'annotation-empty muted small',
        text: 'This session has no assistant turns yet. Chat with the agent first.' }))
    } else {
      for (let i = 0; i < turns.length; i++) turnsHost.appendChild(renderTurnCard(turns[i], ann, i))
    }
    host.appendChild(turnsHost)
    renderCompletenessChip(ann, turns.length)
  }

  // A dropdown that lets the reader switch which rubric drives the scoring
  // controls in the drawer.  Rubrics are pulled from the same catalog the
  // Rubrics page uses (window.__dshRubrics._state.rubrics), which is
  // populated after `rubrics-page.js` loads its fixtures.  The default
  // multi-turn rubric is always the first entry so the drawer opens
  // sensibly even before the Rubrics tab has been visited.
  function renderRubricPicker() {
    const wrap = el('div', { className: 'annotation-rubric-picker' })
    wrap.appendChild(el('span', {
      className: 'annotation-rubric-label muted small',
      text: 'Rubric',
    }))
    const sel = el('select', { className: 'annotation-rubric-select' })
    const opts = [DEFAULT_RUBRIC]
    const rp = (typeof window !== 'undefined') ? window.__dshRubrics : null
    if (rp && rp._state && Array.isArray(rp._state.rubrics)) {
      for (const r of rp._state.rubrics) {
        // Only include rubrics with real dims (multi-turn or explicit).
        const dims = rubricsModel.dimensionsForRubric
          ? rubricsModel.dimensionsForRubric(r) : []
        if (dims.length) opts.push(r)
      }
    }
    for (const r of opts) {
      const opt = el('option', { value: r.id, text: r.name || r.id })
      if (state.activeRubric && state.activeRubric.id === r.id) opt.selected = true
      sel.appendChild(opt)
    }
    sel.addEventListener('change', () => {
      const chosen = opts.find(r => r.id === sel.value)
      if (chosen) {
        state.activeRubric = chosen
        state.focus = { turnIndex: 0, dimIndex: 0 }
        renderBody()
      }
    })
    wrap.appendChild(sel)
    // A running badge that captions the picker with the primitive mix
    // (e.g. "3 continuous · 1 categorical · 1 boolean") so the reader can
    // tell what the current rubric is asking of them before scrolling
    // through the turn cards.
    const dims = activeDims()
    const mix = { continuous: 0, categorical: 0, boolean: 0 }
    for (const d of dims) {
      const spec = rubricsModel.normalizeDimSpec ? rubricsModel.normalizeDimSpec(d) : d
      if (spec && mix[spec.type] != null) mix[spec.type]++
    }
    const parts = []
    for (const k of Object.keys(mix)) if (mix[k] > 0) parts.push(`${mix[k]} ${k}`)
    wrap.appendChild(el('span', {
      className: 'annotation-rubric-mix muted tiny',
      text: parts.length ? parts.join(' · ') : `${dims.length} dims`,
    }))
    return wrap
  }

  // ---- Completeness chips on Recent list rows ----------------------------

  // Paint an "annotated N/M" chip on every Recent list row that has an
  // annotation started. Non-destructive — clears and reapplies.
  function paintCompletenessChips() {
    const rows = document.querySelectorAll('#sessions [data-session-id]')
    const dims = activeDims()
    const dimIds = dims.map(d => d.id)
    for (const r of rows) {
      const id = r.getAttribute('data-session-id')
      let chip = r.querySelector('.annotation-row-chip')
      const ann = state.byId.get(id)
      if (!ann) { if (chip) chip.remove(); continue }
      const totalTurns = (ann.turnScores || []).length
      const totalAnnTurns = (ann.turnScores || []).filter(t => {
        if (!t || !t.dims) return false
        for (const dimId of dimIds) if (!(dimId in t.dims)) return false
        return true
      }).length
      if (!chip) {
        chip = el('span', { className: 'annotation-row-chip chip tiny' })
        r.appendChild(chip)
      }
      chip.textContent = `rated ${totalAnnTurns}/${totalTurns}`
    }
  }

  // ---- Export drawer ------------------------------------------------------

  function ensureExportDrawer() {
    let root = document.getElementById('export-drawer')
    if (root) return root
    root = el('aside', {
      id: 'export-drawer', className: 'export-drawer',
      'aria-hidden': 'true', 'aria-label': 'Export annotations',
    })
    root.appendChild(el('div', { className: 'export-drawer-head' }, [
      el('div', { className: 'export-drawer-title', text: 'Export annotations' }),
      el('button', { type: 'button', id: 'export-drawer-close', className: 'ghost small', text: '×' }),
    ]))
    root.appendChild(el('div', { className: 'export-drawer-body', id: 'export-drawer-body' }))
    document.body.appendChild(root)
    root.querySelector('#export-drawer-close').addEventListener('click', closeExport)
    return root
  }

  function closeExport() {
    const root = document.getElementById('export-drawer')
    if (!root) return
    root.classList.remove('open')
    root.setAttribute('aria-hidden', 'true')
  }

  function openExport() {
    hydrate()
    void loadFixtureSessions().then(() => {
      const root = ensureExportDrawer()
      root.classList.add('open')
      root.setAttribute('aria-hidden', 'false')
      renderExportBody({ format: 'jsonl-html', selected: null })
    })
  }

  function renderExportBody(uiState) {
    const host = document.getElementById('export-drawer-body')
    if (!host) return
    host.replaceChildren()
    const sessions = (state.fixtureSessions && state.fixtureSessions.sessions) || []
    // Format toggle.
    const fmtRow = el('div', { className: 'export-format-row' }, [
      el('span', { className: 'small', text: 'Format:' }),
      el('label', { className: 'chip small' }, [
        el('input', { type: 'radio', name: 'export-format', value: 'jsonl-html', checked: uiState.format === 'jsonl-html' ? true : false,
          onchange: () => renderExportBody({ ...uiState, format: 'jsonl-html' }) }),
        el('span', { text: ' jsonl-to-html (messages + annotation-fields)' }),
      ]),
      el('label', { className: 'chip small' }, [
        el('input', { type: 'radio', name: 'export-format', value: 'triples', checked: uiState.format === 'triples' ? true : false,
          onchange: () => renderExportBody({ ...uiState, format: 'triples' }) }),
        el('span', { text: ' (state, action, reward) triples' }),
      ]),
    ])
    host.appendChild(fmtRow)
    // Session picker.
    const selected = new Set(uiState.selected == null
      ? sessions.filter(s => state.byId.has(s.sessionId)).map(s => s.sessionId)
      : uiState.selected)
    const list = el('div', { className: 'export-session-list' })
    for (const s of sessions) {
      const has = state.byId.has(s.sessionId)
      const cb = el('input', { type: 'checkbox', checked: selected.has(s.sessionId) ? true : false })
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(s.sessionId)
        else selected.delete(s.sessionId)
        renderExportBody({ ...uiState, selected: Array.from(selected) })
      })
      list.appendChild(el('label', { className: 'export-session-row' + (has ? ' annotated' : '') }, [
        cb,
        el('span', { className: 'small', text: s.title }),
        el('span', { className: 'muted tiny', text: has ? '(annotated)' : '(not yet rated)' }),
      ]))
    }
    host.appendChild(list)
    // Preview & stats.
    const rows = []
    const dims = activeDims()
    for (const id of selected) {
      const s = sessions.find(x => x.sessionId === id)
      if (!s) continue
      const ann = get(id)
      if (uiState.format === 'jsonl-html') {
        // Annotator: omit — projectJsonlRow picks up the annotator from the
        // stored record (defaulted to 'local-user' at write time).
        const row = model.projectJsonlRow(s.events, ann, { now: 0, dims })
        if (row) rows.push(row)
      } else {
        for (const t of model.projectTripleRows(s.events, ann, id, { dims })) rows.push(t)
      }
    }
    const serial = model.serializeJsonl(rows)
    const bytes = serial.length
    const previewText = serial.split('\n').slice(0, 2).join('\n')
    host.appendChild(el('div', { className: 'export-stats muted small', text:
      `${rows.length} rows · ~${(bytes / 1024).toFixed(1)} KB · ${uiState.format}` }))
    host.appendChild(el('pre', { className: 'export-preview', text: previewText || '(no rows selected)' }))
    // Save button — writes via preload IPC if available; otherwise triggers
    // an in-browser download via a data: URL.
    const saveBtn = el('button', { type: 'button', className: 'primary small', text: 'Save JSONL', onclick: () => saveExport(serial, uiState.format) })
    host.appendChild(el('div', { className: 'export-actions' }, [
      saveBtn,
      el('span', { className: 'muted small', text: 'Demo tier: client-side assembly. G13 export-batch + G16 annotation/put pending upstream.' }),
    ]))
  }

  function saveExport(serial, format) {
    if (window.dsh && window.dsh.annotationExport && typeof window.dsh.annotationExport.save === 'function') {
      void window.dsh.annotationExport.save({ format, body: serial })
      return
    }
    // Download fallback (renderer only, no main-process seam).
    try {
      const blob = new Blob([serial], { type: 'application/x-jsonlines' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'dsh-annotations.jsonl'
      document.body.appendChild(a)
      a.click()
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url) }, 100)
    } catch (_) { /* environment may block Blob; the preview still shows */ }
  }

  // Public API ------------------------------------------------------------

  const api = {
    open, close, openExport, closeExport, paintCompletenessChips,
    // Stable read interface for external consumers (e.g. #205 Feedback tab
    // in lane-trace-triview). See annotation-model.js shape-lock comment for
    // record shape. Push updates arrive via `dsh:annotation-updated`
    // CustomEvent on document with detail `{sessionId, ann}`.
    read, readAll,
    // Switch which rubric drives the drawer's scoring controls.  The
    // Rubrics page Create-from-scratch form calls this after saving a
    // new rubric so the drawer opens on the fresh spec.  Also lets
    // triview / trace-detail-pane display the correct dim types when
    // rendering feedback rows.
    setActiveRubric(rubric) {
      if (!rubric || typeof rubric !== 'object') return
      state.activeRubric = rubric
      state.focus = { turnIndex: 0, dimIndex: 0 }
      // Only rerender when the drawer is open; otherwise the next open
      // call will pick up the change.
      const drawer = typeof document !== 'undefined' && document.getElementById('annotation-drawer')
      if (drawer && drawer.getAttribute('aria-hidden') === 'false') renderBody()
    },
    getActiveRubric() { return state.activeRubric },
    getActiveDims() { return activeDims() },
    // Write seam for the LangSmith-style inline popover on the Feedback tab
    // (2026-07-17 team-lead: Add-feedback should submit inline, full drawer
    // is the escape hatch). Patch shape:
    //   { overall?: 'bad'|'ok'|'good'|null, dims?: {[dimId]:1-5},
    //     note?: string, turnIndex?: number }
    // When turnIndex is a non-negative integer, `dims`/`note` land on that
    // turn's per-turn scores; otherwise `dims`/`note` are ignored (the
    // trajectory-level record has no dim map, only the overall verdict).
    // Returns the persisted record.
    submit(sessionId, patch) {
      if (!sessionId) return null
      const before = get(sessionId)
      let next = before
      if (patch && 'overall' in patch) {
        next = model.setOverall(next, patch.overall)
      }
      if (patch && Number.isInteger(patch.turnIndex) && patch.turnIndex >= 0) {
        const turnPatch = {}
        if (patch.dims && typeof patch.dims === 'object') turnPatch.dims = patch.dims
        if (typeof patch.note === 'string') turnPatch.note = patch.note
        if (Object.keys(turnPatch).length) {
          next = model.setTurnScore(next, patch.turnIndex, turnPatch)
        }
      }
      // Trajectory-level free-text note (no turnIndex). Not part of the
      // 5-dim rubric — it lives on `ann.notes`, mirroring the drawer.
      if (patch && !Number.isInteger(patch.turnIndex) && typeof patch.note === 'string') {
        next = { ...next, notes: patch.note, updatedAt: Date.now() }
      }
      if (next === before) return before
      write(next)
      return next
    },
    _state: state,
  }

  if (typeof window !== 'undefined') {
    window.__dshAnnotation = api
    hydrate()
    // Paint chips whenever the Recent list is repainted; renderer.js emits
    // a `dsh:sessions-rendered` event we can hook on. Belt-and-braces:
    // also observe #sessions changes.
    document.addEventListener('DOMContentLoaded', () => {
      window.addEventListener('dsh:sessions-rendered', paintCompletenessChips)
    }, { once: true })
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { _internal: { state, get, write, read, readAll, renderExportBody, paintCompletenessChips, activeDims, valueForKey, DEFAULT_RUBRIC } }
  }
})()
