// details-aria.js — reflect a `<details>` `[open]` state onto the
// enclosing summary's `aria-expanded` attribute (fix/expand-affordance,
// 2026-07-18). Standalone helper so every disclosure surface — trace
// drawer, inject cards, subagent trace, runtime rows, trace-detail
// section/attr/field blocks, context-page rows — sets the a11y state
// through the same one-liner. Also serves as a copyable reference for
// plugin authors building their own disclosures.
//
// Usage:
//   const details = doc.createElement('details')
//   const summary = doc.createElement('summary')
//   details.append(summary, body)
//   wireDetailsAria(details, summary)
//
// The helper sets `aria-expanded` to match `details.open` immediately,
// then listens for the native `toggle` event and keeps it in sync.
// If `initialOpen` differs from the current DOM state, it's not
// touched — callers should set `details.open` before or after wiring
// as they see fit.

'use strict'

function wireDetailsAria(detailsEl, summaryEl) {
  if (!detailsEl || !summaryEl) return
  const reflect = () => {
    summaryEl.setAttribute('aria-expanded', detailsEl.open ? 'true' : 'false')
  }
  reflect()
  detailsEl.addEventListener('toggle', reflect)
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { wireDetailsAria }
}
if (typeof window !== 'undefined') {
  window.__dshDetailsAria = { wireDetailsAria }
}
