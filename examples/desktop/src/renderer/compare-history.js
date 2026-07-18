// Pure helpers for the "Test with a past session" compare flow (B4).
//
// The playground-ui.js compare drawer uses these to turn a live session's
// event stream into a re-runnable first-user prompt, so the playground can
// answer the same question under the proposed overlay. Broken out into its
// own file so the extraction logic is testable without booting Electron.
//
// The B4 use case is "same question, new plugin set" — a simplified stand-in
// for a real session/fork replay. When the daemon exposes a cross-daemon
// fork wire (an isolated playground daemon accepting a seed from the live
// daemon's session) this file gets slimmer: we hand the daemon the
// (sessionId, boundary) pair and paint whatever comes back, instead of
// picking apart the event stream on our side.

'use strict'

;(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory()
  } else {
    root.__dshCompareHistory = factory()
  }
})(typeof self !== 'undefined' ? self : this, function () {

  /**
   * Extract plain text from an event's `text` scalar or a v2 content-block
   * array. Non-text blocks are dropped; a joined string is returned.
   *
   * @param {any} event
   * @returns {string}
   */
  function extractText(event) {
    if (!event) return ''
    if (typeof event.text === 'string') return event.text
    if (Array.isArray(event.content)) {
      return event.content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('')
    }
    return ''
  }

  /**
   * Find the first user message in an event stream. Accepts both the v2
   * `message/user` type and a legacy `user/message` shape, and both `kind`
   * and `type` discriminators so it stays drivable against older recorded
   * transcripts. Returns `null` if the stream has no user message.
   *
   * @param {any[]} events
   * @returns {{event:any, text:string, index:number}|null}
   */
  function findFirstUserMessage(events) {
    if (!Array.isArray(events)) return null
    for (let i = 0; i < events.length; i++) {
      const e = events[i]
      if (!e) continue
      const kind = e.type || e.kind
      if (kind === 'message/user' || kind === 'user/message') {
        const text = extractText(e)
        if (text) return { event: e, text, index: i }
      }
    }
    return null
  }

  /**
   * Normalise the various "get events" response shapes the shell has seen:
   *  - plain array (mocked runtime),
   *  - `{ events: [...] }` (v2 wire),
   *  - `{ items: [...] }` (an older transport variant that briefly shipped).
   * Returns a fresh array; never mutates the input.
   *
   * @param {any} raw
   * @returns {any[]}
   */
  function normaliseEventsResponse(raw) {
    if (!raw) return []
    if (Array.isArray(raw)) return raw.slice()
    if (Array.isArray(raw.events)) return raw.events.slice()
    if (Array.isArray(raw.items)) return raw.items.slice()
    return []
  }

  return { findFirstUserMessage, extractText, normaliseEventsResponse }
})
