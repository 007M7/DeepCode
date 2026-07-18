(function () {
// Pure helpers for the fork tree + context-injection UI. Kept framework-free
// and side-effect-free so both the renderer (via <script>) and the headless
// smoke test (via require) can consume the same logic.
//
// The three primitives:
//
//   buildSessionTree(entries)
//     Turn a flat list of session/list rows into a forest rooted at sessions
//     whose parentSession is undefined or not present in the list. Preserves
//     original entry order among siblings so the sidebar stays stable across
//     refreshes. Every returned node carries { entry, children, depth }.
//
//   classifyEvent(event)
//     Bucket a raw SessionEvent (see SessionEventMap in packages/core/session/
//     src/types.ts) into one of the surface categories the renderer draws:
//       - 'user' / 'assistant' / 'tool-call' / 'tool-result' / 'reasoning'
//         → the normal chat surface
//       - 'context-injection' → context/message + steering/message events
//         collapse into a system card
//       - 'compact-begin' / 'compact-end' / 'compact-summary' → the
//         "── context compacted ──" divider triple from packages/compact/
//       - 'turn-boundary' / 'step-boundary' / 'stream-chunk' → mostly muted
//       - 'header' / 'header-delta' → log-only request state
//       - 'other' → forward-compatibility catch-all for plugin-merged types
//
//   findChildForks(activeSessionId, allEntries)
//     Return the child sessions whose parentSession === activeSessionId, tagged
//     with the fork point seq (child.header.seedLength - 1, matching how
//     Session.create seeds the child; when seedLength is missing we fall back
//     to `null` so the UI can still render the marker at the top).
//
// None of these touch DOM, protocol, or timers; they take plain JSON and
// return plain JSON.

'use strict'

// -- classifyEvent -----------------------------------------------------------

const CONTEXT_INJECTION_TYPES = new Set([
  'context/message',
  'steering/message',
])

const COMPACT_TYPES = new Map([
  ['compact/start', 'compact-begin'],
  ['compact/summary', 'compact-summary'],
  ['compact/end', 'compact-end'],
])

const CHAT_TYPES = new Map([
  ['user/message', 'user'],
  ['assistant/message', 'assistant'],
  ['tool/call', 'tool-call'],
  ['tool/result', 'tool-result'],
])

/**
 * Bucket a session event by rendering intent. Returns null for events that
 * have no visual affordance (e.g. request/header-delta) so the caller can
 * simply skip them; returns 'other' for unknown types so plugin-merged events
 * still surface as a muted system line (mirroring the renderer's current
 * fallback behaviour).
 *
 * The event shape mirrors the wire notification: {type, seq, time, data}.
 */
function classifyEvent(event) {
  if (!event || typeof event.type !== 'string') return null
  const type = event.type
  if (CHAT_TYPES.has(type)) return CHAT_TYPES.get(type)
  if (CONTEXT_INJECTION_TYPES.has(type)) return 'context-injection'
  if (COMPACT_TYPES.has(type)) return COMPACT_TYPES.get(type)
  if (type === 'turn/start' || type === 'turn/end') return 'turn-boundary'
  if (type === 'step/start' || type === 'step/end') return 'step-boundary'
  if (type === 'assistant/chunk') return 'stream-chunk'
  if (type === 'todo/write') return 'todo'
  if (type === 'prompt/blocked') return 'blocked'
  if (type === 'request/header' || type === 'request/header-delta') return 'header'
  return 'other'
}

// -- buildSessionTree --------------------------------------------------------

/**
 * Extract the parent session id from a wire-shaped header. Ticket B (task
 * #124) audit found the wire ships `parentSession: { id: SessionId, seq:
 * number }`, not a bare string.
 * Old mocks used the bare string form and consumers happened to work by
 * accident — until a real daemon shipped the object shape and every
 * parent link silently broke. Accept both shapes so a rolling upgrade
 * doesn't strand old rows in the tree, but prefer the object form since
 * that is the wire truth.
 */
function parentIdOf(header) {
  const p = header && header.parentSession
  if (!p) return null
  if (typeof p === 'string') return p
  if (typeof p === 'object' && typeof p.id === 'string') return p.id
  return null
}

/**
 * Fold a flat list of SessionListEntry rows into a forest keyed by
 * parentSession. Rows with a parentSession that's absent from the input list
 * (deleted, foreign runtime, etc.) are treated as roots and get a synthetic
 * `orphaned: true` flag so the UI can surface it.
 *
 * The returned nodes are shaped `{ entry, children, depth, orphaned }`.
 * Sibling order is preserved from the input array; child order is the order
 * they were first seen in the input.
 */
function buildSessionTree(entries) {
  if (!Array.isArray(entries)) return []
  const byId = new Map()
  const roots = []
  const children = new Map() // parentId -> [entry]
  for (const entry of entries) {
    if (!entry || typeof entry.sessionId !== 'string') continue
    byId.set(entry.sessionId, entry)
  }
  for (const entry of entries) {
    if (!entry || typeof entry.sessionId !== 'string') continue
    const parent = parentIdOf(entry && entry.header)
    if (parent && byId.has(parent)) {
      if (!children.has(parent)) children.set(parent, [])
      children.get(parent).push(entry)
    } else {
      roots.push(entry)
    }
  }
  const materialize = (entry, depth) => {
    const kids = children.get(entry.sessionId) || []
    const parent = parentIdOf(entry && entry.header)
    const orphaned = !!parent && !byId.has(parent)
    return {
      entry,
      depth,
      orphaned,
      children: kids.map((k) => materialize(k, depth + 1)),
    }
  }
  return roots.map((r) => materialize(r, 0))
}

// -- findChildForks ----------------------------------------------------------

/**
 * Find every session that was forked from `parentSessionId`, tagged with the
 * seq at which the fork happened. The seed is a prefix of the parent's event
 * log, so `seedLength - 1` is the highest seq the child inherited. When
 * `seedLength` is missing (an older or synthetic entry), forkSeq is null and
 * the caller should place the marker at the top of the stream.
 */
function findChildForks(parentSessionId, entries) {
  if (!Array.isArray(entries) || !parentSessionId) return []
  const out = []
  for (const entry of entries) {
    // Wire shape is `parentSession: { id, seq }` (types.ts:44); unwrap `.id`
    // before comparing so real daemon rows link the same as legacy string
    // fixtures. See Ticket B §B-8.
    const parent = parentIdOf(entry && entry.header)
    if (parent !== parentSessionId) continue
    const seedLength = entry.header && typeof entry.header.seedLength === 'number'
      ? entry.header.seedLength
      : null
    out.push({
      childSessionId: entry.sessionId,
      childTitle: entry.title || '',
      forkSeq: seedLength === null ? null : Math.max(0, seedLength - 1),
      running: !!entry.running,
    })
  }
  return out
}

// -- forkChildLabel ------------------------------

/**
 * Build the display label for a fork/subagent child row in the session tree.
 *
 * The bug this fixes: fork children inherit the parent's `header.title` at
 * seed time (the daemon derives titles from the first user message, and a
 * fresh fork replays the parent's seedEvents which include that message).
 * Rendering the child's title verbatim produced rows that read as identical
 * duplicates of the parent — the user's live feedback was "不太看得懂".
 *
 * The fork POINT is the identity of a fork row, not the copied title. So the
 * label collapses to `<kind> @ seq <N> · <own signal>` where:
 *   - kind is "fork" for a user-initiated branch, "subagent" for a
 *     system-spawned child (header.originKind === 'subagent')
 *   - "own signal" is the child's title IF it differs from the parent's
 *     (the daemon updated it after a new user message landed in the child)
 *   - "(no new messages yet)" otherwise
 *
 * Returns { text, hasOwnMessage, forkSeq, kind } so the caller can also
 * stash flags for tooltip/aria copy without re-running the comparison.
 */
function forkChildLabel(childEntry, parentEntry, forkSeq) {
  const childTitle = normalizedTitle(childEntry)
  const parentTitle = normalizedTitle(parentEntry)
  const hasOwnMessage = !!childTitle && childTitle !== parentTitle
  const own = hasOwnMessage ? childTitle : '(no new messages yet)'
  const seq = typeof forkSeq === 'number' && forkSeq >= 0 ? forkSeq : null
  const kind = childEntry && childEntry.header && childEntry.header.originKind === 'subagent'
    ? 'subagent'
    : 'fork'
  const seqPart = seq === null ? kind : `${kind} @ seq ${seq}`
  return { text: `${seqPart} · ${own}`, hasOwnMessage, forkSeq: seq, kind }
}

/**
 * Pull the "real" title off an entry — the header mirror when the daemon set
 * one, otherwise entry.title, otherwise empty. Placeholder shapes (smoke-*
 * and the "(shortId)" fallback) collapse to empty so a placeholder never
 * counts as an own-message signal.
 */
function normalizedTitle(entry) {
  if (!entry) return ''
  const raw = (entry.header && typeof entry.header.title === 'string' && entry.header.title)
    || (typeof entry.title === 'string' && entry.title)
    || ''
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if (/^\(?smoke-/i.test(trimmed)) return ''
  if (typeof entry.sessionId === 'string' && trimmed === `(${entry.sessionId.slice(0, 8)})`) return ''
  return trimmed
}

// -- summary of a raw context/message injection ------------------------------

/**
 * Extract a one-line summary from a context/message event's ContentBlock
 * array so the collapsed card can show a hint of what was injected without
 * blowing up long payloads. Text blocks are concatenated (first 80 chars);
 * non-text blocks render as `[type]`.
 */
function summarizeContentBlocks(blocks, cap = 80) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    else if (b.type) parts.push(`[${b.type}]`)
  }
  const joined = parts.join(' ').replace(/\s+/g, ' ').trim()
  if (joined.length <= cap) return joined
  return joined.slice(0, cap - 1) + '…'
}

// -- classifySessionShape (M5 smartlog shape/role) --------------------------

/**
 * Reduce a session-list entry down to one of the five smartlog shapes and a
 * matching role token. Shapes are lifted from jj / git-branchless / ISL where
 * the goal is "you can tell what a row *is* at a glance without reading its
 * text". Discriminant priority, most-informative wins:
 *
 *   running turn        → '●'  role='running'   (green, pulses)
 *   interrupted/failed  → '✕'  role='interrupted'
 *   subagent origin     → '⇢'  role='subagent'  (system-spawned child)
 *   fork with a parent  → '⌘'  role='fork'      (user-branched child)
 *   otherwise           → '◇'  role='idle'      (root or dormant ancestor)
 *
 * Running wins over subagent/fork because "there is a turn in flight" is
 * strictly higher-value than "this row's ancestry". A running subagent still
 * gets its edge kind drawn on the connector — the shape encodes the *node*.
 */
function classifySessionShape(entry) {
  if (!entry || typeof entry !== 'object') {
    return { shape: '◇', role: 'idle' }
  }
  if (entry.running) return { shape: '●', role: 'running' }
  const header = entry.header || {}
  // Ticket B §B-4/B-5 (2026-07-16): the daemon never ships an
  // `interrupted` or `lastError` field on `SessionHeader` — those were
  // phantom reads that only fired against demo mocks. The wire signal is
  // the `SessionFinishedNotification.reason` (a `TurnEndReason` per
  // types.ts:94-120), which the renderer derives into `state.sessions.get
  // (id).lastError` and surfaces here as `entry.meta.lastError`.
  //
  // TurnEndReason.kind is one of `ok | cancelled | error | stopped`. Any
  // non-ok reason reads as `✕ interrupted` — B-4 (error) and B-5 (user
  // cancel) share the same visual affordance because "the run didn't
  // finish naturally" is the useful bit for the reader.
  const meta = entry.meta || {}
  const lastError = meta.lastError
  if (lastError && lastError.kind && lastError.kind !== 'ok') {
    return { shape: '✕', role: 'interrupted' }
  }
  const parent = header.parentSession
  if (parent && header.originKind === 'subagent') {
    return { shape: '⇢', role: 'subagent' }
  }
  if (parent) return { shape: '⌘', role: 'fork' }
  return { shape: '◇', role: 'idle' }
}

// -- partitionSmartlog (M2 noise collapse) ----------------------------------

/**
 * Split raw entries into what the smartlog draws inline vs what folds into a
 * "⋮ N dormant sessions" summary row. The rule is the M2 "only draw what
 * matters" pattern from git-branchless smartlog:
 *
 *   meaningful =
 *     titled (real user prompt) OR
 *     has a user message (hasUserMessage) OR
 *     has any descendant in the meaningful set (transitively)
 *
 *   dormant   = everything else (0-event untitled leaves, smoke fixtures)
 *
 * The transitive check keeps a titleless *root* alive when it has a titled
 * child — dropping it would strand the child. Roots without any live
 * descendants and without their own signal fold.
 */
function partitionSmartlog(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { meaningful: [], dormant: [] }
  }
  const byId = new Map()
  const childrenOf = new Map()
  for (const e of entries) {
    if (!e || typeof e.sessionId !== 'string') continue
    byId.set(e.sessionId, e)
  }
  for (const e of entries) {
    if (!e || typeof e.sessionId !== 'string') continue
    // Wire shape (types.ts:44): parentSession is `{ id, seq }`, not a bare
    // string. Unwrap `.id` before graph indexing so real daemon rows fold
    // into the transitive-meaningful set the same as legacy string mocks.
    const parent = parentIdOf(e.header)
    if (parent && byId.has(parent)) {
      if (!childrenOf.has(parent)) childrenOf.set(parent, [])
      childrenOf.get(parent).push(e)
    }
  }
  // Direct signal test — same shape as the sidebar's smartSessionTitle rule.
  // A row counts as "self-meaningful" if any of: a non-placeholder title,
  // hasUserMessage flag set, or eventCount > 0 (something happened here).
  function selfMeaningful(e) {
    const raw = typeof (e && e.title) === 'string' ? e.title.trim() : ''
    if (raw && !/^\(?smoke-/i.test(raw) && !/^\([0-9a-f]{4,16}\)$/i.test(raw)) return true
    if (e && e.hasUserMessage === true) return true
    if (e && typeof e.eventCount === 'number' && e.eventCount > 0) return true
    return false
  }
  // Transitive close: a row is meaningful if any node in its connected tree
  // (self, ancestors, or descendants) is self-meaningful. That way a titled
  // child pulls its titleless parent into the log (or the child would be
  // orphaned), and a titled parent pulls its titleless children too (they're
  // still real branches of a real conversation, worth showing).
  //
  // Implementation: find the root of each entry's tree, propagate any
  // self-meaningful bit up to the root, then propagate down. Same effect
  // as union-find with a "has meaningful descendant" marker.
  const isMeaningful = new Map()
  function rootOf(id) {
    let cur = id
    let guard = 0
    while (guard < 64) {
      const e = byId.get(cur)
      // Same wire-shape unwrap as above; rootOf must climb via the object
      // form for real daemons but stay compatible with string fixtures.
      const p = parentIdOf(e && e.header)
      if (p && byId.has(p)) { cur = p; guard += 1; continue }
      return cur
    }
    return cur
  }
  // First pass: gather self-meaningful bits at each root.
  const rootMeaningful = new Map()
  for (const e of entries) {
    if (!e || typeof e.sessionId !== 'string') continue
    if (selfMeaningful(e)) rootMeaningful.set(rootOf(e.sessionId), true)
  }
  // Second pass: an entry is meaningful iff its root is meaningful. This is
  // strong enough to cover both the "titled parent → include titleless
  // children" and "titled child → include titleless ancestor" cases.
  for (const e of entries) {
    if (!e || typeof e.sessionId !== 'string') continue
    isMeaningful.set(e.sessionId, !!rootMeaningful.get(rootOf(e.sessionId)))
  }
  const meaningfulList = []
  const dormantList = []
  for (const e of entries) {
    if (!e || typeof e.sessionId !== 'string') continue
    if (isMeaningful.get(e.sessionId)) meaningfulList.push(e)
    else dormantList.push(e)
  }
  return { meaningful: meaningfulList, dormant: dormantList }
}

// -- layoutSmartlogRows (M1 rail lane assignment) ---------------------------

/**
 * Walk a forest (as produced by buildSessionTree) in smartlog order and
 * assign each row a `lane` (rail-column index) plus its `parentLane`. Lanes
 * are integers ≥ 0. The renderer draws a persistent 16-20px vertical rail
 * per lane, and a curve from (parentLane, parentRow) to (lane, thisRow) for
 * every non-root row.
 *
 * Ordering: for each parent, children are visited in `lastEventTime` desc
 * order (most-recent first) so the "live" branch reads as the trunk and
 * older siblings peel off to the right. Roots are ordered by recency too so
 * the freshest tree floats to the top of the log.
 *
 * Lane assignment (greedy, ISL-style):
 *   - The first child of a parent inherits the parent's lane (trunk).
 *   - Additional siblings claim a new lane — the lowest lane not currently
 *     occupied by any row on the stack, or a fresh one if none free.
 *   - When a subtree ends, its lane is released and can be reused by a later
 *     sibling. This is what keeps the picture narrow in the common case
 *     (many forks over time, not many concurrent forks).
 *
 * Output is a flat array with elements shaped:
 *   { entry, depth, lane, parentLane|null, orphaned, children? }
 * We deliberately drop `children` (the renderer doesn't need it after flat
 * layout) so views can iterate once.
 */
function layoutSmartlogRows(forest) {
  if (!Array.isArray(forest) || forest.length === 0) return []
  const roots = forest.slice().sort(byRecencyDesc)
  const rows = []
  // Lanes currently held by open subtrees on the DFS stack. Two flavours:
  //   - a "branched" lane (new column for this row) — releases on exit
  //   - an "inherited" lane (row rides its parent's lane) — release is
  //     the parent's job
  // Roots always branch (parent's lane is null) and always release, so a
  // fully-processed root frees up lane 0 for the next root — sequential
  // leaf roots stack on the same rail, matching the smartlog convention.
  const occupied = new Set()
  function nextFreeLane() {
    let l = 0
    while (occupied.has(l)) l += 1
    return l
  }
  // `visit(node, parentLane, inherit)`:
  //   - `inherit=true` means this node keeps its parent's lane (only-child
  //     of a parent whose sole descendant it is). It does NOT release on
  //     exit — the parent will.
  //   - `inherit=false` means it branches to a fresh lane, which it releases
  //     on exit so later siblings can reuse the column.
  function visit(node, parentLane, inherit) {
    let lane
    if (inherit && parentLane !== null) {
      lane = parentLane
    } else {
      lane = nextFreeLane()
      occupied.add(lane)
    }
    rows.push({
      entry: node.entry,
      depth: node.depth,
      lane,
      parentLane,
      orphaned: !!node.orphaned,
    })
    const children = Array.isArray(node.children) ? node.children.slice().sort(byRecencyDesc) : []
    // Only-child inherits the parent's lane so the trunk reads as one
    // continuous column. Multi-child siblings all branch to fresh lanes.
    const onlyChild = children.length === 1
    for (let i = 0; i < children.length; i += 1) {
      visit(children[i], lane, onlyChild)
    }
    // Release rules:
    //   - inherited lane: parent still owns it → we don't touch.
    //   - branched lane whose subtree has children: it extended down, so the
    //     column was visibly used and we release only on exit (Set.delete).
    //   - root or non-root with no descendants: same delete; a later peer
    //     can reuse the column immediately (three sequential leaf roots
    //     stack on lane 0 rather than fanning out to 0/1/2, which reads
    //     as "these are unrelated one-shots" not "three concurrent tasks").
    if (!inherit) occupied.delete(lane)
  }
  for (const root of roots) visit(root, null, false)
  return rows
}

function byRecencyDesc(a, b) {
  const ta = (a && a.entry && a.entry.lastEventTime) || 0
  const tb = (b && b.entry && b.entry.lastEventTime) || 0
  return tb - ta
}

// -- CJS + global export -----------------------------------------------------

const api = {
  buildSessionTree,
  classifyEvent,
  findChildForks,
  forkChildLabel,
  normalizedTitle,
  summarizeContentBlocks,
  classifySessionShape,
  partitionSmartlog,
  layoutSmartlogRows,
}
if (typeof module !== 'undefined' && module.exports) module.exports = api
if (typeof globalThis !== 'undefined') globalThis.SessionTree = api
})()
