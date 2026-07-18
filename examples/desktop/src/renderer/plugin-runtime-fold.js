(function () {
// Pure fold that pairs the fs-parsed effective plugin list with the runtime's
// `plugins/list` response. Kept out of plugins-ui.js so the mapping can be
// unit-tested under node --test without JSDOM.
//
// Matching heuristic: the fs entry's `name` (the package specifier from the
// leaf's `name:` field) is not the same string as the runtime fiber's `name`
// (usually the plugin's exported `name`, the class name, or `apply.name`).
// The runtime only publishes the fiber name; the config only publishes the
// package specifier. We narrow the pairing with a normalization step:
//   - take the basename after any `../`/scope prefix
//   - drop a `.ts`/`.js` extension
//   - drop a leading `dsh-` prefix (repo convention)
//   - lower-case + strip `-`/`_`/`.` separators
// A specifier and a fiber name that reduce to the same key are treated as the
// same plugin. This is a best-effort fold: cordis may name a fiber whatever
// the plugin's `name` field says, which need not match the package basename.
// When the heuristic misses, the row's runtime cell says `unmatched` and the
// runtime entry shows up in the "extra runtime plugins" tail. This is honest —
// the user's `cordis.yml` names are what they authored; the runtime names
// are what cordis actually loaded.

'use strict'

/**
 * @param {string} raw
 * @returns {string}
 */
function normalize(raw) {
  if (!raw) return ''
  let s = String(raw).toLowerCase()
  // Take the basename: everything after the last `/` (drops the npm scope,
  // any leading `../`, and any src/index path segments authored in a leaf).
  const lastSlash = s.lastIndexOf('/')
  if (lastSlash >= 0) s = s.slice(lastSlash + 1)
  // Drop a trailing `.ts` / `.js` — leaves and cordis fibers name themselves
  // without the extension, but a relative path in a leaf's `name:` keeps it.
  s = s.replace(/\.(ts|js|mjs|cjs)$/, '')
  // Drop the DSH package prefix (`dsh-bash-local` → `bash-local`) so a fs
  // specifier lines up with the plugin's exported `name` field.
  s = s.replace(/^dsh-/, '')
  // Drop separators so `bash-local` and `BashLocal` collapse to `bashlocal`.
  s = s.replace(/[-_.]/g, '')
  return s
}

/**
 * Fold the fs-parsed rows with the runtime rows into one shape per fs entry
 * plus a residual list of runtime entries that no fs row matched.
 *
 * @param {Array<{id:string,name:string,disabled:boolean,source:'base'|'user'}>} entries
 * @param {Array<{name:string,state:string}>|undefined} runtimePlugins
 * @returns {{
 *   rows: Array<{
 *     id: string,
 *     name: string,
 *     disabled: boolean,
 *     source: 'base'|'user',
 *     runtime: null | { name: string, state: string, mismatch: boolean, reason?: string },
 *   }>,
 *   extras: Array<{ name: string, state: string }>,
 * }}
 */
function foldRuntime(entries, runtimePlugins) {
  const rows = []
  if (!Array.isArray(runtimePlugins)) {
    for (const e of entries) rows.push({ ...e, runtime: null })
    return { rows, extras: [] }
  }
  // Bucket runtime plugins by normalized key so we can consume them as we go
  // through the fs entries. Duplicates (same plugin mounted twice) live under
  // the same key and are dequeued in order.
  const bucket = new Map()
  for (const rp of runtimePlugins) {
    const key = normalize(rp.name)
    if (!bucket.has(key)) bucket.set(key, [])
    bucket.get(key).push(rp)
  }
  for (const e of entries) {
    const key = normalize(e.name) || normalize(e.id)
    const q = bucket.get(key)
    if (q && q.length > 0) {
      const rp = q.shift()
      const mismatch = detectMismatch(e, rp)
      rows.push({
        ...e,
        runtime: {
          name: rp.name,
          state: rp.state,
          mismatch: !!mismatch,
          ...(mismatch ? { reason: mismatch } : {}),
        },
      })
    } else {
      // Nothing in the runtime bucket for this key. If the fs row is enabled
      // (i.e. the user expects it to be running) that's a mismatch worth
      // flagging; a disabled row that isn't in the runtime is expected.
      const mismatch = e.disabled ? null : 'configured enabled but not loaded'
      rows.push({
        ...e,
        runtime: {
          name: '',
          state: 'absent',
          mismatch: !!mismatch,
          ...(mismatch ? { reason: mismatch } : {}),
        },
      })
    }
  }
  const extras = []
  for (const q of bucket.values()) for (const rp of q) extras.push(rp)
  return { rows, extras }
}

/**
 * A row is a mismatch when the user's authored state (enabled/disabled)
 * disagrees with the observed runtime state. active/loading count as running;
 * pending/failed/disposed/unloading count as not-yet-or-no-longer running.
 * A disabled fs entry that still shows up in the runtime is a mismatch
 * ("disabled in overlay but still loaded"), which usually means the user
 * forgot to restart the runtime after editing the overlay.
 *
 * @param {{disabled:boolean}} e
 * @param {{state:string}} rp
 * @returns {string|null}
 */
function detectMismatch(e, rp) {
  const running = rp.state === 'active' || rp.state === 'loading'
  if (e.disabled && running) return 'disabled in overlay but still loaded'
  if (!e.disabled && !running && rp.state !== 'pending') {
    return `configured enabled but runtime is ${rp.state}`
  }
  // A `pending` state is not a mismatch on its own — the plugin is waiting on
  // an injected service. Callers who want to surface that as a warning can
  // read `rp.state` directly.
  return null
}

/**
 * Roll up a fold result into a runtime-health snapshot the diagnostics strip
 * can render as a layered phrase. Kept side-effect-free so plugins-ui's
 * renderDiagnosticsStrip can call it and node --test can pin the phrase.
 *
 * Buckets over enabled rows only (disabled rows aren't expected to load):
 *   active   — rp.state ∈ {'active','loading'}       (rendered as "running")
 *   pending  — rp.state === 'pending'                (waiting on deps)
 *   notLoaded — the row has no runtime match or a non-running state         (renders as "not loaded")
 *
 * Status:
 *   'unknown' — nothing enabled, or every row's runtime is absent — usually
 *              means the daemon has not reported yet. Callers show a neutral
 *              muted strip in that case, not an OK/warn one.
 *   'active'  — every enabled row is running.
 *   'partial' — some enabled rows are pending or not loaded — used to WARN
 *              so the strip can't shout OK when the runtime disagrees with
 *              the authored state.
 *
 * @param {{ rows: Array<{disabled?:boolean, runtime?: null | {state?:string}}> }|null|undefined} fold
 * @returns {{status:'unknown'|'active'|'partial', expected:number, active:number, pending:number, notLoaded:number}}
 */
function healthSnapshot(fold) {
  if (!fold || !Array.isArray(fold.rows)) {
    return { status: 'unknown', expected: 0, active: 0, pending: 0, notLoaded: 0 }
  }
  let expected = 0
  let active = 0
  let pending = 0
  let notLoaded = 0
  let sawRuntime = false
  for (const row of fold.rows) {
    if (row.disabled) continue
    expected += 1
    const s = row.runtime && row.runtime.state
    if (s) sawRuntime = true
    if (s === 'active' || s === 'loading') active += 1
    else if (s === 'pending') pending += 1
    else notLoaded += 1
  }
  if (expected === 0 || !sawRuntime) {
    return { status: 'unknown', expected, active: 0, pending: 0, notLoaded: 0 }
  }
  if (active === expected) return { status: 'active', expected, active, pending: 0, notLoaded: 0 }
  return { status: 'partial', expected, active, pending, notLoaded }
}

/**
 * Render a health snapshot as the layered strip phrase the docs call for:
 *   "5 enabled · 3 running · 2 not loaded"
 * The count for each bucket is dropped when zero so the strip stays compact;
 * `unknown` returns a placeholder the caller can wrap in a muted tone.
 *
 * @param {ReturnType<typeof healthSnapshot>} snapshot
 * @returns {string}
 */
function healthPhrase(snapshot) {
  if (!snapshot || snapshot.status === 'unknown') {
    return snapshot && snapshot.expected > 0
      ? `${snapshot.expected} enabled · runtime status unknown`
      : 'runtime status unknown'
  }
  const parts = [`${snapshot.expected} enabled`, `${snapshot.active} running`]
  if (snapshot.pending > 0) parts.push(`${snapshot.pending} waiting`)
  if (snapshot.notLoaded > 0) parts.push(`${snapshot.notLoaded} not loaded`)
  return parts.join(' · ')
}

/**
 * Text for the strip when the fold rolls up to `unknown`. The `unknown`
 * status covers three different realities the strip should not merge:
 *
 *   - `no-daemon`: stdio profile or a daemon profile that never started.
 *     Stable state, not a transient. Team-lead spec (,
 *     2026-07-16): show "runtime state unavailable (no daemon on this
 *     profile)" instead of the earlier misleading "0/5 mounted".
 *   - `MethodNotFound`: daemon is up but does not implement plugins/list.
 *     Suggests the runtime version is old.
 *   - anything else (no `state.lastRuntime` yet, or a wire error): fall
 *     back to the generic phrase with a "Test boot to check" hint.
 *
 * All three keep the outer three-state model (`unknown | active | partial`)
 * — no fourth state (team-lead ruling 2026-07-16). This is separate from
 * healthPhrase() so plugins-ui can call it once from the strip and once
 * from the row hover without duplicating the branch.
 *
 * @param {ReturnType<typeof healthSnapshot>|null|undefined} snapshot
 * @param {{ reason?: string }|null|undefined} runtime — the raw
 *   `state.lastRuntime` value (or `{}` if not yet fetched).
 * @returns {string}
 */
function unknownReasonPhrase(snapshot, runtime) {
  const rt = runtime || {}
  if (rt.reason === 'no-daemon') {
    return 'runtime state unavailable (no daemon on this profile)'
  }
  if (rt.reason === 'MethodNotFound') {
    return 'runtime state unavailable (daemon does not implement plugins/list)'
  }
  return healthPhrase(snapshot) + ' (Test boot to check)'
}

// -- CJS + global export -----------------------------------------------------

const api = { foldRuntime, normalize, healthSnapshot, healthPhrase, unknownReasonPhrase }
if (typeof module !== 'undefined' && module.exports) module.exports = api
if (typeof globalThis !== 'undefined') globalThis.PluginRuntimeFold = api
})()
