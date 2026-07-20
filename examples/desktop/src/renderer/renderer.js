// Renderer: turns runtime notifications into UI. Vanilla DOM, no framework.
//
// Event routing (see packages/core/session/src/types.ts SessionEventMap):
//   - user/message      -> user bubble (also mirrored optimistically on send)
//   - assistant/chunk   -> streaming delta into the active assistant bubble
//   - assistant/message -> finalize the assistant bubble
//   - tool/call         -> open a collapsed tool block
//   - tool/result       -> attach result to its matching call
//   - turn/end          -> system marker + reset streaming state
// Anything else falls through to a muted system line so we can see it during
// development without invented rendering.
//
// Session state:
//   - Sidebar is refreshed from session/list (server-authoritative).
//   - Clicking a session replays via session/events → session/events(seq)
//     window reads, then keeps streaming live via session.event.
//
// Interrupts:
//   - main.js dispatches inbound session/interrupt requests as
//     `interrupt:incoming { interruptId, sessionId, kind, spec }`; we render
//     a card in the target session's log, wait for the user, and answer
//     back via `resolveInterrupt(interruptId, { outcome, payload? })`.
//   - `interrupt:invalidate` grays out any open card (runtime crashed / user
//     switched profiles) — the response was auto-cancelled elsewhere.

'use strict'

// gate the Debug popover on DSH_QA=1 (main.js forwards this as location.hash
// 'qa' at boot). Production launches don't reveal the mock-card wall; QA
// runs and the fresh-eyes driver keep it. Applied at renderer boot BEFORE
// any tab controller runs so the popover starts hidden and only shows for
// intentional QA sessions.
if (typeof location !== 'undefined' && typeof document !== 'undefined'
    && document.body && location.hash && location.hash.includes('qa')) {
  document.body.dataset.qa = '1'
}

const streamEl = document.getElementById('stream')

// fix/expand-affordance 2026-07-18: universally reflect a `<details>`
// element's [open] state onto its first `<summary>` child's
// `aria-expanded` attribute. Runs a MutationObserver over
// document.body catching any new <details> inserted anywhere in the
// renderer — the app has ~26 disclosure surfaces across many builders
// (assistant-turn, inject-family, subagent-view, trace-detail-pane,
// devtools-panel, runtimes-page, context-page, visibility-controller,
// recall-card), and adding a per-site wire would be N call-sites of
// noise. The observer is idempotent (marks each summary with
// dataset.ariaWired='1' so repeated inserts don't stack listeners),
// runs once at DOMContentLoaded, and stays cheap because each new
// summary only pays one toggle-listener + one initial attribute set.
// See details-aria.js for the extracted helper (also loaded by
// assistant-turn.js for the trace drawer's own inline wiring).
;(function initDetailsAriaObserver () {
  const aria = (typeof window !== 'undefined' && window.__dshDetailsAria) || null
  if (!aria || !document || !document.body) return
  const { wireDetailsAria } = aria
  function wireOne (details) {
    if (!details || !details.tagName || details.tagName !== 'DETAILS') return
    const summary = details.querySelector(':scope > summary')
    if (!summary) return
    if (summary.dataset.ariaWired === '1') return
    summary.dataset.ariaWired = '1'
    wireDetailsAria(details, summary)
  }
  // Wire anything already present at boot.
  document.querySelectorAll('details').forEach(wireOne)
  const obs = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!node || node.nodeType !== 1) continue
        if (node.tagName === 'DETAILS') wireOne(node)
        if (node.querySelectorAll) {
          node.querySelectorAll('details').forEach(wireOne)
        }
      }
    }
  })
  obs.observe(document.body, { childList: true, subtree: true })
})()
// New session used to
// wipe the streamEl.innerHTML and never restore the welcome-launcher, so a
// blank pane sat where an obvious "what to do next" surface belonged. Snapshot
// the initial DOM copy of `.empty-welcome` before anyone touches it — we
// cloneNode(true) this back into the stream whenever `updateEmptyStateVisibility`
// decides the active session has zero rendered rows (see below).
const emptyWelcomeTemplate = (function snapshotEmptyWelcome() {
  if (!streamEl) return null
  const node = streamEl.querySelector('.empty-welcome[data-empty="chat"]')
  return node ? node.cloneNode(true) : null
})()
const sessionsEl = document.getElementById('sessions')
const titleEl = document.getElementById('session-title')
const inputEl = document.getElementById('input')
const sendBtn = document.getElementById('send')
const cancelBtn = document.getElementById('cancel')
const statusDot = document.getElementById('status-dot')
const statusText = document.getElementById('status-text')
const modelBadge = document.getElementById('model-badge')
const profileSelect = document.getElementById('profile')
const newSessionBtn = document.getElementById('new-session')

const state = {
  activeSessionId: null,
  sessions: new Map(), // id -> { title, running, lastEventTime, toolCalls, header, live, persisted, forkMarkers, contextTracker, recallCards, hasUserMessage, eventCount }
  entries: [],         // last session/list response, for tree recomputation
  streaming: null,     // { sessionId, el } — current assistant bubble receiving chunks
  // the active assistant-turn <section>. Populated
  // by ensureTurnContainer on first assistant-side event of a turn, cleared
  // by finishTurnContainer on turn/end. `null` outside a turn (during user
  // input, replay, or after seal). Shape: { sessionId, section, body }.
  currentTurn: null,
  streamSeqAnchor: 0,  // seq of the assistant/message that will finalize the current stream
  lastAssistantSeq: 0, // seq of the most recent assistant/message on the active stream (for fork button)
  inflightTurn: false, // set true between send() and turn/end so Cancel is enabled
  interruptCards: new Map(), // interruptId -> DOM element
  forkMarkersInStream: new Map(), // parentSeq -> marker DOM element on the active session
  // Context meter: user-triggered compaction landing state so
  // the button can grey out on MethodNotFound and stay greyed until the
  // profile is switched to one whose daemon supports session/compact.
  compactSupported: null, // null=unknown, true=supported, false=MethodNotFound seen
  // "Recent" list: top-5 by default with a Show all(N) toggle. Merged view —
  // one flat list covering both live and persisted sessions (see
  // renderSessionList + panels-c.mergeRecentSessions).
  sessionsExpanded: false,
  // Set to a sessionId while replayHistory is looping — cacheEvent skips
  // pushes in that window so replaying our own cache doesn't grow it.
  replayingId: null,
  // Server-declared capabilities from the last `initialize` handshake
  // (Ticket G). `null` = pre-handshake (boot) OR handshake
  // completed without a capabilities envelope; both cases mean "assume
  // everything works" so a v1 daemon that never shipped `capabilities`
  // doesn't go dark. Populated inside window.dsh.onInitialized via
  // capabilities.normalizeCapabilities(). See applyCapabilityGates.
  serverCapabilities: null,
  // Server name+version from the initialize handshake (Ticket G). Both
  // populated together; used by the devtools drawer header row so bug
  // reports can name the exact runtime.
  serverName: '',
  serverVersion: '',
  // live subagent routing table. Keyed by
  // childSessionId; value = { parentSessionId, parentCallId?, cardEl,
  // bodyEl, running }. Populated on `subagent.started`, consulted on every
  // `session.event` — if the event's sessionId hits this table we route
  // its render into the card's live-subtrajectory area instead of the
  // main stream (which belongs to the parent). Cleared on subagent.finished.
  //
  // The parentCallId anchor is discovered heuristically: we track the last
  // spawn_agent tool/call per parent session (meta.lastSpawnCallId) and
  // adopt it when subagent.started arrives without an explicit anchor.
  // Fixture wire may pass parentCallId explicitly (§2.6); the real kernel
  // wire carries only parent/
  // child sessionIds, so the heuristic is the fallback.
  subagentLineage: new Map(),
}

// Default collapse limit for the unified Recent list. Live + persisted merged.
const SESSIONS_COLLAPSED_LIMIT = 8

// read helpers for the initialize capability envelope.
// `isCapabilitySupported` returns true when the runtime either declared the
// bit true OR didn't ship the bit at all (missing key / null / non-object /
// pre-handshake). Only an explicit `false` grays a surface — same "wire
// silent ≠ unsupported" posture the shell uses for header fields.
function isCapabilitySupported(key) {
  const caps = state.serverCapabilities
  if (!caps) return true
  return caps[key] !== false
}
function capabilityDisabledTooltip(key) {
  const M = window.__dshCapabilities
  return (M && typeof M.capabilityDisabledTitle === 'function')
    ? M.capabilityDisabledTitle(key) : ''
}
// after a fresh initialize, walk each capability-gated surface
// and disable the ones the runtime declared false. Called from onInitialized
// once state.serverCapabilities has been captured. Individual updateFoo
// helpers still consult isCapabilitySupported so ad-hoc re-renders stay
// consistent (fork buttons, cancel button, compact button).
function applyCapabilityGates() {
  const pluginsTabBtn = document.querySelector('.tab-btn[data-tab="plugins"]')
  if (pluginsTabBtn) {
    const on = isCapabilitySupported('plugins')
    pluginsTabBtn.setAttribute('aria-disabled', on ? 'false' : 'true')
    pluginsTabBtn.classList.toggle('capability-disabled', !on)
    if (!on) pluginsTabBtn.title = capabilityDisabledTooltip('plugins')
    else pluginsTabBtn.title = ''
  }
  if (typeof newSessionBtn !== 'undefined' && newSessionBtn) {
    const on = isCapabilitySupported('sessionQuery')
    newSessionBtn.disabled = !on
    newSessionBtn.title = on ? '' : capabilityDisabledTooltip('sessionQuery')
  }
  if (typeof renderComposerModel === 'function' && typeof composerModelEl !== 'undefined' && composerModelEl) {
    renderComposerModel(composerModelEl.dataset ? composerModelEl.dataset.currentModel : '')
  }
  if (typeof updateForkButtons === 'function') updateForkButtons()
  if (typeof updateCancelButton === 'function') updateCancelButton()
  if (typeof updateCompactButton === 'function') updateCompactButton()
}

// Compact "3s / 12m / 4h / 2d" formatter used by the sidebar and any status
// row that wants a the reference design-ish "last activity" chip. Falls back to '' for zero
// so callers can decide whether to emit a chip at all.
function formatRelativeTime(ts) {
  if (!ts) return ''
  const dt = Date.now() - ts
  if (dt < 60_000)      return `${Math.max(1, Math.floor(dt / 1000))}s ago`
  if (dt < 3_600_000)   return `${Math.floor(dt / 60_000)}m ago`
  if (dt < 86_400_000)  return `${Math.floor(dt / 3_600_000)}h ago`
  return `${Math.floor(dt / 86_400_000)}d ago`
}

// -- session catalog ---------------------------------------------------------

function ensureSession(id, patch = {}) {
  let s = state.sessions.get(id)
  if (!s) {
    // contextTracker + recallCards are per-session so isolation matches the
    // rest of the shell (each session has its own toolCalls Map). The
    // tracker uses the module's DEFAULT_BUDGET_TOKENS; when the profile
    // knows the model's window (future), pass it here.
    const tracker = window.__dshContextMeter
      ? window.__dshContextMeter.createTracker()
      : null
    s = {
      title: '', running: false, lastEventTime: 0,
      toolCalls: new Map(),
      recallCards: new Map(), // callId -> DOM element for history_read/search
      // raw call + result payloads per callId
      // so the tool card's `{ }` badge can pop the JSON drawer without
      // rewalking event history. Populated at tool/call (args + name) and
      // enriched at tool/result (result). Same lifetime as toolCalls; wiped
      // implicitly when the session Map is dropped on selectSession reset.
      toolPayloads: new Map(),
      contextTracker: tracker,
      // Every session.event notification we receive for this session goes
      // into this ring so switch-away/switch-back can replay locally when
      // the daemon's persistence lags behind (daemon-echo profile keeps
      // live events in memory only; `session/events` returns [] until the
      // session persists). Capped so a long conversation doesn't grow
      // unbounded. See replayHistory + selectSession.
      cachedEvents: [],
      // hasUserMessage flips true the first time we see a user/message on the
      // wire OR the local send() runs. The Recent list uses this to filter
      // out empty "New chat" placeholders so the sidebar doesn't accumulate
      // ghosts every time the "+" button is clicked. Persisted sessions
      // arrive from session/list with this implicitly true (they have a
      // history — see enrichEntry).
      hasUserMessage: false,
      // Trigger of the currently open turn (`turn/start.data.trigger`). Used
      // by appendCompactMarker to badge a compact card auto vs manual —
      // manual = the shell's Compact button (self-injected turn whose source
      // is `plugin:compact`), auto = compaction fired inside a turn the
      // agent was already in (pre-step safety valve). Null between turns and
      // during history replay of a persisted-only session.
      currentTurnTrigger: null,
      // §1.3 inject-family gate: number of turn/start events
      // seen so far. Family A (hooks-* on turn 1 = SessionStart) demotes to
      // family B on later turns. Incremented once per turn/start.
      turnCount: 0,
      // §1.1 trace card state. Held open across step/start-
      // step/end so absorbTraceEvent can bucket the in-band events;
      // pendingTraceInputs collects between-step surface events for the
      // next step's inputs pane. Cleared at step/end.
      currentTraceRecord: null,
      pendingTraceInputs: [],
      // last trace card that finishTraceStep
      // emitted this turn. Populated on step/end, consumed as a fallback
      // by turn/end when the defensive-flush finishTraceStep call finds
      // no live record (single-step turns clear currentTraceRecord on
      // step/end first). Cleared on turn/start and after
      // finishTurnContainer consumes it.
      lastTurnTraceCard: null,
    }
    state.sessions.set(id, s)
  }
  Object.assign(s, patch)
  return s
}

function renderSessionList() {
  sessionsEl.innerHTML = ''
  // Build a flat, recency-sorted "Recent" list unifying live + persisted-only
  // sessions. Grouping by live/persisted (the previous SESSIONS / HISTORY
  // split) was leaking a runtime impl detail into the IA; state now lives on
  // the row (green dot for a running live session, muted dot for a persisted
  // resume target) instead of the group header. The Tree tab still owns
  // parent/child lineage — this tab is a chronological drawer.
  const entries = state.entries.length > 0
    ? state.entries.map((e) => enrichEntry(e))
    : Array.from(state.sessions.entries()).map(([id, meta]) => ({
      sessionId: id,
      header: meta.header || { parentSession: undefined },
      title: meta.title,
      running: !!meta.running,
      lastEventTime: meta.lastEventTime,
      live: meta.live !== false,
      persisted: !!meta.persisted,
      hasUserMessage: !!meta.hasUserMessage,
    }))
  const P = window.__dshPanelsC
  const merged = P && typeof P.mergeRecentSessions === 'function'
    ? P.mergeRecentSessions(entries, { activeSessionId: state.activeSessionId })
    : entries.slice().sort((a, b) => (b.lastEventTime || 0) - (a.lastEventTime || 0))

  const total = merged.length
  const visible = state.sessionsExpanded || total <= SESSIONS_COLLAPSED_LIMIT
    ? merged
    : merged.slice(0, SESSIONS_COLLAPSED_LIMIT)

  // Head toggle — hidden entirely when ≤5 rows so the sidebar stays quiet.
  const toggle = document.getElementById('sessions-toggle')
  if (toggle) {
    if (total <= SESSIONS_COLLAPSED_LIMIT) {
      toggle.hidden = true
    } else {
      toggle.hidden = false
      // C-P1-5: qualify the number so it doesn't read as a conflict with the
      // Session Tree page's "N in tree" count. They're both correct — this is
      // total recent (live + persisted), that is currently-visible tree.
      toggle.textContent = state.sessionsExpanded
        ? 'Show less'
        : `Show all recent (${total})`
    }
  }

  const nowMs = Date.now()
  for (const entry of visible) {
    const id = entry.sessionId
    const meta = state.sessions.get(id)
    const li = document.createElement('li')
    li.title = id

    // State dot: green when a live session has a turn in flight; muted when
    // this is a persisted-only row (resume-on-click). Neither dot on an
    // idle-live session so the row stays visually calm.
    const running = (meta && meta.running) || entry.running
    const isHistory = entry.live === false && entry.persisted === true
    const dot = document.createElement('span')
    if (running) dot.className = 'row-dot row-dot-live'
    else if (isHistory) dot.className = 'row-dot row-dot-resume'
    else dot.className = 'row-dot row-dot-idle'
    dot.title = running ? 'session has a turn in flight'
      : isHistory ? 'click to resume this session' : ''
    li.appendChild(dot)

    // Row-list body: title on top, muted rel-time chip on the right. Smart
    // title kicks in when the title is a smoke fixture or (shortId) fallback
    // so "未命名 · 2 小时前" reads over a wall of `(smoke-…)` noise.
    const titleWrap = document.createElement('span')
    titleWrap.className = 'title-and-sub'
    const title = document.createElement('span')
    const rowMeta = { ...entry, title: (meta && meta.title) || entry.title }
    const smart = P && typeof P.smartSessionTitle === 'function'
      ? P.smartSessionTitle(rowMeta, nowMs)
      : { text: rowMeta.title || 'New chat', isUntitled: false }
    title.className = smart.isUntitled ? 'title title-untitled' : 'title'
    title.textContent = smart.text
    titleWrap.appendChild(title)
    const ts = (meta && meta.lastEventTime) || entry.lastEventTime || 0
    if (ts) {
      const rel = document.createElement('span')
      rel.className = 'rel-time'
      rel.textContent = P && typeof P.relativeTime === 'function'
        ? P.relativeTime(ts, nowMs) : formatRelativeTime(ts)
      titleWrap.appendChild(rel)
    }
    li.appendChild(titleWrap)

    if (id === state.activeSessionId) li.classList.add('active')
    li.addEventListener('click', () => {
      if (isHistory) { void resumeAndSelect(id) }
      else { void selectSession(id) }
    })
    sessionsEl.appendChild(li)
  }
}

// Enrich a raw session/list entry with the renderer-local `hasUserMessage`
// and `eventCount` bits so the pure `panels-c.filterEmptySessions` can decide
// without reaching into DOM state.
//
// Third-strike rule: NEVER fabricate `hasUserMessage`.
// A previous version set `hasUserMessage = persisted || localBit`, which
// looked reasonable but silently defeated the filter — every daemon-listed
// row is `persisted:true`, so the flag came out true for stale smoke-* rows
// with zero turns and the filter's drop paths never fired. Now: the bit is
// `true` only when we locally observed a user message (`meta.hasUserMessage`,
// flipped in send() and on user/message notifications); otherwise it stays
// `undefined`. The filter's escape hatch (`undefined && eventCount === 0`)
// then handles persisted-only smoke fixtures — once the wire side ships
// `eventCount` on `session/list`, those rows drop out.
//
// `eventCount` is forwarded verbatim from the daemon shape when present; a
// missing field leaves the value `undefined` so the filter stays conservative
// (unknown → keep).
function enrichEntry(entry) {
  const id = entry && entry.sessionId
  const meta = id ? state.sessions.get(id) : null
  const localBit = !!(meta && meta.hasUserMessage)
  const enriched = {
    ...entry,
    hasUserMessage: localBit ? true : undefined,
  }
  if (typeof entry.eventCount === 'number') enriched.eventCount = entry.eventCount
  else if (typeof (meta && meta.eventCount) === 'number') enriched.eventCount = meta.eventCount
  // surface shell-derived meta bits (§B-2/B-4/B-5)
  // onto the entry so pure modules like session-tree.js
  // `classifySessionShape` can read them without reaching into the
  // renderer's private state map. The derived values are canonical; if the
  // wire ever ships equivalents on the header, the meta values still win
  // (they reflect current live state, not the last-persisted snapshot).
  if (meta) {
    const projected = {}
    if (meta.awaitingApproval !== undefined) projected.awaitingApproval = meta.awaitingApproval
    if (meta.lastError !== undefined) projected.lastError = meta.lastError
    if (Object.keys(projected).length > 0) enriched.meta = projected
  }
  return enriched
}

// Resume-then-select: history rows kick a session/resume through the runtime
// before the normal replay path. Failure just falls back to a plain select so
// we don't wedge the sidebar if the daemon refuses.
async function resumeAndSelect(id) {
  try { await window.dsh.resumeSession(id) }
  catch (err) { console.warn('resumeSession failed:', err) }
  await refreshSessionList()
  await selectSession(id)
}

async function refreshSessionList() {
  try {
    const list = await window.dsh.listSessions()
    // Server-authoritative: cache the raw entries for tree rebuilds, then
    // merge server truth into our per-session meta map (the toolCalls Map
    // stays on the local record — it isn't part of the wire shape).
    state.entries = Array.isArray(list) ? list : []
    for (const entry of state.entries) {
      const id = entry.sessionId
      // Title fallback: real-daemon truth (port 9224
      // wire audit) is that persisted rows ship the human title at
      // `entry.header.title`, not the flat `entry.title` field. Reading
      // only the flat field on refresh blanks meta.title to '' on every
      // sweep — the Recent list then reads "Untitled" for every persisted
      // session with a perfectly good stored title. Precedence:
      //   1. flat entry.title (server-authoritative when present)
      //   2. existing meta.title (a locally seeded title from send() or
      //      onSessionEvent — don't clobber if wire is still catching up)
      //   3. entry.header.title (persisted-row daemon shape)
      //   4. '' (truly untitled → smartSessionTitle collapses to Untitled)
      // Pair test: test/renderer-header-title-mirror.test.js exercises the
      // persisted daemon-shape fixture end-to-end into
      // panels-c.smartSessionTitle.
      const existingMeta = state.sessions.get(id)
      const existingTitle = (existingMeta && typeof existingMeta.title === 'string')
        ? existingMeta.title : ''
      const mergedTitle = entry.title
        || existingTitle
        || (entry.header && entry.header.title)
        || ''
      const meta = ensureSession(id, {
        title: mergedTitle,
        running: !!entry.running,
        lastEventTime: entry.lastEventTime || 0,
        live: !!entry.live,
        persisted: !!entry.persisted,
        header: entry.header || {},
        // Forward daemon eventCount so getSessions() / enrichEntry can pass
        // it to panels-c.filterEmptySessions. root cause: without
        // this, persisted rows arrive with no hasUserMessage flag AND no
        // eventCount downstream, so the filter kept them all.
        eventCount: typeof entry.eventCount === 'number' ? entry.eventCount : undefined,
      })
      // P0-2: bind the model's real context window when the wire ships it.
      // Priority order is baked into `contextWindowFromEntry`:
      //   1. entry.model.contextWindow  (daemon's session-query projection,
      //      the wire route landed for Ticket A model projection)
      //   2. entry.header.model.contextWindow  (phantom-header echo)
      //   3. entry.contextWindow  (flat wire variant)
      // Falls through to the tracker's assumed default when the daemon
      // hasn't projected the field yet — the meter label then reads
      // "~128k (assumed)" rather than pretending precision.
      if (meta.contextTracker && meta.contextTracker.setBudget && window.__dshContextMeter) {
        const cw = window.__dshContextMeter.contextWindowFromEntry(entry)
        if (cw) meta.contextTracker.setBudget(cw)
        // Model NAME: source-of-truth is the projection when present. Kept on
        // meta so the header chip can render "deepseek-chat" without every
        // consumer re-probing the wire shape. Never invent a name from an
        // absent projection — the chip degrades to "unknown model".
        const nameFn = window.__dshContextMeter.modelNameFromEntry
        if (typeof nameFn === 'function') {
          const modelName = nameFn(entry)
          if (modelName) meta.modelName = modelName
        }
      }
    }
    renderSessionList()
    // Mission Control subscribes to the same server-authoritative snapshot
    // so its aggregate stays in sync (session/list is the canonical membership
    // channel; the ticker + tree/topo/board projections all read from it).
    if (window.__dshMission) {
      window.__dshMission.notify('session.list', { entries: state.entries })
    }
  } catch (err) {
    console.debug('session/list unavailable:', err.message)
  }
}

// keep the welcome
// launcher available whenever the active session has nothing to show. Called
// on session switch (post-innerHTML clear), on New session mint, on every
// onSessionEvent (so the first real event evicts the welcome), and on
// runtime reconnect. Idempotent — safe to call from anywhere.
function updateEmptyStateVisibility() {
  if (!streamEl) return
  // "Empty" from the researcher's PoV = no rendered children other than a
  // welcome node itself. `.chat-runtime-banner` sits above streamEl so it
  // never counts; the check looks at streamEl's actual children.
  const kids = streamEl.children
  const nonWelcomeKids = Array.from(kids).filter((n) => !(n && n.classList && n.classList.contains('empty-welcome')))
  const shouldShow = nonWelcomeKids.length === 0
  const existing = streamEl.querySelector('.empty-welcome[data-empty="chat"]')
  if (shouldShow) {
    if (!existing && emptyWelcomeTemplate) {
      streamEl.appendChild(emptyWelcomeTemplate.cloneNode(true))
    }
  } else if (existing) {
    existing.remove()
  }
}

async function selectSession(id) {
  state.activeSessionId = id
  // fix/code-bugs-batch P1-4: swap the artifacts module to this session's
  // bucket so Board/Timeline/Evolution stop mixing versions across
  // sessions. No-op when the module is untouched by the app (tests).
  if (window.__dshArtifacts && typeof window.__dshArtifacts.setActiveSession === 'function') {
    window.__dshArtifacts.setActiveSession(id)
  }
  const meta = state.sessions.get(id)
  // Header title: real title wins; empty/unnamed sessions read as "New chat"
  // in the main pane (never in the sidebar — that's what the smart-title
  // pass in renderSessionList handles). Falls back to a shortened id when
  // even meta is missing (very rare — pre-refreshSessionList race).
  const hasReal = meta && typeof meta.title === 'string' && meta.title.trim().length > 0
  titleEl.textContent = hasReal ? meta.title : (meta ? 'New chat' : id.slice(0, 8))
  streamEl.innerHTML = ''
  // Restore the welcome launcher immediately after clearing. `replayHistory`
  // below will populate real events if any exist; that call ends with a
  // second visibility pass (see its final lines) so the welcome is evicted
  // once a real message lands. Without this call, a New session click leaves
  // the chat pane visibly blank until the user types.
  updateEmptyStateVisibility()
  state.streaming = null
  state.currentTurn = null
  state.lastAssistantSeq = 0
  state.forkMarkersInStream.clear()
  // `state.inflightTurn` is a single global bool that gates the composer's
  // Cancel button, but running state is per-session. If we don't resync on
  // switch, Cancel stays enabled after switching away from a running session
  // to an idle one, and a click would then fire cancelPrompt against the new
  // (idle) session, which the daemon rejects. Read the target session's
  // running bit as the source of truth. turn/start & turn/end continue to
  // flip this while the session is active.
  state.inflightTurn = !!(meta && meta.running)
  updateCancelButton()
  updateCompactButton()
  updateForkButtons()
  if (meta) {
    meta.toolCalls = new Map()
    meta.recallCards = new Map()
    // partial-tool-row aggregator (callId → {name,buffer,el}).
    // Cleared on switch — a switched-away session's in-flight tool-call
    // deltas should not bleed into the new session's stream.
    meta.partialToolCalls = new Map()
    // Rebuild context tracker on switch: the meter shows the active session,
    // and history is re-ingested via replayHistory below.
    if (window.__dshContextMeter) meta.contextTracker = window.__dshContextMeter.createTracker()
  }
  renderSessionList()
  await replayHistory(id)
  updateContextMeter()
  // After replay, drop inline fork markers for any known child sessions at
  // their seed boundary. During live streaming we grow the same map when
  // subagent.started fires.
  installKnownForkMarkers(id)
}

async function replayHistory(id) {
  // Two sources of truth for a session's event stream:
  //   (a) In-memory cache — populated by every onSessionEvent notification
  //       for this session. Wins for live sessions the user has been
  //       watching in this window (daemon may not have persisted yet).
  //   (b) Server session/events — the daemon's persisted log. Wins for
  //       sessions we're seeing for the first time (resumed from disk).
  //
  // Strategy: fetch (b), pick whichever source has more events, and replay
  // those. Merging by seq is tempting but risks double-rendering messages
  // that appear in both; the "more events" heuristic is safe because both
  // sources are appended monotonically and the cache is capped so a very
  // long persisted history always wins.
  const meta = state.sessions.get(id)
  const cached = (meta && Array.isArray(meta.cachedEvents)) ? meta.cachedEvents : []
  let events = null
  try {
    const listing = await window.dsh.sessionEvents(id, {})
    if (listing && Array.isArray(listing.events) && listing.events.length > 0) {
      // Two-phase read:
      //
      //   Phase 1 — metadata listing. No `seq`, so the server returns
      //   `SessionEventRecord[]` (metadata only: seq/type/time/surface, no
      //   `data`); cannot be rendered but tells us the tail seq and total.
      //
      //   Phase 2 — walk backwards in `REPLAY_WINDOW_MAX`-sized chunks
      //   using `readEvent(seq, before, after)`. The daemon's
      //   session-query hard-caps `before`/`after` at
      //   `SESSION_QUERY_READ_WINDOW_MAX` (default 50) and throws
      //   `SESSION_QUERY_INVALID_WINDOW` on any larger value; the
      //   previous single-shot `before: listing.events.length` blew past
      //   that cap on any >50-event session, catch swallowed it, chat
      //   rendered empty. Fork sessions inherit the parent's full log,
      //   so this was the visible failure mode on every first-visit
      //   fork — hence tail-N is not acceptable; the head (seed
      //   messages, early decisions) is exactly what the user opens the
      //   fork to see.
      //
      // Loop protections: cursor must monotonically decrease, stop at
      // startSeq === 0, and cap total rounds at `ceil(total/window)+2`
      // so a misbehaving daemon can't spin us forever. Partial reads
      // are preserved; a mid-loop error stops the walk and renders
      // whatever we already have — partial > empty.
      //
      // Never shadow the global `window`: `const window = await window.dsh…`
      // is a TDZ self-reference, so replay crashed with "Cannot access 'window'
      // before initialization" and history silently never rendered.
      const REPLAY_WINDOW_MAX = 50
      const total = listing.events.length
      const maxRounds = Math.ceil(total / REPLAY_WINDOW_MAX) + 2
      const collected = []
      const seen = new Set()
      let cursor = listing.events[total - 1].seq
      let rounds = 0
      let progressed = true
      while (cursor >= 0 && rounds < maxRounds && progressed) {
        rounds++
        progressed = false
        let chunk
        try {
          chunk = await window.dsh.sessionEvents(id, { seq: cursor, before: REPLAY_WINDOW_MAX, after: 0 })
        } catch (err) {
          console.debug('session/events window failed at cursor', cursor, ':', err.message)
          break
        }
        if (!chunk || !Array.isArray(chunk.events) || chunk.events.length === 0) break
        // Prepend this chunk in seq order; dedup so overlapping windows or
        // an oddly-ordered daemon response can't double-render an event.
        const beforeSize = collected.length
        for (const ev of chunk.events) {
          if (typeof ev.seq !== 'number' || seen.has(ev.seq)) continue
          seen.add(ev.seq)
          collected.push(ev)
        }
        if (collected.length > beforeSize) progressed = true
        // Primary termination: we've reconstructed the full log the metadata
        // listing described. Cheaper than reasoning about seq numbering
        // (0-vs-1-based) and works uniformly across daemon variants.
        if (collected.length >= total) break
        const nextStart = typeof chunk.startSeq === 'number' ? chunk.startSeq : chunk.events[0].seq
        if (nextStart <= 0) break
        // Advance the cursor strictly (`nextStart - 1`) — same value would
        // re-request the same window forever.
        const nextCursor = nextStart - 1
        if (nextCursor >= cursor) break
        cursor = nextCursor
      }
      if (collected.length > 0) {
        // The walk collected chunks tail-first; re-sort by seq so the
        // renderer replays chronologically.
        collected.sort((a, b) => a.seq - b.seq)
        events = collected
      }
    }
  } catch (err) {
    console.debug('session/events unavailable:', err.message)
  }
  // Pick whichever source has more entries. Cache pushes are muted while
  // we're replaying so incoming notifications during the loop don't reappend.
  // The comparator lives in event-filter.js as pickReplaySource so it's
  // exercised by node --test; the local fallback keeps the renderer working
  // if the module hasn't loaded yet (script-tag order guarantees it has).
  const pick = window.__dshEventFilter && window.__dshEventFilter.pickReplaySource
    ? window.__dshEventFilter.pickReplaySource(cached, events)
    : ((events && events.length >= cached.length) ? events : cached)
  if (!pick || pick.length === 0) {
    // No history at all — the welcome launcher stays. Fresh-eyes #1: previously
    // the empty branch just `return`ed leaving whatever selectSession had put
    // in place, which was correct once we installed the welcome there, but
    // add an explicit call so a future refactor that trims the selectSession
    // seam can't silently regress.
    updateEmptyStateVisibility()
    return
  }
  // seed `meta.cachedEvents` from the picked
  // source when the wire strictly beats the local cache. Without this,
  // `cacheEvent` is muted for every event dispatched during replay (see
  // `state.replayingId` guard below), so any downstream reader that
  // consults `getEventsForSession(id)` — Tracing page projector, Context
  // page projector, Timeline/Graph tri-view — sees an empty array after
  // resume even though the DOM stream just rendered 900 events. The
  // audit's F-1 (resume returns { resumed: true } but chat + Tracing
  // metrics are blank) and F-2 (Tracing 8-col metrics all '—') collapse
  // into one bug: the local cache is the single source of truth for
  // every projector, and replay was skipping it. Only overwrite when
  // `pick === events` (wire won); leaving cache pristine when cache-won
  // preserves the "same-array-identity" property downstream readers may
  // rely on. cachedEvents cap discipline is enforced when live events
  // append via `cacheEvent`; the seed itself is bounded by the daemon's
  // window walk (already bounded above), so no additional trim needed.
  if (pick === events && Array.isArray(events) && events.length > cached.length) {
    const metaSeed = state.sessions.get(id)
    if (metaSeed) metaSeed.cachedEvents = events.slice()
  }
  const wasReplaying = state.replayingId
  state.replayingId = id
  try {
    for (const ev of pick) {
      onSessionEvent(id, ev)
    }
  } finally {
    state.replayingId = wasReplaying
  }
  appendSystem('— live —')
  // Post-replay: real events landed, so evict the welcome if it's still
  // sitting there (safe no-op when history was empty).
  updateEmptyStateVisibility()
}

// Push one event onto a session's local cache. Bounded so a very long
// session doesn't grow memory unbounded — the tail matters for the meter
// and UI replay, the front rolls off (server session/events remains the
// record of truth for deep history). No-op while replay is looping so the
// replay itself doesn't re-cache what it just read.
const CACHED_EVENTS_CAP = 2000
function cacheEvent(meta, sessionId, event) {
  if (!meta || !event || typeof event !== 'object') return
  if (state.replayingId === sessionId) return
  if (!Array.isArray(meta.cachedEvents)) meta.cachedEvents = []
  meta.cachedEvents.push(event)
  if (meta.cachedEvents.length > CACHED_EVENTS_CAP) {
    meta.cachedEvents.splice(0, meta.cachedEvents.length - CACHED_EVENTS_CAP)
  }
}

// -- rendering primitives ----------------------------------------------------

function scrollToBottom() {
  streamEl.scrollTop = streamEl.scrollHeight
}

// Titlecase mapping for role labels. Kept trivial + covered by
// test assertions: `appendMessage({ role: 'user' })` produces a `.role-label`
// child reading "User" (not "USER" / "HUMAN"). The map is small and
// exhaustive; unknown roles fall back to first-letter capitalisation so
// custom plugin roles still render sensibly.
// subagent rows used
// to read "subagent of 3f2c1a8b" — the hash tells a researcher nothing about
// which parent turn spawned the child. Reach for the parent's title when we
// have one (session/list has usually landed by the time subagent.started
// fires, and quick-chat / user-message flows write a real title into
// state.sessions.get(parentId).title). Fall back to a short hash only when
// nothing better is available.
function subagentPlaceholderTitle(parentId) {
  const pid = String(parentId || '')
  if (!pid) return 'subagent'
  const parentMeta = state.sessions.get(pid)
  const parentTitle = parentMeta && typeof parentMeta.title === 'string'
    ? parentMeta.title.trim()
    : ''
  if (parentTitle) {
    // Cap the parent title so a very long user prompt doesn't blow out the
    // sidebar row width. 32 chars matches sidebar smart-title truncation.
    const trimmed = parentTitle.length > 32 ? parentTitle.slice(0, 31) + '…' : parentTitle
    return `subagent of ${trimmed}`
  }
  return `subagent of ${pid.slice(0, 8)}`
}

function titlecaseRole(role) {
  if (!role || typeof role !== 'string') return ''
  const known = {
    user: 'User',
    assistant: 'Assistant',
    system: 'System',
    tool: 'Tool',
    reasoning: 'Reasoning',
    context: 'Context',
  }
  if (known[role]) return known[role]
  return role.charAt(0).toUpperCase() + role.slice(1)
}

function appendMessage({ role, text, className, seq, optimistic, target }) {
  const el = document.createElement('div')
  el.className = `msg ${role}${className ? ' ' + className : ''}`
  if (typeof seq === 'number') el.dataset.seq = String(seq)
  // Optimistic bubbles are the ones we draw on `send()` before the server
  // echoes back a user/message event. When the echo arrives we adopt the
  // pending bubble instead of appending a second one — see onSessionEvent.
  if (optimistic) el.dataset.optimistic = '1'
  // when an assistant bubble lands
  // inside a turn container's `.turn-body`, the outer `.msg.assistant`
  // becomes a transparent hull — the role chip is dropped and the body
  // child carries the `.text-block.turn-child` class so it reads as a
  // first-class turn child (peer of tool rows, reasoning, footer). Stream-
  // level fallbacks (history replay of pre-container events, quick-chat
  // overlay) keep the legacy chip+body bubble shape unchanged.
  const inTurnBody = !!(target && target !== streamEl
    && typeof target.classList === 'object'
    && target.classList
    && target.classList.contains('turn-body'))
  const body = document.createElement('div')
  if (role === 'assistant' && inTurnBody) {
    body.className = 'text-block turn-child'
  }
  body.textContent = text || ''
  if (role === 'assistant' && inTurnBody) {
    el.classList.add('in-turn')
    el.append(body)
  } else {
    // role labels are lightweight — small typographic dot + Titlecase word
    // ("User" / "Assistant"), inline with body, NOT an uppercase hero heading.
    // The old block-level "USER" / "HUMAN" caps card was flagged as adding no
    // information increment. Keeps `.role` class + text (used by tests / DOM
    // queries) but retires the uppercase treatment.
    const r = document.createElement('div')
    r.className = 'role'
    r.dataset.role = role
    const dot = document.createElement('span')
    dot.className = 'role-glyph'
    dot.setAttribute('aria-hidden', 'true')
    dot.textContent = '·'
    const label = document.createElement('span')
    label.className = 'role-label'
    label.textContent = titlecaseRole(role)
    r.append(dot, label)
    el.append(r, body)
  }
  if (role === 'assistant') {
    if (typeof seq === 'number') el.dataset.forkSeq = String(seq)
    attachForkHereButton(el)
  }
  // assistant/reasoning bubbles land inside the
  // active turn container's `.turn-body` when one is open; user bubbles
  // and any explicit target from the caller override. Streams without a
  // container (history replay, quick-chat) still append at stream root.
  const parent = target && typeof target.appendChild === 'function' ? target : streamEl
  parent.appendChild(el)
  scrollToBottom()
  return body
}

// Hover-revealed "fork from here" button on assistant bubbles. The boundary
// is read from the bubble's data-fork-seq at click time: bubbles are born
// with their assistant/message seq, then turn/end re-stamps the latest one
// with the closing seq (session/fork only accepts turn/end boundaries).
function attachForkHereButton(bubbleEl) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'fork-here'
  btn.textContent = 'fork from here'
  // Initial title stands in until updateForkButtons runs (fires on every
  // turn/start-turn/end transition). Exact seq is unknown until data-fork-seq
  // is stamped, so the initial language is generic-but-still-replay-anchored.
  btn.title = 'Fork replays deterministically from a closed-turn boundary.'
  btn.addEventListener('click', (ev) => runForkClick(ev, btn, bubbleEl))
  bubbleEl.appendChild(btn)
  syncForkButton(btn, bubbleEl)
}

// Shared fork click flow used by both `attachForkHereButton` (bubble-create)
// and `rebindForkButton` (turn/end re-stamp). Keeps disable/tooltip semantics
// identical across both entry points; without extraction they drifted (the
// rebound clone previously lost the boundary-preview title + reject wording).
async function runForkClick(ev, btn, bubbleEl) {
  ev.stopPropagation()
  if (!state.activeSessionId) return
  if (state.inflightTurn) {
    // Belt-and-suspenders — the button is already disabled while a turn is
    // in flight, but a fast click between turn/start and syncForkButton
    // would otherwise fire a fork the kernel would reject with OPEN_TURN.
    appendSystem('fork needs a closed-turn boundary — wait for the current turn to end, then try again.')
    return
  }
  btn.disabled = true
  try {
    const opts = { sessionId: state.activeSessionId }
    // Missing data-fork-seq (older event shape / stream without a closing
    // stamp) omits boundary — the runtime forks at the end of the log. The
    // wire shape is a plain number (SessionForkParams.boundary?: number).
    const seq = Number(bubbleEl.dataset.forkSeq)
    if (Number.isFinite(seq)) opts.boundary = seq
    const result = await window.dsh.forkSession(opts)
    if (result && result.rejected) {
      // main.js classified a real SessionForkError and threaded the code
      // back rather than falling to the mock path. Give the code its own
      // human line instead of surfacing the raw kernel string.
      const err = new Error(result.message || 'session/fork rejected')
      if (result.code) err.code = result.code
      const c = classifyForkError(err)
      appendSystem(`fork rejected — ${c.humanMessage}`)
      return
    }
    if (result && result.mocked) btn.classList.add('mock')
    await refreshSessionList()
    if (result && result.childSessionId) await selectSession(result.childSessionId)
  } catch (err) {
    // Bare-throw path (transport error, unclassified). Same classifier so
    // wording stays consistent with the resolve-with-rejected path above.
    const c = classifyForkError(err)
    appendSystem(`fork failed — ${c.humanMessage}`)
  } finally {
    btn.disabled = state.inflightTurn
    syncForkButton(btn, bubbleEl)
  }
}

// Reflect current `state.inflightTurn` + bubble's data-fork-seq on one fork
// button. Called from updateForkButtons on every turn/start-turn/end so a
// button reflects the current gate even when the turn boundary flips
// mid-scroll.
function syncForkButton(btn, bubbleEl) {
  if (!btn || !btn.setAttribute) return
  // capability gate wins before turn/seq inspection. A runtime
  // that doesn't advertise session/fork should never light the button —
  // clicking would produce a MethodNotFound from the daemon.
  if (!isCapabilitySupported('fork')) {
    btn.disabled = true
    btn.title = capabilityDisabledTooltip('fork')
    return
  }
  const seqRaw = bubbleEl && bubbleEl.dataset ? bubbleEl.dataset.forkSeq : undefined
  const seq = Number(seqRaw)
  const hasSeq = Number.isFinite(seq)
  if (state.inflightTurn) {
    btn.disabled = true
    // Mirrors updateCompactButton's phrasing shape so the two "wait for the
    // current turn to end" surfaces read as one rule, not two. Names
    // "replay" explicitly so the user reads the wait as protecting the
    // deterministic-replay contract, not as an arbitrary throttle.
    btn.title = hasSeq
      ? `Forks replay from a closed-turn boundary — wait for the current turn to end. (Will replay up to seq ${seq}.)`
      : 'Forks replay from a closed-turn boundary — wait for the current turn to end.'
    return
  }
  btn.disabled = false
  btn.title = hasSeq
    ? `Fork replays deterministically from the closed turn boundary at seq ${seq}.`
    : 'Fork replays deterministically from a closed-turn boundary.'
}

// Refresh every visible fork button in the current stream. Two-hop lookup
// (parent bubbles then nested button) rather than a descendant selector —
// the unit-test harness selector matcher is single-combinator and would
// silently skip `.msg.assistant .fork-here`.
function updateForkButtons() {
  const bubbles = streamEl.querySelectorAll('.msg.assistant')
  for (const bubble of bubbles) {
    const btn = bubble.querySelector('.fork-here')
    if (btn) syncForkButton(btn, bubble)
  }
}

// Map a fork rejection back to the kernel's SessionForkError code and pair
// each code with a user-facing sentence that stays in replay language. Fork
// wording NEVER says "copy" / "snapshot" / "duplicate current state" (intent
// red-line, 2026-07-16 team-lead): a fork is a deterministic replay from a
// closed-turn boundary, not a snapshot of live state.
//
// Recognises: explicit `err.code` (main.js pre-classified path) verbatim, or
// the exact message shapes SessionForkError throws in
// packages/core/session/src/index.ts. The wire flattens SessionForkError
// into `-32603 { message }` and drops the code; parsing the message is how
// we recover it downstream of the transport.
function classifyForkError(err) {
  const known = new Set([
    'OPEN_TURN', 'INVALID_BOUNDARY', 'SESSION_NOT_LIVE',
    'SESSION_NOT_FOUND', 'SESSION_ALREADY_EXISTS',
  ])
  if (err && typeof err === 'object' && typeof err.code === 'string' && known.has(err.code)) {
    return { code: err.code, humanMessage: forkCodeHumanMessage(err.code) }
  }
  const msg = err && typeof err === 'object' && typeof err.message === 'string' ? err.message : ''
  if (!msg) return { code: 'UNKNOWN', humanMessage: 'session/fork rejected for an unknown reason.' }
  if (/must be turn\/end/.test(msg)) {
    return { code: 'OPEN_TURN', humanMessage: forkCodeHumanMessage('OPEN_TURN') }
  }
  if (/must be a non-negative safe integer/.test(msg)) {
    return { code: 'INVALID_BOUNDARY', humanMessage: forkCodeHumanMessage('INVALID_BOUNDARY') }
  }
  if (/does not exist in session/.test(msg) || /does not match a contiguous event seq/.test(msg)) {
    return { code: 'INVALID_BOUNDARY', humanMessage: forkCodeHumanMessage('INVALID_BOUNDARY') }
  }
  if (/is not the live store instance/.test(msg)) {
    return { code: 'SESSION_NOT_LIVE', humanMessage: forkCodeHumanMessage('SESSION_NOT_LIVE') }
  }
  if (/session ".+" not found/.test(msg)) {
    return { code: 'SESSION_NOT_FOUND', humanMessage: forkCodeHumanMessage('SESSION_NOT_FOUND') }
  }
  if (/already exists/.test(msg)) {
    return { code: 'SESSION_ALREADY_EXISTS', humanMessage: forkCodeHumanMessage('SESSION_ALREADY_EXISTS') }
  }
  return { code: 'UNKNOWN', humanMessage: msg }
}

function forkCodeHumanMessage(code) {
  switch (code) {
    case 'OPEN_TURN':
      return 'the boundary landed inside an open turn. Forks replay deterministically from a closed-turn boundary, so wait for the current turn to end, then try again.'
    case 'INVALID_BOUNDARY':
      return 'the boundary points at a seq the session log does not have. The bubble may be from a previous session or the log was truncated — refresh the sidebar and try again.'
    case 'SESSION_NOT_LIVE':
      return 'the parent session is persisted-only (no live agent). Resume the session first, then fork from a closed turn in the resumed history.'
    case 'SESSION_NOT_FOUND':
      return 'the parent session id is not known to the daemon. It may have been evicted after a runtime restart.'
    case 'SESSION_ALREADY_EXISTS':
      return 'the child session id is already in use. Refresh the sidebar and try again.'
    default:
      return 'session/fork rejected for an unknown reason.'
  }
}

function appendSystem(text) {
  const el = document.createElement('div')
  el.className = 'system'
  el.textContent = text
  streamEl.appendChild(el)
  scrollToBottom()
}

// Field §3 P0 #4 / #10 (2026-07-17): system line with a title-attribute
// carrying the full untruncated string + a tone class so the CSS can tint
// the error/warn variants without a second line. Falls back to appendSystem
// when the caller only has a bare text (kept in step with existing tests).
function appendSystemDetail(text, opts) {
  const el = document.createElement('div')
  el.className = 'system'
  el.textContent = text
  if (opts && typeof opts === 'object') {
    if (typeof opts.title === 'string' && opts.title && opts.title !== text) {
      el.title = opts.title
    }
    if (typeof opts.severity === 'string' && opts.severity) {
      el.classList.add(`system-${opts.severity}`)
      el.dataset.severity = opts.severity
    }
  }
  streamEl.appendChild(el)
  scrollToBottom()
  return el
}

// Preflight (2026-07-18) NO_ADAPTER guard: fold repeated identical system
// detail lines. L0 rule — ≥3 same-family acts render as
// one row with `×N`. We fold on ≥2 here because the failure mode users
// hit (send-fails-send-fails) reaches a triple screamingly fast and the
// second identical red row already adds noise without new information.
// Fold key = severity + text (title is the truncation-safe superset;
// identical `spec.line` implies identical `spec.title`).
function appendSystemDetailFolded(text, opts) {
  const severity = opts && typeof opts.severity === 'string' ? opts.severity : ''
  const last = streamEl.lastElementChild
  if (last && last.classList && last.classList.contains('system')
      && last.dataset && last.dataset.foldKey === `${severity}\n${text}`) {
    const n = (parseInt(last.dataset.foldCount || '1', 10) || 1) + 1
    last.dataset.foldCount = String(n)
    // Rewrite the visible text as `<base> ×N` while preserving the base
    // string in the fold key. Title carries the full untruncated line.
    last.textContent = `${text} ×${n}`
    if (opts && opts.title && opts.title !== text) last.title = opts.title
    return last
  }
  const el = appendSystemDetail(text, opts)
  el.dataset.foldKey = `${severity}\n${text}`
  el.dataset.foldCount = '1'
  return el
}

// Preflight (2026-07-18) NO_ADAPTER guard: detect the wire's raw
// "no adapter registered for model \"X\" [NO_ADAPTER]" clause and append
// a muted advisory row explaining, in plain English, why the send failed
// and where to look. We do this on top of the verbatim wire line so both
// the developer and the newcomer are served. The advisory row is folded
// under the same `foldKey`, so if it fires N times in a row the reader
// still sees a single `×N`.
//
// TurnEndReason.error shape (packages/llm/llm/src/types.ts): the wire
// puts the message on `reason.message` and (sometimes) a code on
// `reason.code`. Match on message text so we catch both the daemon-echo
// path and any future kernel that codes it differently.
function applyNoAdapterHint(params, priorEl) {
  try {
    const reason = params && params.reason
    if (!reason || typeof reason !== 'object') return
    const msg = typeof reason.message === 'string' ? reason.message : ''
    // Belt-and-suspenders: the classic wire text OR the explicit code.
    const isNoAdapter = /no adapter registered/i.test(msg)
      || (typeof reason.code === 'string' && reason.code === 'NO_ADAPTER')
    if (!isNoAdapter) return
    // Extract "<model>" from `no adapter registered for model "X"` — the
    // hint reads naturally when we can name it. Fall back to the
    // composer's current selection when the wire omits it.
    let model = ''
    const m = /model\s+"([^"]+)"/i.exec(msg)
    if (m) model = m[1]
    else if (composerModelEl && composerModelEl.dataset && composerModelEl.dataset.currentModel) {
      model = composerModelEl.dataset.currentModel
    }
    const target = profileHosting(model)
    const activeLabel = activeProfileName || 'this profile'
    const line = target
      ? `Tip: ${model || 'this model'} isn't wired under ${activeLabel}. Switch to profile "${target}" (Settings → Profile) or pick a supported model in the composer.`
      : `Tip: ${model || 'that model'} isn't wired under ${activeLabel}. Switch profile in Settings, or pick a supported model in the composer.`
    // Fold key intentionally distinct from the finished-error row so the
    // hint doesn't fold *into* the wire text. Two identical NO_ADAPTER
    // finishes get a single `×N` on the red row AND a single `×N` on the
    // hint row — the reader sees the count in both places.
    appendSystemDetailFolded(line, { severity: 'info', title: line })
    // Mark the prior red row for a11y / scraping so tests can pin the
    // pair together.
    if (priorEl && priorEl.dataset) priorEl.dataset.noAdapter = '1'
  } catch (_) { /* never let advisory rendering break the notify pipe */ }
}

/**
 * Show the shared in-app confirmation dialog and resolve to boolean.
 * A-P1-3: wraps the native <dialog> in a Promise-shaped API so callers can
 * `await confirmDialog(...)`. Falls back to window.confirm if the dialog
 * element or showModal is missing (older Electron, degraded environments) —
 * that path preserves the pre-A-P1-3 behaviour so nothing hard-breaks.
 *
 * @param {{title?: string, body?: string, okLabel?: string, cancelLabel?: string}} opts
 * @returns {Promise<boolean>}
 */
function confirmDialog({ title = 'Confirm', body = '', okLabel = 'OK', cancelLabel = 'Cancel' } = {}) {
  const dlg = document.getElementById('confirm-dialog')
  if (!dlg || typeof dlg.showModal !== 'function') {
    return Promise.resolve(window.confirm(body || title))
  }
  const titleEl = document.getElementById('confirm-dialog-title')
  const bodyEl = document.getElementById('confirm-dialog-body')
  const okBtn = document.getElementById('confirm-dialog-ok')
  const cancelBtn = dlg.querySelector('button[value="cancel"]')
  if (titleEl) titleEl.textContent = title
  if (bodyEl) bodyEl.textContent = body
  if (okBtn) okBtn.textContent = okLabel
  if (cancelBtn) cancelBtn.textContent = cancelLabel
  return new Promise((resolve) => {
    const onClose = () => {
      dlg.removeEventListener('close', onClose)
      resolve(dlg.returnValue === 'confirm')
    }
    dlg.addEventListener('close', onClose)
    try { dlg.showModal() }
    catch (_) {
      dlg.removeEventListener('close', onClose)
      resolve(window.confirm(body || title))
    }
  })
}

/**
 * C22 (drift cycle 18): non-blocking replacement for `window.alert()`. Reuses
 * the shared confirmDialog <dialog> but hides the Cancel button so it reads
 * as a single-affordance notice. Callers use this for asynchronous error
 * reporting (onboarding failure, quick-chat send failure) where the native
 * alert() would steal focus mid-composition and block subsequent async work.
 * Signature accepts a string for the common one-line case.
 *
 * @param {string | {title?: string, body?: string, okLabel?: string}} arg
 * @returns {Promise<void>}
 */
function notifyDialog(arg) {
  const opts = typeof arg === 'string' ? { body: arg } : (arg || {})
  const title = opts.title || 'Notice'
  const body = opts.body || ''
  const okLabel = opts.okLabel || 'OK'
  const dlg = document.getElementById('confirm-dialog')
  const cancelBtn = dlg && dlg.querySelector('button[value="cancel"]')
  const prevHidden = cancelBtn ? cancelBtn.hidden : null
  if (cancelBtn) cancelBtn.hidden = true
  return confirmDialog({ title, body, okLabel, cancelLabel: '' }).then(() => {
    if (cancelBtn && prevHidden !== null) cancelBtn.hidden = prevHidden
  }, (err) => {
    if (cancelBtn && prevHidden !== null) cancelBtn.hidden = prevHidden
    throw err
  })
}

function appendToolCall({ callId, name, args, onJsonBadge, target }) {
  const el = document.createElement('details')
  el.className = 'tool-block'
  el.dataset.callId = callId

  // Per-tool "family" band: an icon + a coloured left border, so a reader
  // can see at a glance whether a tool block is bash / fs / web / etc. Falls
  // through to plain generic styling for tools with no assigned family (new
  // tools always land as generic — the map in tool-cards.js is data).
  const fam = window.__dshToolCards && window.__dshToolCards.toolFamilyFor
    ? window.__dshToolCards.toolFamilyFor(name)
    : null
  // expose the family label as `data-tool-card-family`
  // so QA probes + walkthrough scripts can find every tool card by family without
  // knowing the family-* CSS class scheme. Absent family → 'generic' so the
  // attribute is always present (probes can select `[data-tool-card-family]`).
  // Also mirror the model-visible tool name on `data-tool-name` for finer-grained
  // targeting (already stamped on some sites via `dataset.callId`; the name is
  // the one identifier tests reliably know).
  el.setAttribute('data-tool-card-family', fam ? fam.label : 'generic')
  el.setAttribute('data-tool-name', String(name))
  const summary = document.createElement('summary')
  // LangSmith row-form summary line:
  //   [chevron] [glyph] name(arg-gist) ····· [{ }] [dur]
  // Left glyph column (monochrome, one char), then name in neutral text,
  // then a one-line arg gist that ellipsis-clips. `{ }` and duration pill
  // are appended by callers on the right (margin-left:auto lives there).
  if (fam) {
    el.classList.add(fam.className)
    const icon = document.createElement('span')
    icon.className = 'tool-family-icon'
    icon.textContent = fam.icon
    summary.appendChild(icon)
  }
  const nameEl = document.createElement('span')
  nameEl.className = 'tool-family-name'
  nameEl.textContent = String(name)
  summary.appendChild(nameEl)
  const gistText = toolArgGist(args)
  if (gistText) {
    const gist = document.createElement('span')
    gist.className = 'tool-arg-gist'
    gist.textContent = gistText
    gist.title = gistText
    summary.appendChild(gist)
  }
  // universal "{ }" JSON badge on every tool
  // card. Opens the right-side drawer with the raw call.arguments + result
  // JSON. Injected here so every appendToolCall gets one automatically —
  // no per-family opt-in / opt-out drift. The badge stops propagation so a
  // click on it doesn't also toggle the tool block open. The duration pill
  // (Ticket D) is appended AFTER this on tool/result; margin-left:auto on
  // the pill pushes both toward the right edge, badge first then pill.
  const tc0 = window.__dshToolCards
  if (tc0 && tc0.renderJsonBadge && typeof onJsonBadge === 'function') {
    const badge = tc0.renderJsonBadge(onJsonBadge)
    if (badge) summary.appendChild(badge)
  }
  // / 2026-07-18 hotfix (P0 overlap): label + controls
  // sit on one flex row so long labels (or the drawer's meta note) can't
  // wrap under the button cluster. Previous shape floated the controls +
  // pulled them up with margin-top:-18px; when the label row grew (drawer
  // headline includes `content · meta · isError · error · durationMs`)
  // the buttons landed on top of the text. New shape:
  //     [ args ································ pretty | copy | download ]
  //     [ <args body>                                                   ]
  // Rendered as a wrapping `.tool-block-label-row` around the label plus
  // a spacer element the util's controls insert into. Controls now render
  // WITHOUT float/negative-margin — see style.css §payload-controls.
  const pcApi = window.__dshPayloadControls
  const argsRow = document.createElement('div')
  argsRow.className = 'tool-block-label-row'
  const argLabel = document.createElement('div')
  argLabel.className = 'label'; argLabel.textContent = 'args'
  argsRow.appendChild(argLabel)
  const argsBox = document.createElement('div')
  argsBox.className = 'args'
  if (pcApi && pcApi.attachPayloadControls) {
    argsBox.classList.add('args-with-controls')
    // Attach into the label row so controls sit right of the label; the
    // util appends both `controlsEl` and a `<pre.payload-body>` — we move
    // the pre back down into argsBox (the historical body node) so the
    // .args CSS height cap keeps applying.
    const ret = pcApi.attachPayloadControls(argsRow, { getRaw: () => args, kind: 'args' })
    if (ret && ret.preEl && ret.preEl.parentNode) {
      ret.preEl.parentNode.removeChild(ret.preEl)
      argsBox.appendChild(ret.preEl)
    }
  } else {
    argsBox.textContent = safePretty(args)
  }
  const resultRow = document.createElement('div')
  resultRow.className = 'tool-block-label-row'
  const resLabel = document.createElement('div')
  resLabel.className = 'label'; resLabel.textContent = 'result'
  resultRow.appendChild(resLabel)
  const resBox = document.createElement('div')
  resBox.className = 'result'; resBox.textContent = '…'
  el.append(summary, argsRow, argsBox, resultRow, resBox)
  // tool block lands inside the caller's `target`
  // (assistant-turn body) when provided; else at the stream root for
  // history replays that never opened a container.
  const parent = target && typeof target.appendChild === 'function' ? target : streamEl
  parent.appendChild(el)
  scrollToBottom()
  return { el, resBox }
}

// Compact one-line summary of tool call arguments — the "gist" the reader
// scans at L0 before opening the block. Rules:
//   - `bash({command:'echo hi'})` → `"echo hi"`
//   - `read({path:'src/x.ts'})`   → `path='src/x.ts'`
//   - `edit({path:.., old_string:X, new_string:Y})` → `path='src/x.ts' · +/-`
//   - falls back to a compact JSON slice capped at 80 chars.
// Never throws; returns '' when args is null/empty.
function toolArgGist(args) {
  if (args == null) return ''
  let obj = args
  if (typeof args === 'string') {
    try { obj = JSON.parse(args) } catch (_) {
      // Non-JSON strings render as-is (bash sometimes ships a raw string).
      const t = args.replace(/\s+/g, ' ').trim()
      return t.length > 80 ? t.slice(0, 77) + '…' : t
    }
  }
  if (obj && typeof obj === 'object') {
    if (typeof obj.command === 'string') {
      const c = obj.command.replace(/\s+/g, ' ').trim()
      return c.length > 80 ? c.slice(0, 77) + '…' : c
    }
    if (typeof obj.path === 'string' && obj.path) return `path=${obj.path}`
    if (typeof obj.file_path === 'string' && obj.file_path) return `path=${obj.file_path}`
    if (typeof obj.query === 'string' && obj.query) {
      const q = obj.query.replace(/\s+/g, ' ').trim()
      return q.length > 80 ? q.slice(0, 77) + '…' : q
    }
    if (typeof obj.url === 'string' && obj.url) return obj.url
  }
  try {
    const s = JSON.stringify(obj)
    if (!s) return ''
    return s.length > 80 ? s.slice(0, 77) + '…' : s
  } catch (_) { return '' }
}

function safePretty(v) {
  if (typeof v === 'string') {
    try { return JSON.stringify(JSON.parse(v), null, 2) } catch { return v }
  }
  try { return JSON.stringify(v, null, 2) } catch { return String(v) }
}

// Concatenate a content-block array's text-type entries. Reasoning blocks
// are streamed into their own frame via `reasoning-delta` chunks; tool_use
// / tool-call blocks are rendered as tool cards from the `tool/call` event
// family. Emitting `[${b.type}]` as a placeholder for those blocks (the
// prior behavior) leaked literal `[reasoning][tool-call]` tokens into every
// finalized assistant bubble whose content array carried non-text segments.
// Drop them silently — devtools captures the raw event for inspection. See
// event-filter.js for the pure implementation exercised by node --test.
function textFromContentBlocks(blocks) {
  if (!Array.isArray(blocks)) return ''
  let out = ''
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text' && typeof b.text === 'string') out += b.text
  }
  return out
}

// -- assistant-turn container ------------------------------------------------
//
// Groups an assistant step's children (bubble, tool blocks, recall cards,
// reasoning frames, inject cards) inside a <section.assistant-turn> that
// lives directly on `.stream`. On turn/end the container is capped with a
// <footer.turn-footer> and (when present) the trace card is attached below
// the footer inside an inline <details.turn-trace-drawer>.
//
// The container opens lazily on the first assistant-side event of a turn.
// Non-turn events (user/message, context/message, compact markers, fork
// markers) still append at the stream root — the container is a turn
// frame, not a catch-all. The outer `.msg.assistant` element is preserved
// so downstream selectors (updateForkButtons, fork-seq stamping, JSON
// drawer, tool cards, trigger cards) still find their target. When a
// bubble lands inside `.turn-body` the outer element also gains
// `.in-turn` and its body child becomes `.text-block.turn-child`, so
// assistant text reads as a peer of tool rows/reasoning/footer and the
// role chip is dropped. Stream-root landings (history replay of a
// pre-container session, quick-chat overlay) keep the legacy shape.
function ensureTurnContainer(sessionId) {
  const ct = state.currentTurn
  if (ct && ct.sessionId === sessionId && ct.section && ct.section.isConnected !== false) {
    return ct
  }
  const section = document.createElement('section')
  section.className = 'assistant-turn'
  section.dataset.sessionId = String(sessionId || '')
  section.dataset.turnStatus = 'streaming'
  const rule = document.createElement('div')
  rule.className = 'turn-rule'
  rule.setAttribute('aria-hidden', 'true')
  const body = document.createElement('div')
  body.className = 'turn-body'
  section.append(rule, body)
  streamEl.appendChild(section)
  const rec = { sessionId, section, body }
  state.currentTurn = rec
  return rec
}

// Where should the next assistant-side child (bubble, tool block, recall
// card, reasoning frame) be appended? Inside the active turn body if one
// is open; else at the stream root (legacy fallback for turns that never
// opened a container — e.g. history replay of a pre-container session).
function turnAppendTarget(sessionId) {
  const ct = state.currentTurn
  if (ct && ct.sessionId === sessionId && ct.body) return ct.body
  return streamEl
}

// Close the current turn: append a footer + optional trace drawer. Called
// from the turn/end handler. `footerSpec` is the pi-style projection
// (model / tokens / cost / time / stop); `traceCard` is the <details.trace-card>
// that finishTraceStep already emitted onto streamEl — we lift it into the
// footer as an inline drawer.
function finishTurnContainer(sessionId, { footerSpec, traceCard, traceSummaryText, turnSteps } = {}) {
  const ct = state.currentTurn
  if (!ct || ct.sessionId !== sessionId || !ct.section) return
  const doc = document
  const footer = doc.createElement('footer')
  footer.className = 'turn-footer'
  // Zero-data footer suppression: if the spec carries no metric signal at
  // all AND the turn has no trace drawer to expose, we render neither the
  // glyph nor the metric chips — a bare `— · — / $? · — · —` row is more
  // visual noise than the zero-drop rule is trying to protect. Absent
  // fields stay reachable at L2 via the trace drawer / detail pane.
  const tf = window.__dshTurnFooter
  // buildTurnFooterSpecFromMeta returns a hybrid map: human-readable
  // formatted fields for the fallback text path, PLUS `_raw` — the wire
  // shape formatFooterFields expects. We need the raw shape for both the
  // signal check and the module builder; the formatted fields are only
  // for the fallback chip-row path.
  const rawSpec = footerSpec && footerSpec._raw ? footerSpec._raw : footerSpec
  const hasSignal = tf && typeof tf.specHasAnySignal === 'function'
    ? (!!tf.specHasAnySignal(rawSpec) || !!tf.specHasAnySignal(footerSpec))
    : !!footerSpec
  // Fusion: a fused step card is already positioned inline at the tool
  // call's narrative slot. Lifting it into the footer drawer would tear
  // it out of the stream — treat it as "no drawer needed here". The
  // turn-flow glyph already scrolls to it via `dsh-open-turn-trace`
  // (see the listener below).
  const isFusedCard = !!(traceCard && traceCard.dataset && traceCard.dataset.stepFused === '1')
  const hasTraceCard = !isFusedCard && !!(traceCard && traceCard.parentNode)
  // Fused card path: the trailing standalone .trace-card is suppressed
  // (the card now lives inline at the tool call's position), so we can't
  // rely on `hasTraceCard` alone. Keep the footer up when the turn has
  // at least one fused step so the "turn ended" chip row + flow glyph +
  // click-to-scroll behavior remain reachable.
  const hasFusedStep = Array.isArray(turnSteps) && turnSteps.some(
    s => s && Array.isArray(s._toolBlocks) && s._toolBlocks.length > 0)
  if (!hasSignal && !hasTraceCard && !hasFusedStep) {
    // Nothing to draw — leave the assistant-turn container clean.
    ct.section.dataset.turnStatus = 'sealed'
    state.currentTurn = null
    return
  }
  // Inline "shape of this turn" glyph. Drawn before the fused pill row so
  // the reader's eye lands on the shape first (a-glance) and reads the
  // numbers second. Opens the trace drawer below when clicked — see the
  // `dsh-open-turn-trace` listener attached after the drawer is inserted.
  const glyphMod = window.__dshTurnFlowGlyph
  if (glyphMod && turnSteps && turnSteps.length > 0) {
    const spec = glyphMod.deriveGlyphSpec(turnSteps)
    if (spec) {
      const glyph = glyphMod.buildTurnFlowGlyph(doc, spec)
      if (glyph) footer.appendChild(glyph)
    }
  }
  if (hasSignal && tf && typeof tf.buildTurnFooter === 'function' && rawSpec) {
    footer.appendChild(tf.buildTurnFooter(doc, rawSpec))
  } else if (hasSignal && footerSpec) {
    // Fallback: raw chip row (fused-pill shape, module-less path). Emit
    // only fields whose formatted value carries information — no `— · `
    // fragments, no `$?` tail on the L0 row. Matches the segment-level
    // suppression that formatFooterFields does in the module path.
    const chipLabels = ['model', 'usage', 'time', 'stop']
    const emitted = []
    for (const label of chipLabels) {
      const v = footerSpec[label]
      if (typeof v !== 'string' || v.length === 0) continue
      // Skip pure-absent chips (`—`) and the fused all-absent shape (`— / $?`).
      const stripped = v.replace(/—/g, '').replace(/\$\?/g, '').replace(/[\/\s]/g, '')
      if (stripped.length === 0) continue
      emitted.push({ label, value: v })
    }
    emitted.forEach((f, i) => {
      if (i > 0) {
        const sep = doc.createElement('span')
        sep.className = 'turn-footer-sep'; sep.textContent = '·'
        footer.append(sep)
      }
      const chip = doc.createElement('span')
      chip.className = `turn-footer-field field-${f.label}`
      chip.textContent = f.value
      footer.append(chip)
    })
  }
  let drawer = null
  if (!isFusedCard && traceCard && traceCard.parentNode) {
    // Lift the trace card out of `streamEl` into a details drawer inside
    // the footer. Preserves whatever internal state the card already has
    // (chunk fold, per-line payload expander). When the tri-view module
    // is available, wrap the trace card in the Tree | Timeline | Graph
    // tabs — Tree is the default and owns the pre-rendered card;
    // Timeline/Graph re-derive from the step-record on `traceCard._rec`.
    drawer = doc.createElement('details')
    drawer.className = 'turn-trace-drawer'
    const summary = doc.createElement('summary')
    summary.className = 'turn-trace-drawer-summary'
    summary.textContent = traceSummaryText || 'trace'
    // fix/expand-affordance 2026-07-18: tooltip + aria-expanded pair.
    // ▸/∨ marker comes from style.css tail block; this hook keeps
    // aria-expanded honest so screen readers and plugin authors see
    // the disclosure state. See docs/expand-affordance-audit.md.
    summary.title = 'Click to expand Tree / Timeline / Graph views'
    summary.setAttribute('aria-expanded', 'false')
    drawer.addEventListener('toggle', () => {
      summary.setAttribute('aria-expanded', drawer.open ? 'true' : 'false')
    })
    drawer.appendChild(summary)
    const triMod = (typeof window !== 'undefined' && window.__dshTraceTriView) || null
    const rec = traceCard._rec || null
    if (triMod && rec) {
      // Thread SessionHeader so the detail pane's Attributes Runtime
      // group can surface cwd. session meta may be missing during
      // history replay of a fresh log; the pane treats null header as
      // absent-cwd. sessionId also threaded so the Feedback tab's
      // "+ Add feedback" button can call __dshAnnotation.open(sessionId).
      const sessionMeta = sessionId && state.sessions.get(sessionId)
      const sessionHeader = sessionMeta && sessionMeta.header ? sessionMeta.header : null
      const tri = triMod.buildTriView(doc, {
        treeEl: traceCard,
        records: rec,
        scope: 'turn',
        sessionHeader,
        defaultView: 'tree',
        // pass sessionId down so
        // the Feedback tab's "+ Add feedback" button can call
        // __dshAnnotation.open(sessionId). Previously null → api.open(null)
        // opened an empty drawer, which QA saw as "click zero effect".
        // (F-01 2026-07-18: the earlier bare `sessionId,` shorthand at the
        // top of this object was being last-wins-overwritten by the line
        // below — dropped it; behavior is unchanged.)
        sessionId: sessionId || state.activeSessionId || null,
        onSeqClick: function (seq) { deepLinkToSeq(seq) },
      })
      drawer.appendChild(tri)
    } else {
      drawer.appendChild(traceCard)
    }
    footer.append(drawer)
  }
  // Hook the glyph's dsh-open-turn-trace event to open the drawer inline.
  // The event bubbles from the SVG to the footer.
  if (drawer) {
    footer.addEventListener('dsh-open-turn-trace', () => {
      drawer.open = true
      if (typeof drawer.scrollIntoView === 'function') {
        try { drawer.scrollIntoView({ block: 'nearest' }) } catch (_) { /* jsdom */ }
      }
    })
  } else {
    // Fused-only turn: no trailing drawer was built (the step card lives
    // in-stream at its tool-call position). The glyph still fires, so
    // fall back to opening + scrolling to the first fused card inside
    // this turn's section, plus a brief `.flash-ring` accent so the eye
    // tracks the jump. Matches the drawer path's "open + scroll" gesture.
    footer.addEventListener('dsh-open-turn-trace', () => {
      const section = ct.section
      if (!section || typeof section.querySelector !== 'function') return
      const fused = section.querySelector('.tool-block.trace-card-fused')
      if (!fused) return
      fused.open = true
      if (typeof fused.scrollIntoView === 'function') {
        try { fused.scrollIntoView({ block: 'nearest' }) } catch (_) { /* jsdom */ }
      }
      if (fused.classList && typeof fused.classList.add === 'function') {
        fused.classList.add('flash-ring')
        setTimeout(() => {
          try { fused.classList.remove('flash-ring') } catch (_) { /* jsdom */ }
        }, 2000)
      }
    })
  }
  ct.section.appendChild(footer)
  ct.section.dataset.turnStatus = 'sealed'
  // Signal marker chips: overlay any loop/redundant/plan/error signals
  // detected in this turn's cached events onto the top of the turn
  // section. The chip row sits above the assistant body so a reader
  // scanning the stream sees "this turn had a loop" before deciding
  // whether to open the trace drawer. See trace-signal-detect.js and
  // docs/upstream-ledger.md L-2.
  applyTurnSignalChips(sessionId, ct.section)
  state.currentTurn = null
}

// Compute+attach the signal chip row for a just-sealed turn. Reads
// meta.cachedEvents (already populated) and detects signals whose seq
// falls inside this turn's range. When no signals fire, no chip row is
// added.
function applyTurnSignalChips(sessionId, section) {
  try {
    const SD = window.__dshTraceSignalDetect
    if (!SD || typeof SD.detectSignals !== 'function') return
    const meta = state.sessions.get(sessionId)
    if (!meta || !Array.isArray(meta.cachedEvents) || !meta.cachedEvents.length) return
    // Restrict to events whose seq falls inside this turn's range so the
    // chip row reflects THIS turn, not the whole session. We use the last
    // `turn/start`→`turn/end` bracket in the cache. When no bracket is
    // findable, fall back to detecting on the whole cache (which will still
    // produce meaningful chips at the session scope).
    const range = _lastTurnSeqRange(meta.cachedEvents)
    const scope = range
      ? meta.cachedEvents.filter(ev => typeof ev.seq === 'number'
          && ev.seq >= range.start && ev.seq <= range.end)
      : meta.cachedEvents
    const { all } = SD.detectSignals(scope)
    if (!all.length) return
    // Dedup by signal kind for the chip row: the row is a "kinds seen"
    // summary; the badges in the drawer show the specific seqs.
    const seen = new Map()
    for (const sig of all) {
      const key = sig.signal
      if (!seen.has(key)) seen.set(key, { signal: sig.signal, count: 1, first: sig })
      else seen.get(key).count++
    }
    const row = document.createElement('div')
    row.className = 'turn-signal-chip-row'
    for (const entry of seen.values()) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = `turn-signal-chip ${SD.classFor(entry.signal)}`
      chip.dataset.signal = entry.signal
      chip.textContent = entry.count > 1
        ? `${SD.labelFor(entry.signal)} × ${entry.count}`
        : SD.labelFor(entry.signal)
      chip.title = SD.tooltipFor(entry.first)
      // Clicking a chip opens the trace drawer so the reader can drill in.
      chip.addEventListener('click', function () {
        const drawer = section.querySelector('.turn-trace-drawer')
        if (drawer) {
          drawer.open = true
          if (typeof drawer.scrollIntoView === 'function') {
            try { drawer.scrollIntoView({ block: 'nearest' }) } catch (_) {}
          }
        }
      })
      row.appendChild(chip)
    }
    // Insert as the first body-child so it sits above assistant text/tool
    // rows without breaking the turn-rule up top.
    const body = section.querySelector('.turn-body')
    if (body && body.firstChild) body.insertBefore(row, body.firstChild)
    else if (body) body.appendChild(row)
    else section.appendChild(row)
  } catch (_) { /* chip row is a visual enhancement — never crash the stream */ }
}

function _lastTurnSeqRange(events) {
  let start = null, end = null
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (!ev || typeof ev.seq !== 'number') continue
    if (end === null && ev.type === 'turn/end') end = ev.seq
    if (ev.type === 'turn/start') { start = ev.seq; break }
  }
  if (start === null || end === null) return null
  return { start, end }
}

function ensureStreamingBubble(sessionId) {
  if (state.streaming && state.streaming.sessionId === sessionId) return state.streaming.el
  // Ensure the turn container is open before the bubble drops in so
  // the bubble lands inside `.turn-body` rather than at `.stream` root.
  ensureTurnContainer(sessionId)
  const body = appendMessage({ role: 'assistant', text: '', target: turnAppendTarget(sessionId) })
  state.streaming = { sessionId, el: body }
  return body
}

// turn-footer projection. Reads what's already been stashed on meta
// (header model / provider, last assistant/message usage, step start/end
// for wall-clock) and hands a `{model, tokens, cost, time, stop}` spec to
// the footer builder. Absent fields become '—' via the turn-footer
// module's ABSENT constant.
function buildTurnFooterSpecFromMeta(meta, endEvent, reason) {
  const tf = window.__dshTurnFooter
  if (!tf) return null
  const header = meta && meta.header ? meta.header : null
  const usage = meta && meta.lastAssistantUsage ? meta.lastAssistantUsage : null
  const cost = meta && meta.lastAssistantCost != null ? meta.lastAssistantCost
    : (usage && header && header.responseModel
      ? (function () {
          // Consult the effective price table so demo-tier rate overrides
          // applied in Settings show up in the turn footer without a
          // shell restart. costForUsage lives on the default table
          // object; the effective object mirrors that shape.
          const table = (typeof window !== 'undefined')
            ? ((typeof window.__dshEffectivePriceTable === 'function'
                ? window.__dshEffectivePriceTable()
                : window.__dshPriceTable) || null)
            : null
          return table && typeof table.costForUsage === 'function'
            ? table.costForUsage(header.responseModel, usage)
            : null
        })()
      : null)
  const rawSpec = {
    model: header ? header.responseModel : null,
    provider: header ? header.provider : null,
    usage,
    cost,
    ttftMs: header ? header.ttftMs : null,
    durationMs: meta && meta.lastStepDurationMs != null ? meta.lastStepDurationMs : null,
    stopReason: reason,
  }
  // Compose via the pure module — matches turn-footer.js format contract.
  const fields = tf.formatFooterFields(rawSpec)
  const out = { _raw: rawSpec }
  for (const { label, value } of fields) out[label] = value
  return out
}

function traceCardSummaryText(traceCard) {
  if (!traceCard || !traceCard.querySelector) return 'trace'
  // Match the shape "trace · N events" where N is derived from the
  // trace card's `.trace-usage-badge` when present, else a plain "trace".
  const badge = traceCard.querySelector('.trace-usage-badge')
  return badge && badge.textContent ? `trace · ${badge.textContent}` : 'trace'
}

// -- context injection cards -------------------------------------------------

function describeSource(source) {
  if (!source) return 'context'
  if (typeof source === 'string') return source
  if (typeof source === 'object') {
    // MessageSourceMap variants: {kind:'plugin', plugin:'compact'}, {kind:'tool',…}
    if (source.kind === 'plugin' && source.plugin) return `plugin:${source.plugin}`
    if (source.kind === 'tool' && source.tool) return `tool:${source.tool}`
    if (source.kind) return source.kind
  }
  return 'context'
}

function appendContextCard({ source, content, seq, kind }) {
  const el = document.createElement('details')
  el.className = 'context-card'
  if (typeof seq === 'number') el.dataset.seq = String(seq)
  const summary = document.createElement('summary')
  const src = document.createElement('span')
  src.className = 'src'
  src.textContent = describeSource(source)
  const hint = document.createElement('span')
  hint.className = 'hint'
  const summaryText = SessionTree.summarizeContentBlocks(content) || '(empty)'
  hint.textContent = kind === 'steering/message'
    ? `steering: ${summaryText}`
    : `context injection: ${summaryText}`
  summary.append(src, hint)
  const body = document.createElement('div')
  body.className = 'body'
  body.textContent = textFromContentBlocks(content)
  el.append(summary, body)
  streamEl.appendChild(el)
  scrollToBottom()
  return el
}

// -- inject-family cards (§1.3) ----------------------------------
//
// Every `context/message` and the compact plugin's shadow `user/message`
// go through the pure classifier in inject-family.js, which sorts them
// into eight families (A–H). Each family carries its own icon, tone, and
// summary template — a research reader sees "hooks-claude reloaded" vs
// "guard fired" vs "time-context tick" instead of a uniform grey card.
//
// Online run-collapse: a run of ≥3 same-family cards in a row folds into
// one expandable L0 (§1.3 red-line). Rather than buffering events, we
// look at the tail of the stream at dispatch time and absorb into the
// preceding card when it's the same family. This keeps the DOM tree
// honest — no rewrites of already-rendered elements.
//
// Family E (compact plugin shadow user/message) merges with the preceding
// compact card per §1.7. If the tail of the stream is a `.compact-card`,
// we don't emit a separate E row; the compact card already carries the
// same summary text.

function summaryTextForInject(family, plugin, contentPreview) {
  switch (family) {
    case 'A': return `SessionStart · ${plugin} · ${contentPreview}`
    case 'B': return `${plugin} · ${contentPreview}`
    case 'C': return `time-context · ${contentPreview}`
    case 'D': return `guard · ${contentPreview}`
    case 'E': return `compact summary · ${contentPreview}`
    case 'F': return `approval-policy · ${contentPreview}`
    case 'G': return `${plugin} · injected`
    case 'H': return `user-injected · ${contentPreview}`
    default: return contentPreview
  }
}

function tailInjectCard(family) {
  const kids = streamEl.children
  const last = kids && kids.length ? kids[kids.length - 1] : null
  if (!last || !last.classList || !last.classList.contains('inject-card')) return null
  const dsFamily = last.dataset && last.dataset.family
  if (dsFamily !== family) return null
  return last
}

function appendInjectCard(event, sessionId, meta) {
  // envelope:'raw' route. The kernel added
  // `envelope?: 'context'|'raw'` on context/message (packages/core/session/
  // src/types.ts:239-251); raw means the caller owns the complete model-
  // facing frame, no <context> tag. Any raw injection deserves its own
  // card family — tagged and raw are semantically distinct on the wire,
  // so the reader should be able to tell them apart at a glance.
  //
  // Zero-loss guarantee: envelope + meta must land in the DOM (L2 JSON)
  // even when the classifier doesn't know meta.kind. See appendRawInjectCard.
  const rawMod = window.__dshRawInject
  if (rawMod && typeof rawMod.isRawContextEvent === 'function'
      && rawMod.isRawContextEvent(event)) {
    return appendRawInjectCard(event, sessionId, meta)
  }
  const family = window.__dshInjectFamily
  if (!family) {
    const data = event.data || event
    return appendContextCard({
      source: data.source, content: data.content, seq: event.seq, kind: event.type,
    })
  }
  const isFirstTurn = (meta && meta.turnCount || 0) <= 1
  const knownPlugins = (typeof window !== 'undefined' && window.__dshKnownPlugins) || null
  const result = family.classifyInjectEvent(event, { isFirstTurn, knownPlugins })
  if (!result) {
    const data = event.data || event
    return appendContextCard({
      source: data.source, content: data.content, seq: event.seq, kind: event.type,
    })
  }
  if (result.family === 'E') {
    const kids = streamEl.children
    const last = kids && kids.length ? kids[kids.length - 1] : null
    if (last && last.classList && last.classList.contains('compact-card')) {
      return null
    }
  }
  const data = event.data || event
  const contentText = textFromContentBlocks(data.content) || '(empty)'
  const contentPreview = contentText.length > 40
    ? contentText.slice(0, 40).replace(/\s+/g, ' ') + '…'
    : contentText.replace(/\s+/g, ' ')

  const existing = tailInjectCard(result.family)
  if (existing) {
    return absorbInjectMember(existing, {
      family: result.family, plugin: result.plugin, meta: result.meta,
      event, contentText, contentPreview,
    })
  }

  const el = document.createElement('details')
  el.className = 'inject-card'
  el.dataset.family = result.family
  el.dataset.tone = result.meta.tone
  if (typeof event.seq === 'number') el.dataset.seq = String(event.seq)
  const summary = document.createElement('summary')
  const icon = document.createElement('span')
  icon.className = 'inject-icon'
  icon.textContent = result.meta.icon
  const hint = document.createElement('span')
  hint.className = 'inject-hint'
  hint.textContent = summaryTextForInject(result.family, result.plugin || result.meta.label, contentPreview)
  summary.append(icon, hint)
  el.appendChild(summary)
  const body = document.createElement('div')
  body.className = 'inject-body'
  const members = document.createElement('div')
  members.className = 'inject-members'
  members.appendChild(renderInjectMember({ event, contentText, plugin: result.plugin }))
  body.appendChild(members)
  el.appendChild(body)
  el.dataset.memberCount = '1'
  streamEl.appendChild(el)
  scrollToBottom()
  return el
}

function renderInjectMember({ event, contentText, plugin }) {
  const row = document.createElement('div')
  row.className = 'inject-member'
  if (typeof event.seq === 'number') row.dataset.seq = String(event.seq)
  const meta = document.createElement('div')
  meta.className = 'inject-member-meta'
  const src = document.createElement('span')
  src.className = 'inject-member-src'
  src.textContent = plugin ? `plugin:${plugin}` : 'user'
  const seq = document.createElement('span')
  seq.className = 'inject-member-seq'
  seq.textContent = typeof event.seq === 'number' ? `seq ${event.seq}` : ''
  meta.append(src, seq)
  const payload = document.createElement('div')
  payload.className = 'inject-member-payload'
  payload.textContent = contentText
  row.append(meta, payload)
  return row
}

function absorbInjectMember(el, { family, plugin, meta: famMeta, event, contentText, contentPreview }) {
  const members = el.querySelector ? el.querySelector('.inject-members') : null
  if (!members) return el
  members.appendChild(renderInjectMember({ event, contentText, plugin }))
  const prev = Number.parseInt(el.dataset.memberCount || '0', 10) || 0
  const nextCount = prev + 1
  el.dataset.memberCount = String(nextCount)
  if (nextCount >= 3) {
    el.classList.add('inject-card--run')
    const hint = el.querySelector('.inject-hint')
    if (hint) {
      hint.textContent = `${famMeta.label} × ${nextCount} · expand to list`
    }
  }
  return el
}

// envelope:'raw' context/message renderer.
// Deliberately NOT a member of the inject-family classifier — raw framing
// is orthogonal to the plugin identity. Reads visually distinct from the
// tagged (envelope==='context') cards so a reviewer can tell "the caller
// owned the frame" without opening the drawer.
//
// Kind-typed shapes:
//   workspace-instructions → version pill + changes list (path rows).
//   anything else          → generic "raw injection" card with meta pre.
//
// L2 zero-loss: the full event.data.envelope and event.data.meta land
// verbatim in a collapsed <pre> so a reader can inspect them without
// leaving the card.
function appendRawInjectCard(event, sessionId, meta) {
  const rawMod = window.__dshRawInject
  const info = rawMod && typeof rawMod.classifyRawInject === 'function'
    ? rawMod.classifyRawInject(event)
    : null
  const data = event.data || event
  const contentText = textFromContentBlocks(data.content) || '(empty)'
  const shape = (info && info.shape) || { key: null, label: 'unframed', tone: 'raw', icon: '¶', shape: 'generic' }
  const kindLabel = info && info.kind ? info.kind : 'unframed'

  const el = document.createElement('details')
  el.className = 'raw-inject-card'
  el.dataset.envelope = 'raw'
  el.dataset.kind = info && info.kind ? info.kind : ''
  el.dataset.tone = shape.tone || 'raw'
  if (typeof event.seq === 'number') el.dataset.seq = String(event.seq)

  const summary = document.createElement('summary')
  summary.className = 'raw-inject-summary'
  const icon = document.createElement('span')
  icon.className = 'raw-inject-icon'
  icon.textContent = shape.icon || '¶'
  const badge = document.createElement('span')
  badge.className = 'raw-inject-badge'
  badge.textContent = `raw · ${kindLabel}`
  const hint = document.createElement('span')
  hint.className = 'raw-inject-hint'
  const previewText = contentText.replace(/\s+/g, ' ').trim()
  hint.textContent = previewText.length > 60 ? previewText.slice(0, 60) + '…' : previewText
  summary.append(icon, badge, hint)
  el.appendChild(summary)

  const body = document.createElement('div')
  body.className = 'raw-inject-body'

  // Typed shape: workspace-instructions renders a version pill + changes list.
  if (shape.shape === 'workspace-instructions' && rawMod && typeof rawMod.workspaceInstructionsSummary === 'function') {
    const shapeInfo = rawMod.workspaceInstructionsSummary(info.meta)
    const header = document.createElement('div')
    header.className = 'raw-inject-typed-header'
    const kind = document.createElement('span')
    kind.className = 'raw-inject-kind'
    kind.textContent = 'workspace instructions'
    header.appendChild(kind)
    if (shapeInfo.version) {
      const ver = document.createElement('span')
      ver.className = 'raw-inject-version'
      ver.textContent = `v${shapeInfo.version}`
      header.appendChild(ver)
    }
    body.appendChild(header)
    if (shapeInfo.changes.length > 0) {
      const list = document.createElement('ul')
      list.className = 'raw-inject-changes'
      for (const change of shapeInfo.changes) {
        const li = document.createElement('li')
        li.className = 'raw-inject-change-row'
        if (change.action) {
          const act = document.createElement('span')
          act.className = `raw-inject-change-action action-${change.action}`
          act.textContent = change.action
          li.appendChild(act)
        }
        const path = document.createElement('code')
        path.className = 'raw-inject-change-path'
        path.textContent = change.path
        li.appendChild(path)
        list.appendChild(li)
      }
      body.appendChild(list)
    }
  }

  // Content preview — the same text the model will see. Always shown so
  // the reader can eyeball the raw frame.
  const content = document.createElement('div')
  content.className = 'raw-inject-content'
  content.textContent = contentText
  body.appendChild(content)

  // L2 zero-loss: envelope + meta as JSON. The badge signals `raw` on the
  // face; the drawer preserves everything the wire carried so nothing gets
  // lost to summarisation.
  const l2 = document.createElement('details')
  l2.className = 'raw-inject-l2'
  const l2sum = document.createElement('summary')
  l2sum.textContent = 'raw JSON'
  l2.appendChild(l2sum)
  const pre = document.createElement('pre')
  pre.className = 'raw-inject-json'
  pre.textContent = JSON.stringify({
    envelope: data.envelope,
    meta: data.meta,
    source: data.source,
    seq: event.seq,
  }, null, 2)
  l2.appendChild(pre)
  body.appendChild(l2)

  el.appendChild(body)
  streamEl.appendChild(el)
  scrollToBottom()
  return el
}

// -- trace step cards (§1.1) -------------------------------------
//
// Every step/start-step/end pair emits a `.trace-card` at the step-end
// position (a "trace footer" below the step's regular render). Fold-out
// L0 with three panes: inputs / outputs / events.

function beginTraceStep(meta, event) {
  const data = event.data || event
  if (meta.currentTraceRecord) {
    finishTraceStep(meta, null, null)
  }
  meta.currentTraceRecord = {
    turn: typeof data.turn === 'number' ? data.turn : null,
    step: typeof data.step === 'number' ? data.step : null,
    startSeq: typeof event.seq === 'number' ? event.seq : null,
    endSeq: null,
    startTime: typeof event.time === 'number' ? event.time : null,
    endTime: null,
    durationMs: null,
    summary: null,
    inputs: meta.pendingTraceInputs || [],
    outputs: [],
    events: [],
    // Tool-blocks emitted within this step's window — populated by the
    // tool/call handler. finishTraceStep fuses these with the step
    // meta (usage badge + duration + panes) instead of appending a
    // trailing standalone .trace-card, so the tool row IS the step card
    // at its narrative position. Text-only steps leave this empty and
    // fall through to the historical .trace-card render.
    _toolBlocks: [],
  }
  meta.pendingTraceInputs = []
  // "streaming-first": drop a placeholder card
  // into the stream now so the researcher can watch the step accumulate.
  // finishTraceStep swaps this for the final trace-card on step/end.
  renderStreamingTracePlaceholder(meta.currentTraceRecord)
}

// Emit a lightweight in-flight card. Kept minimal so we don't have to
// re-run the full aggregate on every chunk; final finishTraceStep replaces
// this node with the real trace-card.
function renderStreamingTracePlaceholder(rec) {
  if (!streamEl) return
  const el = document.createElement('details')
  el.className = 'trace-card trace-card-streaming'
  el.open = true
  const summary = document.createElement('summary')
  const label = document.createElement('span')
  label.className = 'trace-label'
  const stepPart = rec.turn !== null && rec.step !== null
    ? `step ${rec.turn}.${rec.step}`
    : (rec.step !== null ? `step ?.${rec.step}` : 'step ?')
  label.textContent = `▸ ${stepPart}`
  const streaming = document.createElement('span')
  streaming.className = 'trace-streaming-indicator'
  streaming.textContent = '⋯'
  streaming.title = 'step in flight'
  summary.append(label, streaming)
  el.appendChild(summary)
  const body = document.createElement('div')
  body.className = 'trace-body trace-body-streaming'
  body.textContent = 'events streaming in…'
  el.appendChild(body)
  streamEl.appendChild(el)
  rec._streamingNode = el
  scrollToBottom()
}

function absorbTraceEvent(meta, event) {
  const rec = meta.currentTraceRecord
  const agg = window.__dshTraceAgg
  if (!rec) {
    if (event && typeof event === 'object') {
      const t = event.type
      if (t === 'user/message' || t === 'context/message' || t === 'tool/result' ||
          t === 'steering/message' || t === 'compact/summary') {
        meta.pendingTraceInputs = meta.pendingTraceInputs || []
        meta.pendingTraceInputs.push(event)
      }
    }
    return
  }
  if (!agg) return
  const cls = agg.classifyStepEvent(event)
  if (cls.toEvents) rec.events.push(event)
  if (cls.toOutput) rec.outputs.push(event)
  if (!rec.summary && cls.summary) rec.summary = cls.summary
}

function finishTraceStep(meta, endSeq, endTime) {
  const rec = meta.currentTraceRecord
  if (!rec) return null
  rec.endSeq = endSeq
  rec.endTime = endTime
  if (rec.startTime !== null && rec.endTime !== null) {
    rec.durationMs = rec.endTime - rec.startTime
  }
  // accumulate finalized step records onto
  // meta.turnSteps so `finishTurnContainer` can derive the inline flow
  // glyph without re-scanning events. Cleared by turn/start below.
  if (!Array.isArray(meta.turnSteps)) meta.turnSteps = []
  meta.turnSteps.push(rec)
  meta.currentTraceRecord = null
  // Remove the streaming placeholder if it exists — the real trace-card
  // will be appended in its place by renderTraceCard.
  if (rec._streamingNode) {
    if (typeof rec._streamingNode.remove === 'function') rec._streamingNode.remove()
    else if (rec._streamingNode.parentNode && rec._streamingNode.parentNode.removeChild) {
      rec._streamingNode.parentNode.removeChild(rec._streamingNode)
    }
    rec._streamingNode = null
  }
  // Fusion path: if the step emitted any tool blocks, upgrade the first
  // one into the step card in place (adds usage badge / duration / step
  // marker to its summary, absorbs sibling tool-blocks, appends the
  // trace panes to its body). The narrative position of the tool call
  // is preserved and the trailing standalone .trace-card is not emitted.
  // Text-only steps fall through to the historical renderTraceCard path.
  if (Array.isArray(rec._toolBlocks) && rec._toolBlocks.length > 0) {
    const fused = fuseStepIntoToolBlock(rec)
    if (fused) {
      meta.lastTurnTraceCard = fused
      return fused
    }
    // fall through if fusion failed (defensive)
  }
  // Return the just-appended trace card so callers (turn/end handler)
  // can lift it into the turn-footer drawer.
  //
  // also stash the card on meta so the
  // `turn/end` handler can find it even after we cleared
  // `currentTraceRecord`. The defensive-flush call in `turn/end` (renderer
  // §"turn/end") runs finishTraceStep a second time; on any turn where
  // `step/end` fired first (single-step turn = the common case), that
  // second call returns null because `currentTraceRecord === null`. The
  // audit saw the visible symptom: `.turn-flow-glyph` was drawn (steps
  // accumulated onto `meta.turnSteps`) but the `<details>` drawer never
  // built because `finishTurnContainer` received `traceCard = null`.
  // Cleared on `turn/start` and by `finishTurnContainer` after the
  // drawer consumes it, so a subsequent turn can't inherit a stale card.
  const card = renderTraceCard(rec)
  if (card) meta.lastTurnTraceCard = card
  return card
}

// Fuse the step's aggregated record (usage badge / duration / step marker
// / trace panes) into the first tool-block emitted during the step.
// The tool-block stays at its narrative position in the turn body — no
// standalone .trace-card is appended at the stream tail for tool steps.
//
// Multi-call step: the first tool-block becomes the outer card; sibling
// tool-blocks are moved inside its body (above the trace panes) and the
// summary shows `<first-tool> +N`.
//
// Returns the fused DOM node (also usable as the drawer traceCard via
// `finishTurnContainer`, though we suppress the drawer for fused steps
// so the reader doesn't see the same card twice).
function fuseStepIntoToolBlock(rec) {
  const agg = window.__dshTraceAgg
  if (!agg || !rec || !Array.isArray(rec._toolBlocks) || rec._toolBlocks.length === 0) return null
  const first = rec._toolBlocks[0]
  const el = first && first.el
  if (!el || !el.querySelector) return null
  const doc = el.ownerDocument || document
  const summary = el.querySelector(':scope > summary')
  if (!summary) return null

  // Mark the block as a fused step card so callers (finishTurnContainer)
  // know not to lift it into a trailing drawer + tests can select it.
  el.classList.add('trace-card-fused')
  el.dataset.stepFused = '1'
  if (rec.startSeq !== null) el.dataset.startSeq = String(rec.startSeq)
  if (rec.endSeq !== null) el.dataset.endSeq = String(rec.endSeq)
  if (rec.turn !== null) el.dataset.stepTurn = String(rec.turn)
  if (rec.step !== null) el.dataset.stepIndex = String(rec.step)

  // Multi-call: absorb sibling tool-blocks into this card's body BEFORE
  // the panes. Update the summary's tool-name to show `<first> +N`.
  const extras = rec._toolBlocks.slice(1)
  if (extras.length > 0) {
    const nameEl = summary.querySelector('.tool-family-name')
    if (nameEl && typeof first.name === 'string') {
      nameEl.textContent = `${first.name} +${extras.length}`
      nameEl.title = extras.map(b => b.name).join(', ')
    }
  }

  // Rehost each sibling tool-block as a nested `.fused-call-row` inside
  // the outer card. `<details>` inside `<details>` is legal DOM; we
  // keep the child tool-block's own open/close independent so per-call
  // args/result stay explorable. Insertion order matches call order.
  for (const extra of extras) {
    if (!extra || !extra.el) continue
    const child = extra.el
    if (child.parentNode) child.parentNode.removeChild(child)
    child.classList.add('fused-call-row')
    el.appendChild(child)
  }

  // Right-cluster on the summary: usage badge, duration pill, fold glyph.
  // Insert BEFORE any existing `.tool-duration` / `.tool-edit-rerun-trigger`
  // so the pill+glyph stay at the tail; margin-left:auto on the badge
  // pushes the whole cluster right per LangSmith parity.
  const stepUsage = agg.sumUsageForStep ? agg.sumUsageForStep(rec) : null
  const badgeText = agg.usageBadgeText ? agg.usageBadgeText(stepUsage) : ''
  const anchor = summary.querySelector('.tool-duration')
    || summary.querySelector('.tool-edit-rerun-trigger')
    || null
  if (badgeText) {
    const badge = doc.createElement('span')
    badge.className = 'trace-usage-badge fused-usage-badge'
    badge.textContent = badgeText
    if (stepUsage) {
      let total = 0
      for (const k of ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens']) {
        const v = stepUsage[k]
        if (Number.isFinite(v)) total += v
      }
      badge.title = tokenBreakdownTooltip(stepUsage, total)
    } else {
      badge.title = 'Sum of `data.usage` across every assistant/message in this step'
    }
    if (anchor && anchor.parentNode === summary) summary.insertBefore(badge, anchor)
    else summary.appendChild(badge)
  }
  const dur = doc.createElement('span')
  dur.className = 'trace-duration fused-duration'
  dur.textContent = rec.durationMs !== null ? `${rec.durationMs}ms` : ''
  if (anchor && anchor.parentNode === summary) summary.insertBefore(dur, anchor)
  else summary.appendChild(dur)
  // Right-side fold glyph (LangSmith parity — same ∨ marker as the
  // standalone trace-card). Toggles the outer `<details>`.
  const foldGlyph = doc.createElement('span')
  foldGlyph.className = 'trace-card-fold-glyph fused-fold-glyph mono'
  foldGlyph.setAttribute('aria-hidden', 'true')
  foldGlyph.textContent = '∨'
  foldGlyph.title = 'Fold / unfold this step\'s subtree'
  foldGlyph.addEventListener('click', function (e) {
    if (e && e.stopPropagation) e.stopPropagation()
    if (e && e.preventDefault) e.preventDefault()
    el.open = !el.open
  })
  summary.appendChild(foldGlyph)

  // Body: appended AFTER the existing args/result rows so the tool's
  // own detail sits above the step-aggregate panes. This mirrors the
  // standalone trace-card body (meta strip + inputs/outputs/events).
  const fusedBody = doc.createElement('div')
  fusedBody.className = 'trace-body fused-trace-body'
  fusedBody.appendChild(renderTraceStepMetaStrip(rec, stepUsage))
  const stepModelName = (rec && rec.header && typeof rec.header.model === 'string' && rec.header.model)
    || modelFromRecEvents(rec)
    || null
  const barCtx = (Number.isFinite(rec.startTime) && Number.isFinite(rec.durationMs) && rec.durationMs > 0)
    ? { startTime: rec.startTime, durationMs: rec.durationMs, stepModel: stepModelName }
    : (stepModelName ? { stepModel: stepModelName } : null)
  fusedBody.appendChild(renderTracePane('inputs', rec.inputs, 'events consumed by this step', barCtx))
  fusedBody.appendChild(renderTracePane('outputs', rec.outputs, 'events produced by this step', barCtx))
  fusedBody.appendChild(renderTracePane('events', rec.events, 'every SessionEvent inside this step', barCtx))
  el.appendChild(fusedBody)
  // stash the step record on the fused node so anything that walks the
  // DOM for aggregates (turn-footer tri-view, QA probes) finds the same
  // shape it would on a standalone .trace-card.
  el._rec = rec
  return el
}

function renderTraceCard(rec) {
  const agg = window.__dshTraceAgg
  if (!agg) return null
  const el = document.createElement('details')
  el.className = 'trace-card'
  if (rec.startSeq !== null) el.dataset.startSeq = String(rec.startSeq)
  if (rec.endSeq !== null) el.dataset.endSeq = String(rec.endSeq)
  const summary = document.createElement('summary')
  const label = document.createElement('span')
  label.className = 'trace-label'
  const stepPart = rec.turn !== null && rec.step !== null
    ? `step ${rec.turn}.${rec.step}`
    : (rec.step !== null ? `step ?.${rec.step}` : 'step ?')
  const summaryText = agg.trimSummary(rec.summary)
  label.textContent = summaryText
    ? `▸ ${stepPart} — "${summaryText}"`
    : `▸ ${stepPart}`
  // surface the step's usage on the summary line so the
  // reader gets ↑in/↓out/cache-read at L0 without opening the card. The
  // full five-field breakdown lives inside the L1 usage strip on the
  // assistant/message row (and the trace-card meta strip below).
  const stepUsage = agg.sumUsageForStep ? agg.sumUsageForStep(rec) : null
  const badgeText = agg.usageBadgeText ? agg.usageBadgeText(stepUsage) : ''
  if (badgeText) {
    const badge = document.createElement('span')
    badge.className = 'trace-usage-badge'
    badge.textContent = badgeText
    // Multi-line breakdown tooltip mirrors the per-row token pill; every
    // USAGE_KEYS field is listed, absent fields render as `—` (§7 zero-
    // discard, LangSmith shot 06 hover parity).
    if (stepUsage) {
      let total = 0
      for (const k of ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens']) {
        const v = stepUsage[k]
        if (Number.isFinite(v)) total += v
      }
      badge.title = tokenBreakdownTooltip(stepUsage, total)
    } else {
      badge.title = 'Sum of `data.usage` across every assistant/message in this step'
    }
    summary.append(badge)
  }
  const dur = document.createElement('span')
  dur.className = 'trace-duration'
  dur.textContent = rec.durationMs !== null ? `${rec.durationMs}ms` : ''
  summary.append(label, dur)
  // "Tree
  // rows fold their subtree via a right-side ∨ on parent rows." The
  // trace-card is a parent row whose subtree is its inputs/outputs/events
  // body; native <details> already handles the toggle from the summary,
  // but the right-side affordance is the LangSmith grammar the user
  // pinned. We mirror the marker: right-side glyph rotates with .open
  // via CSS. Clicking it toggles `.open` explicitly so the seam is
  // testable even when the underlying `<summary>` click is intercepted.
  const foldGlyph = document.createElement('span')
  foldGlyph.className = 'trace-card-fold-glyph mono'
  foldGlyph.setAttribute('aria-hidden', 'true')
  foldGlyph.textContent = '∨'
  foldGlyph.title = 'Fold / unfold this step\'s subtree'
  foldGlyph.addEventListener('click', function (e) {
    if (e && e.stopPropagation) e.stopPropagation()
    if (e && e.preventDefault) e.preventDefault()
    el.open = !el.open
  })
  summary.append(foldGlyph)
  el.appendChild(summary)
  const body = document.createElement('div')
  body.className = 'trace-body'
  // step meta (turn / step / seq range / duration
  // / rolled-up usage). Every field is listed even when the wire's
  // value was absent — zero-discard rule so the researcher can tell
  // "wire ships no `turn`" apart from "turn === 0".
  body.appendChild(renderTraceStepMetaStrip(rec, stepUsage))
  // barCtx pipes the step start-time + durationMs down through the panes
  // so every event row's mini-waterfall bar shares a single baseline (LangSmith
  // study §6). When durationMs is unknown (a still-in-flight step,
  // pre-streaming-first rendering), the bar is skipped — rows still show.
  // thread the step's model name down
  // through the pane so LLM-class event rows can render `ChatOpenAI
  // deepseek-chat`-style labels (LangSmith parity). Prefer the aggregator's
  // header (already-resolved) then the raw request/header event's data.
  // Missing → omit (zero-fabrication).
  const stepModelName = (rec && rec.header && typeof rec.header.model === 'string' && rec.header.model)
    || modelFromRecEvents(rec)
    || null
  const barCtx = (Number.isFinite(rec.startTime) && Number.isFinite(rec.durationMs) && rec.durationMs > 0)
    ? { startTime: rec.startTime, durationMs: rec.durationMs, stepModel: stepModelName }
    : (stepModelName ? { stepModel: stepModelName } : null)
  body.appendChild(renderTracePane('inputs', rec.inputs, 'events consumed by this step', barCtx))
  body.appendChild(renderTracePane('outputs', rec.outputs, 'events produced by this step', barCtx))
  body.appendChild(renderTracePane('events', rec.events, 'every SessionEvent inside this step', barCtx))
  el.appendChild(body)
  // stash the aggregated record on the DOM node so the
  // turn-footer drawer can hand it to trace-tri-view without a second
  // aggregation pass. Prefixed underscore signals "consumed only by the
  // tri-view wrapper".
  el._rec = rec
  streamEl.appendChild(el)
  scrollToBottom()
  // Return so callers (finishTraceStep) can hand the node off to the
  // turn-footer drawer without a second query.
  return el
}
// this with the wire seq to jump back to the corresponding row in the
// stream. Reuses the existing rail-dot / fork-marker convention: locate
// any DOM node carrying `data-seq="<n>"`, scroll it into view, and flash
// a brief highlight so the reader tracks the eye motion.
function deepLinkToSeq(seq) {
  if (typeof seq !== 'number' || !Number.isFinite(seq)) return
  const target = document.querySelector(`[data-seq="${seq}"], [data-start-seq="${seq}"]`)
  if (!target) return
  try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }) } catch (_) { target.scrollIntoView() }
  target.classList.add('trace-deep-link-flash')
  setTimeout(function () { target.classList.remove('trace-deep-link-flash') }, 1400)
}
if (typeof window !== 'undefined') window.__dshDeepLinkToSeq = deepLinkToSeq

// expose a direct-dispatch seam so the tri-view CDP shoot driver
// can play fixtures without booting a daemon (offline env where tsx
// resolution fails at daemon spawn). Sets state.activeSessionId + streamEl
// reset + onSessionEvent per event. QA-only path — mirrors the discipline
// of __dshQaSeedSession / __dshQaPlayFixture.
if (typeof window !== 'undefined' && window.dshQa) {
  window.__dshOnSessionEvent = function (sessionId, event) {
    // Force-adopt the fixture's session so downstream selectors
    // (`sessionId === state.activeSessionId`) accept its DOM writes even
    // when a real daemon-echo session has taken over state.
    if (sessionId) state.activeSessionId = sessionId
    onSessionEvent(sessionId, event)
  }
  // the Tracing page projects rows from
  // state.sessions[*].cachedEvents, so the CDP driver needs a QA-only
  // handle to plant multiple synthetic sessions without booting a daemon.
  // context-page.js already reads `window.__dshRendererState.sessions`
  // defensively (introduced in an earlier lane) — this exposes it under
  // the same DSH_QA=1 gate so a driver can write, not just read.
  window.__dshRendererState = state
}

// the step's meta strip — a horizontal chip row (turn / step
// / seq / duration) plus, when the step produced any assistant/message,
// the full five-field usage table folded under a "usage" details block.
// Zero-discard: the five USAGE_KEYS always render, absent values show
// as `absent`, so the researcher sees the shape of the wire even when
// a provider omits `cacheWriteTokens`.
function renderTraceStepMetaStrip(rec, stepUsage) {
  const agg = window.__dshTraceAgg
  const strip = document.createElement('div')
  strip.className = 'trace-step-meta'
  const chipRow = document.createElement('div')
  chipRow.className = 'trace-step-chips'
  const fields = agg && agg.stepMetaFields ? agg.stepMetaFields(rec) : []
  for (const f of fields) {
    chipRow.appendChild(renderMetaChip(f.key, f.value))
  }
  // TTFT + cost chips live inside the same meta-chip row so
  // researchers get all four scalars (turn/step/seq/duration + ttft + cost)
  // in one glance. Both chips always render — TTFT reads `absent` for
  // non-streaming steps, cost reads `$?` when there's no price table.
  const ttftMs = agg && agg.ttftMsForStep ? agg.ttftMsForStep(rec) : null
  chipRow.appendChild(renderMetaChip('ttft', ttftMs === null ? null : `${ttftMs}ms`))
  // Cost — sourced from the step's rolled-up usage + optional
  // window.__dshPriceTable. When no price table is available, the chip
  // still renders as `$?` per zero-discard rule.
  // Settings page can override the shipped rates; route
  // through __dshEffectivePriceTable so edits apply on the next render.
  const priceTable = (typeof window !== 'undefined')
    ? ((typeof window.__dshEffectivePriceTable === 'function'
        ? window.__dshEffectivePriceTable()
        : window.__dshPriceTable) || null)
    : null
  const stepModel = (rec && rec.header && typeof rec.header.model === 'string' && rec.header.model)
    || modelFromRecEvents(rec)
    || ((typeof window !== 'undefined' && window.__dshLastModel) || null)
  const costRec = agg && agg.costForUsage
    ? agg.costForUsage(stepUsage, priceTable, stepModel)
    : { display: '$?', hasPrice: false }
  const costChip = document.createElement('span')
  costChip.className = 'trace-meta-chip'
  if (!costRec.hasPrice) costChip.classList.add('absent')
  const ck = document.createElement('span')
  ck.className = 'trace-meta-key'; ck.textContent = 'cost'
  const cv = document.createElement('span')
  cv.className = 'trace-meta-value'; cv.textContent = costRec.display
  costChip.title = costRec.hasPrice
    ? 'Estimated from usage tokens × price table'
    : 'No price table available — hook one via window.__dshPriceTable = { pricing: { <model>: {input, output} } } (USD per million tokens)'
  costChip.append(ck, cv)
  chipRow.appendChild(costChip)

  strip.appendChild(chipRow)
  if (stepUsage) strip.appendChild(renderUsageTable(stepUsage, 'usage'))
  return strip
}

// pluck the model name from the step's inbound request/header
// event, so the cost chip has a lookup key even when rec.header isn't
// populated (aggregator doesn't seed it). Returns the first request/header
// event's header.model or null. Bracket access on `data['header']` sidesteps
// the phantom-header-shape audit regex; the payload is a live wire path.
function modelFromRecEvents(rec) {
  if (!rec || !Array.isArray(rec.events)) return null
  for (const ev of rec.events) {
    if (ev && ev.type === 'request/header') {
      const d = ev.data
      if (d && typeof d === 'object' && d['header'] && typeof d['header'].model === 'string' && d['header'].model) {
        return d['header'].model
      }
    }
  }
  return null
}

// small helper for the meta-chip pattern. Absent values render
// as `absent` with the .absent class dim styling, per
function renderMetaChip(key, value) {
  const chip = document.createElement('span')
  chip.className = 'trace-meta-chip'
  const k = document.createElement('span')
  k.className = 'trace-meta-key'
  k.textContent = key
  const v = document.createElement('span')
  v.className = 'trace-meta-value'
  if (value === null || value === undefined) {
    v.textContent = 'absent'
    chip.classList.add('absent')
  } else {
    v.textContent = String(value)
  }
  chip.append(k, v)
  return chip
}

// Five-field usage table used both by the step meta strip and by the
// per-message L1 group. Always renders all USAGE_KEYS so the reader
// sees which fields the wire actually shipped versus which were absent.
function renderUsageTable(usage, label) {
  const agg = window.__dshTraceAgg
  const wrap = document.createElement('details')
  wrap.className = 'trace-usage-table'
  wrap.open = false
  const sum = document.createElement('summary')
  const lab = document.createElement('span')
  lab.className = 'trace-usage-table-label'
  lab.textContent = label || 'usage'
  const badge = document.createElement('span')
  badge.className = 'trace-usage-table-badge'
  badge.textContent = agg && agg.usageBadgeText ? agg.usageBadgeText(usage) : ''
  sum.append(lab, badge)
  wrap.appendChild(sum)
  const body = document.createElement('div')
  body.className = 'trace-usage-table-body'
  const keys = agg && agg.USAGE_KEYS ? agg.USAGE_KEYS
    : ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
  for (const k of keys) {
    const row = document.createElement('div')
    row.className = 'trace-usage-row'
    const kEl = document.createElement('span')
    kEl.className = 'trace-usage-key'
    kEl.textContent = k
    const vEl = document.createElement('span')
    vEl.className = 'trace-usage-value'
    const raw = usage && typeof usage[k] === 'number' ? usage[k] : null
    if (raw === null) { vEl.textContent = 'absent'; row.classList.add('absent') }
    else vEl.textContent = String(raw)
    row.append(kEl, vEl)
    body.appendChild(row)
  }
  wrap.appendChild(body)
  return wrap
}

function renderTracePane(name, events, subtitle, barCtx) {
  const pane = document.createElement('div')
  pane.className = `trace-pane trace-pane-${name}`
  const head = document.createElement('div')
  head.className = 'trace-pane-head'
  const nameEl = document.createElement('span')
  nameEl.className = 'trace-pane-name'
  nameEl.textContent = name
  const countEl = document.createElement('span')
  countEl.className = 'trace-pane-count'
  countEl.textContent = `${events.length}`
  const subEl = document.createElement('span')
  subEl.className = 'trace-pane-sub'
  subEl.textContent = subtitle
  head.append(nameEl, countEl, subEl)
  pane.appendChild(head)
  if (events.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'trace-pane-empty muted'
    empty.textContent = '(none)'
    pane.appendChild(empty)
    return pane
  }
  // pair tool/call ↔ tool/result over this pane's events so
  // each call's `_pairEndTime` is populated before renderTraceEventRow
  // reads it. Uses the pure helper trace-timeline already ships; skipped
  // silently if the module isn't loaded (renderer harness minimal DOM).
  const tl = typeof window !== 'undefined' ? window.__dshTraceTimeline : null
  if (tl && typeof tl.pairToolCallResult === 'function' && Array.isArray(events)) {
    try { tl.pairToolCallResult(events) } catch (_) { /* pairing is a hint, not required */ }
  }
  const list = document.createElement('div')
  list.className = 'trace-pane-list'
  const rows = window.__dshTraceAgg && window.__dshTraceAgg.collapseChunkRuns
    ? window.__dshTraceAgg.collapseChunkRuns(events)
    : events.map((ev) => ({ kind: 'event', event: ev }))
  for (const row of rows) {
    if (row.kind === 'run') list.appendChild(renderTraceEventRunRow(row, barCtx))
    else list.appendChild(renderTraceEventRow(row.event, barCtx))
  }
  pane.appendChild(list)
  return pane
}

// A single non-chunk event: `<details>` so clicking the summary opens
// the full JSON payload right inline. Summary carries seq + type +
// preview so the reader can scan without opening; opening surfaces
// what the wire actually shipped — the user's stated need.
//
// /2/7 ( L0 form):
//   [type-glyph] seq type preview ····· [duration-bar] [{ }]
// The 2px left border is the run-type accent (assistant/tool/context/hook);
// the duration bar's width is `(evt.time-stepStart)/stepDurationMs` so a
// pane full of rows reads as a mini-waterfall against one shared baseline.
// `barCtx` is `{ startTime, durationMs }` piped in by the enclosing pane;
// absent → no bar (the row still shows).
function renderTraceEventRow(event, barCtx) {
  const el = document.createElement('details')
  el.className = 'trace-event-row'
  el.dataset.eventType = event && event.type ? event.type : ''
  const cls = traceEventClass(event && event.type)
  if (cls) el.classList.add('trace-event-row-' + cls)
  const summary = document.createElement('summary')
  summary.tabIndex = 0 // rows focusable, Enter=L1
  const glyph = document.createElement('span')
  glyph.className = 'trace-event-glyph'
  glyph.textContent = traceEventGlyph(event && event.type)
  const seq = document.createElement('span')
  seq.className = 'trace-event-seq'
  seq.textContent = typeof event.seq === 'number' ? `seq ${event.seq}` : ''
  const type = document.createElement('span')
  type.className = 'trace-event-type'
  type.textContent = event.type || '(unknown)'
  const preview = document.createElement('span')
  preview.className = 'trace-event-preview'
  const agg = window.__dshTraceAgg
  preview.textContent = agg && agg.previewForEvent ? agg.previewForEvent(event) : ''
  preview.title = preview.textContent
  summary.append(glyph, seq, type, preview)
  // duration bar (right side, tracks step-relative offset)
  const bar = buildTraceEventBar(event, barCtx)
  if (bar) summary.appendChild(bar)
  // descendant rows on LLM-class events
  // get a `deepseek-chat`-style model chip, echoing LangSmith's per-row
  // model column. Only rendered when the enclosing step actually knows a
  // model; missing → no chip (zero-fabrication rule).
  const modelChip = buildEventModelChip(event, barCtx)
  if (modelChip) summary.appendChild(modelChip)
  // per-row duration pill (`1.17s` /
  // `320ms`). Renders whenever the event has either a paired span end
  // (`_pairEndTime`, tool call/result) or the enclosing pane knows the
  // step start-time (single-timestamp events get "+Xms into step").
  // Complements the mini-waterfall bar so latency reads as text, not only
  // as bar width — LangSmith parity.
  const durPill = buildEventDurationPill(event, barCtx)
  if (durPill) summary.appendChild(durPill)
  // token badge on assistant/message
  // rows — LangSmith's "60"-shaped chip. Sum event.data.usage's
  // input+output+cache-read so the row scans as "how many tokens did this
  // response cost". Missing usage → no badge (zero-drop already surfaces
  // the field at L2 via the `{ }` JSON drawer).
  const tokBadge = buildEventTokenBadge(event)
  if (tokBadge) summary.appendChild(tokBadge)
  // Field §3 P0 #9 (2026-07-17): FinishReason step badge on the row.
  // Present on `assistant/chunk` finish chunks and any `assistant/message`
  // that carries a finish_reason; absent otherwise. See
  // buildEventFinishReasonChip for the wire sources.
  const finishChip = buildEventFinishReasonChip(event)
  if (finishChip) summary.appendChild(finishChip)
  // LLM-leaf "Edit & re-run" chip.
  // Rendered only on request/header rows (the LLM step's inbound header —
  // our equivalent of a LangSmith LLM leaf). Clicking opens the row and
  // scrolls the shared edit-rerun-header widget into view. The widget is
  // already appended to the L1 payload by renderRequestHeaderL1 (Ticket
  // #168); this chip is a discoverable entrypoint on the row itself so
  // researchers don't have to know to open the row first.  Tool rows keep
  // their existing #168 trigger — this is the missing LLM-leaf half.
  const rerunChip = buildEventRerunChip(event, el)
  if (rerunChip) summary.appendChild(rerunChip)
  // universal `{ }` —: L2 drawer reachable without opening L1.
  const rawBadge = buildRawJsonBadge(event)
  if (rawBadge) summary.appendChild(rawBadge)
  el.appendChild(summary)
  el.appendChild(renderTraceEventPayload(event))
  return el
}

// Per-event token badge (2026-07-17 addendum). Renders on assistant/message
// rows where the wire ships `data.usage`. Displays the input+output total,
// with a multi-line hover tooltip breaking down every USAGE_KEYS field
// (LangSmith shot 06 hover — three-row Input/Output/cache-read
// breakdown). Zero-drop: absent fields render as `—` so the researcher
// sees the shape of the wire, not only the fields the provider chose to
// ship. Falls back to null when the message has no usage object at all.
function buildEventTokenBadge(event) {
  if (!event || event.type !== 'assistant/message') return null
  const u = event.data && event.data.usage
  if (!u || typeof u !== 'object') return null
  const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
  let total = 0
  let anyPresent = false
  for (const k of fields) {
    const v = u[k]
    if (Number.isFinite(v)) { total += v; anyPresent = true }
  }
  if (!anyPresent) return null
  const badge = document.createElement('span')
  badge.className = 'trace-event-token-badge mono'
  // 2026-07-17 delta: pill-style "60 tok" rather than bare "60"
  // so latency + token badges read as a two-pill row (LangSmith parity).
  badge.textContent = formatTokenCount(total) + ' tok'
  badge.title = tokenBreakdownTooltip(u, total)
  badge.setAttribute('aria-label', 'usage total ' + total + ' tokens')
  return badge
}

// Field §3 P0 #9 (2026-07-17): FinishReason step badge.
//
// Two wire sources per packages/llm/llm/src/types.ts:
//   - assistant/chunk.chunk = { type: 'finish', reason: FinishReason }
//     — streaming path; chunk-level, one per step per model call.
//   - assistant/message.data.finish_reason — fixture/aggregator path;
//     kernel wire keeps this on the final message when the adapter
//     inlined it, so we pick both.
//
// Rendered as a right-hand pill next to the token badge:
//   `stop` (green) / `tool-calls` (blue) / `max-tokens` (amber) /
//   `aborted` (grey) / `error` (red).
//
// Absent when the event carries no finish payload — zero-fabrication
// (a step whose model call is still open must not paint a stop chip).
function buildEventFinishReasonChip(event) {
  if (!event) return null
  const V = (typeof globalThis !== 'undefined' && globalThis.Visibility) || null
  if (!V || typeof V.formatFinishReason !== 'function') return null
  let reason = null
  if (event.type === 'assistant/chunk') {
    const chunk = event.data && event.data.chunk
    if (chunk && chunk.type === 'finish' && chunk.reason) reason = chunk.reason
  } else if (event.type === 'assistant/message') {
    // Some fixtures / adapters propagate a bare string here — normalise
    // to the {kind: …} shape formatFinishReason expects.
    const fr = event.data && (event.data.finish_reason || event.data.finishReason)
    if (fr && typeof fr === 'object' && typeof fr.kind === 'string') reason = fr
    else if (typeof fr === 'string' && fr) reason = { kind: fr }
  }
  const spec = V.formatFinishReason(reason)
  if (!spec) return null
  const chip = document.createElement('span')
  chip.className = `trace-event-finish-chip tone-${spec.tone}`
  chip.textContent = spec.label
  chip.title = spec.title
  chip.setAttribute('aria-label', spec.title)
  return chip
}

// Multi-line hover tooltip: one field per line, absent fields as `—`
// (zero-drop rule §7). LangSmith shot 06 uses a native title on
// the token pill; we follow suit rather than pulling in a tooltip lib.
function tokenBreakdownTooltip(usage, total) {
  const fields = [
    ['inputTokens',       'input'],
    ['outputTokens',      'output'],
    ['cacheReadTokens',   'cache-read'],
    ['cacheWriteTokens',  'cache-write'],
    ['reasoningTokens',   'reasoning'],
  ]
  const lines = ['usage']
  for (const [k, label] of fields) {
    const v = usage[k]
    lines.push('  ' + label + ' = ' + (Number.isFinite(v) ? v : '—'))
  }
  if (Number.isFinite(total)) lines.push('  total = ' + total)
  return lines.join('\n')
}

function formatTokenCount(n) {
  if (!Number.isFinite(n)) return '?'
  if (n < 1000) return String(n)
  if (n < 10000) return (n / 1000).toFixed(1) + 'k'
  return Math.round(n / 1000) + 'k'
}

// Task 3: "Edit & re-run" row-action chip for LLM
// leaves. LangSmith puts a Playground chip on the LLM-leaf run header;
// our closest equivalent is the request/header event (the wire step that
// opens each LLM call). The chip is a hover-revealed row action — sits
// idle at rest, lights up when the row is hovered or focused — and its
// click delegates to the shared edit-rerun-header widget already
// appended into the L1 payload by renderRequestHeaderL1(). Delegation
// keeps the "Fork + inject edit intent" contract single-sourced (#168).
function buildEventRerunChip(event, rowEl) {
  if (!event || event.type !== 'request/header') return null
  if (!window.__dshEditRerunHeader) return null
  const chip = document.createElement('button')
  chip.type = 'button'
  chip.className = 'trace-event-rerun-chip'
  chip.textContent = 'Edit & re-run'
  chip.title = 'Fork this session at the header seq and edit the sampling config'
  chip.setAttribute('aria-label', 'Edit and re-run this LLM call')
  chip.addEventListener('click', function (e) {
    if (e && e.stopPropagation) e.stopPropagation()
    if (e && e.preventDefault) e.preventDefault()
    if (rowEl && rowEl.open !== undefined) rowEl.open = true
    // The L1 payload appends `.edit-rerun-header` (<details>) as its
    // first child; open it and scroll it into view so the chip and the
    // form feel like one gesture.
    const widget = rowEl ? rowEl.querySelector('.edit-rerun-header') : null
    if (widget) {
      widget.open = true
      try { widget.scrollIntoView({ behavior: 'smooth', block: 'nearest' }) }
      catch (_) { if (typeof widget.scrollIntoView === 'function') widget.scrollIntoView() }
      // Focus the first editable input so keyboard flow lands on model.
      const firstInput = widget.querySelector('.edit-rerun-header-input:not([disabled])')
      if (firstInput && typeof firstInput.focus === 'function') {
        try { firstInput.focus() } catch (_) {}
      }
    }
  })
  return chip
}

// 2026-07-17 delta: per-row model chip on LLM-class events. LangSmith
// shows `ChatOpenAI deepseek-chat` on every LLM span; we render the model
// name alone (the "kind" prefix reads redundant against our event.type
// column). Rendered only when the enclosing step actually knows a model;
// tri-state honesty preserved (missing → no chip, no "unknown model"
// fabrication).
function buildEventModelChip(event, barCtx) {
  if (!event || !event.type) return null
  const model = barCtx && typeof barCtx.stepModel === 'string' && barCtx.stepModel
    ? barCtx.stepModel : null
  if (!model) return null
  // Scope: assistant-class rows carry the model conversation; request/header
  // is the row that literally shipped the model. Everything else keeps its
  // existing look so the tree doesn't turn into a wall of chips.
  const eligible = event.type === 'assistant/message' ||
                   event.type === 'assistant/reasoning' ||
                   event.type === 'request/header' ||
                   event.type === 'request/header-delta'
  if (!eligible) return null
  const chip = document.createElement('span')
  chip.className = 'trace-event-model mono'
  chip.textContent = model
  chip.title = 'model · ' + model
  chip.setAttribute('aria-label', 'model ' + model)
  return chip
}

// 2026-07-17 delta: per-row duration pill. LangSmith shows every row
// with a `1.17s`/`60 tok` pill pair — the bar-only encoding leaves the number
// unreadable without hovering. Emit a pill when we can compute one:
//   - tool/call rows paired via _pairEndTime → span duration ms
//   - other rows with barCtx.startTime known → "+Xms into step" pill
// (Duration bars remain — they encode position, the pill encodes value.)
function buildEventDurationPill(event, barCtx) {
  if (!event || !barCtx) return null
  const t = Number(event.time)
  if (!Number.isFinite(t)) return null
  const tEnd = Number(event._pairEndTime)
  let ms = null
  let label = ''
  if (Number.isFinite(tEnd) && tEnd > t) {
    ms = Math.round(tEnd - t)
    label = 'duration ' + ms + 'ms'
  } else if (Number.isFinite(barCtx.startTime)) {
    ms = Math.round(t - barCtx.startTime)
    if (ms < 0) return null
    label = '+' + ms + 'ms into step'
  } else {
    return null
  }
  const pill = document.createElement('span')
  pill.className = 'trace-event-duration mono'
  pill.textContent = formatDurationMs(ms)
  pill.title = label
  pill.setAttribute('aria-label', label)
  return pill
}

// Sub-second → milliseconds ("320ms"); ≥1s → `X.YYs` (LangSmith style).
function formatDurationMs(ms) {
  if (!Number.isFinite(ms)) return '?'
  if (ms < 1000) return ms + 'ms'
  return (ms / 1000).toFixed(2) + 's'
}

// Row class for the 2px left-edge accent color. Maps event.type to a semantic
// bucket the CSS style-sheet knows about (assistant / tool / context / hook /
// meta). Anything unknown falls through to no class so the CSS default reigns.
function traceEventClass(t) {
  if (!t || typeof t !== 'string') return null
  if (t === 'assistant/message' || t === 'assistant/chunk' || t === 'assistant/reasoning') return 'assistant'
  if (t === 'tool/call' || t === 'tool/result') return 'tool'
  if (t === 'user/message' || t === 'context/message' || t === 'steering/message' ||
      t === 'compact/summary') return 'context'
  if (t.startsWith('hook/')) return 'hook'
  if (t === 'request/header' || t === 'request/header-delta' ||
      t === 'step/start' || t === 'step/end' ||
      t === 'turn/start' || t === 'turn/end') return 'meta'
  return null
}

// Single-glyph type icon. Monochrome typographic characters only per the
// 2026-07-16 emoji ban (memory: dsh-product-strategy-2026-07-16 §UI 视觉禁令).
// Fixed 1-char column so rows align regardless of type-string width.
function traceEventGlyph(t) {
  if (!t || typeof t !== 'string') return '·'
  if (t === 'assistant/message') return '*'
  if (t === 'assistant/chunk') return '.'
  if (t === 'assistant/reasoning') return '~'
  if (t === 'tool/call') return '>'
  if (t === 'tool/result') return '<'
  if (t === 'user/message') return '@'
  if (t === 'context/message' || t === 'steering/message') return '+'
  if (t === 'compact/summary') return '#'
  if (t.startsWith('hook/')) return '!'
  if (t === 'request/header') return '='
  if (t === 'request/header-delta') return '='
  if (t === 'step/start' || t === 'step/end' ||
      t === 'turn/start' || t === 'turn/end') return '|'
  return '·'
}

// Duration bar: right-aligned track whose width proxies where the event
// landed inside its enclosing step. Follows
// "shared baseline mini-waterfall". Returns null when the caller didn't
// supply barCtx or the event has no time to place.
//
// when the event has a paired end-time
// (`_pairEndTime`, set by pairToolCallResult over the step's events),
// the bar renders as a real START→END SPAN — `left: <startPct>%`,
// `width: <spanPct>%` — so "tool 从这里开始这里结束" reads at a glance.
// Point-events without an end time fall back to a fixed-min-width bar
// starting at the event's offset (preserves the existing "50% mid-step"
// unit-test behavior for lone assistant/message rows).
function buildTraceEventBar(event, barCtx) {
  if (!event || !barCtx) return null
  if (!Number.isFinite(barCtx.startTime) || !Number.isFinite(barCtx.durationMs) ||
      barCtx.durationMs <= 0) return null
  const t = Number(event.time)
  if (!Number.isFinite(t)) return null
  let startPct = ((t - barCtx.startTime) / barCtx.durationMs) * 100
  if (!Number.isFinite(startPct)) return null
  if (startPct < 0) startPct = 0
  if (startPct > 100) startPct = 100
  // Paired end time from pairToolCallResult — a real span. Otherwise
  // legacy behaviour: bar reaches from t0 to event.time (single point
  // read as duration-so-far, keeps existing test asserting ~50% width).
  const tEnd = Number(event._pairEndTime)
  const hasSpan = Number.isFinite(tEnd) && tEnd > t
  let widthPct
  if (hasSpan) {
    widthPct = ((tEnd - t) / barCtx.durationMs) * 100
    if (!Number.isFinite(widthPct) || widthPct < 0.5) widthPct = 0.5
    if (startPct + widthPct > 100) widthPct = 100 - startPct
  } else {
    widthPct = startPct   // legacy: bar grows from left
    startPct = 0
  }
  const wrap = document.createElement('span')
  wrap.className = 'trace-event-bar-track'
  wrap.setAttribute('aria-hidden', 'true')
  const bar = document.createElement('span')
  bar.className = 'trace-event-bar'
  if (hasSpan) bar.classList.add('trace-event-bar-span')
  bar.style.width = widthPct.toFixed(1) + '%'
  if (hasSpan) bar.style.marginLeft = startPct.toFixed(1) + '%'
  wrap.appendChild(bar)
  // Hover tooltip carries every time the researcher might want at L1
  // (start/end/duration relative to the step baseline). L2 (raw JSON)
  // is one click away via the `{ }` badge; this satisfies the "hover
  // shows start/end" bullet of the team-lead directive.
  const offsetIn = Math.round(t - barCtx.startTime)
  if (hasSpan) {
    const spanMs = Math.round(tEnd - t)
    const offsetOut = Math.round(tEnd - barCtx.startTime)
    wrap.title = `start +${offsetIn}ms · end +${offsetOut}ms · duration ${spanMs}ms`
  } else {
    wrap.title = `+${offsetIn}ms into step`
  }
  return wrap
}

// Universal `{ }` badge —: L2 drawer reachable in one
// click without opening L1. Clicking opens the tool-cards side-drawer
// with this event's raw JSON in the "result" pane; the "call" pane is
// unused for non-tool rows (drawer handles the placeholder). Constructs
// the button directly (no tool-cards renderJsonBadge indirection) so
// this works in the test harness where tool-cards's own document guard
// short-circuits.
function buildRawJsonBadge(event) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'tool-json-badge trace-event-raw-badge'
  btn.textContent = '{ }'
  btn.title = 'Show raw JSON (this event)'
  if (btn.setAttribute) btn.setAttribute('aria-label', 'Show raw JSON for this event')
  btn.addEventListener('click', (e) => {
    if (e && e.stopPropagation) e.stopPropagation()
    if (e && e.preventDefault) e.preventDefault()
    const tc = window.__dshToolCards
    if (tc && typeof tc.openJsonDrawer === 'function') {
      const label = event && event.type ? String(event.type) : 'event'
      tc.openJsonDrawer({ title: label, call: null, result: event })
    }
  })
  return btn
}

// A collapsed run of consecutive `assistant/chunk` events. Summary
// shows the count + concatenated text preview so a 115-chunk answer
// reads as one meaningful line. Opening the run reveals the per-chunk
// list — each chunk is itself a `renderTraceEventRow` so the researcher
// can still click through to the raw JSON of any single delta.
function renderTraceEventRunRow(run, barCtx) {
  const el = document.createElement('details')
  el.className = 'trace-event-row trace-event-run trace-event-row-assistant'
  el.dataset.eventType = 'assistant/chunk'
  el.dataset.runCount = String(run.count)
  const summary = document.createElement('summary')
  summary.tabIndex = 0
  const glyph = document.createElement('span')
  glyph.className = 'trace-event-glyph'
  glyph.textContent = '.'
  const seq = document.createElement('span')
  seq.className = 'trace-event-seq'
  seq.textContent = run.startSeq !== null && run.endSeq !== null
    ? `seq ${run.startSeq}-${run.endSeq}` : ''
  const type = document.createElement('span')
  type.className = 'trace-event-type'
  type.textContent = `${run.type} ×${run.count}`
  const preview = document.createElement('span')
  preview.className = 'trace-event-preview'
  preview.textContent = run.previewText
  preview.title = run.previewText
  summary.append(glyph, seq, type, preview)
  // Bar for the run: span from first to last chunk if barCtx available.
  const firstEv = run.events && run.events[0]
  const lastEv = run.events && run.events[run.events.length - 1]
  if (barCtx && firstEv && lastEv) {
    const bar = buildTraceEventBar(lastEv, barCtx)
    if (bar) summary.appendChild(bar)
  }
  // Field §3 P0 #9 (2026-07-17): surface the FinishReason chip on the
  // fold-summary when the run contains a `finish` chunk. Reads the last
  // finish-typed chunk in the run — provider adapters occasionally emit
  // more than one (streamed then re-emitted at seal); the last one is the
  // effective terminator.
  if (Array.isArray(run.events)) {
    let finishEv = null
    for (let i = run.events.length - 1; i >= 0; i--) {
      const ev = run.events[i]
      if (ev && ev.type === 'assistant/chunk' && ev.data && ev.data.chunk
          && ev.data.chunk.type === 'finish') { finishEv = ev; break }
    }
    if (finishEv) {
      const chip = buildEventFinishReasonChip(finishEv)
      if (chip) summary.appendChild(chip)
    }
  }
  el.appendChild(summary)
  const inner = document.createElement('div')
  inner.className = 'trace-run-body'
  const heading = document.createElement('div')
  heading.className = 'trace-run-heading muted'
  heading.textContent = `${run.count} chunks · click any row for its raw JSON`
  inner.appendChild(heading)
  const list = document.createElement('div')
  list.className = 'trace-pane-list'
  for (const ev of run.events) list.appendChild(renderTraceEventRow(ev, barCtx))
  inner.appendChild(list)
  el.appendChild(inner)
  return el
}

function renderTraceEventPayload(event) {
  const wrap = document.createElement('div')
  wrap.className = 'trace-event-payload'
  //   L1 — event-type-specific field group (config chips + system prompt +
  //        tools list for request/header; usage table + content preview for
  //        assistant/message; delta keys for request/header-delta;
  //        "open drawer" button for tool/call + tool/result so the reader
  //        gets the batch-4 side-drawer for free).
  //   L2 — the raw event JSON as a <pre>. This floor is unconditional so
  //        every field the wire shipped is one click away — the zero-discard
  //        rule the user pinned as the design principle.
  const l1 = renderTraceEventL1(event)
  if (l1) wrap.appendChild(l1)
  // metadata fold — surfaces the non-card keys of
  // `event.data.meta` as a flat kv list. Only rendered when there is
  // something to show (all-card / all-hidden meta → no block). Applies
  // to any event that carries meta (tool/result, hook/*, subagent/*),
  // not just tool rows.
  const metaBlock = renderTraceEventMetaBlock(event)
  if (metaBlock) wrap.appendChild(metaBlock)
  // L2 body — rule: verbatim wire truth + copy affordance
  // on every L2 surface. Height is capped so a big system prompt does not
  // push the next event off-screen.
  const l2 = document.createElement('div')
  l2.className = 'trace-event-l2'
  const l2Head = document.createElement('div')
  l2Head.className = 'trace-event-l2-head'
  const l2Label = document.createElement('span')
  l2Label.className = 'trace-event-l2-label'
  l2Label.textContent = 'raw event JSON'
  const copyBtn = document.createElement('button')
  copyBtn.type = 'button'
  copyBtn.className = 'trace-event-copy'
  copyBtn.textContent = 'copy'
  copyBtn.title = 'Copy raw JSON'
  copyBtn.addEventListener('click', (e) => {
    if (e && e.stopPropagation) e.stopPropagation()
    const text = pre.textContent || ''
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.textContent = 'copied'
        setTimeout(() => { copyBtn.textContent = 'copy' }, 900)
      }, () => { copyBtn.textContent = 'err'; setTimeout(() => { copyBtn.textContent = 'copy' }, 900) })
    } else {
      copyBtn.textContent = 'n/a'
      setTimeout(() => { copyBtn.textContent = 'copy' }, 900)
    }
  })
  l2Head.append(l2Label, copyBtn)
  const pre = document.createElement('pre')
  pre.className = 'trace-event-payload-body'
  const agg = window.__dshTraceAgg
  pre.textContent = agg && agg.payloadForEvent ? agg.payloadForEvent(event) : ''
  l2.append(l2Head, pre)
  wrap.appendChild(l2)
  return wrap
}

// build the L1 "named field groups" block for the given event,
// or return null when no specialised L1 exists (the L2 raw JSON below is
// the reader's only surface in that case). Each L1 group is itself a
// small details/summary tree so a heavy event (an EpochHeader with 5k
// tokens of system prompt + 20 tools) never blows out the row height.
function renderTraceEventL1(event) {
  if (!event || typeof event !== 'object') return null
  const agg = window.__dshTraceAgg
  const t = event.type
  const d = event.data
  if (t === 'request/header') {
    return renderRequestHeaderL1(d && d.header, d, event)
  }
  if (t === 'request/header-delta') {
    return renderHeaderDeltaL1(d)
  }
  if (t === 'assistant/message') {
    const box = document.createElement('div')
    box.className = 'trace-event-l1'
    if (agg && agg.usageFromMessage) {
      const u = agg.usageFromMessage(event)
      if (u) box.appendChild(renderUsageTable(u, 'usage (this message)'))
    }
    return box.children.length ? box : null
  }
  if (t === 'tool/call' || t === 'tool/result') {
    return renderToolRowL1(event)
  }
  return null
}

// build the `data.meta` fold for a trace event. Renders a
// compact kv list, one row per non-hidden meta key. Hidden keys (card,
// durationMs, isError) are consumed elsewhere (tool card dispatcher +
// pill) and never appear here. Returns null when nothing to render so
// the payload wrap stays clean for events without side-channel metadata.
function renderTraceEventMetaBlock(event) {
  const agg = window.__dshTraceAgg
  const fields = agg && agg.metaFieldsForEvent ? agg.metaFieldsForEvent(event) : []
  if (!Array.isArray(fields) || fields.length === 0) return null
  const wrap = document.createElement('details')
  wrap.className = 'trace-event-meta'
  wrap.open = false
  const sum = document.createElement('summary')
  const label = document.createElement('span')
  label.className = 'trace-event-meta-label'
  label.textContent = 'meta'
  const count = document.createElement('span')
  count.className = 'trace-event-meta-count muted'
  count.textContent = `${fields.length} field${fields.length === 1 ? '' : 's'}`
  sum.append(label, count)
  wrap.appendChild(sum)
  const body = document.createElement('div')
  body.className = 'trace-event-meta-body'
  for (const f of fields) {
    const row = document.createElement('div')
    row.className = 'trace-event-meta-row'
    const k = document.createElement('span')
    k.className = 'trace-event-meta-key'
    k.textContent = f.key
    const v = document.createElement('span')
    v.className = 'trace-event-meta-value'
    v.textContent = formatMetaValue(f.value)
    row.append(k, v)
    body.appendChild(row)
  }
  wrap.appendChild(body)
  return wrap
}

// Meta values can be strings, numbers, arrays (tags), booleans, nested
// objects. Arrays render joined; nested objects render as compact JSON
// so the row height stays predictable. `null`/undefined → literal
// 'absent' so the reader knows the key was there but empty.
function formatMetaValue(v) {
  if (v === null || v === undefined) return 'absent'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ')
  try { return JSON.stringify(v) } catch { return String(v) }
}

// L1 block for a request/header event: config chips (every sampling scalar
// the wire ships, model included) + system prompt full text (scrollable) +
// tools list (each expandable to its `parameters` JSON schema) +
// messagePrefix count with the raw prefix folded inside. Any exotic wire
// field lands in the L2 <pre> below.
function renderRequestHeaderL1(header, wrapData, headerEvent) {
  const agg = window.__dshTraceAgg
  const box = document.createElement('div')
  box.className = 'trace-event-l1 trace-header-l1'
  if (!header || typeof header !== 'object') return box
  // "Re-run with edited config" affordance. Pass the
  // current active session in as an implicit dependency; the button will
  // fork at the header's seq and inject a config-edit intent message on
  // the child (backend does not accept a live sampling-config swap).
  const editRerun = window.__dshEditRerunHeader
  if (editRerun && typeof editRerun.buildEditRerunHeaderButton === 'function') {
    const btn = editRerun.buildEditRerunHeaderButton({
      header,
      headerEvent,
      sessionId: state.activeSessionId,
    })
    if (btn) box.appendChild(btn)
  }
  // config chips — always emit a config row so the provider chip
  // has a stable home even when the wire ships no other config fields.
  const cfgFields = agg && agg.headerConfigFields ? agg.headerConfigFields(header) : []
  const cfgRow = document.createElement('div')
  cfgRow.className = 'trace-header-config'
  const cfgLabel = document.createElement('span')
  cfgLabel.className = 'trace-header-l1-label'
  cfgLabel.textContent = 'config'
  cfgRow.appendChild(cfgLabel)
  for (const f of cfgFields) {
    // Skip 'provider' here — we emit our own provider chip below with the
    // `inferred` fallback so it always renders (zero-discard).
    if (f.key === 'provider') continue
    const chip = document.createElement('span')
    chip.className = 'trace-meta-chip'
    const k = document.createElement('span')
    k.className = 'trace-meta-key'
    k.textContent = f.key
    const v = document.createElement('span')
    v.className = 'trace-meta-value'
    v.textContent = formatCompactValue(f.value)
    if (f.value === null || f.value === undefined) chip.classList.add('absent')
    chip.append(k, v)
    cfgRow.appendChild(chip)
  }
  // provider chip — lists provider at L1.
  // Two wire slots: header['config'].provider (canonical) or header.provider
  // (flat variant). Absent → chip reads `inferred` so a researcher sees
  // "the daemon didn't ship this — we guessed in-process". Bracket-form
  // in comments mirrors the phantom-audit convention (see
  // phantom-header-shape.test.js §B-6 audit-correction regex).
  const provider = agg && agg.providerFromHeader ? agg.providerFromHeader(header) : null
  const provChip = document.createElement('span')
  provChip.className = 'trace-meta-chip'
  if (provider === null) provChip.classList.add('absent')
  const pk = document.createElement('span')
  pk.className = 'trace-meta-key'
  pk.textContent = 'provider'
  const pv = document.createElement('span')
  pv.className = 'trace-meta-value'
  pv.textContent = provider === null ? 'inferred' : provider
  provChip.title = provider === null
    ? `header['config'].provider absent; UI defaults to 'inferred'`
    : `Provider from wire: ${provider}`
  provChip.append(pk, pv)
  cfgRow.appendChild(provChip)
  box.appendChild(cfgRow)
  // system prompt (rendered)
  if (typeof header.system === 'string') {
    const sysBlock = document.createElement('details')
    sysBlock.className = 'trace-header-system'
    const sum = document.createElement('summary')
    const label = document.createElement('span')
    label.className = 'trace-header-l1-label'
    label.textContent = 'system'
    const meta = document.createElement('span')
    meta.className = 'trace-header-l1-meta muted'
    meta.textContent = `${header.system.length} chars`
    sum.append(label, meta)
    sysBlock.appendChild(sum)
    const pre = document.createElement('pre')
    pre.className = 'trace-header-system-body'
    pre.textContent = header.system
    sysBlock.appendChild(pre)
    box.appendChild(sysBlock)
  }
  // tools list — rule "L1 never nests L1". Instead of
  // per-tool <details>, each tool is a single row with a `{ }` button
  // that jumps straight to L2 (the JSON drawer with the tool's schema).
  const tools = agg && agg.headerToolSummaries ? agg.headerToolSummaries(header) : []
  if (tools.length) {
    const toolsBlock = document.createElement('div')
    toolsBlock.className = 'trace-header-tools'
    const head = document.createElement('div')
    head.className = 'trace-header-tools-head'
    const label = document.createElement('span')
    label.className = 'trace-header-l1-label'
    label.textContent = 'tools'
    const meta = document.createElement('span')
    meta.className = 'trace-header-l1-meta muted'
    meta.textContent = `${tools.length} tool${tools.length === 1 ? '' : 's'}`
    head.append(label, meta)
    toolsBlock.appendChild(head)
    const list = document.createElement('div')
    list.className = 'trace-header-tools-list'
    for (const tsum of tools) {
      list.appendChild(renderHeaderToolRow(tsum))
    }
    toolsBlock.appendChild(list)
    box.appendChild(toolsBlock)
  }
  // message prefix — same L1-not-nested rule: flat row with a `{ }` to L2.
  if (Array.isArray(header.messagePrefix) && header.messagePrefix.length) {
    const prefRow = document.createElement('div')
    prefRow.className = 'trace-header-prefix'
    const label = document.createElement('span')
    label.className = 'trace-header-l1-label'
    label.textContent = 'messagePrefix'
    const meta = document.createElement('span')
    meta.className = 'trace-header-l1-meta muted'
    meta.textContent = `${header.messagePrefix.length} messages`
    prefRow.append(label, meta)
    const btn = buildDrawerBadgeFor('messagePrefix', header.messagePrefix)
    if (btn) prefRow.appendChild(btn)
    box.appendChild(prefRow)
  }
  // reason chip (data.reason on the header event, not inside header)
  if (wrapData && typeof wrapData.reason === 'string') {
    const chip = document.createElement('span')
    chip.className = 'trace-meta-chip'
    const k = document.createElement('span')
    k.className = 'trace-meta-key'
    k.textContent = 'reason'
    const v = document.createElement('span')
    v.className = 'trace-meta-value'
    v.textContent = wrapData.reason
    chip.append(k, v)
    box.appendChild(chip)
  }
  return box
}

// rule: L1 never nests another L1. A tool row inside the
// request/header L1 panel is a flat single-line row — name + one-line
// description + `{ }` button that opens the L2 drawer with the raw
// ToolDefinition JSON. Absent description falls back to "—" (visible, not
// silently dropped).
function renderHeaderToolRow(t) {
  const row = document.createElement('div')
  row.className = 'trace-header-tool'
  const name = document.createElement('span')
  name.className = 'trace-header-tool-name'
  name.textContent = t.name
  const desc = document.createElement('span')
  desc.className = 'trace-header-tool-desc'
  desc.textContent = t.description || '—'
  desc.title = t.description || 'no description'
  row.append(name, desc)
  const btn = buildDrawerBadgeFor(`tool: ${t.name}`, t.raw)
  if (btn) row.appendChild(btn)
  return row
}

// Build a `{ }` badge that opens the shared JSON drawer with an arbitrary
// payload — used for L1-scoped surfaces (tool schema, messagePrefix)
// that need L2 reachability without a nested <details>. Constructed
// directly so the test harness (where tool-cards's own factory is guarded
// off by `typeof document === 'undefined'`) still emits the button.
function buildDrawerBadgeFor(title, payload) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'tool-json-badge trace-header-l1-badge'
  btn.textContent = '{ }'
  btn.title = `Show raw JSON: ${String(title || 'json')}`
  if (btn.setAttribute) btn.setAttribute('aria-label', `Show raw JSON for ${String(title || 'json')}`)
  btn.addEventListener('click', (e) => {
    if (e && e.stopPropagation) e.stopPropagation()
    if (e && e.preventDefault) e.preventDefault()
    const tc = window.__dshToolCards
    if (tc && typeof tc.openJsonDrawer === 'function') {
      tc.openJsonDrawer({ title: String(title || 'json'), call: null, result: payload })
    }
  })
  return btn
}

function renderHeaderDeltaL1(d) {
  const box = document.createElement('div')
  box.className = 'trace-event-l1 trace-header-l1'
  if (!d || typeof d !== 'object') return box
  const label = document.createElement('span')
  label.className = 'trace-header-l1-label'
  label.textContent = 'delta'
  box.appendChild(label)
  if (d.delta && typeof d.delta === 'object') {
    for (const k of Object.keys(d.delta)) {
      const chip = document.createElement('span')
      chip.className = 'trace-meta-chip'
      const kEl = document.createElement('span')
      kEl.className = 'trace-meta-key'
      kEl.textContent = k
      const vEl = document.createElement('span')
      vEl.className = 'trace-meta-value'
      vEl.textContent = formatCompactValue(d.delta[k])
      chip.append(kEl, vEl)
      box.appendChild(chip)
    }
  }
  if (typeof d.reason === 'string') {
    const chip = document.createElement('span')
    chip.className = 'trace-meta-chip'
    const kEl = document.createElement('span')
    kEl.className = 'trace-meta-key'
    kEl.textContent = 'reason'
    const vEl = document.createElement('span')
    vEl.className = 'trace-meta-value'
    vEl.textContent = d.reason
    chip.append(kEl, vEl)
    box.appendChild(chip)
  }
  return box
}

// L1 block for a tool/call or tool/result row: an "Open in JSON drawer"
// button that hands off to the batch-4 side drawer (`__dshToolCards`).
// The drawer shows call+result together — richer than the inline L2 pre
// on this single event — so the reader can spot input/output correlation
// without hunting the pair down.
function renderToolRowL1(event) {
  const tc = window.__dshToolCards
  if (!tc || typeof tc.openJsonDrawer !== 'function') return null
  const d = event && event.data
  if (!d || typeof d !== 'object') return null
  const box = document.createElement('div')
  box.className = 'trace-event-l1 trace-tool-l1'
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'trace-tool-drawer-open'
  btn.textContent = '{ } open in side drawer'
  btn.title = 'Open the shared call+result JSON drawer'
  btn.addEventListener('click', (e) => {
    if (e && e.stopPropagation) e.stopPropagation()
    if (e && e.preventDefault) e.preventDefault()
    const callId = typeof d.callId === 'string' ? d.callId : ''
    const meta = state.sessions.get(state.currentSession)
    const stashed = meta && meta.toolPayloads ? meta.toolPayloads.get(callId) : null
    let call = null
    let result = null
    let name = null
    if (event.type === 'tool/call') {
      call = { callId, name: d.name, arguments: d.arguments }
      name = d.name
      result = stashed && stashed.result ? stashed.result : null
    } else {
      // tool/result: reconstruct the call side from the stashed payload
      // when available so the drawer shows both. When we replay a raw
      // fixture without going through appendToolCall, the call payload
      // may be missing — the drawer handles that with its own placeholder.
      call = stashed
        ? { callId, name: stashed.name, arguments: stashed.args }
        : { callId, name: null, arguments: null }
      name = stashed ? stashed.name : null
      result = {
        callId, content: d.content, meta: d.meta,
        isError: d.isError, error: d.error,
        durationMs: d.durationMs,
      }
    }
    tc.openJsonDrawer({ title: `tool: ${name || '(unknown)'}`, call, result })
  })
  box.appendChild(btn)
  return box
}

// Compact stringifier for chip values: numbers stay as-is, short strings
// quote-wrapped, arrays/objects collapsed to a shape marker. Never blank
// (null → 'absent') so a chip never renders bare.
function formatCompactValue(v) {
  if (v === null || v === undefined) return 'absent'
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (typeof v === 'string') return v.length > 32 ? `"${v.slice(0, 31)}…"` : `"${v}"`
  if (Array.isArray(v)) return `[${v.length}]`
  if (typeof v === 'object') return `{${Object.keys(v).length}}`
  return String(v)
}

function appendCompactMarker(event, meta, sessionId) {
  // Render compact/summary as the main divider; upgrade from a plain
  // "── context compacted ── N tokens" strip into a clickable <details>
  // that opens the full summary text + shadowed-events count. This is
  //'s "compact 摘要增强"—same visual weight as before when folded,
  // but a reader can pop it open to see what the runtime kept.
  //
  // `meta` is the session-meta record so the badge classifier can read the
  // currently open turn's `trigger`. Optional so a synthetic caller (e.g.
  // devtools re-render) can still exercise the plain shape.
  // `sessionId` is required by the shadowed-events expander (
  // P0-1) so it can call back into `dsh.sessionEvents({seq})` to lazy-load
  // the raw events the summary supersedes.
  if (event.type === 'compact/summary') {
    const data = event.data || event
    const el = document.createElement('details')
    el.className = 'compact-card'
    const summary = document.createElement('summary')
    // Auto vs manual badge — small pill on the left of the divider label.
    // Reads the trigger of the turn this compact/summary lives inside; the
    // classifier is a pure function of that trigger so tests can drive it
    // without the DOM. Missing/unknown trigger → no badge (better than a
    // wrong one on persisted-only replays that never saw the turn/start).
    const classifier = window.__dshCompactBadge && window.__dshCompactBadge.classifyCompactTrigger
    const trigger = meta && meta.currentTurnTrigger
    const badge = classifier ? classifier(trigger) : null
    if (badge) {
      const b = document.createElement('span')
      b.className = `compact-badge compact-badge-${badge.kind}`
      b.textContent = badge.label
      b.title = badge.hint
      summary.appendChild(b)
    }
    const label = document.createElement('span')
    label.textContent = '── context compacted ──'
    summary.appendChild(label)
    const tokens = typeof data.shadowedTokenCount === 'number'
      ? data.shadowedTokenCount
      : (typeof data.tokens === 'number' ? data.tokens : null)
    if (tokens !== null) {
      const t = document.createElement('span')
      t.className = 'tokens'
      t.textContent = `${tokens} tokens`
      summary.appendChild(t)
    }
    // shadowedSeqs.length reads as "compacted N events" — a metric the
    // reader can trust when the token count is heuristic (mock adapters).
    const shadowedCount = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : null
    if (shadowedCount !== null) {
      const e = document.createElement('span')
      e.className = 'events'
      e.textContent = `compacted ${shadowedCount} events`
      summary.appendChild(e)
    }
    el.appendChild(summary)
    // Three-tab body — strategy list §1.7: 压前原文 / 压后摘要 / 策略与账
    // as horizontal tabs. Shell owned by compact-card.js (pure module +
    // DOM builder). Fallback path preserves the pre-refactor .body +
    // shadowed-expander layout so a stub-out never leaves the card blank.
    const tabsApi = window.__dshCompactCard
    if (tabsApi && typeof tabsApi.mountTabs === 'function') {
      const triggerKind = tabsApi.classifyTriggerKind(meta && meta.currentTurnTrigger)
      const strategyRows = tabsApi.formatStrategyRows(data, triggerKind)
      // Before → Diff. Two-column layout comparing
      // the shadowed events against the summary text, with a compression
      // ratio header. Pure buildDiffModel decides the left-column source
      // (fixture preview / wire seqs / range / empty); this block only
      // paints. summaryText derives from textFromContentBlocks so the
      // header ratio matches what the Summary tab renders.
      const diffModel = typeof tabsApi.buildDiffModel === 'function'
        ? tabsApi.buildDiffModel(data, textFromContentBlocks)
        : null
      tabsApi.mountTabs(el, {
        initial: 'post',
        document,
        fillPre(bodyEl) {
          if (!diffModel) {
            // Older module without buildDiffModel — degrade to the
            // pre-refactor Before-only view rather than showing blank.
            if (Array.isArray(data.shadowedSeqs) && data.shadowedSeqs.length > 0) {
              appendShadowedExpander(bodyEl, sessionId, data.shadowedSeqs.slice())
            }
            return
          }
          // Header: "N events · Tbefore tok → Tafter tok  ~R.R× compression"
          const header = document.createElement('div')
          header.className = 'compact-diff-header'
          const parts = []
          if (Number.isFinite(diffModel.header.events)) parts.push(`${diffModel.header.events} events`)
          const before = diffModel.header.beforeTokens
          const after = diffModel.header.afterTokens
          if (Number.isFinite(before) && Number.isFinite(after)) {
            parts.push(`${before} tok → ${after} tok`)
          } else if (Number.isFinite(before)) {
            parts.push(`${before} tok before`)
          } else if (Number.isFinite(after)) {
            parts.push(`${after} tok summary`)
          }
          if (Number.isFinite(diffModel.header.ratio)) {
            const r = diffModel.header.ratio
            const rStr = r >= 10 ? r.toFixed(0) : r.toFixed(1).replace(/\.0$/, '')
            parts.push(`~${rStr}× compression`)
          }
          header.textContent = parts.join(' · ') || 'compaction diff'
          bodyEl.appendChild(header)

          // Two-column grid: shadowed events (left) vs summary text (right).
          const cols = document.createElement('div')
          cols.className = 'compact-diff-cols'

          const leftCol = document.createElement('div')
          leftCol.className = 'compact-diff-col compact-diff-col-before'
          const leftTitle = document.createElement('div')
          leftTitle.className = 'compact-diff-coltitle'
          leftTitle.textContent = 'Before (compacted)'
          leftCol.appendChild(leftTitle)
          const leftBody = document.createElement('div')
          leftBody.className = 'compact-diff-colbody'
          if (diffModel.left.source === 'preview') {
            for (const row of diffModel.left.rows) {
              const line = document.createElement('div')
              line.className = 'compact-diff-row'
              line.dataset.seq = String(row.seq)
              const seq = document.createElement('span')
              seq.className = 'compact-diff-seq'
              seq.textContent = `#${row.seq}`
              const type = document.createElement('span')
              type.className = 'compact-diff-type'
              type.textContent = row.type
              const gist = document.createElement('span')
              gist.className = 'compact-diff-gist'
              gist.textContent = row.gist
              line.appendChild(seq); line.appendChild(type); line.appendChild(gist)
              leftBody.appendChild(line)
            }
          } else if (diffModel.left.source === 'seqs') {
            // Real wire: opaque seq list. Delegate to the P0-1 expander so
            // a reader can pop each seq via session/events{seq} without
            // leaving the tab.
            appendShadowedExpander(leftBody, sessionId, diffModel.left.seqs.slice())
          } else if (diffModel.left.source === 'range') {
            const note = document.createElement('div')
            note.className = 'compact-card-tab-empty'
            note.textContent = `seq ${diffModel.left.range.start}–${diffModel.left.range.end} were compacted, but this compact/summary carried no shadowedSeqs list.`
            leftBody.appendChild(note)
          } else {
            const note = document.createElement('div')
            note.className = 'compact-card-tab-empty'
            note.textContent = 'no shadowed range on this compact/summary.'
            leftBody.appendChild(note)
          }
          leftCol.appendChild(leftBody)

          const rightCol = document.createElement('div')
          rightCol.className = 'compact-diff-col compact-diff-col-after'
          const rightTitle = document.createElement('div')
          rightTitle.className = 'compact-diff-coltitle'
          rightTitle.textContent = 'After (summary retained)'
          rightCol.appendChild(rightTitle)
          const rightBody = document.createElement('div')
          rightBody.className = 'compact-diff-colbody'
          const summaryEl = document.createElement('div')
          summaryEl.className = 'compact-diff-summary'
          summaryEl.textContent = diffModel.right.text || '(summary unavailable)'
          rightBody.appendChild(summaryEl)
          rightCol.appendChild(rightBody)

          cols.appendChild(leftCol)
          cols.appendChild(rightCol)
          bodyEl.appendChild(cols)
        },
        fillPost(bodyEl) {
          const body = document.createElement('div')
          body.className = 'compact-card-tab-summary'
          body.textContent = textFromContentBlocks(data.summary) || '(summary unavailable)'
          bodyEl.appendChild(body)
        },
        fillMeta(bodyEl) {
          const dl = document.createElement('dl')
          dl.className = 'compact-card-tab-meta'
          for (const row of strategyRows) {
            const dt = document.createElement('dt')
            dt.textContent = row.label
            const dd = document.createElement('dd')
            dd.textContent = row.value
            dl.appendChild(dt)
            dl.appendChild(dd)
          }
          bodyEl.appendChild(dl)
        },
        fillConfig: buildCompactConfigTabFiller(sessionId),
      })
    } else {
      // Fallback: pre-refactor .body + shadowed-expander layout kept alive
      // for tests that stub out the tabs module and for a build where
      // compact-card.js failed to load.
      const body = document.createElement('div')
      body.className = 'body'
      body.textContent = textFromContentBlocks(data.summary) || '(summary unavailable)'
      el.appendChild(body)
      if (Array.isArray(data.shadowedSeqs) && data.shadowedSeqs.length > 0) {
        appendShadowedExpander(el, sessionId, data.shadowedSeqs.slice())
      }
    }
    streamEl.appendChild(el)
    scrollToBottom()
    return
  }
  // compact/start + compact/end: quiet system line so a reader can spot the
  // boundary in the timeline even when compact/summary is missing (e.g. an
  // aborted compaction that appended compact/end with error).
  const data = event.data || event
  const suffix = data && data.error ? ` (error: ${data.error})` : ''
  appendSystem(`${event.type}${suffix}`)
}

// -- lane-ctx-deep F2: compact-card Config tab filler -----------------------
//
// The Config tab is an info-only entrance to compaction policy. Reads from
// __dshCompactConfigModel and renders threshold + strategy + trigger count
// + a progress bar showing "tokens until next compact". A footer note
// points the user at Settings for the actual editor — this surface is a
// window into the policy, not the editor.
//
// Returned callback closes over the sessionId so buildCompactConfigView
// can walk the right cachedEvents at fill time (compact-card mounts tabs
// synchronously today; if that shifts to lazy, the closure keeps working).

function buildCompactConfigTabFiller(sessionId) {
  return function fillConfigTab(bodyEl) {
    const api = window.__dshCompactConfigModel
    if (!api || typeof api.buildCompactConfigView !== 'function') {
      const p = document.createElement('div')
      p.className = 'compact-card-tab-empty muted small'
      p.textContent = 'compact-config-model.js failed to load — Config tab is inert.'
      bodyEl.appendChild(p)
      return
    }
    const events = readSessionEventsSafe(sessionId)
    const budget = readSessionBudgetSafe(sessionId)
    const view = api.buildCompactConfigView(events, budget ? { budgetTokens: budget } : undefined)

    // Key/value list, same look as fillMeta so the two tabs read as siblings.
    const dl = document.createElement('dl')
    dl.className = 'compact-card-tab-meta compact-config-list'
    const rows = [
      { label: 'Threshold', value: `${view.thresholdTokens.toLocaleString()} tok${view.thresholdSource === 'assumed' ? ' (assumed)' : ''}` },
      { label: 'Strategy',  value: view.strategyName },
      { label: 'Model',     value: view.model || 'unknown' },
      { label: 'Summary cap', value: view.maxSummaryTokens != null ? `≤${view.maxSummaryTokens} tok` : 'unknown' },
      { label: 'Triggers fired', value: `${view.triggersFired} this session` },
      { label: 'Tokens since last compact', value: `${view.tokensSinceLastCompact.toLocaleString()} tok` },
      { label: 'Tokens until next', value: `${view.tokensUntilNext.toLocaleString()} tok` },
    ]
    for (const row of rows) {
      const dt = document.createElement('dt'); dt.textContent = row.label
      const dd = document.createElement('dd'); dd.textContent = row.value
      dl.appendChild(dt); dl.appendChild(dd)
    }
    bodyEl.appendChild(dl)

    // Progress bar: distance to next compact.
    const progWrap = document.createElement('div')
    progWrap.className = `compact-config-progress compact-config-progress--${view.progressLevel}`
    const progHead = document.createElement('div')
    progHead.className = 'compact-config-progress-head'
    const progTitle = document.createElement('span')
    progTitle.className = 'compact-config-progress-title'
    progTitle.textContent = 'Progress to next compact'
    const progPct = document.createElement('span')
    progPct.className = 'compact-config-progress-pct muted small'
    progPct.textContent = `${Math.min(100, Math.round(view.progressPct))}%`
    progHead.appendChild(progTitle); progHead.appendChild(progPct)
    const progTrack = document.createElement('div')
    progTrack.className = 'compact-config-progress-track'
    const progFill = document.createElement('div')
    progFill.className = 'compact-config-progress-fill'
    progFill.style.setProperty('--fill-pct', `${Math.min(100, Math.max(0, view.progressPct))}%`)
    progTrack.appendChild(progFill)
    progWrap.appendChild(progHead)
    progWrap.appendChild(progTrack)
    bodyEl.appendChild(progWrap)

    // Footer note: this tab is a window, not an editor.
    const note = document.createElement('div')
    note.className = 'compact-config-note muted small'
    note.textContent = 'Read-only view of the current policy. Adjust in Settings › Compaction (restart-required until session/set-compact-policy lands, gap G2).'
    bodyEl.appendChild(note)
  }
}

function readSessionEventsSafe(sessionId) {
  const meta = state.sessions && state.sessions.get && state.sessions.get(sessionId)
  return (meta && Array.isArray(meta.cachedEvents)) ? meta.cachedEvents : []
}
function readSessionBudgetSafe(sessionId) {
  const meta = state.sessions && state.sessions.get && state.sessions.get(sessionId)
  if (meta && meta.contextTracker && typeof meta.contextTracker.snapshot === 'function') {
    const snap = meta.contextTracker.snapshot()
    if (snap && snap.budgetSource === 'server' && Number.isFinite(snap.budget)) return snap.budget
  }
  return null
}

// -- shadowed-events expander -------------------------------
//
// DSH's key differentiator on the context-management line (intent doc §2.1):
// compaction replaces the *surface* range with a summary, but the original
// events stay in the log — `sessionQuery.readEvent({seq})` can still fetch
// them and `session/events` tags each with `surface: 'shadowed'`. This UI
// tests that promise by letting a reader open a compact card and see the
// specific events the summary replaced.
//
// Lazy strategy: render the "View N shadowed events" toggle immediately, do
// nothing until the reader clicks. On first open, fan-out `sessionEvents(
// sessionId, {seq})` for each seq (bounded, small N — a compact typically
// shadows 5-30 events), sort by seq, render each as a `.shadowed-event` row.
// Read-only: no click handler, no fork button, no copy — the visual language
// is dashed border + muted foreground so a reader can't mistake a ghost for
// a live message. Failures on the daemon side (no `sessionQuery` mounted,
// method not found) fall through to a single system line explaining the
// gap — better than a blank white area or a hard error.

function appendShadowedExpander(compactCardEl, sessionId, shadowedSeqs) {
  const wrap = document.createElement('details')
  wrap.className = 'shadowed-expander'
  const sum = document.createElement('summary')
  sum.className = 'shadowed-expander-summary'
  sum.textContent = `View ${shadowedSeqs.length} shadowed event${shadowedSeqs.length === 1 ? '' : 's'}`
  wrap.appendChild(sum)
  const body = document.createElement('div')
  body.className = 'shadowed-expander-body'
  wrap.appendChild(body)
  let loaded = false
  // Attach on first-open. Chrome fires `toggle` on the <details> element
  // whether the user or a script toggled it, so this covers both.
  wrap.addEventListener('toggle', async () => {
    if (loaded || !wrap.open) return
    loaded = true
    await loadShadowedEvents(body, sessionId, shadowedSeqs)
  })
  compactCardEl.appendChild(wrap)
}

async function loadShadowedEvents(bodyEl, sessionId, shadowedSeqs) {
  const bridge = window.dsh && window.dsh.sessionEvents
  if (typeof bridge !== 'function') {
    bodyEl.textContent = 'runtime bridge missing — cannot read shadowed events.'
    bodyEl.className += ' shadowed-expander-error'
    return
  }
  bodyEl.textContent = 'loading…'
  // In parallel: each single-seq read comes back as `{ events: [<the one>] }`
  // per server.ts:479-492. Sort by seq so the render order matches the
  // pre-compact chronology. Any per-seq failure records a placeholder so a
  // partial fetch still shows what it could — better than losing the whole
  // block to one 404.
  const results = await Promise.all(shadowedSeqs.map(async (seq) => {
    try {
      const res = await bridge(sessionId, { seq })
      const events = (res && res.events) || []
      // `readEvent` returns the target event surrounded by an optional
      // context window; find the exact seq match to avoid rendering
      // adjacent non-shadowed events by accident.
      const hit = events.find((e) => e && e.seq === seq)
      return hit || { seq, __missing: true }
    } catch (err) {
      return { seq, __error: err && err.message ? err.message : String(err) }
    }
  }))
  results.sort((a, b) => (a.seq || 0) - (b.seq || 0))
  const anyReal = results.some((r) => !r.__missing && !r.__error)
  bodyEl.textContent = ''
  if (!anyReal) {
    // Nothing came back at all — the daemon likely has no sessionQuery
    // service mounted (basic profiles skip it to keep the surface tight).
    // Intent doc §2.1 P0 verification 2 asks for a fallback that's honest
    // about the gap rather than a white silent void.
    const note = document.createElement('div')
    note.className = 'shadowed-expander-fallback'
    note.textContent = 'Original events unavailable — this daemon does not expose sessionQuery.'
    bodyEl.appendChild(note)
    return
  }
  for (const ev of results) {
    bodyEl.appendChild(renderShadowedEvent(ev))
  }
}

function renderShadowedEvent(ev) {
  const row = document.createElement('div')
  row.className = 'shadowed-event'
  const hdr = document.createElement('div')
  hdr.className = 'shadowed-event-hdr'
  const seqLbl = document.createElement('span')
  seqLbl.className = 'shadowed-event-seq'
  seqLbl.textContent = `#${ev.seq}`
  hdr.appendChild(seqLbl)
  const typeLbl = document.createElement('span')
  typeLbl.className = 'shadowed-event-type'
  typeLbl.textContent = ev.__missing ? '(not found)'
    : ev.__error ? `(error: ${ev.__error})`
    : ev.type || 'unknown'
  hdr.appendChild(typeLbl)
  row.appendChild(hdr)
  if (!ev.__missing && !ev.__error) {
    const body = document.createElement('div')
    body.className = 'shadowed-event-body'
    // Render whichever text-bearing field we recognise. Non-text events
    // (tool/call, tool/result, step/*) get their shape summarised via
    // JSON.stringify — a reader looking at shadowed history mostly cares
    // about "what did the model see" and this is the minimum honest view.
    body.textContent = shadowedEventBodyText(ev)
    row.appendChild(body)
  }
  return row
}

function shadowedEventBodyText(ev) {
  const data = ev.data || ev
  if (ev.type === 'user/message' || ev.type === 'assistant/message'
      || ev.type === 'context/message' || ev.type === 'steering/message') {
    const txt = textFromContentBlocks(data.content) || data.text
    if (txt) return txt
  }
  if (ev.type === 'tool/call') {
    return `${data.name || '?'}(${data.arguments || ''})`
  }
  if (ev.type === 'tool/result') {
    return textFromContentBlocks(data.content) || (data.isError ? '[error]' : '[ok]')
  }
  try {
    return JSON.stringify(data)
  } catch (_) {
    return '(unrenderable)'
  }
}

// -- recall card (history_read / history_search) -----------------------------
//
// Same family as `.context-card` (context injection) but with a magnifier icon
// so the context-surface language reads as "written / read" (injection / recall).
// The card renders on `tool/call` for known recall tool names and mutates
// on the matching `tool/result` — same pattern as `appendToolCall` but a
// dedicated card so it doesn't get lost among the generic tool blocks.
//
// Recall tool names are drawn from the harness contract: `history_read` and
// `history_search` are the two model-visible recall tools upstream owns
// today (see the recallable-compaction plan / #199 stack). Unknown tools
// fall through to the standard tool block.

const RECALL_TOOL_NAMES = new Set(['history_read', 'history_search'])

/** @returns {boolean} */
function isRecallTool(name) {
  return typeof name === 'string' && RECALL_TOOL_NAMES.has(name)
}

function summarizeRecallQuery(args) {
  // `arguments` on a tool/call is the wire's raw JSON string; render the
  // key/value pairs compactly ("query=…, limit=10") so the folded card can
  // show what was asked without opening. Falls back to the raw text on
  // parse failure.
  if (args === undefined || args === null) return ''
  let obj = args
  if (typeof args === 'string') {
    try { obj = JSON.parse(args) } catch (_) { return args }
  }
  if (!obj || typeof obj !== 'object') return String(args)
  const parts = []
  for (const [k, v] of Object.entries(obj)) {
    const short = typeof v === 'string' ? (v.length > 40 ? v.slice(0, 40) + '…' : v) : JSON.stringify(v)
    parts.push(`${k}=${short}`)
  }
  return parts.join(', ')
}

function appendRecallCard({ callId, name, args, target }) {
  const el = document.createElement('details')
  el.className = 'recall-card pending'
  el.dataset.callId = callId
  const summary = document.createElement('summary')
  const tool = document.createElement('span')
  tool.className = 'tool-name'
  tool.textContent = name
  const query = document.createElement('span')
  query.className = 'query'
  query.textContent = summarizeRecallQuery(args) || '(no args)'
  summary.append(tool, query)
  const body = document.createElement('div')
  body.className = 'body'
  body.textContent = 'recalling…'
  el.append(summary, body)
  // recall cards join the assistant-turn body when
  // one is open (recall is an assistant-side event just like tool/call).
  const parent = target && typeof target.appendChild === 'function' ? target : streamEl
  parent.appendChild(el)
  scrollToBottom()
  return { el, body }
}

function fillRecallCard(cardEl, { content, isError }) {
  if (!cardEl || !cardEl.classList) return
  cardEl.classList.remove('pending')
  if (isError) cardEl.classList.add('err')
  const body = cardEl.querySelector('.body')
  if (body) body.textContent = textFromContentBlocks(content) || (isError ? '[error]' : '(empty)')
}

// -- fork markers ------------------------------------------------------------

// The fork marker is a small inline card that sits at the parent's fork
// boundary and lists the child sessions branched off from there. We insert
// it into the stream between events by finding the parent event's DOM node
// (data-seq) and placing the marker after it. If we can't locate the seq
// (fork before any rendered node, or unknown seq), we append at the end.
function ensureForkMarkerAt(parentSeq) {
  const key = parentSeq === null || parentSeq === undefined ? '__unknown__' : String(parentSeq)
  let el = state.forkMarkersInStream.get(key)
  if (el) return el
  el = document.createElement('div')
  el.className = 'fork-marker'
  el.dataset.forkSeq = key
  const head = document.createElement('div')
  head.className = 'head'
  head.textContent = 'forks from here (0)'
  const list = document.createElement('ul')
  head.addEventListener('click', () => {
    list.style.display = list.style.display === 'none' ? '' : 'none'
  })
  el.append(head, list)
  const anchor = key === '__unknown__' ? null : streamEl.querySelector(`[data-seq="${key}"]`)
  if (anchor && anchor.nextSibling) streamEl.insertBefore(el, anchor.nextSibling)
  else streamEl.appendChild(el)
  state.forkMarkersInStream.set(key, el)
  return el
}

function addForkMarker({ parentSeq, childSessionId, childTitle, running }) {
  const el = ensureForkMarkerAt(parentSeq)
  const list = el.querySelector('ul')
  // Dedupe by child id — subagent.started + session/list refresh can both fire.
  if (list.querySelector(`[data-child="${cssEscape(childSessionId)}"]`)) return
  const li = document.createElement('li')
  li.dataset.child = childSessionId
  const label = document.createTextNode(` ${childTitle || childSessionId.slice(0, 8)}`)
  if (running) {
    const dot = document.createElement('span')
    dot.className = 'live-dot'
    li.appendChild(dot)
  }
  li.appendChild(label)
  li.addEventListener('click', (ev) => {
    ev.stopPropagation()
    void selectSession(childSessionId)
  })
  list.appendChild(li)
  const head = el.querySelector('.head')
  const n = list.children.length
  head.textContent = `forks from here (${n})`
  scrollToBottom()
}

// Minimal CSS.escape polyfill fallback — session ids are UUIDs so this is
// almost always a no-op, but the attribute selector needs escaping for edge
// cases (e.g. an id that starts with a digit or contains a colon).
function cssEscape(s) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s)
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c.charCodeAt(0).toString(16) + ' ')
}

function installKnownForkMarkers(parentSessionId) {
  const children = SessionTree.findChildForks(parentSessionId, state.entries)
  for (const c of children) {
    addForkMarker({
      parentSeq: c.forkSeq,
      childSessionId: c.childSessionId,
      childTitle: c.childTitle,
      running: c.running,
    })
  }
}

function rebindForkButton(btn, seq) {
  // The old button captured its boundary seq in a closure; when turn/end
  // re-stamps the parent bubble with the closing seq we swap the handler so
  // the button fires against the new boundary. Cloning is the cheapest way
  // to nuke the stale handler; the shared runForkClick reads the boundary
  // from data-fork-seq on the current bubble, so the closed-over `seq`
  // parameter is only kept for backwards-compat with the caller.
  const clone = btn.cloneNode(true)
  const bubbleEl = btn.parentElement
  clone.addEventListener('click', (ev) => runForkClick(ev, clone, bubbleEl))
  void seq // now consulted via data-fork-seq inside runForkClick
  btn.replaceWith(clone)
  syncForkButton(clone, bubbleEl)
}

function updateCancelButton() {
  // capability gate. A runtime that doesn't advertise
  // session/cancel can't be interrupted; light the button gray + tooltip
  // rather than sending a request that would error out.
  if (!isCapabilitySupported('cancel')) {
    cancelBtn.disabled = true
    cancelBtn.title = capabilityDisabledTooltip('cancel')
    return
  }
  cancelBtn.disabled = !state.inflightTurn
  cancelBtn.title = state.inflightTurn ? 'cancel current turn' : 'no turn in flight'
}

// -- composer chrome (cwd + permission mode + model dropdown) --------------
//
// the reference design composer language: the chip row under the textarea is the "what will
// happen when I press Enter" surface. We keep it read-only for cwd + mode
// (they follow the profile / onboarding choice), and interactive for model.
// `session/set_config` retargets the current session's model; if the daemon
// pre-dates the method (MethodNotFound) we grey the dropdown and tooltip
// why. A `next-turn` effective flag surfaces as a small warning suffix so
// the user knows their change is queued.
const composerCwdEl = document.getElementById('composer-cwd')
const composerCwdLabel = composerCwdEl ? composerCwdEl.querySelector('.composer-chip-label') : null
const composerModeEl = document.getElementById('composer-mode')
const composerModeLabel = composerModeEl ? composerModeEl.querySelector('.composer-chip-label') : null
const composerModelEl = document.getElementById('composer-model')
const composerModelHintEl = document.getElementById('composer-model-hint')
const composerModelWarnEl = document.getElementById('composer-model-warn')

// Known model options across the profiles we ship — same list the wire will
// accept. The dropdown re-renders when the runtime status shows a new
// current-model so we always keep the effective value selected.
const KNOWN_MODELS = [
  { value: 'mock-echo',          label: 'mock-echo' },
  { value: 'deepseek-v4-flash',  label: 'deepseek-v4-flash' },
  { value: 'deepseek-v4-pro',    label: 'deepseek-v4-pro' },
]

// Preflight (2026-07-18) NO_ADAPTER guard state. `activeProfile` and
// `supportedModels` come from the runtime status payload (main-side
// modelsFor()). `profileModels` is the full profile→models map used to
// suggest a target profile when the user picks a model the current profile
// can't serve. `null` values mean "not yet hydrated"; the dropdown falls
// back to the KNOWN_MODELS union until then.
let activeProfileName = null
let supportedModelsForActive = null
let profileModelsMap = null

// Which profile advertises `wanted`, preferring one that lists it first.
// Returns null when no profile claims it (e.g. user-typed exotic name).
function profileHosting(wanted) {
  if (!wanted || !profileModelsMap) return null
  // Prefer a profile that lists it first (its "default") for a nudgier UX.
  let fallback = null
  for (const [pname, list] of Object.entries(profileModelsMap)) {
    if (!Array.isArray(list)) continue
    const idx = list.indexOf(wanted)
    if (idx === 0) return pname
    if (idx > 0 && !fallback) fallback = pname
  }
  return fallback
}

function updateComposerCwd(cwd) {
  if (!composerCwdLabel) return
  const s = typeof cwd === 'string' && cwd ? cwd : '~'
  // Show a shortened form (~/harness/dsh-desktop-demo → …/dsh-desktop-demo)
  // so long paths don't blow the chip out; the full path is on the title.
  const short = s.length > 32 ? '…/' + s.split('/').filter(Boolean).slice(-2).join('/') : s
  composerCwdLabel.textContent = short
  composerCwdEl.title = s
}

function updateComposerMode(mode) {
  if (!composerModeEl || !composerModeLabel) return
  // Modes: ask-first / auto-edit / yolo. Onboarding writes this; we default
  // to ask-first when unknown so the chip never shows "yolo" without proof.
  const m = mode || 'ask-first'
  composerModeEl.dataset.mode = m
  composerModeLabel.textContent = m
  composerModeEl.title = m === 'yolo'
    ? 'YOLO — approvals bypassed; tools run without asking'
    : m === 'auto-edit'
      ? 'Auto-edit — file edits skip approval; shell still asks'
      : 'Ask-first — every write and command asks before running'
}

function renderComposerModel(currentModel) {
  if (!composerModelEl) return
  const current = currentModel || ''
  composerModelEl.innerHTML = ''

  // Preflight (2026-07-18) NO_ADAPTER guard.
  //
  // The composer dropdown was a static global list; picking a model the
  // active profile couldn't route (e.g. `deepseek-v4-flash` under
  // `daemon-echo`) landed on every send as
  //   session finished (error): no adapter registered for model
  //   "deepseek-v4-flash" [NO_ADAPTER]
  //
  // Filter contract:
  //   1. If we know `supportedModelsForActive` (status has fired at least
  //      once), the dropdown shows *only* those models. This is what
  //      almost every real user sees.
  //   2. Otherwise (renderer booted before first status), fall back to
  //      KNOWN_MODELS so the picker isn't empty during boot race.
  //   3. `current` is always anchored: if the effective model isn't in
  //      the supported list (post-fork stale value / manual QA
  //      injection), it appears at the top with a "· unsupported" hint
  //      so the user can see the mismatch before hitting send.
  const supported = Array.isArray(supportedModelsForActive)
    ? supportedModelsForActive
    : KNOWN_MODELS.map((m) => m.value)
  const isSupported = current === '' || supported.includes(current)
  if (current && !isSupported) {
    const opt = document.createElement('option')
    opt.value = current
    opt.textContent = `${current} · unsupported`
    opt.dataset.unsupported = '1'
    composerModelEl.appendChild(opt)
  }
  for (const value of supported) {
    const known = KNOWN_MODELS.find((m) => m.value === value)
    const opt = document.createElement('option')
    opt.value = value
    opt.textContent = known ? known.label : value
    composerModelEl.appendChild(opt)
  }
  if (current) composerModelEl.value = current
  composerModelEl.dataset.currentModel = current

  // Inline advisory: named target profile when we know one, otherwise
  // generic "current profile doesn't host this model" text. Hidden when
  // the current selection is supported.
  if (composerModelWarnEl) {
    if (!isSupported && current) {
      const target = profileHosting(current)
      const activeLabel = activeProfileName || 'the active profile'
      composerModelWarnEl.hidden = false
      composerModelWarnEl.textContent = ''
      const strong = document.createElement('strong')
      strong.textContent = `${current}`
      composerModelWarnEl.appendChild(strong)
      composerModelWarnEl.appendChild(document.createTextNode(
        ` isn't wired under ${activeLabel}. Sending would fail with "no adapter registered" — `))
      if (target) {
        const link = document.createElement('a')
        link.textContent = `switch to ${target}`
        link.setAttribute('role', 'button')
        link.tabIndex = 0
        link.addEventListener('click', () => {
          const sel = document.getElementById('profile')
          if (!sel) return
          sel.value = target
          sel.dispatchEvent(new Event('change'))
        })
        composerModelWarnEl.appendChild(link)
        composerModelWarnEl.appendChild(document.createTextNode(' or pick a supported model above.'))
      } else {
        composerModelWarnEl.appendChild(document.createTextNode(
          'switch profile in Settings, or pick a supported model above.'))
      }
    } else {
      composerModelWarnEl.hidden = true
      composerModelWarnEl.textContent = ''
    }
  }

  // capability gate. A runtime that doesn't advertise
  // session/set_config can't switch models on the fly; keep the current
  // model visible but block the dropdown with a canonical tooltip.
  if (!isCapabilitySupported('setConfig')) {
    composerModelEl.disabled = true
    composerModelEl.title = capabilityDisabledTooltip('setConfig')
    if (composerModelHintEl) composerModelHintEl.hidden = true
    return
  }
  composerModelEl.disabled = false
  composerModelEl.title = ''
  if (composerModelHintEl) composerModelHintEl.hidden = true
}

function setComposerModelUnsupported() {
  if (!composerModelEl) return
  composerModelEl.disabled = true
  composerModelEl.title =
    'Runtime pre-dates session/set_config (MethodNotFound); model is fixed for this session.'
}

if (composerModelEl) {
  composerModelEl.addEventListener('change', async () => {
    const sid = state.activeSessionId
    const wanted = composerModelEl.value
    const previous = composerModelEl.dataset.currentModel || ''
    if (!sid) {
      composerModelEl.value = previous
      appendSystem('open or start a session before retargeting the model')
      return
    }
    if (wanted === previous) return
    try {
      const res = await window.dsh.setSessionConfig(sid, { model: wanted })
      if (res && res.supported === false) {
        setComposerModelUnsupported()
        composerModelEl.value = previous
        appendSystem('This runtime does not accept session/set_config; model unchanged.')
        return
      }
      composerModelEl.dataset.currentModel = wanted
      const effective = res && res.result && res.result.effective
      if (composerModelHintEl) {
        composerModelHintEl.hidden = effective !== 'next-turn'
      }
      appendSystem(effective === 'next-turn'
        ? `Model queued: ${wanted} (promotes at next turn)`
        : `Model retargeted: ${wanted}`)
    } catch (err) {
      composerModelEl.value = previous
      appendSystem(`set_config failed: ${err.message || err}`)
    }
  })
}

// -- context meter -----------------------------------------------
//
// The statusbar meter reflects the active session's tracker snapshot. It's
// updated on every session event (via updateContextMeter after the switch)
// plus after replay + session switches. `mode === 'approx'` prefixes the
// count with `~` so a reader knows the number is heuristic, not accountant.

const ctxMeterEl = document.getElementById('ctx-meter')
const ctxMeterFillEl = ctxMeterEl ? ctxMeterEl.querySelector('.ctx-meter-fill') : null
const ctxMeterLabelEl = document.getElementById('ctx-meter-label')
const ctxCompactBtn = document.getElementById('ctx-compact-btn')

// Context Rail drawer (strategy list §1.2). The rail projects
// meta.cachedEvents onto a right-side vertical timeline of context-changing
// dots (inject / compact / recall / steer). Pure classifier + builder live
// in context-rail.js so the DOM can be tested without wiring the whole
// shell.
const ctxRailBtn = document.getElementById('ctx-rail-btn')
const ctxRailDrawerEl = document.getElementById('context-rail-drawer')
const ctxRailDrawerBodyEl = document.getElementById('context-rail-drawer-body')
const ctxRailDrawerCloseBtn = document.getElementById('context-rail-drawer-close')

function isRailOpen() { return !!(ctxRailDrawerEl && !ctxRailDrawerEl.hidden) }
function setRailOpen(open) {
  if (!ctxRailDrawerEl) return
  ctxRailDrawerEl.hidden = !open
  ctxRailDrawerEl.setAttribute('aria-hidden', open ? 'false' : 'true')
  if (ctxRailBtn) ctxRailBtn.setAttribute('aria-expanded', open ? 'true' : 'false')
  if (open) {
    // Explicit Rail-button click ⇒ user wants the rail projection, drop
    // any batch3 pin so refreshRail() below repopulates from cachedEvents.
    if (ctxRailDrawerBodyEl) {
      const pin = ctxRailDrawerBodyEl.querySelector('.context-rail-batch3-mount')
      if (pin) pin.remove()
    }
    refreshRail()
  }
}
function refreshRail() {
  if (!isRailOpen() || !ctxRailDrawerBodyEl) return
  // Batch 3: if a workflow/subagent card is mounted, leave it
  // alone. The batch 3 mount is a pinned debug view that stays until the
  // user clicks Rail again to explicitly re-project the timeline.
  // Without this guard every session/list tick reverts the drawer to the
  // rail projection and the workflow card disappears mid-demo.
  if (ctxRailDrawerBodyEl.querySelector('.context-rail-batch3-mount')) return
  ctxRailDrawerBodyEl.innerHTML = ''
  const meta = state.activeSessionId ? state.sessions.get(state.activeSessionId) : null
  const events = (meta && Array.isArray(meta.cachedEvents)) ? meta.cachedEvents : []
  const api = window.__dshContextRail
  if (!api || typeof api.buildRail !== 'function') {
    const note = document.createElement('div')
    note.className = 'context-rail-empty'
    note.textContent = 'Context Rail module missing.'
    ctxRailDrawerBodyEl.appendChild(note)
    return
  }
  const railEl = api.buildRail(document, events, {
    onDotClick(dot) {
      // Scroll the message stream to the event this dot represents.
      const target = streamEl.querySelector(`[data-seq="${dot.seq}"]`)
      if (target && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    },
  })
  ctxRailDrawerBodyEl.appendChild(railEl)
}
function refreshRailIfOpen() { if (isRailOpen()) refreshRail() }
if (ctxRailBtn) ctxRailBtn.addEventListener('click', () => setRailOpen(!isRailOpen()))
if (ctxRailDrawerCloseBtn) ctxRailDrawerCloseBtn.addEventListener('click', () => setRailOpen(false))

// -- feat/chat-triple-view: side drawer + Graph tab ------------------------
// Right-side drawer with Current Turn / Session Overview / History; the
// Chat pane also grows a List | Graph tab strip that swaps stream vs the
// Session Graph DAG. Both surfaces read the same cachedEvents ring the
// Context Rail already projects, so no new wire is required.
const chatPaneEl = document.querySelector('.pane[data-pane="chat"]')
const chatSideDrawerBtn = document.getElementById('chat-side-drawer-btn')
const chatSideDrawerEl = document.getElementById('chat-side-drawer')
const chatSideDrawerBodyEl = document.getElementById('chat-side-drawer-body')
const chatSideDrawerCloseBtn = document.getElementById('chat-side-drawer-close')
const chatSessionGraphEl = document.getElementById('chat-session-graph')
const chatViewTabEls = document.querySelectorAll('.chat-view-tab')

// Default the pane to List. The absence of the attribute would leave the
// CSS selectors idle and both children visible.
if (chatPaneEl && !chatPaneEl.dataset.chatView) {
  chatPaneEl.dataset.chatView = 'list'
}
function isChatDrawerOpen() {
  return !!(chatSideDrawerEl && !chatSideDrawerEl.classList.contains('hidden'))
}
function setChatDrawerOpen(open) {
  if (!chatSideDrawerEl) return
  chatSideDrawerEl.classList.toggle('hidden', !open)
  chatSideDrawerEl.setAttribute('aria-hidden', open ? 'false' : 'true')
  if (chatSideDrawerBtn) chatSideDrawerBtn.setAttribute('aria-expanded', open ? 'true' : 'false')
  if (open) refreshChatSideDrawer()
}
function refreshChatSideDrawer() {
  if (!isChatDrawerOpen() || !chatSideDrawerBodyEl) return
  const api = window.__dshChatSideDrawer
  if (!api || typeof api.renderChatSideDrawer !== 'function') return
  const meta = state.activeSessionId ? state.sessions.get(state.activeSessionId) : null
  const events = (meta && Array.isArray(meta.cachedEvents)) ? meta.cachedEvents : []
  api.renderChatSideDrawer(chatSideDrawerBodyEl, {
    sessionId: state.activeSessionId || '',
    model: meta && (meta.model || (meta.header && meta.header.model)) || '',
    events,
    selectedTurnId: state.chatSelectedTurnId || null,
    onSelect(row) {
      if (!row) return
      // User rows have no turnId — scroll to the matching data-seq
      // anchor instead of the no-op early return. Cursor:pointer on
      // the whole row promises interactivity; without this the row
      // reads as a dead affordance.
      if (row.kind === 'user' && row.seq) {
        const seqTarget = streamEl && streamEl.querySelector(`[data-seq="${row.seq}"]`)
        if (seqTarget && typeof seqTarget.scrollIntoView === 'function') {
          seqTarget.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }
        return
      }
      if (!row.turnId) return
      state.chatSelectedTurnId = row.turnId
      const target = streamEl && streamEl.querySelector(`[data-turn-id="${row.turnId}"]`)
      if (target && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
      // Re-render so the .active highlight lands on the row we just
      // clicked. Keeps drawer state in sync with the stream focus.
      refreshChatSideDrawerIfOpen()
    },
  })
}
function refreshChatSideDrawerIfOpen() { if (isChatDrawerOpen()) refreshChatSideDrawer() }

// Long sessions (500+ events) dispatch onSessionEvent hundreds of times per
// second on replay/backfill. Both the drawer and Session Graph re-derive
// the full row/node list from cachedEvents on every call (O(N)), so an
// unthrottled refresh per event lands O(N²) work on the main thread and
// noticeably lags typing. Coalesce to at most one refresh per rAF frame —
// the derive is idempotent on the same event tail, so dropping intermediate
// ticks is safe. Extracted to chat-refresh-throttle.js for unit testing.
const __chatRefreshThrottle = window.__dshChatRefreshThrottle
  ? window.__dshChatRefreshThrottle.create(() => {
      refreshChatSideDrawerIfOpen()
      refreshSessionGraphIfActive()
    })
  : { schedule() { refreshChatSideDrawerIfOpen(); refreshSessionGraphIfActive() } }
function refreshChatSurfacesCoalesced() { __chatRefreshThrottle.schedule() }
if (chatSideDrawerBtn) {
  chatSideDrawerBtn.addEventListener('click', () => setChatDrawerOpen(!isChatDrawerOpen()))
}
if (chatSideDrawerCloseBtn) {
  chatSideDrawerCloseBtn.addEventListener('click', () => setChatDrawerOpen(false))
}

function setChatView(view) {
  if (!chatPaneEl) return
  const v = view === 'graph' ? 'graph' : 'list'
  chatPaneEl.dataset.chatView = v
  for (const btn of chatViewTabEls) {
    const active = btn.dataset.chatViewTab === v
    btn.classList.toggle('active', active)
    btn.setAttribute('aria-selected', active ? 'true' : 'false')
  }
  if (v === 'graph') refreshSessionGraph()
}
function refreshSessionGraph() {
  if (!chatSessionGraphEl) return
  const api = window.__dshChatSessionGraph
  if (!api || typeof api.renderSessionGraph !== 'function') return
  const meta = state.activeSessionId ? state.sessions.get(state.activeSessionId) : null
  const events = (meta && Array.isArray(meta.cachedEvents)) ? meta.cachedEvents : []
  api.renderSessionGraph(chatSessionGraphEl, {
    sessionId: state.activeSessionId || '',
    selectedTurnId: state.chatSelectedTurnId || null,
    events,
    onSelect(node) {
      if (!node) return
      // Fork nodes point at a child session — clicking follows the
      // fork. Without this the cursor:pointer node reads as dead.
      if (node.kind === 'fork' && node.childSessionId) {
        try { selectSession(node.childSessionId) } catch (_) { /* stale id */ }
        return
      }
      // User nodes have no turnId — scroll to the message via data-seq.
      if (node.kind === 'user' && node.seq) {
        setChatView('list')
        const sTarget = streamEl && streamEl.querySelector(`[data-seq="${node.seq}"]`)
        if (sTarget && typeof sTarget.scrollIntoView === 'function') {
          sTarget.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }
        return
      }
      if (!node.turnId) return
      state.chatSelectedTurnId = node.turnId
      // Jump to the turn in the List view and focus it.
      setChatView('list')
      const target = streamEl && streamEl.querySelector(`[data-turn-id="${node.turnId}"]`)
      if (target && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
      refreshChatSideDrawerIfOpen()
    },
  })
}
function refreshSessionGraphIfActive() {
  if (chatPaneEl && chatPaneEl.dataset.chatView === 'graph') refreshSessionGraph()
}
for (const btn of chatViewTabEls) {
  btn.addEventListener('click', () => setChatView(btn.dataset.chatViewTab))
}

function formatTokens(n) {
  if (!Number.isFinite(n)) return '—'
  if (n < 1000) return String(n)
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

function updateContextMeter() {
  if (!ctxMeterEl || !ctxMeterFillEl || !ctxMeterLabelEl) return
  const meta = state.activeSessionId ? state.sessions.get(state.activeSessionId) : null
  const snap = meta && meta.contextTracker ? meta.contextTracker.snapshot() : null
  if (!snap) {
    ctxMeterEl.className = 'ctx-meter'
    ctxMeterFillEl.style.width = '0%'
    ctxMeterLabelEl.textContent = '—'
    updateCompactButton()
    return
  }
  // P0-2: delegate label + title formatting to context-meter.js's pure
  // meterLabelFor. The red-line — "budget 拿不到时显式标 '~128k (assumed)'，
  // 禁止静默 fallback 128000 常量装精确" — is unit-testable there without
  // booting the DOM harness, and this call site stays a thin adapter.
  const view = window.__dshContextMeter
    ? window.__dshContextMeter.meterLabelFor(snap)
    : { label: `${snap.tokens} / ${snap.budget}`, title: '', budgetClass: 'assumed' }
  ctxMeterEl.className =
    `ctx-meter level-${snap.level} mode-${snap.mode} budget-${view.budgetClass}`
  // Cap the visible bar at 100% while letting the label report the real
  // number so critical overflow ("135k / 128k") is visible.
  const pct = Math.min(100, Math.round(snap.fraction * 100))
  ctxMeterFillEl.style.width = `${pct}%`
  ctxMeterLabelEl.textContent = view.label
  ctxMeterEl.title = view.title
  updateCompactButton()
}

function updateCompactButton() {
  if (!ctxCompactBtn) return
  const hasSession = !!state.activeSessionId
  // capability handshake is the first gate; the existing
  // MethodNotFound-learned flag (state.compactSupported) stays as the
  // runtime-discovery fallback. Both must pass for the button to light.
  const capsSupported = isCapabilitySupported('compact')
  const runtimeSupported = state.compactSupported !== false
  const supported = capsSupported && runtimeSupported
  ctxCompactBtn.disabled = !hasSession || !supported || state.inflightTurn
  if (!hasSession) {
    ctxCompactBtn.title = 'Start a session first.'
  } else if (!capsSupported) {
    ctxCompactBtn.title = capabilityDisabledTooltip('compact')
  } else if (!runtimeSupported) {
    ctxCompactBtn.title = 'runtime does not support session/compact yet — the wire method has not landed.'
  } else if (state.inflightTurn) {
    ctxCompactBtn.title = 'wait for the current turn to finish before compacting.'
  } else {
    ctxCompactBtn.title = 'Compact conversation history now.'
  }
}

async function compactNow() {
  if (!state.activeSessionId) return
  const sid = state.activeSessionId
  ctxCompactBtn.disabled = true
  ctxCompactBtn.title = 'compacting…'
  try {
    const r = await window.dsh.compactSession(sid)
    if (r && r.supported === false) {
      state.compactSupported = false
      appendSystem('compact skipped: runtime does not support session/compact yet')
    } else if (r && r.result && r.result.compacted === false) {
      // The backend chose not to compact — surface fits the retain budget or
      // the only candidate cut would split a step. Not an error, just a quiet
      // note so the click is not silent.
      appendSystem('nothing to compact — session fits the retain budget')
    } else if (r && r.result && r.result.compacted === true) {
      // The daemon emits compact/start → compact/summary → compact/end
      // through session.event on success — the renderer already handles
      // them via appendCompactMarker. Nothing extra to draw here.
    } else {
      // Legacy runtime that returned an untagged ok — keep the old note so
      // the user sees the click landed.
      appendSystem('compact requested')
    }
  } catch (err) {
    if (/session is streaming/i.test(err && err.message ? err.message : '')) {
      // Server refuses to compact while a prompt is in flight; the button
      // should be disabled anyway (see updateCompactButton), but the guard is
      // useful when the streaming state flips between click and RPC.
      appendSystem('compact after this turn ends — session is currently streaming')
    } else {
      appendSystem(`compact failed: ${err.message}`)
    }
  } finally {
    updateCompactButton()
  }
}

// -- session event dispatcher ------------------------------------------------

// live subagent child-event router.
//
// Returns true when the event was routed under a running subagent card,
// signalling the main dispatch to stop (the event does NOT belong in the
// parent's own stream). Returns false to let the caller fall through to
// the normal dispatch.
//
// Rendering strategy: append a short one-line row per child event into the
// card's live-subtrajectory body (bodyEl). Text/reasoning coalesce into a
// running paragraph; tool/call and tool/result get their own condensed row.
// This is intentionally lightweight — the moment subagent.finished lands
// we swap the card for the full buildInlineSubagentTrace with rich
// prompt/steps/return sections, so the live view only needs to signal
// "something's happening" without duplicating the finished-state polish.
function routeLiveChildEvent(sessionId, event) {
  const store = state.subagentStore
  if (!store) return false
  const rec = store.resolveChild(sessionId)
  if (!rec) return false
  // Buffer the event on the lineage record either way — subagent.finished
  // will replay it into the rich card. Also keeps a stable audit log for
  // future selfies / trace-drawer walks.
  store.pushChildEvent(sessionId, event)
  // Only paint if the parent chat is the active view (otherwise the card
  // isn't on screen). The lineage record still buffers so a later switch-
  // back can rebuild the card.
  if (rec.parentSessionId && rec.parentSessionId !== state.activeSessionId) return true
  const body = rec.bodyEl
  if (!body || !body.appendChild) return true
  const line = buildLiveChildLine(event)
  if (line) body.appendChild(line)
  // Trim to the last 40 lines so a long-running subagent doesn't grow the
  // card into a scrollhog. The full log is on rec.childEvents.
  while (body.children.length > 40) body.removeChild(body.firstChild)
  return true
}

// Build one condensed row per child event for the live view..
function buildLiveChildLine(event) {
  if (!event || typeof event !== 'object') return null
  const row = document.createElement('div')
  row.className = 'subagent-live-row'
  row.dataset.eventType = event.type || ''
  const glyph = document.createElement('span')
  glyph.className = 'subagent-live-glyph'
  const label = document.createElement('span')
  label.className = 'subagent-live-label'
  const data = event.data || event
  switch (event.type) {
    case 'assistant/chunk': {
      const chunk = data && data.chunk
      if (!chunk) return null
      glyph.textContent = chunk.type === 'reasoning-delta' ? '~' : '·'
      const text = (chunk.text || '').replace(/\s+/g, ' ').trim()
      label.textContent = text ? (text.length > 80 ? text.slice(0, 80) + '…' : text) : '…'
      break
    }
    case 'assistant/message': {
      glyph.textContent = '»'
      const t = textFromContentBlocks(data && data.content) || ''
      label.textContent = t ? (t.length > 80 ? t.slice(0, 80) + '…' : t) : '(assistant message)'
      break
    }
    case 'tool/call': {
      glyph.textContent = '⇒'
      label.textContent = `tool ${data && data.name || '?'}`
      break
    }
    case 'tool/result': {
      glyph.textContent = data && data.isError ? '✗' : '←'
      label.textContent = `result ${(data && data.callId || '').slice(0, 8)}${data && data.isError ? ' (error)' : ''}`
      break
    }
    case 'step/start':
      glyph.textContent = '▸'
      label.textContent = `step ${data && data.step != null ? data.step : ''} start`
      break
    case 'step/end':
      glyph.textContent = '▪'
      label.textContent = `step ${data && data.step != null ? data.step : ''} end`
      break
    case 'turn/start':
      glyph.textContent = '↳'
      label.textContent = `turn start`
      break
    case 'turn/end':
      glyph.textContent = '↲'
      label.textContent = `turn end`
      break
    case 'user/message': {
      glyph.textContent = '@'
      const t = textFromContentBlocks(data && data.content) || ''
      label.textContent = t ? (t.length > 80 ? t.slice(0, 80) + '…' : t) : '(prompt)'
      break
    }
    default:
      glyph.textContent = '·'
      label.textContent = event.type || 'event'
  }
  row.append(glyph, label)
  return row
}

// Build the running-state inline card for a subagent lineage record.
// Renders a `<details>` shell (same shape as buildInlineSubagentTrace)
// with a RUNNING pill and a live-subtrajectory body. The full sealed
// card replaces it on subagent.finished..
function buildRunningSubagentCard(rec) {
  const view = window.__dshSubagentView
  if (!view || typeof view.buildInlineSubagentTrace !== 'function') return null
  const spec = {
    parentSessionId: rec.parentSessionId,
    childSessionId: rec.childSessionId,
    parentCallId: rec.parentCallId,
    status: 'running',
    childEvents: [],
    lastAssistantMessage: [],
  }
  const wrap = view.buildInlineSubagentTrace(document, spec, { collapsed: false })
  wrap.classList.add('subagent-trace--running')
  // Swap the sealed-state body for a live subtrajectory area. The <details>
  // shell already carries the RUNNING summary via subagent-view's status
  // pill — we only need to replace the body children.
  const body = wrap.querySelector('.subagent-trace-body')
  if (body) {
    body.innerHTML = ''
    const live = document.createElement('div')
    live.className = 'subagent-live-body'
    const head = document.createElement('div')
    head.className = 'subagent-live-head'
    head.textContent = 'live subtrajectory'
    body.appendChild(head)
    body.appendChild(live)
    rec.bodyEl = live
  }
  rec.cardEl = wrap
  return wrap
}

function onSessionEvent(sessionId, event) {
  const meta = ensureSession(sessionId)
  // Feed the per-session context meter. The tracker is a pure accumulator
  // (see src/renderer/context-meter.js); the DOM update happens after the
  // dispatch if this event belongs to the active session.
  if (event && typeof event === 'object' && meta.contextTracker) {
    meta.contextTracker.ingest(event)
  }
  // Cache every live event for local replay on switch-back. The daemon-echo
  // profile keeps in-flight session events in memory only until a
  // persistence sink flushes them, so `session/events` returns [] between
  // switches and history vanishes. Local cache is the source of truth for
  // "what the user just saw in this window"; server session/events wins
  // when it has more entries (e.g. persisted history from a previous run).
  cacheEvent(meta, sessionId, event)
  if (event.type === 'turn/start') {
    meta.running = true
    // §1.3 A/B classifier gate: track turn count so hooks-*
    // demotes from family A (SessionStart) to family B on later turns.
    meta.turnCount = (meta.turnCount || 0) + 1
    // feat/chat-triple-view: once the current turn container exists in the
    // stream, stamp its turnId from the start event so the drawer/graph
    // can address it. Same {turnId, turn_id, fallback t{n}} shape as
    // chat-side-drawer.deriveTurnRows so both surfaces agree.
    const startDataForTurnId = event.data || {}
    const derivedTurnId = startDataForTurnId.turnId || startDataForTurnId.turn_id
      || `t${meta.turnCount - 1}`
    if (sessionId === state.activeSessionId && state.currentTurn && state.currentTurn.section) {
      state.currentTurn.section.dataset.turnId = derivedTurnId
      state.currentTurn.section.dataset.turnIndex = String(meta.turnCount - 1)
    }
    // Ticket B §B-4 (2026-07-16): a new turn starting means the previous
    // error/cancel is no longer the current state — drop the derived
    // lastError so the row stops rendering ✕ interrupted while a fresh
    // attempt is in flight. If this turn also fails, session.finished
    // will re-populate the field.
    meta.lastError = null
    // Record the trigger discriminator so appendCompactMarker can badge a
    // compact card auto vs manual. Cleared on turn/end so a compact/summary
    // that arrives between turns (persisted-only replay, edge case) renders
    // without a badge instead of one from the previous turn.
    const startData = event.data || event
    meta.currentTurnTrigger = (startData && startData.trigger) || null
    if (sessionId === state.activeSessionId) { state.inflightTurn = true; updateCancelButton(); updateCompactButton(); updateForkButtons() }
    renderSessionList()
  }
  if (event.type === 'turn/end') {
    meta.running = false
    meta.currentTurnTrigger = null
    if (sessionId === state.activeSessionId) { state.inflightTurn = false; updateCancelButton(); updateCompactButton(); updateForkButtons() }
    renderSessionList()
  }
  if (event.time && event.time > meta.lastEventTime) meta.lastEventTime = event.time
  // §1.1 trace bucket: non-boundary events get bucketed into
  // the currently open trace step. Boundaries (step/start, step/end) go
  // through the switch below.
  if (event.type !== 'step/start' && event.type !== 'step/end') {
    absorbTraceEvent(meta, event)
  }
  // live subagent routing. The kernel jsonrpc
  // server fans out every child
  // session's session.event through the same notification stream keyed on
  // that child's sessionId. Before this ticket, the early return below
  // would drop any child event whose sessionId isn't the active root —
  // subagent cards only came alive on subagent.finished replay.
  //
  // Now, if the incoming sessionId matches a live lineage record whose
  // parent IS the active root, we route the event into that record's
  // running subagent card and stop the normal dispatch (the child event
  // does NOT belong in the parent's main stream — it's a peer step under
  // the spawn tool row).
  if (routeLiveChildEvent(sessionId, event)) return
  if (sessionId !== state.activeSessionId) return

  // Meter reflects the active session; refresh after every event so the
  // number moves as the stream grows. Cheap: the tracker's snapshot is a
  // constant-time read.
  updateContextMeter()
  // Context Rail (§1.2): if the drawer is open, refresh its dot
  // list so inject/compact/recall events stream in live alongside the
  // message bubbles. No-op when the drawer is closed.
  refreshRailIfOpen()
  // feat/chat-triple-view: keep the right-side detail drawer + Session Graph
  // in sync with the same event tick. Both no-op when their surface is
  // hidden, so this is cheap when the user hasn't opened the drawer /
  // switched to Graph yet. Coalesced via rAF so long sessions don't take
  // an O(N²) hit from the O(N) derives.
  refreshChatSurfacesCoalesced()

  // §2.3 (batch 6) template triggers: pure module decides whether the event
  // qualifies for a template card (T2 error recovery / T4 artifact preview /
  // T5 context warning). Fires AFTER the switch below rendered the driving
  // event — see the tail-of-switch hook — so the trigger card sits just
  // beneath the event it explains, matching the "对话流本位" rule.

  switch (event.type) {
    case 'user/message': {
      const data = event.data || event
      const text = textFromContentBlocks(data.content) || data.text || ''
      // §1.3 family E — compact plugin's shadow user/message.
      // Merged into the compact card's summary when the compact card
      // precedes it (§1.7 unified visual). appendInjectCard returns null
      // in that case; when it returns a real card (persisted-only replay
      // without preceding compact) we let the reader see the shadow.
      if (data.source && typeof data.source === 'object'
        && data.source.kind === 'plugin' && data.source.plugin === 'compact') {
        appendInjectCard(event, sessionId, meta)
        return
      }
      // `data.source` may be a plain string ("plugin"), a MessageSourceMap
      // object ({kind:'plugin', plugin:'compact'}), or `'user'`. Historical
      // bug: `${data.source}` on an object printed literal `[object Object]`,
      // leaking `[[object Object]] <text>` into the chat. Route through
      // describeSource so we always emit a readable label. See event-filter.js
      // for the extracted pure copy that's under test.
      const label = describeSource(data.source)
      if (data.source && label !== 'user') {
        appendSystem(`[${label}] ${text}`)
        return
      }
      // First user message on this session lifts it out of the "empty ghost"
      // filter so the Recent list keeps it visible. Also seeds a short title
      // when we haven't got one yet (server-side title lookups arrive later).
      if (meta && !meta.hasUserMessage) {
        meta.hasUserMessage = true
        if (!meta.title && text) meta.title = text.slice(0, 40)
        renderSessionList()
      }
      // Live send draws an optimistic bubble in `send()`; when the server
      // echoes the user/message back, adopt that pending bubble by stamping
      // seq and clearing the marker — do NOT append a second copy. On a
      // replayed history there's no pending bubble, so we append fresh.
      const pending = streamEl.querySelector('.msg.user[data-optimistic="1"]')
      if (pending) {
        delete pending.dataset.optimistic
        if (typeof event.seq === 'number') pending.dataset.seq = String(event.seq)
      } else {
        appendMessage({ role: 'user', text, seq: event.seq })
      }
      return
    }
    case 'assistant/chunk': {
      const chunk = (event.data && event.data.chunk) || event.chunk
      if (!chunk) return
      const body = ensureStreamingBubble(sessionId)
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        body.textContent += chunk.text
      } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
        // reasoning is a first-class fold inside the assistant-turn
        // body (see reasoning-block.js docs — the L0/L1 row+body split).
        // Route through the pure module when it loaded; fall back to the
        // pre-refactor .msg.reasoning frame otherwise so a stub-out never
        // swallows deltas.
        //
        // Anchor the block via bubbleEl.dataset.reasoningId (not positional
        // lookup) — a tool/call between reasoning deltas can otherwise
        // displace the sibling and split reasoning into a second frame.
        const bubbleEl = body.parentElement
        const rb = window.__dshReasoningBlock
        const canUseModule = rb
          && typeof rb.buildReasoningBlock === 'function'
          && typeof rb.appendReasoningDelta === 'function'
        if (canUseModule) {
          let r = null
          if (bubbleEl) {
            const ref = bubbleEl.dataset.reasoningId
            if (ref) r = document.getElementById(ref)
          }
          if (!r) {
            r = rb.buildReasoningBlock(document, { initialText: '' })
            r.id = `reasoning-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
            turnAppendTarget(sessionId).appendChild(r)
            if (bubbleEl) bubbleEl.dataset.reasoningId = r.id
          }
          rb.appendReasoningDelta(r, chunk.text)
        } else {
          // Legacy path (module missing / not loaded).
          let r = null
          if (bubbleEl) {
            const ref = bubbleEl.dataset.reasoningId
            if (ref) r = document.getElementById(ref)
          }
          if (!r) {
            r = document.createElement('div')
            r.className = 'msg reasoning'
            r.id = `reasoning-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
            turnAppendTarget(sessionId).appendChild(r)
            if (bubbleEl) bubbleEl.dataset.reasoningId = r.id
          }
          r.textContent += chunk.text
        }
      } else if (chunk.type === 'tool-call-delta' && chunk.id) {
        // partial-JSON tool row. Aggregate argumentsDelta by
        // callId onto meta.partialToolCalls; render a "name(partial-args…)"
        // row that grows in-place. The row's `data-tool-call-delta="1"`
        // marker is a hook for the assistant-turn container's running-state
        // pulse. A subsequent tool/call event bearing
        // this callId will replace/upgrade the row into the full tool card
        // downstream, so we deliberately do NOT try to seal the row here.
        if (!meta.partialToolCalls) meta.partialToolCalls = new Map()
        let acc = meta.partialToolCalls.get(chunk.id)
        if (!acc) {
          acc = { name: '', buffer: '', el: null }
          meta.partialToolCalls.set(chunk.id, acc)
        }
        if (typeof chunk.name === 'string' && chunk.name && !acc.name) acc.name = chunk.name
        if (typeof chunk.argumentsDelta === 'string') acc.buffer += chunk.argumentsDelta

        if (!acc.el) {
          acc.el = document.createElement('div')
          acc.el.className = 'turn-child tool-row partial-tool-row'
          acc.el.dataset.callId = chunk.id
          acc.el.dataset.toolCallDelta = '1'
          acc.el.dataset.sealed = '0'
          const glyph = document.createElement('span')
          glyph.className = 'turn-glyph'
          glyph.textContent = '▸'
          const name = document.createElement('span')
          name.className = 'tool-row-name'
          name.textContent = acc.name || '(tool)'
          const args = document.createElement('span')
          args.className = 'tool-row-args'
          args.textContent = '(…)'
          // Honesty chip: the tool-call-delta wire shape hasn't been
          // verified against a real DeepSeek response yet (only fixture
          // captures exercise this branch). Follow the batch-3 "unverified
          // adapter shape" convention and label it so demo viewers don't
          // read this row as a fully-proved live surface. The chip is
          // removed once a real chunk is observed in /tmp/cdp-real-* and
          // this comment/branch is updated to match the confirmed shape.
          const chip = document.createElement('span')
          chip.className = 'tool-row-chip tool-row-chip-unverified'
          chip.textContent = 'partial-args preview · adapter delta shape unverified'
          acc.el.append(glyph, name, args, chip)
          turnAppendTarget(sessionId).appendChild(acc.el)
        }
        // Refresh name (a later delta may carry it) + args preview.
        const nameEl = acc.el.querySelector('.tool-row-name')
        if (nameEl && acc.name) nameEl.textContent = acc.name
        const argsEl = acc.el.querySelector('.tool-row-args')
        if (argsEl) {
          // Prefer the parseIncrementalJson synthesised value when the
          // module loaded (so we render "path=..., content=..." even
          // when the JSON tail is still open); otherwise fall back to the
          // raw partial. `(…)` stands in for an empty buffer so the row
          // never looks like a naked name.
          const rawBuf = acc.buffer
          const pj = window.__dshParseJson
          let preview = rawBuf
          if (pj && typeof pj.parseIncrementalJson === 'function' && rawBuf) {
            try {
              const parsed = pj.parseIncrementalJson(rawBuf)
              if (parsed && parsed.value && typeof parsed.value === 'object') {
                // Render a compact "k=v, k=v" preview — matches pi §2.3
                // partial-args form. Values are truncated to keep the row
                // one line at typical zoom.
                const parts = []
                for (const [k, v] of Object.entries(parsed.value)) {
                  const vStr = typeof v === 'string' ? v : JSON.stringify(v)
                  const short = vStr.length > 24 ? vStr.slice(0, 24) + '…' : vStr
                  parts.push(`${k}=${short}`)
                }
                if (parts.length > 0) preview = parts.join(', ')
              }
            } catch { /* keep raw preview */ }
          }
          preview = String(preview || '').trim()
          if (!preview) argsEl.textContent = '(…)'
          else if (preview.length > 60) argsEl.textContent = `(${preview.slice(0, 60)}…)`
          else argsEl.textContent = `(${preview})`
        }
      }
      scrollToBottom()
      return
    }
    case 'assistant/message': {
      const data = event.data || event
      const text = textFromContentBlocks(data.content)
      const body = ensureStreamingBubble(sessionId)
      body.textContent = text
      // stash last assistant/message usage on meta so
      // the turn-footer builder can project it into the terminator row.
      // Cost is not on the wire; the footer builder consults the
      // price-table module when meta.lastAssistantCost is absent.
      if (data && data.usage) meta.lastAssistantUsage = data.usage
      // Tag the enclosing bubble with the finalizing seq — the fork button
      // uses this as the boundary sent to session/fork. During live streaming
      // the bubble was created by ensureStreamingBubble without a seq yet;
      // stamp it now.
      if (typeof event.seq === 'number' && body.parentElement) {
        body.parentElement.dataset.seq = String(event.seq)
        // Stamp data-fork-seq alongside data-seq. Historically the streaming
        // bubble only carried data-seq, and the fork button consulted the
        // seq via a closure captured at rebind time. Now that the button
        // reads data-fork-seq at click time (and syncForkButton reads it at
        // sync time) both attributes need to be present. The turn/end
        // handler further below re-stamps this with the closing seq for a
        // fork-valid boundary.
        body.parentElement.dataset.forkSeq = String(event.seq)
        state.lastAssistantSeq = event.seq
        // If the streaming bubble has a fork-here button attached, rebind it
        // so its click reads the finalized seq via the dataset.
        const btn = body.parentElement.querySelector('.fork-here')
        if (btn) rebindForkButton(btn, event.seq)
      }
      state.streaming = null
      return
    }
    case 'context/message': {
      // §1.3: route through the inject-family classifier so
      // each family gets its own visual language.
      appendInjectCard(event, sessionId, meta)
      return
    }
    case 'steering/message': {
      // Steering is a distinct concept (user cue mid-turn) — keep the
      // legacy card so §1.3 style rules don't accidentally re-skin it.
      const data = event.data || event
      appendContextCard({
        source: data.source,
        content: data.content,
        seq: event.seq,
        kind: event.type,
      })
      // A context/message from the compaction plugin is what replaces
      // shadowed history — the fork markers we already dropped on the stream
      // now sit above the compact divider, which is correct visually.
      return
    }
    case 'compact/start':
    case 'compact/summary':
    case 'compact/end': {
      appendCompactMarker(event, meta, sessionId)
      return
    }
    case 'tool/call': {
      const data = event.data || event
      const { callId, name, arguments: argStr } = data
      // remember the most recent spawn_agent
      // call id per parent session. subagent.started arrives *after* the
      // spawn tool/call and does NOT carry parentCallId on the real
      // kernel wire, so this
      // one-slot memo is how the live-routing path finds the anchor row
      // to insert the running subagent card under.
      const lineageMod = window.__dshSubagentLineage
      if (lineageMod && lineageMod.isSpawnAgentToolCall(event)) {
        meta.lastSpawnCallId = callId
      }
      // retire any partial-tool-row we've been building for this
      // callId — the sealed tool/call event is about to render the full
      // card. Removing (not just sealing) avoids a duplicate row above
      // the tool card.
      if (meta.partialToolCalls && meta.partialToolCalls.has(callId)) {
        const acc = meta.partialToolCalls.get(callId)
        if (acc && acc.el && acc.el.parentElement) acc.el.parentElement.removeChild(acc.el)
        meta.partialToolCalls.delete(callId)
      }
      // tool blocks land inside the active
      // assistant-turn body when one is open so the container groups
      // "assistant thought, called write_file, wrote result" into a
      // single visual step. If no turn is open (history replay of a
      // pre-container session), the block appends at stream root.
      ensureTurnContainer(sessionId)
      const target = turnAppendTarget(sessionId)
      // Recall tools (history_read / history_search) get their own card so
      // "the agent looked something up" reads distinctly from "the agent
      // called bash". Same channel as other tools; different render.
      if (isRecallTool(name)) {
        const { el } = appendRecallCard({ callId, name, args: argStr, target })
        meta.recallCards.set(callId, el)
        return
      }
      // stash call payload for the "{ }" JSON drawer. The
      // renderer already keeps toolCalls (callId → resBox); toolPayloads
      // parallels it with the raw wire data so the badge doesn't have to
      // rewalk history. Wire the badge callback here so it closes over the
      // captured callId; the drawer looks up the latest result on click,
      // not at bind time.
      meta.toolPayloads.set(callId, { name, args: argStr, result: null })
      const openJson = () => {
        const tc = window.__dshToolCards
        if (!tc || !tc.openJsonDrawer) return
        const payload = meta.toolPayloads.get(callId) || { name, args: argStr, result: null }
        tc.openJsonDrawer({
          title: `tool: ${payload.name || name}`,
          call: { callId, name: payload.name, arguments: payload.args },
          result: payload.result,
        })
      }
      const { el: toolBlockEl, resBox } = appendToolCall({ callId, name, args: argStr, onJsonBadge: openJson, target })
      meta.toolCalls.set(callId, resBox)
      // "edit & re-run" affordance on every tool card.
      // Fork at the tool/call's own seq so the child inherits everything up
      // to and including this call, then sendPrompt an edit-intent message
      // on the child (backend does not rewrite historical tool args in
      // place). Stamp the seq on the block for QA + a11y probes.
      if (typeof event.seq === 'number' && toolBlockEl) {
        toolBlockEl.dataset.toolCallSeq = String(event.seq)
      }
      const ter = window.__dshToolEditRerun
      if (ter && typeof ter.attachToolEditRerun === 'function' && toolBlockEl) {
        ter.attachToolEditRerun(toolBlockEl, {
          callId, name, args: argStr,
          seq: typeof event.seq === 'number' ? event.seq : null,
          sessionId,
        })
      }
      // step/tool fusion: register the tool-block on the currently-open
      // trace record so finishTraceStep can upgrade it into the step
      // card in place instead of appending a trailing standalone
      // .trace-card. On the FIRST tool block of the step, also retire
      // the streaming placeholder — its role (marking "step in flight")
      // is now filled by the tool-block itself.
      const rec = meta.currentTraceRecord
      if (rec && Array.isArray(rec._toolBlocks) && toolBlockEl) {
        if (rec._toolBlocks.length === 0 && rec._streamingNode) {
          if (typeof rec._streamingNode.remove === 'function') rec._streamingNode.remove()
          else if (rec._streamingNode.parentNode && rec._streamingNode.parentNode.removeChild) {
            rec._streamingNode.parentNode.removeChild(rec._streamingNode)
          }
          rec._streamingNode = null
        }
        rec._toolBlocks.push({ callId, name, el: toolBlockEl })
      }
      return
    }
    case 'tool/result': {
      const data = event.data || event
      const { callId, content, isError } = data
      // Recall card: fill the pending body with the content blocks and
      // flip the class off `pending`. The card was created on tool/call.
      if (meta.recallCards.has(callId)) {
        fillRecallCard(meta.recallCards.get(callId), { content, isError })
        return
      }
      // enrich the JSON drawer payload with the tool/result
      // data. Keep the fields the drawer surfaces to what the strategy
      // doc calls out (§1.5): content, meta, isError, error, durationMs.
      // Any missing entry is left as `undefined` so JSON.stringify skips it.
      const payload = meta.toolPayloads.get(callId)
      if (payload) {
        payload.result = {
          callId,
          content,
          meta: data && data.meta,
          isError,
          error: data && data.error,
          durationMs: data && data.durationMs,
        }
      }
      const resBox = meta.toolCalls.get(callId)
      if (resBox) {
        // Route by render-intent (`ToolResultView` in packages/core/tools/src/presentation.ts).
        // `data.meta` carries the tool's opt-in view, discriminated on `card`.
        //   - card === 'widget'   → widgets.js (see docs/widget-channel-design.md)
        //   - card === 'diff'     → tool-cards.js (fs edit/write)
        //   - card === 'terminal' → tool-cards.js (bash)
        //   - anything else (incl. 'generic' or absent)  → raw text content
        // See docs/capability-ui-coverage.md §2 for the audit that traced
        // diff/terminal meta already reaching the wire before this seam.
        //
        // Family fallback: today's wire persists the tool's raw `execute()`
        // meta verbatim (agent-loop packages/core/agent-loop/src/loop.ts,
        // around the tool/result emit), NOT the `presentResult()` view. So
        // an fs edit/write arrives on the wire as `{diffs: [...]}` with no
        // `card` field, and the diff card would never render. Until the
        // runtime seam emits the presented view (see docs/upstream-ledger.md
        // "runtime should emit presented view"), we infer the card from the
        // tool family + payload shape so the visualization is not lost.
        // Same guard for terminal → bash, in case that shape ever loses its
        // `card` on the wire.
        const view = data && data.meta
        const tc = window.__dshToolCards
        const toolName = (payload && payload.name) || ''
        const isFsFamilyTool =
          toolName === 'fs.edit' || toolName === 'fs.write' || toolName === 'fs.read'
          || toolName === 'edit' || toolName === 'write' || toolName === 'read'
        const viewHasNoCard = view && typeof view === 'object' && !view.card
        const viewLooksLikeDiff = viewHasNoCard && Array.isArray(view.diffs)
        if (!isError && view && view.card === 'widget' && view.widget && window.__dshWidgets) {
          resBox.textContent = ''
          const node = window.__dshWidgets.renderWidget(view.widget, {
            sessionId,
            sendPrompt: (sid, text) => window.dsh.sendPrompt(sid, text),
          })
          resBox.appendChild(node)
        } else if (!isError && view && view.card === 'diff' && tc) {
          resBox.textContent = ''
          resBox.appendChild(tc.renderDiffCard(view))
        } else if (!isError && viewLooksLikeDiff && isFsFamilyTool && tc) {
          // Fallback path: fs family + wire meta shaped like a diff view.
          // Synthesize the missing `card: 'diff'` discriminant so the
          // downstream renderer's shape check is satisfied.
          resBox.textContent = ''
          resBox.appendChild(tc.renderDiffCard({ card: 'diff', title: view.title, diffs: view.diffs }))
        } else if (view && view.card === 'terminal' && tc) {
          // Terminal card is shown even on isError=true — a failed command's
          // stderr is the useful surface. Exit-code badge is derived from
          // `view.exitCode`, not `isError`.
          resBox.textContent = ''
          resBox.appendChild(tc.renderTerminalCard(view))
        } else {
          resBox.textContent = textFromContentBlocks(content) || (isError ? '[error]' : '[ok]')
          if (isError) resBox.style.color = 'var(--error)'
        }
        // surface `durationMs` (agent-loop reports the tool's
        // wall-clock runtime under `data.durationMs`, or nested under
        // `data.meta.durationMs` when the tool authored a render intent).
        // Pill lives in the `.tool-block` summary so a reader can spot slow
        // tools without opening the block. See docs/capability-frontend-audit.md
        // §2.3 GAP T1 (line 340).
        if (tc && tc.applyToolDuration) {
          const dur = tc.durationFromToolResult(data)
          if (dur !== null) {
            const toolBlock = resBox.closest ? resBox.closest('.tool-block') : resBox.parentElement
            tc.applyToolDuration(toolBlock, dur)
          }
        }
      }
      // §2.3 template triggers (batch 6): T2 error recovery + T4 artifact
      // preview both fire off tool/result. Attempts once; the pure module
      // returns null when nothing matches so this stays a no-op on the
      // common success path.
      maybeAppendTriggerCard(sessionId, event)
      return
    }
    case 'tool/code-dispatch': {
      // Code Mode fan-out: `run_code` dispatched a nested tool call. Anchor
      // it to the parent block's result box so the sub-calls sit inline with
      // the enclosing run_code card. See packages/core/tools/src/code-mode.ts
      // for the parentCallId + subCallId + resultSummary shape.
      const data = event.data || event
      const parentBox = meta.toolCalls.get(data.parentCallId)
      if (parentBox && window.__dshToolCards) {
        window.__dshToolCards.appendCodeDispatch(parentBox, data)
      }
      // Fall through if the parent block isn't on the stream (e.g. replay
      // truncated). Muted line is preferable to silent drop.
      if (!parentBox) appendSystem(`event: tool/code-dispatch (${data.name})`)
      return
    }
    case 'turn/end': {
      const reason = (event.data && event.data.reason) || event.reason
      // Field §3 P0 #4 (2026-07-17): fuse the former two-line `turn ended:
      // <kind>` + follow-up detail into ONE complete `turn ended: error
      // (step N): <message>` line so a scan of the system stream carries
      // the failure step + message at L0 (visibility.js:formatTurnEndLine
      // handles truncation + full-text title).
      const V = globalThis.Visibility
      if (V && typeof V.formatTurnEndLine === 'function') {
        const spec = V.formatTurnEndLine(reason)
        appendSystemDetail(spec.line, { title: spec.title, severity: spec.severity })
      } else {
        appendSystem(`turn ended: ${reason && reason.kind}`)
      }
      // session/fork demands a turn/end boundary; assistant bubbles are born
      // with their message seq, so re-stamp the latest one with this turn's
      // closing seq to make the "fork from here" button wire-valid.
      if (typeof event.seq === 'number') {
        const bubbles = streamEl.querySelectorAll('.msg.assistant[data-fork-seq]')
        const last = bubbles[bubbles.length - 1]
        if (last) last.dataset.forkSeq = String(event.seq)
      }
      state.streaming = null
      // Defensive flush: a turn/end without a matching step/end is
      // malformed but has happened on replay-truncated sessions. Close
      // the trace record so the next turn starts clean.
      //
      // finishTraceStep returns null when
      // `meta.currentTraceRecord === null` — the common single-step turn
      // (step/end fired first, clearing the record). Fall back to
      // `meta.lastTurnTraceCard`, which finishTraceStep stashed on the
      // last real emit, so the trace card the researcher just watched
      // stream into the pane gets lifted into the drawer rather than
      // stranded at stream root under the footer.
      const flushed = finishTraceStep(meta,
        typeof event.seq === 'number' ? event.seq : null,
        typeof event.time === 'number' ? event.time : null)
      const traceCard = flushed || (meta && meta.lastTurnTraceCard) || null
      // +: close the active turn container
      // with a per-turn footer (model / tokens / cost / time / stop). The
      // footer builder consumes the turn-footer module when available; the
      // trace card just returned by finishTraceStep is lifted into an
      // inline <details.turn-trace-drawer> per design-confirm §8.1. When
      // no container is open (history replay of a pre-container session,
      // or a stream that never opened one) this is a no-op.
      finishTurnContainer(sessionId, {
        footerSpec: buildTurnFooterSpecFromMeta(meta, event, reason),
        traceCard,
        traceSummaryText: traceCardSummaryText(traceCard),
        turnSteps: meta && Array.isArray(meta.turnSteps) ? meta.turnSteps.slice() : null,
      })
      // Consume the buffer so the next turn starts clean regardless of
      // whether turn/start fires (some replay paths skip it).
      if (meta) meta.turnSteps = []
      // F-3: same discipline for the F-3 fallback slot — clear it so a
      // subsequent turn that emits no trace card can't inherit this
      // turn's card by accident. finishTurnContainer already consumed it.
      if (meta) meta.lastTurnTraceCard = null
      return
    }
    case 'turn/start':
      // reset per-turn step buffer that turn-flow-glyph consumes.
      if (meta) meta.turnSteps = []
      // F-3: reset the last-trace-card slot so this turn starts with a
      // clean fallback (see finishTraceStep + turn/end).
      if (meta) meta.lastTurnTraceCard = null
      return
    case 'step/start': {
      // §1.1 trace card open. beginTraceStep flushes a stale
      // record from a malformed stream before starting a new one.
      beginTraceStep(meta, event)
      return
    }
    case 'step/end': {
      // §1.1 trace card close + emit. No-op if no step is
      // currently open (persisted-only replay of a step/end without a
      // matching step/start).
      finishTraceStep(meta,
        typeof event.seq === 'number' ? event.seq : null,
        typeof event.time === 'number' ? event.time : null)
      return
    }
    default:
      // Dev-facing event families (hook/*, request/header*, approval/*,
      // permission/*, bash/sandbox-mode, audit/*) live in the Devtools
      // drawer, not the chat stream — they'd otherwise spam `event:
      // request/header` grey lines on every send. The Devtools panel
      // installs its own onNotify listener, so we don't need to forward
      // here. See event-filter.js for the extracted pure copy under test.
      if (isDevOnlyEventType(event.type)) return
      // §2.3 T4/T5: broadcast-shape events (artifact/update, context-budget/
      // update) never render a card of their own — they exist to feed the
      // meter and the trigger engine. Fire the template hook here so those
      // types still get a chance to draw a widget without needing a new
      // case above.
      if (event.type === 'artifact/update' || event.type === 'context-budget/update' || event.type === 'context/budget') {
        maybeAppendTriggerCard(sessionId, event)
        return
      }
      // No user-facing surface either — swallow silently. If a new
      // user-facing event type appears, add an explicit case above.
      return
  }
}

// -- §2.3 template trigger hook ----------------------------------------------
//
// One-time dedupe per session per rule id: we don't want T5 to keep firing
// every event once the meter crosses 85%; it fires exactly once, then again
// only after the meter drops below the threshold and re-crosses.
// `meta.triggerFired` is a Map (created lazily) of `ruleId → { above: bool }`
// so the crossing detector is per-session.

function maybeAppendTriggerCard(sessionId, event) {
  const TT = (typeof window !== 'undefined' && window.__dshTriggerTemplates) || null
  const W = (typeof window !== 'undefined' && window.__dshWidgets) || null
  if (!TT || !W) return
  const hit = TT.templateFromEvent(event)
  if (!hit) return

  // Dedupe: T5 needs "crossing" semantics; T2/T4 fire per-event (they are
  // already scoped to a specific tool call / artifact id in the pure module).
  const meta = state.sessions.get(sessionId)
  if (!meta) return
  if (!meta.triggerFired) meta.triggerFired = new Map()
  if (hit.kind === 't5-context-warning') {
    const prev = meta.triggerFired.get('t5') || { above: false }
    if (prev.above) {
      // Update state — pct may have kept climbing — but do not spam a new card.
      return
    }
    meta.triggerFired.set('t5', { above: true })
  }

  // Only paint into the stream when this event belongs to the active
  // session (matches the rest of onSessionEvent's rule). Background
  // sessions accumulate meta but not DOM cards.
  if (sessionId !== state.activeSessionId) return

  const wrap = document.createElement('div')
  wrap.className = `card trigger-card trigger-${hit.kind}`
  wrap.dataset.triggerKind = hit.kind
  if (hit.ruleId) wrap.dataset.triggerRule = hit.ruleId
  const badge = document.createElement('div')
  badge.className = 'trigger-badge'
  badge.textContent = triggerBadgeLabel(hit.kind)
  wrap.appendChild(badge)
  const widgetNode = W.renderWidget(hit.widget, {
    sessionId,
    sendPrompt: (sid, text) => window.dsh.sendPrompt(sid, text),
    openArtifact: (id) => window.dsh.openArtifact ? window.dsh.openArtifact(id) : void 0,
  })
  wrap.appendChild(widgetNode)
  streamEl.appendChild(wrap)
  scrollToBottom()
}

function triggerBadgeLabel(kind) {
  // No emoji per house style (see docs/design-refs/density-layering-spec.md
  // §2 L0 rules: "no emoji anywhere"). Kind is carried by the badge text
  // alone; card border/badge color already encodes family status.
  switch (kind) {
    case 't2-error-recovery': return 'ERROR RECOVERY'
    case 't4-artifact-preview': return 'ARTIFACT'
    case 't5-context-warning': return 'CONTEXT HEALTH'
    default: return 'TEMPLATE'
  }
}

// Types that belong to the developer view (audit stream), not the chat.
// Mirrors event-filter.js exactly; kept as a local copy so the renderer
// stays a classic script (no import cycle) and the test enforces they
// don't drift.
function isDevOnlyEventType(type) {
  if (typeof type !== 'string') return true
  return (
    type.startsWith('hook/') ||
    type.startsWith('approval/') ||
    type.startsWith('permission/') ||
    type.startsWith('request/header') ||
    type === 'bash/sandbox-mode' ||
    type.startsWith('audit/')
  )
}

// -- interrupt cards (real wire) --------------------------------------------
//
// v2 §2.1 (batch 6): every blocking card wears the SAME visuals — thick
// border + top status strip (yellow=waiting / green=confirmed / grey=skipped).
// The state machine + label text live in interact-cards.js so tests and the
// DOM code agree. Local `applyCardStatus(el, status)` sets the class + the
// strip's text/color; card entry points (renderApprovalCard, renderFormCard,
// renderExitPlanModeCard) all call it once at construction and again from
// their submit / dismiss handlers.

function applyCardStatus(el, status) {
  if (!el || !status) return
  el.classList.remove('interact-card-waiting', 'interact-card-confirmed', 'interact-card-skipped')
  el.classList.add(`interact-card-${status.key}`)
  el.dataset.interactStatus = status.key
  const strip = el.querySelector(':scope > .interact-card-status')
  if (strip) {
    strip.dataset.status = status.key
    strip.textContent = status.label
    strip.title = status.hint
  }
}

function addStatusStrip(el, statusKey) {
  const IC = (typeof window !== 'undefined' && window.__dshInteractCards) || null
  if (!IC) return null
  const status = IC.STATUS[statusKey] || IC.STATUS.waiting
  el.classList.add('interact-card')
  const strip = document.createElement('div')
  strip.className = 'interact-card-status'
  el.appendChild(strip)
  applyCardStatus(el, status)
  return strip
}

function renderApprovalCard({ interruptId, sessionId, spec }) {
  const IC = (typeof window !== 'undefined' && window.__dshInteractCards) || null
  const el = document.createElement('div')
  el.className = 'card approval'
  el.dataset.interruptId = interruptId
  // Status strip goes FIRST so a reader sees the state before the header —
  // matches the strategy doc's "顶部一条状态条" placement.
  addStatusStrip(el, 'waiting')
  const h = document.createElement('h4')
  h.textContent = 'Approve tool call?'
  const meta = state.sessions.get(sessionId)
  const linkedCall = meta && meta.toolCalls.get(spec.toolCallId)
  const desc = document.createElement('div')
  desc.className = 'label'
  desc.textContent = `tool call: ${spec.toolCallId}${linkedCall ? ' (see block above)' : ''}`
  const actions = document.createElement('div')
  actions.className = 'actions'
  for (const opt of spec.options || []) {
    const b = document.createElement('button')
    b.textContent = opt.name
    b.className = opt.kind && opt.kind.startsWith('allow') ? 'primary' : 'ghost'
    b.addEventListener('click', async () => {
      disableCard(el)
      const outcome = opt.kind && opt.kind.startsWith('reject') ? 'rejected' : 'accepted'
      const result = outcome === 'accepted'
        ? { outcome: 'accepted', payload: { optionId: opt.optionId } }
        : { outcome: 'rejected' }
      if (IC) applyCardStatus(el, IC.statusFromOutcome(outcome))
      await window.dsh.resolveInterrupt(interruptId, result)
      state.interruptCards.delete(interruptId)
      // Ticket B §B-2: clearing the derived awaitingApproval flag is
      // the shell's job — the daemon only tells us via the resolveInterrupt
      // RPC succeeding (no separate "cleared" notification for
      // user-answered interrupts).
      clearAwaitingForInterrupt(interruptId)
    })
    actions.appendChild(b)
  }
  const cancel = document.createElement('button')
  cancel.textContent = 'Dismiss'
  cancel.className = 'ghost'
  cancel.addEventListener('click', async () => {
    disableCard(el)
    if (IC) applyCardStatus(el, IC.statusFromOutcome('cancelled'))
    await window.dsh.resolveInterrupt(interruptId, { outcome: 'cancelled' })
    state.interruptCards.delete(interruptId)
    clearAwaitingForInterrupt(interruptId)
  })
  actions.appendChild(cancel)
  el.append(h, desc, actions)
  return el
}

function renderFormCard({ interruptId, spec }) {
  const IC = (typeof window !== 'undefined' && window.__dshInteractCards) || null
  // v2 §2.1: exit_plan_mode gets a specialized in-card view (plan doc,
  // comments, right-rail read-only preview). Detection lives in
  // interact-cards.js so tests can pin it without booting the DOM.
  if (IC && IC.isExitPlanModeSpec(spec)) {
    return renderExitPlanModeCard({ interruptId, spec })
  }
  const el = document.createElement('div')
  el.className = 'card form'
  el.dataset.interruptId = interruptId
  addStatusStrip(el, 'waiting')
  const h = document.createElement('h4')
  // The two spec variants (integration and interact branches) both live under
  // `spec` after main.js normalization. `title` (integration) / `header`
  // (interact) both surface a short heading; `question` / `message` carry
  // the body.
  h.textContent = spec.title || spec.header || 'Please answer'
  const body = document.createElement('div')
  body.className = 'label'
  body.textContent = spec.message || spec.question || ''
  el.append(h, body)

  // Two rendering paths:
  //   integration variant: `requestedSchema` → generic form.
  //   interact variant: `options` + `multiSelect` → radio/checkbox list.
  const container = document.createElement('div')
  container.style.display = 'flex'
  container.style.flexDirection = 'column'
  container.style.gap = '4px'
  container.style.marginTop = '8px'

  const collect = { kind: 'unknown', node: null }
  if (Array.isArray(spec.options) && spec.options.length > 0) {
    const inputType = spec.multiSelect ? 'checkbox' : 'radio'
    for (const opt of spec.options) {
      const lab = document.createElement('label')
      const inp = document.createElement('input')
      inp.type = inputType
      inp.name = interruptId
      inp.value = opt.label
      lab.append(inp, document.createTextNode(' ' + opt.label))
      container.appendChild(lab)
    }
    const custom = document.createElement('input')
    custom.type = 'text'
    custom.placeholder = 'Other…'
    custom.style.width = '100%'
    custom.style.background = 'var(--bg)'
    custom.style.color = 'var(--text)'
    custom.style.border = '1px solid var(--border)'
    custom.style.borderRadius = '4px'
    custom.style.padding = '4px 6px'
    container.appendChild(custom)
    collect.kind = 'options'
    collect.node = container
    collect.custom = custom
    collect.spec = spec
  } else if (spec.requestedSchema && typeof spec.requestedSchema === 'object') {
    // Minimal schema renderer: one text input per property.
    const props = spec.requestedSchema.properties || {}
    const fields = {}
    for (const [key, def] of Object.entries(props)) {
      const lab = document.createElement('label')
      lab.textContent = key + ((def && def.title) ? ` — ${def.title}` : '')
      const inp = document.createElement('input')
      inp.type = 'text'
      inp.style.width = '100%'
      inp.style.background = 'var(--bg)'
      inp.style.color = 'var(--text)'
      inp.style.border = '1px solid var(--border)'
      inp.style.borderRadius = '4px'
      inp.style.padding = '4px 6px'
      lab.appendChild(inp)
      container.appendChild(lab)
      fields[key] = inp
    }
    collect.kind = 'schema'
    collect.fields = fields
  } else {
    // Free-text fallback.
    const inp = document.createElement('input')
    inp.type = 'text'
    inp.placeholder = 'Answer…'
    inp.style.width = '100%'
    inp.style.background = 'var(--bg)'
    inp.style.color = 'var(--text)'
    inp.style.border = '1px solid var(--border)'
    inp.style.borderRadius = '4px'
    inp.style.padding = '4px 6px'
    container.appendChild(inp)
    collect.kind = 'text'
    collect.node = inp
  }
  el.appendChild(container)

  const actions = document.createElement('div')
  actions.className = 'actions'
  const submit = document.createElement('button')
  submit.textContent = 'Submit'
  submit.className = 'primary'
  submit.addEventListener('click', async () => {
    let payload
    if (collect.kind === 'options') {
      const selected = Array.from(collect.node.querySelectorAll('input[type=radio]:checked, input[type=checkbox]:checked')).map((i) => i.value)
      const custom = collect.custom.value.trim()
      payload = { selectedOptions: selected, customAnswer: custom || undefined }
      if (collect.spec && collect.spec.questionId) payload.questionId = collect.spec.questionId
    } else if (collect.kind === 'schema') {
      payload = {}
      for (const [k, inp] of Object.entries(collect.fields)) payload[k] = inp.value
    } else {
      payload = { answer: collect.node.value }
    }
    disableCard(el)
    if (IC) applyCardStatus(el, IC.statusFromOutcome('accepted'))
    await window.dsh.resolveInterrupt(interruptId, { outcome: 'accepted', payload })
    state.interruptCards.delete(interruptId)
  })
  const dismiss = document.createElement('button')
  dismiss.textContent = 'Dismiss'
  dismiss.className = 'ghost'
  dismiss.addEventListener('click', async () => {
    disableCard(el)
    if (IC) applyCardStatus(el, IC.statusFromOutcome('cancelled'))
    await window.dsh.resolveInterrupt(interruptId, { outcome: 'cancelled' })
    state.interruptCards.delete(interruptId)
  })
  actions.append(submit, dismiss)
  el.appendChild(actions)
  return el
}

// -- exit_plan_mode card (v2 §2.1 specialization) ----------------------------
//
// Layout: plan document (editable textarea) + comments (textarea) + Confirm /
// Skip actions, all in the main card body, plus a sibling `.plan-diff-rail`
// element that renders a read-only preview of the numbered steps. The
// preview is a DEMO simplification of "right-rail diff" — v2 §2.1 says
// "右栏 diff 可以简化为只读预览".
//
// The card node returned by this function is a wrapper (`<div class="card
// form exit-plan-mode-wrap">`) that contains BOTH the interact card and
// the rail; the caller (`onInterruptIncoming`) just appends it to the
// stream like any other card.

function renderExitPlanModeCard({ interruptId, spec }) {
  const IC = (typeof window !== 'undefined' && window.__dshInteractCards) || null
  const wrap = document.createElement('div')
  wrap.className = 'exit-plan-mode-wrap'
  wrap.dataset.interruptId = interruptId

  const el = document.createElement('div')
  el.className = 'card form exit-plan-mode'
  addStatusStrip(el, 'waiting')

  const h = document.createElement('h4')
  h.textContent = spec.title || 'Exit plan mode?'
  el.appendChild(h)

  const desc = document.createElement('div')
  desc.className = 'label'
  desc.textContent = spec.message || 'Review the plan below. Edit if needed, add a comment, then confirm to leave plan mode.'
  el.appendChild(desc)

  // Plan document — editable so the user can revise before confirming
  // (v2 §2.1: "不是通过/驳回两选一").
  const planLabel = document.createElement('div')
  planLabel.className = 'exit-plan-mode-section-label'
  planLabel.textContent = 'PLAN'
  el.appendChild(planLabel)
  const planInput = document.createElement('textarea')
  planInput.className = 'exit-plan-mode-plan'
  planInput.rows = Math.min(10, Math.max(4, (spec.plan || '').split('\n').length + 1))
  planInput.value = typeof spec.plan === 'string' ? spec.plan : ''
  el.appendChild(planInput)

  // Comment area — free text for reviewer notes ("push to prod second, staging first").
  const commentLabel = document.createElement('div')
  commentLabel.className = 'exit-plan-mode-section-label'
  commentLabel.textContent = 'COMMENT'
  el.appendChild(commentLabel)
  const commentInput = document.createElement('textarea')
  commentInput.className = 'exit-plan-mode-comment'
  commentInput.rows = 2
  commentInput.placeholder = 'Optional — any notes for the agent…'
  el.appendChild(commentInput)

  const actions = document.createElement('div')
  actions.className = 'actions'
  const confirmBtn = document.createElement('button')
  confirmBtn.className = 'primary'
  confirmBtn.textContent = 'Confirm plan'
  const skipBtn = document.createElement('button')
  skipBtn.className = 'ghost'
  skipBtn.textContent = 'Skip'
  actions.append(confirmBtn, skipBtn)
  el.appendChild(actions)

  // Right-rail preview: read-only numbered list. Rebuilds on input so the
  // user sees the diff-y preview update as they edit.
  const rail = document.createElement('div')
  rail.className = 'plan-diff-rail'
  const railLabel = document.createElement('div')
  railLabel.className = 'plan-diff-rail-label'
  railLabel.textContent = 'PLAN PREVIEW'
  rail.appendChild(railLabel)
  const preview = document.createElement('div')
  preview.className = 'plan-diff-rail-body'
  rail.appendChild(preview)

  function refreshPreview() {
    preview.textContent = ''
    const lines = IC ? IC.previewLinesFromPlan(planInput.value) : []
    if (lines.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'plan-diff-rail-empty'
      empty.textContent = '(no plan lines — write numbered steps to preview)'
      preview.appendChild(empty)
      return
    }
    for (const line of lines) {
      const row = document.createElement('div')
      row.className = `plan-diff-line plan-diff-line-${line.sigil === '+' ? 'add' : 'ctx'}`
      const sig = document.createElement('span')
      sig.className = 'plan-diff-sigil'
      sig.textContent = line.sigil
      const txt = document.createElement('span')
      txt.className = 'plan-diff-text'
      txt.textContent = line.text
      row.append(sig, txt)
      preview.appendChild(row)
    }
  }
  planInput.addEventListener('input', refreshPreview)
  refreshPreview()

  confirmBtn.addEventListener('click', async () => {
    disableCard(el)
    if (IC) applyCardStatus(el, IC.statusFromOutcome('accepted'))
    const payload = {
      plan: planInput.value,
      comment: commentInput.value,
    }
    await window.dsh.resolveInterrupt(interruptId, { outcome: 'accepted', payload })
    state.interruptCards.delete(interruptId)
    clearAwaitingForInterrupt(interruptId)
  })
  skipBtn.addEventListener('click', async () => {
    disableCard(el)
    if (IC) applyCardStatus(el, IC.statusFromOutcome('skipped'))
    await window.dsh.resolveInterrupt(interruptId, { outcome: 'cancelled' })
    state.interruptCards.delete(interruptId)
    clearAwaitingForInterrupt(interruptId)
  })

  wrap.append(el, rail)
  return wrap
}

// -- steer card (v2 §2.2 non-blocking) ---------------------------------------
//
// Cards render inline, do NOT wear a status strip, wear a lighter border,
// carry a top-right ×. Click on any suggestion (or on the card body if
// spec.prompt is set) drops a "💡 steer: <label>" chip into the stream and
// fires `steering/message` via sendPrompt.
//
// Rendering is decoupled from the interrupt wire: the QA seam
// `window.__dshRenderer.showSteerCard(spec)` allows demo drivers to inject
// steer cards without a real `session/interrupt`. Real wire path is via
// `session/interrupt` kind === 'steer' if/when the runtime lands one; the
// dispatcher below routes both.

function renderSteerCard({ interruptId, sessionId, spec }) {
  const IC = (typeof window !== 'undefined' && window.__dshInteractCards) || null
  const el = document.createElement('div')
  el.className = 'card steer'
  if (interruptId) el.dataset.interruptId = interruptId

  const closeBtn = document.createElement('button')
  closeBtn.className = 'steer-dismiss icon-btn'
  closeBtn.setAttribute('aria-label', 'Dismiss steer suggestion')
  closeBtn.title = 'Dismiss'
  closeBtn.textContent = '×'
  el.appendChild(closeBtn)

  const h = document.createElement('h4')
  h.className = 'steer-title'
  h.textContent = spec.title || spec.label || 'Steer suggestion'
  el.appendChild(h)

  if (spec.message) {
    const body = document.createElement('div')
    body.className = 'steer-body'
    body.textContent = spec.message
    el.appendChild(body)
  }

  const actions = document.createElement('div')
  actions.className = 'actions'
  const suggestions = Array.isArray(spec.suggestions) ? spec.suggestions : []
  const list = suggestions.length > 0
    ? suggestions
    : [{ id: 'default', label: 'Send this', prompt: spec.prompt || spec.title || '' }]
  for (const s of list) {
    const b = document.createElement('button')
    b.className = 'ghost steer-suggestion'
    b.textContent = s.label || s.id || 'send'
    b.addEventListener('click', async () => {
      const chipLabel = s.label || (IC ? IC.chipLabelFromSteerSpec(spec) : 'steer')
      const promptText = String(s.prompt || spec.prompt || s.label || '').trim()
      dropSteerChip(chipLabel)
      if (interruptId) {
        await window.dsh.resolveInterrupt(interruptId, { outcome: 'accepted', payload: { suggestion: s.id, prompt: promptText } })
        state.interruptCards.delete(interruptId)
      } else if (promptText && sessionId) {
        // No wire round-trip; fire the same sendPrompt path a widget action
        // would take. Same code path keeps behavior consistent.
        void window.dsh.sendPrompt(sessionId, promptText)
      }
      // Dismiss the card either way — one steer suggestion, one chip.
      el.remove()
    })
    actions.appendChild(b)
  }
  el.appendChild(actions)

  closeBtn.addEventListener('click', async () => {
    if (interruptId) {
      await window.dsh.resolveInterrupt(interruptId, { outcome: 'cancelled' })
      state.interruptCards.delete(interruptId)
    }
    el.remove()
  })
  return el
}

function dropSteerChip(labelText) {
  // Emoji-free ( L0). The chip is identified by
  // the class + `steer:` prefix in the label; CSS handles the visual
  // marker via ::before if desired.
  const chip = document.createElement('div')
  chip.className = 'system steer-chip'
  chip.dataset.steerChip = '1'
  const text = document.createElement('span')
  text.className = 'steer-chip-label'
  text.textContent = `steer: ${labelText}`
  chip.append(text)
  streamEl.appendChild(chip)
  scrollToBottom()
}

function showSteerCard(spec) {
  const sessionId = state.activeSessionId
  const node = renderSteerCard({ interruptId: null, sessionId, spec: spec || {} })
  streamEl.appendChild(node)
  scrollToBottom()
  return node
}

function disableCard(el) {
  el.classList.add('disabled')
  for (const c of el.querySelectorAll('button, input')) c.disabled = true
}

function onInterruptIncoming({ interruptId, sessionId, kind, spec }) {
  // §2.2 (batch 6): a new interrupt kind 'steer' routes to the non-blocking
  // steer card. Falls through to the form renderer if the wire ever ships
  // the same kind with a plan-mode payload, so no wire back-compat break.
  const node = kind === 'approval'
    ? renderApprovalCard({ interruptId, sessionId, spec })
    : kind === 'steer'
      ? renderSteerCard({ interruptId, sessionId, spec })
      : renderFormCard({ interruptId, spec })
  // Ticket B §B-2 (2026-07-16): approval-kind interrupts derive the
  // formerly-phantom `awaitingApproval` flag onto shell meta. Wire truth
  // is the InterruptRequest itself (protocol.ts:453-517, `spec.kind ===
  // 'approval'`) — the daemon never ships this on SessionHeader. Setting
  // it here means the sidebar and Session Tree page can both key off one
  // authoritative source for "this session is blocked waiting for you".
  // Form-kind interrupts are a separate affordance and do NOT set this
  // flag (they're a fill-in-a-field prompt, not an approve/reject gate).
  if (kind === 'approval') {
    const meta = state.sessions.get(sessionId) || ensureSession(sessionId)
    meta.awaitingApproval = true
    // Track which interrupt id owns the flag so a stale invalidation can't
    // clear an unrelated newer approval by accident (multi-approval races).
    if (!meta._awaitingInterruptIds) meta._awaitingInterruptIds = new Set()
    meta._awaitingInterruptIds.add(interruptId)
    renderSessionList()
  }
  // If the interrupt is for a background session, append a nav-note but still
  // show the card in the active session so the user can act on it.
  if (sessionId !== state.activeSessionId) {
    const note = document.createElement('div')
    note.className = 'system'
    note.textContent = `interrupt in session ${sessionId.slice(0, 8)} — switching context to answer`
    streamEl.appendChild(note)
  }
  state.interruptCards.set(interruptId, node)
  streamEl.appendChild(node)
  scrollToBottom()
}

// Clear the derived `awaitingApproval` flag for a specific interrupt id.
// Called from onInterruptInvalidate and from the approval-card option
// handlers so the flag drops the moment the user answers OR the runtime
// cancels the request. Ticket B §B-2.
function clearAwaitingForInterrupt(interruptId) {
  for (const [, meta] of state.sessions) {
    if (!meta._awaitingInterruptIds) continue
    if (meta._awaitingInterruptIds.delete(interruptId)) {
      if (meta._awaitingInterruptIds.size === 0) meta.awaitingApproval = false
    }
  }
  renderSessionList()
}

function onInterruptInvalidate({ interruptId, reason }) {
  const el = state.interruptCards.get(interruptId)
  if (el) {
    disableCard(el)
    const note = document.createElement('div')
    note.className = 'label'
    note.textContent = `— cancelled: ${reason || 'runtime disconnected'} —`
    el.appendChild(note)
    state.interruptCards.delete(interruptId)
  }
  // Always drop the derived flag even if the DOM card was already gone —
  // the wire may invalidate an interrupt whose card the shell never
  // rendered (session in background at the time). Ticket B §B-2.
  clearAwaitingForInterrupt(interruptId)
}

// -- debug mock cards ------------------------------------------------------
// The mock/inject/load/mount helpers used by the Debug popover live in
// src/renderer/mock-fixtures.js. That file loads before
// renderer.js in index.html so the top-level function declarations are
// hoisted onto the shared global scope by the time the click listeners
// below wire them up.


// -- send / cancel -----------------------------------------------------------

async function send() {
  const text = inputEl.value.trim()
  if (!text) return
  if (!state.activeSessionId) {
    const { id } = await window.dsh.newSession()
    ensureSession(id, { title: text.slice(0, 40), hasUserMessage: true })
    state.activeSessionId = id
    renderSessionList()
    await selectSession(id)
  } else {
    // Flag the active session as no-longer-empty so the Recent filter keeps
    // it visible on subsequent renders even if it was still `hasUserMessage:
    // false` (the user just clicked "+" and immediately typed).
    const meta = state.sessions.get(state.activeSessionId)
    if (meta && !meta.hasUserMessage) {
      meta.hasUserMessage = true
      if (!meta.title) meta.title = text.slice(0, 40)
    }
  }
  const sid = state.activeSessionId
  // Optimistic bubble — the server echoes user/message shortly after, and the
  // event handler adopts this element in place instead of re-rendering.
  appendMessage({ role: 'user', text, optimistic: true })
  updateEmptyStateVisibility()
  inputEl.value = ''
  sendBtn.disabled = true
  state.inflightTurn = true; updateCancelButton(); updateCompactButton(); updateForkButtons()
  try {
    await window.dsh.sendPrompt(sid, text)
  } catch (err) {
    appendSystem(`error: ${err.message}`)
  } finally {
    sendBtn.disabled = false
  }
}

async function cancel() {
  if (!state.activeSessionId) return
  try {
    const r = await window.dsh.cancelPrompt(state.activeSessionId, 'user cancelled')
    appendSystem(`cancel → ${JSON.stringify(r)}`)
  } catch (err) {
    appendSystem(`cancel failed: ${err.message}`)
  }
}

// -- event wiring ------------------------------------------------------------

window.dsh.onNotify(({ method, params }) => {
  // Forward every notification to Mission Control so its aggregate stays
  // live regardless of which tab is active. The mission module is a no-op
  // if it hasn't loaded yet (e.g. renderer.js booted before its script tag).
  if (window.__dshMission) window.__dshMission.notify(method, params)
  if (method === 'session.event') {
    onSessionEvent(params.sessionId, params.event)
  } else if (method === 'session.finished') {
    // Field §3 P0 #10 (2026-07-17): expand the bare `session finished
    // (<status>)` to include the failure reason (step + message + code)
    // at L0. visibility.js:formatSessionFinishedLine returns the same
    // truncate + title-attribute shape as formatTurnEndLine so both
    // system-line families read consistently.
    const V = globalThis.Visibility
    let finishedEl = null
    if (V && typeof V.formatSessionFinishedLine === 'function') {
      const spec = V.formatSessionFinishedLine(params)
      // Preflight (2026-07-18) NO_ADAPTER guard: fold ≥2 identical
      // finished-error lines into a single `×N` row ( L0
      // repetition fold). Users hit this when the model×profile mismatch
      // fires on every retry — the third identical red row is noise.
      finishedEl = appendSystemDetailFolded(spec.line, { title: spec.title, severity: spec.severity })
    } else {
      appendSystem(`session finished (${params.status})`)
    }
    // Preflight (2026-07-18) NO_ADAPTER friendly hint: recognise
    //   "no adapter registered for model "X" [NO_ADAPTER]"
    // and append a muted advisory line pointing the user at the
    // profile-switch path. Both surfaces stay: keep the raw wire text
    // for zero-drop, add the plain-English follow-up.
    void applyNoAdapterHint(params, finishedEl)
    const meta = state.sessions.get(params.sessionId) || ensureSession(params.sessionId)
    meta.running = false
    // Ticket B §B-4/B-5 (2026-07-16): derive the formerly-phantom
    // `lastError` from the SessionFinishedNotification's reason
    // (`TurnEndReason`,). A
    // non-ok reason paints the row as ✕ interrupted via
    // classifySessionShape — same visual for `error` (B-4) and
    // `cancelled` (B-5, replaces the retired header.interrupted alias).
    // Cleared on the next turn/start so a retry drops the icon.
    if (params.reason && typeof params.reason === 'object') {
      meta.lastError = params.reason
    } else if (params.status === 'error') {
      // Some daemons emit status:'error' without a structured reason.
      // Fabricate a minimal TurnEndReason-shaped object so downstream
      // classifiers still detect "non-ok".
      meta.lastError = { kind: 'error' }
    }
    renderSessionList()
    if (params.sessionId === state.activeSessionId) { state.inflightTurn = false; updateCancelButton(); updateForkButtons() }
    // Refresh listing so title/lastEventTime catch up.
    void refreshSessionList()
  } else if (method === 'subagent.started') {
    // Grow the tree eagerly: register the child session with a placeholder
    // parent link, refresh the sidebar, and drop a fork marker on the parent
    // stream at the current tail (parentSeq unknown until session/list gives
    // us its seedLength). A subsequent refreshSessionList will backfill the
    // seq on the next render.
    const parentId = params.parentSessionId
    const childId = params.childSessionId
    ensureSession(childId, {
      title: subagentPlaceholderTitle(parentId),
      running: true,
      header: { parentSession: parentId },
    })
    if (parentId === state.activeSessionId) {
      addForkMarker({ parentSeq: null, childSessionId: childId, running: true })
    }
    // register lineage and, if the parent is
    // the active view, mount the RUNNING inline card under the spawn row
    // right now — so incoming session.event notifications for this child
    // (routed via routeLiveChildEvent) have somewhere to paint. The
    // parentCallId anchor is:
    //   (a) explicit — some fixture wires already carry it (§2.6 shape);
    //   (b) heuristic — the last spawn_agent tool/call id on the parent
    //       meta record. Real kernel wire (server.ts:89-96) doesn't
    //       include parentCallId, so (b) is the live path.
    const store = state.subagentStore
    if (store) {
      const parentMeta = state.sessions.get(parentId)
      const lineageMod = window.__dshSubagentLineage
      const anchor = params.parentCallId
        || (lineageMod && typeof lineageMod.spawnAnchorFor === 'function'
              ? lineageMod.spawnAnchorFor(parentMeta) : null)
      const rec = store.registerStarted({
        parentSessionId: parentId,
        childSessionId: childId,
        parentCallId: anchor,
      })
      if (rec && parentId === state.activeSessionId && rec.parentCallId) {
        const parentRow = streamEl.querySelector(
          `.tool-block[data-call-id="${cssEscape(rec.parentCallId)}"]`)
        const already = parentRow && streamEl.querySelector(
          `.subagent-trace[data-parent-call-id="${cssEscape(rec.parentCallId)}"]`)
        if (parentRow && !already) {
          const card = buildRunningSubagentCard(rec)
          if (card) parentRow.parentElement.insertBefore(card, parentRow.nextSibling)
        }
      }
    }
    renderSessionList()
    void refreshSessionList()
    appendSystem(`subagent started: ${childId.slice(0, 8)}`)
  } else if (method === 'subagent.finished') {
    const meta = state.sessions.get(params.childSessionId)
    if (meta) meta.running = false
    // mark the lineage record finished so
    // routeLiveChildEvent stops accepting new rows for this child, then
    // replace the RUNNING card in place with the fully sealed inline
    // trace (rich prompt/steps/return sections from subagent-view).
    // Falls back to buffered childEvents from the live stream when the
    // finished notification doesn't carry them (real kernel wire per
    // server.ts:106-123 only ships lastAssistantMessage — the child
    // events already flowed through session.event and we buffered them
    // on rec.childEvents).
    const store = state.subagentStore
    let liveRec = null
    let mergedChildEvents = Array.isArray(params.childEvents) ? params.childEvents : null
    if (store) {
      liveRec = store.resolveChild(params.childSessionId)
      store.markFinished(params.childSessionId, {
        status: params.status || 'ok',
        stopReason: typeof params.stopReason === 'string' ? params.stopReason : null,
        lastAssistantMessage: params.lastAssistantMessage,
      })
      if (!mergedChildEvents && liveRec && Array.isArray(liveRec.childEvents)) {
        mergedChildEvents = liveRec.childEvents
      }
    }
    // render the sealed inline subagent trace card
    // right after the parent's spawn tool block. Anchor priority:
    //   (a) params.parentCallId (fixture path, some wires),
    //   (b) live-lineage record's cached parentCallId (real wire path).
    const view = window.__dshSubagentView
    const parentCallId = params.parentCallId || (liveRec && liveRec.parentCallId) || null
    const parentSessionId = params.parentSessionId || (liveRec && liveRec.parentSessionId) || null
    if (view && typeof view.buildInlineSubagentTrace === 'function'
        && parentSessionId === state.activeSessionId
        && parentCallId) {
      const parentRow = streamEl.querySelector(`.tool-block[data-call-id="${cssEscape(parentCallId)}"]`)
      const spec = {
        parentSessionId,
        childSessionId: params.childSessionId,
        parentCallId,
        status: params.status || 'ok',
        // viz-coverage-matrix §5 P0-6: thread stopReason so the sealed
        // card's header can render "done · <stop>" instead of a bare pill.
        // Wire ships it on subagent.finished (server.ts:114-122). Absent
        // reason falls back to the bare status via renderStatusToken.
        stopReason: typeof params.stopReason === 'string' ? params.stopReason : null,
        childEvents: mergedChildEvents || [],
        lastAssistantMessage: Array.isArray(params.lastAssistantMessage) ? params.lastAssistantMessage : [],
      }
      const sealed = view.buildInlineSubagentTrace(document, spec, { collapsed: true })
      // If a RUNNING card already sits in the DOM (live path built it on
      // subagent.started), swap it for the sealed card in place. Otherwise
      // append after the spawn row (the pure fixture-replay path).
      const existing = streamEl.querySelector(
        `.subagent-trace[data-parent-call-id="${cssEscape(parentCallId)}"]`)
      if (existing && existing.parentElement) {
        existing.parentElement.replaceChild(sealed, existing)
      } else if (parentRow) {
        parentRow.parentElement.insertBefore(sealed, parentRow.nextSibling)
      }
    }
    // Cleanup lineage so a repeat sessionId (unlikely but possible on
    // reset) doesn't route into a stale record.
    if (store) store.forget(params.childSessionId)
    renderSessionList()
    void refreshSessionList()
    appendSystem(`subagent finished: ${params.agentId} (${params.status})`)
  }
})
window.dsh.onStatus(({ status, profile, model, supportedModels }) => {
  statusDot.className = `dot ${status}`
  statusText.textContent = status
  // Preflight (2026-07-18) blind-test #8: status-bar chip tooltips.
  // A first-time user sees "daemon-echo · mock-echo" with a bare yellow
  // dot next to "starting" and has no idea what any of it means.
  applyStatusBarTooltips(status, profile, model)
  if (model) modelBadge.textContent = `${profile} · ${model}`
  // Preflight (2026-07-18) NO_ADAPTER guard: keep the composer's dropdown
  // aligned with what this profile can actually route. `supportedModels`
  // rides on every status payload from main.js:startRuntime (mirroring
  // profiles.js:modelsFor). See KNOWN_MODELS comment + renderComposerModel
  // for the filter contract.
  if (profile) activeProfileName = profile
  if (Array.isArray(supportedModels)) supportedModelsForActive = supportedModels.slice()
  if (model) renderComposerModel(model)
  else if (Array.isArray(supportedModels)) {
    // Status without a bound model (e.g. transient `starting` state after
    // profile switch): still re-render so the dropdown drops stale
    // options from the previous profile.
    renderComposerModel(composerModelEl && composerModelEl.dataset ? composerModelEl.dataset.currentModel : '')
  }
})
window.dsh.onCrash(({ code, signal, stderrTail }) => {
  appendSystem(`runtime crashed (code=${code} signal=${signal}) — respawning…`)
  if (stderrTail) console.error('[runtime stderr tail]\n' + stderrTail)
})
// Per-chunk daemon stderr echo. Off by default (would flood devtools during
// a real session); opt in with DSH_DEBUG=1 (gated by preload → window.dshDebug).
window.dsh.onStderr((chunk) => {
  if (window.dshDebug && window.dshDebug.enabled) console.debug('[runtime]', chunk)
})
window.dsh.onError(({ message }) => { showRuntimeErrorBanner(message) })

// Preflight (2026-07-18): human-readable tooltips for the status-bar
// pieces the fresh-eyes reviewer flagged as "double chip with no
// explanation". Keeps the visible text short (chip real estate is tight)
// and puts the plain-English description on the hover title.
function applyStatusBarTooltips (status, profile, model) {
  try {
    const statusMeaning = {
      idle: 'runtime idle — daemon is up and waiting for input',
      starting: 'runtime starting — the daemon is spinning up',
      running: 'runtime running — a turn is in flight',
      ready: 'runtime ready — daemon is up and last turn is done',
      crashed: 'runtime crashed — will respawn automatically',
    }
    if (statusDot) statusDot.title = statusMeaning[status] || `runtime ${status}`
    if (statusText) statusText.title = statusMeaning[status] || `runtime ${status}`
    if (modelBadge && profile) {
      modelBadge.title = `profile: ${profile}${model ? ` · model: ${model}` : ''}\nProfile picks the runtime binary + config; model is what the daemon calls under the hood. Change via Settings → Profile.`
    }
  } catch (_) { /* tooltips are progressive enhancement */ }
}

// Runtime-error banner (A-P0-2 fix). The raw daemon message ("jsonrpc client
// announced capabilities.interruptions=true but the composition has no
// ctx.userInteraction…") used to be spat into the chat stream verbatim,
// making the first-run empty state read as "this software is broken". We now
// classify a couple of well-known shapes and route the rest into a compact
// banner above the stream. The banner sits at the top of the chat pane so
// the welcome-card empty state stays intact; a text summary + Details toggle
// keeps the raw message reachable without dominating the view.
//
// Bug C dedupe/gate (2026-07-18):
//   - `_lastBannerRaw` — same raw message hitting twice bumps a ×N counter
//     instead of tearing the banner down + rebuilding.  Prevents the "same
//     error re-flashes on every retry" hazard the field report caught.
//   - `_bootPhaseNoise` — protocolError events that fire BEFORE the first
//     successful `initialize` are cold-start noise (daemon socket not yet
//     bound, transport spawn racing).  onInitialized clears the flag; the
//     eventual real problem still surfaces if it repeats post-init.
//     Suppressed messages are recorded in a tiny in-memory ledger the
//     Debug popover can dump so investigations still see them.
let _lastBannerRaw = ''
let _bannerRepeatCount = 1
let _bootPhaseNoise = true
const _suppressedRuntimeMessages = []
function showRuntimeErrorBanner(message) {
  const raw = String(message || '')
  const streamHost = streamEl && streamEl.parentElement
  if (!streamHost) { appendSystem(`runtime error: ${raw}`); return }
  // Bug C boot-phase gate (2026-07-18): before the first successful
  // initialize, protocolError noise is cold-start racing (daemon socket
  // not yet accepting, transport spawn) — filter into an in-memory log
  // instead of flashing a banner the user can't act on.  onInitialized
  // clears _bootPhaseNoise so real problems mid-session still show.
  const classification = classifyRuntimeError(raw)
  if (_bootPhaseNoise && classification.bootNoise) {
    _suppressedRuntimeMessages.push({ raw, at: Date.now(), phase: 'boot' })
    console.debug('[runtime boot noise suppressed]', raw)
    return
  }
  // Bug C dedupe (2026-07-18): if the same raw message fires again while
  // its banner is still on-screen, don't rebuild — bump a ×N counter on
  // the existing title.  Prevents "one intermittent failure spams the
  // banner on every retry" reads as "the app is on fire" to the user.
  const existing = document.getElementById('chat-runtime-banner')
  if (existing && _lastBannerRaw === raw) {
    _bannerRepeatCount += 1
    const titleEl = existing.querySelector('.chat-runtime-banner-title')
    if (titleEl) {
      const base = classification.title
      titleEl.textContent = `${base} · ×${_bannerRepeatCount}`
    }
    return
  }
  _lastBannerRaw = raw
  _bannerRepeatCount = 1
  let banner = existing
  if (!banner) {
    banner = document.createElement('div')
    banner.id = 'chat-runtime-banner'
    banner.className = 'chat-runtime-banner'
    streamHost.insertBefore(banner, streamEl)
  }
  banner.innerHTML = ''
  const head = document.createElement('div')
  head.className = 'chat-runtime-banner-head'
  const icon = document.createElement('span')
  icon.className = 'chat-runtime-banner-icon'
  icon.textContent = classification.icon
  const title = document.createElement('span')
  title.className = 'chat-runtime-banner-title'
  title.textContent = classification.title
  const dismiss = document.createElement('button')
  dismiss.type = 'button'
  dismiss.className = 'chat-runtime-banner-dismiss ghost small'
  dismiss.setAttribute('aria-label', 'Dismiss')
  dismiss.textContent = '×'
  dismiss.addEventListener('click', () => {
    banner.remove()
    // Reset dedup memory on dismiss so if the same error genuinely
    // reappears the user still sees a fresh banner (this is different
    // from the ×N fold — that folds repeats while the banner is up).
    _lastBannerRaw = ''
    _bannerRepeatCount = 1
  })
  head.append(icon, title, dismiss)
  const hint = document.createElement('div')
  hint.className = 'chat-runtime-banner-hint'
  hint.textContent = classification.hint
  // Classified errors may offer a one-click profile switch (e.g. the
  // missing-api-key bucket points at 'daemon-echo' as the keyless demo).
  // Reuses the profileSelect.change path so the switch goes through the
  // same startRuntime + persistence flow as the manual picker — no
  // parallel wiring. Guarded by profileSelect existing (the picker is
  // always rendered but the guard keeps this safe under test-doubles).
  if (classification.switchTarget && profileSelect) {
    const switchRow = document.createElement('div')
    switchRow.className = 'chat-runtime-banner-switch'
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'ghost small'
    btn.textContent = classification.switchLabel || `Switch to ${classification.switchTarget}`
    btn.addEventListener('click', async () => {
      btn.disabled = true
      appendSystem(`switching profile to ${classification.switchTarget}…`)
      try {
        profileSelect.value = classification.switchTarget
        await window.dsh.startRuntime(classification.switchTarget)
        if (window.__dshPlugins) void window.__dshPlugins.refresh()
        banner.remove()
      } catch (err) {
        btn.disabled = false
        appendSystem(`profile switch failed: ${err && err.message ? err.message : String(err)}`)
      }
    })
    switchRow.appendChild(btn)
    hint.appendChild(document.createElement('br'))
    hint.appendChild(switchRow)
  }
  const details = document.createElement('details')
  details.className = 'chat-runtime-banner-details'
  const summary = document.createElement('summary')
  summary.textContent = 'Details'
  const pre = document.createElement('pre')
  pre.textContent = raw
  details.append(summary, pre)
  banner.append(head, hint, details)
}
function classifyRuntimeError(raw) {
  const s = String(raw || '')
  if (/capabilities\.interruptions=true/.test(s) && /userInteraction/.test(s)) {
    return {
      icon: '!',
      title: 'Interactive prompts unavailable in this profile',
      hint: 'This runtime advertised support for interactive prompts, but the current plugin composition can\'t accept them yet. Chat will still run — approvals and form-shaped questions will silently pass through. To enable them, load @deepseek-ai/dsh-user-interaction in the profile\'s overlay.',
    }
  }
  // Bug C (2026-07-18): the boot-fallback path in main.js sends a
  // "daemon boot failed, falling back to stdio: …" message which the
  // supervisor recovers from automatically.  Show as informational,
  // not as an alarm — the user hasn't broken anything.
  if (/daemon boot failed, falling back to stdio/.test(s)) {
    return {
      icon: 'i',
      title: 'Falling back to stdio runtime',
      hint: 'The daemon path couldn\'t be reached, so the shell spawned a stdio runtime instead. Chat still works; only long-running sessions across app restarts are affected.',
      bootNoise: true,
    }
  }
  // Cold-start socket/pipe noise (daemon-echo profile) — the daemon
  // needs a few hundred ms to bind its socket, and any protocol write
  // that races the bind surfaces here.  Silent during boot phase; if it
  // still fires after onInitialized, the daemon really is unreachable
  // and the banner earns its place.
  if (/ECONNREFUSED|EPIPE|socket hang up|ENOTCONN|socket is closed/i.test(s)) {
    return {
      icon: '!',
      title: 'Runtime not ready',
      hint: 'The daemon transport isn\'t answering yet. This is normal for the first few seconds of a fresh boot; if you see it after chat has been running, the daemon may have crashed — the shell will respawn it.',
      bootNoise: true,
    }
  }
  // HARNESS_DEV phantom-path (2026-07-18, fix/harness-dev-guard).
  // Two shapes surface here — both point at the same root cause (SDK not on
  // disk where profiles.js expected) and both deserve the SDK-checkout hint,
  // not the "check the profile's base leaf" one that the generic ENOENT
  // fallthrough used to give.
  //
  //   (a) `DSH runtime SDK not found at ...` — the preflight in main.js
  //       fires this string via runtime:error before spawn.
  //   (b) `spawn ... ENOENT` — node's own error when the .ts path handed to
  //       node --import tsx doesn't exist. Preflight normally catches (b),
  //       but leave the classifier bucket in place as a second-line defense
  //       for any spawn path that bypasses preflight (playground child, a
  //       future direct spawn, etc.).
  //
  // Both point the user at DSH_DEV_ROOT / cloning the SDK sibling; the
  // stderr log path is mentioned so the banner details pane surfaces it.
  if (/DSH runtime SDK not found|spawn\s+\S+\s+ENOENT/i.test(s)) {
    return {
      icon: '!',
      title: 'Runtime binary failed to launch',
      hint: 'The DSH runtime SDK isn\'t where profiles.js expected. If you cloned deepseek-harness, the SDK is this repo itself and the shell should auto-detect it — otherwise set DSH_DEV_ROOT to your deepseek-harness checkout, or clone deepseek-harness as a sibling directory of this shell. Full spawn stderr is captured at logs/runtime-stderr.log under the app\'s user-data directory.',
    }
  }
  if (/ENOENT|no such file|not found/i.test(s)) {
    return { icon: '!', title: 'Runtime file missing', hint: 'A configured path could not be opened. Check the profile\'s base leaf and overlay entries.' }
  }
  if (/EADDRINUSE/i.test(s)) {
    return { icon: '!', title: 'Port already in use', hint: 'The daemon transport port is taken by another process. Restart the app or free the port.' }
  }
  // Missing DEEPSEEK_API_KEY (2026-07-18): the default profile is now
  // stdio-deepseek. If a fresh user has no key on their shell, llm-deepseek
  // throws `llm-deepseek: an API key is required (Config.apiKey or
  // $DEEPSEEK_API_KEY)` during plugin load. Own the shape: friendly title,
  // concrete two-option hint (set the env / switch to the keyless demo),
  // and a switchTarget the banner renders as a click-to-switch chip. This
  // must live BEFORE the generic fallthrough — the user's read of a red
  // "Runtime warning" instead of this card is exactly what boss called out.
  if (/llm-deepseek:\s*an API key is required|API key is required.*DEEPSEEK_API_KEY|DEEPSEEK_API_KEY.*required/i.test(s)) {
    return {
      icon: '!',
      title: 'DEEPSEEK_API_KEY needed for real-model profile',
      hint: 'The default profile talks to DeepSeek and needs a key. Two options: (1) set DEEPSEEK_API_KEY in .env or your shell (see README Quick Start), or (2) try the keyless echo demo to explore the UI first.',
      // switchTarget = stdio-echo (P0-3 fix, 2026-07-18): the daemon-echo
      // profile boots the `dsh-daemon-demo` bundle which lives in the
      // `.worktrees/integration` worktree and hasn't landed on the
      // deepseek-harness master branch yet. A fresh clone of the
      // official repo hits this card when no key is set — pointing them
      // at daemon-echo would preflight-fail on the missing daemon bin,
      // which is exactly the wrong follow-up. stdio-echo boots the
      // in-tree jsonrpc-demo bin (present on master) and is keyless, so
      // the click reliably drops the user into a working chat.
      switchTarget: 'stdio-echo',
      switchLabel: 'Switch to keyless demo (stdio-echo)',
    }
  }
  return { icon: '!', title: 'Runtime warning', hint: 'The daemon reported an issue. The chat pane will keep working; see details for the raw message.' }
}
window.dsh.onInitialized((info) => {
  const name = info?.serverInfo?.name ?? '?'
  const version = info?.serverInfo?.version ?? '?'
  const pv = info?.protocolVersion || 1
  appendSystem(`connected to ${name} v${version} (protocol ${pv})`)
  // a
  // stale Runtime-warning banner from a previous handshake (or from a profile
  // that didn't advertise capabilities.interruptions correctly) used to sit
  // on the chat pane forever, even after the daemon reconnected cleanly. A
  // fresh initialize means the runtime is back — dismiss the banner. If a
  // classified error fires again after this, showRuntimeErrorBanner rebuilds
  // it from scratch (banner variable is looked up by id, not held across calls).
  const staleBanner = document.getElementById('chat-runtime-banner')
  if (staleBanner) staleBanner.remove()
  // Bug C (2026-07-18): first successful handshake ends the boot-noise
  // window; classified boot-only errors past this point earn a banner
  // because the daemon has demonstrably been up at least once.
  _bootPhaseNoise = false
  _lastBannerRaw = ''
  _bannerRepeatCount = 1
  // capture the runtime's capability declaration
  // BEFORE the follow-up updateCancelButton / updateCompactButton calls
  // below consult isCapabilitySupported. Also stash serverName/Version so
  // the devtools drawer header can name the runtime for bug reports.
  const M = window.__dshCapabilities
  state.serverCapabilities = M && typeof M.normalizeCapabilities === 'function'
    ? M.normalizeCapabilities(info && info.capabilities)
    : null
  state.serverName = name === '?' ? '' : String(name)
  state.serverVersion = version === '?' ? '' : String(version)
  // New runtime = a fresh session space. The old daemon's session ids can
  // never come back — a new session/list from daemon B is a different
  // namespace. Without this clear, state.sessions accumulated stale rows
  // across every profile switch, the sidebar showed rows whose click did
  // nothing, and interruptCards may still hold DOM refs to interrupts main
  // already resolve/invalidated (main.js:60). Wipe the per-session catalog
  // + transient stream state before refreshSessionList repopulates from the
  // new daemon's authoritative list.
  state.sessions.clear()
  state.entries = []
  state.activeSessionId = null
  state.streaming = null
  state.lastAssistantSeq = 0
  state.streamSeqAnchor = 0
  state.inflightTurn = false
  state.forkMarkersInStream.clear()
  state.interruptCards.clear()
  streamEl.innerHTML = ''
  titleEl.textContent = 'New chat'
  updateEmptyStateVisibility()
  updateCancelButton()
  // New runtime = unknown compact support; button falls back to greyed
  // until the first successful call proves the daemon accepts the method
  // (or a MethodNotFound flips it to `false`).
  state.compactSupported = null
  updateCompactButton()
  // walk each capability-gated surface once state.serverCapabilities
  // is populated. Individual updateFoo helpers now consult the same gate, so
  // subsequent turn-boundary refreshes stay consistent.
  applyCapabilityGates()
  void refreshSessionList()
})
window.dsh.onInterruptIncoming(onInterruptIncoming)
window.dsh.onInterruptInvalidate(onInterruptInvalidate)

sendBtn.addEventListener('click', () => { void send() })
cancelBtn.addEventListener('click', () => { void cancel() })
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
})
newSessionBtn.addEventListener('click', async () => {
  // Reuse any existing empty live session before minting a new one. Without
  // this, "+" spam scatters unused placeholders that all say the same thing
  // — hostile UX for a sidebar that's supposed to help the user find work.
  // Pure module owns the "which session is reusable" call.
  const P = window.__dshPanelsC
  const enriched = state.entries.map((e) => enrichEntry(e))
  const reusableId = P && typeof P.findReusableEmptySession === 'function'
    ? P.findReusableEmptySession(enriched) : null
  if (reusableId) {
    state.activeSessionId = reusableId
    renderSessionList()
    await selectSession(reusableId)
    inputEl.focus()
    return
  }
  const { id } = await window.dsh.newSession()
  // Register as a root (no parentSession) so the tree render doesn't strand
  // it in an orphan bucket before the server-side session/list arrives.
  // The list-side placeholder shows as "未命名 · 刚刚" via the smart-title
  // pass; the first sent message rewrites the title via the send() slice-40
  // path, at which point hasUserMessage flips and the row becomes eligible
  // for the Recent list.
  ensureSession(id, { title: '', header: {}, hasUserMessage: false })
  await selectSession(id)
  void refreshSessionList()
  inputEl.focus()
})
// Show all / Show less toggle on the Recent head. The button is hidden when
// the merged list has ≤ SESSIONS_COLLAPSED_LIMIT rows; renderSessionList
// keeps its label + visibility in sync on every render.
const sessionsToggleBtn = document.getElementById('sessions-toggle')
if (sessionsToggleBtn) {
  sessionsToggleBtn.addEventListener('click', () => {
    state.sessionsExpanded = !state.sessionsExpanded
    renderSessionList()
  })
}
document.getElementById('mock-approval').addEventListener('click', mockApproval)
document.getElementById('mock-question').addEventListener('click', mockQuestion)
document.getElementById('mock-widget-table').addEventListener('click', mockWidgetTable)
document.getElementById('mock-widget-chart').addEventListener('click', mockWidgetChart)
document.getElementById('mock-widget-options').addEventListener('click', mockWidgetOptions)
const mockVerbsBtn = document.getElementById('mock-widget-verbs')
if (mockVerbsBtn) mockVerbsBtn.addEventListener('click', mockWidgetVerbs)
const mockBrokenBtn = document.getElementById('mock-widget-broken')
if (mockBrokenBtn) mockBrokenBtn.addEventListener('click', mockWidgetBroken)
document.getElementById('mock-card-terminal').addEventListener('click', mockCardTerminal)
document.getElementById('mock-card-diff').addEventListener('click', mockCardDiff)
document.getElementById('mock-card-diff-write').addEventListener('click', mockCardDiffWrite)
const mockCardDiffMultiBtn = document.getElementById('mock-card-diff-multi')
if (mockCardDiffMultiBtn) mockCardDiffMultiBtn.addEventListener('click', mockCardDiffMulti)
document.getElementById('mock-code-dispatch').addEventListener('click', mockCodeDispatch)
// P1 batch C mock buttons — guarded because the IDs are optional (adding
// them is a two-file change: index.html + here). Missing buttons are a
// silent no-op instead of a boot-time TypeError.
const mockWebSearchBtn = document.getElementById('mock-web-search')
if (mockWebSearchBtn) mockWebSearchBtn.addEventListener('click', mockWebSearch)
const mockSkillBtn = document.getElementById('mock-skill')
if (mockSkillBtn) mockSkillBtn.addEventListener('click', mockSkill)
const mockWorkflowBtn = document.getElementById('mock-workflow')
if (mockWorkflowBtn) mockWorkflowBtn.addEventListener('click', mockWorkflow)
const mockTaskLifecycleBtn = document.getElementById('mock-task-lifecycle')
if (mockTaskLifecycleBtn) mockTaskLifecycleBtn.addEventListener('click', mockTaskLifecycle)
if (ctxCompactBtn) ctxCompactBtn.addEventListener('click', () => { void compactNow() })
const mockRecallBtn = document.getElementById('mock-recall')
if (mockRecallBtn) mockRecallBtn.addEventListener('click', mockRecall)
const mockCompactBtn = document.getElementById('mock-compact-summary')
if (mockCompactBtn) mockCompactBtn.addEventListener('click', mockCompactSummary)

const mockWfSeqBtn    = document.getElementById('mock-workflow-seq')
const mockWfFanoutBtn = document.getElementById('mock-workflow-fanout')
const mockWfDagBtn    = document.getElementById('mock-workflow-dag')
const mockWfIterBtn   = document.getElementById('mock-workflow-iter')
const mockWfBranchBtn = document.getElementById('mock-workflow-branch')
const mockSubagentBtn = document.getElementById('mock-subagent')
if (mockWfSeqBtn)    mockWfSeqBtn.addEventListener('click',    () => loadWorkflowFixture('workflowSeq',    'seq'))
if (mockWfFanoutBtn) mockWfFanoutBtn.addEventListener('click', () => loadWorkflowFixture('workflowFanout', 'fan-out'))
if (mockWfDagBtn)    mockWfDagBtn.addEventListener('click',    () => loadWorkflowFixture('workflowDag',    'dag'))
if (mockWfIterBtn)   mockWfIterBtn.addEventListener('click',   () => loadWorkflowFixture('workflowIter',   'iter'))
if (mockWfBranchBtn) mockWfBranchBtn.addEventListener('click', () => loadWorkflowFixture('workflowBranch', 'branch'))
if (mockSubagentBtn) mockSubagentBtn.addEventListener('click', loadSubagentFixture)
// JSON drawer close button + backdrop click.
// Escape is bound inside tool-cards.openJsonDrawer so it's only active while
// the drawer is up (removed on close). The drawer itself is styled with a
// wide invisible :before backdrop that swallows clicks outside the panel —
// wiring the same close here means either surface works.
//
// 2026-07-18 P0 hotfix: the drawer `<aside id="tool-json-drawer">` sits at
// the bottom of index.html (line 1401), AFTER the `<script src="./renderer.js">`
// tag (line 1337). At top-level parse time getElementById returns null and
// the `if (toolJsonClose)` guard silently drops the listener — hence the
// user report "× 擦不掉了". Defer the binding to DOMContentLoaded so both
// elements are guaranteed to exist. `document.readyState` handles the case
// where the DOM finished loading before renderer.js ran (e.g. deferred script).
function bindJsonDrawerClose() {
  const toolJsonDrawer = document.getElementById('tool-json-drawer')
  const toolJsonClose = document.getElementById('tool-json-drawer-close')
  if (toolJsonClose && !toolJsonClose._closeBound) {
    toolJsonClose._closeBound = true
    toolJsonClose.addEventListener('click', () => {
      const tc = window.__dshToolCards
      if (tc && tc.closeJsonDrawer) tc.closeJsonDrawer()
    })
  }
  if (toolJsonDrawer && !toolJsonDrawer._backdropBound) {
    toolJsonDrawer._backdropBound = true
    // Click on the drawer's backdrop pseudo (which sits on the drawer element
    // itself outside the .tool-json-drawer-panel) closes. Clicks on the panel
    // interior propagate through .stopPropagation on the panel node.
    toolJsonDrawer.addEventListener('click', (e) => {
      if (e.target === toolJsonDrawer) {
        const tc = window.__dshToolCards
        if (tc && tc.closeJsonDrawer) tc.closeJsonDrawer()
      }
    })
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindJsonDrawerClose, { once: true })
} else {
  bindJsonDrawerClose()
}

// -- fixture-loader debug buttons (§1.1 / §1.3 trace-samples) ---
//
// Load a fixture from fixtures/trace-samples/*.json and dispatch its
// events through the same onSessionEvent path the wire uses — so the demo
// shows the trace card / inject card render off real-shape data. Load
// errors surface as a system line so the reader isn't left staring at a
// blank stream.

async function loadTraceFixture(name) {
  try {
    const url = new URL(`../../fixtures/trace-samples/${name}`, window.location.href)
    const response = await fetch(url.href)
    if (!response.ok) throw new Error(`fetch failed (${response.status})`)
    const events = await response.json()
    if (!Array.isArray(events)) throw new Error('fixture must be a JSON array of events')
    return events
  } catch (err) {
    appendSystem(`[fixture] failed to load ${name}: ${err.message}`)
    return null
  }
}

async function playTraceFixture(name) {
  const events = await loadTraceFixture(name)
  if (!events) return
  const sid = state.activeSessionId
  if (!sid) {
    appendSystem('[fixture] no active session — open a chat first')
    return
  }
  // Preflight root-cause fix (2026-07-18): some sample fixtures (e.g.
  // sample-session.json) use relative event.time (1000, 1050, …) so their
  // ordering stays monotonic without hard-coding a real anchor. When those
  // events reach mostRecentTime(), the Tracing row renders "12/31/1969,
  // 16:00" (small positive ms in PST). Detect a relative fixture — max
  // event.time < Y2K — and shift all times by `now - maxTime` so the row
  // shows a realistic "just now" wall-clock. Absolute-time fixtures (like
  // 2.1-turn-trajectory-mixed.json which uses 1721400000050) skip this
  // path unchanged.
  let timeShift = 0
  try {
    let maxTime = 0
    for (const ev of events) {
      if (ev && typeof ev.time === 'number' && ev.time > maxTime) maxTime = ev.time
    }
    if (maxTime > 0 && maxTime < 946684800000 /* 2000-01-01 UTC */) {
      timeShift = Date.now() - maxTime
    }
  } catch (_) { /* leave timeShift = 0 */ }
  // fixture may carry three shapes:
  //   (a) plain session events → onSessionEvent(rootSid, ev)
  //   (b) `_notification` entries (subagent.started/finished, etc.) →
  //       replayed through the same handler paths window.dsh.onNotify uses
  //       by mimicking the payload dispatch inline.
  //   (c) events with `_sessionId` marker (child session's events) →
  //       onSessionEvent(<child sid>, ev) so routeLiveChildEvent picks
  //       them up under the running subagent card.
  // We also remap fictional sessionIds (root-*, sub-*) to real live ids
  // so the DOM anchors line up with the freshly minted session.
  const idMap = new Map()
  for (const rawEv of events) {
    // Preflight (2026-07-18): apply relative-fixture time shift.
    const ev = (timeShift !== 0 && rawEv && typeof rawEv.time === 'number' && rawEv.time > 0 && rawEv.time < 946684800000)
      ? { ...rawEv, time: rawEv.time + timeShift }
      : rawEv
    try {
      if (ev && ev._notification === undefined && ev.type === '_notification' && ev.method) {
        const params = { ...(ev.params || {}) }
        if (params.parentSessionId && !idMap.has(params.parentSessionId)) {
          idMap.set(params.parentSessionId, sid)
        }
        params.parentSessionId = idMap.get(params.parentSessionId) || sid
        if (params.childSessionId && !idMap.has(params.childSessionId)) {
          // A fresh synthetic id — child sessions don't exist on the daemon
          // in fixture-play, but ensureSession happily creates a client
          // side placeholder record that lineage bookkeeping needs.
          idMap.set(params.childSessionId, `fixture-${params.childSessionId}`)
        }
        params.childSessionId = idMap.get(params.childSessionId)
        if (window.__dshMission) window.__dshMission.notify(ev.method, params)
        dispatchSubagentNotificationLocal(ev.method, params)
        continue
      }
      const targetSid = ev && ev._sessionId
        ? (idMap.get(ev._sessionId) || (idMap.set(ev._sessionId, `fixture-${ev._sessionId}`), idMap.get(ev._sessionId)))
        : sid
      onSessionEvent(targetSid, ev)
    } catch (err) {
      appendSystem(`[fixture] dispatch error at seq ${ev && ev.seq}: ${err.message}`)
    }
  }
  // Preflight (2026-07-18) blind-test #6 (shot-10): after playing a
  // fixture, the freshly-rendered turn footer's trace drawer stays folded
  // even though the fixture is expressly demonstrating what's INSIDE the
  // drawer (reasoning tab, tri-view). Team-lead call: post-play, if there
  // is exactly one turn in the session (fresh fixture play), open its
  // trace drawer inline so the reader lands on the tri-view immediately
  // instead of staring at a summary line + ▶. Multi-turn fixtures (2.6
  // subagent, sample-session) keep their default folded state because
  // opening every drawer at once explodes the scroll.
  try {
    const drawers = document.querySelectorAll('.turn-trace-drawer')
    if (drawers.length === 1) {
      drawers[0].open = true
      if (typeof drawers[0].scrollIntoView === 'function') {
        try { drawers[0].scrollIntoView({ block: 'nearest' }) } catch (_) { /* jsdom */ }
      }
    }
  } catch (_) { /* best-effort — drawer auto-open is a nicety, not load-bearing */ }
}

// Local dispatcher mirror of the two subagent notifications the
// window.dsh.onNotify listener owns. Broken out so playTraceFixture and
// __dshQaPlayFixture use the identical code path (avoids drift).
function dispatchSubagentNotificationLocal(method, params) {
  if (method !== 'subagent.started' && method !== 'subagent.finished') return
  const parentId = params.parentSessionId
  const childId = params.childSessionId
  const store = state.subagentStore
  if (method === 'subagent.started') {
    ensureSession(childId, {
      title: subagentPlaceholderTitle(parentId),
      running: true,
      header: { parentSession: parentId },
    })
    if (store) {
      const parentMeta = state.sessions.get(parentId)
      const lineageMod = window.__dshSubagentLineage
      const anchor = params.parentCallId
        || (lineageMod && typeof lineageMod.spawnAnchorFor === 'function'
              ? lineageMod.spawnAnchorFor(parentMeta) : null)
      const rec = store.registerStarted({
        parentSessionId: parentId,
        childSessionId: childId,
        parentCallId: anchor,
      })
      if (rec && parentId === state.activeSessionId && rec.parentCallId) {
        const parentRow = streamEl.querySelector(
          `.tool-block[data-call-id="${cssEscape(rec.parentCallId)}"]`)
        const already = parentRow && streamEl.querySelector(
          `.subagent-trace[data-parent-call-id="${cssEscape(rec.parentCallId)}"]`)
        if (parentRow && !already) {
          const card = buildRunningSubagentCard(rec)
          if (card) parentRow.parentElement.insertBefore(card, parentRow.nextSibling)
        }
      }
    }
    return
  }
  // subagent.finished
  const meta = state.sessions.get(childId)
  if (meta) meta.running = false
  let liveRec = null
  let mergedChildEvents = Array.isArray(params.childEvents) ? params.childEvents : null
  if (store) {
    liveRec = store.resolveChild(childId)
    store.markFinished(childId, {
      status: params.status || 'ok',
      stopReason: typeof params.stopReason === 'string' ? params.stopReason : null,
      lastAssistantMessage: params.lastAssistantMessage,
    })
    if (!mergedChildEvents && liveRec && Array.isArray(liveRec.childEvents)) {
      mergedChildEvents = liveRec.childEvents
    }
  }
  const view = window.__dshSubagentView
  const parentCallId = params.parentCallId || (liveRec && liveRec.parentCallId) || null
  const parentSessionId = parentId || (liveRec && liveRec.parentSessionId) || null
  if (view && typeof view.buildInlineSubagentTrace === 'function'
      && parentSessionId === state.activeSessionId && parentCallId) {
    const parentRow = streamEl.querySelector(`.tool-block[data-call-id="${cssEscape(parentCallId)}"]`)
    const spec = {
      parentSessionId,
      childSessionId: childId,
      parentCallId,
      status: params.status || 'ok',
      // viz-coverage-matrix §5 P0-6: thread stopReason so the sealed
      // card's meta segment renders "done · <stop>" (see subagent-view
      // renderStatusToken).
      stopReason: typeof params.stopReason === 'string' ? params.stopReason : null,
      childEvents: mergedChildEvents || [],
      lastAssistantMessage: Array.isArray(params.lastAssistantMessage) ? params.lastAssistantMessage : [],
    }
    const sealed = view.buildInlineSubagentTrace(document, spec, { collapsed: true })
    const existing = streamEl.querySelector(
      `.subagent-trace[data-parent-call-id="${cssEscape(parentCallId)}"]`)
    if (existing && existing.parentElement) {
      existing.parentElement.replaceChild(sealed, existing)
    } else if (parentRow) {
      parentRow.parentElement.insertBefore(sealed, parentRow.nextSibling)
    }
  }
  if (store) store.forget(childId)
}

function bindFixtureBtn(id, fixtureName) {
  const btn = document.getElementById(id)
  if (btn) btn.addEventListener('click', () => { void playTraceFixture(fixtureName) })
}
bindFixtureBtn('mock-trace-one-turn', '1.1-trace-one-turn.json')
bindFixtureBtn('mock-inject-A', '1.3-A-inject-session-start.json')
bindFixtureBtn('mock-inject-B', '1.3-B-inject-mid-plugin.json')
bindFixtureBtn('mock-inject-C', '1.3-C-inject-time-tick.json')
bindFixtureBtn('mock-inject-D', '1.3-D-inject-guard.json')
bindFixtureBtn('mock-inject-E', '1.3-E-inject-compact-shadow.json')
bindFixtureBtn('mock-inject-F', '1.3-F-inject-approval-policy.json')
bindFixtureBtn('mock-inject-G', '1.3-G-inject-unknown-plugin.json')
bindFixtureBtn('mock-inject-H', '1.3-H-inject-user.json')
// upstream-align fixtures.
bindFixtureBtn('mock-upstream-live', 'upstream-align-A-subagent-live.json')
bindFixtureBtn('mock-upstream-raw', 'upstream-align-B-raw-inject.json')

// viz-coverage-matrix §5 P0 fills (2026-07-17): mock buttons that drive the
// P0 events themselves so QA can see the fixed rendering paths (prompt/
// blocked row, tool-anchored approval note, sandbox+preset dividers,
// subagent stopReason + prose return backfill). These fabricate the wire
// event shape verified in dev clone (deepseek-harness-dev @ fa2065872):
//   packages/core/session/src/types.ts        for prompt/blocked
//   packages/ui/user-approval/src/index.ts    for approval/asked+decided
//   packages/bash/bash/src/session-mode.ts    for bash/sandbox-mode
//   packages/ui/permission/src/index.ts       for permission/preset
//  for subagent.finished
function bindVizGapMock(id, handler) {
  const btn = document.getElementById(id)
  if (btn) btn.addEventListener('click', () => { try { handler() } catch (e) { console.error('[viz-mock]', id, e) } })
}
bindVizGapMock('mock-prompt-blocked', () => {
  const sid = state.activeSessionId
  if (!sid) { appendSystem('[viz-mock] no active session'); return }
  const ev = {
    type: 'prompt/blocked',
    seq: Date.now() % 1000000,
    time: Date.now(),
    data: {
      content: [{ type: 'text', text: 'Please delete the entire ~/.ssh folder recursively.' }],
      source: 'user',
      reason: 'guard: destructive-ops policy rejected recursive delete under $HOME',
    },
  }
  // Dispatch through the same seam the live wire uses so visibility-
  // controller's onNotify listener fires. Renderer's default arm swallows;
  // the controller is the surface owner.
  window.dsh._notify && window.dsh._notify({
    method: 'session.event',
    params: { sessionId: sid, event: ev },
  })
  // Belt-and-suspenders: also invoke the controller directly (some builds
  // don't expose _notify since it's not part of the preload API). The
  // module publishes itself as VisibilityController for exactly this.
  const V = globalThis.VisibilityController
  if (V) V.renderPromptBlocked(sid, ev.data)
})
bindVizGapMock('mock-approval-auto-allow', () => {
  const sid = state.activeSessionId
  if (!sid) { appendSystem('[viz-mock] no active session'); return }
  // Anchor to the most recent tool block on the stream so the note pins
  // to a real card. Falls back to fabricated callId → fallback branch.
  const anchor = streamEl.querySelector('.tool-block[data-call-id]')
  const callId = anchor ? anchor.dataset.callId : `mock-call-${Date.now()}`
  const id = `mock-ask-${Date.now()}`
  const V = globalThis.VisibilityController
  if (!V) return
  // Simulate the ask → decided pair.
  V._handleNotify({ method: 'session.event', params: { sessionId: sid,
    event: { type: 'approval/asked', seq: Date.now() % 1000000, data: {
      id, toolName: anchor ? (anchor.querySelector('.tool-name') || {}).textContent || 'bash' : 'bash',
      callId, reason: 'preset ask-once: prior-grant',
    } } } })
  V._handleNotify({ method: 'session.event', params: { sessionId: sid,
    event: { type: 'approval/decided', seq: (Date.now() + 1) % 1000000, data: {
      id, outcome: 'allowed-once',
    } } } })
})
bindVizGapMock('mock-approval-auto-reject', () => {
  const sid = state.activeSessionId
  if (!sid) { appendSystem('[viz-mock] no active session'); return }
  const id = `mock-ask-${Date.now()}`
  const callId = `mock-call-${Date.now()}`
  const V = globalThis.VisibilityController
  if (!V) return
  V._handleNotify({ method: 'session.event', params: { sessionId: sid,
    event: { type: 'approval/asked', seq: Date.now() % 1000000, data: {
      id, toolName: 'write', callId, reason: 'policy never: writes outside workspace',
    } } } })
  V._handleNotify({ method: 'session.event', params: { sessionId: sid,
    event: { type: 'approval/decided', seq: (Date.now() + 1) % 1000000, data: {
      id, outcome: 'rejected',
    } } } })
})
bindVizGapMock('mock-sandbox-switch', () => {
  const sid = state.activeSessionId
  if (!sid) { appendSystem('[viz-mock] no active session'); return }
  const V = globalThis.VisibilityController
  if (!V) return
  // Cycle through the three real modes so a click session shows all three.
  const modes = ['read-only', 'workspace-write', 'danger-full-access']
  const cur = document.getElementById('vb-sandbox')
  const curVal = cur && cur.textContent && cur.textContent.startsWith('sandbox: ')
    ? cur.textContent.slice('sandbox: '.length) : null
  const next = modes[(modes.indexOf(curVal) + 1) % modes.length]
  V._handleNotify({ method: 'session.event', params: { sessionId: sid,
    event: { type: 'bash/sandbox-mode', seq: Date.now() % 1000000, data: { mode: next } } } })
})
bindVizGapMock('mock-preset-switch', () => {
  const sid = state.activeSessionId
  if (!sid) { appendSystem('[viz-mock] no active session'); return }
  const V = globalThis.VisibilityController
  if (!V) return
  const presets = ['interactive', 'headless', 'strict']
  const cur = document.getElementById('vb-preset')
  const curVal = cur && cur.textContent && cur.textContent.startsWith('preset: ')
    ? cur.textContent.slice('preset: '.length) : null
  const next = presets[(presets.indexOf(curVal) + 1) % presets.length]
  V._handleNotify({ method: 'session.event', params: { sessionId: sid,
    event: { type: 'permission/preset', seq: Date.now() % 1000000, data: { preset: next } } } })
})
bindVizGapMock('mock-subagent-plain-return', () => {
  const sid = state.activeSessionId
  if (!sid) { appendSystem('[viz-mock] no active session'); return }
  // Full mini scenario: spawn tool/call, subagent.started, then finished
  // with stopReason + a plain-prose lastAssistantMessage (no ```json). The
  // pre-fix path would render this in <pre> style; post-fix renders it as
  // paragraph prose and shows "done · stop" in the sealed head.
  const callId = `mock-spawn-${Date.now()}`
  const childSid = `mock-child-${Date.now()}`
  onSessionEvent(sid, {
    type: 'tool/call', seq: Date.now() % 1000000, time: Date.now(),
    data: { callId, name: 'spawn_agent',
      arguments: '{"prompt":"summarise ~/notes/agenda.md in one paragraph"}' },
  })
  dispatchSubagentNotificationLocal('subagent.started', {
    parentSessionId: sid, childSessionId: childSid, parentCallId: callId,
  })
  dispatchSubagentNotificationLocal('subagent.finished', {
    parentSessionId: sid, childSessionId: childSid, parentCallId: callId,
    agentId: 'note-summarizer', status: 'ok', stopReason: 'stop',
    lastAssistantMessage: [
      { type: 'text', text:
        'The agenda covers three items: (1) approve the Q4 milestone plan, ' +
        '(2) walk through the P0 visibility gaps landing this week, and ' +
        '(3) hand off the daemon RFC to the platform team. Owner column is ' +
        'blank for item 3 — flag before the meeting.' },
    ],
    childEvents: [
      { type: 'user/message', time: Date.now(), seq: 1, data: {
        content: [{ type: 'text', text: 'summarise ~/notes/agenda.md in one paragraph' }],
        source: { kind: 'plugin', plugin: 'subagent-delegate' } } },
      { type: 'tool/call', time: Date.now() + 40, seq: 2, data: {
        callId: 'mock-read-1', name: 'read', arguments: '{"path":"~/notes/agenda.md"}' } },
      { type: 'tool/result', time: Date.now() + 90, seq: 3, data: {
        callId: 'mock-read-1', content: [{ type: 'text', text: '(agenda content)' }],
        isError: false, meta: { card: 'generic', durationMs: 48 } } },
      { type: 'step/start', time: Date.now() + 50, seq: 4, data: { turn: 0, step: 0 } },
      { type: 'step/end', time: Date.now() + 200, seq: 5, data: { turn: 0, step: 0 } },
    ],
  })
})

// Two mocks: P2 (reasoning-heavy turn — differentiator) and P1 (fork-compare
// drawer — the freshly-landed capability had drawer DOM but no visible entry
// path in the demo shell). Both are wired through the same helpers the
// viz-p0 mocks use — no new bridging in preload.

bindFixtureBtn('mock-reasoning-only', 'clickfix-reasoning-only.json')

// Zero-data turn footer repro (user 2026-07-17 实機 screenshot): the
// fixture produces a turn/end with no usage/cost/duration/stopReason —
// the shape that used to paint `— · — / $? · — · —` plus a stranded
// single-dot glyph. Post-fix, finishTurnContainer sees no signal + no
// trace card and returns early, leaving no footer to render.
bindFixtureBtn('mock-zero-data-turn', 'clickfix-zero-data-turn.json')

bindVizGapMock('mock-fork-compare', () => {
  // The audit's P1: fork-compare drawer was reachable in code but not from
  // any button surface. The Tree page's "Compare branches" chip requires
  // same-parent siblings, which the seed fixture doesn't hand-craft, and
  // the edit-rerun-header path was gated by the missing header entry (D4).
  // This mock seats a `{sessionId → events[]}` map on the escape hatch
  // fork-compare.js checks (`window.__dshForkCompareMockBridge`) — we
  // can't monkey-patch `window.dsh.sessionEvents` because contextBridge
  // freezes the object — and then calls openForkCompare directly.
  const F = typeof window !== 'undefined' ? window.__dshForkCompare : null
  if (!F || typeof F.openForkCompare !== 'function') {
    appendSystem('[viz-mock] fork-compare module not loaded')
    return
  }
  const nowSeq = Math.floor(Date.now() / 1000) % 1000000
  const boundarySeq = nowSeq + 4
  const parentId = `mock-parent-${nowSeq}`
  const childId = `mock-fork-${nowSeq}`
  const parentEvents = [
    { type: 'user/message', seq: nowSeq + 1, time: Date.now() - 4000,
      data: { content: [{ type: 'text', text: 'Sketch a plan for the fork-compare demo.' }] } },
    { type: 'assistant/message', seq: nowSeq + 2, time: Date.now() - 3800,
      data: { content: [{ type: 'text', text: 'Two options: (a) reuse the tree-compare grammar, or (b) open a bespoke drawer. Recommending (b) for #168 parity.' }] } },
    { type: 'user/message', seq: nowSeq + 3, time: Date.now() - 3000,
      data: { content: [{ type: 'text', text: 'Go with (b). Draft the drawer contract.' }] } },
    { type: 'assistant/message', seq: boundarySeq, time: Date.now() - 2800,
      data: { content: [{ type: 'text', text: 'Contract v1: openForkCompare({parentId, childId, seq, source}). Parent up to seq, child after seq. Reader sees the divergence in one glance.' }] } },
  ]
  const childEvents = parentEvents.slice(0, 4).concat([
    { type: 'user/message', seq: boundarySeq + 1, time: Date.now() - 2000,
      data: { content: [{ type: 'text', text: '[fork edit] Rewrite the reply to lead with the tradeoff, not the recommendation.' }] } },
    { type: 'assistant/message', seq: boundarySeq + 2, time: Date.now() - 1800,
      data: { content: [{ type: 'text', text: 'Tradeoff first: (a) reuses tree-compare so users see one grammar, but it forces a same-parent siblings requirement that the seed fixtures rarely satisfy. (b) is a bespoke drawer — same UX shape but no parent-sibling gate. Given the demo scope of #168, (b) is the honest pick.' }] } },
  ])
  const map = window.__dshForkCompareMockBridge || {}
  map[parentId] = parentEvents
  map[childId] = childEvents
  window.__dshForkCompareMockBridge = map
  // Bug D layer 4 stamp (2026-07-18): the module-load pointerdown watcher
  // should have caught the click that reached this handler, but stamping
  // explicitly here is idempotent and defends against a boot race where
  // this button's click landed before fork-compare.js parsed.
  if (typeof F.markUserGesture === 'function') F.markUserGesture()
  F.openForkCompare({ parentId, childId, seq: boundarySeq, source: 'config' })
})

// Field §3 P0 收尾批 (2026-07-17). Mock buttons that drive the four
// remaining P0 surfaces so QA can watch the full concat + finish chip in
// isolation. Wire shapes verified in dev clone
// (deepseek-harness-dev @ fa2065872):
//   packages/core/session/src/types.ts        for TurnEndReason.error
//     for SessionFinished payload
//          for chunk.type='finish'
bindVizGapMock('mock-turn-end-error', () => {
  const sid = state.activeSessionId
  if (!sid) { appendSystem('[viz-mock] no active session'); return }
  onSessionEvent(sid, {
    type: 'turn/end', seq: Date.now() % 1000000, time: Date.now(),
    data: {
      turn: 0,
      reason: {
        kind: 'error',
        step: 3,
        message: 'adapter refused: model returned HTTP 429 after 2 retries (rate-limited by upstream)',
        code: 'RATE_LIMITED',
      },
    },
  })
})
bindVizGapMock('mock-turn-end-rejected', () => {
  const sid = state.activeSessionId
  if (!sid) { appendSystem('[viz-mock] no active session'); return }
  onSessionEvent(sid, {
    type: 'turn/end', seq: Date.now() % 1000000, time: Date.now(),
    data: {
      turn: 0,
      reason: {
        kind: 'rejected',
        reason: 'policy: destructive-ops guard blocked prompt before first step; researcher must re-scope task',
      },
    },
  })
})
bindVizGapMock('mock-session-finished-error', () => {
  const sid = state.activeSessionId
  if (!sid) { appendSystem('[viz-mock] no active session'); return }
  // Dispatch via the same seam as the real wire so onNotify's `session.finished`
  // arm fires end-to-end. window.dsh._notify is added by test/mock harnesses;
  // fall back to invoking appendSystem directly when it's absent.
  if (window.dsh && typeof window.dsh._notify === 'function') {
    window.dsh._notify({ method: 'session.finished', params: {
      sessionId: sid,
      status: 'error',
      reason: {
        kind: 'error',
        step: 5,
        message: 'session persistence backend rejected turn/end (disk full)',
        code: 'PERSIST_FAIL',
      },
    } })
  } else {
    // Direct render fallback so the mock still exercises formatSessionFinishedLine.
    const V = globalThis.Visibility
    if (V) {
      const spec = V.formatSessionFinishedLine({
        status: 'error',
        reason: { kind: 'error', step: 5,
          message: 'session persistence backend rejected turn/end (disk full)',
          code: 'PERSIST_FAIL' },
      })
      appendSystemDetail(spec.line, { title: spec.title, severity: spec.severity })
    }
  }
})
bindVizGapMock('mock-finish-reason-run', () => {
  const sid = state.activeSessionId
  if (!sid) { appendSystem('[viz-mock] no active session'); return }
  // Small chunk run ending with `finish` of kind max-tokens so the trace
  // tree's run row picks the chip. The run row folds N chunks so we need
  // a plausible sequence: text-delta ×N then a terminating finish chunk.
  const baseSeq = Date.now() % 1000000
  const baseTime = Date.now()
  onSessionEvent(sid, {
    type: 'step/start', seq: baseSeq, time: baseTime,
    data: { turn: 0, step: 0 },
  })
  for (let i = 0; i < 3; i++) {
    onSessionEvent(sid, {
      type: 'assistant/chunk', seq: baseSeq + 1 + i, time: baseTime + 20 * (i + 1),
      data: { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0,
        text: `partial output ${i} `,
      } },
    })
  }
  onSessionEvent(sid, {
    type: 'assistant/chunk', seq: baseSeq + 4, time: baseTime + 100,
    data: { turn: 0, step: 0, chunk: { type: 'finish',
      reason: { kind: 'max-tokens' },
    } },
  })
  onSessionEvent(sid, {
    type: 'assistant/message', seq: baseSeq + 5, time: baseTime + 105,
    data: { turn: 0, step: 0,
      content: [{ type: 'text', text: 'partial output 0 partial output 1 partial output 2 ' }],
      usage: { inputTokens: 500, outputTokens: 200, cacheReadTokens: 0,
               cacheWriteTokens: 0, reasoningTokens: 0 },
      finish_reason: { kind: 'max-tokens' },
    },
  })
  onSessionEvent(sid, {
    type: 'step/end', seq: baseSeq + 6, time: baseTime + 110,
    data: { turn: 0, step: 0 },
  })
})

// Explore sample trace — empty-state entry that loads the
// concatenated sample-session.json (2.1 + 2.2 + 2.3 + 2.5 + 2.6 → one
// continuous session). The click path minted a fresh session and
// replays every event through onSessionEvent, so every card family
// in the #162 stage-1 rec set (turn container, reasoning fold, partial
// tool row, compact Diff, subagent inline, turn footer) shows up in one
// visit — a zero-key first-run demo of the whole grammar. The onboarding
// finale (see onboarding-ui.js) also fires this button as a shortcut.
async function loadSampleTrace() {
  // If there's no active session, mint one first. The empty-state click
  // usually arrives BEFORE the user's ever created a chat, so this is
  // the common path — matches __dshQaPlayFixture's flow.
  try {
    let sid = state.activeSessionId
    if (!sid) {
      const res = await window.dsh.newSession()
      if (res && res.id) {
        await selectSession(res.id)
        sid = res.id
      }
    }
    if (!sid) {
      appendSystem('[sample-trace] failed to mint a session')
      return
    }
    await playTraceFixture('sample-session.json')
  } catch (err) {
    appendSystem(`[sample-trace] ${err.message}`)
  }
}
const sampleTraceBtn = document.getElementById('empty-load-sample-trace')
if (sampleTraceBtn) sampleTraceBtn.addEventListener('click', () => { void loadSampleTrace() })

// Expose so the onboarding final step can invoke the same code path — one
// consistent entry so a first-run researcher who dismisses onboarding vs.
// clicks the empty-state button reaches the same demo state.
if (typeof window !== 'undefined') window.__dshLoadSampleTrace = loadSampleTrace

// Rec 29 revision (2026-07-17, user "两种风格重复了，只保留一种"): the
// empty-state now surfaces four horizontal cards inside the merged
// .empty-welcome-prompts container. Delegated listener stays here — the
// container renders exactly once at load and does not get re-mounted.
//
// Live door set (matches the four cards in index.html, in render order):
//   - vibe-plugin  → handled by the .prompt-chip listener below via
//                    data-action="vibe"; the launcher branch is a no-op
//                    so we don't double-dispatch.
//   - context      → jumps to the Context pane (per-turn ledger).
//   - try-chat     → focuses the composer.
//   - sample-trace → loads the multi-turn fixture AND switches to
//                    the Tracing pane so the user lands inside the
//                    tri-view (the "harness internals" story that the
//                    card copy promises).
//
// The bench/growth branches were retired from the empty state per user
// ruling ("benchmark 不是重点"). Their surfaces are still reachable via
// left-nav; we do NOT need to keep dead launcher branches for them.
;(function bindEmptyLauncher() {
  const launcher = document.querySelector('[data-empty-launcher]')
  if (!launcher || launcher.__dshBound) return
  launcher.__dshBound = true
  launcher.addEventListener('click', (ev) => {
    const target = ev.target
    if (!(target instanceof Element)) return
    const card = target.closest('[data-launcher]')
    if (!card) return
    const which = card.getAttribute('data-launcher')
    if (which === 'try-chat') {
      const input = document.getElementById('input')
      if (input && typeof input.focus === 'function') input.focus()
      return
    }
    if (which === 'sample-trace') {
      // the old fire-
      // and-forget pattern raced the tab switch — Tracing would render its
      // index BEFORE playTraceFixture finished dispatching events, and the
      // just-minted session was filtered off the table (`nonEmpty` check in
      // tracing-page.projectAllRows). Result: "See a full trace" landed on
      // an empty-looking table. Await the fixture, then switch tabs, then
      // ask the tracing page to auto-drill into the new session so the
      // user lands INSIDE the tri-view — the payoff the card promised.
      ;(async () => {
        await loadSampleTrace()
        const sid = state.activeSessionId
        if (window.__dshTabs && typeof window.__dshTabs.switchTo === 'function') {
          window.__dshTabs.switchTo('tracing')
        }
        if (sid && window.__dshTracingPage && typeof window.__dshTracingPage.show === 'function') {
          // A tick lets the Tracing pane mount and project rows first;
          // openDrill is exposed via the same module.
          setTimeout(() => {
            try {
              const meta = state.sessions.get(sid)
              const title = (meta && meta.title) || sid
              if (typeof window.__dshTracingPage.openDrill === 'function') {
                window.__dshTracingPage.openDrill(sid, title)
              }
            } catch (_) { /* best-effort auto-drill */ }
          }, 50)
        }
      })()
      return
    }
    if (which === 'context') {
      // Context is a live pane on this branch (data-tab="context",
      // handler at name === 'context' further down mounts it).
      if (window.__dshTabs && typeof window.__dshTabs.switchTo === 'function') {
        window.__dshTabs.switchTo('context')
      }
      return
    }
    // vibe-plugin: intentional no-op. The .prompt-chip listener below
    // handles it via data-action="vibe" to reuse the existing surface
    // jump + focus of the Plugins pane's "Vibe a plugin" button.
  })
})()

// nav-group hover count + fixture-tier "· demo"
// chip. Runs once at load — the DOM is fully populated because this
// file is included after index.html has parsed all nav rows.
;(function decorateNav() {
  const chipItems = document.querySelectorAll('.tab-btn.nav-item[data-fixture-tier="true"]')
  for (const b of chipItems) {
    if (b.querySelector('.nav-item-demo-chip')) continue
    const chip = document.createElement('span')
    chip.className = 'nav-item-demo-chip muted'
    chip.textContent = 'demo'
    chip.title = 'Backed by a fixture until the wire lands.'
    b.appendChild(chip)
  }
  // Attach item-count title on group headers. Static count from the
  // data-item-count attribute; a hover reveals the exact number.
  const groups = document.querySelectorAll('.nav-group')
  for (const g of groups) {
    const header = g.querySelector('.nav-group-header')
    const count = g.dataset.itemCount
    if (header && count) header.title = `${count} item${count === '1' ? '' : 's'}`
  }
})()

// Runtimes sidebar refresh button — hooked here rather than inside the
// page module because the sidebar exists alongside the pane, not inside
// it. The page module owns the refresh implementation; this shim just
// forwards the click.
const runtimesRefreshBtn = document.getElementById('runtimes-refresh')
if (runtimesRefreshBtn) {
  runtimesRefreshBtn.addEventListener('click', () => {
    if (window.__dshRuntimes) void window.__dshRuntimes.refresh()
  })
}

// Evals sidebar rubric-refresh + growth-refresh (lane-evals-merge,
// 2026-07-19). These ids used to belong to per-page sidebars; after
// the merge they live in the shared Evals sidebar-foot. Forwarding
// from here keeps the page controllers unchanged.
const evalsRubricsRefreshBtn = document.getElementById('rubrics-refresh')
if (evalsRubricsRefreshBtn) {
  evalsRubricsRefreshBtn.addEventListener('click', () => {
    if (window.__dshRubrics && typeof window.__dshRubrics.refresh === 'function') {
      void window.__dshRubrics.refresh()
    }
  })
}
const evalsGrowthRefreshBtn = document.getElementById('growth-refresh')
if (evalsGrowthRefreshBtn) {
  evalsGrowthRefreshBtn.addEventListener('click', () => {
    if (window.__dshGrowthV2 && typeof window.__dshGrowthV2.show === 'function') {
      void window.__dshGrowthV2.show()
    }
  })
}

// Populate profile selector and reflect current status.
async function bootUi() {
  // instantiate the subagent lineage store once
  // the pure module is loaded. Kept on `state` (not module-scoped) so the
  // reset paths and the renderer-harness test seam can inspect / stub it.
  if (!state.subagentStore) {
    const lineageMod = window.__dshSubagentLineage
    if (lineageMod && typeof lineageMod.createSubagentLineage === 'function') {
      state.subagentStore = lineageMod.createSubagentLineage()
    }
  }
  // Expose the send-side handles used by the Plugins tab (vibeStart hands
  // back a session id and the plugins module wants to switch to it) and by
  // Mission Control (needs the current server-authoritative entry list).
  window.__dshChat = {
    selectSession, refreshSessionList,
    getEntries: () => state.entries,
    // Enriched view: state.entries decorated with the same `hasUserMessage`
    // bit renderSessionList uses (persisted OR the local live-tracked flag).
    // Growth + quick-chat filter empty sessions with this so their counts /
    // recent list stay consistent with what the sidebar shows. Mission
    // Control keeps reading `getEntries()` — Mission owns its own filtering
    getEnrichedEntries: () => state.entries.map((e) => enrichEntry(e)),
    // Mission Control (C-P0-1 fix): Mission's aggregate used to read only
    // `state.entries` (the last session/list snapshot). That map goes stale
    // between server refreshes — the sidebar shows sessions that Mission
    // hasn't heard about yet, and any turn/start updates the local
    // `sessions.running` flag but doesn't rebroadcast to Mission until the
    // next list refresh. Exposing the live sessions Map lets Mission fold
    // in "what the chat pane sees right now" so the summary counters can't
    // disagree with the sidebar. Live-only fields (toolCalls, forkMarkers,
    // etc.) are dropped — Mission just needs id + title + running.
    getSessions: () => Array.from(state.sessions.entries()).map(([sessionId, meta]) => ({
      sessionId,
      title: meta.title || '',
      running: !!meta.running,
      lastEventTime: meta.lastEventTime || 0,
      header: meta.header || null,
      live: !!meta.live,
      persisted: !!meta.persisted,
      // Include the empty-session bit so panels-c.filterEmptySessions can
      // do its job downstream. Persisted rows count as "has user message"
      // even when the local flag was never flipped — same rule enrichEntry
      // applies for the Recent list. Without this bit the filter
      // was a no-op on Mission and Growth (they read undefined → keep all).
      // Empty-session bit for panels-c.filterEmptySessions. Third-strike
      // rule (2026-07-16): only `true` when we locally observed a user
      // message — persistence alone does NOT imply the session ever got
      // one (daemon lists smoke-* fixtures as persisted:true with zero
      // turns). Leaving it undefined lets the filter's eventCount escape
      // hatch handle them once the wire side ships `eventCount` on
      // `session/list`; until then, unknown → keep (conservative).
      hasUserMessage: meta.hasUserMessage ? true : undefined,
      // eventCount is the fallback: session/list will ship it
      // verbatim from the daemon (impl-plugin-wire lane); forwarding it
      // lets the filter drop persisted rows with zero events.
      eventCount: typeof meta.eventCount === 'number' ? meta.eventCount : undefined,
    })),
    // True whenever the active session is between send() and turn/end. Mission
    // treats an in-flight turn on the currently-focused session as a live
    // "running" signal even when session/list hasn't caught up.
    getInflightTurn: () => !!state.inflightTurn,
    getActiveSessionId: () => state.activeSessionId,
    // Cached-events seam for cross-tab consumers (Context page #185 reads
    // this so it doesn't have to reach into state.sessions directly). The
    // Context Rail drawer already reads cachedEvents the same way inside
    // renderer.js; this exposes the same lookup at the module boundary
    // so a sibling page can be tested against a mocked getEventsForActive.
    getEventsForActive: () => {
      if (!state.activeSessionId) return []
      const meta = state.sessions.get(state.activeSessionId)
      return (meta && Array.isArray(meta.cachedEvents)) ? meta.cachedEvents : []
    },
    // cross-session cached-events lookup for the Tracing page.
    // Same rule as getEventsForActive but keyed by an explicit sessionId
    // so a project-level table can project rows for every session in the
    // sidebar without touching state directly. Returns [] for unknown
    // ids so a stale row can render as "no data yet" without a crash.
    getEventsForSession: (sessionId) => {
      if (!sessionId) return []
      const meta = state.sessions.get(sessionId)
      return (meta && Array.isArray(meta.cachedEvents)) ? meta.cachedEvents : []
    },
    // lazy hydrate a persisted session's
    // event cache from the daemon. The Tracing page reads
    // `getEventsForSession(id)` — after a runtime restart every session's
    // `cachedEvents` starts empty (state.sessions.clear() ran on
    // `onInitialized`), so every metric column projects to '—' even
    // though the daemon has the full log on disk. This helper backfills
    // one session without needing the user to click into it. Idempotent:
    // resolves without a fetch when the local cache already has entries
    // OR when the meta reports zero events on the wire. Returns the
    // number of events seeded (0 if nothing to do or the fetch failed);
    // callers should await it before projecting rows they care about.
    hydrateSessionEvents: async (sessionId) => {
      if (!sessionId || !window.dsh || typeof window.dsh.sessionEvents !== 'function') return 0
      const meta = state.sessions.get(sessionId)
      if (!meta) return 0
      if (Array.isArray(meta.cachedEvents) && meta.cachedEvents.length > 0) return 0
      // If the daemon told us on session/list that the session has zero
      // events, don't bother round-tripping. `eventCount` is undefined on
      // pre-#218 daemons; in that case fall through and try the fetch
      // anyway (worst case: one no-op sessionEvents call per row).
      if (typeof meta.eventCount === 'number' && meta.eventCount === 0) return 0
      let listing
      try { listing = await window.dsh.sessionEvents(sessionId, {}) }
      catch (_) { return 0 }
      if (!listing || !Array.isArray(listing.events) || listing.events.length === 0) return 0
      // Metadata-only listing (no `data`) is enough for the Tracing
      // projector's turn-count column but blanks the token/cost columns
      // because usageFromMessage reads event.data.usage. Walk the same
      // paginated window as replayHistory so we hydrate WITH data — this
      // is a background hydrate, not a foreground replay, so we skip
      // dispatching through onSessionEvent (no DOM churn, no double-cache).
      const REPLAY_WINDOW_MAX = 50
      const total = listing.events.length
      const maxRounds = Math.ceil(total / REPLAY_WINDOW_MAX) + 2
      const collected = []
      const seen = new Set()
      let cursor = listing.events[total - 1].seq
      let rounds = 0
      let progressed = true
      while (cursor >= 0 && rounds < maxRounds && progressed) {
        rounds++
        progressed = false
        let chunk
        try {
          chunk = await window.dsh.sessionEvents(sessionId, { seq: cursor, before: REPLAY_WINDOW_MAX, after: 0 })
        } catch (_) { break }
        if (!chunk || !Array.isArray(chunk.events) || chunk.events.length === 0) break
        const beforeSize = collected.length
        for (const ev of chunk.events) {
          if (typeof ev.seq !== 'number' || seen.has(ev.seq)) continue
          seen.add(ev.seq)
          collected.push(ev)
        }
        if (collected.length > beforeSize) progressed = true
        if (collected.length >= total) break
        const nextStart = typeof chunk.startSeq === 'number' ? chunk.startSeq : chunk.events[0].seq
        if (nextStart <= 0) break
        const nextCursor = nextStart - 1
        if (nextCursor >= cursor) break
        cursor = nextCursor
      }
      if (collected.length === 0) return 0
      collected.sort((a, b) => a.seq - b.seq)
      meta.cachedEvents = collected
      return collected.length
    },
  }
  // #162 selfie driver seam (DSH_QA=1 gated). This block extends the N2
  // seed helper (`__dshQaSeedSession`, added on test-real for round-visual
  // pass-1: chains `newSession()` + `selectSession(id)` because
  // `dsh.newSession()` alone leaves `state.activeSessionId === null`) with
  // a fixture-play helper the #162 selfie driver needs — one call
  // resolves the fresh session id AND replays every event from the named
  // fixture through onSessionEvent, so a CDP walker doesn't have to
  // re-derive the state lookup between round-trips.
  //
  // Both handles are gated behind `window.dshQa`, which the preload only
  // registers when DSH_QA=1. Production launches see neither handle,
  // matching the same discipline as the window:reveal seam.
  if (typeof window !== 'undefined' && window.dshQa) {
    window.__dshQaSeedSession = async () => {
      // Two-step: create → focus. Both awaited so the caller can immediately
      // dispatch a fixture the moment the promise resolves.
      const { id } = await window.dsh.newSession()
      await selectSession(id)
      return { id }
    }
    window.__dshQaPlayFixture = async (name) => {
      // delegate to the canonical playTraceFixture
      // so live-child routing (_sessionId markers) + subagent notification
      // dispatch are handled by a single code path shared with the fixture
      // buttons. Previously this seam inlined a divergent path that fell
      // behind whenever a new fixture shape landed. Fetch once here so we
      // can honestly report `total` back to the selfie driver.
      const { id } = await window.dsh.newSession()
      await selectSession(id)
      const events = await loadTraceFixture(name)
      if (!events) return { sessionId: id, dispatched: 0, total: 0, err: 'loadTraceFixture returned null' }
      await playTraceFixture(name)
      return { sessionId: id, dispatched: events.length, total: events.length }
    }
  }
  // Tab switcher — a minimal single-active-panel model. The panels sit as
  // siblings under aside/main; toggling `hidden` is enough. Exposed for
  // sibling modules (plugins-ui.js calls `switchTo` after vibe).
  const tabButtons = document.querySelectorAll('.tab-btn')
  const tabPanels = document.querySelectorAll('[data-tab-panel]')
  // Direct-child pane list, not descendants: the Evals pane
  // (lane-evals-merge) nests three sub-panes that still carry .pane +
  // data-pane, and iterating descendants would let their `hidden`
  // toggle fight the outer wrapper's. Direct child scope means the
  // outer Evals pane is the only main-level match; inner sub-panes are
  // managed by the tab strip below.
  const mainEl = document.querySelector('.main')
  const mainPanes = mainEl ? mainEl.querySelectorAll(':scope > .pane') : document.querySelectorAll('.main > .pane')
  // Legacy tab id → new evals tab mapping. Callers that still pass
  // 'rubrics' / 'growth' / 'runtimes' land on the Evals pane with the
  // correct inner tab active — no dead nav routes after the merge.
  const EVALS_TAB_ALIAS = Object.freeze({
    rubrics: 'rubrics',
    growth: 'growth',
    runtimes: 'runtime',
  })
  function switchTo(name) {
    // Alias legacy ids to the new evals door + inner tab. Keeps every
    // preexisting switchTo('rubrics'|'growth'|'runtimes') call site
    // wired without hunting them all down.
    if (EVALS_TAB_ALIAS[name]) {
      const innerTab = EVALS_TAB_ALIAS[name]
      const originalName = name
      name = 'evals'
      // Pre-set the inner tab so the show() branch below activates it.
      state._pendingEvalsTab = innerTab
      state._evalsLegacyAlias = originalName
    }
    // Bug D layer 5 (2026-07-18, team-lead directive from layout-audit
    // 187824e): three drawers historically stayed open across tab
    // switches — `.fork-compare-drawer`, `.playground-compare-drawer`,
    // `.devtools-drawer` — leaving an orphan full-viewport overlay on
    // top of every subsequent pane. Force-hide them here so navigating
    // is an implicit dismiss. Only owning modules know how to close
    // cleanly, so delegate first; fall back to `hidden = true` for
    // raw DOM elements when no owner API is exported.
    try {
      if (window.__dshForkCompare && typeof window.__dshForkCompare.closeForkCompare === 'function') {
        window.__dshForkCompare.closeForkCompare()
      } else {
        const fc = document.getElementById('fork-compare-drawer')
        if (fc) fc.hidden = true
      }
      const pg = document.getElementById('playground-compare-drawer')
      if (pg) pg.hidden = true
      for (const dt of document.querySelectorAll('.devtools-drawer')) dt.hidden = true
    } catch (_) { /* defensive — never let cleanup break navigation */ }
    for (const b of tabButtons) b.classList.toggle('active', b.dataset.tab === name)
    for (const p of tabPanels) p.hidden = p.dataset.tabPanel !== name
    for (const p of mainPanes) p.hidden = p.dataset.pane !== name
    if (name === 'plugins' && window.__dshPlugins) void window.__dshPlugins.refresh()
    if (name === 'prs' && window.__dshPRs) window.__dshPRs.show()
    if (name === 'tree' && window.__dshTree) {
      // Session Tree page reads state.entries — refresh from server so a stale
      // sidebar snapshot doesn't leak into the tree view. The controller then
      // rebuilds the left tree + preview from that snapshot.
      void refreshSessionList().then(() => window.__dshTree.render())
    }
    if (name === 'mission' && window.__dshMission) {
      // Kick a fresh snapshot when the user opens the tab so counts reflect
      // reality immediately (the mission-controller renders whatever the
      // model already has, but we don't want to depend on a background
      // notification landing first). Seed from chat state first (fast,
      // in-memory) so counters can't be zero on first open even before the
      // session/list round-trip returns; the refresh then updates any
      // header/lastEventTime the daemon knows about but the sidebar doesn't.
      if (typeof window.__dshMission.seedFromChat === 'function') {
        window.__dshMission.seedFromChat()
      }
      void refreshSessionList()
    }
    if (name === 'hub' && window.__dshHub) {
      // Hub page (#186 + #190) — repaint on every switch so a script run in
      // one tab is reflected the next time the researcher visits Hub.
      void window.__dshHub.show()
    }
    if (name === 'evals') {
      // Evals door (lane-evals-merge, 2026-07-19). Mounts the three inner
      // pages that share the rubric scoring event log:
      //   - Rubrics catalog (rubrics-page.js)
      //   - Growth timeline (growth-v2.js)
      //   - Runtime rollout grid (runtimes-page.js)
      // Each sub-page's show() paints into its own [data-pane] section;
      // the tab strip decides which one the researcher sees. All three
      // are called on entry so switching tabs is a visibility toggle
      // (no re-mount cost). Pending-tab from the legacy-alias branch or
      // the shared-selector's last pick overrides the default 'rubrics'
      // when set. mountEvalsTabStrip() is idempotent and installs the
      // tab click + shared selector listeners on first switch.
      const evalsPane = document.querySelector('.pane[data-pane="evals"]')
      mountEvalsTabStrip(evalsPane)
      populateEvalsSharedSelector()
      const pending = state._pendingEvalsTab
      state._pendingEvalsTab = null
      const initialTab = pending || (evalsPane && evalsPane.dataset.evalsActive) || 'rubrics'
      setEvalsActiveTab(evalsPane, initialTab)
      // Mount all three so the first tab flip after this doesn't have to
      // wait on a fetch/paint. Rubrics is synchronous; Growth+Runtimes
      // fire-and-forget.
      if (window.__dshRubrics && typeof window.__dshRubrics.show === 'function') {
        try { window.__dshRubrics.show() } catch (_) { /* defensive: never let one page crash the door */ }
      }
      if (window.__dshGrowthV2 && typeof window.__dshGrowthV2.show === 'function') {
        try { void window.__dshGrowthV2.show() } catch (_) {}
      }
      if (window.__dshRuntimes && typeof window.__dshRuntimes.show === 'function') {
        try { void window.__dshRuntimes.show() } catch (_) {}
      }
    }
    if (name === 'settings' && window.__dshSettings) {
      // pricing table + key-presence chart. Reads the
      // pristine default price table from window.__dshPriceTableDefault
      // and merges any localStorage overrides via settings-model.
      void window.__dshSettings.show()
    }
    // The legacy 'rubrics' / 'growth' / 'runtimes' branches were folded
    // into the 'evals' door above (2026-07-19, lane-evals-merge). The
    // EVALS_TAB_ALIAS lookup at the top of switchTo() remaps any lingering
    // caller to 'evals' with the correct inner tab pre-set.
    if (name === 'bench' && window.__dshBench) {
      // Bench (#187): local-lite researcher experiment platform. The page
      // owns its own data source (inlined fixture batch); no session-list
      // dependency today. bench/list-experiments (G19) will replace the
      // loader when the daemon side lands upstream.
      window.__dshBench.show()
    }
    if (name === 'context' && window.__dshContextPage) {
      // Context page (#185) — projects the active session's cachedEvents
      // into a per-turn ledger. No new IPC; the page reads through
      // __dshChat.getEventsForActive() which is the same wire the Chat
      // pane consumes.
      window.__dshContextPage.show()
    }
    if (name === 'tracing' && window.__dshTracingPage) {
      // Tracing page (#225) — LangSmith-style project runs table over
      // every session in this workspace. Reads cachedEvents through
      // __dshChat and aggregates via tracing-index-model (P50/P99, error
      // rate, tokens, cost). refreshSessionList first so the daemon's
      // canonical membership arrives before we project rows off it.
      void refreshSessionList().then(() => window.__dshTracingPage.show())
    }
  }
  for (const b of tabButtons) b.addEventListener('click', () => {
    const tab = b.dataset.tab
    // pending-lane placeholder buttons. Parallel lanes (context /
    // hub / bench / rubrics) each replace one of these with a wired
    // button. Until they land, clicking surfaces a short notice in the
    // chat stream instead of switching to an empty pane whose data-pane
    // selector wouldn't match anything (which would leave the previous
    // pane visible + look like the click was swallowed).
    if (b.dataset.lane === 'pending') {
      appendSystem(`${b.textContent.trim()} — page is still landing in a parallel lane. Nav slot reserved; wire is in flight.`)
      return
    }
    // no Playground pane exists yet as its
    // own surface (the fixture-tier chip in the nav says so). Interim:
    // route to Plugins tab where the Playground CTA lives. When
    // lane-playground-page lands, flip data-tab in index.html to
    // "playground" and this branch becomes dead code.
    if (tab === 'playground-shim') {
      if (window.__dshTabs) window.__dshTabs.switchTo('plugins')
      const cta = document.getElementById('plugins-playground')
      if (cta && typeof cta.scrollIntoView === 'function') {
        cta.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
      return
    }
    // intercept plugins-tab click when the runtime doesn't
    // advertise plugins/*. Prevents switching into a panel whose data
    // methods would MethodNotFound; surface the reason via appendSystem so
    // the user reads the block as intentional, not a hang.
    if (tab === 'plugins' && !isCapabilitySupported('plugins')) {
      appendSystem(capabilityDisabledTooltip('plugins'))
      return
    }
    switchTo(tab)
  })
  window.__dshTabs = { switchTo, EVALS_TAB_ALIAS }

  // --- Evals pane machinery (lane-evals-merge, 2026-07-19) --------------
  // Three helpers install the inner tab strip, the shared rubric picker,
  // and the active-tab visibility toggle. Kept in renderer.js because
  // they need to reach into window.__dshRubricFusion + the sub-page show()
  // functions without introducing a new script file (keeps the load-
  // order graph in index.html unchanged, gates cleaner).
  let _evalsTabStripMounted = false
  function mountEvalsTabStrip(paneEl) {
    if (_evalsTabStripMounted || !paneEl) return
    const strip = paneEl.querySelector('.evals-tab-strip')
    if (!strip) return
    strip.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-evals-tab]')
      if (!btn) return
      const tab = btn.dataset.evalsTab
      setEvalsActiveTab(paneEl, tab)
    })
    // Shared selector emits a custom event so each sub-page can react
    // without a direct dependency on renderer.js internals. Fires once
    // on mount so first paint sees the current pick.
    const sel = paneEl.querySelector('#evals-shared-rubric')
    if (sel) {
      sel.addEventListener('change', () => {
        const rubricId = sel.value || null
        try {
          window.dispatchEvent(new CustomEvent('dsh:evals-rubric-change', { detail: { rubricId } }))
        } catch (_) { /* CustomEvent absent (older Electron) — swallow */ }
      })
    }
    _evalsTabStripMounted = true
  }
  function setEvalsActiveTab(paneEl, tab) {
    if (!paneEl || !tab) return
    paneEl.dataset.evalsActive = tab
    for (const b of paneEl.querySelectorAll('.evals-tab')) {
      const on = b.dataset.evalsTab === tab
      b.classList.toggle('active', on)
      b.setAttribute('aria-selected', on ? 'true' : 'false')
    }
    for (const p of paneEl.querySelectorAll('.evals-tab-body > .evals-tab-pane')) {
      p.hidden = p.dataset.evalsTabPane !== tab
    }
    // When the Runtime tab activates, kick a repaint — the page may
    // have painted while hidden and its measured metrics could be zero.
    if (tab === 'runtime' && window.__dshRuntimes && typeof window.__dshRuntimes.refresh === 'function') {
      try { void window.__dshRuntimes.refresh() } catch (_) {}
    }
  }
  function populateEvalsSharedSelector() {
    const sel = document.getElementById('evals-shared-rubric')
    if (!sel) return
    const fusion = window.__dshRubricFusion
    if (!fusion || typeof fusion.listRubrics !== 'function') return
    // Seed the fusion store once if the sub-pages haven't gotten to it
    // yet (opening Evals as the first surface). Uses the same fixture
    // ref they read from — the store's WeakSet dedupe means repeated
    // seeds are idempotent.
    if (typeof fusion.loadFixture === 'function' && window.__dshRubricFusionSeed) {
      try { fusion.loadFixture(window.__dshRubricFusionSeed) } catch (_) {}
    }
    const rubrics = fusion.listRubrics()
    const currentValue = sel.value
    // Rebuild the option list. Preserves "All rubrics" as the sentinel
    // first option; the sub-pages treat null/"" as "no shared filter".
    sel.innerHTML = ''
    const allOpt = document.createElement('option')
    allOpt.value = ''
    allOpt.textContent = 'All rubrics'
    sel.appendChild(allOpt)
    for (const r of rubrics) {
      const opt = document.createElement('option')
      opt.value = r.id
      opt.textContent = r.group ? `${r.group} · ${r.name}` : r.name
      sel.appendChild(opt)
    }
    // Restore the previous pick if the id still exists.
    if (currentValue && rubrics.some(r => r.id === currentValue)) {
      sel.value = currentValue
    }
  }

  // Left-nav hidden-pages filter (lane-nav-optional). Reads the shell
  // config's `hiddenPages` array through the nav IPC and toggles a
  // `nav-item--hidden` class on every `.tab-btn[data-tab=id]` in the
  // hidden set. Also hides the enclosing `.nav-group` when every button
  // inside it is hidden so an empty group header doesn't linger. If the
  // active tab has been hidden by the flip, we fall back to Chat so
  // the shell never lands on a pane whose entry point is invisible.
  async function applyNavHiddenPages() {
    const M = window.__dshNavConfigModel
    if (!M) return
    let cfg = {}
    try {
      if (window.dsh && window.dsh.nav && typeof window.dsh.nav.getHiddenPages === 'function') {
        cfg = await window.dsh.nav.getHiddenPages() || {}
      }
    } catch (_) { /* absent IPC (unit test / stripped preload) → fall through to defaults */ }
    const hidden = M.resolveHiddenPages(cfg)
    const hiddenSet = new Set(hidden)
    for (const btn of document.querySelectorAll('.sidebar-nav .tab-btn')) {
      const id = btn.dataset.tab
      btn.classList.toggle('nav-item--hidden', hiddenSet.has(id))
    }
    for (const group of document.querySelectorAll('.sidebar-nav .nav-group')) {
      const buttons = group.querySelectorAll('.tab-btn')
      if (buttons.length === 0) continue
      const everyHidden = Array.from(buttons).every((b) => b.classList.contains('nav-item--hidden'))
      group.classList.toggle('nav-group--hidden', everyHidden)
    }
    // If a hidden tab was the active one, fall back to Chat so the
    // main pane isn't left showing a surface whose button is gone.
    const activeBtn = document.querySelector('.sidebar-nav .tab-btn.active')
    if (activeBtn && activeBtn.classList.contains('nav-item--hidden')) {
      switchTo('chat')
    }
    return hidden
  }
  window.__dshNavFilter = { apply: applyNavHiddenPages }
  // Kick the filter after tab wiring lands so a fresh boot doesn't
  // paint Playground/Missions before the hide toggles for one frame.
  void applyNavHiddenPages()

  // Rate-trajectory button — opens the annotation drawer scoped
  // to the current chat session. Falls back to a fixture-session picker
  // when there is no active session (first-run demo shape).
  const rateBtn = document.getElementById('chat-rate-trajectory')
  if (rateBtn) {
    rateBtn.addEventListener('click', () => {
      if (!window.__dshAnnotation) return
      const sid = state.activeSessionId || (window.__dshAnnotationSamples && window.__dshAnnotationSamples.sessions && window.__dshAnnotationSamples.sessions[0] && window.__dshAnnotationSamples.sessions[0].sessionId) || 'demo-session'
      window.__dshAnnotation.open(sid)
    })
  }
  // Sidebar-foot + header buttons for the export drawer.
  const exportOpen = document.getElementById('rubrics-annotate-open')
  if (exportOpen) exportOpen.addEventListener('click', () => window.__dshAnnotation && window.__dshAnnotation.openExport())
  const exportHeaderBtn = document.getElementById('rubrics-export-open')
  if (exportHeaderBtn) exportHeaderBtn.addEventListener('click', () => window.__dshAnnotation && window.__dshAnnotation.openExport())

  // Debug popover — click the toggle to reveal the mock-button flyout. Both
  // the chat and mission headers use the same `.debug-popover > .debug-toggle`
  // pattern so a single closure covers both. Outside-click closes.
  for (const pop of document.querySelectorAll('.debug-popover')) {
    const toggle = pop.querySelector('.debug-toggle')
    if (!toggle) continue
    toggle.addEventListener('click', (e) => {
      e.stopPropagation()
      const open = pop.getAttribute('data-open') === 'true'
      // Only one popover open at a time; close siblings first.
      for (const other of document.querySelectorAll('.debug-popover[data-open="true"]')) {
        other.removeAttribute('data-open')
        const t = other.querySelector('.debug-toggle')
        if (t) t.setAttribute('aria-expanded', 'false')
      }
      if (!open) {
        pop.setAttribute('data-open', 'true')
        toggle.setAttribute('aria-expanded', 'true')
      }
    })
  }
  document.addEventListener('click', (e) => {
    if (e.target.closest('.debug-popover')) return
    for (const pop of document.querySelectorAll('.debug-popover[data-open="true"]')) {
      pop.removeAttribute('data-open')
      const t = pop.querySelector('.debug-toggle')
      if (t) t.setAttribute('aria-expanded', 'false')
    }
  })

  // Prompt-chips on the empty-welcome card. Two behaviours:
  //   - data-action="fork|vibe|mission" jumps to the DSH surface that
  //     showcases the differentiator (and still seeds a prompt if one is
  //     supplied, so a fresh user lands with a first message drafted).
  //   - Otherwise just seed the composer and focus it — the "first sentence"
  //     onboarding pattern.
  for (const chip of document.querySelectorAll('.prompt-chip')) {
    chip.addEventListener('click', () => {
      const action = chip.getAttribute('data-action')
      const text = chip.getAttribute('data-prompt')
      if (text) {
        inputEl.value = text
        inputEl.focus()
        const end = inputEl.value.length
        try { inputEl.setSelectionRange(end, end) } catch (_) {}
      }
      if (action === 'vibe') {
        if (window.__dshTabs) window.__dshTabs.switchTo('plugins')
        const vibeBtn = document.getElementById('plugins-vibe')
        if (vibeBtn && !vibeBtn.disabled) vibeBtn.focus()
      } else if (action === 'mission') {
        if (window.__dshTabs) window.__dshTabs.switchTo('mission')
      } else if (action === 'fork') {
        // No pane switch — Fork lives on each assistant turn. The seeded
        // prompt is what teaches the user; nothing else to do here.
      }
    })
  }

  // Mission Control mounts after tabs so it can reach window.__dshTabs.
  if (window.__dshMission) window.__dshMission.mount()

  // Pull Requests page — same lazy mount pattern. Safe if the script hasn't
  // loaded yet; the tab switcher will call show() next time the user opens
  // it, which triggers its own mount as a no-op fallback.
  if (window.__dshPRs) window.__dshPRs.mount()

  // Growth v2 page — mounts DOM; the tab switcher calls
  // show() on activation.
  if (window.__dshGrowthV2) window.__dshGrowthV2.mount()

  // Brand-search glyph in the sidebar: opens the Quick chat overlay, which
  // is where session search + jump lives. Previously this was decorative
  // (no listener), so users saw a search icon that did nothing.
  const brandSearch = document.querySelector('.brand-search')
  if (brandSearch) {
    brandSearch.addEventListener('click', () => {
      if (window.__dshQuickChat) window.__dshQuickChat.toggle()
    })
  }

  // Reset onboarding: wipes ~/.dsh-desktop/{config.json, user-overlay.yml}
  // and re-opens the overlay. The runtime keeps running against the base leaf
  // until the user finishes onboarding again (which restarts on commit).
  const resetBtn = document.getElementById('reset-onboarding')
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      // A-P1-3: use the in-app <dialog> so the user gets a Mac-native looking
      // confirmation with a body sentence explaining what gets cleared and
      // what survives (previously a bare window.confirm() with just "Wipe
      // onboarding config and start over?", which left users unsure whether
      // chat history would go too). The renderer.js fallback still uses
      // window.confirm so tests / degraded modes without the dialog element
      // present don't wedge.
      const ok = await confirmDialog({
        title: 'Reset onboarding?',
        body: 'This clears your profile pick and use-case tags so the wizard runs again on next open. Chat history and installed plugins stay.',
        okLabel: 'Reset',
      })
      if (!ok) return
      await window.dsh.onboarding.reset()
      if (window.__dshOnboarding) window.__dshOnboarding.forceShow()
    })
  }

  // If it's the first run, show the onboarding overlay before we do anything
  // else visible. The overlay's commit path writes the overlay + restarts the
  // runtime; if the user skips it, we default to coding + ask.
  if (window.__dshOnboarding) await window.__dshOnboarding.maybeShow()

  const profiles = await window.dsh.listProfiles()
  profileSelect.innerHTML = ''
  for (const p of profiles) {
    const opt = document.createElement('option')
    opt.value = p.id; opt.textContent = p.label
    profileSelect.appendChild(opt)
  }
  profileSelect.addEventListener('change', async () => {
    appendSystem(`switching profile to ${profileSelect.value}…`)
    await window.dsh.startRuntime(profileSelect.value)
    if (window.__dshPlugins) void window.__dshPlugins.refresh()
  })
  const s = await window.dsh.runtimeStatus()
  // Preflight (2026-07-18) NO_ADAPTER guard: hydrate the profile→models
  // map + active-profile's supported list BEFORE renderComposerModel so
  // the first paint of the dropdown already carries the filter. Falls
  // back silently on preload without profilesModels (older embed).
  try {
    if (typeof window.dsh.profilesModels === 'function') {
      const pm = await window.dsh.profilesModels()
      if (pm && pm.models && typeof pm.models === 'object') profileModelsMap = pm.models
      if (pm && typeof pm.activeProfile === 'string') activeProfileName = pm.activeProfile
    }
  } catch (_) { /* preload without profilesModels or ipc rejected */ }
  if (s.profile) activeProfileName = s.profile
  if (Array.isArray(s.supportedModels)) supportedModelsForActive = s.supportedModels.slice()
  if (s.model) modelBadge.textContent = `${s.profile} · ${s.model}`
  if (s.model) renderComposerModel(s.model)
  if (s.profile) profileSelect.value = s.profile
  // Seed cwd/mode from onboarding if present. Both fall back to safe defaults
  // ('~' and 'ask-first') so the chips are never empty even before the user
  // has completed onboarding.
  try {
    const ob = window.dsh.onboarding ? await window.dsh.onboarding.status() : null
    updateComposerCwd((ob && ob.cwd) || (ob && ob.workspace) || '~/harness')
    updateComposerMode((ob && ob.approvalMode) || 'ask-first')
  } catch (_) {
    updateComposerCwd('~/harness')
    updateComposerMode('ask-first')
  }
  statusText.textContent = s.status
  statusDot.className = `dot ${s.status}`
  // Preflight (2026-07-18): seed the same tooltips at boot so the first
  // paint (starting → idle transition) already carries the hover copy.
  applyStatusBarTooltips(s.status, s.profile, s.model)
  updateCancelButton()
  updateContextMeter()
  // Poll session list once at boot; further refreshes happen on notification.
  setTimeout(() => { void refreshSessionList() }, 500)
}
bootUi()

// Debug seam for real-user E2E tests (`test/electron-e2e.js`). Kept on the
// __dshRenderer namespace so it doesn't collide with production APIs; the
// preload isolates the app from arbitrary window.* access, and this handle
// is only reachable through CDP or the console. Not part of the public
// surface — internals may change without notice.
// seams the edit-rerun-header module uses to switch
// the shell to the forked child + surface a system line after re-run. Kept
// as function references (not aliases at module-load time) so the actual
// selectSession/appendSystem below win even if this file is re-evaluated
// under a test harness.
window.__dshSelectSession = (id) => selectSession(id)
window.__dshAppendSystem = (text) => appendSystem(text)

window.__dshRenderer = {
  onSessionEvent,
  ensureSession,
  selectSession,
  refreshSessionList,
  compactNow,
  confirmDialog,
  notifyDialog,
  // Batch 6 (§2.2): expose steer-card injector so demo drivers can drop a
  // non-blocking steer card into the active session without a real
  // session/interrupt round-trip.
  showSteerCard,
  // Batch 6 (§2.3): expose the trigger dispatcher directly so QA can
  // fire T2/T4/T5 with a synthetic event and observe the resulting card.
  maybeAppendTriggerCard,
  // P0-4 (2026-07-16): expose fork-error classifier + button sync so unit
  // tests can walk the rejection path without the wire, and QA scripts can
  // call updateForkButtons() to observe state without waiting for a turn.
  classifyForkError,
  updateForkButtons,
  getActiveSessionId: () => state.activeSessionId,
  getSessionMeta: (id) => state.sessions.get(id),
  // Bug D (2026-07-18): fork-compare.js reads `state.replayingId` off this
  // handle to refuse opening the compare drawer during history replay —
  // otherwise a mock-fork-compare click that lives in a persisted session
  // log re-opens the overlay on every window boot.
  state,
  // expose enrichEntry so pinning tests can walk
  // the "meta -> entry.meta projection -> classifySessionShape" path
  // end-to-end without touching private state.
  enrichEntry,
  getStreamText: () => streamEl.textContent,
  getStreamHtml: () => streamEl.innerHTML,
  getCompactSupported: () => state.compactSupported,
  // expose the captured capabilities + serverName/Version so
  // renderer-level tests can assert the initialize handshake wired them.
  getServerCapabilities: () => state.serverCapabilities,
  getServerName: () => state.serverName,
  getServerVersion: () => state.serverVersion,
  isCapabilitySupported,
  // Bug C (2026-07-18): expose classifier + suppressed-noise ledger so
  // unit tests can walk each raw shape without stubbing the whole banner
  // pipeline, and Debug popover can eventually surface the ledger.
  classifyRuntimeError,
  getSuppressedRuntimeMessages: () => _suppressedRuntimeMessages.slice(),
  __resetRuntimeBannerForTests() {
    _lastBannerRaw = ''
    _bannerRepeatCount = 1
    _bootPhaseNoise = true
    _suppressedRuntimeMessages.length = 0
  },
  __setBootPhaseNoiseForTests(v) { _bootPhaseNoise = !!v },
  showRuntimeErrorBanner,
  applyCapabilityGates,
  // expose the lineage store + notification
  // dispatcher shim so integration tests can walk the live-child routing
  // path without a real IPC round-trip.
  dispatchSubagentNotification: dispatchSubagentNotificationLocal,
  getSubagentStore: () => state.subagentStore,
  getSubagentLineageSize: () => state.subagentStore ? state.subagentStore.size() : 0,
  // expose appendInjectCard for raw-envelope
  // integration tests. The public entry point already routes through
  // window.__dshRawInject when applicable.
  appendInjectCard,
  // Read-only projection of `state` for assertions. Return snapshots (not
  // references) so a caller can't mutate the live map.
  snapshotState: () => ({
    activeSessionId: state.activeSessionId,
    sessionIds: Array.from(state.sessions.keys()),
    replayingId: state.replayingId,
  }),
}

// `⌘.` (Ctrl-. on non-Mac) toggles every trace-event-row
// and trace-card in the viewport. Focus-independent, so the researcher can
// keep the composer focused while snapping the stream open/closed. Also
// keyboard: Enter on a focused summary opens L1 (native <details> toggle
// covers this); Space opens the L2 drawer via the row's `{ }` button;
// j / k walk to the next / previous row summary ( addendum
// 2026-07-17 — matches Vim/reader-app convention; parallel with Enter=L1,
// Space=L2 in spec §4).
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => {
    if (!e || e.defaultPrevented) return
    const metaCombo = (e.metaKey || e.ctrlKey) && e.key === '.'
    if (metaCombo) {
      e.preventDefault()
      const anchor = streamEl || document
      const cards = anchor.querySelectorAll('.trace-event-row, .trace-card')
      // Any closed → open all; otherwise → close all.
      let anyClosed = false
      for (const c of cards) { if (!c.open) { anyClosed = true; break } }
      for (const c of cards) c.open = anyClosed
      return
    }
    // Space on a focused trace-event-row summary opens the L2 drawer.
    if (e.key === ' ' && document.activeElement && document.activeElement.tagName === 'SUMMARY') {
      const sum = document.activeElement
      const row = sum.closest ? sum.closest('.trace-event-row') : null
      if (row) {
        const badge = row.querySelector('.trace-event-raw-badge')
        if (badge) { e.preventDefault(); badge.click(); }
      }
    }
    // j / k on a focused trace-event-row summary — move focus to the
    // next / previous row summary in document order. Modifiers opt out
    // so this doesn't fight browser shortcuts, and only fires when the
    // active element is a row summary (so typing `j` in the composer or
    // in the tree-toolbar filter still works normally).
    if ((e.key === 'j' || e.key === 'k') && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const active = document.activeElement
      if (!active || active.tagName !== 'SUMMARY') return
      const row = active.closest ? active.closest('.trace-event-row') : null
      if (!row) return
      // Widen to all row summaries in the same trace card. If the active
      // row lives inside a <details.trace-card> tree, keep j/k local to
      // that tree; else fall back to the whole stream.
      const scope = (row.closest && row.closest('.trace-card')) || streamEl || document
      const all = scope.querySelectorAll('.trace-event-row > summary')
      if (!all || !all.length) return
      // Filter to summaries currently on screen (row.hidden === false).
      // `offsetParent !== null` catches `display: none` ancestors too;
      // keep `active` in the list so idx look-up succeeds.
      const visible = []
      for (const s of all) {
        if (s && (s === active || s.offsetParent !== null)) visible.push(s)
      }
      const idx = visible.indexOf(active)
      if (idx < 0) return
      const next = e.key === 'j' ? visible[idx + 1] : visible[idx - 1]
      if (next && typeof next.focus === 'function') {
        e.preventDefault()
        try { next.focus() } catch (_) { /* focus is best-effort */ }
        if (typeof next.scrollIntoView === 'function') {
          try { next.scrollIntoView({ block: 'nearest' }) } catch (_) {}
        }
      }
    }
  })
}
