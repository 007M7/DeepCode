// chat-side-drawer.js — right-side fold-out drawer for the Chat pane
// (feat/chat-triple-view, lane-chat-triple).
//
// Three sections rendered in order:
//   1. Current Turn — model / tokens / duration / latency / session id /
//      turn seq for the selected turn (defaults to the newest one).
//   2. Session Overview — running totals: tokens, duration, turn count.
//   3. History — one row per turn (role tag + first-line summary); click
//      jumps main stream to that turn.
//
// State: pure over a session-like snapshot. The renderer wires it via
// `renderChatSideDrawer(container, snapshot)` and toggle by adding /
// removing `hidden` on the drawer aside. Nothing here talks to the DOM
// beyond the passed-in container.

'use strict'

;(function () {

// Derive the ordered turn list from a cachedEvents ring. A turn is
// bounded by turn/start .. turn/end pairs; user/message events sit
// between turns. We flatten to a stream of "history rows" the drawer
// renders — one row per user message + one row per assistant turn.
function deriveTurnRows(events) {
  if (!Array.isArray(events) || events.length === 0) return []
  const rows = []
  let currentTurn = null
  let turnIdx = 0
  for (const evt of events) {
    if (!evt || typeof evt !== 'object') continue
    const type = evt.type || evt.event || ''
    const data = evt.data || {}
    if (type === 'user/message') {
      const text = extractText(data)
      rows.push({
        kind: 'user',
        role: 'user',
        summary: firstLine(text) || '(empty)',
        turnIndex: null,
        seq: evt.seq || 0,
        turnId: null,
      })
    } else if (type === 'turn/start' || type === 'turn.start') {
      currentTurn = {
        kind: 'turn',
        role: 'agent',
        summary: '',
        turnIndex: turnIdx,
        seq: evt.seq || 0,
        turnId: data.turnId || data.turn_id || `t${turnIdx}`,
        model: data.model || '',
        tokens: 0,
        durationMs: 0,
        latencyMs: 0,
        interrupted: false,
      }
      turnIdx += 1
      rows.push(currentTurn)
    } else if (currentTurn && (type === 'assistant/message' || type === 'assistant.message')) {
      const text = extractText(data)
      if (!currentTurn.summary) currentTurn.summary = firstLine(text)
    } else if (currentTurn && (type === 'turn/end' || type === 'turn.end')) {
      const usage = data.usage || {}
      currentTurn.tokens = num(usage.total_tokens || usage.totalTokens || usage.tokens || data.tokens)
      currentTurn.durationMs = num(data.durationMs || data.duration_ms || 0)
      currentTurn.latencyMs = num(data.latencyMs || data.latency_ms || 0)
      currentTurn.model = currentTurn.model || data.model || ''
      const stop = (data.stopReason || data.stop_reason || '').toString().toLowerCase()
      if (stop.includes('cancel') || stop.includes('interrupt') || stop.includes('reject')) {
        currentTurn.interrupted = true
      }
      currentTurn = null
    } else if (currentTurn && (type === 'user/interrupt' || type === 'user/cancel')) {
      currentTurn.interrupted = true
    }
  }
  return rows
}

function extractText(data) {
  if (!data) return ''
  if (typeof data === 'string') return data
  if (typeof data.text === 'string') return data.text
  if (typeof data.content === 'string') return data.content
  if (Array.isArray(data.content)) {
    return data.content.map((c) => (c && typeof c.text === 'string') ? c.text : '').join(' ')
  }
  if (typeof data.delta === 'string') return data.delta
  return ''
}
function firstLine(text) {
  if (typeof text !== 'string') return ''
  const trimmed = text.trim()
  if (!trimmed) return ''
  const nl = trimmed.indexOf('\n')
  const line = nl === -1 ? trimmed : trimmed.slice(0, nl)
  return line.length > 80 ? line.slice(0, 79) + '…' : line
}
function num(x) {
  const n = Number(x)
  return Number.isFinite(n) ? n : 0
}
function formatMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

// Compute session-level overview from the derived rows.
function summarize(rows) {
  const turns = rows.filter((r) => r.kind === 'turn')
  const tokens = turns.reduce((acc, t) => acc + (t.tokens || 0), 0)
  const duration = turns.reduce((acc, t) => acc + (t.durationMs || 0), 0)
  return {
    turnCount: turns.length,
    userCount: rows.filter((r) => r.kind === 'user').length,
    tokens,
    duration,
    interrupted: turns.filter((t) => t.interrupted).length,
  }
}

// Render a drawer body into a container element. `snapshot`:
//   { sessionId, model?, events, selectedTurnId? }
function renderChatSideDrawer(container, snapshot) {
  if (!container) return
  // Clear
  container.textContent = ''
  container.className = 'chat-side-drawer-body'
  const doc = container.ownerDocument || document
  const rows = deriveTurnRows(snapshot && snapshot.events)
  const overview = summarize(rows)
  const selectedTurnId = snapshot && snapshot.selectedTurnId
  const turns = rows.filter((r) => r.kind === 'turn')
  const selected = turns.find((t) => t.turnId === selectedTurnId) || turns[turns.length - 1] || null

  // Section 1: current turn
  container.appendChild(renderCurrentTurn(doc, snapshot || {}, selected))
  // Section 2: session overview
  container.appendChild(renderOverview(doc, overview))
  // Section 3: history
  container.appendChild(renderHistory(doc, rows, selectedTurnId, snapshot && snapshot.onSelect))
}

function renderCurrentTurn(doc, snapshot, turn) {
  const section = doc.createElement('section')
  section.className = 'chat-side-drawer-section chat-side-drawer-section--current'
  const title = doc.createElement('div')
  title.className = 'chat-side-drawer-section-title'
  title.textContent = 'Current Turn'
  section.appendChild(title)
  const dl = doc.createElement('dl')
  dl.className = 'chat-side-drawer-meta'
  const entries = []
  if (turn) {
    entries.push(['seq', turn.turnIndex != null ? `#${turn.turnIndex}` : '—'])
    entries.push(['model', turn.model || snapshot.model || '—'])
    entries.push(['tokens', turn.tokens ? String(turn.tokens) : '—'])
    entries.push(['duration', formatMs(turn.durationMs)])
    entries.push(['latency', formatMs(turn.latencyMs)])
    entries.push(['turn id', turn.turnId || '—'])
    entries.push(['session', shortSid(snapshot.sessionId)])
    if (turn.interrupted) entries.push(['state', 'interrupted'])
  } else {
    entries.push(['state', 'no turn yet'])
    entries.push(['session', shortSid(snapshot.sessionId)])
  }
  for (const [k, v] of entries) {
    const dt = doc.createElement('dt'); dt.textContent = k
    const dd = doc.createElement('dd'); dd.textContent = v
    dl.appendChild(dt); dl.appendChild(dd)
  }
  section.appendChild(dl)
  return section
}
function renderOverview(doc, overview) {
  const section = doc.createElement('section')
  section.className = 'chat-side-drawer-section chat-side-drawer-section--overview'
  const title = doc.createElement('div')
  title.className = 'chat-side-drawer-section-title'
  title.textContent = 'Session Overview'
  section.appendChild(title)
  const dl = doc.createElement('dl')
  dl.className = 'chat-side-drawer-meta'
  const entries = [
    ['turns', String(overview.turnCount)],
    ['user msgs', String(overview.userCount)],
    ['tokens', String(overview.tokens)],
    ['duration', formatMs(overview.duration)],
    ['interrupts', String(overview.interrupted)],
  ]
  for (const [k, v] of entries) {
    const dt = doc.createElement('dt'); dt.textContent = k
    const dd = doc.createElement('dd'); dd.textContent = v
    dl.appendChild(dt); dl.appendChild(dd)
  }
  section.appendChild(dl)
  return section
}
function renderHistory(doc, rows, selectedTurnId, onSelect) {
  const section = doc.createElement('section')
  section.className = 'chat-side-drawer-section chat-side-drawer-section--history'
  const title = doc.createElement('div')
  title.className = 'chat-side-drawer-section-title'
  title.textContent = 'History'
  section.appendChild(title)
  if (rows.length === 0) {
    const empty = doc.createElement('div')
    empty.className = 'chat-side-drawer-empty'
    empty.textContent = 'No turns yet — send a message to start.'
    section.appendChild(empty)
    return section
  }
  const ul = doc.createElement('ul')
  ul.className = 'chat-side-drawer-history'
  for (const row of rows) {
    const li = doc.createElement('li')
    li.className = 'chat-side-drawer-history-item'
    if (row.turnId && row.turnId === selectedTurnId) li.classList.add('active')
    if (row.turnId) li.dataset.turnId = row.turnId
    if (row.seq) li.dataset.seq = String(row.seq)
    li.dataset.kind = row.kind
    const roleEl = doc.createElement('span')
    roleEl.className = 'chat-side-drawer-history-role'
    roleEl.textContent = row.role
    const sumEl = doc.createElement('span')
    sumEl.className = 'chat-side-drawer-history-summary'
    sumEl.textContent = row.summary || (row.kind === 'turn' ? `(turn ${row.turnIndex})` : '(user)')
    li.appendChild(roleEl)
    li.appendChild(sumEl)
    if (typeof onSelect === 'function') {
      li.addEventListener('click', () => onSelect(row))
    }
    ul.appendChild(li)
  }
  section.appendChild(ul)
  return section
}
function shortSid(sid) {
  if (typeof sid !== 'string' || !sid) return '—'
  return sid.length > 10 ? sid.slice(0, 8) + '…' : sid
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    deriveTurnRows,
    summarize,
    firstLine,
    formatMs,
    renderChatSideDrawer,
  }
}
if (typeof window !== 'undefined') {
  window.__dshChatSideDrawer = {
    deriveTurnRows,
    summarize,
    firstLine,
    formatMs,
    renderChatSideDrawer,
  }
}

})()
