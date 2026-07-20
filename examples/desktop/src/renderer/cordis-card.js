// Dedicated tool card for the self-referential cordis toolset (cordis_mount /
// cordis_unmount / cordis_inspect): the "model modifies its own runtime"
// flagship capability. Renders a purpose-built card instead of the generic
// raw-text result the family would otherwise fall through to.
//
// Wire truth (verified against packages/cordis/tool-cordis/src in the sibling
// runtime repo): all three tools declare a `generic` render intent and return
// PLAIN-TEXT content blocks — there is no structured result object on the
// wire. So this card PARSES the tool's own completed text, never fabricating a
// shape the runtime didn't emit:
//   mount   → `mounted dyn-1 (plugin "name", state: ACTIVE[ — waiting for service(s): …])`
//   unmount → `unmounted dyn-1 (plugin "name")`
//   inspect → markdown-ish `## section\n- item\n…` blocks (six sections, or one when `what` is set)
// Error results arrive with isError=true and the thrown Error's message as the
// text; we surface that verbatim rather than guessing an operation shape.
//
// Everything textual goes through `textContent`; no `innerHTML` from any
// tool-controlled field — same safety edge as tool-cards.js / widgets.js.
//
// Detection is by tool name only (the family map in tool-cards.js already
// identifies the three names); the renderer keeps its `meta.card` switch
// untouched for every other tool, and an unknown cordis-family name falls
// back to the generic renderer.

'use strict'

;(function () {

// The three model-visible cordis tool names. Kept local (not imported from
// TOOL_FAMILIES) so this module stands alone under node:test without loading
// the whole tool-cards surface; the two lists are asserted consistent in the
// unit tests.
const CORDIS_TOOLS = Object.freeze(['cordis_mount', 'cordis_unmount', 'cordis_inspect'])

// Per-operation header glyph (single monochrome column, matching the family
// glyph convention in tool-cards.js). mount/unmount/inspect read as
// add-to-runtime / remove-from-runtime / read-runtime.
const OP_GLYPH = Object.freeze({
  cordis_mount: '⊕',   // ⊕
  cordis_unmount: '⊖', // ⊖
  cordis_inspect: '⊙', // ⊙
})

/**
 * Whether a tool name is one of the three cordis self-inspection tools.
 * @param {string} name
 * @returns {boolean}
 */
function isCordisTool(name) {
  return typeof name === 'string' && CORDIS_TOOLS.indexOf(name) !== -1
}

/**
 * Parse a `cordis_mount` success text into its fields. Returns null when the
 * text doesn't match the mount shape (e.g. it's an error message) so the
 * caller can fall back to raw text.
 * Shape: `mounted <id> (plugin "<name>", state: <STATE>[ — waiting for service(s): a, b (activates when provided)])`
 * @param {string} text
 * @returns {{ id: string, pluginName: string, state: string, waiting: string[] } | null}
 */
function parseMountResult(text) {
  if (typeof text !== 'string') return null
  const m = text.match(/^mounted\s+(\S+)\s+\(plugin\s+"([^"]*)",\s+state:\s+(\w+)/)
  if (!m) return null
  const waitingMatch = text.match(/waiting for service\(s\):\s+([^(]+?)\s*\(activates when provided\)/)
  const waiting = waitingMatch
    ? waitingMatch[1].split(',').map((s) => s.trim()).filter(Boolean)
    : []
  return { id: m[1], pluginName: m[2], state: m[3], waiting }
}

/**
 * Parse a `cordis_unmount` success text. Returns null on non-match.
 * Shape: `unmounted <id> (plugin "<name>")`
 * @param {string} text
 * @returns {{ id: string, pluginName: string } | null}
 */
function parseUnmountResult(text) {
  if (typeof text !== 'string') return null
  const m = text.match(/^unmounted\s+(\S+)\s+\(plugin\s+"([^"]*)"\)/)
  if (!m) return null
  return { id: m[1], pluginName: m[2] }
}

/**
 * Parse `cordis_inspect` text into a `{ section: lines[] }` object suitable for
 * the Fields-tree widget. Splits on lines beginning with `## `; each section's
 * body becomes an array of its non-blank lines (leading `- ` bullets kept as-is
 * so the tree reads like the tool's own report). Returns an empty object when
 * no `## ` heading is present.
 * @param {string} text
 * @returns {Record<string, string[]>}
 */
function parseInspectSections(text) {
  const out = {}
  if (typeof text !== 'string' || text.length === 0) return out
  // No `## ` heading anywhere → not a sectioned report; caller falls back to raw.
  if (!/^##\s+/m.test(text)) return out
  // Split on a heading line; the first chunk before any `## ` (usually empty)
  // is dropped by the falsy-heading guard below.
  const parts = text.split(/^##\s+/m)
  for (const part of parts) {
    if (!part || !part.trim()) continue
    const nl = part.indexOf('\n')
    const heading = (nl === -1 ? part : part.slice(0, nl)).trim()
    if (!heading) continue
    const body = nl === -1 ? '' : part.slice(nl + 1)
    const lines = body.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.length > 0)
    out[heading] = lines
  }
  return out
}

// Resolve the shared Fields-tree builder. The inspect body reuses
// trace-detail-pane's buildJsonTree (task rule: "no new tree"). Injectable so
// the unit tests can pass a stub under the node DOM shim.
function resolveBuildTree(explicit) {
  if (typeof explicit === 'function') return explicit
  const tdp = (typeof window !== 'undefined') ? window.__dshTraceDetailPane : null
  return tdp && typeof tdp.buildJsonTree === 'function' ? tdp.buildJsonTree : null
}

// Small helper: a key-value row `key  value` inside the mount/unmount block.
function kvRow(doc, key, value) {
  const row = doc.createElement('div')
  row.className = 'card-cordis-kv-row'
  const k = doc.createElement('span')
  k.className = 'card-cordis-kv-key'
  k.textContent = String(key)
  const v = doc.createElement('span')
  v.className = 'card-cordis-kv-val'
  v.textContent = String(value)
  row.append(k, v)
  return row
}

// A `＋entry` / `－entry` delta line. `kind` is 'add' | 'del'. This is the ONLY
// place we assert a runtime change, and only because the operation itself is
// definitionally an add (mount) or remove (unmount) of exactly this id — never
// a synthesised before/after diff.
function deltaLine(doc, kind, entry) {
  const row = doc.createElement('div')
  row.className = 'card-cordis-delta ' + (kind === 'del' ? 'del' : 'add')
  const sig = doc.createElement('span')
  sig.className = 'card-cordis-delta-sig'
  sig.textContent = kind === 'del' ? '－' : '＋' // －／＋
  const label = doc.createElement('span')
  label.className = 'card-cordis-delta-entry'
  label.textContent = String(entry)
  row.append(sig, label)
  return row
}

/**
 * Render a cordis tool result into a purpose-built card.
 *
 * @param {object} spec
 * @param {string} spec.name       — the tool name (cordis_mount|unmount|inspect).
 * @param {object} [spec.argsObj]  — the parsed `tool/call.arguments` (code/id/what).
 * @param {string} [spec.text]     — the tool/result text content (already flattened).
 * @param {boolean} [spec.isError] — the tool/result isError flag.
 * @param {Function} [spec.buildTree] — override for buildJsonTree (tests).
 * @param {Document} [spec.doc]    — override document (tests); defaults to global.
 * @returns {HTMLElement}
 */
function renderCordisCard(spec) {
  const s = spec || {}
  const doc = s.doc || (typeof document !== 'undefined' ? document : null)
  const name = s.name
  const argsObj = s.argsObj && typeof s.argsObj === 'object' ? s.argsObj : {}
  const text = typeof s.text === 'string' ? s.text : ''
  const isError = !!s.isError

  const el = doc.createElement('div')
  el.className = 'card-cordis'
  el.setAttribute('data-tool-card-family', 'cordis')
  el.setAttribute('data-cordis-op', String(name))

  // -- header: op glyph + id + status dot ------------------------------------
  const header = doc.createElement('div')
  header.className = 'card-cordis-header'
  const glyph = doc.createElement('span')
  glyph.className = 'card-cordis-op-glyph'
  glyph.textContent = OP_GLYPH[name] || '~'
  header.appendChild(glyph)

  // The most identifying token for the header, per operation. mount's id lives
  // in the result (runtime-assigned dyn-N), so parse it; unmount/inspect carry
  // it in args.
  const mount = name === 'cordis_mount' && !isError ? parseMountResult(text) : null
  const unmount = name === 'cordis_unmount' && !isError ? parseUnmountResult(text) : null
  let headerId
  if (name === 'cordis_mount') headerId = mount ? mount.id : 'mount'
  else if (name === 'cordis_unmount') headerId = argsObj.id != null ? String(argsObj.id) : (unmount ? unmount.id : 'unmount')
  else headerId = argsObj.what != null ? String(argsObj.what) : 'all sections'

  const idEl = doc.createElement('span')
  idEl.className = 'card-cordis-id'
  idEl.textContent = String(headerId)
  header.appendChild(idEl)

  const status = doc.createElement('span')
  status.className = 'card-cordis-status ' + (isError ? 'err' : 'ok')
  status.setAttribute('aria-hidden', 'true')
  status.textContent = isError ? '●' : '●' // ● (colour carries meaning; class-driven)
  status.setAttribute('title', isError ? 'error' : 'ok')
  header.appendChild(status)
  el.appendChild(header)

  const body = doc.createElement('div')
  body.className = 'card-cordis-body'
  el.appendChild(body)

  // -- error path: surface the tool's own message verbatim ------------------
  if (isError) {
    const err = doc.createElement('div')
    err.className = 'card-cordis-error'
    err.textContent = text || '[error]'
    body.appendChild(err)
    return el
  }

  // -- mount -----------------------------------------------------------------
  if (name === 'cordis_mount') {
    if (mount) {
      const kv = doc.createElement('div')
      kv.className = 'card-cordis-kv'
      kv.appendChild(kvRow(doc, 'id', mount.id))
      kv.appendChild(kvRow(doc, 'name', mount.pluginName))
      kv.appendChild(kvRow(doc, 'state', mount.state))
      if (mount.waiting.length > 0) kv.appendChild(kvRow(doc, 'waiting', mount.waiting.join(', ')))
      body.appendChild(kv)
      // A mount definitionally adds exactly this entry.
      body.appendChild(deltaLine(doc, 'add', mount.id))
    } else {
      // Unrecognised success text: show what IS there rather than an empty card.
      appendRawText(doc, body, text)
    }
    // The mount source (`code`) is the closest thing the entry carries to a
    // config; keep it behind a fold so a dozen-line plugin body doesn't drown
    // the card. Absent when the arg wasn't captured.
    if (typeof argsObj.code === 'string' && argsObj.code.length > 0) {
      body.appendChild(codeFold(doc, argsObj.code))
    }
    return el
  }

  // -- unmount ---------------------------------------------------------------
  if (name === 'cordis_unmount') {
    const removedId = unmount ? unmount.id : (argsObj.id != null ? String(argsObj.id) : null)
    if (unmount) {
      const kv = doc.createElement('div')
      kv.className = 'card-cordis-kv'
      kv.appendChild(kvRow(doc, 'id', unmount.id))
      kv.appendChild(kvRow(doc, 'name', unmount.pluginName))
      body.appendChild(kv)
    } else {
      appendRawText(doc, body, text)
    }
    if (removedId) body.appendChild(deltaLine(doc, 'del', removedId))
    return el
  }

  // -- inspect ---------------------------------------------------------------
  // Reuse the shared Fields-tree over the parsed sections. Falls back to raw
  // text when either the tree builder is unavailable (early boot) or the text
  // carried no `## ` sections to parse.
  const sections = parseInspectSections(text)
  const buildTree = resolveBuildTree(s.buildTree)
  if (buildTree && Object.keys(sections).length > 0) {
    const treeHost = doc.createElement('div')
    treeHost.className = 'card-cordis-tree'
    // openDepth:1 shows the section names folded; the reader expands a section
    // to see its lines — matches the "collapsible list" the task asked for.
    treeHost.appendChild(buildTree(doc, sections, { rootName: null, openDepth: 1 }))
    body.appendChild(treeHost)
  } else {
    appendRawText(doc, body, text)
  }
  return el
}

// A monospace fold holding the mount `code`. Closed by default.
function codeFold(doc, code) {
  const det = doc.createElement('details')
  det.className = 'card-cordis-code'
  const sum = doc.createElement('summary')
  sum.className = 'card-cordis-code-summary'
  sum.textContent = 'plugin source'
  det.appendChild(sum)
  const pre = doc.createElement('pre')
  pre.className = 'card-cordis-code-body'
  pre.textContent = code
  det.appendChild(pre)
  return det
}

// Fallback: raw text in a monospace block (the generic result view, scoped so
// it still reads as part of the cordis card).
function appendRawText(doc, host, text) {
  const pre = doc.createElement('pre')
  pre.className = 'card-cordis-raw'
  pre.textContent = text || '[ok]'
  host.appendChild(pre)
}

// -- exports -----------------------------------------------------------------
// Dual export shape mirrors tool-cards.js / widgets.js.
const api = {
  CORDIS_TOOLS,
  OP_GLYPH,
  isCordisTool,
  parseMountResult,
  parseUnmountResult,
  parseInspectSections,
  renderCordisCard,
}
if (typeof module !== 'undefined' && module.exports) module.exports = api
if (typeof window !== 'undefined') window.__dshCordisCard = api

})()
