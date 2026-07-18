(function () {
// Pure data model for Mission Control — the long-running task management
// view. All three subviews (tree / topology / board) read from the same
// in-memory aggregate that this module maintains. Keeping it framework-free
// and side-effect-free means the smoke test and node:test suites can drive
// the same reducers the renderer uses.
//
// Wire inputs (all already flowing through renderer.js):
//   - session/list snapshot: array of SessionListEntry (title / running /
//     lastEventTime / header.parentSession / header.seedLength).
//   - `session.event` notifications: { sessionId, event } with the
//     SessionEventMap types.
//   - `subagent.started` / `subagent.finished` notifications: parent/child
//     ids + status.
//
// The model exposes three surfaces:
//   applySessionList(state, entries)        — swap in the current server truth.
//   applyEvent(state, sessionId, event)     — increment counters, update tail.
//   applySubagentEdge(state, edge)          — record a parent→child edge.
//
//   projectTreeRows(state)                  — flat rows for the tree view.
//   projectTopology(state, opts)            — layered DAG layout (nodes+edges).
//   projectBoard(state)                     — kanban buckets over todo state.
//   projectSummary(state)                   — top-of-view aggregate stats.
//   projectTicker(state, n)                 — the last N cross-session events.
//
// No DOM, no protocol, no timers. Every mutation is a shallow reassignment or
// a Map/Set update on the passed-in state; consumers keep one instance for
// the life of the UI. See mission-controller.js for the wiring.

'use strict'

// -- state shape -------------------------------------------------------------

/**
 * Build an empty mission-model state. Consumers should hold one of these for
 * the lifetime of the UI and feed it through applyX / projectX.
 *
 * `sessions` maps sessionId → session record. Records carry a running flag,
 * the last-known title, a total event count, per-type counters (tool call
 * count, assistant messages, etc.), the last event timestamp, the latest
 * todo list snapshot (if any), and the parent link. Everything is derived
 * from the wire; no invented fields.
 */
function createMissionState() {
  return {
    sessions: new Map(),
    // parent → Set(child) mirror of subagent edges (also present as
    // header.parentSession on the child); kept explicitly so live
    // subagent.started notifications grow the graph before session/list
    // catches up.
    edges: new Map(),
    // A bounded ring of the most recent notification-visible events across
    // all sessions. Newest first; capped at MAX_TICKER.
    ticker: [],
  }
}

const MAX_TICKER = 32
const MAX_EVENT_COUNTERS = 6 // running window for activity sparkline

function ensureSession(state, sessionId) {
  let s = state.sessions.get(sessionId)
  if (!s) {
    s = {
      sessionId,
      title: '',
      running: false,
      parentSession: null,
      seedLength: null,
      lastEventTime: 0,
      firstSeenTime: Date.now(),
      eventCount: 0,
      toolCallCount: 0,
      assistantMessageCount: 0,
      userMessageCount: 0,
      lastEventType: null,
      lastEventSummary: '',
      // Whole-list todo snapshot from the latest todo/write event.
      todos: null,
      // Whole-list snapshot of write-tool file paths seen on this session.
      writes: [],
      // Rolling activity window: array of {t, count} buckets. Simple 1s
      // buckets are enough for the visualization we need.
      activity: [],
      // model / other metadata, opportunistically captured from
      // request/header events. Absent until observed.
      model: null,
    }
    state.sessions.set(sessionId, s)
  }
  return s
}

// -- reducers ----------------------------------------------------------------

/**
 * Replace the session catalogue with a session/list snapshot. Existing
 * per-session counters are preserved — the server is authoritative about
 * membership + top-level metadata, but the counters we accumulate live only
 * in this module.
 */
function applySessionList(state, entries) {
  if (!Array.isArray(entries)) return state
  const seen = new Set()
  for (const entry of entries) {
    if (!entry || typeof entry.sessionId !== 'string') continue
    const s = ensureSession(state, entry.sessionId)
    s.title = entry.title || s.title
    s.running = !!entry.running
    if (typeof entry.lastEventTime === 'number' && entry.lastEventTime > s.lastEventTime) {
      s.lastEventTime = entry.lastEventTime
    }
    // Forward the wire-side eventCount. Persisted rows never fire applyEvent
    // in this module, so without this adoption the tree/topo/summary would
    // show `0 ev` for every persisted session after a daemon restart. Server
    // is authoritative between snapshots; applyEvent takes over incremental
    // updates. Guarded so older daemon builds (no eventCount field) preserve
    // the last known value rather than clobbering with 0.
    if (typeof entry.eventCount === 'number') s.eventCount = entry.eventCount
    const parent = entry.header && entry.header.parentSession
    if (parent) {
      s.parentSession = parent
      if (!state.edges.has(parent)) state.edges.set(parent, new Set())
      state.edges.get(parent).add(entry.sessionId)
    }
    const seed = entry.header && entry.header.seedLength
    if (typeof seed === 'number') s.seedLength = seed
    seen.add(entry.sessionId)
  }
  // Drop stale sessions: only sessions that vanished from the server AND
  // aren't referenced by an in-flight subagent edge. Keeping edges alive
  // avoids the topology view thrashing when a child session finishes before
  // its next list refresh lands.
  for (const [id, s] of state.sessions) {
    if (seen.has(id)) continue
    const isReferenced = s.parentSession && state.sessions.has(s.parentSession)
    if (!isReferenced) state.sessions.delete(id)
  }
  return state
}

/**
 * Fold one session/event notification into the state. Only fields we
 * actually surface get counted (tool calls, assistant/user messages, todo
 * snapshots, write-tool paths, running flag). Unknown types still bump the
 * generic event counter and refresh lastEventTime so the tree/topo can show
 * an "active" pulse. The ticker keeps a bounded ring of the most recent
 * events across sessions.
 */
function applyEvent(state, sessionId, event) {
  if (!event || typeof event.type !== 'string' || !sessionId) return state
  const s = ensureSession(state, sessionId)
  s.eventCount += 1
  s.lastEventType = event.type
  const now = typeof event.time === 'number' && event.time > 0
    ? event.time
    : Date.now()
  if (now > s.lastEventTime) s.lastEventTime = now
  updateActivity(s, now)

  const data = event.data || event
  switch (event.type) {
    case 'turn/start':
      s.running = true
      s.lastEventSummary = 'turn started'
      break
    case 'turn/end':
      s.running = false
      s.lastEventSummary = `turn ended${data && data.reason && data.reason.kind ? ' — ' + data.reason.kind : ''}`
      break
    case 'user/message': {
      s.userMessageCount += 1
      const t = extractText(data.content)
      s.lastEventSummary = 'user: ' + clip(t, 60)
      break
    }
    case 'assistant/message': {
      s.assistantMessageCount += 1
      const t = extractText(data.content)
      s.lastEventSummary = 'assistant: ' + clip(t, 60)
      break
    }
    case 'tool/call': {
      s.toolCallCount += 1
      const name = data.name || 'tool'
      s.lastEventSummary = `tool: ${name}`
      const path = extractWritePath(data)
      if (path) recordWrite(s, path, sessionId)
      break
    }
    case 'tool/result': {
      const errored = !!data.isError
      s.lastEventSummary = errored ? 'tool result: error' : 'tool result'
      break
    }
    case 'todo/write': {
      // The whole list is authoritative; last write wins.
      if (data && Array.isArray(data.todos)) s.todos = data.todos.slice()
      s.lastEventSummary = data && Array.isArray(data.todos)
        ? `todo update (${data.todos.length})`
        : 'todo update'
      break
    }
    case 'request/header': {
      const h = data && data.header
      if (h && h.config && typeof h.config.model === 'string') s.model = h.config.model
      s.lastEventSummary = 'request/header'
      break
    }
    case 'context/message':
    case 'steering/message': {
      const t = extractText(data.content)
      s.lastEventSummary = event.type + ': ' + clip(t, 60)
      break
    }
    default:
      s.lastEventSummary = event.type
  }

  pushTicker(state, {
    time: now,
    sessionId,
    sessionTitle: s.title || sessionId.slice(0, 8),
    type: event.type,
    summary: s.lastEventSummary,
  })
  return state
}

/**
 * Record a subagent parent→child edge. Called by subagent.started; keeps
 * the topology alive even before the next session/list snapshot arrives.
 * `status` is 'started' / 'finished'; finished flips the child's running
 * flag but does NOT drop the edge (the tree/topo want to keep showing it).
 */
function applySubagentEdge(state, { parentSessionId, childSessionId, status }) {
  if (!parentSessionId || !childSessionId) return state
  const parent = ensureSession(state, parentSessionId)
  const child = ensureSession(state, childSessionId)
  if (!child.parentSession) child.parentSession = parentSessionId
  if (!state.edges.has(parentSessionId)) state.edges.set(parentSessionId, new Set())
  state.edges.get(parentSessionId).add(childSessionId)
  if (status === 'finished') child.running = false
  else if (status === 'started') child.running = true
  parent.lastEventTime = Math.max(parent.lastEventTime, Date.now())
  return state
}

// -- projections -------------------------------------------------------------

/**
 * Flat, depth-annotated rows for the tree view. Roots first (sorted by
 * lastEventTime desc so recently active work floats up), children preserve
 * insertion order under each parent. Each row is a plain object; the DOM
 * layer chooses how to render.
 */
function projectTreeRows(state) {
  const rows = []
  const byId = state.sessions
  // A root is any session whose parent is unknown to us — including the
  // orphan case where the parent is set but missing from the map.
  const isRoot = (s) => !s.parentSession || !byId.has(s.parentSession)
  const roots = Array.from(byId.values()).filter(isRoot)
  roots.sort((a, b) => (b.lastEventTime || 0) - (a.lastEventTime || 0))
  const childrenOf = (id) => {
    const kids = state.edges.get(id)
    if (!kids) return []
    // Sort children by lastEventTime asc so oldest sits at top of the
    // subtree (chronological reading order for spawn cascades).
    return Array.from(kids)
      .filter((cid) => byId.has(cid))
      .map((cid) => byId.get(cid))
      .sort((a, b) => (a.lastEventTime || 0) - (b.lastEventTime || 0))
  }
  const walk = (s, depth) => {
    rows.push({
      sessionId: s.sessionId,
      title: s.title || s.sessionId.slice(0, 8),
      depth,
      running: !!s.running,
      lastEventTime: s.lastEventTime,
      lastEventType: s.lastEventType,
      lastEventSummary: s.lastEventSummary,
      eventCount: s.eventCount,
      toolCallCount: s.toolCallCount,
      todoCount: s.todos ? s.todos.length : 0,
      orphan: !!s.parentSession && !byId.has(s.parentSession),
      hasChildren: !!(state.edges.get(s.sessionId) && state.edges.get(s.sessionId).size > 0),
      model: s.model,
    })
    for (const kid of childrenOf(s.sessionId)) walk(kid, depth + 1)
  }
  for (const r of roots) walk(r, 0)
  return rows
}

/**
 * Layered DAG layout for the topology view. Simple hand-rolled algorithm
 * (Sugiyama-lite): rank = depth from a root, x = balanced tree position by
 * subtree width. Returns { nodes, edges } with pixel-space coordinates in
 * the [0..1] × [0..1] range; the renderer scales to the SVG viewport.
 *
 * opts.padding — [0..1) fraction of margin around the node grid (default 0.05).
 * opts.orientation — 'vertical' (default) puts roots at top, or 'horizontal'.
 */
function projectTopology(state, opts) {
  const options = opts || {}
  const padding = typeof options.padding === 'number' ? options.padding : 0.05
  const orientation = options.orientation === 'horizontal' ? 'horizontal' : 'vertical'
  const byId = state.sessions
  const ranks = new Map() // sessionId -> rank
  const isRoot = (s) => !s.parentSession || !byId.has(s.parentSession)
  const allRoots = Array.from(byId.values()).filter(isRoot)
  // A topology is a picture of RELATIONSHIPS. Roots with no children carry
  // none — 50+ smoke sessions once each claimed a lane and their labels
  // smeared into an unreadable band. Only linked structure gets drawn;
  // childless roots collapse into one aggregate capsule the view renders
  // as "N unlinked sessions".
  const hasKids = (s) => {
    const kids = state.edges.get(s.sessionId)
    if (!kids) return false
    for (const cid of kids) if (byId.has(cid)) return true
    return false
  }
  const roots = allRoots.filter(hasKids)
  const unlinked = allRoots.filter((s) => !hasKids(s))
  // BFS from every root to assign ranks; if the graph has cycles (it won't
  // in practice — parent is a strict tree — but we defend), later hits keep
  // the smaller rank.
  const queue = []
  for (const r of roots) { ranks.set(r.sessionId, 0); queue.push(r.sessionId) }
  while (queue.length > 0) {
    const id = queue.shift()
    const rank = ranks.get(id)
    const children = state.edges.get(id)
    if (!children) continue
    for (const cid of children) {
      if (!byId.has(cid)) continue
      if (!ranks.has(cid) || ranks.get(cid) > rank + 1) {
        ranks.set(cid, rank + 1)
        queue.push(cid)
      }
    }
  }
  // Compute subtree widths so we can position sibling groups. Width is the
  // number of leaves in the subtree (or 1 for a leaf).
  const subtreeWidth = new Map()
  const computeWidth = (id) => {
    if (subtreeWidth.has(id)) return subtreeWidth.get(id)
    const kids = state.edges.get(id)
    if (!kids || kids.size === 0) { subtreeWidth.set(id, 1); return 1 }
    let w = 0
    for (const cid of kids) {
      if (!byId.has(cid)) continue
      w += computeWidth(cid)
    }
    if (w === 0) w = 1
    subtreeWidth.set(id, w)
    return w
  }
  let totalWidth = 0
  for (const r of roots) totalWidth += computeWidth(r.sessionId)
  if (totalWidth === 0) totalWidth = 1
  const maxRank = Array.from(ranks.values()).reduce((a, b) => Math.max(a, b), 0)
  // Position each node in [padding, 1-padding] on both axes; the "main"
  // axis is rank (y for vertical, x for horizontal), the "cross" axis is
  // in-rank offset (x for vertical, y for horizontal).
  const nodes = []
  const positions = new Map()
  const layoutRoot = (id, xStart, xEnd, depth) => {
    const w = computeWidth(id)
    const cx = (xStart + xEnd) / 2
    const rankFrac = maxRank === 0 ? 0 : depth / maxRank
    const cross = padding + cx * (1 - 2 * padding)
    const main = padding + rankFrac * (1 - 2 * padding)
    const x = orientation === 'vertical' ? cross : main
    const y = orientation === 'vertical' ? main : cross
    positions.set(id, { x, y })
    const s = byId.get(id)
    if (s) nodes.push({
      sessionId: id,
      x, y,
      rank: depth,
      running: !!s.running,
      title: s.title || id.slice(0, 8),
      model: s.model || null,
      eventCount: s.eventCount,
      lastEventTime: s.lastEventTime,
      lastEventSummary: s.lastEventSummary,
    })
    const kids = state.edges.get(id)
    if (!kids || kids.size === 0) return
    let acc = xStart
    // Preserve child order: sort by lastEventTime asc so oldest child sits
    // leftmost for vertical, topmost for horizontal.
    const orderedKids = Array.from(kids)
      .filter((cid) => byId.has(cid))
      .map((cid) => ({ cid, t: byId.get(cid).lastEventTime || 0 }))
      .sort((a, b) => a.t - b.t)
      .map((o) => o.cid)
    for (const cid of orderedKids) {
      const cw = computeWidth(cid)
      const span = ((xEnd - xStart) * cw) / (w || 1)
      layoutRoot(cid, acc, acc + span, depth + 1)
      acc += span
    }
  }
  // Divide the [0..1] cross axis among the roots by subtree width.
  {
    let acc = 0
    for (const r of roots) {
      const w = computeWidth(r.sessionId)
      const span = w / totalWidth
      layoutRoot(r.sessionId, acc, acc + span, 0)
      acc += span
    }
  }
  const edges = []
  for (const [pid, kids] of state.edges) {
    if (!byId.has(pid)) continue
    for (const cid of kids) {
      if (!byId.has(cid)) continue
      const from = positions.get(pid)
      const to = positions.get(cid)
      if (!from || !to) continue
      const child = byId.get(cid)
      edges.push({
        from: pid, to: cid,
        fromX: from.x, fromY: from.y,
        toX: to.x, toY: to.y,
        // "Active" edge: parent running or child running or child recent.
        active: !!(child.running || byId.get(pid).running),
      })
    }
  }
  return {
    nodes, edges, orientation,
    // Childless roots the layout intentionally skipped: the view shows one
    // capsule ("N unlinked sessions") instead of N overlapping lanes.
    unlinked: unlinked.map((s) => ({
      sessionId: s.sessionId,
      title: s.title || s.sessionId.slice(0, 8),
      running: !!s.running,
      lastEventTime: s.lastEventTime,
    })),
  }
}

/**
 * Kanban projection: fold each session's latest todos into three buckets.
 * Order within a bucket preserves the todo's index in its source list (so
 * a session's "first pending" stays first). Sessions with no todos are
 * omitted entirely — per the brief.
 */
function projectBoard(state) {
  const buckets = { pending: [], in_progress: [], completed: [] }
  for (const [id, s] of state.sessions) {
    if (!s.todos || s.todos.length === 0) continue
    s.todos.forEach((todo, idx) => {
      if (!todo || typeof todo.content !== 'string') return
      const status = todo.status === 'in_progress'
        ? 'in_progress'
        : todo.status === 'completed' ? 'completed' : 'pending'
      buckets[status].push({
        sessionId: id,
        sessionTitle: s.title || id.slice(0, 8),
        content: todo.content,
        status,
        index: idx,
      })
    })
  }
  // Sort each bucket by (sessionTitle, index) so a session's todos stay
  // grouped visually.
  for (const key of Object.keys(buckets)) {
    buckets[key].sort((a, b) => {
      const t = a.sessionTitle.localeCompare(b.sessionTitle)
      if (t !== 0) return t
      return a.index - b.index
    })
  }
  return buckets
}

/**
 * Top-of-view aggregate. Counts today's events (defined as events with
 * lastEventTime after `sinceMs`, or since local midnight if not supplied).
 * Callers pass sinceMs=0 for lifetime totals in the demo path.
 */
function projectSummary(state, sinceMs) {
  const cutoff = typeof sinceMs === 'number' ? sinceMs : startOfDayMs()
  let total = 0
  let running = 0
  let events = 0
  let toolCalls = 0
  let todosPending = 0
  let todosInProgress = 0
  for (const s of state.sessions.values()) {
    total += 1
    if (s.running) running += 1
    events += s.eventCount
    toolCalls += s.toolCallCount
    if (s.todos) {
      for (const t of s.todos) {
        if (!t) continue
        if (t.status === 'pending') todosPending += 1
        else if (t.status === 'in_progress') todosInProgress += 1
      }
    }
  }
  // Recent-events count = ticker entries newer than cutoff. The ticker is
  // capped at MAX_TICKER, so this is bounded and cheap.
  let recent = 0
  for (const t of state.ticker) if (t.time >= cutoff) recent += 1
  return {
    totalSessions: total,
    runningSessions: running,
    totalEvents: events,
    totalToolCalls: toolCalls,
    todosPending,
    todosInProgress,
    recentEvents: recent,
    since: cutoff,
  }
}

/**
 * The last N ticker entries, newest-first. Callers render these as a
 * scrolling status line at the top of the Mission view.
 */
function projectTicker(state, n) {
  const cap = typeof n === 'number' && n > 0 ? n : 10
  return state.ticker.slice(0, cap)
}

// -- helpers -----------------------------------------------------------------

function extractText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join(' ')
    .trim()
}

function clip(s, cap) {
  if (typeof s !== 'string' || s.length <= cap) return s || ''
  return s.slice(0, cap - 1) + '…'
}

function pushTicker(state, entry) {
  state.ticker.unshift(entry)
  if (state.ticker.length > MAX_TICKER) state.ticker.length = MAX_TICKER
}

function updateActivity(s, tMs) {
  const bucket = Math.floor(tMs / 1000)
  const last = s.activity[s.activity.length - 1]
  if (last && last.bucket === bucket) {
    last.count += 1
  } else {
    s.activity.push({ bucket, count: 1 })
    if (s.activity.length > MAX_EVENT_COUNTERS) s.activity.shift()
  }
}

// Extract a filesystem write path from a tool/call's argument string.
// Falls back to null if the args don't parse or don't name a file path.
// This lets the mission view keep a per-session "files touched" trace
// alongside the todo board — useful when a coding-agent turn edits several
// files across a plan.
function extractWritePath(data) {
  if (!data) return null
  const name = String(data.name || '')
  const args = data.arguments
  if (!name) return null
  if (!/^(edit|write|create_file|apply_patch|str_replace|patch|multi_?edit|update_file)/i.test(name)) return null
  if (typeof args !== 'string') return null
  try {
    const parsed = JSON.parse(args)
    const p = parsed && (parsed.path || parsed.file_path || parsed.filePath || parsed.filename)
    return typeof p === 'string' ? p : null
  } catch { return null }
}

function recordWrite(s, path, sessionId) {
  if (!path) return
  if (s.writes.includes(path)) return
  s.writes.push(path)
  if (s.writes.length > 20) s.writes.shift()
  void sessionId
}

function startOfDayMs() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// -- exports -----------------------------------------------------------------

const api = {
  createMissionState,
  applySessionList,
  applyEvent,
  applySubagentEdge,
  projectTreeRows,
  projectTopology,
  projectBoard,
  projectSummary,
  projectTicker,
  // Constants exposed for the DOM layer + tests.
  MAX_TICKER,
}
if (typeof module !== 'undefined' && module.exports) module.exports = api
if (typeof globalThis !== 'undefined') globalThis.MissionModel = api
})()
