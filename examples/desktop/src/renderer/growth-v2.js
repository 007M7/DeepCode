// Growth v2 — the recompacted "harness evolution log" for researchers.
//
//. Data source is the growth-v2 IPC → compact-window history +
// per-window rubrics/errors that tell a "prompt was rough → added rubric →
// +42% pass" evolution story.
//
// Modes:
//   - novice (default): each compact window is a single row with a summary
//     + a compression ratio + the R × N / E × M sticky-note badge. Nothing
//     unfolds. Reads "impressive but not overwhelming".
//   - researcher: same rows, but each expands into
//       · shadowed range + full summary + eval strip (42%→94%)
//       · rubric list (fixture + user-written) + `+ rubric` button
//       · error list (fixture + user-written) + `› error` button
//       · dev-mode metadata row (model, cw id, log path)
//     — mirroring the dispatch's "对话逐条 / dev-mode 级 header/请求/raw
//     response" call. In the demo we don't have per-request headers wired
//     to compact windows yet, so the dev-mode row surfaces what we do have.
//
// Persistence: rubric/error forms POST through window.dsh.growth.v2Add*.
// The main process writes ~/.dsh/growth/{rubrics,errors}/<cwId>.json and
// echoes back the persisted entry. We re-read on success so the DOM
// reflects disk instead of trusting an optimistic in-memory push.

'use strict'
;(function () {

const state = {
  mode: 'novice', // 'novice' | 'researcher'
  payload: null, // { compactWindows, installedAt, logPath, userWrites, seedNote }
  expanded: new Set(), // Set<compactWindowId> — researcher-mode row expansion
  form: null, // { kind:'rubric'|'error', cwId } when a form is open
  loading: false,
}

let els = null

function $(id) { return document.getElementById(id) }
function el(tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

function mount() {
  const pane = document.querySelector('.pane[data-pane="growth"]')
  if (!pane) return
  // Replace the pane body wholesale — explicitly says "推倒
  // 现有 Growth 页重来". We keep the outer <section> so the tab wiring
  // (renderer.js:2936) still finds the pane.
  pane.innerHTML = ''
  const header = el('header', 'header')
  const lead = el('div', 'header-lead')
  lead.appendChild(el('div', 'page-title', 'Growth'))
  const sub = el('div', 'page-sub muted')
  sub.textContent = 'Compact-window history: what the runtime remembered, what it forgot, and what we taught it since.'
  lead.appendChild(sub)
  header.appendChild(lead)

  const acts = el('div', 'header-actions')
  const noviceBtn = el('button', 'ghost small growth-v2-mode-chip active', 'Novice')
  noviceBtn.type = 'button'
  noviceBtn.dataset.mode = 'novice'
  noviceBtn.title = 'One-line summary per compact window. No fold-outs.'
  const researcherBtn = el('button', 'ghost small growth-v2-mode-chip', 'Researcher')
  researcherBtn.type = 'button'
  researcherBtn.dataset.mode = 'researcher'
  researcherBtn.title = 'Expand every window to see rubrics, errors, evals, and dev-mode metadata.'
  acts.append(noviceBtn, researcherBtn)
  header.appendChild(acts)
  pane.appendChild(header)

  const body = el('section', 'growth-v2-body')
  const seedNote = el('div', 'growth-v2-seed-note muted small')
  seedNote.id = 'growth-v2-seed-note'
  body.appendChild(seedNote)

  // Evolution arc — a global "42% -> 94%" summary strip at the top of the
  // body. Written into `arcHost` from render() when the payload carries eval
  // data; hidden otherwise so a blank page doesn't look broken.
  const arcHost = el('div', 'growth-v2-arc')
  arcHost.id = 'growth-v2-arc'
  arcHost.hidden = true
  body.appendChild(arcHost)

  const empty = el('div', 'growth-v2-empty')
  empty.id = 'growth-v2-empty'
  empty.hidden = true
  empty.textContent = 'No compact windows yet. Once the runtime compacts a session, it will land here.'
  body.appendChild(empty)

  const list = el('ol', 'growth-v2-list')
  list.id = 'growth-v2-list'
  body.appendChild(list)

  const formHost = el('div', 'growth-v2-form-host')
  formHost.id = 'growth-v2-form-host'
  formHost.hidden = true
  body.appendChild(formHost)

  pane.appendChild(body)

  els = { pane, list, empty, seedNote, arcHost, formHost, noviceBtn, researcherBtn }

  noviceBtn.addEventListener('click', () => setMode('novice'))
  researcherBtn.addEventListener('click', () => setMode('researcher'))
}

function setMode(mode) {
  if (mode !== 'novice' && mode !== 'researcher') return
  state.mode = mode
  if (mode === 'novice') state.expanded.clear()
  if (els) {
    els.noviceBtn.classList.toggle('active', mode === 'novice')
    els.researcherBtn.classList.toggle('active', mode === 'researcher')
  }
  render()
}

async function show() {
  if (!els) mount()
  if (state.loading) return
  state.loading = true
  try {
    if (window.dsh && window.dsh.growth && typeof window.dsh.growth.v2Read === 'function') {
      const payload = await window.dsh.growth.v2Read()
      state.payload = payload
    } else {
      state.payload = { compactWindows: [], installedAt: null, logPath: null, userWrites: { rubrics: {}, errors: {} }, seedNote: null }
    }
  } finally {
    state.loading = false
  }
  render()
}

function projected() {
  const M = window.__dshGrowthV2Model
  const p = state.payload
  if (!M || !p) return { compactWindows: [] }
  return M.mergeAll({ compactWindows: p.compactWindows, installedAt: p.installedAt, logPath: p.logPath }, p.userWrites || {})
}

function render() {
  if (!els) return
  const model = window.__dshGrowthV2Model
  const p = projected()
  els.list.innerHTML = ''
  const cws = p.compactWindows
  els.empty.hidden = cws.length > 0

  if (state.payload && state.payload.seedNote) {
    els.seedNote.hidden = false
    els.seedNote.textContent = 'Demo data (fixture): ' + state.payload.seedNote
  } else {
    els.seedNote.hidden = true
    els.seedNote.textContent = ''
  }

  renderArc(cws)

  for (const cw of cws) {
    const li = el('li', 'growth-v2-row')
    li.dataset.cwId = cw.id
    if (state.expanded.has(cw.id)) li.classList.add('expanded')

    // — head row: [big compression tile] [meta stack + summary] [pass-rate chip] [badges] [chevron] —
    // The compression ratio is the one number that reads at a glance on a
    // researcher's diary page ("28.5k tokens collapsed into 26"), so it gets
    // a tile with the survival percentage large and centered.
    const head = el('div', 'growth-v2-head')

    const ratio = model.compressionRatio(cw)
    const tile = el('div', 'growth-v2-comp-tile')
    if (ratio) {
      const pct = (ratio.ratio * 100)
      const big = el('div', 'growth-v2-comp-pct', pct < 0.05 ? '<0.1%' : pct.toFixed(1) + '%')
      const label = el('div', 'growth-v2-comp-label muted small', 'survived')
      const sub = el('div', 'growth-v2-comp-sub muted small', `${model.shortTokens(cw.shadowedTokenCount)} → ${model.shortTokens(ratio.summaryTokens)} tok`)
      tile.append(big, label, sub)
    } else {
      tile.classList.add('empty')
    }
    head.appendChild(tile)

    const meta = el('div', 'growth-v2-meta')
    const metaTop = el('div', 'growth-v2-meta-top')
    metaTop.append(
      el('div', 'growth-v2-time', model.fmtTime(cw.time)),
      el('div', 'growth-v2-trigger pill', model.triggerLabel(cw.trigger || 'auto')),
      el('div', 'growth-v2-range muted small', model.formatShadowedRange(cw)),
    )
    meta.appendChild(metaTop)
    head.appendChild(meta)

    // Pass-rate chip on the row itself (novice-visible) — echoes the arc so
    // each row has its own memorable data point. Only when eval data exists.
    const evalStrip = model.evalStrip(cw)
    if (evalStrip) {
      const chip = el('div', 'growth-v2-passrate-chip')
      chip.append(
        el('span', 'growth-v2-passrate-num', evalStrip.improvedTo),
        el('span', 'growth-v2-passrate-label muted small', 'pass'),
      )
      chip.title = `${evalStrip.name}: ${evalStrip.pass} / ${evalStrip.total} passed`
      head.appendChild(chip)
    } else {
      head.appendChild(el('div', 'growth-v2-passrate-chip empty'))
    }

    const counts = model.badgeCounts(cw)
    const badge = el('div', 'growth-v2-badge pill', `R×${counts.rubrics} · E×${counts.errors}`)
    badge.title = `${counts.rubrics} rubric(s), ${counts.errors} error(s) captured for this window`
    if (counts.rubrics === 0 && counts.errors === 0) badge.classList.add('muted')
    head.appendChild(badge)

    // Novice mode gets a click on the row itself — a subtle expand chevron
    // stays visible so it doesn't look inert.
    const chevron = el('button', 'ghost icon-btn growth-v2-chevron', state.expanded.has(cw.id) ? '−' : '+')
    chevron.type = 'button'
    chevron.title = state.expanded.has(cw.id) ? 'Collapse' : 'Expand'
    chevron.addEventListener('click', (e) => {
      e.stopPropagation()
      if (state.expanded.has(cw.id)) state.expanded.delete(cw.id)
      else state.expanded.add(cw.id)
      render()
    })
    head.appendChild(chevron)
    li.appendChild(head)

    // — one-line summary (both modes) —
    const summary = el('div', 'growth-v2-summary', cw.summary || '')
    li.appendChild(summary)

    // — expanded body: eval strip + rubric list + error list + dev-mode —
    if (state.expanded.has(cw.id)) {
      const body = el('div', 'growth-v2-expanded')

      const evalStrip = model.evalStrip(cw)
      if (evalStrip) {
        const es = el('div', 'growth-v2-eval')
        es.append(
          el('div', 'growth-v2-eval-name', evalStrip.name),
          el('div', 'growth-v2-eval-arc', `${evalStrip.improvedFrom || '—'} → ${evalStrip.improvedTo}`),
          el('div', 'growth-v2-eval-count muted small', `${evalStrip.pass} / ${evalStrip.total} passed`),
        )
        body.appendChild(es)
      }

      body.appendChild(renderCollection('Rubrics', 'rubric', cw))
      body.appendChild(renderCollection('Errors', 'error', cw))

      const devRow = el('div', 'growth-v2-devrow muted small')
      devRow.append(
        span(`cw id: ${cw.id}`),
        span(`model: ${cw.model || '?'}`),
        span(`store: ${state.payload && state.payload.logPath || '~/.dsh/growth/'}`),
      )
      body.appendChild(devRow)

      li.appendChild(body)
    }

    els.list.appendChild(li)
  }
}

function span(txt) {
  const s = document.createElement('span')
  s.className = 'growth-v2-dev-span'
  s.textContent = txt
  return s
}

// Evolution arc — one SVG polyline across the current window list, plotting
// each window's pass rate on a normalized 0..100 y-axis. Windows without eval
// data still contribute an x-slot but render as a hollow marker; that way the
// arc reads as "we had three compacts, only the last two have an eval, and
// look how it climbed". Skipped entirely when zero windows carry eval data.
function renderArc(cws) {
  if (!els || !els.arcHost) return
  const model = window.__dshGrowthV2Model
  const points = cws.map((cw) => {
    const ev = model.evalStrip(cw)
    return {
      cwId: cw.id,
      time: cw.time,
      rate: ev ? ev.rate : null,
      prevRate: ev ? ev.prevRate : null,
      label: ev ? ev.improvedTo : null,
    }
  })
  const hasEval = points.some((p) => p.rate != null || p.prevRate != null)
  if (!hasEval || points.length === 0) {
    els.arcHost.hidden = true
    els.arcHost.innerHTML = ''
    return
  }

  // Seed the plot with the earliest prevRate so a single-eval fixture still
  // draws the "from -> to" jump instead of a flat dot.
  const first = points.find((p) => p.rate != null)
  const seedRate = first && first.prevRate != null ? first.prevRate : (first ? first.rate : 0)
  const plot = []
  if (first && first.prevRate != null) plot.push({ x: 0, rate: seedRate, label: first.prevRate != null ? Math.round(first.prevRate * 100) + '%' : null, seed: true })
  for (const p of points) {
    plot.push({ x: plot.length, rate: p.rate != null ? p.rate : null, label: p.label, cwId: p.cwId })
  }

  const W = 640
  const H = 72
  const padX = 24
  const padY = 12
  const stepX = plot.length > 1 ? (W - padX * 2) / (plot.length - 1) : 0
  const yFor = (r) => H - padY - (r != null ? r : 0) * (H - padY * 2)

  const svgNS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(svgNS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svg.setAttribute('class', 'growth-v2-arc-svg')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', `Pass-rate evolution across ${cws.length} compact windows`)

  // Baseline (0%) + top-of-scale (100%) reference lines.
  for (const [y, cls] of [[yFor(0), 'baseline'], [yFor(1), 'ceiling']]) {
    const ln = document.createElementNS(svgNS, 'line')
    ln.setAttribute('x1', padX); ln.setAttribute('x2', W - padX)
    ln.setAttribute('y1', y); ln.setAttribute('y2', y)
    ln.setAttribute('class', 'growth-v2-arc-ref-' + cls)
    svg.appendChild(ln)
  }

  const known = plot.map((p, i) => ({ ...p, i })).filter((p) => p.rate != null)
  if (known.length >= 2) {
    const poly = document.createElementNS(svgNS, 'polyline')
    poly.setAttribute('points', known.map((p) => `${padX + p.i * stepX},${yFor(p.rate)}`).join(' '))
    poly.setAttribute('class', 'growth-v2-arc-line')
    svg.appendChild(poly)
  }

  for (const p of plot) {
    if (p.rate == null) continue
    const cx = padX + p.x * stepX
    const cy = yFor(p.rate)
    const dot = document.createElementNS(svgNS, 'circle')
    dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); dot.setAttribute('r', p.seed ? 3.5 : 5)
    dot.setAttribute('class', p.seed ? 'growth-v2-arc-dot seed' : 'growth-v2-arc-dot')
    svg.appendChild(dot)
    if (p.label) {
      const tx = document.createElementNS(svgNS, 'text')
      tx.setAttribute('x', cx)
      tx.setAttribute('y', cy - 8)
      tx.setAttribute('text-anchor', 'middle')
      tx.setAttribute('class', 'growth-v2-arc-label' + (p.seed ? ' seed' : ''))
      tx.textContent = p.label
      svg.appendChild(tx)
    }
  }

  const caption = el('div', 'growth-v2-arc-caption muted small', `Pass-rate evolution · ${cws.length} compact window${cws.length === 1 ? '' : 's'}`)

  els.arcHost.hidden = false
  els.arcHost.innerHTML = ''
  els.arcHost.appendChild(svg)
  els.arcHost.appendChild(caption)
}

function renderCollection(label, kind, cw) {
  const box = el('div', `growth-v2-collection growth-v2-collection-${kind}`)
  const head = el('div', 'growth-v2-collection-head')
  head.appendChild(el('h4', 'growth-v2-collection-title', label))
  const add = el('button', 'ghost small growth-v2-add', kind === 'rubric' ? '+ rubric' : '› error')
  add.type = 'button'
  add.title = kind === 'rubric'
    ? 'Capture a rubric assertion for this compact window (writes ~/.dsh/growth/rubrics/…)'
    : 'Flag an error case for this compact window (writes ~/.dsh/growth/errors/…)'
  add.addEventListener('click', (e) => { e.stopPropagation(); openForm(kind, cw.id) })
  head.appendChild(add)
  box.appendChild(head)

  const items = kind === 'rubric' ? cw.rubrics : cw.errors
  if (!items || !items.length) {
    box.appendChild(el('div', 'growth-v2-collection-empty muted small', kind === 'rubric' ? 'No rubrics yet.' : 'No errors flagged yet.'))
  } else {
    const ul = el('ul', 'growth-v2-collection-list')
    for (const it of items) {
      const li = el('li', 'growth-v2-collection-item')
      if (kind === 'rubric') {
        li.appendChild(el('div', 'growth-v2-item-primary', it.assertion || ''))
        if (it.expected) li.appendChild(el('div', 'growth-v2-item-secondary muted small', `expected: ${it.expected}`))
        if (it.tag) li.appendChild(el('div', 'growth-v2-item-tag pill muted small', it.tag))
      } else {
        li.appendChild(el('div', 'growth-v2-item-primary', it.text || ''))
        if (it.cause) li.appendChild(el('div', 'growth-v2-item-secondary muted small', `cause: ${it.cause}`))
        if (it.todo) li.appendChild(el('div', 'growth-v2-item-tag pill muted small', `todo: ${it.todo}`))
      }
      ul.appendChild(li)
    }
    box.appendChild(ul)
  }
  return box
}

function openForm(kind, cwId) {
  state.form = { kind, cwId }
  const host = els.formHost
  host.hidden = false
  host.innerHTML = ''
  const wrap = el('form', `growth-v2-form growth-v2-form-${kind}`)
  wrap.appendChild(el('h4', 'growth-v2-form-title', kind === 'rubric' ? `+ rubric for ${cwId}` : `› error for ${cwId}`))

  const fields = kind === 'rubric'
    ? [
        { name: 'assertion', label: 'Assertion (natural language, required)', type: 'textarea' },
        { name: 'expected', label: 'Expected value / behavior', type: 'text' },
        { name: 'tag', label: 'Tag (optional)', type: 'text' },
      ]
    : [
        { name: 'text', label: 'Error description (required)', type: 'textarea' },
        { name: 'cause', label: 'Suspected root cause', type: 'text' },
        { name: 'todo', label: 'Todo (optional)', type: 'text' },
      ]

  for (const f of fields) {
    const row = el('label', 'growth-v2-form-row')
    row.appendChild(el('span', 'growth-v2-form-label small', f.label))
    const input = document.createElement(f.type === 'textarea' ? 'textarea' : 'input')
    input.name = f.name
    if (f.type === 'text') input.type = 'text'
    row.appendChild(input)
    wrap.appendChild(row)
  }

  const actions = el('div', 'growth-v2-form-actions')
  const submit = el('button', 'primary small', 'Save')
  submit.type = 'submit'
  const cancel = el('button', 'ghost small', 'Cancel')
  cancel.type = 'button'
  cancel.addEventListener('click', closeForm)
  actions.append(submit, cancel)
  wrap.appendChild(actions)

  const errRow = el('div', 'growth-v2-form-error muted small')
  errRow.hidden = true
  wrap.appendChild(errRow)

  wrap.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    errRow.hidden = true
    const form = {}
    for (const f of fields) {
      const input = wrap.querySelector(`[name="${f.name}"]`)
      form[f.name] = input ? String(input.value || '').trim() : ''
    }
    const method = kind === 'rubric' ? 'v2AddRubric' : 'v2AddError'
    if (!(window.dsh && window.dsh.growth && typeof window.dsh.growth[method] === 'function')) {
      errRow.hidden = false
      errRow.textContent = 'IPC unavailable. Growth v2 needs the preload wire.'
      return
    }
    const res = await window.dsh.growth[method](cwId, form)
    if (!res || !res.ok) {
      errRow.hidden = false
      errRow.textContent = (res && res.reason === 'assertion-required') ? 'Assertion cannot be blank.'
        : (res && res.reason === 'text-required') ? 'Error description cannot be blank.'
        : 'Save failed.'
      return
    }
    closeForm()
    await show()
  })

  host.appendChild(wrap)
  const first = wrap.querySelector('textarea, input[type="text"]')
  if (first) first.focus()
}

function closeForm() {
  state.form = null
  if (els && els.formHost) {
    els.formHost.hidden = true
    els.formHost.innerHTML = ''
  }
}

const api = { mount, show, render, setMode, _state: state }
window.__dshGrowthV2 = api

})()
