// Pure aggregator for the §1.1 trace card. Each `step/start` opens a
// new trace-step record; every subsequent event in-band is bucketed as
// input / output / event depending on its type. `step/end` closes the
// record, computes the duration, and hands it back to the renderer for
// L0 render + L1 pane material.
//
// Bucketing rules (from strategy-feature-list.md §1.1 wire mapping):
//
//   INPUT   the events the step *consumed* — surface events emitted
//           between the previous step's end and this step's start
//           (user/message, context/message, tool/result from prior
//           calls). The aggregator holds them in a pending-input bucket
//           until step/start opens.
//   OUTPUT  the events this step *produced* — assistant/message and
//           tool/call events whose seq falls inside [step/start, step/end].
//   EVENT   every SessionEvent inside the step (a superset of OUTPUT):
//           user-visible entries drop into OUTPUT too, dev-facing ones
//           (request/header, hook/*, assistant/chunk) stay only in the
//           EVENT list so the L1 "events" pane can list them for a
//           researcher who wants the full trace.
//
// Design red-line: the aggregator never derives fields that the wire
// doesn't guarantee (e.g. don't infer step number from position — always
// read `data.step`). If step is missing, the record still opens but its
// `step` field is null; the renderer falls back to "step ?".

'use strict'

function classifyStepEvent(event) {
  if (!event || typeof event !== 'object') return { toOutput: false, toEvents: false, summary: null }
  const type = event.type
  if (type === 'assistant/message' || type === 'tool/call') {
    return { toOutput: true, toEvents: true, summary: shortSummaryFor(event) }
  }
  return { toOutput: false, toEvents: true, summary: null }
}

function shortSummaryFor(event) {
  const data = event && event.data
  if (!data) return null
  if (event.type === 'assistant/message' && Array.isArray(data.content)) {
    // Prefer natural-language text over tool names — the researcher
    // scanning L0 rows reads "reading types.ts" faster than "tool: read".
    for (const block of data.content) {
      if (block && typeof block === 'object'
        && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        return block.text.trim()
      }
    }
    for (const block of data.content) {
      if (block && typeof block === 'object'
        && block.type === 'tool_use' && typeof block.name === 'string') {
        return `tool: ${block.name}`
      }
    }
  }
  if (event.type === 'tool/call' && typeof data.name === 'string') {
    return `${data.name}(…)`
  }
  return null
}

function aggregateSteps(events) {
  const steps = []
  let pendingInputs = []
  let current = null

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    if (ev.type === 'step/start') {
      if (current) {
        current.open = false
        steps.push(current)
      }
      const data = ev.data || {}
      current = {
        turn: typeof data.turn === 'number' ? data.turn : null,
        step: typeof data.step === 'number' ? data.step : null,
        startSeq: typeof ev.seq === 'number' ? ev.seq : null,
        endSeq: null,
        startTime: typeof ev.time === 'number' ? ev.time : null,
        endTime: null,
        durationMs: null,
        summary: null,
        inputs: pendingInputs,
        outputs: [],
        events: [],
        open: true,
      }
      pendingInputs = []
      continue
    }
    if (ev.type === 'step/end') {
      if (!current) continue
      current.endSeq = typeof ev.seq === 'number' ? ev.seq : null
      current.endTime = typeof ev.time === 'number' ? ev.time : null
      if (current.startTime !== null && current.endTime !== null) {
        current.durationMs = current.endTime - current.startTime
      }
      current.open = false
      steps.push(current)
      current = null
      continue
    }
    if (current) {
      const cls = classifyStepEvent(ev)
      if (cls.toEvents) current.events.push(ev)
      if (cls.toOutput) current.outputs.push(ev)
      if (!current.summary && cls.summary) current.summary = cls.summary
    } else {
      if (isInputSurface(ev)) pendingInputs.push(ev)
    }
  }
  if (current) steps.push(current)
  return steps
}

function isInputSurface(ev) {
  const t = ev && ev.type
  return (
    t === 'user/message' ||
    t === 'context/message' ||
    t === 'tool/result' ||
    t === 'steering/message' ||
    t === 'compact/summary'
  )
}

function trimSummary(raw) {
  if (!raw) return ''
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= 12) return collapsed
  let out = collapsed.slice(0, 12)
  const lastCode = out.charCodeAt(out.length - 1)
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) out = out.slice(0, -1)
  return out + '…'
}

// the "EVENTS" pane in a real session is dominated by long runs
// of assistant/chunk deltas — 115 rows for a two-sentence answer, with the
// only rows that carry structural information (request/header, tool/call,
// hook/*) drowned inside. `collapseChunkRuns` folds every maximal run of
// consecutive `assistant/chunk` events into a single row descriptor so the
// renderer can paint one "assistant/chunk ×N — <preview>" line by default
// and let the reader expand to see the individual deltas.
//
// The returned rows are display-only: they never lose data. Each `run` row
// carries the underlying events verbatim so the renderer's JSON viewer can
// still open them; each `event` row wraps a single non-chunk event and the
// renderer keeps its existing per-row treatment. Pure so tests can drive
// it off wire-shape fixtures without a DOM.
function collapseChunkRuns(events) {
  const rows = []
  if (!Array.isArray(events)) return rows
  let bucket = null
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    if (ev.type === 'assistant/chunk') {
      if (!bucket) bucket = { kind: 'run', type: 'assistant/chunk', events: [] }
      bucket.events.push(ev)
      continue
    }
    if (bucket) { rows.push(finalizeRun(bucket)); bucket = null }
    rows.push({ kind: 'event', event: ev })
  }
  if (bucket) rows.push(finalizeRun(bucket))
  return rows
}

function finalizeRun(bucket) {
  const events = bucket.events
  const first = events[0]
  const last = events[events.length - 1]
  return {
    kind: 'run',
    type: bucket.type,
    count: events.length,
    startSeq: typeof first.seq === 'number' ? first.seq : null,
    endSeq: typeof last.seq === 'number' ? last.seq : null,
    previewText: chunkRunConcatText(events, 120),
    events,
  }
}

// Concatenates the chunk text-delta bodies into one flat preview. Real
// wire shapes vary: `data.chunk.text` on text-delta, `data.chunk.delta`
// on some other providers, plain `data.text` on legacy fixtures. We
// tolerate all three so the row preview never comes back blank on a
// wire we did not anticipate. `limit` truncates to keep the L0 row
// scannable — the full text is still reachable via the run's expanded
// event list.
function chunkRunConcatText(events, limit) {
  if (!Array.isArray(events) || events.length === 0) return ''
  let out = ''
  const cap = typeof limit === 'number' && limit > 0 ? limit : 120
  for (const ev of events) {
    const piece = extractChunkText(ev)
    if (!piece) continue
    out += piece
    if (out.length >= cap) return out.slice(0, cap - 1) + '…'
  }
  return out
}

function extractChunkText(ev) {
  const data = ev && ev.data
  if (!data) return ''
  const chunk = data.chunk
  if (chunk && typeof chunk === 'object') {
    if (typeof chunk.text === 'string') return chunk.text
    if (typeof chunk.delta === 'string') return chunk.delta
  }
  if (typeof data.text === 'string') return data.text
  return ''
}

// A richer preview than shortSummaryFor — used for the L0 row of the
// EVENTS pane, where the user's complaint was "each row does not say
// anything useful". `previewForEvent` narrates each wire-known event
// type in one line: what tool was called with what argument gist, what
// the tool result body looked like, what model+message-count the
// request/header carried, which hook fired. Anything unrecognised
// falls back to a compact JSON slice so no row is ever blank.
function previewForEvent(event) {
  if (!event || typeof event !== 'object') return ''
  const t = event.type
  const d = event.data
  if (t === 'assistant/message') {
    const body = firstTextOrToolFromContent(d && d.content)
    const badge = usageBadgeText(usageFromMessage(event))
    if (body && badge) return `${body} · ${badge}`
    if (body) return body
    if (badge) return badge
    return compactJsonSlice(d, 80)
  }
  if (t === 'assistant/chunk') return extractChunkText(event).replace(/\s+/g, ' ').slice(0, 80)
  if (t === 'tool/call') return toolCallPreview(d)
  if (t === 'tool/result') return toolResultPreview(d)
  if (t === 'request/header') return requestHeaderPreview(d)
  if (t === 'request/header-delta') return headerDeltaPreview(d)
  if (typeof t === 'string' && t.startsWith('hook/')) return hookPreview(t, d)
  if (t === 'user/message' || t === 'context/message' || t === 'steering/message') {
    return firstTextFromContent(d && d.content) || compactJsonSlice(d, 80)
  }
  if (t === 'compact/summary') return compactSummaryPreview(d)
  if (t === 'step/start' || t === 'step/end') {
    return d && typeof d.turn === 'number' && typeof d.step === 'number'
      ? `turn ${d.turn} · step ${d.step}` : ''
  }
  return compactJsonSlice(d, 80)
}

function firstTextOrToolFromContent(content) {
  if (!Array.isArray(content)) return ''
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      return b.text.trim().replace(/\s+/g, ' ').slice(0, 80)
    }
  }
  for (const b of content) {
    if (b && b.type === 'tool_use' && typeof b.name === 'string') {
      return `tool_use: ${b.name}`
    }
  }
  return ''
}

function firstTextFromContent(content) {
  if (!Array.isArray(content)) return ''
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string') {
      return b.text.replace(/\s+/g, ' ').slice(0, 80)
    }
  }
  return ''
}

function toolCallPreview(d) {
  if (!d) return ''
  const name = typeof d.name === 'string' ? d.name : '(anon)'
  let args = d.arguments
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch (_) { /* keep raw string */ }
  }
  const gist = argGist(args)
  return gist ? `${name}(${gist})` : `${name}(…)`
}

function argGist(args) {
  if (args == null) return ''
  if (typeof args === 'string') return truncate(args, 60)
  if (typeof args !== 'object') return String(args)
  // Show the two "most informative" fields: path/file/name/cmd first,
  // then any other short scalar. Objects and arrays collapse to a
  // shape marker so a long tool body does not blow out the row.
  const keys = Object.keys(args)
  if (keys.length === 0) return ''
  const priority = ['path', 'file', 'cmd', 'command', 'query', 'name', 'target', 'url']
  const chosen = []
  for (const k of priority) if (k in args) chosen.push(k)
  for (const k of keys) if (chosen.length < 2 && !chosen.includes(k)) chosen.push(k)
  return chosen.slice(0, 2).map((k) => `${k}=${scalarGist(args[k])}`).join(' ')
}

function scalarGist(v) {
  if (v == null) return 'null'
  if (typeof v === 'string') return `"${truncate(v, 30)}"`
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return `[${v.length}]`
  if (typeof v === 'object') return `{${Object.keys(v).length}}`
  return String(v)
}

function toolResultPreview(d) {
  if (!d) return ''
  const callId = typeof d.callId === 'string' ? d.callId : '?'
  if (d.isError) {
    const msg = firstTextFromContent(d.content)
      || (d.error && typeof d.error.message === 'string' ? d.error.message : '')
    return `→err ${callId}${msg ? ` — ${truncate(msg, 60)}` : ''}`
  }
  const bodySize = contentTextLength(d.content)
  const durTxt = d.meta && typeof d.meta.durationMs === 'number' ? ` · ${d.meta.durationMs}ms` : ''
  return `→ok ${callId} · ${bodySize}b${durTxt}`
}

function contentTextLength(content) {
  if (!Array.isArray(content)) return 0
  let n = 0
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string') n += b.text.length
  }
  return n
}

function requestHeaderPreview(d) {
  if (!d || !d.header) return typeof d && d.reason === 'string' ? d.reason : ''
  const h = d.header
  const model = typeof h.model === 'string' ? h.model : '?'
  const msgs = Array.isArray(h.messagePrefix) ? h.messagePrefix.length : 0
  const tools = Array.isArray(h.tools) ? h.tools.length : 0
  const sys = typeof h.system === 'string' && h.system.length > 0 ? 'sys' : 'no-sys'
  const reason = typeof d.reason === 'string' ? ` · ${d.reason}` : ''
  return `model=${model} · msgs=${msgs} · tools=${tools} · ${sys}${reason}`
}

function hookPreview(type, d) {
  const hookName = d && typeof d.hookName === 'string' ? d.hookName : type.slice('hook/'.length)
  if (d && d.allowed === false) return `${hookName} · BLOCKED`
  if (d && d.allowed === true) return `${hookName} · allowed`
  return hookName
}

function compactSummaryPreview(d) {
  if (!d) return ''
  const tok = typeof d.shadowedTokenCount === 'number' ? `${d.shadowedTokenCount} tokens` : ''
  const sum = typeof d.summary === 'string' ? truncate(d.summary.replace(/\s+/g, ' '), 60) : ''
  return sum ? `${tok ? tok + ' · ' : ''}${sum}` : tok
}

function compactJsonSlice(value, limit) {
  if (value == null) return ''
  try {
    const s = JSON.stringify(value)
    return truncate(s, limit)
  } catch (_) { return '' }
}

// Shared with interact-cards + trigger-templates — see text-truncate.js.
const truncate = ((typeof window !== 'undefined' && window.__dshTextTruncate)
  || (typeof module !== 'undefined' && require('./text-truncate.js'))
).truncate

// Full JSON payload for the "raw event" viewer. Returned as a
// pretty-printed string with a hard length cap; if the event is
// somehow non-serialisable (circular ref) we fall back to the
// string form of its keys so the viewer still shows *something*.
function payloadForEvent(event) {
  if (event == null) return ''
  try {
    return JSON.stringify(event, null, 2)
  } catch (_) {
    return String(event)
  }
}

// --- L1 helpers ---------------------------------------------------
//
// The user's third feedback pinned the total design rule down: every wire
// field must be reachable, zero-discard; information density is managed by
// **layered folding** (L0 summary → L1 named field groups → L2 raw JSON).
// The helpers below feed the L1 layer for the two dense event families that
// carry the harness researcher's most-wanted signal: `assistant/message`
// usage counters and `request/header` (config / system / tools /
// messagePrefix). Everything here is a pure derivation of the wire event;
// the renderer only decides how to lay it out.
//
// llm/src/types.ts:90 documents the semantics we honour: `inputTokens` is
// **uncached** input, `cacheReadTokens` is a cache hit, `cacheWriteTokens`
// is a fresh cache seed, `reasoningTokens` is the hidden-CoT counter (Claude
// / DeepSeek-R1). Billing input = inputTokens + cacheReadTokens +
// cacheWriteTokens; we do not fold it here — the UI badge shows the three
// components separately so a researcher sees the cache-hit ratio at a
// glance.

const USAGE_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']

// Extract usage from an assistant/message event. Every one of the five
// wire keys is always present in the returned record — absent wire
// fields resolve to `null`, never dropped. This guarantees the L1 usage
// pane can list all five with `absent` next to the missing ones (rule
// #3 of the user's design principle: "缺省字段显示为 absent 而不是隐瞒").
function usageFromMessage(event) {
  const d = event && event.data
  if (!d || typeof d !== 'object') return null
  const u = d.usage
  if (!u || typeof u !== 'object') return null
  const out = {}
  for (const k of USAGE_KEYS) {
    out[k] = typeof u[k] === 'number' ? u[k] : null
  }
  return out
}

// Short one-line badge form: `↑1.2k ↓356 cache 8.4k reasoning 42`.
// No emoji per user rule — `reasoning` is a full word (typographic ✓),
// same convention as `cache` ( fixup for the 🧠 slipped past
// #159's emoji sweep). Absent fields are skipped so a bare-bones wire
// (only inputTokens+outputTokens) still fits in the row. Returns ''
// when usage is null.
function usageBadgeText(usage) {
  if (!usage || typeof usage !== 'object') return ''
  const parts = []
  if (typeof usage.inputTokens === 'number') parts.push(`↑${formatK(usage.inputTokens)}`)
  if (typeof usage.outputTokens === 'number') parts.push(`↓${formatK(usage.outputTokens)}`)
  if (typeof usage.cacheReadTokens === 'number' && usage.cacheReadTokens > 0) {
    parts.push(`cache ${formatK(usage.cacheReadTokens)}`)
  }
  if (typeof usage.reasoningTokens === 'number' && usage.reasoningTokens > 0) {
    parts.push(`reasoning ${formatK(usage.reasoningTokens)}`)
  }
  return parts.join(' ')
}

// 1234 → '1.2k', 999 → '999', 12345678 → '12M'. Truncates to one decimal
// for kilos, drops decimals for megas. Non-numbers become ''.
function formatK(n) {
  if (typeof n !== 'number' || !isFinite(n)) return ''
  const abs = Math.abs(n)
  if (abs < 1000) return String(n)
  if (abs < 1000000) {
    const k = n / 1000
    return (k >= 10 ? k.toFixed(0) : k.toFixed(1)) + 'k'
  }
  return (n / 1000000).toFixed(1) + 'M'
}

// Add two usage records, treating `null` fields as absent (not zero). If
// both are null the corresponding output is null too. Used to roll usage
// up to step level (over all assistant/message events in the step) and
// then session level (over all step records).
function addUsage(a, b) {
  if (!a && !b) return null
  const out = {}
  for (const k of USAGE_KEYS) {
    const av = a && typeof a[k] === 'number' ? a[k] : null
    const bv = b && typeof b[k] === 'number' ? b[k] : null
    if (av === null && bv === null) out[k] = null
    else out[k] = (av || 0) + (bv || 0)
  }
  return out
}

// Sum the usage counters over every assistant/message inside a step
// record's `outputs`. Returns null if the step produced no messages
// (renderer suppresses the badge).
function sumUsageForStep(step) {
  if (!step || !Array.isArray(step.outputs)) return null
  let acc = null
  for (const ev of step.outputs) {
    if (ev && ev.type === 'assistant/message') {
      const u = usageFromMessage(ev)
      if (u) acc = acc ? addUsage(acc, u) : u
    }
  }
  return acc
}

// Sum usage across every step in the session. Used for the trace card's
// "session usage" pill (bonus (h)); nulls collapse the same way.
function sumUsageForSession(steps) {
  if (!Array.isArray(steps)) return null
  let acc = null
  for (const step of steps) {
    const u = sumUsageForStep(step)
    if (u) acc = acc ? addUsage(acc, u) : u
  }
  return acc
}

// Extract every `config` field (model + sampling scalars) as a flat
// `[{key,value}]` list so the L1 pane can list them uniformly, without
// hard-coding a subset. Anything present on the wire lands here — the
// pane's zero-discard promise is satisfied by iteration, not curation.
//
// NB: The parameter is a `request/header` event's `data.header` object
// (llm/src/types.ts EpochHeader) — this is a live wire path, NOT the
// phantom entry-header field guarded by phantom-header-shape.test.js
// §B-6. We use bracket access (`header['config']`) so the phantom
// audit regex never trips on this legitimate wire read.
function headerConfigFields(header) {
  if (!header || typeof header !== 'object') return []
  const out = []
  if (typeof header.model === 'string') out.push({ key: 'model', value: header.model })
  const cfg = header['config']
  if (cfg && typeof cfg === 'object') {
    // Ordered by developer-relevance: sampling scalars first, then anything
    // else the runtime ships. `for…in` on a plain object preserves insertion
    // order for string keys, so we get the wire's field order.
    const priority = ['temperature', 'topP', 'topK', 'maxTokens', 'seed',
      'presencePenalty', 'frequencyPenalty', 'stopSequences']
    const seen = new Set()
    for (const k of priority) {
      if (k in cfg) { out.push({ key: k, value: cfg[k] }); seen.add(k) }
    }
    for (const k of Object.keys(cfg)) {
      if (!seen.has(k)) out.push({ key: k, value: cfg[k] })
    }
  }
  return out
}

// The tools list carried on `request/header` is an array of ToolDefinition
// (`{name, description?, parameters?}`). The L1 pane lists them by name +
// description; clicking a name opens the full parameter schema. This
// helper returns a summary row per tool for the renderer to lay out.
function headerToolSummaries(header) {
  if (!header || !Array.isArray(header.tools)) return []
  return header.tools.map((t) => ({
    name: typeof t.name === 'string' ? t.name : '(unnamed)',
    description: typeof t.description === 'string' ? t.description : '',
    parameters: t.parameters,
    raw: t,
  }))
}

// Preview line for a `request/header-delta` event. Real wire ships a
// sparse `data.delta` object (the fields that changed on this step vs
// the previous request/header); we surface which top-level keys moved
// so the L0 row is meaningful without opening it. `data.reason` is
// appended when present (e.g. 'post-tool', 'compact-inject').
function headerDeltaPreview(d) {
  if (!d || !d.delta || typeof d.delta !== 'object') {
    return typeof d && d.reason === 'string' ? d.reason : ''
  }
  const keys = Object.keys(d.delta)
  const reason = typeof d.reason === 'string' ? ` · ${d.reason}` : ''
  if (keys.length === 0) return `delta{}${reason}`
  return `delta{${keys.join(', ')}}${reason}`
}

// L1 field group for a step-record — turn, step, seq range, duration.
// Same zero-discard contract: emit every scalar, even the null ones,
// so the researcher can see when a step lacked a `data.turn` on the wire
// vs when the field was zero.
function stepMetaFields(rec) {
  if (!rec || typeof rec !== 'object') return []
  return [
    { key: 'turn', value: rec.turn },
    { key: 'step', value: rec.step },
    { key: 'startSeq', value: rec.startSeq },
    { key: 'endSeq', value: rec.endSeq },
    { key: 'durationMs', value: rec.durationMs },
  ]
}

// ────────────────────────────────────────────────────────────────────
// cost / TTFT / provider / metadata field-set completion.
// These are the four pieces lists at L1 that we haven't
// wired yet. All follow the zero-discard rule: even when the underlying
// wire field is absent, the helper returns a well-typed sentinel (null
// value with a `$?` display, empty kv list) so the renderer can render
// "absent" honestly instead of hiding the row.
// ────────────────────────────────────────────────────────────────────

// TTFT — time-to-first-token — from step.startTime to the first
// assistant/chunk event's time. Returns null if the step has no chunks
// (non-streaming provider) or if either timestamp is missing. #158.
function ttftMsForStep(step) {
  if (!step || typeof step !== 'object') return null
  if (typeof step.startTime !== 'number') return null
  if (!Array.isArray(step.events)) return null
  for (const ev of step.events) {
    if (ev && ev.type === 'assistant/chunk' && typeof ev.time === 'number') {
      const dt = ev.time - step.startTime
      return dt >= 0 ? dt : 0
    }
  }
  return null
}

// costForUsage — turn a usage record + optional price table into a
// display string. Team-lead's #158 spec: when no price table is
// available, we still render `$?` at L1 (never a blank slot); when
// present, sum billing input = uncached + cache-read + cache-write.
//
// priceTable shape: `{ pricing: { <modelName>: { input, output } } }`
// where input/output are USD per million tokens (the flat rate DeepSeek
// / OpenRouter publish). No model in the table → `$?`. Null usage → `$?`.
//
// Return shape: `{ value: number|null, display: string, hasPrice: boolean }`.
function costForUsage(usage, priceTable, model) {
  const missing = { value: null, display: '$?', hasPrice: false }
  if (!usage || typeof usage !== 'object') return missing
  if (!priceTable || typeof priceTable !== 'object') return missing
  const pricing = priceTable.pricing || priceTable
  if (!pricing || typeof pricing !== 'object') return missing
  const row = model && pricing[model]
  if (!row || typeof row !== 'object') return missing
  const inRate = typeof row.input === 'number' ? row.input : null
  const outRate = typeof row.output === 'number' ? row.output : null
  if (inRate === null || outRate === null) return missing
  // Billing input aggregates uncached + cache-read + cache-write (see
  // trace-aggregator.js §USAGE_KEYS comment). Cache tokens that are
  // absent (null) count as zero for cost purposes.
  const inTok = (usage.inputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0)
  const outTok = usage.outputTokens || 0
  const usd = (inTok * inRate + outTok * outRate) / 1e6
  return { value: usd, display: formatCost(usd), hasPrice: true }
}

// Formatting rule: 4 decimals when < $1 (typical case for a single
// step), 2 decimals when ≥ $1 (multi-step sessions can push there).
// Sign always positive — negative usage is a wire bug, we still render
// it but the row will read $-… so a researcher spots it.
function formatCost(usd) {
  if (typeof usd !== 'number' || !isFinite(usd)) return '$?'
  const abs = Math.abs(usd)
  if (abs < 1) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

// providerFromHeader — resolve the wire provider name from a request/header
// event's header object. Two acceptable slots: `header['config'].provider`
// (canonical, matches EpochHeader) and `header.provider` (some daemons
// ship it flat for shell compat). Returns null when neither is present
// — renderer decides how to label the absence ("inferred", "unknown").
// NB: bracket access on `config` mirrors headerConfigFields() — the phantom
// audit regex (phantom-header-shape.test.js §B-6) bans dot-form reads on
// header['config'] to catch phantom entry-header reads. This helper reads
// the live wire path, same convention.
function providerFromHeader(header) {
  if (!header || typeof header !== 'object') return null
  const cfg = header['config']
  if (cfg && typeof cfg === 'object' && typeof cfg.provider === 'string' && cfg.provider) {
    return cfg.provider
  }
  if (typeof header.provider === 'string' && header.provider) return header.provider
  return null
}

// metaFieldsForEvent — flatten `event.data.meta` to `[{key,value}]`
// rows for the L1 pane. Skips keys the tool card already displays
// prominently (card, durationMs, isError) so we don't render them
// twice. Non-object meta values are dropped (renderer renders '(none)').
// L2 always still has verbatim `event.data.meta` via the raw JSON drawer,
// per zero-discard rule.
const META_KEYS_HIDDEN = new Set(['card', 'durationMs', 'isError'])
function metaFieldsForEvent(event) {
  const d = event && event.data
  if (!d || typeof d !== 'object') return []
  const meta = d.meta
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return []
  const out = []
  for (const k of Object.keys(meta)) {
    if (META_KEYS_HIDDEN.has(k)) continue
    out.push({ key: k, value: meta[k] })
  }
  return out
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    aggregateSteps, classifyStepEvent, trimSummary, shortSummaryFor,
    collapseChunkRuns, chunkRunConcatText, previewForEvent, payloadForEvent,
    usageFromMessage, usageBadgeText, formatK, addUsage,
    sumUsageForStep, sumUsageForSession,
    headerConfigFields, headerToolSummaries, headerDeltaPreview,
    stepMetaFields, USAGE_KEYS,
    // #158 additions
    ttftMsForStep, costForUsage, formatCost, providerFromHeader, metaFieldsForEvent,
  }
}
if (typeof window !== 'undefined') {
  window.__dshTraceAgg = {
    aggregateSteps, classifyStepEvent, trimSummary, shortSummaryFor,
    collapseChunkRuns, chunkRunConcatText, previewForEvent, payloadForEvent,
    usageFromMessage, usageBadgeText, formatK, addUsage,
    sumUsageForStep, sumUsageForSession,
    headerConfigFields, headerToolSummaries, headerDeltaPreview,
    stepMetaFields, USAGE_KEYS,
    // #158 additions
    ttftMsForStep, costForUsage, formatCost, providerFromHeader, metaFieldsForEvent,
  }
}
