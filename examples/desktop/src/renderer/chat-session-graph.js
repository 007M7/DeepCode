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

// Derive nodes + edges from a cachedEvents list. Same event model as
// chat-side-drawer.deriveTurnRows so the two views agree.
function deriveGraph(events) {
  const nodes = []
  const edges = []
  if (!Array.isArray(events)) return { nodes, edges }
  let currentTurn = null
  let turnIdx = 0
  let lastNodeId = null
  for (const evt of events) {
    if (!evt || typeof evt !== 'object') continue
    const type = evt.type || evt.event || ''
    const data = evt.data || {}
    if (type === 'user/message') {
      const id = `u${nodes.length}`
      nodes.push({
        id, kind: 'user', label: 'user',
        turnId: null, seq: evt.seq || 0,
      })
      if (lastNodeId != null) edges.push({ from: lastNodeId, to: id, kind: 'succession' })
      lastNodeId = id
    } else if (type === 'turn/start' || type === 'turn.start') {
      const id = `t${turnIdx}`
      currentTurn = {
        id, kind: 'turn', label: `#${turnIdx}`,
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
      const stop = (data.stopReason || data.stop_reason || '').toString().toLowerCase()
      if (stop.includes('cancel') || stop.includes('interrupt') || stop.includes('reject')) {
        currentTurn.interrupted = true
      }
      if (currentTurn.interrupted) {
        currentTurn.kind = 'interrupt'
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
    _constants: { NODE_R, ROW_H, COL_W, PAD_X, PAD_Y },
  }
}
if (typeof window !== 'undefined') {
  window.__dshChatSessionGraph = {
    deriveGraph,
    layoutGraph,
    renderSessionGraph,
  }
}

})()
