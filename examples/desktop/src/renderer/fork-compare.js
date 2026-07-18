// fork side-by-side compare drawer.
//
// Called from edit-rerun-header + tool-edit-rerun on a successful fork.
// Opens a two-column read-only compare of (parentSession, childSession)
// with a header badge that names the origin: "来源：#parent @ seq N ·
// source=<config|tool>".
//
// Grammar
// -------
// Reuses the `.playground-compare-drawer` layout (drawer-head + drawer-body
// with two `.compare-col` streams) so a researcher who's seen the
// Playground compare surface reads this one instantly. Not the same DOM —
// this drawer has its own root id (`fork-compare-drawer`) so it can be
// opened over the current pane no matter which pane is active.
//
// Downgrade honesty
// -----------------
// The drawer paints from `session/events` snapshots; live events after
// open require a Refresh button. Live subscription would need coupling
// to onSessionEvent inside renderer.js, which is out of scope for this
// ticket. The Refresh button is one click and cheap.
//
// Contract
// --------
// openForkCompare({parentId, childId, seq?, source?}) -> void
//   Ensures the drawer exists in the DOM (creates on first open), fetches
//   both sides' events, paints, and unhides the drawer.
// closeForkCompare() -> void
//
// Exported CommonJS + window.__dshForkCompare.

'use strict'

;(function () {

const SOURCE_LABELS = {
  config: 'edited config',
  tool: 'edited tool args',
  header: 'edited config', // alias
  'tool-args': 'edited tool args', // alias
}

let cached = null // { root, badge, leftTitle, rightTitle, leftStream, rightStream, closeBtn, refreshBtn }
let lastArgs = null // remember (parentId, childId, seq, source) so Refresh works
let escBound = false // document-level Escape listener installed once
let gestureBound = false // user-gesture watcher installed once
let lastUserGestureAt = 0 // Date.now() of most recent trusted pointer/key
let BOOT_AT = (typeof Date !== 'undefined') ? Date.now() : 0
// User-gesture window: only allow openForkCompare when the last trusted
// pointer/key event landed within this many ms. Wider than a click round-
// trip but shorter than a re-focus after switching windows.
const GESTURE_WINDOW_MS = 5000
// Boot-quiet window: reject every open call in the first N ms after
// renderer boot, no matter what. Nothing legitimate opens a full-screen
// overlay this early; if we didn't have this a stale queued microtask
// could still slip past the gesture check.
const BOOT_QUIET_MS = 2000

function ensureGestureWatcher() {
  if (gestureBound) return
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return
  gestureBound = true
  const bump = function (e) {
    // `isTrusted` distinguishes real user input from dispatchEvent replay.
    // Tests fire synthetic events without isTrusted; guard treats absence
    // as "assume trusted" only when running under node/no-navigator (tests).
    const trusted = (e && typeof e.isTrusted === 'boolean') ? e.isTrusted : true
    if (!trusted) return
    lastUserGestureAt = Date.now()
  }
  document.addEventListener('pointerdown', bump, true)
  document.addEventListener('keydown', bump, true)
}

// Exposed for the qa-harness/tests: allow explicit gesture stamping so
// programmatic openForkCompare from inside a user-clicked button handler
// (mock-fork-compare) survives even if the click event pre-dated the
// watcher install (renderer boot race).
function markUserGesture() {
  lastUserGestureAt = Date.now()
}

function openForkCompare(opts) {
  const { parentId, childId, seq, source } = opts || {}
  if (!parentId || !childId) return
  // Bug D guard (2026-07-18): Never open a full-screen overlay while the
  // renderer is replaying a session's event log — replay is a projection
  // of persisted events, not a user action.  A stale mock-fork-compare
  // click that landed in a session's log would otherwise re-open on every
  // window boot ("擦不掉了" report).  The `state.replayingId` flag lives
  // on `window.__dshRenderer` for renderer.js visibility.
  const R = typeof window !== 'undefined' ? window.__dshRenderer : null
  if (R && R.state && R.state.replayingId) return
  // Bug D guard L4: openForkCompare is
  // only allowed off a recent user gesture. This defends against every
  // still-unknown auto-open path (queued mock click, driver hook residue,
  // future auto-scroll code accidentally invoking the fork bridge). The
  // legitimate call sites (mock-fork-compare button, edit-rerun buttons)
  // are all inside real click handlers so the gesture window is fresh.
  ensureGestureWatcher()
  const now = Date.now()
  const bootAgeMs = now - BOOT_AT
  const gestureAgeMs = now - lastUserGestureAt
  if (bootAgeMs < BOOT_QUIET_MS) {
    // eslint-disable-next-line no-console
    console.warn('[fork-compare] blocked auto-open during boot-quiet window (', bootAgeMs, 'ms since boot)')
    return { blocked: 'boot-quiet' }
  }
  if (lastUserGestureAt === 0 || gestureAgeMs > GESTURE_WINDOW_MS) {
    // eslint-disable-next-line no-console
    console.warn('[fork-compare] blocked open — no recent user gesture (last=', lastUserGestureAt, ')')
    return { blocked: 'no-gesture' }
  }
  lastArgs = { parentId, childId, seq, source }
  const doc = typeof document !== 'undefined' ? document : null
  if (!doc) return
  const els = ensureDrawer(doc)
  els.badge.textContent = buildBadgeText({ parentId, childId, seq, source })
  els.leftTitle.textContent = `Parent · ${short(parentId)}`
  els.rightTitle.textContent = `Fork · ${short(childId)}`
  els.leftStream.innerHTML = ''
  els.rightStream.innerHTML = ''
  appendMeta(els.leftStream, 'loading…')
  appendMeta(els.rightStream, 'loading…')
  els.root.hidden = false
  ensureEscListener(doc)
  // Best-effort fetch; if either side fails we surface the error inline.
  void hydrate(els, parentId, childId, seq)
}

function closeForkCompare() {
  if (cached && cached.root) cached.root.hidden = true
}

function ensureEscListener(doc) {
  if (escBound) return
  if (typeof doc.addEventListener !== 'function') return
  escBound = true
  doc.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' && e.keyCode !== 27) return
    if (!cached || !cached.root || cached.root.hidden) return
    closeForkCompare()
    if (typeof e.stopPropagation === 'function') e.stopPropagation()
  })
}

function buildBadgeText({ parentId, childId, seq, source }) {
  const parts = []
  parts.push(`Fork of ${short(parentId)} → ${short(childId)}`)
  if (typeof seq === 'number') parts.push(`@ seq ${seq}`)
  const label = source ? (SOURCE_LABELS[source] || source) : null
  if (label) parts.push(`source: ${label}`)
  return parts.join(' · ')
}

function short(id) {
  if (typeof id !== 'string') return ''
  return id.length > 10 ? id.slice(0, 8) + '…' : id
}

async function hydrate(els, parentId, childId, seq) {
  const bridge = getBridge()
  if (!bridge) {
    els.leftStream.innerHTML = ''
    els.rightStream.innerHTML = ''
    appendMeta(els.leftStream, 'no session/events bridge available.')
    appendMeta(els.rightStream, 'no session/events bridge available.')
    return
  }
  // Left column: parent up to and including `seq` (inclusive), so the reader
  // sees exactly the state the fork inherited.
  //
  // seq-less events (typeof e.seq !== 'number') deliberately survive BOTH
  // column filters and render on both sides — with no seq we cannot place
  // them relative to the boundary, and dropping them would silently hide
  // wire content (violates the zero-drop rule). Dual-column display is the
  // honest fallback: the reader sees the event exists but that its position
  // relative to the fork is undetermined. If a future event type carries
  // reliable ordering metadata other than seq, tighten this filter first.
  els.leftStream.innerHTML = ''
  try {
    const raw = await bridge(parentId, {})
    const events = normaliseEventsResponse(raw)
    const clipped = typeof seq === 'number'
      ? events.filter((e) => typeof e.seq !== 'number' || e.seq <= seq)
      : events
    if (clipped.length === 0) appendMeta(els.leftStream, '(no events yet)')
    else for (const e of clipped) paintRow(els.leftStream, e)
  } catch (err) {
    appendMeta(els.leftStream, `could not load parent history — ${errMsg(err)}`)
  }
  // Right column: child from seq forward (or the whole child log when seq
  // is missing).  seq is INHERITED by the fork so the wire's own numbering
  // gives us the exact set to render on the right — everything with a seq
  // strictly greater than the boundary is fork-original.
  els.rightStream.innerHTML = ''
  try {
    const raw = await bridge(childId, {})
    const events = normaliseEventsResponse(raw)
    const clipped = typeof seq === 'number'
      ? events.filter((e) => typeof e.seq !== 'number' || e.seq > seq)
      : events
    if (clipped.length === 0) {
      appendMeta(els.rightStream, '(fork is fresh — waiting for the next turn.  Refresh after the model responds.)')
    } else {
      for (const e of clipped) paintRow(els.rightStream, e)
    }
  } catch (err) {
    appendMeta(els.rightStream, `could not load fork history — ${errMsg(err)}`)
  }
}

function errMsg(err) { return err && err.message ? err.message : String(err) }

function normaliseEventsResponse(raw) {
  const CH = typeof window !== 'undefined' ? window.__dshCompareHistory : null
  if (CH && typeof CH.normaliseEventsResponse === 'function') {
    return CH.normaliseEventsResponse(raw)
  }
  if (!raw) return []
  if (Array.isArray(raw)) return raw.slice()
  if (Array.isArray(raw.events)) return raw.events.slice()
  if (Array.isArray(raw.items)) return raw.items.slice()
  return []
}

function paintRow(container, event) {
  const doc = container.ownerDocument
  const t = (event && (event.type || event.kind)) || ''
  const row = doc.createElement('div')
  row.className = 'fork-compare-row'
  const seqEl = doc.createElement('span')
  seqEl.className = 'fork-compare-seq mono muted'
  seqEl.textContent = typeof event.seq === 'number' ? `#${event.seq}` : '·'
  row.appendChild(seqEl)
  const kind = doc.createElement('span')
  kind.className = 'fork-compare-kind mono'
  kind.textContent = t || '(unknown)'
  row.appendChild(kind)
  const body = doc.createElement('span')
  body.className = 'fork-compare-body'
  body.textContent = summariseEvent(event)
  row.appendChild(body)
  container.appendChild(row)
}

function summariseEvent(event) {
  if (!event) return ''
  const t = event.type || event.kind || ''
  if (t === 'message/user' || t === 'user/message') return extractText(event) || '(user)'
  if (t === 'message/assistant' || t === 'assistant/message') {
    const s = extractText(event)
    return s ? clip(s, 120) : '(assistant)'
  }
  if (t === 'tool/call') {
    const d = event.data || event
    const name = d.name || event.tool || 'tool'
    return `${name}(…)`
  }
  if (t === 'tool/result') {
    const d = event.data || event
    return d.isError ? '(error)' : '(result)'
  }
  if (t === 'request/header') {
    const d = event.data && event.data.header ? event.data.header : (event.header || {})
    const m = (d.config && d.config.model) || d.model || ''
    return m ? `model=${m}` : ''
  }
  if (typeof event.text === 'string') return clip(event.text, 120)
  return ''
}

function clip(s, n) {
  if (typeof s !== 'string') return ''
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function extractText(event) {
  if (!event) return ''
  if (typeof event.text === 'string') return event.text
  if (Array.isArray(event.content)) {
    return event.content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
  }
  const d = event.data
  if (d && Array.isArray(d.content)) {
    return d.content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
  }
  return ''
}

function appendMeta(container, text) {
  const doc = container.ownerDocument
  const row = doc.createElement('div')
  row.className = 'fork-compare-row fork-compare-meta muted'
  row.textContent = text
  container.appendChild(row)
}

function ensureDrawer(doc) {
  if (cached && cached.root && cached.root.isConnected) return cached
  // Reuse the DOM if index.html shipped a stub; otherwise build it.
  let root = doc.getElementById('fork-compare-drawer')
  if (!root) {
    root = doc.createElement('div')
    root.id = 'fork-compare-drawer'
    root.className = 'playground-compare-drawer fork-compare-drawer'
    root.hidden = true
    // Head
    const head = doc.createElement('div')
    head.className = 'drawer-head'
    const title = doc.createElement('span')
    title.className = 'title'
    title.textContent = 'Fork compare'
    head.appendChild(title)
    const badge = doc.createElement('span')
    badge.id = 'fork-compare-badge'
    badge.className = 'fork-compare-badge mono'
    head.appendChild(badge)
    const spacer = doc.createElement('span')
    spacer.className = 'fork-compare-spacer'
    head.appendChild(spacer)
    const refreshBtn = doc.createElement('button')
    refreshBtn.type = 'button'
    refreshBtn.className = 'ghost small'
    refreshBtn.textContent = 'Refresh'
    refreshBtn.title = 'Refetch both sides — fork sessions grow after this drawer opens.'
    head.appendChild(refreshBtn)
    const closeBtn = doc.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'ghost small'
    closeBtn.textContent = 'Close'
    head.appendChild(closeBtn)
    root.appendChild(head)
    // Body
    const body = doc.createElement('div')
    body.className = 'drawer-body'
    const leftCol = doc.createElement('div')
    leftCol.className = 'compare-col compare-live'
    const leftTitle = doc.createElement('div')
    leftTitle.className = 'col-title'
    leftTitle.id = 'fork-compare-left-title'
    leftCol.appendChild(leftTitle)
    const leftStream = doc.createElement('div')
    leftStream.className = 'stream compact fork-compare-stream'
    leftStream.id = 'fork-compare-left-stream'
    leftCol.appendChild(leftStream)
    body.appendChild(leftCol)
    const rightCol = doc.createElement('div')
    rightCol.className = 'compare-col compare-playground'
    const rightTitle = doc.createElement('div')
    rightTitle.className = 'col-title'
    rightTitle.id = 'fork-compare-right-title'
    rightCol.appendChild(rightTitle)
    const rightStream = doc.createElement('div')
    rightStream.className = 'stream compact fork-compare-stream'
    rightStream.id = 'fork-compare-right-stream'
    rightCol.appendChild(rightStream)
    body.appendChild(rightCol)
    root.appendChild(body)

    closeBtn.addEventListener('click', closeForkCompare)
    refreshBtn.addEventListener('click', function () {
      if (lastArgs) openForkCompare(lastArgs)
    })
    // Bug D (2026-07-18): a click on the drawer's own root (outside the
    // head/body children) means the user clicked the border/gap; treat as
    // dismissal so "关不掉" isn't just a screen-scroll trap.  Clicks
    // inside .drawer-head / .drawer-body bubble up through those first,
    // so this fires only for the outermost pointer target.
    root.addEventListener('click', function (e) {
      if (e.target === root) closeForkCompare()
    })

    doc.body.appendChild(root)
  }
  cached = {
    root,
    badge: doc.getElementById('fork-compare-badge'),
    leftTitle: doc.getElementById('fork-compare-left-title'),
    rightTitle: doc.getElementById('fork-compare-right-title'),
    leftStream: doc.getElementById('fork-compare-left-stream'),
    rightStream: doc.getElementById('fork-compare-right-stream'),
  }
  return cached
}

function getBridge() {
  const w = typeof window !== 'undefined' ? window : null
  const dsh = w && w.dsh ? w.dsh : null
  // the demo `mock-fork-compare` button
  // stashes a `{sessionId → events[]}` map on `window.__dshForkCompareMockBridge`
  // and expects the drawer to hydrate from it. The dsh contextBridge object
  // is frozen (contextIsolation), so a mock cannot monkey-patch
  // dsh.sessionEvents directly. This escape hatch is the honest path — a
  // pure lookup ahead of the real bridge, falls through to daemon-backed
  // sessionEvents for any id not in the map.
  const mockMap = w && w.__dshForkCompareMockBridge
  const daemon = (dsh && typeof dsh.sessionEvents === 'function')
    ? (sessionId, opts) => dsh.sessionEvents(sessionId, opts || {})
    : null
  if (mockMap && typeof mockMap === 'object') {
    return async (sessionId, opts) => {
      if (mockMap[sessionId]) return { events: mockMap[sessionId] }
      if (daemon) return daemon(sessionId, opts)
      return { events: [] }
    }
  }
  return daemon
}

// -- exports -----------------------------------------------------------

const api = {
  openForkCompare,
  closeForkCompare,
  markUserGesture,
  buildBadgeText,
  // Pure helpers exposed for tests.
  normaliseEventsResponse,
  summariseEvent,
  extractText,
  short,
  SOURCE_LABELS,
  // Internal reset for tests so consecutive suites don't fight over cache.
  __resetForTests() {
    cached = null
    lastArgs = null
    escBound = false
    gestureBound = false
    lastUserGestureAt = 0
  },
  __markGestureForTests(t) { lastUserGestureAt = (typeof t === 'number') ? t : Date.now() },
  __getBootAtForTests() { return BOOT_AT },
  __setBootAtForTests(t) { BOOT_AT = t },
}
if (typeof module !== 'undefined' && module.exports) module.exports = api
if (typeof window !== 'undefined') window.__dshForkCompare = api

// Install the gesture watcher at module load so that trusted pointer
// events fired between renderer boot and the first openForkCompare call
// are captured (otherwise the click that reaches an edit-rerun button
// would arrive *before* the watcher installs on demand).
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  try {
    const bump = function (e) {
      const trusted = (e && typeof e.isTrusted === 'boolean') ? e.isTrusted : false
      if (!trusted) return
      lastUserGestureAt = Date.now()
    }
    document.addEventListener('pointerdown', bump, true)
    document.addEventListener('keydown', bump, true)
    gestureBound = true
  } catch (_) { /* no-op — SSR/tests */ }
}

})();
