// Pure helpers for the P1 renderer batch C (workflow / tasks / web / skill /
// resume). No DOM, no globals — the controller layer (panels-c-controller.js)
// wraps these in one direction only. Same shape as visibility.js.
//
// Covered gaps (see docs/capability-ui-coverage.md §2 + §3):
//   - web_search  → result-list card (title + url + snippet)
//   - skill       → "skill loaded: <name>" badge + folded body
//   - workflow    → orchestration card skeleton (workflow name + phase list)
//   - task_*      → background-task panel state reducer
//   - session/resume → session-list splitter (live vs. persisted-only history)
//
// The pure module does NOT talk to the runtime. All wire-side coupling lives
// in panels-c-controller.js. Everything here is data → data.
//
// Payload shapes:
//   packages/web/tool-web/src/search.ts   → { url, title, snippet? } content blocks
//   packages/skill/tool-skill/src/index.ts → args: { name }, content: skill body
//   packages/workflow/tool-workflow/src   → args: { name, ... }, content plain
//   packages/tasks/tool-tasks/src/*.ts    → task_output/task_list/task_kill
//   packages/ui/jsonrpc/README.md         → session/resume, session/list live/persisted

'use strict'

// -- web_search result folding ----------------------------------------------

/**
 * Extract a list of {url, title, snippet} rows from `tool/result.content`.
 * The web_search tool emits either:
 *   1. structured JSON (as a single text content block containing JSON), or
 *   2. plain-text lines like "1. <title>\n<url>\n<snippet>\n"
 * We accept both. Malformed rows drop silently — the caller renders whatever
 * we return and falls through to raw text if the list is empty.
 *
 * @param {unknown} content — `event.data.content` (array of content blocks)
 * @returns {{ results: {url:string,title:string,snippet:string}[], raw: string }}
 */
function foldWebSearchResults(content) {
  const raw = joinTextBlocks(content)
  const results = []
  if (!raw) return { results, raw: '' }

  // Path 1: JSON — the tool ships a `{results: [...]}` object or a bare array.
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed && parsed.results)
          ? parsed.results
          : null
      if (list) {
        for (const row of list) {
          const r = normalizeSearchRow(row)
          if (r) results.push(r)
        }
        return { results, raw }
      }
    } catch (_) { /* fall through to text parse */ }
  }

  // Path 2: plain text — split on blank lines, take the first http(s) token as
  // URL, the line before it as title, the rest as snippet. Best-effort; we're
  // never doing more than a demo-quality parse here.
  const blocks = raw.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)
  for (const block of blocks) {
    const lines = block.split('\n').map((s) => s.trim()).filter(Boolean)
    let urlIdx = -1
    let url = ''
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/(https?:\/\/[^\s"'<>)]+)/i)
      if (m) { url = m[1]; urlIdx = i; break }
    }
    if (!url) continue
    const title = urlIdx > 0 ? lines[urlIdx - 1] : lines[0]
    const snippet = lines.slice(urlIdx + 1).join(' ')
    if (isSafeExternalUrl(url)) {
      results.push({ url, title: title || url, snippet })
    }
  }
  return { results, raw }
}

function normalizeSearchRow(row) {
  if (!row || typeof row !== 'object') return null
  const url = typeof row.url === 'string' ? row.url : ''
  if (!isSafeExternalUrl(url)) return null
  const title = typeof row.title === 'string' && row.title ? row.title : url
  const snippet = typeof row.snippet === 'string' ? row.snippet
    : typeof row.description === 'string' ? row.description
      : ''
  return { url, title, snippet }
}

/**
 * Whitelist http(s) URLs for shell.openExternal. Any other scheme (file:,
 * javascript:, data:, custom-protocol:) is rejected. Matches the safety edge
 * artifact-ipc.js already applies to the artifact server URLs.
 * @param {unknown} u
 */
function isSafeExternalUrl(u) {
  if (typeof u !== 'string' || u === '') return false
  try {
    const parsed = new URL(u)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch (_) {
    return false
  }
}

// -- skill fold --------------------------------------------------------------

/**
 * Extract the loaded skill's display name and body from a tool/call+result
 * pair. `args` is the JSON string from `tool/call.arguments`; `content` is
 * from `tool/result.content`. The skill tool takes `{name}` in args and hands
 * back the skill body as text content.
 *
 * @param {{ args?: string, content?: unknown }} input
 * @returns {{ name: string, body: string }}
 */
function foldSkillLoad({ args, content } = {}) {
  let name = ''
  if (typeof args === 'string' && args) {
    try {
      const parsed = JSON.parse(args)
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.name === 'string') name = parsed.name
        else if (typeof parsed.skill === 'string') name = parsed.skill
      }
    } catch (_) { /* fall through */ }
  }
  const body = joinTextBlocks(content)
  return { name, body }
}

// -- workflow fold -----------------------------------------------------------

/**
 * Extract workflow display metadata from a `workflow` tool/call. The wire
 * side hasn't (yet) plumbed `workflow/*` Cordis events through, so the card
 * we render is a placeholder skeleton: name + a "phases pending" slot the
 * controller fills once notifications arrive. Kept structured so the wire-up
 * is a data swap not a rewrite.
 *
 * @param {{ args?: string }} input
 * @returns {{ name: string, phases: {id:string,label:string,status:'pending'|'running'|'done'|'failed'}[] }}
 */
function foldWorkflowCall({ args } = {}) {
  let name = ''
  let phases = []
  if (typeof args === 'string' && args) {
    try {
      const parsed = JSON.parse(args)
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.name === 'string') name = parsed.name
        else if (typeof parsed.workflow === 'string') name = parsed.workflow
        if (Array.isArray(parsed.phases)) {
          for (const p of parsed.phases) {
            if (typeof p === 'string') phases.push({ id: p, label: p, status: 'pending' })
            else if (p && typeof p === 'object' && typeof p.id === 'string') {
              phases.push({
                id: p.id,
                label: typeof p.label === 'string' ? p.label : p.id,
                status: normalizePhaseStatus(p.status),
              })
            }
          }
        }
      }
    } catch (_) { /* fall through */ }
  }
  return { name, phases }
}

function normalizePhaseStatus(s) {
  if (s === 'running' || s === 'done' || s === 'failed') return s
  return 'pending'
}

// -- background tasks --------------------------------------------------------

/**
 * Pure reducer for the background-task panel. Consumes tool/call and
 * tool/result events for the task_* family and returns a new state (immutable
 * update semantics: never mutates the input). State shape:
 *   { tasks: Map<taskId, TaskEntry> }
 * TaskEntry:
 *   { id, status: 'pending'|'running'|'done'|'failed'|'killed', name, summary, lastUpdate }
 *
 * The three tools exercise the reducer differently:
 *   - task_output: reads current output — updates `summary` + `lastUpdate`
 *   - task_list  : lists all tasks — bulk upserts entries
 *   - task_kill  : requests kill — flips to 'killed' on ok result
 *
 * We identify tasks by their `taskId` in args (task_output/task_kill) or by
 * the list rows returned in content (task_list). If neither is present, the
 * event is a no-op — a foreign tool won't accidentally clutter the panel.
 *
 * @param {{ tasks: Map }} state
 * @param {{ toolName: string, callId?: string, args?: string, content?: unknown, isError?: boolean, phase: 'call'|'result' }} event
 * @returns {{ tasks: Map }} — new Map (structural share of entries is fine)
 */
function updateBackgroundTasks(state, event) {
  const prev = (state && state.tasks instanceof Map) ? state.tasks : new Map()
  const tasks = new Map(prev)
  const nowIso = event && event.time ? String(event.time) : new Date().toISOString()

  if (!event || typeof event.toolName !== 'string') return { tasks }
  const family = classifyTaskTool(event.toolName)
  if (!family) return { tasks }

  const parsedArgs = safeParseJson(event.args)
  const taskId = parsedArgs && typeof parsedArgs.taskId === 'string'
    ? parsedArgs.taskId
    : parsedArgs && typeof parsedArgs.id === 'string'
      ? parsedArgs.id
      : null

  if (event.phase === 'call') {
    if (taskId) {
      const existing = tasks.get(taskId) || { id: taskId, status: 'pending', name: '', summary: '', lastUpdate: nowIso }
      const nextStatus = family === 'kill' ? 'killed' : 'running'
      tasks.set(taskId, { ...existing, status: nextStatus, lastUpdate: nowIso })
    }
    return { tasks }
  }

  // phase === 'result'
  if (event.isError) {
    if (taskId) {
      const existing = tasks.get(taskId) || { id: taskId, name: '', summary: '', lastUpdate: nowIso }
      tasks.set(taskId, { ...existing, id: taskId, status: 'failed', summary: shortSummary(joinTextBlocks(event.content)) || existing.summary || '', lastUpdate: nowIso })
    }
    return { tasks }
  }

  const bodyText = joinTextBlocks(event.content)

  if (family === 'list') {
    // Parse the list output — either JSON `{tasks:[{id,name,status,summary}]}`
    // or plain-text rows. Missing rows are DROPPED from state so a stale
    // entry doesn't linger; task_list is authoritative when it runs.
    const rows = parseTaskListBody(bodyText)
    if (rows) {
      const next = new Map()
      for (const r of rows) {
        const prevEntry = tasks.get(r.id)
        next.set(r.id, {
          id: r.id,
          name: r.name || (prevEntry && prevEntry.name) || '',
          status: r.status || (prevEntry && prevEntry.status) || 'pending',
          summary: r.summary || (prevEntry && prevEntry.summary) || '',
          lastUpdate: nowIso,
        })
      }
      return { tasks: next }
    }
    return { tasks }
  }

  if (family === 'output' && taskId) {
    const existing = tasks.get(taskId) || { id: taskId, name: '', status: 'running', summary: '', lastUpdate: nowIso }
    tasks.set(taskId, { ...existing, id: taskId, summary: shortSummary(bodyText), lastUpdate: nowIso })
    return { tasks }
  }

  if (family === 'kill' && taskId) {
    const existing = tasks.get(taskId) || { id: taskId, name: '', summary: '', lastUpdate: nowIso }
    tasks.set(taskId, { ...existing, id: taskId, status: 'killed', lastUpdate: nowIso })
    return { tasks }
  }

  return { tasks }
}

function classifyTaskTool(name) {
  if (name === 'task_output') return 'output'
  if (name === 'task_list') return 'list'
  if (name === 'task_kill') return 'kill'
  return null
}

function parseTaskListBody(text) {
  if (!text) return []
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed && parsed.tasks)
          ? parsed.tasks
          : null
      if (!list) return null
      const rows = []
      for (const row of list) {
        if (!row || typeof row !== 'object') continue
        const id = typeof row.id === 'string' ? row.id : typeof row.taskId === 'string' ? row.taskId : null
        if (!id) continue
        rows.push({
          id,
          name: typeof row.name === 'string' ? row.name : '',
          status: typeof row.status === 'string' ? row.status : '',
          summary: typeof row.summary === 'string' ? row.summary : '',
        })
      }
      return rows
    } catch (_) { return null }
  }
  return null
}

function shortSummary(text) {
  if (typeof text !== 'string') return ''
  const trimmed = text.trim()
  if (trimmed.length <= 200) return trimmed
  return trimmed.slice(0, 197) + '…'
}

// -- session split (resume) --------------------------------------------------

/**
 * Split a `session/list` result into live sessions (already attached to an
 * agent) and history sessions (persisted, not currently live — candidates for
 * session/resume). The persistence/liveness discriminant is `entry.live`.
 * `entry.persisted` is a secondary signal — a session that is both live=false
 * AND persisted=true is a resume target; live=false && persisted=false is a
 * stale ghost that should not appear (defensive drop).
 *
 * Sibling grouping (live vs history) is orthogonal to the fork tree — a
 * history session may still have parent/child links, but the tree layer
 * handles those independently.
 *
 * @param {Array} entries
 * @returns {{ live: Array, history: Array }}
 */
function splitSessionsByLive(entries) {
  const live = []
  const history = []
  if (!Array.isArray(entries)) return { live, history }
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue
    if (e.live === false && e.persisted === true) history.push(e)
    else if (e.live === false && e.persisted === false) continue
    else live.push(e)
  }
  return { live, history }
}

// -- history row derivations ( HISTORY noise collapse) ----------------

/**
 * Produce a human-friendly title + a "was-placeholder" flag for a session-list
 * entry. Real user prompts win; smoke fixtures (title === `(smoke-…)` or the
 * `(shortId)` fallback the renderer used to emit) render as `Untitled · <rel>`
 * with the italic muted styling from CSS. Pure so the test suite can pin
 * every case.
 *
 * C-P1-6: originally rendered as `未命名 · <rel>` — the demo audience is the
 * internal group, and the rest of the shell is English, so keep this English
 * too. The Chinese variant is preserved in git for the day we do proper i18n.
 *
 * @param {object} entry — a session/list row (title? / sessionId / lastEventTime?)
 * @param {number} nowMs — current epoch ms; injected for test determinism
 * @returns {{ text: string, isUntitled: boolean }}
 */
function smartSessionTitle(entry, nowMs) {
  const raw = entry && typeof entry.title === 'string' ? entry.title.trim() : ''
  if (raw && !looksLikePlaceholderTitle(raw, entry && entry.sessionId)) {
    return { text: raw, isUntitled: false }
  }
  const rel = relativeTime(entry && entry.lastEventTime, nowMs)
  const suffix = rel ? ` · ${rel}` : ''
  return { text: `Untitled${suffix}`, isUntitled: true }
}

function looksLikePlaceholderTitle(t, sessionId) {
  // The old renderer fallback wrapped the short id in parens: `(abcdef12)`.
  // Smoke fixtures ship as `(smoke-…)` / `smoke-…`. Both should read as
  // "Untitled" rather than technical noise in the sidebar.
  if (/^smoke-/i.test(t)) return true
  if (/^\(smoke-/i.test(t)) return true
  if (/^\([0-9a-f]{4,16}\)$/i.test(t)) return true
  if (typeof sessionId === 'string' && t === `(${sessionId.slice(0, 8)})`) return true
  return false
}

/**
 * Relative-time renderer for session-list rows.
 * "just now / N min ago / N h ago / N d ago / N w ago / N mo ago / N y ago".
 * English to match the rest of the demo copy; when we do i18n proper we can
 * swap the locale table.
 *
 * @param {number|undefined|null} whenMs — epoch ms; null/undefined → ''
 * @param {number} nowMs
 */
function relativeTime(whenMs, nowMs) {
  if (typeof whenMs !== 'number' || !Number.isFinite(whenMs) || whenMs <= 0) return ''
  const now = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now()
  const diff = Math.max(0, now - whenMs)
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} min ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day} d ago`
  const wk = Math.floor(day / 7)
  if (wk < 5) return `${wk} w ago`
  const mo = Math.floor(day / 30)
  if (mo < 12) return `${mo} mo ago`
  const yr = Math.floor(day / 365)
  return `${yr} y ago`
}

// -- unified "Recent" list (SESSIONS + HISTORY merger) ----------------------

/**
 * Merge live and persisted-only entries into a single recency-sorted list.
 * The IA-level intent: the sidebar shows *sessions*, not "kinds of sessions".
 * Liveness/persistence stay as per-row state (a green dot for a running live
 * session, a resume affordance for a persisted-only one), never as a
 * grouping label the user has to read.
 *
 * `activeSessionId` gets a small tiebreaker bonus so a freshly-selected but
 * as-yet-empty session still lands at the top of the list.
 *
 * Empty sessions (no user message ever sent) are filtered out so the "+"
 * button doesn't strew placeholder rows across the sidebar. The controller
 * decides what counts as empty via `hasUserMessage` (a live-tracked bit on
 * per-session meta) and passes it in on the entry.
 *
 * @param {Array<{sessionId:string, title?:string, running?:boolean, live?:boolean, persisted?:boolean, lastEventTime?:number, hasUserMessage?:boolean}>} entries
 * @param {{activeSessionId?: string|null}} [opts]
 * @returns {Array} — sorted, filtered entry rows
 */
function mergeRecentSessions(entries, opts = {}) {
  if (!Array.isArray(entries)) return []
  const activeId = opts && opts.activeSessionId ? opts.activeSessionId : null
  const rows = filterEmptySessions(entries, { activeSessionId: activeId })
  rows.sort((a, b) => {
    const aT = (a.lastEventTime || 0) + (a.sessionId === activeId ? 1 : 0)
    const bT = (b.lastEventTime || 0) + (b.sessionId === activeId ? 1 : 0)
    return bT - aT
  })
  return rows
}

/**
 * Filter empty / stale sessions from a `session/list` entry array. Shared by
 * every surface that shows a session list (the sidebar Recent list, Mission
 * Control's three projections, Quick Chat, Growth) so a fresh "+" click can't
 * spawn ghost rows in one place while another shows a clean list. Extracted
 * from mergeRecentSessions so all consumers share the same predicate.
 *
 * Rules:
 *   - Drop stale ghosts: `live === false && persisted === false`. Same rule
 *     splitSessionsByLive applies — these are historical fragments the daemon
 *     still remembers but nothing on either side owns.
 *   - Drop empty sessions (`hasUserMessage === false`) UNLESS the sessionId
 *     matches `opts.activeSessionId` — the just-created "+" session must
 *     stay visible so the user sees where they landed before they've typed.
 *   - `hasUserMessage === undefined` is treated as "we don't know" — with one
 *     escape hatch: if the entry also carries `eventCount === 0` (typical for
 *     persistent smoke-* rows the daemon still remembers but never received
 *     a turn on), drop it. This closes the hole where Mission /
 *     Growth read session/list entries + chat-side sessions Map projections
 *     that never carried `hasUserMessage` at all, so the filter was a no-op.
 *     Callers can still raw-enrich (see renderer.js enrichEntry) if they
 *     want the strictest filter that keeps unknown-and-unknown rows.
 *
 * @param {Array<{sessionId?:string, live?:boolean, persisted?:boolean, hasUserMessage?:boolean, eventCount?:number}>} entries
 * @param {{activeSessionId?: string|null}} [opts]
 * @returns {Array}
 */
function filterEmptySessions(entries, opts = {}) {
  if (!Array.isArray(entries)) return []
  const activeId = opts && opts.activeSessionId ? opts.activeSessionId : null
  const rows = []
  for (const e of entries) {
    if (!e || typeof e !== 'object' || typeof e.sessionId !== 'string') continue
    if (e.live === false && e.persisted === false) continue
    if (e.sessionId === activeId) { rows.push(e); continue }
    if (e.hasUserMessage === false) continue
    // Unknown flag + zero events = same as "no user message". Persistent
    // smoke-* rows land here (session/list ships them without the bit),
    // so this is what actually filters them out in the real app.
    if (e.hasUserMessage === undefined && e.eventCount === 0) continue
    rows.push(e)
  }
  return rows
}

/**
 * Find an existing empty live session that the "+" button should reuse
 * instead of minting a new one. "Empty" = live, not-running, no user message
 * yet. Returns the sessionId or null.
 *
 * @param {Array} entries
 * @returns {string|null}
 */
function findReusableEmptySession(entries) {
  if (!Array.isArray(entries)) return null
  // Prefer the most-recent one (rare to have >1, but be deterministic).
  const candidates = []
  for (const e of entries) {
    if (!e || typeof e !== 'object' || typeof e.sessionId !== 'string') continue
    if (e.live === false) continue
    if (e.running === true) continue
    if (e.hasUserMessage !== false) continue
    candidates.push(e)
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => (b.lastEventTime || 0) - (a.lastEventTime || 0))
  return candidates[0].sessionId
}

// -- helpers -----------------------------------------------------------------

/** Join `tool/result.content` (array of `{type:'text', text}` blocks) into a
 * single string. Non-text blocks are skipped. Returns '' for anything shaped
 * unexpectedly (including `null`/`undefined`). */
function joinTextBlocks(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const b of content) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    else if (typeof b.text === 'string' && !b.type) parts.push(b.text)
  }
  return parts.join('\n')
}

function safeParseJson(s) {
  if (typeof s !== 'string' || s === '') return null
  try { return JSON.parse(s) } catch (_) { return null }
}

// -- exports -----------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    foldWebSearchResults,
    isSafeExternalUrl,
    foldSkillLoad,
    foldWorkflowCall,
    updateBackgroundTasks,
    splitSessionsByLive,
    smartSessionTitle,
    relativeTime,
    mergeRecentSessions,
    filterEmptySessions,
    findReusableEmptySession,
    // exposed for tests + controller reuse
    joinTextBlocks,
    classifyTaskTool,
    parseTaskListBody,
    shortSummary,
    looksLikePlaceholderTitle,
  }
}
if (typeof window !== 'undefined') {
  window.__dshPanelsC = {
    foldWebSearchResults,
    isSafeExternalUrl,
    foldSkillLoad,
    foldWorkflowCall,
    updateBackgroundTasks,
    splitSessionsByLive,
    smartSessionTitle,
    relativeTime,
    mergeRecentSessions,
    filterEmptySessions,
    findReusableEmptySession,
    joinTextBlocks,
  }
}
