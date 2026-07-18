// Shared string-truncation helper. Three in-file copies existed
// (interact-cards.js:123, trace-aggregator.js:369, trigger-templates.js:278)
// with byte-identical output: if the input isn't a string return '',
// else if length <= limit return as-is, else slice(0, limit-1) + '…'.
//
// The ellipsis counts as one visible character, so slice(0, limit-1)
// keeps the total at `limit` chars. Non-string inputs coerce to '' so
// callers don't have to guard.
//
// Public API (window.__dshTextTruncate / module.exports):
//   truncate(s, limit) → string

'use strict'

;(function () {
  function truncate(s, limit) {
    if (typeof s !== 'string') return ''
    if (s.length <= limit) return s
    return s.slice(0, limit - 1) + '…'
  }

  const API = { truncate }
  if (typeof module !== 'undefined' && module.exports) module.exports = API
  if (typeof window !== 'undefined') window.__dshTextTruncate = API
})()
