// Startup probe layer (A2). Boots the daemon-demo against a candidate leaf
// on an isolated socket, waits for ping-or-fail, and maps stderr fail-loud
// lines back to plugin entries so the Plugins tab can red-flag the offending
// row.
//
// The probe is a "does this boot?" check, not a coverage check. On success
// we return `{ok: true}`; on failure we return the parsed stderr so the UI
// paints an inline error under the plausibly-guilty entry.
//
// Fail-loud parsing: the loader's `assertEntriesLoaded` prints a message
// containing the missing plugin id / package name. We match on a handful
// of shapes we've observed in the dev clone; anything unrecognised falls
// through to a whole-list error banner.

'use strict'

const { spawnIsolatedDaemon } = require('./isolated-daemon.js')

// Patterns that map a fail-loud stderr line to a specific entry. Each entry
// is `{re, kind}` — the first capture group is the id or package name; the
// caller matches that against the base+patches to find the row.
//
// Kept small and honest: only patterns we've actually seen. Adding a new
// pattern should come with a test that exercises the observed stderr.
const FAIL_PATTERNS = [
  // Cordis loader: `Cannot find module '@scope/pkg'` or a plain "not found".
  { re: /Cannot find module ['"]([^'"]+)['"]/, kind: 'package' },
  // dsh-loader's fail-loud output: `plugin "id" failed to load: …`
  { re: /plugin ['"]([^'"]+)['"] failed to load/i, kind: 'id' },
  // Missing service (e.g. session-query dropped, dependent plugin trips)
  { re: /service ['"]([^'"]+)['"] not found/i, kind: 'service' },
  // Config validation surfacing zod issues at a leaf entry
  { re: /invalid config for ['"]([^'"]+)['"]/i, kind: 'id' },
]

/**
 * Parse the daemon's captured stderr into `[{kind, value, message}, …]`.
 * `kind` is one of `'package' | 'id' | 'service' | 'unknown'`. The last
 * catchall preserves the raw line so the UI can still show a whole-list
 * banner when nothing pattern-matches.
 */
function parseFailLoudLines(stderrText) {
  if (!stderrText) return []
  const lines = stderrText.split(/\r?\n/)
  const out = []
  for (const line of lines) {
    if (!line.trim()) continue
    let matched = false
    for (const pat of FAIL_PATTERNS) {
      const m = line.match(pat.re)
      if (m) {
        out.push({ kind: pat.kind, value: m[1], message: line.trim() })
        matched = true
        break
      }
    }
    // Also collect obvious error markers even if the pattern didn't hit.
    if (!matched && /error|fail|throw|❌|✗/i.test(line)) {
      out.push({ kind: 'unknown', value: null, message: line.trim() })
    }
  }
  return out
}

/**
 * Given parsed fail-loud findings and the current base/overlay entries,
 * emit diagnostics anchored to plugin rows where possible. Anything without
 * an id match goes to the top-level banner via `overall: true`.
 *
 * @param {Array<{kind:string,value:string|null,message:string}>} findings
 * @param {Array<{id:string,name:string}>} baseEntries
 * @param {Array<{id:string,name?:string}>} overlayPatches
 */
function anchorFindings(findings, baseEntries, overlayPatches) {
  const byPackageName = new Map()
  for (const e of baseEntries) byPackageName.set(e.name, e)
  for (const p of overlayPatches || []) if (p.name) byPackageName.set(p.name, p)
  const byId = new Map()
  for (const e of baseEntries) byId.set(e.id, e)
  for (const p of overlayPatches || []) if (p.id) byId.set(p.id, p)

  const diags = []
  for (const f of findings) {
    if (f.kind === 'package' && f.value && byPackageName.has(f.value)) {
      const entry = byPackageName.get(f.value)
      diags.push({
        severity: 'error',
        scope: 'entry',
        id: entry.id,
        message: `boot: ${f.message}`,
      })
      continue
    }
    if ((f.kind === 'id' || f.kind === 'service') && f.value && byId.has(f.value)) {
      diags.push({
        severity: 'error',
        scope: 'entry',
        id: f.value,
        message: `boot: ${f.message}`,
      })
      continue
    }
    diags.push({
      severity: 'error',
      scope: 'overall',
      message: `boot: ${f.message}`,
    })
  }
  return diags
}

/**
 * Boot an isolated daemon over `overlayOrLeafPath`, wait up to
 * `timeoutMs`, and return `{ok, diagnostics, stderrTail}`. On success
 * diagnostics is empty. On failure we anchor stderr findings to plugin
 * entries using `baseEntries + overlayPatches`.
 *
 * @param {{
 *   overlayOrLeafPath: string,
 *   daemonBin: string,
 *   tsxSpecifier: string,
 *   tsxTsconfigPath: string,
 *   baseEntries: Array<{id:string,name:string}>,
 *   overlayPatches: Array<{id:string,name?:string,disabled?:boolean}>,
 *   timeoutMs?: number,
 * }} spec
 */
async function probeBoot(spec) {
  const {
    overlayOrLeafPath, daemonBin, tsxSpecifier, tsxTsconfigPath,
    baseEntries, overlayPatches, timeoutMs = 10000,
  } = spec
  try {
    const iso = await Promise.race([
      spawnIsolatedDaemon({
        overlayOrLeafPath, daemonBin, tsxSpecifier, tsxTsconfigPath,
        purpose: 'probe',
      }),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(`probe boot exceeded ${timeoutMs}ms`)),
        timeoutMs,
      )),
    ])
    const stderrTail = iso.stderrTail()
    // Tear the probe down right away — it's a one-shot health check, not a
    // long-lived companion.
    await iso.dispose()
    return { ok: true, diagnostics: [], stderrTail }
  } catch (err) {
    const stderrTail = err.stderrTail || ''
    const findings = parseFailLoudLines(stderrTail)
    const diagnostics = anchorFindings(findings, baseEntries, overlayPatches || [])
    if (diagnostics.length === 0) {
      // Nothing we could anchor, but the boot still failed. Surface the
      // headline error.
      diagnostics.push({
        severity: 'error',
        scope: 'overall',
        message: `boot: ${err.message}`,
      })
    }
    return { ok: false, diagnostics, stderrTail, error: err.message }
  }
}

module.exports = { probeBoot, parseFailLoudLines, anchorFindings }
