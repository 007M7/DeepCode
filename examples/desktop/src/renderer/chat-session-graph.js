// chat-session-graph.js — pure-SVG DAG rendering of a session's turn
// sequence for the Chat pane's Graph view.
//
// Nodes: user messages (grey), agent turns (accent), interrupted turns
// (orange rim). Edges:
//   - succession (solid) between consecutive nodes on the main line
//   - fork (dashed) when a turn declares a fork to a child session id
//   - interruption (orange) at the seam where a turn was cancelled
//
// Layout is a vertical timeline (one row per node) so the graph stays
// readable at any width without a force-directed engine. Kept dependency-
// free — pure SVG built via createElementNS so tests can shim the DOM.

'use strict'

;(function () {

const SVG_NS = 'http://www.w3.org/2000/svg'
const NODE_R = 12
const ROW_H = 44
const COL_W = 60
const PAD_Y = 24
const PAD_X = 40

// Extract user-visible text from a user/message data payload. Mirrors
// chat-side-drawer.extractText — kept local so the two views can diverge
// on truncation policy without cross-coupling.
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

// First non-empty line of `text`, capped at ~28 chars with an ellipsis.
// 28 is a deliberate crop: the label reads on a single row alongside the
// `user ·` tag; beyond ~35 chars SVG text bleeds into the next column at
// the default zoom.
function firstLine28(text) {
  if (typeof text !== 'string') return ''
  const trimmed = text.trim()
  if (!trimmed) return ''
  const nl = trimmed.indexOf('\n')
  const line = nl === -1 ? trimmed : trimmed.slice(0, nl)
  return line.length > 28 ? line.slice(0, 27) + '…' : line
}

function typeOf(evt) {
  return (evt && (evt.type || evt.event)) || ''
}

// Repair the wire event stream so the DAG reads in causal order. Two
// passes:
//   1. Stable sort by evt.seq (missing seq is treated as 0, so unstamped
//      events keep their relative order since Array.sort is stable).
//   2. Adjacent-pair fixup: the runtime protocol serialises turn/start
//      before its triggering user/message echo — renderer.js ~L809
//      calls this out; the main chat stream hides it via optimistic
//      bubble + echo adoption, but the Graph view sees the raw order
//      and would draw the user node after its own turn. When a
//      turn/start lands with no unclaimed user/message preceding it
//      and the next event IS a user/message, swap them so user comes
//      first. Fork / interrupt / turn/end are left in place — only
//      the (turn/start, user/message) reversal is repaired.
function reorderEvents(events) {
  if (!Array.isArray(events)) return []
  const sorted = events.slice().sort((a, b) => {
    const sa = (a && typeof a.seq === 'number') ? a.seq : 0
    const sb = (b && typeof b.seq === 'number') ? b.seq : 0
    return sa - sb
  })
  let pendingUser = false
  for (let i = 0; i < sorted.length; i++) {
    const t = typeOf(sorted[i])
    if (t === 'user/message') {
      pendingUser = true
    } else if (t === 'turn/start' || t === 'turn.start') {
      if (pendingUser) {
        pendingUser = false
      } else if (i + 1 < sorted.length && typeOf(sorted[i + 1]) === 'user/message') {
        // Only swap when the user's seq is at or right after the turn's
        // (co-temporal echo). A large seq gap would mean the user
        // arrived much later — a barge-in, not the echo bug — and must
        // stay after the turn so the graph reads truthfully.
        const turnSeq = (typeof sorted[i].seq === 'number') ? sorted[i].seq : 0
        const userSeq = (typeof sorted[i + 1].seq === 'number') ? sorted[i + 1].seq : 0
        if (userSeq - turnSeq <= 1) {
          const tmp = sorted[i]
          sorted[i] = sorted[i + 1]
          sorted[i + 1] = tmp
          pendingUser = false // swapped-in user is paired with this turn
          i += 1 // skip past the just-paired turn so we don't re-process it
        }
      }
    } else if (t === 'turn/end' || t === 'turn.end') {
      pendingUser = false
    }
  }
  return sorted
}

// Derive nodes + edges from a cachedEvents list. Same event model as
// chat-side-drawer.deriveTurnRows so the two views agree.
function deriveGraph(events) {
  const nodes = []
  const edges = []
  if (!Array.isArray(events)) return { nodes, edges }
  const ordered = reorderEvents(events)
  let currentTurn = null
  let turnIdx = 0
  let lastNodeId = null
  for (const evt of ordered) {
    if (!evt || typeof evt !== 'object') continue
    const type = evt.type || evt.event || ''
    const data = evt.data || {}
    if (type === 'user/message') {
      const id = `u${nodes.length}`
      const raw = extractText(data).trim()
      const preview = firstLine28(raw)
      const label = preview ? `user · "${preview}"` : 'user'
      nodes.push({
        id, kind: 'user', label,
        title: raw && raw !== preview ? raw : null,
        turnId: null, seq: evt.seq || 0,
      })
      if (lastNodeId != null) edges.push({ from: lastNodeId, to: id, kind: 'succession' })
      lastNodeId = id
    } else if (type === 'turn/start' || type === 'turn.start') {
      const id = `t${turnIdx}`
      currentTurn = {
        id, kind: 'turn', label: `#${turnIdx}`,
        title: null,
        turnId: data.turnId || data.turn_id || id,
        seq: evt.seq || 0,
        interrupted: false,
        forkChildren: [],
      }
      nodes.push(currentTurn)
      if (lastNodeId != null) edges.push({ from: lastNodeId, to: id, kind: 'succession' })
      lastNodeId = id
      turnIdx += 1
    } else if (currentTurn && (type === 'user/interrupt' || type === 'user/cancel')) {
      currentTurn.interrupted = true
    } else if (currentTurn && (type === 'turn/end' || type === 'turn.end')) {
      const stopRaw = (data.stopReason || data.stop_reason || '').toString().trim()
      const stop = stopRaw.toLowerCase()
      if (stop.includes('cancel') || stop.includes('interrupt') || stop.includes('reject')) {
        currentTurn.interrupted = true
      }
      if (currentTurn.interrupted) {
        currentTurn.kind = 'interrupt'
      }
      if (stopRaw) {
        const short = stopRaw.length > 20 ? stopRaw.slice(0, 19) + '…' : stopRaw
        currentTurn.label = `${currentTurn.label} · ${short}`
        if (stopRaw.length > 20) currentTurn.title = stopRaw
      }
      currentTurn = null
    } else if (type === 'session/fork' || type === 'session.fork') {
      const parentTurnId = data.fromTurnId || data.parentTurnId
      const childId = data.childSessionId || data.child_session_id
      const parent = nodes.find((n) => n.turnId === parentTurnId)
      const parentId = parent ? parent.id : (lastNodeId || null)
      if (parentId) {
        const forkId = `f${nodes.length}`
        nodes.push({
          id: forkId, kind: 'fork', label: 'fork',
          turnId: null, seq: evt.seq || 0,
          childSessionId: childId,
        })
        edges.push({ from: parentId, to: forkId, kind: 'fork' })
      }
    }
  }
  // Recolour any interrupt edges leading into an interrupt node.
  for (const edge of edges) {
    const target = nodes.find((n) => n.id === edge.to)
    if (target && target.kind === 'interrupt') edge.kind = 'interrupt'
  }
  return { nodes, edges }
}

// Compute {x,y} for each node using a simple vertical stack. Fork nodes
// step out to the right (column +1) so the DAG shows a branch.
function layoutGraph(graph) {
  const positions = new Map()
  let mainRow = 0
  for (const node of graph.nodes) {
    if (node.kind === 'fork') {
      const parentEdge = graph.edges.find((e) => e.to === node.id)
      const parentPos = parentEdge ? positions.get(parentEdge.from) : null
      if (parentPos) {
        positions.set(node.id, { x: parentPos.x + COL_W, y: parentPos.y })
        continue
      }
    }
    positions.set(node.id, { x: PAD_X, y: PAD_Y + mainRow * ROW_H })
    mainRow += 1
  }
  const width = PAD_X * 2 + COL_W * 2 + NODE_R * 2
  const height = PAD_Y * 2 + Math.max(0, mainRow - 1) * ROW_H + NODE_R * 2
  return { positions, width, height }
}

function renderSessionGraph(container, snapshot) {
  if (!container) return
  container.textContent = ''
  const doc = container.ownerDocument || document
  const events = snapshot && snapshot.events
  const graph = deriveGraph(events)
  if (graph.nodes.length === 0) {
    const empty = doc.createElement('div')
    empty.className = 'chat-session-graph-empty'
    empty.textContent = 'No turns to graph yet. Send a message on this session.'
    container.appendChild(empty)
    return
  }
  const { positions, width, height } = layoutGraph(graph)
  const svg = doc.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', 'Session graph')
  // Edges first so nodes overpaint their endpoints.
  for (const edge of graph.edges) {
    const from = positions.get(edge.from)
    const to = positions.get(edge.to)
    if (!from || !to) continue
    const line = doc.createElementNS(SVG_NS, 'line')
    line.setAttribute('x1', String(from.x))
    line.setAttribute('y1', String(from.y))
    line.setAttribute('x2', String(to.x))
    line.setAttribute('y2', String(to.y))
    line.setAttribute('class', `graph-edge edge-${edge.kind}`)
    line.dataset.edgeKind = edge.kind
    svg.appendChild(line)
  }
  for (const node of graph.nodes) {
    const pos = positions.get(node.id)
    if (!pos) continue
    const g = doc.createElementNS(SVG_NS, 'g')
    const cls = `graph-node node-${node.kind}`
    g.setAttribute('class', cls)
    g.dataset.nodeId = node.id
    g.dataset.nodeKind = node.kind
    if (node.turnId) g.dataset.turnId = node.turnId
    if (node.turnId && snapshot && snapshot.selectedTurnId === node.turnId) {
      g.setAttribute('class', cls + ' active')
    }
    const circle = doc.createElementNS(SVG_NS, 'circle')
    circle.setAttribute('cx', String(pos.x))
    circle.setAttribute('cy', String(pos.y))
    circle.setAttribute('r', String(NODE_R))
    g.appendChild(circle)
    const label = doc.createElementNS(SVG_NS, 'text')
    label.setAttribute('x', String(pos.x + NODE_R + 6))
    label.setAttribute('y', String(pos.y + 4))
    label.textContent = node.label
    // Full text on hover: user messages truncated to 28 chars in the
    // label carry the raw first line here; a turn whose stopReason got
    // clipped surfaces the full reason. `<title>` inside an SVG `<g>`
    // yields the native browser tooltip without any extra scripting.
    if (node.title) {
      const titleEl = doc.createElementNS(SVG_NS, 'title')
      titleEl.textContent = node.title
      g.appendChild(titleEl)
    }
    g.appendChild(label)
    // Bind click on any node that carries an actionable identifier:
    // turn nodes → turnId, fork nodes → childSessionId, user nodes →
    // seq. Only these get the pointer cursor; nodes without a target
    // fall back to the default cursor so the affordance matches
    // reality.
    const actionable =
      (node.turnId) ||
      (node.kind === 'fork' && node.childSessionId) ||
      (node.kind === 'user' && node.seq)
    if (typeof snapshot?.onSelect === 'function' && actionable) {
      g.addEventListener('click', () => snapshot.onSelect(node))
      g.style && (g.style.cursor = 'pointer')
    } else if (g.style) {
      g.style.cursor = 'default'
    }
    svg.appendChild(g)
  }
  container.appendChild(svg)
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    deriveGraph,
    layoutGraph,
    renderSessionGraph,
    reorderEvents,
    _constants: { NODE_R, ROW_H, COL_W, PAD_X, PAD_Y },
  }
}
if (typeof window !== 'undefined') {
  window.__dshChatSessionGraph = {
    deriveGraph,
    layoutGraph,
    renderSessionGraph,
    reorderEvents,
  }
}

})()
