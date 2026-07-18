// Static overlay validation. Pure functions that produce a diagnostic list
// the Plugins tab paints inline against the offending row.
//
// The validation is deliberately shallow — we don't try to reason about the
// cordis plugin protocol here. We answer three questions the UI needs to
// give useful feedback the moment the user hits "Apply + restart":
//
//   1. Does every entry name resolve to a real package or file? (An unknown
//      package spec turns into a fail-loud loader error at boot; catching it
//      here means the user gets a red row instead of a stderr blob.)
//   2. Does every patch id target an entry that exists in the base leaf?
//      (Include-plugin patches are keyed by id; a typo silently no-ops.)
//   3. Do the effective entries look coherent as a whole? (Duplicate ids,
//      near-duplicate ids that suggest a typo, an overwhelming tool count.)
//
// A2's runtime probe layer (`plugin-probe.js`) handles the boot-time class of
// errors those checks can't catch — deep config errors, peer failures,
// service-not-found. The two layers are meant to be complementary; static
// validation is fast enough to run on every save, the probe is opt-in.
//
// Nothing here touches the disk except `packageResolves` — it uses fs
// existence checks against a caller-supplied list of workspace paths + a
// node_modules root, so tests can supply an in-memory fixture without
// mocking `require.resolve`.

'use strict'

const fs = require('node:fs')
const path = require('node:path')

// ---------- workspace scan ---------------------------------------------------

/**
 * Walk the dev-clone `packages/` tree once and return the set of
 * `@deepseek-ai/dsh-*` package names it publishes. Called at shell start; the
 * result is cached by the caller. Missing dir → empty set (validation degrades
 * to node_modules-only lookup).
 *
 * @param {string} packagesRoot - Absolute path to `deepseek-harness-dev/packages`.
 * @returns {Set<string>}
 */
function scanWorkspacePackages(packagesRoot) {
  const out = new Set()
  if (!packagesRoot) return out
  let groups
  try { groups = fs.readdirSync(packagesRoot, { withFileTypes: true }) }
  catch (_) { return out }
  for (const g of groups) {
    if (!g.isDirectory()) continue
    const groupDir = path.join(packagesRoot, g.name)
    let pkgs
    try { pkgs = fs.readdirSync(groupDir, { withFileTypes: true }) }
    catch (_) { continue }
    for (const p of pkgs) {
      if (!p.isDirectory()) continue
      const pkgJson = path.join(groupDir, p.name, 'package.json')
      try {
        const parsed = JSON.parse(fs.readFileSync(pkgJson, 'utf8'))
        if (parsed && typeof parsed.name === 'string') out.add(parsed.name)
      } catch (_) { /* not every dir carries a package.json; ignore */ }
    }
  }
  return out
}

// ---------- name classification ---------------------------------------------

/**
 * Classify what an entry's `name` field points at. Cordis leaves accept three
 * shapes: bare npm specifiers (`@scope/pkg`), absolute paths, or paths
 * relative to the leaf file. We don't try to resolve the path here — that's
 * `packageResolves` — just tag the shape so downstream messages are precise.
 *
 * @param {string} name
 * @returns {'package'|'relative-path'|'absolute-path'|'unknown'}
 */
function classifyName(name) {
  if (!name) return 'unknown'
  if (name.startsWith('@') || /^[a-z0-9]/i.test(name) && !name.includes('/') && !name.includes('.') && !name.includes(path.sep)) {
    // Bare packages: either `@scope/name` or a single-token like `cordis`.
    // Single-token with a slash is still a package if the first path segment
    // is a scope; otherwise treat it as a path.
    return 'package'
  }
  if (name.startsWith('@')) return 'package'
  if (name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name)) return 'absolute-path'
  // A leading `.` (./, ../) is the canonical relative-path signal; anything
  // else with a slash is a package unless it's clearly path-shaped (has a
  // file extension or a `..` segment).
  if (name.startsWith('.') || name.includes('/..') || /\.[a-z]+$/i.test(name)) {
    return 'relative-path'
  }
  return 'package'
}

/**
 * Check whether an entry's package/path resolves.
 *  - Bare package: match against `knownPackages` (workspace + node_modules
 *    listing) — no dynamic require.
 *  - Path: fs.existsSync against `leafDir` for relative, direct for absolute.
 *
 * Returns null on success; a short reason string on failure.
 *
 * @param {{id:string,name:string}} entry
 * @param {{knownPackages:Set<string>, leafDir:string}} ctx
 * @returns {string|null}
 */
function packageResolves(entry, ctx) {
  const kind = classifyName(entry.name)
  if (kind === 'unknown') return 'missing name'
  if (kind === 'package') {
    return ctx.knownPackages.has(entry.name)
      ? null
      : `package not found on workspace or in node_modules: ${entry.name}`
  }
  const abs = kind === 'absolute-path' ? entry.name : path.resolve(ctx.leafDir, entry.name)
  return fs.existsSync(abs) ? null : `file does not exist: ${entry.name}`
}

// ---------- edit distance for near-duplicate detection ----------------------

/**
 * Two-row Levenshtein — enough for short plugin ids. Used to flag likely
 * typos ("bash" vs "bash-local" would clear this threshold; we care about
 * the near-collision case, not the sibling-package case).
 */
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

// ---------- validation drivers ----------------------------------------------

/**
 * Run the static-layer checks. Returns a list of diagnostics; the caller
 * classifies severity into UI red/amber/green rows. Each diagnostic carries
 * enough anchoring for the UI: `line` (1-based row in the file), `id` (patch
 * or entry id where applicable), `scope` (`entry` for base leaf entries,
 * `patch` for overlay patches, `overall` for whole-list heuristics).
 *
 * @param {{
 *   baseEntries: Array<{id:string,name:string,line?:number}>,
 *   overlay: {base:string, patches:Array<{id:string,name?:string,disabled?:boolean,line?:number}>},
 *   knownPackages: Set<string>,
 *   leafDir: string,
 *   toolCountWarnAt?: number
 * }} input
 * @returns {Array<{severity:'error'|'warn', scope:'entry'|'patch'|'overall', id?:string, line?:number, message:string}>}
 */
function validate(input) {
  const {
    baseEntries,
    overlay,
    knownPackages,
    leafDir,
    toolCountWarnAt = 30,
  } = input
  const diags = []
  const baseById = new Map(baseEntries.map((e) => [e.id, e]))

  // 1. Base entries: each `name` must resolve.
  for (const entry of baseEntries) {
    const reason = packageResolves(entry, { knownPackages, leafDir })
    if (reason) {
      diags.push({
        severity: 'error',
        scope: 'entry',
        id: entry.id,
        line: entry.line,
        message: reason,
      })
    }
  }

  // 2. Patches: id must reference a base entry (unless the patch is adding a
  // new entry — signalled by a `name` field). Adding entries with a `name`
  // is also validated for resolvability.
  for (const patch of overlay.patches || []) {
    const inBase = baseById.has(patch.id)
    if (!inBase && !patch.name) {
      diags.push({
        severity: 'error',
        scope: 'patch',
        id: patch.id,
        line: patch.line,
        message: `patch targets id "${patch.id}" which is not in the base leaf`,
      })
      continue
    }
    if (!inBase && patch.name) {
      // A "new entry" patch: the name has to resolve too.
      const reason = packageResolves({ id: patch.id, name: patch.name }, { knownPackages, leafDir })
      if (reason) {
        diags.push({
          severity: 'error',
          scope: 'patch',
          id: patch.id,
          line: patch.line,
          message: reason,
        })
      }
    }
  }

  // 3. Whole-list heuristics — only fire when the effective list is
  // computable (base entries present).
  if (baseEntries.length > 0) {
    // Duplicate ids in base — shouldn't happen with a well-formed leaf, but
    // catch it before include-plugin errors out with a less useful message.
    const seenIds = new Map()
    for (const e of baseEntries) {
      if (seenIds.has(e.id)) {
        diags.push({
          severity: 'error',
          scope: 'overall',
          id: e.id,
          line: e.line,
          message: `duplicate id in base leaf: ${e.id}`,
        })
      } else {
        seenIds.set(e.id, e)
      }
    }

    // Near-duplicate ids: `edit distance <= 2` and length ≥ 4 (short ids
    // like "fs" and "os" are legitimately close). Skip pairs where one id
    // is disabled — those are intentional side-by-sides.
    const disabledIds = new Set(
      (overlay.patches || []).filter((p) => p.disabled === true).map((p) => p.id),
    )
    const activeIds = baseEntries.map((e) => e.id).filter((id) => !disabledIds.has(id))
    for (let i = 0; i < activeIds.length; i++) {
      for (let j = i + 1; j < activeIds.length; j++) {
        const a = activeIds[i], b = activeIds[j]
        if (a.length < 4 || b.length < 4) continue
        const d = editDistance(a, b)
        if (d > 0 && d <= 2) {
          diags.push({
            severity: 'warn',
            scope: 'overall',
            id: a,
            message: `near-duplicate ids "${a}" and "${b}" — one may be a typo`,
          })
        }
      }
    }

    // Tool count heuristic. We don't yet know which entries are tool-shaped
    // (that requires the runtime), so we treat every enabled entry as a
    // plausible tool contributor. The threshold is deployment-tunable via
    // `toolCountWarnAt`.
    if (activeIds.length > toolCountWarnAt) {
      diags.push({
        severity: 'warn',
        scope: 'overall',
        message: `${activeIds.length} enabled entries — many tools can dilute model attention (advisory threshold ${toolCountWarnAt})`,
      })
    }
  }

  return diags
}

module.exports = {
  scanWorkspacePackages,
  classifyName,
  packageResolves,
  editDistance,
  validate,
}
