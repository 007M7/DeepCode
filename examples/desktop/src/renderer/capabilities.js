// Server-capability gating (Ticket G).
//
// The `initialize` handshake result carries `capabilities` — a boolean bag
// declared by the runtime that tells the shell which management methods
// this daemon actually implements. Six bits matter to the desktop UI:
//
//   cancel       — session/cancel is wired
//   sessionQuery — session/list is wired
//   setConfig    — session/set_config is wired
//   fork         — session/fork is wired
//   plugins      — plugins/* are wired
//   compact      — session/compact is wired
//
// This module normalizes the raw envelope into a stable shape the renderer
// can key gating decisions off. The main rule — matching the shell's
// historical assumption that v1 servers "just work" — is that a **missing**
// bit means the capability is present. Only an **explicit `false`** grays
// the corresponding UI. Wire didn't say ≠ not supported. This mirrors the
// P0-3 auto/manual badge rule (§docs/capability-frontend-audit.md §1.1)
// where "wire silence" is not a negative claim.
//
// Kept as a pure module: no DOM, no globals, no timers. Rendered gating
// lives in renderer.js; the constants and normalizer stay tested against
// `node --test` in test/capabilities.test.js.

'use strict'

// The six capabilities the shell actually gates on. Any capability the
// wire ships that isn't in this list is preserved on the normalized
// output (so a devtools reader can inspect it) but doesn't drive UI.
const CAPABILITY_KEYS = Object.freeze([
  'cancel',
  'sessionQuery',
  'setConfig',
  'fork',
  'plugins',
  'compact',
])

/**
 * Canonical shape for gated capabilities. All six default to `true` so a
 * caller can spread this over a `null` envelope and still get the
 * "everything supported" posture v1 servers assume.
 */
const CAPABILITIES_ALL_SUPPORTED = Object.freeze({
  cancel: true,
  sessionQuery: true,
  setConfig: true,
  fork: true,
  plugins: true,
  compact: true,
})

/**
 * Normalize a raw `initialize.result.capabilities` envelope into the
 * shell's canonical `{cancel, sessionQuery, setConfig, fork, plugins,
 * compact}` boolean bag.
 *
 * Semantics (locked in tests):
 *   - `null` / `undefined` / non-object input → all six default to `true`
 *     (v1 server didn't ship a capabilities envelope; assume everything
 *     works, which is what the shell always did before Ticket G).
 *   - Object input with a specific key **missing** → that bit defaults
 *     to `true`. "Wire silent" ≠ "not supported".
 *   - Object input with a specific key set to `false` → that bit is
 *     `false`. This is the only way to gray a UI surface.
 *   - Any other value (`true`, non-empty string, number) → coerced to
 *     `true`. Bad-shape envelopes from a misbehaving daemon should never
 *     accidentally gray a working UI.
 *
 * @param {unknown} raw — the `capabilities` field from the initialize result.
 * @returns {{cancel: boolean, sessionQuery: boolean, setConfig: boolean,
 *            fork: boolean, plugins: boolean, compact: boolean}}
 */
function normalizeCapabilities(raw) {
  const out = { ...CAPABILITIES_ALL_SUPPORTED }
  if (!raw || typeof raw !== 'object') return out
  for (const key of CAPABILITY_KEYS) {
    // Explicit `false` is the *only* way to gray. Everything else
    // (missing / null / true / truthy) leaves the default in place.
    if (raw[key] === false) out[key] = false
  }
  return out
}

// Canonical disabled-tooltip strings. Kept in one place so every gated
// surface reads with the same voice ("this runtime doesn't support X yet")
// instead of drifting per-caller. Also machine-readable — tests assert
// against these constants rather than substring matching prose.
const DISABLED_TOOLTIPS = Object.freeze({
  cancel:
    'This runtime does not advertise session/cancel — the Cancel button is disabled. Restart into a profile whose daemon supports cancel to enable it.',
  sessionQuery:
    'This runtime does not advertise session/list — the session sidebar cannot be refreshed. Sessions still stream live, but no history browse.',
  setConfig:
    'This runtime does not advertise session/set_config — the model is fixed for this session.',
  fork:
    'This runtime does not advertise session/fork — fork-from-here is disabled. Restart into a profile whose daemon supports fork.',
  plugins:
    'This runtime does not advertise plugins/* — the Plugins tab is disabled.',
  compact:
    'This runtime does not advertise session/compact — the Compact button is disabled.',
})

/**
 * Look up the canonical disabled-tooltip for a capability. Returns `''`
 * if the caller passes an unknown key so the UI falls back to whatever
 * tooltip it had before Ticket G.
 * @param {string} capabilityKey
 * @returns {string}
 */
function capabilityDisabledTitle(capabilityKey) {
  return DISABLED_TOOLTIPS[capabilityKey] || ''
}

// Dual export shape: CommonJS for `node --test`; `window.__dshCapabilities`
// for the renderer. The renderer's <script> tag runs before renderer.js so
// the handle is ready at first read.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    normalizeCapabilities,
    capabilityDisabledTitle,
    CAPABILITY_KEYS,
    CAPABILITIES_ALL_SUPPORTED,
    DISABLED_TOOLTIPS,
  }
}
if (typeof window !== 'undefined') {
  window.__dshCapabilities = {
    normalizeCapabilities,
    capabilityDisabledTitle,
    CAPABILITY_KEYS,
    CAPABILITIES_ALL_SUPPORTED,
    DISABLED_TOOLTIPS,
  }
}
