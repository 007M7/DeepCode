// Mission Control — Tree subview. Info-dense flat list of every session
// with status + activity + child counts, one row per session. Depth is
// encoded with an indent guide and box-drawing connector, matching the
// sidebar convention (└─ per depth level).
//
// This module is a factory: `createMissionTreeView(root, deps)` returns a
// `render(rows)` function the controller calls whenever the model changes.
// Root ownership is at the caller; the view mutates innerHTML in one pass.

'use strict'

;(function () {
  function fmtRel(t) {
    if (!t) return '—'
    const dt = Date.now() - t
    if (dt < 5_000) return 'now'
    if (dt < 60_000) return `${Math.floor(dt / 1000)}s ago`
    if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`
    if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h ago`
    return `${Math.floor(dt / 86_400_000)}d ago`
  }

  function createMissionTreeView(root, deps) {
    const onSelect = (deps && deps.onSelect) || (() => {})
    const collapsed = new Set() // sessionIds whose subtree is collapsed
    root.classList.add('mission-tree')

    function isHidden(row, rows) {
      // Walk up the depth stack looking at previously-emitted rows; if any
      // ancestor is in `collapsed`, this row is hidden. Rows are given in
      // pre-order so the immediate ancestor is the last-seen row with a
      // strictly smaller depth.
      let d = row.depth - 1
      for (let i = rows.indexOf(row) - 1; i >= 0 && d >= 0; i--) {
        const r = rows[i]
        if (r.depth <= d) {
          if (collapsed.has(r.sessionId)) return true
          d = r.depth - 1
        }
      }
      return false
    }

    function render(rows) {
      root.innerHTML = ''
      if (!rows || rows.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'mission-empty'
        empty.textContent = 'No sessions yet. Start a chat, or load sample data from the empty-state bar.'
        root.appendChild(empty)
        return
      }
      for (const row of rows) {
        if (isHidden(row, rows)) continue
        const item = document.createElement('div')
        item.className = 'mission-tree-row'
        item.dataset.sessionId = row.sessionId
        if (row.running) item.classList.add('running')
        if (row.orphan) item.classList.add('orphan')

        // Depth indicator: N × 2-space indent + a "└─ " marker at leaf level.
        if (row.depth > 0) {
          const indent = document.createElement('span')
          indent.className = 'mission-tree-indent'
          indent.textContent = '  '.repeat(row.depth - 1) + '└─ '
          item.appendChild(indent)
        }

        // Status dot: green pulsing when running, muted when idle, check
        // when finished (we approximate finished as "not running and has
        // an assistant/message tail").
        const dot = document.createElement('span')
        dot.className = 'mission-tree-dot'
        if (row.running) dot.classList.add('running')
        else if (row.lastEventType === 'turn/end') dot.classList.add('finished')
        else dot.classList.add('idle')
        item.appendChild(dot)

        // Title (click = focus in Chat).
        const title = document.createElement('span')
        title.className = 'mission-tree-title'
        title.textContent = row.title
        title.title = row.sessionId
        title.addEventListener('click', (ev) => {
          ev.stopPropagation()
          onSelect(row.sessionId)
        })
        item.appendChild(title)

        // Collapse toggle if the node has children.
        if (row.hasChildren) {
          const toggle = document.createElement('button')
          toggle.className = 'mission-tree-collapse'
          toggle.type = 'button'
          toggle.textContent = collapsed.has(row.sessionId) ? '▸' : '▾'
          toggle.title = collapsed.has(row.sessionId) ? 'expand subtree' : 'collapse subtree'
          toggle.addEventListener('click', (ev) => {
            ev.stopPropagation()
            if (collapsed.has(row.sessionId)) collapsed.delete(row.sessionId)
            else collapsed.add(row.sessionId)
            render(rows)
          })
          item.appendChild(toggle)
        }

        // Right-hand metrics: activity summary + counts.
        const metrics = document.createElement('div')
        metrics.className = 'mission-tree-metrics'

        const rel = document.createElement('span')
        rel.className = 'mission-tree-rel'
        rel.textContent = fmtRel(row.lastEventTime)
        // Preflight (2026-07-18): don't leak "1969-12-31T…" into the title
        // when the row carries a fixture-relative timestamp.
        rel.title = (row.lastEventTime && row.lastEventTime >= 946684800000 /* Y2K */)
          ? new Date(row.lastEventTime).toISOString()
          : ''
        metrics.appendChild(rel)

        const evc = document.createElement('span')
        evc.className = 'mission-tree-count'
        evc.textContent = `${row.eventCount} ev`
        evc.title = 'total events seen in this session'
        metrics.appendChild(evc)

        if (row.toolCallCount > 0) {
          const tc = document.createElement('span')
          tc.className = 'mission-tree-count tools'
          tc.textContent = `${row.toolCallCount} tool`
          metrics.appendChild(tc)
        }

        if (row.todoCount > 0) {
          const todo = document.createElement('span')
          todo.className = 'mission-tree-count todos'
          todo.textContent = `${row.todoCount} todo`
          metrics.appendChild(todo)
        }

        item.appendChild(metrics)

        // Second line: last-event summary, muted.
        const sub = document.createElement('div')
        sub.className = 'mission-tree-sub'
        sub.textContent = row.lastEventSummary || row.lastEventType || ''
        item.appendChild(sub)

        root.appendChild(item)
      }
    }

    return { render }
  }

  const api = { createMissionTreeView }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (typeof globalThis !== 'undefined') globalThis.MissionTree = api
})()
