// Pure classifier for the plugin-injection card families (§1.3 of the
// strategy list). Each `context/message` (and the compact
// plugin's shadow `user/message`) is routed to one of eight visual
// families A–H, with its own icon, colour, and short label template.
//
// The classifier is a **pure function of the event** — no DOM, no side
// state — so tests can drive it against fixtures without booting the
// renderer. The renderer calls it at dispatch time and hands the result
// to `appendInjectCard()` which renders the L0 row.
//
// Family layout (matches strategy-feature-list.md §1.3):
//
//   A  hooks-claude / hooks-codex on first turn → SessionStart
//   B  any other plugin on non-first turn        → plugin
//   C  time-context tick                         → ⏱ time
//   D  repeat-tool-guard family                  → guard
//   E  compact plugin shadow user/message        → ⤵ compact (routes to §1.7)
//   F  user-approval policy changes              → approval
//   G  unknown plugin (bucket)                   → unknown
//   H  user-injected skills etc.                 → user
//
// The classifier does NOT decide colour/icon literally — it returns a
// keyed record that the renderer's stylesheet keys against. This keeps
// the DOM/CSS surface out of the pure module so tests stay lightweight.
//
// Design red-line: family E (compact shadow user) intentionally overlaps
// §1.7 compact card. The strategy list says "合并成一张 compact 卡"; the
// renderer honours that by *suppressing* the E family card when the
// preceding element on the stream is the compact card — the audit lives
// in the renderer, not this classifier. The classifier still emits E so
// tests can pin the shape.
//
// Guard family D: matches `repeat-tool-guard` by literal name OR any
// plugin ending in `-guard`, so ecosystem siblings light up without a
// code edit.

'use strict'

// Plugins whose messages read as session-start scaffolding: CLAUDE.md,
// AGENTS.md, codex hooks. First-turn arrival = family A; later-turn
// arrival demotes to family B (plugin-reminder) so the reader sees "the
// hooks got re-injected mid-session".
const SESSION_START_PLUGINS = new Set(['hooks-claude', 'hooks-codex'])

// Built-in "known" plugin catalogue for the B/G split (batch-1 review fix
//): a plugin name we recognise from the first-party bundle or
// our own trace-samples fixtures lights up as family B; anything outside
// this set AND outside the caller-supplied `ctx.knownPlugins` (populated
// from the daemon's `plugins/list` response) demotes to family G with
// muted tone. This is what makes family G meaningful — before the fix,
// unknown-plugin fixtures like `acme-notifier` were falling into B and
// G was never emitted, which is what the batch-1 review flagged.
const OFFICIAL_KNOWN_PLUGINS = new Set([
  // A / session-start hooks
  'hooks-claude', 'hooks-codex',
  // C — time-context tick
  'time-context',
  // D — repeat guard family (name-suffix pattern still catches siblings)
  'repeat-tool-guard',
  // F — approval policy
  'user-approval',
  // E — compact shadow
  'compact',
  // B — canonical first-party dev-tool plugins in fixtures / stock bundle
  'tool-bash', 'tool-read', 'tool-write', 'tool-edit',
  'tool-grep', 'tool-glob', 'tool-search',
])

// Family records — stable keys so the renderer/CSS/tests all key off the
// same strings. `tone` is a design token name resolved to CSS in style.css.
const FAMILIES = {
  // Icons here are typographic monochrome glyphs only — no color-emoji per
  // the 2026-07-16 UI ban (memory: dsh-product-strategy-2026-07-16 §UI 视觉
  // 禁令). The identity signal is carried by tone/label; the glyph is a
  // one-char column that stays consistent-width without pulling in font
  // fallback surprises across platforms.
  A: { key: 'A', kind: 'session-start',  icon: '>', tone: 'neutral', label: 'SessionStart' },
  B: { key: 'B', kind: 'plugin-reminder', icon: '+', tone: 'plugin',  label: 'plugin' },
  C: { key: 'C', kind: 'time-tick',       icon: '·', tone: 'info',    label: 'time' },
  D: { key: 'D', kind: 'guard',           icon: '!', tone: 'warn',    label: 'guard' },
  E: { key: 'E', kind: 'compact-shadow',  icon: '↓', tone: 'compact', label: 'compact summary' },
  F: { key: 'F', kind: 'approval-policy', icon: '*', tone: 'danger',  label: 'approval-policy' },
  G: { key: 'G', kind: 'unknown-plugin',  icon: '?', tone: 'muted',   label: 'plugin' },
  H: { key: 'H', kind: 'user-injected',   icon: '@', tone: 'accent',  label: 'user-injected' },
}

/**
 * Classify an inject-card event.
 *
 * @param {object} event
 * @param {object} [ctx] - dispatch-time context.
 *   `{ isFirstTurn }` tells the classifier whether the event's turn is
 *   the session's first — used to disambiguate family A (session-start)
 *   from family B (mid-session plugin reminder) when the plugin is
 *   hooks-*. When absent, the classifier assumes first-turn for hooks-*
 *   (backwards-compatible with fixture-only replays that don't track
 *   turn counters).
 *   `{ knownPlugins }` optional Set/Array of plugin names the runtime
 *   currently has mounted (from `plugins/list`). Combined with the
 *   built-in `OFFICIAL_KNOWN_PLUGINS` catalogue this decides B (known,
 *   plugin-tone) vs G (unknown, muted). Batch-1 review fix
 *   — before this parameter existed, everything with a plugin string
 *   fell into B and family G was never emitted.
 * @returns {{ family: string, plugin: string|null, meta: object } | null}
 */
function classifyInjectEvent(event, ctx) {
  if (!event || typeof event !== 'object') return null
  const data = event.data || event
  const source = data && data.source
  if (!source || typeof source !== 'object') return null

  const isFirstTurn = ctx && typeof ctx.isFirstTurn === 'boolean' ? ctx.isFirstTurn : true
  const runtimeKnown = ctx && ctx.knownPlugins
  const runtimeSet = runtimeKnown && typeof runtimeKnown[Symbol.iterator] === 'function'
    ? (runtimeKnown instanceof Set ? runtimeKnown : new Set(runtimeKnown))
    : null

  // Family E — the compact plugin's shadow user/message. Only user/message
  // events with source.plugin='compact' hit this branch; the classifier
  // stays honest about its input type.
  if (event.type === 'user/message' && source.kind === 'plugin' && source.plugin === 'compact') {
    return { family: 'E', plugin: 'compact', meta: FAMILIES.E }
  }

  // Everything else must be a context/message with a valid source.
  if (event.type !== 'context/message') return null

  // Family H — user-injected (skills, ad-hoc includes).
  if (source.kind === 'user') {
    return { family: 'H', plugin: null, meta: FAMILIES.H }
  }

  if (source.kind !== 'plugin') return null
  const plugin = typeof source.plugin === 'string' ? source.plugin : null
  if (!plugin) return null

  // Family C — time-context tick.
  if (plugin === 'time-context') {
    return { family: 'C', plugin, meta: FAMILIES.C }
  }

  // Family D — guard family. Matches literal name and *-guard suffix.
  if (plugin === 'repeat-tool-guard' || plugin.endsWith('-guard')) {
    return { family: 'D', plugin, meta: FAMILIES.D }
  }

  // Family F — approval policy changes.
  if (plugin === 'user-approval') {
    return { family: 'F', plugin, meta: FAMILIES.F }
  }

  // Family A — session-start hooks on the first turn. On later turns the
  // same plugin routes to family B so the reader sees "hooks re-ran".
  if (SESSION_START_PLUGINS.has(plugin) && isFirstTurn) {
    return { family: 'A', plugin, meta: FAMILIES.A }
  }

  // Batch-1 review fix: the B/G split is what gives family G
  // its reason to exist. A plugin is "known" if it's in our first-party
  // catalogue OR the runtime advertises it via `plugins/list`. Anything
  // else lands in G with muted tone so unknown ecosystem plugins are
  // visually distinct from first-party ones.
  const known = OFFICIAL_KNOWN_PLUGINS.has(plugin) || (runtimeSet && runtimeSet.has(plugin))
  if (!known) {
    return { family: 'G', plugin, meta: FAMILIES.G }
  }

  // Family B — a known plugin outside the specialised buckets above.
  return { family: 'B', plugin, meta: FAMILIES.B }
}

/**
 * Sequence-collapsing helper: given an ordered list of classified inject
 * results, group runs of ≥3 same-family entries into a single "N-of-family"
 * bucket. Runs of 1–2 pass through unchanged. Preserves original order.
 *
 * Used by the renderer to fold session-start boilerplate (CLAUDE.md + a
 * dozen AGENTS.md fragments) into a single expandable row. The strategy
 * list §1.3 red-line: "同一 turn 内同族连续 ≥3 条时合并成一张 L0".
 *
 * @param {Array<{ family: string, event: object }>} entries
 * @returns {Array<{ kind: 'single'|'run', family: string, entries: Array }>}
 */
function collapseRuns(entries) {
  const out = []
  let i = 0
  while (i < entries.length) {
    const fam = entries[i].family
    let j = i
    while (j < entries.length && entries[j].family === fam) j++
    const run = entries.slice(i, j)
    if (run.length >= 3) {
      out.push({ kind: 'run', family: fam, entries: run })
    } else {
      for (const one of run) out.push({ kind: 'single', family: fam, entries: [one] })
    }
    i = j
  }
  return out
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { classifyInjectEvent, collapseRuns, FAMILIES, OFFICIAL_KNOWN_PLUGINS }
}
if (typeof window !== 'undefined') {
  window.__dshInjectFamily = { classifyInjectEvent, collapseRuns, FAMILIES, OFFICIAL_KNOWN_PLUGINS }
}
