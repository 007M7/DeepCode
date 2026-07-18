// parse-incremental-json.js — best-effort parser for a growing JSON buffer
// as it streams in (#162,).
//
// pi's TUI reads `event.partial.content[i].arguments` on every tool-call
// delta and renders whatever fields have already arrived. The discipline
// (from pi-ai's README:329-336) is: never throw, always return at least
// `{}` (or `[]` if the buffer starts with `[`), and let the caller render
// the value as it is. String values may be truncated mid-word; missing
// closing brackets are synthesised; a trailing `,` or `:` is stripped.
//
// This module is pure, has no DOM or window dependencies, and is loaded
// both via `require()` under node --test and as an IIFE-published global
// `window.__dshParseJson` in the renderer. It complements
// `trace-aggregator.js` (which builds the streaming row) without
// depending on it — the aggregator calls into this on every
// `tool-call-delta` and re-renders the row from the returned value.
//
// Public API:
//
//   parseIncrementalJson(buffer: string) → {
//     value: object | any[],  // at minimum {} / []
//     complete: boolean,      // true iff the raw buffer already parses
//     source: 'raw' | 'padded' | 'walkback' | 'empty'
//                              // which strategy produced `value`
//   }
//
// Never throws.

'use strict'

// Detect whether the tail of `buffer` sits inside an unterminated JSON
// string (an odd number of unescaped `"` since the last structural
// character). We can't just count `"` because `\"` inside a string
// doesn't close it. Walk once with a small state machine.
function tailStringState(buffer) {
  let inString = false
  let escape = false
  for (let i = 0; i < buffer.length; i++) {
    const c = buffer[i]
    if (inString) {
      if (escape) { escape = false; continue }
      if (c === '\\') { escape = true; continue }
      if (c === '"') { inString = false; continue }
    } else {
      if (c === '"') { inString = true; escape = false }
    }
  }
  return { inString, dangling: escape } // dangling: a `\` at the very end
}

// Best-effort truncation to the last position where the tail is not
// inside a partial number, bare literal, or trailing `,`/`:`. We chop
// from the tail; the head has already been scanned for string state.
function trimUnstableTail(buffer) {
  let end = buffer.length
  // Strip trailing whitespace first — it's neutral.
  while (end > 0 && /\s/.test(buffer[end - 1])) end--
  // If the last non-space char is `,` or `:` (structural leftovers of a
  // pair that only got the key or a comma with no next value), drop it.
  while (end > 0 && (buffer[end - 1] === ',' || buffer[end - 1] === ':')) end--
  // Trim any trailing whitespace exposed after the strip.
  while (end > 0 && /\s/.test(buffer[end - 1])) end--
  return buffer.slice(0, end)
}

// Given a buffer we've already trimmed and know the string-state of,
// synthesise closing tokens so JSON.parse succeeds. Walks the buffer
// tracking `{`/`[` opens (outside strings) and appends the reverse
// close sequence.
function synthesizeClosers(buffer) {
  const stack = []
  let inString = false
  let escape = false
  for (let i = 0; i < buffer.length; i++) {
    const c = buffer[i]
    if (inString) {
      if (escape) { escape = false; continue }
      if (c === '\\') { escape = true; continue }
      if (c === '"') { inString = false; continue }
      continue
    }
    if (c === '"') { inString = true; escape = false; continue }
    if (c === '{') stack.push('}')
    else if (c === '[') stack.push(']')
    else if (c === '}' || c === ']') stack.pop()
  }
  const closers = []
  // If a string is still open, close it before we close containers.
  if (inString) closers.push('"')
  while (stack.length) closers.push(stack.pop())
  return closers.join('')
}

/**
 * Best-effort incremental JSON parse.
 *
 * @param {string} buffer
 * @returns {{value: object|any[], complete: boolean, source: 'raw'|'padded'|'walkback'|'empty'}}
 */
function parseIncrementalJson(buffer) {
  // Empty / non-string → return the appropriate empty container so
  // callers can render L0 without a null check.
  if (typeof buffer !== 'string' || buffer.length === 0) {
    return { value: {}, complete: false, source: 'empty' }
  }

  // Fast path: the raw buffer already parses (a sealed tool-call args
  // string is the common case once the delta stream finishes).
  try {
    const v = JSON.parse(buffer)
    if (v && typeof v === 'object') {
      return { value: v, complete: true, source: 'raw' }
    }
    // JSON.parse succeeded on a primitive — treat as no-object; fall
    // through to the padding path with an empty container.
  } catch (_) { /* fall through */ }

  // Detect array-ish vs object-ish so the empty fallback matches.
  const trimStart = buffer.replace(/^\s+/, '')
  const startsArray = trimStart.startsWith('[')
  const emptyFallback = startsArray ? [] : {}

  // Padded path: trim structural leftovers, close strings/brackets.
  const trimmed = trimUnstableTail(buffer)
  if (trimmed.length > 0) {
    const closers = synthesizeClosers(trimmed)
    const padded = trimmed + closers
    try {
      const v = JSON.parse(padded)
      if (v && typeof v === 'object') {
        return { value: v, complete: false, source: 'padded' }
      }
    } catch (_) { /* fall through to walkback */ }

    // Walkback: peel characters off the tail until either we parse
    // successfully or we exhaust the trimmed buffer. Bounded to ~256
    // characters so a pathological input stays O(1).
    const WALKBACK_LIMIT = 256
    const lower = Math.max(0, trimmed.length - WALKBACK_LIMIT)
    for (let cut = trimmed.length - 1; cut >= lower; cut--) {
      const slice = trimmed.slice(0, cut)
      // Skip cuts that land inside a `\` escape sequence — those are
      // never valid boundaries.
      if (slice.length > 0 && slice[slice.length - 1] === '\\') continue
      const c = synthesizeClosers(slice)
      try {
        const v = JSON.parse(slice + c)
        if (v && typeof v === 'object') {
          return { value: v, complete: false, source: 'walkback' }
        }
      } catch (_) { /* keep walking */ }
    }
  }

  return { value: emptyFallback, complete: false, source: 'empty' }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseIncrementalJson, tailStringState, trimUnstableTail, synthesizeClosers }
}
if (typeof window !== 'undefined') {
  window.__dshParseJson = { parseIncrementalJson }
}
