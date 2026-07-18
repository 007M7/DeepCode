(function () {
// Pure functions for the Devtools event side panel (P2 audit — devtools-panel
// lane). Runs under both `node --test` (CJS require) and the classic-script
// loader in the renderer (globalThis attach). No DOM, no timers, no protocol
// dependency — the controller layer (`devtools-panel.js`) wraps these.
//
// The devtools view captures the raw `session.event` notification stream so
// dev-facing families that today spam the chat (`hook/invoked`, `hook/result`,
// `request/header*`, `approval/*`, `permission/*`, `bash/sandbox-mode`,
// `step/*`, `tool/code-dispatch`, etc.) have a single log with a filter chip
// row. This is the user-visible manifestation of the shell's "model-visible
// ⟺ logged" audit contract: every event the runtime shipped over the wire
// shows up here, whether or not it has a dedicated chat surface.
//
// Ring buffer cap: 500 entries by default. Overflow drops the oldest so a
// long-lived session doesn't leak memory. UI shows the buffer occupancy.
//
// See docs/capability-ui-coverage.md P2-1 for the audit row that drove this.

'use strict'

// -- constants ---------------------------------------------------------------

/** Default ring-buffer capacity. Chosen by the task brief. */
const DEFAULT_CAP = 500

/**
 * Preset filter recipes. Each entry is a list of "glob-lite" patterns —
 * either an exact event type ("bash/sandbox-mode") or a prefix ending in
 * `/*` ("approval/*"). Matched by {@link matchesPreset}.
 *
 * Preset names are UI-facing labels; keep them stable, the controller writes
 * them to `data-preset` attributes on the chip buttons.
 */
const PRESETS = Object.freeze({
  All:       [], // empty = no restriction
  Approvals: ['approval/*', 'permission/*'],
  Hooks:     ['hook/*'],
  Requests:  ['request/header', 'request/header-delta'],
})

/**
 * Surface classification labels — a three-way partition of every buffered
 * event. Consumed by the filter chips and the coloured left-border in the
 * event list. Ordering here matches the chip render order.
 */
const SURFACES = Object.freeze(['current', 'shadowed', 'log-only'])

/**
 * Event-type patterns that never render on the chat surface. Matched with
 * the same "exact or `prefix/*`" semantics as {@link matchesPreset}.
 *
 * The list mirrors the audit families the Devtools panel already covers in
 * its preset chips: hooks, approvals, request/header, sandbox mode, code
 * dispatch, and step/* runtime bookkeeping. New audit families added to the
 * wire should land here so the surface partition stays honest.
 */
const LOG_ONLY_PATTERNS = Object.freeze([
  'hook/*',
  'approval/*',
  'permission/*',
  'request/header',
  'request/header-delta',
  'bash/sandbox-mode',
  'step/*',
  'tool/code-dispatch',
])

// -- ring buffer -------------------------------------------------------------

/**
 * Create an empty buffer. Consumers hold the returned object and pass it back
 * into {@link addEvent}/{@link getAll}; nothing mutates it externally.
 *
 * @param {number} [cap]  Max entries kept. Overflow evicts oldest.
 * @returns {{ cap: number, entries: Array<object>, nextId: number }}
 */
function createBuffer(cap = DEFAULT_CAP) {
  const n = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : DEFAULT_CAP
  return { cap: n, entries: [], nextId: 1 }
}

/**
 * Push a normalized entry into the buffer. Returns the entry (with `id`
 * stamped). Overflow drops the oldest.
 *
 * The entry shape is {@link normalizeEntry}'s return type; callers may pass
 * either a raw `{sessionId, event}` pair or a pre-normalized entry.
 *
 * @param {{cap: number, entries: Array, nextId: number}} buffer
 * @param {{sessionId: string, event: object}} input
 * @returns {object}  the stored entry
 */
function addEvent(buffer, input) {
  const entry = normalizeEntry(input, buffer.nextId)
  buffer.nextId += 1
  buffer.entries.push(entry)
  // Evict from the front; small-N shift is fine at cap=500.
  while (buffer.entries.length > buffer.cap) buffer.entries.shift()
  return entry
}

/** Snapshot of the buffer (fresh array; caller may mutate). */
function getAll(buffer) {
  return buffer.entries.slice()
}

/** Clear entries (id counter is preserved so ids remain unique across clears). */
function clearBuffer(buffer) {
  buffer.entries.length = 0
}

/**
 * Normalize a `{sessionId, event}` pair into the entry shape stored in the
 * buffer. Defensive on both sides: an event with no `type` becomes
 * `'(unknown)'`, and missing `time` falls back to `Date.now()` so the UI
 * can always sort/display.
 *
 * @param {object} input      raw `{sessionId, event}` pair
 * @param {number} id         monotonically increasing id assigned by caller
 */
function normalizeEntry(input, id) {
  const sessionId = input && typeof input.sessionId === 'string' ? input.sessionId : ''
  const event = input && input.event && typeof input.event === 'object' ? input.event : {}
  const type = typeof event.type === 'string' && event.type ? event.type : '(unknown)'
  const time = Number.isFinite(event.time) ? event.time : Date.now()
  const seq = Number.isFinite(event.seq) ? event.seq : null
  return { id, time, sessionId, type, seq, event }
}

// -- filtering ---------------------------------------------------------------

/**
 * Check if an event type matches a preset name.
 *
 * Pattern semantics:
 *   - `"foo/bar"`  → exact match
 *   - `"foo/*"`    → prefix match on `"foo/"` (matches `"foo/bar"` etc.)
 *
 * An unknown preset name is treated as `All` (no restriction).
 *
 * @param {string} type
 * @param {string} preset  key of {@link PRESETS}
 */
function matchesPreset(type, preset) {
  const patterns = PRESETS[preset]
  if (!patterns || patterns.length === 0) return true
  return patterns.some((p) => matchesPattern(type, p))
}

/** Single pattern match: exact or `prefix/*`. */
function matchesPattern(type, pattern) {
  if (typeof type !== 'string' || typeof pattern !== 'string') return false
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -1) // keep trailing slash
    return type.startsWith(prefix)
  }
  return type === pattern
}

/**
 * Filter entries against a preset + explicit type set + surface set + text
 * query. All four filters compose (AND). Empty sets = no restriction on that
 * axis (same convention across types and surfaces).
 *
 * Text search matches the type, sessionId, or the pretty-printed JSON of the
 * event (case-insensitive substring).
 *
 * `shadowedSeqs` lets the caller pre-compute the compact-shadow set once per
 * render (via {@link buildShadowedSet}) and pass it in, so the surface
 * classification per-entry stays O(1).
 *
 * @param {Array<object>} entries
 * @param {{preset?: string, types?: Set<string>|Array<string>, surfaces?: Set<string>|Array<string>, shadowedSeqs?: Set<number>, text?: string}} opts
 * @returns {Array<object>}
 */
function filterEntries(entries, opts = {}) {
  const preset = opts.preset || 'All'
  const typeSet = opts.types instanceof Set
    ? (opts.types.size > 0 ? opts.types : null)
    : (Array.isArray(opts.types) && opts.types.length > 0 ? new Set(opts.types) : null)
  const surfaceSet = opts.surfaces instanceof Set
    ? (opts.surfaces.size > 0 ? opts.surfaces : null)
    : (Array.isArray(opts.surfaces) && opts.surfaces.length > 0 ? new Set(opts.surfaces) : null)
  const shadowed = opts.shadowedSeqs instanceof Set ? opts.shadowedSeqs : null
  const q = typeof opts.text === 'string' ? opts.text.trim().toLowerCase() : ''
  const out = []
  for (const e of entries) {
    if (!matchesPreset(e.type, preset)) continue
    if (typeSet && !typeSet.has(e.type)) continue
    if (surfaceSet && !surfaceSet.has(deriveSurface(e.event || e, shadowed))) continue
    if (q && !matchesText(e, q)) continue
    out.push(e)
  }
  return out
}

/**
 * Classify a single event into its surface bucket.
 *
 * Rules (checked in order):
 *   1. If the server has stamped `event.surface` — forward-compat with the
 *      sq-meta ticket that promises it — trust that.
 *   2. If the event type matches any {@link LOG_ONLY_PATTERNS} entry, the
 *      event never rendered on the chat surface → `'log-only'`.
 *   3. Otherwise, if `event.seq` is in the compact-shadow set, the event
 *      was on-surface once but has since been replaced by a compact summary
 *      → `'shadowed'`.
 *   4. Otherwise → `'current'` (default, still-visible chat surface).
 *
 * @param {object} event  the wire event (may be a raw event or a normalized
 *                        buffer entry — this reads `type`/`seq`/`surface`)
 * @param {Set<number>|null|undefined} shadowedSeqs  seqs replaced by compacts
 * @returns {'current'|'shadowed'|'log-only'}
 */
function deriveSurface(event, shadowedSeqs) {
  if (!event || typeof event !== 'object') return 'current'
  if (typeof event.surface === 'string' && SURFACES.includes(event.surface)) return event.surface
  const type = typeof event.type === 'string' ? event.type : ''
  if (isLogOnly(type)) return 'log-only'
  if (shadowedSeqs && Number.isFinite(event.seq) && shadowedSeqs.has(event.seq)) return 'shadowed'
  return 'current'
}

function isLogOnly(type) {
  if (!type) return false
  return LOG_ONLY_PATTERNS.some((p) => matchesPattern(type, p))
}

/**
 * Walk a buffer of normalized entries and gather every seq referenced by a
 * `compact/*` event's `shadowedSeqs` array — that's the set of seqs that
 * the compact replaced on the chat surface. Callers pass the result into
 * {@link deriveSurface} (or `filterEntries({shadowedSeqs})`) so surface
 * classification stays O(1) per entry.
 *
 * @param {Array<object>} entries  buffered entries (from {@link getAll})
 * @returns {Set<number>}
 */
function buildShadowedSet(entries) {
  const s = new Set()
  for (const e of entries) {
    const t = typeof e.type === 'string' ? e.type : ''
    if (!t.startsWith('compact/')) continue
    const seqs = e && e.event && Array.isArray(e.event.shadowedSeqs) ? e.event.shadowedSeqs : null
    if (!seqs) continue
    for (const q of seqs) if (Number.isFinite(q)) s.add(q)
  }
  return s
}

/**
 * Three-way tally: how many buffered entries land in each surface bucket.
 * Used by the surface filter chip badges so a reader can see "there are 42
 * log-only events I'm hiding right now" at a glance.
 *
 * @param {Array<object>} entries
 * @param {Set<number>|null} shadowedSeqs
 * @returns {{current: number, shadowed: number, 'log-only': number}}
 */
function countsBySurface(entries, shadowedSeqs) {
  const out = { current: 0, shadowed: 0, 'log-only': 0 }
  for (const e of entries) {
    out[deriveSurface(e.event || e, shadowedSeqs)] += 1
  }
  return out
}

/** Text-search helper: match against type, sessionId, or serialized event. */
function matchesText(entry, q) {
  if (entry.type && entry.type.toLowerCase().includes(q)) return true
  if (entry.sessionId && entry.sessionId.toLowerCase().includes(q)) return true
  // Fallback: serialise the event (bounded — the ring buffer already caps N,
  // and typical event payloads are <5KB). Wrap in try so a circular payload
  // never breaks filtering.
  try {
    const s = JSON.stringify(entry.event).toLowerCase()
    return s.includes(q)
  } catch {
    return false
  }
}

/**
 * Collect the sorted set of event types seen in the buffer. Used by the
 * chip filter UI so the type list reflects reality (rather than being a
 * hard-coded enum that goes stale as SessionEventMap grows).
 *
 * @param {Array<object>} entries
 * @returns {string[]}
 */
function collectTypes(entries) {
  const s = new Set()
  for (const e of entries) if (e.type) s.add(e.type)
  return Array.from(s).sort()
}

// -- formatting --------------------------------------------------------------

/**
 * Format the event payload as pretty JSON. Circular / non-serialisable
 * payloads fall through to `String(value)` so the UI never shows an
 * exception message.
 *
 * @param {unknown} value
 * @returns {string}
 */
function formatJSON(value) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    try { return String(value) } catch { return '(unserialisable)' }
  }
}

/**
 * Format the entry timestamp as HH:MM:SS.mmm in local time. Used by the
 * list row; the full ISO timestamp is available in the expanded JSON.
 *
 * @param {number} time  ms since epoch
 * @returns {string}
 */
function formatTime(time) {
  if (!Number.isFinite(time)) return '--:--:--'
  const d = new Date(time)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${hh}:${mm}:${ss}.${ms}`
}

// -- exports -----------------------------------------------------------------

const api = {
  DEFAULT_CAP,
  PRESETS,
  SURFACES,
  LOG_ONLY_PATTERNS,
  createBuffer,
  addEvent,
  clearBuffer,
  getAll,
  filterEntries,
  matchesPreset,
  matchesPattern,
  collectTypes,
  formatJSON,
  formatTime,
  normalizeEntry,
  deriveSurface,
  buildShadowedSet,
  countsBySurface,
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api
}
if (typeof globalThis !== 'undefined') {
  globalThis.DevtoolsModel = api
}
})()
