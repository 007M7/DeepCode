// Plugin market: reads a curated index (config/plugin-index.json) and folds it
// against the current base leaf + user overlay to answer "is this entry
// already installed?" for the Browse UI.
//
// Two responsibilities:
//   1. parseIndex(text|obj) → normalized [{id, package, title, ...}] with the
//      shape validated. A bad entry is skipped with a warning; a bad top-level
//      is a hard error (the file is authored, not user data).
//   2. computeMarketState(index, baseEntries, overlayPatches) → for each index
//      row, an install-status verdict: 'installed' | 'available' | 'disabled'.
//      Installed means the entry's id resolves to an active entry in the folded
//      list; disabled means it's present but a user patch turned it off.
//
// The install path itself lives in main.js (writes to plugins.addPatch); this
// module is pure so it round-trips under `node --test` without Electron.
//
// Future: `source: 'url'` entries fetch a remote manifest. This lands in the
// same shape so the renderer only cares about the normalized rows; the wire
// fetch happens once in main.js. See README's "Marketplace" section.

'use strict'

const REQUIRED_FIELDS = ['id', 'package', 'title', 'description']

/**
 * Parse a plugin-index.json blob (string or already-parsed object) into a
 * normalized list of rows. Unknown fields on entries are preserved verbatim so
 * a future field (e.g. `iconUrl`) rides through without a code change.
 *
 * @param {string|object} input
 * @returns {{version:number, source:string, entries:Array<{id:string,package:string,title:string,description:string,author?:string,permissions?:string[],tags?:string[],entry?:{id:string,name:string}}>, updatedAt?:string, skipped?:Array<{index:number,reason:string}>}}
 */
function parseIndex(input) {
  const raw = typeof input === 'string' ? JSON.parse(input) : input
  if (!raw || typeof raw !== 'object') throw new Error('plugin-index: root is not an object')
  if (raw.version !== 1) throw new Error(`plugin-index: unsupported version ${raw.version}`)
  if (!Array.isArray(raw.entries)) throw new Error('plugin-index: `entries` must be an array')
  const entries = []
  const skipped = []
  for (let i = 0; i < raw.entries.length; i++) {
    const e = raw.entries[i]
    if (!e || typeof e !== 'object') { skipped.push({ index: i, reason: 'not an object' }); continue }
    let bad = null
    for (const k of REQUIRED_FIELDS) {
      if (typeof e[k] !== 'string' || e[k].trim() === '') { bad = k; break }
    }
    if (bad) { skipped.push({ index: i, reason: `missing field: ${bad}` }); continue }
    // `entry` defaults to { id, name: package } if the author omitted it — the
    // overlay writer only needs those two.
    const entry = e.entry && typeof e.entry === 'object'
      ? { id: String(e.entry.id || e.id), name: String(e.entry.name || e.package) }
      : { id: e.id, name: e.package }
    entries.push({
      id: e.id,
      package: e.package,
      title: e.title,
      description: e.description,
      author: e.author || '',
      permissions: Array.isArray(e.permissions) ? e.permissions.slice() : [],
      tags: Array.isArray(e.tags) ? e.tags.slice() : [],
      entry,
    })
  }
  return {
    version: raw.version,
    source: raw.source || 'local',
    entries,
    updatedAt: raw.updatedAt,
    skipped,
  }
}

/**
 * Given a parsed index and the current base+overlay state, tag each market
 * row with an install status so the Browse UI can render Install / Installed /
 * Uninstall correctly.
 *
 * Status semantics:
 *   - `installed`  – the entry.id is present + enabled in the folded list.
 *   - `disabled`   – the entry.id exists but a user patch disables it.
 *   - `available`  – the entry.id is not present in the folded list.
 * `installSource` is `base` when the entry lives in the base leaf (so the user
 * can't uninstall — they can only disable), `user` when a user overlay patch
 * added it (uninstall = drop the patch), or null for `available`.
 *
 * @param {ReturnType<parseIndex>} index
 * @param {{id:string,name:string}[]} baseEntries
 * @param {Array<{id:string,disabled?:boolean,name?:string,insert?:string}>} overlayPatches
 * @returns {Array<{row: ReturnType<parseIndex>['entries'][number], status: 'installed'|'disabled'|'available', installSource: 'base'|'user'|null}>}
 */
function computeMarketState(index, baseEntries, overlayPatches) {
  const baseById = new Map(baseEntries.map((e) => [e.id, e]))
  const patchById = new Map((overlayPatches || []).map((p) => [p.id, p]))
  return index.entries.map((row) => {
    const targetId = row.entry.id
    const inBase = baseById.has(targetId)
    const patch = patchById.get(targetId)
    // A patch that introduces a new entry has a `name` and no matching base
    // entry — treat that as "installed via user overlay". A patch on an
    // existing base entry only carries `disabled` semantics for us.
    const userIntroduced = !inBase && !!(patch && patch.name)
    const present = inBase || userIntroduced
    if (!present) return { row, status: 'available', installSource: null }
    const disabled = !!(patch && patch.disabled)
    return {
      row,
      status: disabled ? 'disabled' : 'installed',
      installSource: inBase ? 'base' : 'user',
    }
  })
}

/**
 * Group market rows by tag for the browse view — a small helper so the UI can
 * render "Coding", "Research", "Reliability" sections without a second pass.
 * Rows with no tags land under an "other" bucket.
 * @param {ReturnType<parseIndex>['entries']} rows
 */
function groupByTag(rows) {
  const buckets = new Map()
  for (const r of rows) {
    if (!r.tags || r.tags.length === 0) {
      if (!buckets.has('other')) buckets.set('other', [])
      buckets.get('other').push(r)
      continue
    }
    for (const t of r.tags) {
      if (!buckets.has(t)) buckets.set(t, [])
      buckets.get(t).push(r)
    }
  }
  return buckets
}

module.exports = {
  parseIndex,
  computeMarketState,
  groupByTag,
}
