// Mission Control — Board (kanban) subview. Three columns:
// pending / in_progress / completed, each holding one card per todo
// aggregated across all sessions that emitted a `todo/write`. Cards carry
// the todo content plus a compact session badge that jumps back to the
// Chat view when clicked.
//
// Empty-state shape (QA §5.1): a one-sentence explainer is not
// enough to teach a first-time user what this view will fill up with. We
// borrow the pattern from mission-tree/mission-topo — title + hint —
// and add a ghost preview: three column headers with a placeholder card
// each, so the reader sees the shape the real data will land in. The
// preview cards are dashed and muted so they can't be mistaken for real
// state, and they carry no click affordance.

'use strict'

;(function () {
  const COLUMNS = [
    { key: 'pending',     label: 'Pending' },
    { key: 'in_progress', label: 'In Progress' },
    { key: 'completed',   label: 'Completed' },
  ]

  // Placeholder rows shown in the empty state. Kept as content the reader
  // can actually read — a generic todo per bucket — instead of lorem so
  // the shape is legible without being mistaken for user data. Localized
  // in one place; the render loop wraps each in `.placeholder`.
  const PREVIEW_CARDS = {
    pending:     'Draft the release notes',
    in_progress: 'Refactor the compact seam',
    completed:   'Land the artifact preview PR',
  }

  function buildEmptyState() {
    // Container mirrors the mission-empty pattern used by tree/topo (title +
    // sub) but adds a ghost `.mission-board-preview` beneath it so the reader
    // sees a mini kanban shape. This is the "what will fill in here" cue that
    // a single sentence failed to convey.
    const empty = document.createElement('div')
    empty.className = 'mission-empty mission-board-empty'
    const title = document.createElement('div')
    title.className = 'mission-empty-title'
    title.textContent = 'No todos yet'
    const sub = document.createElement('div')
    sub.className = 'mission-empty-sub'
    sub.textContent = 'Any session that writes todos through the todo/write '
      + 'tool lands in this three-column board. Here is the shape it takes:'
    empty.append(title, sub)

    const preview = document.createElement('div')
    preview.className = 'mission-board-preview'
    preview.setAttribute('aria-hidden', 'true')
    // fix/demo-labels: the three PREVIEW_CARDS strings look like real todos
    // at a glance ("Draft the release notes" / "Refactor the compact seam"
    // / "Land the artifact preview PR"). Prefix a "preview" chip on the
    // ghost so a fresh reader doesn't mistake the shape hint for the real
    // todo list. See docs/review-demo-labels.md P4.
    const previewChip = document.createElement('span')
    previewChip.className = 'demo-tier-chip mission-board-preview-chip'
    // setAttribute over `.dataset.tier =` so the plain-object test stub
    // (test/mission-board.test.js) doesn't need to fake a DOMStringMap.
    previewChip.setAttribute('data-tier', 'preview')
    previewChip.textContent = 'preview'
    previewChip.title = 'Shape preview — the cards below illustrate the three-column layout; real todos land here once a session writes them via todo/write.'
    preview.appendChild(previewChip)
    for (const col of COLUMNS) {
      const colEl = document.createElement('div')
      colEl.className = 'mission-board-preview-column ' + col.key
      const head = document.createElement('div')
      head.className = 'mission-board-preview-head'
      head.textContent = col.label
      const card = document.createElement('div')
      card.className = 'mission-board-preview-card ' + col.key
      card.textContent = PREVIEW_CARDS[col.key]
      colEl.append(head, card)
      preview.appendChild(colEl)
    }
    empty.appendChild(preview)
    return empty
  }

  function createMissionBoardView(root, deps) {
    const onSelect = (deps && deps.onSelect) || (() => {})
    root.classList.add('mission-board')

    function render(buckets) {
      root.innerHTML = ''
      const total = COLUMNS.reduce((sum, c) => sum + (buckets[c.key]?.length || 0), 0)
      if (total === 0) {
        root.appendChild(buildEmptyState())
        return
      }
      const grid = document.createElement('div')
      grid.className = 'mission-board-grid'
      for (const col of COLUMNS) {
        const column = document.createElement('div')
        column.className = 'mission-board-column ' + col.key
        const head = document.createElement('div')
        head.className = 'mission-board-column-head'
        head.textContent = `${col.label} · ${buckets[col.key]?.length || 0}`
        column.appendChild(head)
        const body = document.createElement('div')
        body.className = 'mission-board-column-body'
        const cards = buckets[col.key] || []
        for (const card of cards) {
          const el = document.createElement('div')
          el.className = 'mission-board-card ' + col.key
          const content = document.createElement('div')
          content.className = 'mission-board-card-content'
          content.textContent = card.content
          el.appendChild(content)
          const badge = document.createElement('button')
          badge.className = 'mission-board-card-badge'
          badge.type = 'button'
          badge.textContent = card.sessionTitle
          badge.title = 'jump to ' + card.sessionId
          badge.addEventListener('click', (ev) => {
            ev.stopPropagation()
            onSelect(card.sessionId)
          })
          el.appendChild(badge)
          body.appendChild(el)
        }
        if (cards.length === 0) {
          const dash = document.createElement('div')
          dash.className = 'mission-board-column-empty'
          dash.textContent = '—'
          body.appendChild(dash)
        }
        column.appendChild(body)
        grid.appendChild(column)
      }
      root.appendChild(grid)
    }

    return { render }
  }

  // `_internal` exposes the empty-state builder for node --test so the
  // ghost-preview structure can be pinned without a jsdom render pass.
  const api = { createMissionBoardView, _internal: { buildEmptyState, PREVIEW_CARDS, COLUMNS } }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (typeof globalThis !== 'undefined') globalThis.MissionBoard = api
})()
