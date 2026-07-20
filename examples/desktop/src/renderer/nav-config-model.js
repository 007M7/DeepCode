// nav-config-model.js — pure config helpers for the left-nav hidden-page
// filter. Two responsibilities:
//   • DEFAULT_HIDDEN — the two demo-tier pages we now hide out of the box
//     (Playground shim, Missions) so a fresh install shows fewer surfaces
//     up front. Users opt these in from Settings > Optional pages.
//   • resolveHiddenPages(cfg) — coerces a shell-config blob into the final
//     hidden-page array following these rules:
//       - `hiddenPages` missing entirely  → default hidden set
//       - `hiddenPages` is an empty array → nothing hidden (all pages show)
//       - `hiddenPages` is a non-empty array of strings → honored as-is
//       - anything else (non-array, garbage) → default hidden set (safe)
//
// The renderer applies the result by iterating `.tab-btn[data-tab=…]`
// and toggling a `.nav-item--hidden` class. Kept as a pure module so the
// three fixture cases (missing / empty / custom) are unit-testable
// without spinning up Electron. Wrapped in an IIFE (like settings-model)
// so no top-level bindings leak into the shared renderer global scope
// (test/renderer-collisions.test.js enforces this).

'use strict'
;(function () {

const DEFAULT_HIDDEN = Object.freeze(['playground-shim', 'mission'])

// Legacy ids that were merged into the single 'evals' door on 2026-07-19
// (lane-evals-merge). Any of these appearing in a user's persisted
// hiddenPages array is remapped so their old config keeps hiding the
// Evals door — otherwise a user who previously chose "hide Rubrics"
// would see Evals reappear on the next launch, effectively rolling
// their preference back. The keys must match the ORIGINAL data-tab
// values as they existed pre-merge; the value is the new door id.
const LEGACY_ID_ALIAS = Object.freeze({
  rubrics: 'evals',
  growth: 'evals',
  runtimes: 'evals',
})

// Page ids that a user can opt into from the Settings > Optional pages
// section. Kept as a small explicit list rather than "everything in the
// default hidden set" because the Settings section is meant to be a
// curated on/off surface for the demo-tier pages we hide by default —
// arbitrary custom hidden pages (via manual config.json edit) are still
// honored by resolveHiddenPages, they just don't get a Settings toggle.
// Label is what the checkbox shows; the id must match a `data-tab`
// value in index.html so the renderer filter can find the button.
const OPTIONAL_PAGES = Object.freeze([
  Object.freeze({ id: 'playground-shim', label: 'Playground', hint: 'Demo playground shim (opens Plugins tab).' }),
  Object.freeze({ id: 'mission', label: 'Missions', hint: 'Mission Control — task graph over sessions.' }),
])

function resolveHiddenPages(cfg) {
  if (!cfg || typeof cfg !== 'object') return DEFAULT_HIDDEN.slice()
  const raw = cfg.hiddenPages
  if (raw === undefined) return DEFAULT_HIDDEN.slice()
  if (!Array.isArray(raw)) return DEFAULT_HIDDEN.slice()
  // Explicit empty array means "show everything" — the user has opted
  // every optional page in. Filter out non-strings/blanks defensively so
  // a malformed entry can't crash the renderer filter.
  const cleaned = raw.filter((x) => typeof x === 'string' && x.length > 0)
  // Remap legacy ids merged into 'evals' (lane-evals-merge, 2026-07-19).
  // Deduplicates so a config that hides all three of rubrics/growth/
  // runtimes still yields a single 'evals' entry in the resolved set.
  const out = []
  const seen = new Set()
  for (const id of cleaned) {
    const mapped = LEGACY_ID_ALIAS[id] || id
    if (!seen.has(mapped)) {
      seen.add(mapped)
      out.push(mapped)
    }
  }
  return out
}

// Small helper the Settings page uses to compute the next hiddenPages
// array given a checkbox flip. `enable=true` means "the user wants this
// page visible" so we remove it from hidden; `enable=false` adds it back.
function toggleOptionalPage(current, pageId, enable) {
  const set = new Set(Array.isArray(current) ? current : [])
  if (enable) set.delete(pageId)
  else set.add(pageId)
  return Array.from(set)
}

const navConfigApi = { DEFAULT_HIDDEN, OPTIONAL_PAGES, LEGACY_ID_ALIAS, resolveHiddenPages, toggleOptionalPage }
if (typeof module !== 'undefined' && module.exports) module.exports = navConfigApi
if (typeof window !== 'undefined') window.__dshNavConfigModel = navConfigApi

})();
