// Tri-view node-detail pane (LangSmith run-detail grammar).
//
// Pure module: renders a right-side panel with four LangSmith run-detail
// sections — Feedback, Input, Output, Attributes — for a node selected
// in any of the three views (span tree row / Gantt bar / graph node).
//
//   - Sections are a single scrollable document; the tab row above is an
//     anchor bar (click = scroll-to + highlight active).  Each section is
//     independently collapsible via a `<details open>` wrapper.
//   - Feedback empty state = dashed `+ Add feedback` inline button (opens
//     `__dshAnnotation.open(sessionId)`) instead of a text-only note.
//   - Input/Output sections gain a right-side "Render" dropdown
//     (Markdown / Plain / JSON) — Markdown/Plain differ only in wrapping;
//     JSON dumps the underlying wire event(s) as a `<pre>` block.
//   - Output wraps its rows in a Fields card: `{ } Fields` title, right-
//     side Expand-all + Copy buttons; each row is a `<details>` block with
//     per-block `{ }` (raw JSON) + copy affordances.
//   - Attributes rows split into three collapsible groups — Model, Usage,
//     Runtime — instead of one flat 10-row table.  URL-shaped values in
//     the Runtime group render as `<a target=_blank>` with a `↗` suffix.
//   - Header carries `ID <chip> ⧉` (click = copy the sessionId) plus a
//     top-level `Messages | Details` two-state switch (Messages = deep-
//     link back to the conversation stream via `__dshDeepLinkToSeq`).
//
// Data sources (zero-drop rule — missing fields render as `absent`):
//   Feedback   → window.__dshAnnotation.read(sessionId) + document
//                'dsh:annotation-updated' event listener.  Never touches
//                _state or localStorage.  Empty state opens the annotate
//                pane via __dshAnnotation.open(sessionId).
//   Input      → the step's messagePrefix + config (via aggregator's
//                headerConfigFields over the trace record's inbound
//                header), plus the step's `inputs` array (user/tool/
//                context events consumed by this step).  Each row has a
//                `{ }` badge to L2.
//   Output     → step's `outputs` — assistant/message + tool/call rows,
//                each with role identity, tool_calls key-value rows,
//                arguments truncated + expandable to full JSON.
//   Attributes → wire metadata kv grouped as Model / Usage / Runtime.
//                `absent` markers preserve wire truth.
//
// All text carries `user-select: text` via a container class the CSS
// sheet respects (§7 baseline).  The pane is idempotent — buildDetailPane
// replaces the previous content so re-clicking updates the same host.
//
// Consumers pass `{ record, sessionId, title?, subtitle?, defaultTab?,
// onModeSwitch? }` where `record` is the step-record (from
// trace-aggregator) and `sessionId` scopes annotation lookup.
//
// Exposed as CommonJS + `window.__dshTraceDetailPane` for browser use.

'use strict'

;(function () {

// ---------- error detection ---------------------------------------------
//
// LangSmith's detail pane inserts a conditional `Error` tab at position 0
// when the run finished in error ( shot 11-broken-tool-detail: 5
// tabs, `Error / Feedback / Input / Output / Attributes`; §14.1 row 11).
// The error semantics for a DSH step are unified from three wire sources
// so we don't miss any of them:
//
//   1. `tool/result` events whose `data.isError` is truthy — the tool
//      loop bounced;
//   2. `error/*` events dispatched into the step (turn aborted, kernel
//      error, hook rejection) — surfaces as a first-class error row;
//   3. `assistant/message` events whose `data.finish_reason` reads as an
//      error condition (`error`, `content_policy_violation`, …) — the
//      model signalled failure without an explicit error event.
//
// Returns null when the step is clean; otherwise the shape the panel
// consumes: `{ name, message, events }`. `name` doubles as a header
// glyph label ("Tool error", "Turn aborted"); `message` is the human
// text that goes in the red banner; `events` links back into the step
// so the panel can render click-to-scroll refs into the Output tab.
function detectRecordError(rec) {
  if (!rec) return null
  const events = []
  let primaryName = null
  let primaryMessage = null
  let code = null
  const outputs = Array.isArray(rec.outputs) ? rec.outputs : []
  const allEvents = Array.isArray(rec.events) ? rec.events : []
  const scan = outputs.concat(allEvents)
  const seen = new Set()
  for (const ev of scan) {
    if (!ev || typeof ev !== 'object' || seen.has(ev)) continue
    seen.add(ev)
    const d = ev.data
    // (1) tool/result with isError=true.
    if (ev.type === 'tool/result' && d && d.isError) {
      events.push(ev)
      if (!primaryName) {
        primaryName = 'Tool error'
        primaryMessage = firstTextOrErrorMessage(d)
        code = d.error && (d.error.name || d.error.code) || null
      }
    }
    // (2) explicit error/* events (error, error/aborted, error/kernel, …).
    else if (typeof ev.type === 'string' && ev.type.startsWith('error')) {
      events.push(ev)
      if (!primaryName) {
        primaryName = ev.type === 'error' ? 'Error' : humanizeErrorType(ev.type)
        primaryMessage = (d && (d.message || d.reason || d.text)) || null
        code = (d && (d.name || d.code)) || null
      }
    }
    // (3) turn abort / step abort family (compat with earlier wire dialects).
    else if (ev.type === 'turn/aborted' || ev.type === 'step/aborted') {
      events.push(ev)
      if (!primaryName) {
        primaryName = ev.type === 'turn/aborted' ? 'Turn aborted' : 'Step aborted'
        primaryMessage = (d && (d.reason || d.message)) || null
      }
    }
    // (4) assistant/message with an error-flavoured finish_reason.
    else if (ev.type === 'assistant/message' && d && isErrorFinishReason(d.finish_reason || d.finishReason)) {
      events.push(ev)
      if (!primaryName) {
        primaryName = 'Model error'
        primaryMessage = 'finish_reason=' + String(d.finish_reason || d.finishReason)
        code = String(d.finish_reason || d.finishReason)
      }
    }
  }
  if (!events.length) return null
  return { name: primaryName || 'Error', message: primaryMessage || null, code, events }
}

function firstTextOrErrorMessage(d) {
  if (!d) return null
  if (Array.isArray(d.content)) {
    for (const b of d.content) {
      if (b && b.type === 'text' && typeof b.text === 'string' && b.text) return b.text
    }
  }
  if (d.error && typeof d.error.message === 'string' && d.error.message) return d.error.message
  if (typeof d.message === 'string' && d.message) return d.message
  return null
}
function humanizeErrorType(t) {
  const tail = String(t).split('/').slice(1).join(' ')
  return tail ? 'Error · ' + tail : 'Error'
}
function isErrorFinishReason(fr) {
  if (typeof fr !== 'string') return false
  const lo = fr.toLowerCase()
  return lo === 'error' || lo === 'content_policy_violation' || lo === 'content_filter' ||
    lo === 'refusal' || lo === 'failed' || lo === 'aborted'
}

// ---------- pure builders ------------------------------------------------

// Attributes = wire metadata table, always all keys, `absent` when missing.
// Reads the step record's inbound header event when present; falls back to
// scanning rec.events for a request/header. Preserves the shape teamlead
// enumerated (model/provider/usage 5-field/duration/finish_reason/tags).
//
// `sessionHeader` (optional) — the SessionHeader object from the shell's
// session meta. Used to surface
// `cwd` in the Runtime group; SessionHeader is not part of the trace record
// (which is per-step) so callers must thread it in. Field §3 P0 #5
// (2026-07-17): "这个 session 在哪跑的" — cwd is the researcher-critical
// answer and previously had no consumer point.
function attributesRows(rec, sessionHeader) {
  const win = typeof window !== 'undefined' ? window : null
  const out = []
  const header = pickHeaderFromRec(rec)
  const usage = win && win.__dshTraceAgg && win.__dshTraceAgg.sumUsageForStep
    ? win.__dshTraceAgg.sumUsageForStep(rec) : null
  out.push(['model',       stringOrAbsent(header && header.model)])
  out.push(['provider',    stringOrAbsent(header && header.provider)])
  out.push(['inputTokens',        numOrAbsent(usage && usage.inputTokens)])
  out.push(['outputTokens',       numOrAbsent(usage && usage.outputTokens)])
  out.push(['cacheReadTokens',    numOrAbsent(usage && usage.cacheReadTokens)])
  out.push(['cacheWriteTokens',   numOrAbsent(usage && usage.cacheWriteTokens)])
  out.push(['reasoningTokens',    numOrAbsent(usage && usage.reasoningTokens)])
  out.push(['durationMs',   numOrAbsent(rec && rec.durationMs)])
  out.push(['finish_reason', stringOrAbsent(pickFinishReason(rec))])
  out.push(['tags',         listOrAbsent(pickTags(rec))])
  // Field §3 P0 #5: session-level cwd. Absent when the header wasn't
  // threaded in (defensive default) or the session has no cwd on disk.
  out.push(['cwd',          stringOrAbsent(sessionHeader && sessionHeader.cwd)])
  // MCP source attribution as a first-class Runtime
  // row. Scan the record's events for tool names matching mcp__<server>__…
  // and surface the distinct servers as a comma-joined value. Absent when
  // this step touched no MCP tool — which is the common case, so we don't
  // print a hollow row. See src/renderer/mcp-tool-name.js for the parser.
  out.push(['mcp.server',   mcpServersOrAbsent(rec)])
  return out
}

function mcpServersOrAbsent(rec) {
  const win = typeof window !== 'undefined' ? window : null
  const glob = typeof globalThis !== 'undefined' ? globalThis : null
  const api = (win && win.__dshMcpToolName) || (glob && glob.__dshMcpToolName) || null
  if (!api || typeof api.collectMcpServers !== 'function') return { absent: true }
  const outputs = rec && Array.isArray(rec.events) ? rec.events : []
  const servers = api.collectMcpServers(outputs)
  if (!servers || servers.length === 0) return { absent: true }
  return servers.join(', ')
}

// Group attributes into LangSmith-style folders (Model / Usage / Runtime).
// The 10 attribute rows map into three semantic buckets that a researcher
// scans one at a time; keeping the underlying attributesRows() intact
// preserves the flat contract for callers/tests.
function attributesGroups(rec, sessionHeader) {
  const map = new Map(attributesRows(rec, sessionHeader))
  return [
    { key: 'model',   label: 'Model',   rows: pick(map, ['model', 'provider']) },
    { key: 'usage',   label: 'Usage',   rows: pick(map, ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'finish_reason']) },
    { key: 'runtime', label: 'Runtime', rows: pick(map, ['cwd', 'mcp.server', 'durationMs', 'tags']) },
  ]
}

function pick(map, keys) {
  const out = []
  for (const k of keys) if (map.has(k)) out.push([k, map.get(k)])
  return out
}

function pickHeaderFromRec(rec) {
  if (!rec) return null
  if (rec.header && typeof rec.header === 'object') return rec.header
  if (Array.isArray(rec.events)) {
    for (const ev of rec.events) {
      if (ev && ev.type === 'request/header' && ev.data && typeof ev.data === 'object') {
        return ev.data['header'] || ev.data
      }
    }
  }
  return null
}

function pickFinishReason(rec) {
  if (!rec || !Array.isArray(rec.events)) return null
  for (const ev of rec.events) {
    if (ev && ev.type === 'assistant/message' && ev.data && typeof ev.data === 'object') {
      const fr = ev.data['finish_reason'] || ev.data['finishReason']
      if (fr) return fr
    }
  }
  return null
}

function pickTags(rec) {
  if (!rec) return null
  const header = pickHeaderFromRec(rec)
  if (header && Array.isArray(header['tags'])) return header['tags']
  return null
}

function stringOrAbsent(v) { return (typeof v === 'string' && v) ? v : { absent: true } }
function numOrAbsent(v)    { return Number.isFinite(v) ? v : { absent: true } }
function listOrAbsent(v)   { return Array.isArray(v) && v.length ? v : { absent: true } }

// Output rows = one row per emitted message/tool-call, key-value list.
// Preserves the (role, content-preview, tool_calls array) shape the
// team-lead requested. arguments serialized when short; else truncated
// with a `{ }` link to L2.
function outputRows(rec) {
  const rows = []
  if (!rec || !Array.isArray(rec.outputs)) return rows
  for (const ev of rec.outputs) {
    if (!ev || !ev.data) continue
    if (ev.type === 'assistant/message') {
      rows.push({
        kind: 'message',
        role: 'assistant',
        text: pickAssistantText(ev),
        toolCalls: pickToolCallsFromAssistant(ev),
        raw: ev,
      })
    } else if (ev.type === 'tool/call') {
      rows.push({
        kind: 'tool-call',
        role: 'tool',
        callId: ev.data.callId || null,
        name: ev.data.tool || ev.data.name || '(unnamed)',
        args: ev.data.arguments,
        raw: ev,
      })
    } else if (ev.type === 'tool/result') {
      // Batch C (team-lead 2026-07-17): tool result content is one of the
      // three surfaces the user's LangSmith screenshots show drilling into
      // recursively (raw response also, and assistant/message content
      // beyond `.text`). Emit it as its own Output row so the Fields card
      // can carry the full ContentBlock[] payload — text + image + tool
      // diagnostics + isError — through buildRawFieldsSubtree.
      rows.push({
        kind: 'tool-result',
        role: 'tool',
        callId: ev.data.callId || null,
        content: Array.isArray(ev.data.content) ? ev.data.content : null,
        isError: !!ev.data.isError,
        raw: ev,
      })
    }
  }
  return rows
}

function pickAssistantText(ev) {
  if (!ev || !ev.data || !Array.isArray(ev.data.content)) return null
  for (const block of ev.data.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') return block.text
  }
  return null
}

function pickToolCallsFromAssistant(ev) {
  if (!ev || !ev.data || !Array.isArray(ev.data.content)) return []
  const out = []
  for (const block of ev.data.content) {
    if (block && block.type === 'tool_use') {
      out.push({ id: block.id || null, name: block.name || null, args: block.input || null })
    }
  }
  return out
}

// Input rows = messagePrefix + header config.
function inputRows(rec) {
  const messages = Array.isArray(rec && rec.inputs) ? rec.inputs : []
  const header = pickHeaderFromRec(rec)
  const agg = typeof window !== 'undefined' ? window.__dshTraceAgg : null
  const config = agg && agg.headerConfigFields && header ? agg.headerConfigFields(header) : []
  return { messages, config }
}

// Feedback: LangSmith-style rows shaped from __dshAnnotation.read(sessionId).
// Turn scope: uses `turnScores[]` (dims + note + annotator + updatedAt).
// Session scope: `overall` + `notes` + `updatedAt`.
function feedbackRows(sessionId, api) {
  if (!api || typeof api.read !== 'function') return { available: false, rows: [] }
  let ann = null
  try { ann = api.read(sessionId) } catch (_) { ann = null }
  if (!ann) return { available: true, rows: [], sessionId }
  const rows = []
  if (Array.isArray(ann.turnScores)) {
    for (const t of ann.turnScores) {
      if (!t || typeof t !== 'object') continue
      rows.push({
        scope: 'turn',
        turn: t.turn,
        dims: t.dims || null,
        note: t.note || null,
        annotator: t.annotator || 'local-user',
        time: t.updatedAt || null,
      })
    }
  }
  if (ann.overall) {
    rows.push({
      scope: 'session',
      overall: ann.overall,
      note: ann.notes || null,
      annotator: ann.annotator || 'local-user',
      time: ann.updatedAt || null,
    })
  }
  return { available: true, rows, sessionId }
}

// ---------- DOM builder --------------------------------------------------

const TAB_ORDER = ['feedback', 'input', 'output', 'attributes']
const TAB_LABELS = {
  error: 'Error',
  feedback: 'Feedback',
  input: 'Input',
  output: 'Output',
  attributes: 'Attributes',
  reasoning: 'Reasoning',
}

// Dynamic tab list: on an error run the Error tab is prepended and reads
// pre-selected (LangSmith parity, shot 11 — error-first grammar).
// When the record carries reasoning content, a Reasoning tab is appended
// at the tail. Clean runs without reasoning keep the 4-tab layout.
// `errorInfo` = `detectRecordError(rec)`; `reasoning` = `reasoningRows(rec)`;
// either may be null.
function resolveTabOrder(errorInfo, reasoning) {
  const base = TAB_ORDER.slice()
  // Reasoning appends at the tail — the clickability batch's original
  // placement, locked by its behaviour test (5th tab on reasoning records).
  if (reasoning) base.push('reasoning')
  return errorInfo ? ['error'].concat(base) : base
}

// Clickability audit + §4 differentiator fill (2026-07-17): assemble the
// step's reasoning surface — a concatenation of `assistant/chunk`
// reasoning-delta text with a fallback to `assistant/message.content[type=
// 'reasoning'].text`. Returns `{ text, deltaCount, reasoningTokens }` or
// null when the record has no reasoning. The pane hides the Reasoning tab
// entirely when null (same conditional grammar as's Error
// tab — auditor's request in §4.4).
function reasoningRows(rec) {
  if (!rec) return null
  let text = ''
  let deltaCount = 0
  let reasoningTokens = null
  const walk = function (list) {
    if (!Array.isArray(list)) return
    for (const ev of list) {
      if (!ev || !ev.data) continue
      if (ev.type === 'assistant/chunk') {
        const chunk = (ev.data && ev.data.chunk) || ev.chunk
        if (chunk && chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
          text += chunk.text
          deltaCount += 1
        }
      } else if (ev.type === 'assistant/message' && Array.isArray(ev.data.content)) {
        for (const block of ev.data.content) {
          if (block && block.type === 'reasoning' && typeof block.text === 'string') {
            // Prefer content-block payload when present (it's the final
            // definitive rollup); still count the streamed deltas as a
            // separate "delta events" number so the reader sees both.
            if (!text) text = block.text
          }
        }
      }
    }
  }
  walk(rec.events)
  walk(rec.outputs)
  // reasoningTokens can live on any assistant/message.usage in the record.
  const usageWalk = function (list) {
    if (!Array.isArray(list)) return
    for (const ev of list) {
      if (ev && ev.type === 'assistant/message' && ev.data && ev.data.usage
          && typeof ev.data.usage.reasoningTokens === 'number') {
        reasoningTokens = ev.data.usage.reasoningTokens
        return
      }
    }
  }
  usageWalk(rec.events)
  usageWalk(rec.outputs)
  if (!text && deltaCount === 0 && !Number.isFinite(reasoningTokens)) return null
  return { text: text || '', deltaCount, reasoningTokens }
}

function buildDetailPane(doc, spec) {
  if (!doc) return null
  spec = spec || {}
  const host = doc.createElement('div')
  host.className = 'trace-detail-pane'
  host.setAttribute('role', 'region')
  host.setAttribute('aria-label', 'Trace node detail')

  // Detect an error condition on the underlying step record; when present
  // the tab layout inserts an `Error` tab at position 0 (pre-selected) so
  // the researcher lands on the failure banner without an extra click.
  // Reasoning: when the record carries reasoning-delta text or a positive
  // reasoningTokens counter, insert a `Reasoning` tab after Feedback
  // (differentiator surface — upstreams bury this).
  const errorInfo = detectRecordError(spec.record || null)
  const reasoning = reasoningRows(spec.record || null)
  const tabOrder = resolveTabOrder(errorInfo, reasoning)
  if (errorInfo) host.classList.add('has-error')

  // ─── Header: title / subtitle / ID copy chip / Messages·Details switch ─
  const head = buildHeader(doc, spec)
  host.appendChild(head)

  // ─── Anchor-tab bar (2026-07-17: click = scroll into section) ─────────
  const tabRow = doc.createElement('div')
  tabRow.className = 'trace-detail-tabs'
  tabRow.setAttribute('role', 'tablist')
  const sectionEls = {}
  const buttonsByTab = {}
  for (const tab of tabOrder) {
    const btn = doc.createElement('button')
    btn.type = 'button'
    btn.className = 'trace-detail-tab'
    if (tab === 'error') btn.classList.add('is-error')
    btn.textContent = TAB_LABELS[tab]
    btn.dataset.tab = tab
    btn.setAttribute('role', 'tab')
    btn.setAttribute('aria-selected', 'false')
    tabRow.appendChild(btn)
    buttonsByTab[tab] = btn
  }
  host.appendChild(tabRow)

  // ─── Section list (one scrollable document, four collapsible sections) ─
  const sections = doc.createElement('div')
  sections.className = 'trace-detail-sections'
  for (const tab of tabOrder) {
    const sec = buildSection(doc, tab, spec, { errorInfo, reasoning })
    sections.appendChild(sec.wrap)
    sectionEls[tab] = sec
  }
  host.appendChild(sections)

  function activate(tab) {
    for (const t of tabOrder) {
      const active = t === tab
      buttonsByTab[t].classList.toggle('active', active)
      buttonsByTab[t].setAttribute('aria-selected', active ? 'true' : 'false')
    }
    const target = sectionEls[tab] && sectionEls[tab].wrap
    if (target) {
      try { target.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
      catch (_) { if (typeof target.scrollIntoView === 'function') target.scrollIntoView() }
      target.open = true
    }
  }
  for (const tab of tabOrder) {
    buttonsByTab[tab].addEventListener('click', () => activate(tab))
  }
  // Error runs land on the Error tab (pre-selected); clean runs default to
  // Output.  The caller can still override via `spec.defaultTab`.
  const initial = spec.defaultTab || (errorInfo ? 'error' : 'output')
  activate(tabOrder.includes(initial) ? initial : tabOrder[0])

  // Live re-render when annotation updates land — cheap because we only
  // rebuild the feedback panel content, not the whole pane. Event dispatches
  // on `document` per the __dshAnnotation contract (team-lead 2026-07-17).
  const evtTarget = typeof document !== 'undefined' && typeof document.addEventListener === 'function'
    ? document
    : (typeof window !== 'undefined' && typeof window.addEventListener === 'function' ? window : null)
  if (evtTarget) {
    const listener = (evt) => {
      if (!spec.sessionId) return
      const detail = evt && evt.detail
      if (detail && detail.sessionId && detail.sessionId !== spec.sessionId) return
      const body = sectionEls.feedback && sectionEls.feedback.body
      if (body) {
        while (body.firstChild) body.removeChild(body.firstChild)
        buildFeedbackPanel(doc, body, spec)
      }
    }
    evtTarget.addEventListener('dsh:annotation-updated', listener)
    host._detailPaneListener = listener
    host._detailPaneListenerTarget = evtTarget
  }
  return host
}

// ---- Header (ID chip + Messages/Details switch) -------------------------
function buildHeader(doc, spec) {
  const header = doc.createElement('div')
  header.className = 'trace-detail-head'
  const titleRow = doc.createElement('div')
  titleRow.className = 'trace-detail-title-row'
  const title = doc.createElement('div')
  title.className = 'trace-detail-title'
  title.textContent = spec.title || 'Detail'
  titleRow.appendChild(title)
  // ID chip — clicking copies the sessionId (or the record's start-seq
  // when no sessionId is provided) so a researcher can paste it into a
  // devtools filter/bench log.  The chip stays even when the underlying
  // value is absent, marked so the reader knows the wire had nothing.
  const idChip = buildIdChip(doc, spec)
  if (idChip) titleRow.appendChild(idChip)
  // Messages ⇄ Details top-level switch.  Details = this pane; Messages =
  // scroll the stream to the deep-linked seq (existing helper).  Both
  // segments render so the pattern reads as a switch, not a stray link.
  const modeSwitch = buildModeSwitch(doc, spec)
  if (modeSwitch) titleRow.appendChild(modeSwitch)
  header.appendChild(titleRow)
  if (spec.subtitle) {
    const subtitle = doc.createElement('div')
    subtitle.className = 'trace-detail-subtitle muted'
    subtitle.textContent = spec.subtitle
    header.appendChild(subtitle)
  }
  return header
}

function buildIdChip(doc, spec) {
  const id = spec.sessionId || (spec.record && Number.isFinite(spec.record.startSeq)
    ? 'seq:' + spec.record.startSeq
    : null)
  const chip = doc.createElement('button')
  chip.type = 'button'
  chip.className = 'trace-detail-id-chip'
  chip.title = id ? `Copy ID (${id})` : 'No ID available on this record'
  const label = doc.createElement('span')
  label.className = 'trace-detail-id-label'
  label.textContent = 'ID'
  const value = doc.createElement('span')
  value.className = 'trace-detail-id-value mono'
  if (id) {
    value.textContent = shortenId(id)
  } else {
    value.textContent = 'absent'
    chip.classList.add('absent')
  }
  const copy = doc.createElement('span')
  copy.className = 'trace-detail-id-copy'
  copy.textContent = '⧉' // ⧉ typographic "copy"
  chip.appendChild(label); chip.appendChild(value); chip.appendChild(copy)
  chip.addEventListener('click', function (e) {
    if (e && e.preventDefault) e.preventDefault()
    if (!id) return
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(id).catch(function () {})
      }
    } catch (_) { /* clipboard is best-effort */ }
    chip.classList.add('copied')
    if (typeof setTimeout === 'function') setTimeout(function () { chip.classList.remove('copied') }, 900)
  })
  return chip
}

function shortenId(id) {
  if (typeof id !== 'string') return String(id)
  if (id.length <= 12) return id
  return id.slice(0, 6) + '…' + id.slice(-4)
}

function buildModeSwitch(doc, spec) {
  const wrap = doc.createElement('div')
  wrap.className = 'trace-detail-mode-switch'
  wrap.setAttribute('role', 'group')
  const msgs = doc.createElement('button')
  msgs.type = 'button'
  msgs.className = 'trace-detail-mode-seg'
  msgs.dataset.mode = 'messages'
  msgs.textContent = 'Messages'
  msgs.title = 'Jump back to the conversation stream'
  const detail = doc.createElement('button')
  detail.type = 'button'
  detail.className = 'trace-detail-mode-seg active'
  detail.dataset.mode = 'details'
  detail.textContent = 'Details'
  detail.setAttribute('aria-pressed', 'true')
  wrap.appendChild(msgs); wrap.appendChild(detail)
  msgs.addEventListener('click', function () {
    if (typeof spec.onModeSwitch === 'function') {
      try { spec.onModeSwitch('messages', spec) } catch (_) { /* opener may not exist yet */ }
      return
    }
    // Fallback: deep-link back to the stream at the record's start-seq.
    const target = spec.record && Number.isFinite(spec.record.startSeq)
      ? spec.record.startSeq : null
    if (target === null) return
    if (typeof window !== 'undefined' && typeof window.__dshDeepLinkToSeq === 'function') {
      try { window.__dshDeepLinkToSeq(target) } catch (_) { /* deep-link is optional */ }
    }
  })
  return wrap
}

// ---- Section wrapper (header + optional right-controls + body) ---------
function buildSection(doc, tab, spec, extras) {
  extras = extras || {}
  const errorInfo = extras.errorInfo || null
  const wrap = doc.createElement('details')
  wrap.open = true
  wrap.className = `trace-detail-section section-${tab}`
  wrap.dataset.tab = tab
  const summary = doc.createElement('summary')
  summary.className = 'trace-detail-section-head'
  const label = doc.createElement('span')
  label.className = 'trace-detail-section-label'
  label.textContent = TAB_LABELS[tab]
  summary.appendChild(label)
  const controls = doc.createElement('span')
  controls.className = 'trace-detail-section-controls'
  summary.appendChild(controls)
  wrap.appendChild(summary)
  const body = doc.createElement('div')
  body.className = `trace-detail-panel panel-${tab}`
  body.dataset.tab = tab
  body.setAttribute('role', 'tabpanel')
  wrap.appendChild(body)
  // Populate body + section controls per tab.
  if (tab === 'error')            buildErrorPanel(doc, body, errorInfo, spec, controls)
  else if (tab === 'attributes')  buildAttributesPanel(doc, body, spec.record || null, spec.sessionHeader || null)
  else if (tab === 'input')       buildRenderModePanel(doc, body, controls, 'input', spec)
  else if (tab === 'output')      buildRenderModePanel(doc, body, controls, 'output', spec)
  else if (tab === 'feedback')    buildFeedbackPanel(doc, body, spec, controls)
  else if (tab === 'reasoning')   buildReasoningPanel(doc, body, controls, extras.reasoning)
  return { wrap, body, summary, controls }
}

// ---- Error panel --------------------------------------------------------
//
// LangSmith shot 12 lays this out as a red-outlined banner (`!`
// glyph + `Error <Name>('<msg>') Traceback…`) with copy + expand, followed
// by references to the events that carried the error.  Our step doesn't
// ship Python tracebacks, so we render:
//
//   1. Banner: red border, `!` glyph, `errorInfo.name` + `errorInfo.code`
//      (from tool/result `error.name` / assistant/message `finish_reason`
//      / error/* `data.name`), + Copy button on the message text.
//   2. `errorInfo.message` (multi-line, wire text — the two fields the
//      parity-gap matrix flagged as "染红只显文本" today).
//   3. A row list of the events that raised the error; each row is a
//      `<button>` that scrolls the Output section down to the matching
//      row (uses `data-seq` deep-link on the surrounding stream when the
//      pane's not in a session with `__dshDeepLinkToSeq`).
//   4. Raw error object at L2 (`{ }` badge → tool-cards JSON drawer).
function buildErrorPanel(doc, host, errorInfo, spec, controls) {
  if (!errorInfo) {
    // Defensive branch — never rendered in practice, but keep the panel
    // shape stable so a caller passing an empty errorInfo doesn't crash.
    const empty = doc.createElement('div')
    empty.className = 'trace-detail-empty muted'
    empty.textContent = 'No error on this record.'
    host.appendChild(empty)
    return
  }
  const banner = doc.createElement('div')
  banner.className = 'trace-detail-error-banner'
  banner.setAttribute('role', 'alert')
  const glyph = doc.createElement('span')
  glyph.className = 'trace-detail-error-glyph mono'
  glyph.textContent = '!'
  banner.appendChild(glyph)
  const head = doc.createElement('div')
  head.className = 'trace-detail-error-head'
  const name = doc.createElement('span')
  name.className = 'trace-detail-error-name mono'
  name.textContent = errorInfo.name || 'Error'
  head.appendChild(name)
  if (errorInfo.code) {
    const code = doc.createElement('span')
    code.className = 'trace-detail-error-code mono muted'
    code.textContent = '· ' + String(errorInfo.code)
    head.appendChild(code)
  }
  banner.appendChild(head)
  if (errorInfo.message) {
    const msg = doc.createElement('div')
    msg.className = 'trace-detail-error-message'
    msg.textContent = errorInfo.message
    banner.appendChild(msg)
  } else {
    const msg = doc.createElement('div')
    msg.className = 'trace-detail-error-message muted'
    msg.textContent = 'Wire event flagged an error but no text message was attached.'
    banner.appendChild(msg)
  }
  host.appendChild(banner)

  // Copy button lives in the section controls when available (top-right
  // of the Error section header), so the banner stays a clean text block.
  const copyTarget = errorInfo.message || (errorInfo.name || 'Error')
  const copyBtn = doc.createElement('button')
  copyBtn.type = 'button'
  copyBtn.className = 'ghost small trace-detail-error-copy'
  copyBtn.textContent = 'Copy'
  copyBtn.title = 'Copy the error message'
  copyBtn.addEventListener('click', function (e) {
    if (e && e.stopPropagation) e.stopPropagation()
    if (e && e.preventDefault) e.preventDefault()
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(String(copyTarget)).catch(function () {})
      }
    } catch (_) { /* clipboard is best-effort */ }
  })
  if (controls) controls.appendChild(copyBtn)

  // Related events row list — each entry deep-links back to the event
  // row in the stream (or in the Output section anchor).
  if (Array.isArray(errorInfo.events) && errorInfo.events.length) {
    const label = doc.createElement('div')
    label.className = 'trace-detail-subhead'
    label.textContent = 'raised on'
    host.appendChild(label)
    const list = doc.createElement('div')
    list.className = 'trace-detail-error-refs'
    for (const ev of errorInfo.events) {
      const ref = doc.createElement('button')
      ref.type = 'button'
      ref.className = 'trace-detail-error-ref mono'
      const seq = Number.isFinite(ev && ev.seq) ? ev.seq : null
      const label = (ev && ev.type) ? String(ev.type) : 'event'
      ref.textContent = seq !== null ? `${label} · seq ${seq}` : label
      ref.title = 'Jump to this event in the stream'
      ref.addEventListener('click', function () {
        if (seq === null) return
        if (typeof window !== 'undefined' && typeof window.__dshDeepLinkToSeq === 'function') {
          try { window.__dshDeepLinkToSeq(seq) } catch (_) {}
        }
      })
      list.appendChild(ref)
    }
    host.appendChild(list)
  }

  // Raw error object at L2 — first event that flagged the error goes to
  // the shared JSON drawer, matching how Output rows expose `{ }`.
  const primary = errorInfo.events && errorInfo.events[0]
  if (primary) {
    const raw = buildRawBadgeFor(doc, primary)
    if (raw) {
      const rawRow = doc.createElement('div')
      rawRow.className = 'trace-detail-error-raw-row'
      const lab = doc.createElement('span')
      lab.className = 'muted mono'
      lab.textContent = 'raw'
      rawRow.appendChild(lab)
      rawRow.appendChild(raw)
      host.appendChild(rawRow)
    }
  }
}

// ---- Reasoning tab (differentiator surface, 2026-07-17) ----------------
// Renders the step's reasoning content — the concatenated stream of
// reasoning-delta chunks plus a badge for reasoningTokens. §4.4 audit
// asked for this: current UI buries reasoning inside Attributes.usage +
// Output.content, which undersells the differentiator ("we visualize
// reasoning; upstreams don't"). The tab is only emitted when the record
// has reasoning content or a positive reasoningTokens counter.
function buildReasoningPanel(doc, host, controls, reasoning) {
  if (!reasoning) return
  // Section controls: reasoningTokens + delta count as chips so the reader
  // gets the quant summary without opening the body.
  if (controls) {
    if (Number.isFinite(reasoning.reasoningTokens) && reasoning.reasoningTokens > 0) {
      const chip = doc.createElement('span')
      chip.className = 'trace-detail-reasoning-chip mono small muted'
      chip.textContent = `reasoning ${reasoning.reasoningTokens} tok`
      chip.title = 'usage.reasoningTokens for this step'
      controls.appendChild(chip)
    }
    if (reasoning.deltaCount > 0) {
      const dchip = doc.createElement('span')
      dchip.className = 'trace-detail-reasoning-chip mono small muted'
      dchip.textContent = `${reasoning.deltaCount} delta${reasoning.deltaCount === 1 ? '' : 's'}`
      dchip.title = 'reasoning-delta chunks emitted during this step'
      controls.appendChild(dchip)
    }
  }
  if (!reasoning.text) {
    const empty = doc.createElement('div')
    empty.className = 'trace-detail-empty muted'
    // Token-only case: usage says reasoning ran, but the wire didn't ship
    // content (some upstreams zero-out reasoning text on redaction). Say
    // that plainly so the reader doesn't think the tab is broken.
    empty.textContent = Number.isFinite(reasoning.reasoningTokens)
      ? `Reasoning tokens counted (${reasoning.reasoningTokens}) but content not surfaced on this step.`
      : 'No reasoning content on this step.'
    host.appendChild(empty)
    return
  }
  const wrap = doc.createElement('details')
  wrap.className = 'trace-detail-reasoning-body'
  wrap.open = true
  const sum = doc.createElement('summary')
  sum.className = 'trace-detail-reasoning-summary muted'
  sum.textContent = `thinking · ${trimForSummary(reasoning.text)}`
  wrap.appendChild(sum)
  const body = doc.createElement('div')
  body.className = 'trace-detail-reasoning-content prose'
  body.textContent = reasoning.text
  wrap.appendChild(body)
  host.appendChild(wrap)
}

function trimForSummary(s) {
  if (typeof s !== 'string') return ''
  const trimmed = s.replace(/\s+/g, ' ').trim()
  return trimmed.length > 80 ? trimmed.slice(0, 79) + '…' : trimmed
}

// ---- Attributes ---------------------------------------------------------
function buildAttributesPanel(doc, host, rec, sessionHeader) {
  const groups = attributesGroups(rec, sessionHeader)
  for (const g of groups) {
    const gEl = doc.createElement('details')
    gEl.className = `trace-detail-attr-group group-${g.key}`
    gEl.open = true
    const sum = doc.createElement('summary')
    sum.className = 'trace-detail-attr-group-head'
    const lab = doc.createElement('span')
    lab.className = 'trace-detail-attr-group-label'
    lab.textContent = g.label
    sum.appendChild(lab)
    gEl.appendChild(sum)
    const table = doc.createElement('div')
    table.className = 'trace-detail-kv'
    for (const [k, v] of g.rows) table.appendChild(buildAttrKVRow(doc, k, v))
    gEl.appendChild(table)
    host.appendChild(gEl)
  }
}

function buildAttrKVRow(doc, k, v) {
  const row = doc.createElement('div')
  row.className = 'trace-detail-kv-row'
  const key = doc.createElement('div')
  key.className = 'trace-detail-kv-key mono'
  key.textContent = k
  const val = doc.createElement('div')
  val.className = 'trace-detail-kv-value mono'
  if (v && typeof v === 'object' && v.absent) {
    val.classList.add('absent')
    val.textContent = 'absent'
  } else if (Array.isArray(v)) {
    val.textContent = v.join(', ')
  } else if (typeof v === 'string' && /^https?:\/\//i.test(v)) {
    // URL-shaped value in the Runtime group renders as a real link so
    // researchers can click straight to the trace's canonical page.
    const a = doc.createElement('a')
    a.href = v
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    a.textContent = v
    val.appendChild(a)
    const marker = doc.createElement('span')
    marker.className = 'trace-detail-ext-marker'
    marker.textContent = ' ↗' // ↗
    val.appendChild(marker)
  } else {
    val.textContent = String(v)
  }
  row.appendChild(key); row.appendChild(val)
  return row
}

// ---- Input / Output with Render dropdown -------------------------------
// Both sections share a Render dropdown (Markdown / Plain / JSON).  The
// panel body is rebuilt whenever the dropdown changes so we don't spend
// DOM on modes the user hasn't asked for.
function buildRenderModePanel(doc, host, controls, kind, spec) {
  const select = doc.createElement('select')
  select.className = 'trace-detail-render-mode ghost small'
  select.setAttribute('aria-label', `Render mode for ${kind}`)
  select.title = 'Change how message bodies render'
  const modes = [
    { key: 'markdown', label: 'Markdown' },
    { key: 'plain',    label: 'Plain' },
    { key: 'json',     label: 'JSON' },
  ]
  for (const m of modes) {
    const opt = doc.createElement('option')
    opt.value = m.key
    opt.textContent = m.label
    select.appendChild(opt)
  }
  select.value = 'markdown'
  select.addEventListener('change', function () { render(select.value) })
  if (controls) controls.appendChild(select)

  function render(mode) {
    while (host.firstChild) host.removeChild(host.firstChild)
    if (kind === 'input')  buildInputPanel(doc, host, spec.record || null, spec, mode)
    else                   buildOutputPanel(doc, host, spec.record || null, spec, mode)
  }
  render('markdown')
}

function buildInputPanel(doc, host, rec, spec, mode) {
  mode = mode || 'markdown'
  const { messages, config } = inputRows(rec)
  if (mode === 'json') {
    return buildJsonPanel(doc, host, { messages, config }, 'input')
  }
  if (config && config.length) {
    const h = doc.createElement('div')
    h.className = 'trace-detail-subhead'
    h.textContent = 'config'
    host.appendChild(h)
    const cfg = doc.createElement('div')
    cfg.className = 'trace-detail-kv'
    for (const f of config) {
      const row = doc.createElement('div')
      row.className = 'trace-detail-kv-row'
      const k = doc.createElement('div'); k.className = 'trace-detail-kv-key mono'; k.textContent = f.key
      const v = doc.createElement('div'); v.className = 'trace-detail-kv-value mono'
      if (f.value === null || f.value === undefined) { v.classList.add('absent'); v.textContent = 'absent' }
      else v.textContent = typeof f.value === 'string' ? f.value : JSON.stringify(f.value)
      row.appendChild(k); row.appendChild(v)
      cfg.appendChild(row)
    }
    host.appendChild(cfg)
  }
  const mh = doc.createElement('div')
  mh.className = 'trace-detail-subhead'
  mh.textContent = `messagePrefix · ${messages.length}`
  host.appendChild(mh)
  if (messages.length === 0) {
    const empty = doc.createElement('div')
    empty.className = 'trace-detail-empty muted'
    empty.textContent = 'No inputs.'
    host.appendChild(empty)
    return
  }
  const list = doc.createElement('div')
  list.className = 'trace-detail-message-list'
  for (const ev of messages) list.appendChild(buildMessageRow(doc, ev, mode))
  host.appendChild(list)
}

function buildMessageRow(doc, ev, mode) {
  const row = doc.createElement('div')
  row.className = 'trace-detail-message-row'
  row.dataset.eventType = ev.type || ''
  // two-part role — small typographic dot + Titlecase word, inline.
  const role = doc.createElement('span')
  role.className = 'trace-detail-role'
  const label = roleForEvent(ev)
  role.dataset.role = String(label || '').toLowerCase()
  const glyph = doc.createElement('span')
  glyph.className = 'trace-detail-role-glyph mono'
  glyph.setAttribute('aria-hidden', 'true')
  glyph.textContent = '·'
  const word = doc.createElement('span')
  word.className = 'trace-detail-role-label'
  word.textContent = label
  role.appendChild(glyph); role.appendChild(word)
  const body = doc.createElement('div')
  body.className = 'trace-detail-message-body'
  const text = previewText(ev)
  if (mode === 'plain') body.classList.add('plain')
  body.textContent = text
  row.appendChild(role); row.appendChild(body)
  // Batch C (team-lead 2026-07-17 正面参照): Input panel messages also expose
  // the recursive Fields tree — system prompts with cache_control, multipart
  // content blocks, per-role metadata are all reachable via per-level fold,
  // matching the LangSmith detail-pane grammar the user's screenshots lock
  // in. The tree lives inline below the preview line (same shape as Output
  // rows), so Input and Output present the same reachability contract.
  const fieldsTree = buildRawFieldsSubtree(doc, ev)
  if (fieldsTree) row.appendChild(fieldsTree)
  const raw = buildRawBadgeFor(doc, ev)
  if (raw) row.appendChild(raw)
  return row
}

function roleForEvent(ev) {
  // return Titlecase
  // word ("User" / "Assistant" / "Tool" / "System" / "Context") for inline
  // role labels — the CSS drops uppercase so we ship human-readable words.
  // Uppercase "USER" / "HUMAN" caps hero was flagged as no information
  // increment. Unknown types fall back to a titlecased split of the wire
  // type family ("compact" → "Compact") so plugin-emitted rows still render.
  if (!ev || typeof ev.type !== 'string') return '?'
  if (ev.type === 'user/message') return 'User'
  if (ev.type === 'assistant/message' || ev.type === 'assistant/chunk') return 'Assistant'
  if (ev.type === 'tool/result') return 'Tool'
  if (ev.type === 'context/message' || ev.type === 'steering/message') return 'Context'
  if (ev.type === 'compact/summary') return 'Compact'
  const fam = (ev.type.split('/')[0] || '?')
  return fam ? fam.charAt(0).toUpperCase() + fam.slice(1) : '?'
}

function previewText(ev) {
  const agg = typeof window !== 'undefined' ? window.__dshTraceAgg : null
  if (agg && typeof agg.previewForEvent === 'function') return agg.previewForEvent(ev) || ''
  if (ev && ev.data && typeof ev.data.text === 'string') return ev.data.text
  return ''
}

// ---- Output -------------------------------------------------------------
// LangSmith wraps Output in a "Fields" card with a `{ }` icon, "Fields"
// title, and right-side Expand/Copy controls; each field within is its
// own collapsible block.  We mirror that: one `.trace-detail-fields-card`
// per Output section with per-row `<details>` for expansion and a `{ }`
// raw-JSON link per row (universal L2 reach).
function buildOutputPanel(doc, host, rec, spec, mode) {
  mode = mode || 'markdown'
  const rows = outputRows(rec)
  if (mode === 'json') {
    return buildJsonPanel(doc, host, rows.map(r => r.raw), 'output')
  }
  const card = doc.createElement('div')
  card.className = 'trace-detail-fields-card'
  const head = doc.createElement('div')
  head.className = 'trace-detail-fields-head'
  const glyph = doc.createElement('span')
  glyph.className = 'trace-detail-fields-glyph mono'
  glyph.textContent = '{ }'
  const title = doc.createElement('span')
  title.className = 'trace-detail-fields-title'
  title.textContent = 'Fields'
  const count = doc.createElement('span')
  count.className = 'trace-detail-fields-count muted mono'
  count.textContent = `· ${rows.length}`
  const controls = doc.createElement('span')
  controls.className = 'trace-detail-fields-controls'
  const expandAll = doc.createElement('button')
  expandAll.type = 'button'
  expandAll.className = 'ghost small trace-detail-fields-expand'
  expandAll.textContent = 'Expand all'
  expandAll.title = 'Expand every field in this section'
  const copyAll = doc.createElement('button')
  copyAll.type = 'button'
  copyAll.className = 'ghost small trace-detail-fields-copy'
  copyAll.textContent = 'Copy'
  copyAll.title = 'Copy the raw JSON of all outputs'
  controls.appendChild(expandAll); controls.appendChild(copyAll)
  head.appendChild(glyph); head.appendChild(title); head.appendChild(count); head.appendChild(controls)
  card.appendChild(head)
  if (rows.length === 0) {
    const empty = doc.createElement('div')
    empty.className = 'trace-detail-empty muted'
    empty.textContent = 'No outputs.'
    card.appendChild(empty)
    host.appendChild(card)
    return
  }
  const list = doc.createElement('div')
  list.className = 'trace-detail-message-list'
  const rowEls = []
  for (const r of rows) {
    const details = doc.createElement('details')
    details.className = 'trace-detail-field-block'
    details.open = true
    const sum = doc.createElement('summary')
    sum.className = 'trace-detail-field-block-head'
    const key = doc.createElement('span')
    key.className = 'trace-detail-field-key mono'
    if (r.kind === 'tool-call') key.textContent = 'tool_call'
    else if (r.kind === 'tool-result') key.textContent = 'tool_result'
    else key.textContent = 'output'
    sum.appendChild(key)
    const perCopy = doc.createElement('button')
    perCopy.type = 'button'
    perCopy.className = 'ghost small trace-detail-field-copy'
    perCopy.textContent = 'Copy'
    perCopy.title = 'Copy this block'
    perCopy.addEventListener('click', function (e) {
      if (e && e.stopPropagation) e.stopPropagation()
      copyJson(r.raw)
    })
    sum.appendChild(perCopy)
    details.appendChild(sum)
    details.appendChild(buildOutputRow(doc, r, mode))
    list.appendChild(details)
    rowEls.push(details)
  }
  card.appendChild(list)
  host.appendChild(card)
  expandAll.addEventListener('click', function () {
    const shouldOpen = rowEls.some(function (d) { return !d.open })
    for (const d of rowEls) d.open = shouldOpen
    expandAll.textContent = shouldOpen ? 'Collapse all' : 'Expand all'
  })
  copyAll.addEventListener('click', function () { copyJson(rows.map(function (r) { return r.raw })) })
}

function buildOutputRow(doc, r, mode) {
  const row = doc.createElement('div')
  row.className = 'trace-detail-output-row'
  row.dataset.kind = r.kind
  // role label same shape as message rows (dot + Titlecase word).
  const roleEl = doc.createElement('span')
  roleEl.className = 'trace-detail-role'
  const rawRole = r.role || 'assistant'
  roleEl.dataset.role = rawRole
  const glyph = doc.createElement('span')
  glyph.className = 'trace-detail-role-glyph mono'
  glyph.setAttribute('aria-hidden', 'true')
  glyph.textContent = '·'
  const word = doc.createElement('span')
  word.className = 'trace-detail-role-label'
  word.textContent = rawRole.charAt(0).toUpperCase() + rawRole.slice(1)
  roleEl.appendChild(glyph); roleEl.appendChild(word)
  row.appendChild(roleEl)
  if (r.kind === 'message') {
    const body = doc.createElement('div')
    body.className = 'trace-detail-message-body'
    if (mode === 'plain') body.classList.add('plain')
    body.textContent = r.text ? r.text : '(no text)'
    row.appendChild(body)
    if (Array.isArray(r.toolCalls) && r.toolCalls.length) {
      const tc = doc.createElement('div')
      tc.className = 'trace-detail-tool-calls'
      for (const c of r.toolCalls) tc.appendChild(buildToolCallKV(doc, c))
      row.appendChild(tc)
    }
    const fieldsTree = buildRawFieldsSubtree(doc, r.raw)
    if (fieldsTree) row.appendChild(fieldsTree)
    const raw = buildRawBadgeFor(doc, r.raw)
    if (raw) row.appendChild(raw)
  } else if (r.kind === 'tool-call') {
    const kv = doc.createElement('div')
    kv.className = 'trace-detail-tool-calls'
    kv.appendChild(buildToolCallKV(doc, { id: r.callId, name: r.name, args: r.args }))
    row.appendChild(kv)
    const fieldsTree = buildRawFieldsSubtree(doc, r.raw)
    if (fieldsTree) row.appendChild(fieldsTree)
    const raw = buildRawBadgeFor(doc, r.raw)
    if (raw) row.appendChild(raw)
  } else if (r.kind === 'tool-result') {
    // Batch C: tool_result output row — one-line preview (callId + first
    // text block truncated) plus the full recursive Fields tree. Error
    // status shown as a small chip; deep structure (multi-part content,
    // meta, diagnostics) reachable per level below.
    const body = doc.createElement('div')
    body.className = 'trace-detail-message-body'
    if (mode === 'plain') body.classList.add('plain')
    const parts = []
    if (r.callId) parts.push(r.callId)
    const firstText = Array.isArray(r.content) ? (r.content.find(function (b) { return b && b.type === 'text' && typeof b.text === 'string' }) || null) : null
    if (firstText && firstText.text) {
      const t = firstText.text.length > 120 ? firstText.text.slice(0, 117) + '…' : firstText.text
      parts.push(t)
    } else if (Array.isArray(r.content) && r.content.length > 0) {
      parts.push(`${r.content.length} content block${r.content.length === 1 ? '' : 's'}`)
    }
    body.textContent = parts.length ? parts.join(' · ') : '(no content)'
    row.appendChild(body)
    if (r.isError) {
      const errChip = doc.createElement('span')
      errChip.className = 'trace-detail-tool-result-error-chip mono'
      errChip.textContent = 'isError'
      errChip.title = 'tool/result carried isError=true'
      row.appendChild(errChip)
    }
    const fieldsTree = buildRawFieldsSubtree(doc, r.raw)
    if (fieldsTree) row.appendChild(fieldsTree)
    const raw = buildRawBadgeFor(doc, r.raw)
    if (raw) row.appendChild(raw)
  }
  return row
}

// LangSmith parity (team-lead 2026-07-17 正面参照): every Output row exposes
// its full raw wire payload through the SAME recursive collapsible tree
// grammar as tool_call arguments. Density is carried by folding (deeper
// levels closed by default), never by dropping fields — the user's line
// "全字段+逐级折叠 (不删字段)". The subtree is a top-level `<details>`
// (closed by default so it doesn't push the row body around) whose child
// is a buildJsonTree over the raw event's `.data` payload (or the whole
// event if `.data` is absent). This is the zero-drop reachability path
// for anything the assistant/tool wire carries beyond `text` + args.
function buildRawFieldsSubtree(doc, raw) {
  if (!raw || typeof raw !== 'object') return null
  // Only expose the subtree when the event carries a `.data` payload —
  // that is what the LangSmith Fields card equivalent is showing. Bare
  // event descriptors (e.g. dev/heartbeat) have nothing useful beyond
  // type/seq, which the raw-JSON drawer already surfaces.
  const payload = raw.data && typeof raw.data === 'object' ? raw.data : null
  if (!payload) return null
  const keys = Array.isArray(payload) ? payload.length : Object.keys(payload).length
  if (keys === 0) return null
  const box = doc.createElement('details')
  box.className = 'trace-detail-row-fields'
  box.dataset.kind = 'raw-fields'
  // Batch C (team-lead 2026-07-17 正面参照): default OPEN so the recursive
  // tree is what the user sees when they open a Fields block — matches the
  // LangSmith detail-pane screenshots the user pointed at ("像这样的 UI").
  // Density is still carried within: inner branches default one-level open
  // (via buildJsonTree's openDepth=1), deeper levels stay folded until
  // clicked.
  box.open = true
  const sum = doc.createElement('summary')
  sum.className = 'trace-detail-row-fields-summary'
  const bracket = doc.createElement('span')
  bracket.className = 'trace-detail-row-fields-glyph mono muted'
  bracket.textContent = '{ }'
  const label = doc.createElement('span')
  label.className = 'trace-detail-row-fields-label muted'
  label.textContent = 'Fields'
  const count = doc.createElement('span')
  count.className = 'trace-detail-row-fields-count muted mono'
  count.textContent = `· ${Array.isArray(payload) ? `${keys} items` : `${keys} keys`}`
  sum.appendChild(bracket); sum.appendChild(label); sum.appendChild(count)
  box.appendChild(sum)
  const treeHost = doc.createElement('div')
  treeHost.className = 'trace-detail-row-fields-body'
  treeHost.appendChild(buildJsonTree(doc, payload, { rootName: null, openDepth: 1 }))
  box.appendChild(treeHost)
  return box
}

function buildToolCallKV(doc, call) {
  const wrap = doc.createElement('div')
  wrap.className = 'trace-detail-tool-call'
  const pairs = [
    ['name', call.name || 'absent'],
    ['type', 'function'],
    ['id', call.id || 'absent'],
    ['arguments', argumentsPreview(call.args)],
  ]
  for (const [k, v] of pairs) {
    const row = doc.createElement('div')
    row.className = 'trace-detail-kv-row'
    const key = doc.createElement('div'); key.className = 'trace-detail-kv-key mono'; key.textContent = k
    const val = doc.createElement('div'); val.className = 'trace-detail-kv-value mono'
    if (k === 'arguments' && call.args && typeof call.args === 'object') {
      // render arguments as a
      // RECURSIVELY collapsible JSON tree — every nested object/array
      // gets its own `∨/▸` arrow at any depth, scalars get a leading
      // typographic dot, leaf values in mono. Density is managed by
      // folding, never by dropping. Top level starts open (one level
      // open by default); deeper levels folded until clicked.
      val.appendChild(buildJsonTree(doc, call.args, {
        rootName: null,
        rootSummary: argumentsSummary(call.args),
        openDepth: 1,
      }))
    } else if (v === 'absent') {
      val.classList.add('absent')
      val.textContent = 'absent'
    } else {
      val.textContent = String(v)
    }
    // MCP source attribution chip on the `name`
    // row. When the tool name matches the kernel's `mcp__<server>__<name>`
    // grammar, drop a chip-tier badge next to the value that reads as
    // "mcp · <serverName>" so the user can trace the call back to the
    // dsh-mcp-client patch that mounted the server. Native tools get no
    // chip (they're the default case); a `source.plugin` marker from an
    // orchestrator plugin (e.g. `compact`) still routes through the
    // legacy classifier at renderer.js:1342 — we don't touch that path.
    if (k === 'name') {
      const chip = buildToolSourceChip(doc, call)
      if (chip) val.appendChild(chip)
    }
    row.appendChild(key); row.appendChild(val)
    wrap.appendChild(row)
  }
  return wrap
}

// pure DOM helper that decides whether a tool call
// deserves a source chip, and builds the chip if so. Kept out of
// buildToolCallKV so unit tests can exercise the branch directly + so a
// future built-in/plugin-tool badge can drop in beside the MCP one without
// re-nesting the switch.
function buildToolSourceChip(doc, call) {
  const parser = (typeof globalThis !== 'undefined' && globalThis.__dshMcpToolName)
    || (typeof window !== 'undefined' && window.__dshMcpToolName)
    || null
  const name = call && call.name
  const parsed = parser && parser.parseMcpToolName ? parser.parseMcpToolName(name) : null
  if (parsed) {
    const chip = doc.createElement('span')
    chip.className = 'trace-detail-tool-source-chip chip-tier mcp'
    chip.dataset.source = 'mcp'
    chip.dataset.mcpServer = parsed.server
    // Format: "mcp · <server>" — mirrors the neutral density-layering-spec
    // chip grammar (typographic dot separator, no emoji, status-only color
    // handled by the shared chip-tier tokens).
    const glyph = doc.createElement('span')
    glyph.className = 'trace-detail-tool-source-chip-glyph mono muted'
    glyph.textContent = 'mcp'
    const sep = doc.createElement('span')
    sep.className = 'trace-detail-tool-source-chip-sep muted'
    sep.textContent = ' · '
    const server = doc.createElement('span')
    server.className = 'trace-detail-tool-source-chip-server mono'
    server.textContent = parsed.server
    chip.appendChild(glyph)
    chip.appendChild(sep)
    chip.appendChild(server)
    chip.title = `Tool served by MCP server "${parsed.server}". ` +
      `Kernel-emitted name: mcp__${parsed.server}__${parsed.rawName}.`
    return chip
  }
  // Slot for future built-in / plugin-source attribution. `call.source`
  // is not currently populated by the wire, but the density-layering
  // spec §3 reserves the field; when the kernel adds it, we render:
  //   { plugin } for source.kind === 'plugin'
  //   { built-in } otherwise
  // For now this branch is dead code by design; keeping it explicit so
  // the audit's "leave a categorization slot" ask is visible in source.
  if (call && call.source && call.source.kind === 'plugin' && call.source.plugin) {
    const chip = doc.createElement('span')
    chip.className = 'trace-detail-tool-source-chip chip-tier plugin'
    chip.dataset.source = 'plugin'
    chip.dataset.plugin = call.source.plugin
    chip.textContent = `plugin · ${call.source.plugin}`
    chip.title = `Tool served by plugin "${call.source.plugin}".`
    return chip
  }
  return null
}

// ---- Recursive JSON tree ------------------------------------------------
//
// Task #34 (team-lead 2026-07-17 正面参照 — LangSmith detail-pane grammar
// the user explicitly said "像这样的 UI 就是我们想要的").
//
// Renders any JSON value as a foldable tree:
//   - object/array with children → `<details>` with a `<summary>` carrying
//     the arrow (native `<details>` marker) + key label + one-line preview
//     ("{n keys}" / "[n items]"); children are indented rows inside.
//   - scalar (string/number/boolean/null) → `<div>` with a leading `·` dot
//     glyph + key + `=` + mono value.
//
// Density is carried by per-level folding, NOT by dropping fields
// (zero-drop rule from positive reference).
// `openDepth` controls default open depth (1 = only top level open).
//
// The renderer is used for tool_call arguments (was a flat `<pre>` JSON
// blob before) and can be reused for any wire payload the detail pane
// wants to expose recursively (Fields cards, raw output, etc.).
function buildJsonTree(doc, value, opts) {
  opts = opts || {}
  const openDepth = typeof opts.openDepth === 'number' ? opts.openDepth : 1
  const root = doc.createElement('div')
  root.className = 'trace-detail-json-tree mono'
  renderJsonNode(doc, root, opts.rootName || null, value, 0, openDepth, opts.rootSummary || null)
  return root
}

function renderJsonNode(doc, host, key, value, depth, openDepth, summaryOverride) {
  // Objects and non-empty arrays fold. Empty ones + scalars render inline.
  const isObj = value && typeof value === 'object' && !Array.isArray(value)
  const isArr = Array.isArray(value)
  const foldable = (isObj && Object.keys(value).length > 0) || (isArr && value.length > 0)
  if (foldable) {
    const d = doc.createElement('details')
    d.className = 'trace-detail-json-node trace-detail-json-branch'
    if (depth < openDepth) d.open = true
    d.dataset.depth = String(depth)
    const s = doc.createElement('summary')
    s.className = 'trace-detail-json-summary'
    // key label (nullable at root)
    if (key !== null && key !== undefined) {
      const k = doc.createElement('span')
      k.className = 'trace-detail-json-key'
      k.textContent = String(key)
      s.appendChild(k)
    }
    // one-line preview: "{ n keys }" / "[ n items ]"
    const preview = doc.createElement('span')
    preview.className = 'trace-detail-json-preview muted'
    let previewText
    if (summaryOverride && depth === 0) previewText = summaryOverride
    else if (isObj) previewText = `{ ${Object.keys(value).length} keys }`
    else previewText = `[ ${value.length} items ]`
    preview.textContent = previewText
    s.appendChild(preview)
    d.appendChild(s)
    // children
    const body = doc.createElement('div')
    body.className = 'trace-detail-json-children'
    body.dataset.depth = String(depth + 1)
    if (isObj) {
      for (const ck of Object.keys(value)) {
        renderJsonNode(doc, body, ck, value[ck], depth + 1, openDepth, null)
      }
    } else {
      for (let i = 0; i < value.length; i++) {
        renderJsonNode(doc, body, String(i), value[i], depth + 1, openDepth, null)
      }
    }
    d.appendChild(body)
    host.appendChild(d)
    return d
  }
  // Leaf (scalar or empty container).
  const row = doc.createElement('div')
  row.className = 'trace-detail-json-node trace-detail-json-leaf'
  row.dataset.depth = String(depth)
  const dot = doc.createElement('span')
  dot.className = 'trace-detail-json-dot'
  dot.setAttribute('aria-hidden', 'true')
  dot.textContent = '·'
  row.appendChild(dot)
  if (key !== null && key !== undefined) {
    const k = doc.createElement('span')
    k.className = 'trace-detail-json-key'
    k.textContent = String(key)
    row.appendChild(k)
    const eq = doc.createElement('span')
    eq.className = 'trace-detail-json-eq muted'
    eq.textContent = '='
    row.appendChild(eq)
  }
  const v = doc.createElement('span')
  v.className = 'trace-detail-json-value'
  if (value === null) { v.classList.add('is-null'); v.textContent = 'null' }
  else if (value === undefined) { v.classList.add('absent'); v.textContent = 'absent' }
  else if (typeof value === 'string') { v.classList.add('is-string'); v.textContent = JSON.stringify(value) }
  else if (typeof value === 'boolean') { v.classList.add('is-boolean'); v.textContent = String(value) }
  else if (typeof value === 'number') { v.classList.add('is-number'); v.textContent = String(value) }
  else if (Array.isArray(value)) { v.textContent = '[]' } // empty array
  else if (value && typeof value === 'object') { v.textContent = '{}' } // empty object
  else { v.textContent = String(value) }
  row.appendChild(v)
  host.appendChild(row)
  return row
}

function argumentsSummary(args) {
  if (!args || typeof args !== 'object') return String(args)
  const keys = Object.keys(args)
  if (!keys.length) return '{}'
  const preview = keys.slice(0, 4).map((k) => `${k}=${briefValue(args[k])}`).join(' ')
  return keys.length > 4 ? `${preview} …+${keys.length - 4}` : preview
}
function argumentsPreview(args) {
  if (args && typeof args === 'object') return argumentsSummary(args)
  if (args === null || args === undefined) return 'absent'
  return String(args)
}
function briefValue(v) {
  if (typeof v === 'string') return v.length > 24 ? JSON.stringify(v.slice(0, 24)) + '…' : JSON.stringify(v)
  if (typeof v === 'object') return '{…}'
  return String(v)
}
function safeJsonString(v) {
  try { return JSON.stringify(v, null, 2) } catch (_) { return String(v) }
}

// ---- Raw JSON section body (Render=JSON mode) --------------------------
// this panel is one of the surfaces the shared
// payload-controls util (window.__dshPayloadControls) mirrors — the
// pretty⇅raw / copy / download triplet the tool-block args + drawer
// sections use.  We prefer the util when available so the two families
// stay in lockstep (老板: "抽 shared util 对齐它，绝不做两套") and fall
// back to the legacy copy-only affordance when the util isn't loaded
// (unit-test contexts, headless renderer harness).
function buildJsonPanel(doc, host, payload, kind) {
  const wrap = doc.createElement('div')
  wrap.className = 'trace-detail-json-panel'
  const pc = (typeof window !== 'undefined') ? window.__dshPayloadControls : null
  if (pc && typeof pc.attachPayloadControls === 'function') {
    pc.attachPayloadControls(wrap, {
      getRaw: () => payload,
      kind,
      filename: `${kind}-payload.json`,
    })
    host.appendChild(wrap)
    return
  }
  // Legacy fallback: original copy-only cluster preserved for tests that
  // exercise trace-detail-pane without the payload-controls util loaded.
  const copy = doc.createElement('button')
  copy.type = 'button'
  copy.className = 'ghost small trace-detail-json-copy'
  copy.textContent = 'Copy'
  copy.title = `Copy raw ${kind} JSON`
  copy.addEventListener('click', function () { copyJson(payload) })
  wrap.appendChild(copy)
  const pre = doc.createElement('pre')
  pre.className = 'trace-detail-args-pre mono'
  pre.textContent = safeJsonString(payload)
  wrap.appendChild(pre)
  host.appendChild(wrap)
}

function copyJson(payload) {
  try {
    const s = safeJsonString(payload)
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(s).catch(function () {})
    }
  } catch (_) { /* clipboard is best-effort */ }
}

// ---- Feedback -----------------------------------------------------------
function buildFeedbackPanel(doc, host, spec, controls) {
  const api = typeof window !== 'undefined' ? window.__dshAnnotation : null
  const fb = feedbackRows(spec.sessionId, api)
  if (!fb.available) {
    const stub = doc.createElement('div')
    stub.className = 'trace-detail-empty muted'
    stub.textContent = 'Annotation module not loaded on this build.'
    host.appendChild(stub)
    return
  }
  if (!fb.rows.length) {
    // empty state = dashed `+ Add feedback` inline button
    // (not a text-only note).  Keeps the `.trace-detail-annotate` selector
    // for existing tests but retargets label + affordance.
    //
    // §15 correction (team-lead 2026-07-17 second directive): the
    // button now opens a LangSmith-style INLINE POPOVER (≤5 fields) rather
    // than jumping straight to the full-drawer form. Full drawer stays as
    // the "full annotation →" escape hatch inside the popover.  Popover
    // renders into `host` (below the button, no floating overlay) so it
    // inherits the section's left-align + spec §7 4px grid.
    const empty = doc.createElement('div')
    empty.className = 'trace-detail-empty muted'
    empty.textContent = 'No feedback yet for this trajectory.'
    host.appendChild(empty)
    const btn = doc.createElement('button')
    btn.type = 'button'
    btn.className = 'trace-detail-annotate trace-detail-add-feedback'
    btn.textContent = '+ Add feedback'
    btn.title = 'Rate this trajectory'
    btn.addEventListener('click', () => {
      openFeedbackPopover(doc, host, btn, spec, api)
    })
    host.appendChild(btn)
    return
  }
  const list = doc.createElement('div')
  list.className = 'trace-detail-feedback-list'
  for (const r of fb.rows) list.appendChild(buildFeedbackRow(doc, r))
  host.appendChild(list)
  // Populated state: put an "Add" button in the section controls so the
  // reader can still add more feedback without hunting for the entry.
  if (controls) {
    const add = doc.createElement('button')
    add.type = 'button'
    add.className = 'ghost small trace-detail-add-feedback-inline'
    add.textContent = '+ Add feedback'
    add.title = 'Rate this trajectory'
    add.addEventListener('click', function () {
      openFeedbackPopover(doc, host, add, spec, api)
    })
    controls.appendChild(add)
  }
}

// LangSmith-style inline popover ( §15).  Anchored to the caller's
// section, not the button — CSS positions it below the section head with
// 4px grid spacing.  Fields ≤5:
//   1) overall verdict (bad/ok/good)
//   2) optional per-turn scope selector (only if the record has ≥1 turn;
//      "trajectory (overall)" is always available and default)
//   3) rubric-mean dim: convergence (1-5)  — the "closest to submit-time"
//      dim in the 5-dim rubric; the other 4 stay in the full drawer
//   4) comment textarea (single line, ≤240 chars)
//   5) submit button + "full annotation →" link
// Submits via api.submit(); a successful write dispatches
// `dsh:annotation-updated` on document → the detail pane's own listener
// (installed at build time) rerenders the Feedback panel.
function openFeedbackPopover(doc, host, anchor, spec, api) {
  // If a popover is already open in this section, close it (toggle).
  const prev = host && host.querySelector && host.querySelector('.trace-detail-feedback-popover')
  if (prev && prev.parentNode) {
    prev.parentNode.removeChild(prev)
    return
  }
  const pop = doc.createElement('div')
  pop.className = 'trace-detail-feedback-popover'
  pop.setAttribute('role', 'dialog')
  pop.setAttribute('aria-label', 'Add feedback')

  const head = doc.createElement('div')
  head.className = 'trace-detail-feedback-popover-head'
  const title = doc.createElement('span')
  title.className = 'trace-detail-feedback-popover-title'
  title.textContent = 'Rate this trajectory'
  head.appendChild(title)
  const close = doc.createElement('button')
  close.type = 'button'
  close.className = 'ghost small trace-detail-feedback-popover-close'
  close.textContent = '×'
  close.title = 'Cancel'
  close.setAttribute('aria-label', 'Cancel')
  close.addEventListener('click', () => { if (pop.parentNode) pop.parentNode.removeChild(pop) })
  head.appendChild(close)
  pop.appendChild(head)

  // Field 1: overall verdict radio-row.
  const verdictRow = doc.createElement('div')
  verdictRow.className = 'trace-detail-feedback-popover-row row-verdict'
  const verdictLabel = doc.createElement('span')
  verdictLabel.className = 'trace-detail-feedback-popover-label'
  verdictLabel.textContent = 'Overall'
  verdictRow.appendChild(verdictLabel)
  const verdictGroup = doc.createElement('div')
  verdictGroup.className = 'trace-detail-feedback-popover-verdict-group'
  verdictGroup.setAttribute('role', 'radiogroup')
  const verdictBtns = {}
  const verdictOptions = ['bad', 'ok', 'good']
  let selectedVerdict = null
  for (const v of verdictOptions) {
    const b = doc.createElement('button')
    b.type = 'button'
    b.className = `trace-detail-feedback-popover-verdict verdict-${v}`
    b.textContent = v
    b.setAttribute('role', 'radio')
    b.setAttribute('aria-checked', 'false')
    b.addEventListener('click', () => {
      selectedVerdict = selectedVerdict === v ? null : v
      for (const k of verdictOptions) {
        const other = verdictBtns[k]
        if (!other) continue
        const on = k === selectedVerdict
        if (other.classList && typeof other.classList[on ? 'add' : 'remove'] === 'function') {
          other.classList[on ? 'add' : 'remove']('active')
        }
        other.setAttribute('aria-checked', on ? 'true' : 'false')
      }
    })
    verdictBtns[v] = b
    verdictGroup.appendChild(b)
  }
  verdictRow.appendChild(verdictGroup)
  pop.appendChild(verdictRow)

  // Field 2 (optional): scope selector — trajectory vs a specific turn.
  const R = (typeof window !== 'undefined' && window.__dshRubricsModel) || null
  const dims = R && Array.isArray(R.MULTI_TURN_DIMENSIONS) ? R.MULTI_TURN_DIMENSIONS : []
  const scopeOptions = [{ value: '', label: 'trajectory (overall)' }]
  // Turn scope derived from the record's step count when available.
  const rec = spec && spec.record
  const turnCount = rec && Number.isFinite(rec.turn) ? rec.turn : null
  if (Number.isInteger(turnCount) && turnCount >= 0) {
    scopeOptions.push({ value: String(turnCount), label: `turn ${turnCount}` })
  }
  let scopeSelect = null
  let dimRow = null
  let dimSelect = null
  if (dims.length && scopeOptions.length > 1) {
    const scopeRow = doc.createElement('div')
    scopeRow.className = 'trace-detail-feedback-popover-row row-scope'
    const lbl = doc.createElement('span')
    lbl.className = 'trace-detail-feedback-popover-label'
    lbl.textContent = 'Scope'
    scopeRow.appendChild(lbl)
    scopeSelect = doc.createElement('select')
    scopeSelect.className = 'trace-detail-feedback-popover-scope ghost small'
    scopeSelect.setAttribute('aria-label', 'Feedback scope')
    for (const opt of scopeOptions) {
      const o = doc.createElement('option')
      o.value = opt.value
      o.textContent = opt.label
      scopeSelect.appendChild(o)
    }
    scopeRow.appendChild(scopeSelect)
    pop.appendChild(scopeRow)

    // Field 3: convergence dim (1-5), only meaningful when a turn scope is picked.
    dimRow = doc.createElement('div')
    dimRow.className = 'trace-detail-feedback-popover-row row-dim'
    const dlab = doc.createElement('span')
    dlab.className = 'trace-detail-feedback-popover-label'
    dlab.textContent = 'Convergence'
    dimRow.appendChild(dlab)
    dimSelect = doc.createElement('select')
    dimSelect.className = 'trace-detail-feedback-popover-dim ghost small'
    dimSelect.setAttribute('aria-label', 'Convergence score')
    const noneOpt = doc.createElement('option')
    noneOpt.value = ''
    noneOpt.textContent = '—'
    dimSelect.appendChild(noneOpt)
    for (let i = 1; i <= 5; i++) {
      const o = doc.createElement('option')
      o.value = String(i)
      o.textContent = String(i)
      dimSelect.appendChild(o)
    }
    dimRow.appendChild(dimSelect)
    pop.appendChild(dimRow)
    // Hide dim row when scope = trajectory (rubric only applies per-turn).
    const syncDimRowVisibility = () => {
      const isTurn = scopeSelect.value !== ''
      if (dimRow.classList && typeof dimRow.classList.toggle === 'function') {
        dimRow.classList.toggle('hidden', !isTurn)
      }
    }
    scopeSelect.addEventListener('change', syncDimRowVisibility)
    syncDimRowVisibility()
  }

  // Field 4: comment.
  const noteRow = doc.createElement('div')
  noteRow.className = 'trace-detail-feedback-popover-row row-note'
  const nlab = doc.createElement('span')
  nlab.className = 'trace-detail-feedback-popover-label'
  nlab.textContent = 'Comment'
  noteRow.appendChild(nlab)
  const note = doc.createElement('textarea')
  note.className = 'trace-detail-feedback-popover-note'
  note.rows = 2
  note.maxLength = 240
  note.placeholder = 'Optional — what stood out?'
  noteRow.appendChild(note)
  pop.appendChild(noteRow)

  // Field 5: actions.
  const actions = doc.createElement('div')
  actions.className = 'trace-detail-feedback-popover-actions'
  const submit = doc.createElement('button')
  submit.type = 'button'
  submit.className = 'primary small trace-detail-feedback-popover-submit'
  submit.textContent = 'Submit'
  submit.addEventListener('click', () => {
    if (!api || typeof api.submit !== 'function') return
    const patch = {}
    if (selectedVerdict) patch.overall = selectedVerdict
    if (scopeSelect && scopeSelect.value !== '') {
      const idx = parseInt(scopeSelect.value, 10)
      if (Number.isInteger(idx) && idx >= 0) {
        patch.turnIndex = idx
        if (dimSelect && dimSelect.value !== '') {
          patch.dims = { convergence: parseInt(dimSelect.value, 10) }
        }
      }
    }
    if (note.value && note.value.trim()) patch.note = note.value.trim()
    if (!('overall' in patch) && !('turnIndex' in patch) && !('note' in patch)) {
      // Nothing to submit — surface the intent by focusing the first field.
      const first = verdictBtns.ok || verdictBtns.good
      if (first && typeof first.focus === 'function') try { first.focus() } catch (_) {}
      return
    }
    try { api.submit(spec.sessionId, patch) } catch (_) { /* best-effort */ }
    if (pop.parentNode) pop.parentNode.removeChild(pop)
  })
  actions.appendChild(submit)
  const fullLink = doc.createElement('button')
  fullLink.type = 'button'
  fullLink.className = 'ghost small trace-detail-feedback-popover-full'
  fullLink.textContent = 'full annotation →'
  fullLink.title = 'Open the full annotation drawer (5-dim rubric + task tag + export)'
  fullLink.addEventListener('click', () => {
    if (pop.parentNode) pop.parentNode.removeChild(pop)
    if (api && typeof api.open === 'function') {
      try { api.open(spec.sessionId) } catch (_) { /* opener may not exist yet */ }
    }
  })
  actions.appendChild(fullLink)
  pop.appendChild(actions)

  // Insert the popover directly after the anchor (button) so the visual
  // "below the button" reading holds without absolute positioning.
  if (anchor && anchor.parentNode && typeof anchor.parentNode.insertBefore === 'function') {
    anchor.parentNode.insertBefore(pop, anchor.nextSibling)
  } else {
    host.appendChild(pop)
  }
  // Autofocus the first verdict button for keyboard flow.
  if (verdictBtns.ok && typeof verdictBtns.ok.focus === 'function') {
    try { verdictBtns.ok.focus() } catch (_) { /* focus is best-effort */ }
  }
}

function buildFeedbackRow(doc, r) {
  const row = doc.createElement('div')
  row.className = 'trace-detail-feedback-row'
  row.dataset.scope = r.scope
  const head = doc.createElement('div')
  head.className = 'trace-detail-feedback-head'
  const scope = doc.createElement('span')
  scope.className = 'trace-detail-feedback-scope mono'
  scope.textContent = r.scope === 'session' ? 'trajectory' : `turn ${r.turn}`
  head.appendChild(scope)
  if (r.overall) {
    const overall = doc.createElement('span')
    overall.className = 'trace-detail-feedback-overall'
    overall.textContent = r.overall
    head.appendChild(overall)
  }
  const meta = doc.createElement('span')
  meta.className = 'trace-detail-feedback-meta muted'
  meta.textContent = `${r.annotator || 'local-user'}${r.time ? ' · ' + formatTime(r.time) : ''}`
  head.appendChild(meta)
  row.appendChild(head)
  if (r.dims && typeof r.dims === 'object') {
    // Ask annotation module for the active dim-spec list so we can render
    // categorical enum text / boolean pass-fail labels correctly and
    // stamp each dim with its primitive type badge.  Falls back to
    // untyped rendering if the module isn't available (e.g. in tests).
    const specById = new Map()
    if (typeof window !== 'undefined' && window.__dshAnnotation
        && typeof window.__dshAnnotation.getActiveDims === 'function') {
      try {
        const dims = window.__dshAnnotation.getActiveDims() || []
        for (const d of dims) if (d && d.id) specById.set(d.id, d)
      } catch (_) { /* ignore */ }
    }
    const dims = doc.createElement('div')
    dims.className = 'trace-detail-feedback-dims'
    for (const k of Object.keys(r.dims)) {
      const v = r.dims[k]
      const spec = specById.get(k) || null
      dims.appendChild(buildFeedbackDimChip(doc, k, v, spec))
    }
    row.appendChild(dims)
  }
  if (r.note) {
    const note = doc.createElement('div')
    note.className = 'trace-detail-feedback-note'
    note.textContent = r.note
    row.appendChild(note)
  }
  return row
}

// One chip per scored dim on a Feedback row.  Shape:
//   [ key ][ type-badge ][ value ]
// The type badge tells the reader what primitive the underlying rubric
// used; the value renders as-is for categorical/boolean (string / label
// text) and as a number for continuous.
function buildFeedbackDimChip(doc, key, value, spec) {
  const chip = doc.createElement('span')
  chip.className = 'trace-detail-feedback-dim-chip mono'
  chip.dataset.dimId = key
  const keyEl = doc.createElement('span')
  keyEl.className = 'trace-detail-feedback-dim-key'
  keyEl.textContent = key
  chip.appendChild(keyEl)
  if (spec && spec.type) {
    const badge = doc.createElement('span')
    badge.className = 'trace-detail-feedback-dim-type-badge'
    badge.dataset.dimType = spec.type
    badge.textContent = spec.type
    chip.appendChild(badge)
    chip.dataset.dimType = spec.type
  }
  const valEl = doc.createElement('span')
  valEl.className = 'trace-detail-feedback-dim-value'
  if (value == null) {
    valEl.textContent = '—'
    valEl.classList.add('absent')
  } else if (typeof value === 'boolean') {
    // Prefer the rubric's label pair if we know it — otherwise fall back
    // to the raw true/false strings.
    const labels = spec && spec.labels ? spec.labels : { true: 'true', false: 'false' }
    valEl.textContent = value ? labels.true : labels.false
    valEl.dataset.value = String(value)
  } else {
    valEl.textContent = String(value)
    valEl.dataset.value = String(value)
  }
  chip.appendChild(valEl)
  return chip
}

function formatTime(t) {
  if (typeof t === 'number' && Number.isFinite(t)) {
    // a bare `Date(0)`
    // rendered "12/31/1969, 4:00:00 PM" in Attributes / event rows whenever
    // the wire carried `time: 0` (absent-but-typed = falsy in JS). The
    // researcher scans that and thinks "this software is broken". Guard the
    // epoch-0 case (any ms <= 0 means "we don't know") with the em-dash
    // fallback that formatCell already uses in tracing-index-model.
    //
    // Preflight (2026-07-18): tightened to Y2K threshold because sample-
    // session.json events carry relative times (`time: 1000, 1050, …`) that
    // still rendered "12/31/1969, 16:00" under the earlier `<= 0` guard.
    if (t < 946684800000 /* 2000-01-01 UTC */) return '—'
    try { return new Date(t).toLocaleString() } catch (_) { return String(t) }
  }
  if (typeof t === 'string') return t
  return ''
}

// ---- Raw badge (L2 drawer link) ----------------------------------------
function buildRawBadgeFor(doc, raw) {
  if (!raw) return null
  const btn = doc.createElement('button')
  btn.type = 'button'
  btn.className = 'tool-json-badge trace-detail-raw-badge'
  btn.textContent = '{ }'
  btn.title = 'Show raw JSON (this event)'
  if (btn.setAttribute) btn.setAttribute('aria-label', 'Show raw JSON')
  btn.addEventListener('click', (e) => {
    if (e && e.stopPropagation) e.stopPropagation()
    if (e && e.preventDefault) e.preventDefault()
    const tc = typeof window !== 'undefined' ? window.__dshToolCards : null
    if (tc && typeof tc.openJsonDrawer === 'function') {
      const label = raw && raw.type ? String(raw.type) : 'event'
      tc.openJsonDrawer({ title: label, call: null, result: raw })
    }
  })
  return btn
}

// ---- exports ------------------------------------------------------------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildDetailPane,
    attributesRows,
    attributesGroups,
    outputRows,
    inputRows,
    feedbackRows,
    buildFeedbackDimChip,
    detectRecordError,
    resolveTabOrder,
    buildJsonTree,
    buildRawFieldsSubtree,
    buildOutputRow,
    buildMessageRow,
    reasoningRows,
    openFeedbackPopover,
    formatTime,
    TAB_ORDER,
    TAB_LABELS,
  }
}
if (typeof window !== 'undefined') {
  window.__dshTraceDetailPane = {
    buildDetailPane,
    attributesRows,
    attributesGroups,
    outputRows,
    inputRows,
    feedbackRows,
    buildFeedbackDimChip,
    detectRecordError,
    resolveTabOrder,
    buildJsonTree,
    buildRawFieldsSubtree,
    buildOutputRow,
    buildMessageRow,
    reasoningRows,
    openFeedbackPopover,
    formatTime,
    TAB_ORDER,
    TAB_LABELS,
  }
}

})()
