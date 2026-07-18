// Plugin-list effect heuristics (A3). Pure functions that produce the
// summary bar the Plugins tab paints above the diagnostics strip.
//
// Where this sits relative to the other validation layers:
//   - plugin-validation.js (A1): "does this file resolve" — errors/warnings
//     that map to specific rows.
//   - plugin-probe.js (A2): "does this leaf actually boot" — runtime check
//     that's opt-in because a daemon boot is slow.
//   - plugin-heuristics.js (A3, this file): "does this list *feel* right" —
//     structured facts about the effective list the user can see at a glance.
//     Not an error, not a warning: an at-a-glance readout.
//
// The A1 diagnostics stream is a flat list geared to per-row anchoring. A3
// wants aggregate signals for a compact info bar, so we return a shaped
// `Summary` record instead of adding more diagnostics with different scopes.
// The two layers are complementary: A1 will still flag a near-duplicate as
// an amber row (edit distance ≤ 2), while A3 tightens that to distance ≤ 1
// AND adds the prefix-overlap axis to catch "bash" vs "bashlocal" pairs the
// distance heuristic misses.

'use strict'

// Two-row Levenshtein — same shape as plugin-validation's copy. Duplicated
// intentionally so this module has no cross-file dependency (both are pure
// and small; a shared "string-metrics" module would be less legible).
function editDistance(a, b) {
  if (a === b) return 0
  const m = a.length, n = b.length
  if (m === 0 || n === 0) return m + n
  let prev = new Array(n + 1)
  let cur = new Array(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    cur[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, cur] = [cur, prev]
  }
  return prev[n]
}

/**
 * Detect near-collision pairs among a set of active plugin ids. Returns an
 * array of `{a, b, kind}` records where `kind` is either `'edit-distance'`
 * (Levenshtein ≤ threshold) or `'prefix'` (one id is a proper prefix of the
 * other with at least `prefixMinLen` characters overlap).
 *
 * Both checks skip pairs where either id is shorter than 4 chars — short ids
 * like "fs" and "os" or "cli" and "clr" collide trivially and are usually
 * intentional. Every pair is emitted at most once (a<b lexicographically).
 *
 * @param {string[]} ids
 * @param {{editThreshold?:number, prefixMinLen?:number}} [opts]
 * @returns {Array<{a:string,b:string,kind:'edit-distance'|'prefix'}>}
 */
function findConflicts(ids, opts = {}) {
  const editThreshold = opts.editThreshold ?? 1
  const prefixMinLen = opts.prefixMinLen ?? 4
  const out = []
  const seenPair = new Set()
  const sorted = [...ids].sort()
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i], b = sorted[j]
      if (a === b) continue
      if (a.length < 4 || b.length < 4) continue
      const key = `${a}\0${b}`
      if (seenPair.has(key)) continue
      // Prefix overlap: one id fully contained at the start of the other,
      // shorter one at least prefixMinLen. Catches "bash" vs "bash-local".
      const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a]
      if (longer.startsWith(shorter) && shorter.length >= prefixMinLen) {
        out.push({ a, b, kind: 'prefix' })
        seenPair.add(key)
        continue
      }
      const d = editDistance(a, b)
      if (d > 0 && d <= editThreshold) {
        out.push({ a, b, kind: 'edit-distance' })
        seenPair.add(key)
      }
    }
  }
  return out
}

/**
 * Fold the effective plugin list into the summary the Plugins tab renders
 * above the diagnostics strip.
 *
 *   - `enabledCount` / `disabledCount` / `totalCount`: entry counts.
 *   - `conflicts`: pairs from `findConflicts` — likely-typo ids.
 *   - `toolWarning`: `{count, threshold}` when enabled count > threshold,
 *     otherwise `null`. Named "tool" because each enabled entry is a
 *     plausible tool contributor to the runtime; the shell doesn't yet know
 *     which entries emit tool schemas versus pure services, so it treats
 *     them uniformly.
 *
 * @param {{
 *   entries: Array<{id:string, disabled?:boolean}>,
 *   toolWarnAt?: number,
 *   editThreshold?: number,
 *   prefixMinLen?: number
 * }} input
 * @returns {{
 *   enabledCount: number,
 *   disabledCount: number,
 *   totalCount: number,
 *   conflicts: Array<{a:string,b:string,kind:'edit-distance'|'prefix'}>,
 *   toolWarning: null | {count:number, threshold:number}
 * }}
 */
function summarize(input) {
  const {
    entries = [],
    toolWarnAt = 30,
    editThreshold = 1,
    prefixMinLen = 4,
  } = input
  const enabled = entries.filter((e) => !e.disabled)
  const disabled = entries.filter((e) => e.disabled)
  const conflicts = findConflicts(
    enabled.map((e) => e.id),
    { editThreshold, prefixMinLen },
  )
  const toolWarning = enabled.length > toolWarnAt
    ? { count: enabled.length, threshold: toolWarnAt }
    : null
  return {
    enabledCount: enabled.length,
    disabledCount: disabled.length,
    totalCount: entries.length,
    conflicts,
    toolWarning,
  }
}

module.exports = { summarize, findConflicts, editDistance }
