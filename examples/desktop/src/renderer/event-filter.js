// Pure helpers extracted from renderer.js so they can be exercised under
// `node --test` without a DOM. Both functions guard the chat stream from
// nonsense: `describeSource` produces a printable label for user/message
// `source` payloads (which are sometimes plain strings, sometimes
// MessageSourceMap objects), and `isDevOnlyEventType` decides whether an
// unrecognised event type belongs in the chat or the Devtools drawer.
//
// See renderer.js `case 'user/message'` and the switch `default:` arm for
// the two call sites.

'use strict'

/**
 * Return a printable label for an event's `source` payload.
 *
 * MessageSourceMap variants seen on the wire: `'user'` (string),
 * `{kind:'plugin', plugin:'compact'}` (object), `{kind:'tool', tool:'bash'}`
 * (object). Anything else falls back to `'context'`.
 *
 * The historical bug: `${data.source}` interpolated an object as
 * `[object Object]`, leaking `[[object Object]] <text>` into the chat.
 * Route source through this before any string interpolation.
 *
 * @param {unknown} source
 * @returns {string}
 */
function describeSource(source) {
  if (!source) return 'context'
  if (typeof source === 'string') return source
  if (typeof source === 'object') {
    if (source.kind === 'plugin' && source.plugin) return `plugin:${source.plugin}`
    if (source.kind === 'tool' && source.tool) return `tool:${source.tool}`
    if (source.kind) return source.kind
  }
  return 'context'
}

/**
 * Types that belong to the developer view (audit stream), not the chat.
 *
 * These fire frequently (every request/turn) and are audit-lens signals —
 * showing them as grey `event: request/header` lines in chat was pure
 * noise. Devtools installs its own onNotify listener and captures them
 * regardless.
 *
 * @param {unknown} type
 * @returns {boolean}
 */
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

/**
 * Concatenate the text of an assistant/context content-block array.
 *
 * Content arrays on the wire mix block kinds: `{type:'text',text:…}`,
 * `{type:'reasoning',text:…}`, `{type:'tool-call',…}`, `{type:'tool_use',…}`,
 * `{type:'image',…}`, etc. Only text blocks belong in the message bubble —
 * reasoning is streamed into its own `.msg.reasoning` frame, tool calls
 * into the tool-card family.
 *
 * The historical bug: the fallback arm returned `[${b.type}]` for any
 * non-text block, so every `assistant/message` whose content array carried
 * reasoning/tool-call segments (i.e. every non-trivial turn) overwrote
 * `body.textContent` with `[reasoning][tool-call][tool-call]<text>`. Drop
 * non-text blocks silently; devtools captures the raw event for inspection.
 *
 * @param {unknown} blocks
 * @returns {string}
 */
function textFromContentBlocks(blocks) {
  if (!Array.isArray(blocks)) return ''
  let out = ''
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text' && typeof b.text === 'string') out += b.text
  }
  return out
}

/**
 * Decide which of two event streams to replay when re-entering a session.
 *
 * Two sources of truth:
 *   - `cached`: in-memory events from live notifications this window has
 *     seen. Wins when the daemon's persistence lags behind.
 *   - `server`: what `session/events` returned from the daemon. Wins when
 *     it has more entries (persisted history from a previous run beats
 *     partial live memory).
 *
 * "More entries wins" is safe because both are append-only monotonic — the
 * bigger one is a strict superset of the smaller (or at worst the same
 * ordering). Merging by seq is tempting but risks double-rendering the
 * events that appear in both streams.
 *
 * @param {Array} cached
 * @param {Array|null} server
 * @returns {Array} the picked source (never null; falls back to [])
 */
function pickReplaySource(cached, server) {
  const c = Array.isArray(cached) ? cached : []
  const s = Array.isArray(server) ? server : null
  if (s && s.length >= c.length) return s
  return c
}

// Dual export shape mirrors context-meter.js: CommonJS for node tests,
// `window.__dshEventFilter` for the renderer (which script-tag loads it
// before renderer.js runs).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { describeSource, isDevOnlyEventType, pickReplaySource, textFromContentBlocks }
}
if (typeof window !== 'undefined') {
  window.__dshEventFilter = { describeSource, isDevOnlyEventType, pickReplaySource, textFromContentBlocks }
}
