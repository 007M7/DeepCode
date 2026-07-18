// shared payload-controls util.
//
// Every payload block in the demo (tool call args, tool result, request
// header body, response body, raw event drawer panes) wants the same three
// affordances in its top-right corner:
//
//   [ pretty ⇅ raw ]   [ copy ]   [ download ]
//
// The trace-detail-pane Fields card already ships a similar cluster
// (`.trace-detail-fields-controls` with Expand-all + Copy). This util is
// the shared implementation both surfaces should call so the two grammars
// stay in lockstep (老板: "抽 shared util 对齐它，绝不做两套").
//
// Contract
// --------
// attachPayloadControls(host, opts) returns { controlsEl, preEl, setRaw }.
//   host       — an existing DOM element the controls + <pre> are mounted
//                *into*. Caller decides the outer container / layout.
//   opts.getRaw       function returning the current raw payload (any JS
//                     value). Called every time the reader clicks copy /
//                     download / toggles view mode. Callers pass a getter
//                     (rather than a snapshot) so streaming payloads pick
//                     up the latest value; a `setRaw()` call from outside
//                     is *not* required unless you also swap the reference.
//   opts.kind         short label ('args' | 'result' | 'request' …). Used
//                     as the download filename stem and copy tooltip.
//   opts.filename?    override for the download filename (defaults to
//                     `${kind}-${Date.now()}.json`).
//   opts.startMode?   'pretty' (default) or 'raw'. 'pretty' pretty-prints
//                     JSON with 2-space indent; 'raw' shows JSON.stringify
//                     with no indent (verbatim wire on one line).
//   opts.prettyMax?   number, cap the pretty-print height; the internal
//                     <pre> already scrolls via .args/.result CSS so this
//                     is not required. Kept for callers not inheriting
//                     .tool-block styling.
//   opts.copyLabel?   default 'copy'. Left as a knob for surfaces that
//                     want 'copy JSON' (spec §4 uses "copy JSON" for
//                     tool-block L2).
//
// Returned setRaw(nextValue) lets streaming callers push a new payload
// without querying `getRaw` from the outside — but the default getter
// pattern is enough for tool-block args (immutable) and result (streamed
// via the caller reassigning its own reference before calling setRaw()).
//
// Design constraints
// ------------------
// - Zero framework: pure DOM, headless-safe (returns nulls when document
//   is absent — same guard trace-detail-pane uses).
// - Buttons carry a `.ghost.small` class + explicit `.payload-ctl-*`
//   hooks so tests can query without style drift.
// - copyText via navigator.clipboard, best-effort (same shape as
//   trace-detail-pane copyJson).
// - Download via Blob + createObjectURL + `<a download>` (mirrors
//   annotation-panel.js / bench-page.js — one idiom, one revoke).
// - No emoji: labels are text ('pretty' / 'raw' / 'copy' / 'download').
//   §7 baseline rules out ⧉ or unicode glyphs beyond what the app
//   already ships (`{ }` for JSON badges is pre-existing).
// - The controls container carries `.payload-controls` and lives before
//   the `<pre>` in DOM order; CSS uses flex to shove it top-right of the
//   host without absolute positioning fights.
//
// Exposed as CommonJS + `window.__dshPayloadControls`.

'use strict'

;(function () {

function attachPayloadControls(host, opts) {
  if (!host || typeof host.appendChild !== 'function') return null
  opts = opts || {}
  const doc = (host.ownerDocument) || (typeof document !== 'undefined' ? document : null)
  if (!doc) return null

  const getRaw = typeof opts.getRaw === 'function' ? opts.getRaw : () => null
  const kind = String(opts.kind || 'payload')
  const filename = String(opts.filename || `${kind}-${Date.now()}.json`)
  const copyLabel = String(opts.copyLabel || 'copy')
  const startMode = opts.startMode === 'raw' ? 'raw' : 'pretty'

  // ---- controls cluster (top-right of host) ----------------------------
  const controls = doc.createElement('div')
  controls.className = 'payload-controls'
  controls.setAttribute('data-payload-kind', kind)

  const toggle = doc.createElement('button')
  toggle.type = 'button'
  toggle.className = 'ghost small payload-ctl-toggle'
  toggle.textContent = startMode === 'raw' ? 'raw' : 'pretty'
  toggle.title = 'Toggle between pretty (indented) and raw (one-line) JSON'

  const copyBtn = doc.createElement('button')
  copyBtn.type = 'button'
  copyBtn.className = 'ghost small payload-ctl-copy'
  copyBtn.textContent = copyLabel
  copyBtn.title = `Copy raw ${kind} JSON to clipboard`

  const dlBtn = doc.createElement('button')
  dlBtn.type = 'button'
  dlBtn.className = 'ghost small payload-ctl-download'
  dlBtn.textContent = 'download'
  dlBtn.title = `Download ${kind} JSON as a .json file`

  controls.appendChild(toggle)
  controls.appendChild(copyBtn)
  controls.appendChild(dlBtn)

  // ---- payload <pre> ----------------------------------------------------
  const pre = doc.createElement('pre')
  pre.className = 'payload-body mono'
  pre.setAttribute('data-payload-kind', kind)
  let mode = startMode
  renderPre(pre, getRaw(), mode)

  host.appendChild(controls)
  host.appendChild(pre)

  // ---- wiring -----------------------------------------------------------
  if (toggle.addEventListener) {
    toggle.addEventListener('click', function (e) {
      if (e && e.stopPropagation) e.stopPropagation()
      mode = mode === 'raw' ? 'pretty' : 'raw'
      toggle.textContent = mode
      renderPre(pre, getRaw(), mode)
    })
  }
  if (copyBtn.addEventListener) {
    copyBtn.addEventListener('click', function (e) {
      if (e && e.stopPropagation) e.stopPropagation()
      copyText(prettyString(getRaw()))
    })
  }
  if (dlBtn.addEventListener) {
    dlBtn.addEventListener('click', function (e) {
      if (e && e.stopPropagation) e.stopPropagation()
      downloadJsonFile(doc, filename, prettyString(getRaw()))
    })
  }

  function setRaw(nextValue) {
    // Optional caller-driven refresh — used by streaming payloads that
    // don't want to pay for a getter closure over their own state.
    _lastSet = nextValue
    renderPre(pre, nextValue !== undefined ? nextValue : getRaw(), mode)
  }
  let _lastSet // eslint-disable-line no-unused-vars — reserved for future

  return { controlsEl: controls, preEl: pre, setRaw }
}

// ---- helpers (exported for tests) ------------------------------------

function renderPre(preEl, value, mode) {
  if (!preEl) return
  preEl.textContent = mode === 'raw' ? rawString(value) : prettyString(value)
}

// Pretty-print any value as JSON with 2-space indent. Strings that
// already parse as JSON get re-parsed so the reader sees indented
// structure rather than an escaped blob (same idea as tool-cards
// formatJson). Circular-safe via a WeakSet-backed replacer.
function prettyString(v) {
  return jsonStringifySafe(coerceForPretty(v), 2)
}

// One-line raw form: JSON.stringify with no indent, verbatim ordering
// (no re-parsing of embedded strings — this is the wire truth toggle).
function rawString(v) {
  return jsonStringifySafe(v, 0)
}

function coerceForPretty(v) {
  if (typeof v !== 'string') return v
  const trimmed = v.trim()
  if (!trimmed) return v
  if (trimmed[0] !== '{' && trimmed[0] !== '[') return v
  try { return JSON.parse(trimmed) } catch (_) { return v }
}

function jsonStringifySafe(v, indent) {
  if (v === undefined) return '(absent)'
  const seen = new WeakSet()
  const replacer = function (_k, val) {
    if (val && typeof val === 'object') {
      if (seen.has(val)) return '[Circular]'
      seen.add(val)
    }
    return val
  }
  try {
    return JSON.stringify(v, replacer, indent || 0)
  } catch (_) {
    try { return String(v) } catch (_e) { return '' }
  }
}

function copyText(s) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(String(s == null ? '' : s)).catch(function () {})
    }
  } catch (_) { /* best-effort */ }
}

function downloadJsonFile(doc, filename, content) {
  try {
    if (typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      // Headless / sandboxed shell — silently no-op. Callers should
      // consider the download control aspirational in those contexts.
      return
    }
    const blob = new Blob([String(content == null ? '' : content)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = doc.createElement('a')
    a.href = url
    a.download = filename
    if (doc.body && typeof doc.body.appendChild === 'function') doc.body.appendChild(a)
    if (typeof a.click === 'function') a.click()
    if (a.parentNode && typeof a.parentNode.removeChild === 'function') a.parentNode.removeChild(a)
    setTimeout(function () { try { URL.revokeObjectURL(url) } catch (_) {} }, 0)
  } catch (_) { /* best-effort */ }
}

// ---- exports ---------------------------------------------------------

const api = {
  attachPayloadControls,
  // pure helpers exposed for unit tests + reuse
  prettyString,
  rawString,
  coerceForPretty,
  jsonStringifySafe,
}

if (typeof module !== 'undefined' && module.exports) module.exports = api
if (typeof window !== 'undefined') window.__dshPayloadControls = api

})();
