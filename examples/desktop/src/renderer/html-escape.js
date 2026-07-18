// Shared HTML escaper for renderer modules. Consolidates four in-file
// copies that had drifted (market-ui/playground-ui/plugins-ui were
// byte-identical; bench-page was subtly weaker — it escaped &, <, >, "
// but not ' and was ALSO used as `escapeAttr` alias, so any `'` in an
// attribute value was echoed literally).
//
// The right set is the five OWASP-recommended characters for HTML text +
// double-quoted attribute contexts (& < > " '). Single-quoted attribute
// contexts also need `'` escaped, so covering it makes this helper safe
// as an `escapeAttr` too.
//
// Public API (window.__dshHtmlEscape / module.exports):
//   escapeHtml(s) → string   — escapes & < > " ' for text + attr contexts
//   escapeAttr(s) → string   — alias, kept so bench-page's split-role
//                              call-sites read naturally.

'use strict'

;(function () {
  const REPLACEMENTS = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => REPLACEMENTS[c])
  }

  const API = { escapeHtml, escapeAttr: escapeHtml }
  if (typeof module !== 'undefined' && module.exports) module.exports = API
  if (typeof window !== 'undefined') window.__dshHtmlEscape = API
})()
