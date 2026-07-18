// Plugin list + user overlay management for the desktop demo.
//
// The runtime is a cordis leaf: a flat list of `{ id, name, config? }` entries.
// Base leaves live in `config/*.yml` inside this repo. The user opinions ("turn
// plugin X off", "add plugin Y", "onboarding role = coding + approvals=ask")
// materialize as `~/.dsh-desktop/user-overlay.cordis.yml`, which is a single
// `@cordisjs/plugin-include` entry that re-reads the base leaf and applies
// patches by id — the same overlay shape `examples/host-profiles/*` uses.
//
// Everything in this module is a pure function of file bytes + inputs so it
// can unit-test under `node --test` without Electron. Only `readOverlayFile`,
// `writeOverlayFile`, and `applyRoleTemplate` touch the disk; they are thin
// wrappers over the pure parsers.
//
// YAML scope: base and overlay files use a tiny subset of YAML:
//   - top-level is a `- id: … / name: … / config: {…}` sequence,
//   - `config:` bodies may contain nested maps and `!!js …` scalars
//     (config values are preserved as opaque text — we never evaluate them).
// A full YAML parser would be nice but would drag in a dep; the parser here
// only claims to handle the two shapes we author.

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// ---------- pure: parse base leaf entry list --------------------------------

/**
 * Parse a base cordis.yml leaf into `[{id, name}, …]`. We ignore `config`
 * bodies — the plugin list UI only needs id + name for display + toggling.
 * The parser is line-oriented and tolerates `!!js` scalars and interleaved
 * comments; anything unexpected is silently skipped so a hand-authored comment
 * doesn't crash the shell.
 * @param {string} text - Raw yml file contents.
 * @returns {{id:string,name:string}[]}
 */
function parseBaseEntries(text) {
  const lines = text.split(/\r?\n/)
  const out = []
  let cur = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // A new entry always opens with `- id: X` at column 0 (or `- id:` after
    // a top-level `- ` marker). Nested map keys are indented, so column 0 is
    // the discriminator.
    const idMatch = line.match(/^-\s+id:\s*(.+?)\s*$/)
    if (idMatch) {
      if (cur) out.push(cur)
      // `line` is 1-based to match editor/terminal conventions; validators
      // surface `entry.line` back to the UI as "row N in this file".
      cur = { id: unquote(idMatch[1]), name: '', line: i + 1 }
      continue
    }
    if (!cur) continue
    const nameMatch = line.match(/^\s+name:\s*(.+?)\s*$/)
    if (nameMatch) {
      cur.name = unquote(nameMatch[1])
    }
  }
  if (cur) out.push(cur)
  return out
}

function unquote(s) {
  const trimmed = s.trim()
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

// ---------- pure: parse user overlay -----------------------------------------

/**
 * Parse the user-overlay.cordis.yml we author. Returns `{ base, patches }`
 * where `base` is the referenced base leaf path (relative to the overlay file)
 * and `patches` is a list of `{id, disabled?, name?, insert?, config?}` records
 * — the same subset of `@cordisjs/plugin-include` config we ever emit.
 *
 * We never round-trip an unknown patch shape; if the user hand-edits their
 * overlay with fields we don't recognize, we preserve unknown top-level lines
 * as-is in `_verbatim` so writeOverlay can emit them back. That's a courtesy;
 * the shell only expects the shapes it wrote.
 *
 * MCP note: the MCP-server config card writes a
 * shallow-JSON `config:` block per patch — one level of scalar keys, and one
 * nested `env:` / `headers:` object of scalar key/value pairs. That is the
 * only config shape this parser understands; hand-authored deeply nested YAML
 * is preserved as-is in `_configText` so the round-trip is stable.
 *
 * @param {string} text - Raw overlay yml contents.
 * @returns {{base:string, patches:Array<{id:string,disabled?:boolean,name?:string,insert?:string,config?:object,_configText?:string}>, _verbatim?:string}}
 */
function parseOverlay(text) {
  const result = { base: '', patches: [] }
  const lines = text.split(/\r?\n/)
  // Pull `path:` under the include entry's config.
  for (const line of lines) {
    const m = line.match(/^\s+path:\s*(.+?)\s*$/)
    if (m) { result.base = unquote(m[1]); break }
  }
  // Pull patches: after the `patches:` key, each patch is a `- id: X` block.
  const patchesIdx = lines.findIndex((l) => /^\s+patches:\s*$/.test(l))
  if (patchesIdx < 0) return result
  let cur = null
  // Config-body pointer: when we hit `config:` under the current patch, we
  // start collecting nested lines until the next patch marker or an
  // outdented top-level line. `configIndent` tracks the indent level of the
  // `config:` key so children are anything MORE indented than that.
  let configIndent = -1
  let configLines = null
  const flushConfig = () => {
    if (cur && configLines !== null) {
      const raw = configLines.join('\n')
      cur._configText = raw
      cur.config = parseShallowConfig(configLines)
    }
    configIndent = -1
    configLines = null
  }
  for (let i = patchesIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    // Blank / comment lines end nothing; a top-level `- id: X` inside patches
    // opens the next patch.
    if (/^\s*#/.test(line)) continue
    const idMatch = line.match(/^\s+-\s+id:\s*(.+?)\s*$/)
    if (idMatch) {
      if (cur) { flushConfig(); result.patches.push(cur) }
      cur = { id: unquote(idMatch[1]), line: i + 1 }
      continue
    }
    if (!cur) continue
    // A config body in progress claims all more-indented lines. When we hit
    // a line at the config-key indent or less that isn't a config child, we
    // flush and fall through to the normal per-key match.
    if (configIndent >= 0) {
      const indentMatch = line.match(/^(\s*)/)
      const indent = indentMatch ? indentMatch[1].length : 0
      if (line.trim() === '') {
        // Blank inside a config block ends nothing; keep the line so the raw
        // text round-trips faithfully.
        configLines.push(line)
        continue
      }
      if (indent > configIndent) {
        configLines.push(line)
        continue
      }
      // Fall through: this line belongs to the next patch key.
      flushConfig()
    }
    const nameMatch = line.match(/^\s+name:\s*(.+?)\s*$/)
    if (nameMatch) { cur.name = unquote(nameMatch[1]); continue }
    const disabledMatch = line.match(/^\s+disabled:\s*(true|false)\s*$/)
    if (disabledMatch) { cur.disabled = disabledMatch[1] === 'true'; continue }
    const insertMatch = line.match(/^\s+insert:\s*(before|after|prepend|append)\s*$/)
    if (insertMatch) { cur.insert = insertMatch[1]; continue }
    const configOpen = line.match(/^(\s+)config:\s*$/)
    if (configOpen) {
      configIndent = configOpen[1].length
      configLines = []
      continue
    }
  }
  if (cur) { flushConfig(); result.patches.push(cur) }
  return result
}

/**
 * Parse the shallow-JSON `config:` sub-block we emit — a flat map of scalars
 * plus optional `env:` / `headers:` nested maps of scalars, plus optional
 * `args:` list of scalars. Anything more elaborate is left in `_configText`
 * (see parseOverlay) so a hand-written deep nesting survives round-trips.
 *
 * Only the shapes the MCP-server config card writes are covered here;
 * this is deliberately narrow — we would rather leave a hand-authored block
 * as opaque text than half-parse it and then emit a lossy render.
 *
 * @param {string[]} lines - The raw config-body lines (indented under `config:`).
 * @returns {object} A plain object mirroring the recognized shape.
 */
function parseShallowConfig(lines) {
  const out = {}
  // Compute the base indent from the first non-blank line so we can
  // reason about children of nested maps.
  let base = -1
  for (const raw of lines) {
    if (raw.trim() === '') continue
    const m = raw.match(/^(\s*)/)
    const indent = m ? m[1].length : 0
    if (base < 0 || indent < base) base = indent
  }
  if (base < 0) return out
  let currentKey = null       // for nested map (env/headers) or list (args)
  let currentMap = null
  let currentList = null
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (raw.trim() === '') continue
    if (/^\s*#/.test(raw)) continue
    const m = raw.match(/^(\s*)/)
    const indent = m ? m[1].length : 0
    // Top-level key in this block (scalar OR opens a nested map/list).
    if (indent === base) {
      currentKey = null; currentMap = null; currentList = null
      const kv = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/)
      if (!kv) continue
      const key = kv[1]
      const val = kv[2]
      if (val === '') {
        // Peek: if the next non-blank line is `- ` at deeper indent, treat
        // as a list; else as a nested map.
        let peek = i + 1
        while (peek < lines.length && lines[peek].trim() === '') peek++
        if (peek < lines.length && /^\s+-\s/.test(lines[peek])) {
          currentList = []
          out[key] = currentList
          currentKey = key
        } else {
          currentMap = {}
          out[key] = currentMap
          currentKey = key
        }
      } else {
        out[key] = parseYamlScalar(val)
      }
      continue
    }
    // Deeper than base = child of the most-recently-opened key.
    if (currentList) {
      const item = raw.match(/^\s+-\s+(.*)$/)
      if (item) currentList.push(parseYamlScalar(item[1]))
      continue
    }
    if (currentMap) {
      const kv = raw.match(/^\s+([A-Za-z_][A-Za-z0-9_.\-]*):\s*(.*)$/)
      if (kv) currentMap[kv[1]] = parseYamlScalar(kv[2])
      continue
    }
  }
  return out
}

// Parse a single YAML scalar value the way the config card writes them. We
// only emit JSON-quoted strings, plain numbers, and booleans; nothing exotic.
function parseYamlScalar(v) {
  const t = v.trim()
  if (t === '') return ''
  if (t === 'true') return true
  if (t === 'false') return false
  if (t === 'null' || t === '~') return null
  if (/^-?[0-9]+$/.test(t)) return Number(t)
  if (/^-?[0-9]*\.[0-9]+$/.test(t)) return Number(t)
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    // JSON string parse handles the "double-quoted" form we emit; single
    // quotes are unquoted plainly (no escape sequence support beyond ' pair
    // which we don't emit).
    if (t.startsWith('"')) {
      try { return JSON.parse(t) } catch (_) { return t.slice(1, -1) }
    }
    return t.slice(1, -1)
  }
  return t
}

// ---------- pure: render overlay --------------------------------------------

/**
 * Render an overlay object back to yml text. Keeps the emit shape stable so
 * diffs are easy to eyeball; each patch turns into a small block:
 *
 *   - id: <patch.id>
 *     disabled: true
 *     name: '<...>'      # only when adding a new entry
 *     config:            # only when a config object is present
 *       key: value       # scalar
 *       env:             # nested map (env / headers)
 *         KEY: value
 *       args:            # scalar list (e.g. subprocess args)
 *         - value
 *
 * @param {{base:string, patches:Array<{id:string,disabled?:boolean,name?:string,insert?:string,config?:object}>}} overlay
 * @returns {string}
 */
function renderOverlay(overlay) {
  const lines = []
  lines.push('# User overlay for the DSH desktop shell.')
  lines.push('# Auto-generated by the Plugins tab / onboarding flow. Safe to hand-edit;')
  lines.push('# the shell reparses the file on every restart and drops anything it does')
  lines.push('# not recognize. Toggle a plugin by adding a `disabled: true` patch by id.')
  lines.push('- id: base')
  lines.push("  name: '@cordisjs/plugin-include'")
  lines.push('  config:')
  lines.push(`    path: ${JSON.stringify(overlay.base || '')}`)
  if (overlay.patches && overlay.patches.length > 0) {
    lines.push('    patches:')
    for (const p of overlay.patches) {
      lines.push(`      - id: ${JSON.stringify(p.id)}`)
      if (p.name) lines.push(`        name: ${JSON.stringify(p.name)}`)
      if (typeof p.disabled === 'boolean') lines.push(`        disabled: ${p.disabled}`)
      if (p.insert) lines.push(`        insert: ${p.insert}`)
      if (p.config && typeof p.config === 'object' && Object.keys(p.config).length > 0) {
        lines.push('        config:')
        emitShallowConfig(lines, p.config, '          ')
      }
    }
  }
  return lines.join('\n') + '\n'
}

// Emit a single config sub-block at `indent` (default two extra levels from
// the enclosing patch). Mirrors parseShallowConfig's shape: scalar keys,
// nested env/headers maps, args scalar list. Unknown value shapes fall back
// to JSON.stringify so the round-trip stays lossless.
function emitShallowConfig(lines, obj, indent) {
  const keys = Object.keys(obj)
  for (const key of keys) {
    const value = obj[key]
    if (Array.isArray(value)) {
      // Scalar list; empty list is omitted so the render stays tidy.
      if (value.length === 0) { lines.push(`${indent}${key}: []`); continue }
      lines.push(`${indent}${key}:`)
      for (const item of value) {
        lines.push(`${indent}  - ${JSON.stringify(item)}`)
      }
      continue
    }
    if (value && typeof value === 'object') {
      const subKeys = Object.keys(value)
      if (subKeys.length === 0) { lines.push(`${indent}${key}: {}`); continue }
      lines.push(`${indent}${key}:`)
      for (const sk of subKeys) {
        lines.push(`${indent}  ${sk}: ${JSON.stringify(value[sk])}`)
      }
      continue
    }
    if (value === undefined) continue
    if (value === null) { lines.push(`${indent}${key}: null`); continue }
    if (typeof value === 'boolean') { lines.push(`${indent}${key}: ${value}`); continue }
    if (typeof value === 'number') { lines.push(`${indent}${key}: ${value}`); continue }
    // string
    lines.push(`${indent}${key}: ${JSON.stringify(value)}`)
  }
}

// ---------- pure: effective plugin list -------------------------------------

/**
 * Fold base entries and patches into the "effective" list the tab renders.
 * `source` is `base` for anything from the base leaf, `user` for entries
 * introduced by a patch (i.e. new entries the include plugin appends).
 * Any `config` object attached to the patch is surfaced verbatim on the
 * effective row so the plugin table can render a per-entry config card
 * (mcp-client server list, etc.) without going back to the parser.
 *
 * @param {{id:string,name:string}[]} baseEntries
 * @param {Array<{id:string,disabled?:boolean,name?:string,insert?:string,config?:object}>} patches
 * @returns {Array<{id:string,name:string,disabled:boolean,source:'base'|'user',config?:object}>}
 */
function computeEffective(baseEntries, patches) {
  const patchById = new Map()
  for (const p of patches) patchById.set(p.id, p)
  const out = baseEntries.map((e) => {
    const p = patchById.get(e.id)
    const row = {
      id: e.id,
      name: p && p.name ? p.name : e.name,
      disabled: !!(p && p.disabled),
      source: 'base',
    }
    if (p && p.config && typeof p.config === 'object') row.config = p.config
    return row
  })
  // Patches that introduce a new id (never seen in base) become user entries.
  const seen = new Set(baseEntries.map((e) => e.id))
  for (const p of patches) {
    if (seen.has(p.id)) continue
    if (!p.name) continue // a bare disabled patch without a name is a no-op here
    const row = { id: p.id, name: p.name, disabled: !!p.disabled, source: 'user' }
    if (p.config && typeof p.config === 'object') row.config = p.config
    out.push(row)
  }
  return out
}

// ---------- pure: toggle helper ---------------------------------------------

/**
 * Return a new overlay with `id` toggled to `disabled`. If there's already a
 * patch for `id`, its `disabled` is updated in place; otherwise a fresh patch
 * is appended. When `disabled === false` and the patch had no other fields,
 * we drop it (an empty patch is noise).
 *
 * @param {ReturnType<parseOverlay>} overlay
 * @param {string} id
 * @param {boolean} disabled
 * @returns {ReturnType<parseOverlay>}
 */
function togglePatch(overlay, id, disabled) {
  const next = { base: overlay.base, patches: [...(overlay.patches || [])] }
  const idx = next.patches.findIndex((p) => p.id === id)
  if (idx >= 0) {
    const cur = { ...next.patches[idx], disabled }
    // If toggling off and there's nothing else the patch carries, drop it.
    // A patch that ONLY exists to hold a config sub-block must survive
    // re-enabling so the user doesn't silently lose their edits.
    const hasConfig = cur.config && typeof cur.config === 'object' && Object.keys(cur.config).length > 0
    if (!disabled && !cur.name && !cur.insert && !hasConfig) {
      next.patches.splice(idx, 1)
    } else {
      next.patches[idx] = cur
    }
  } else {
    next.patches.push({ id, disabled })
  }
  return next
}

/**
 * Return a new overlay with a `+add` patch for a package entry. Duplicates on
 * id are rejected (the caller usually first checks base+patches).
 * @param {ReturnType<parseOverlay>} overlay
 * @param {{id:string, name:string, insert?:string, config?:object}} entry
 */
function addPatch(overlay, entry) {
  if (!entry || !entry.id || !entry.name) throw new Error('add: id and name required')
  const next = { base: overlay.base, patches: [...(overlay.patches || [])] }
  const clash = next.patches.find((p) => p.id === entry.id)
  if (clash) throw new Error(`duplicate patch id: ${entry.id}`)
  const patch = { id: entry.id, name: entry.name, insert: entry.insert || 'append' }
  if (entry.config && typeof entry.config === 'object') patch.config = entry.config
  next.patches.push(patch)
  return next
}

/**
 * Return a new overlay with the `config` sub-block on patch `id` replaced.
 * Creates the patch if it does not exist yet — the row might be a base entry
 * that never had a patch until the user filled in a config field (e.g. an
 * MCP-client entry authored in the base leaf whose `serverName` was left
 * blank on purpose so the user configures it after install). A base-only
 * entry needs no `name`, so we do not require one here.
 *
 * When `config` is null/undefined the patch's config is cleared entirely;
 * if that empties the patch (no name, no insert, no disabled), we drop it.
 *
 * @param {ReturnType<parseOverlay>} overlay
 * @param {string} id
 * @param {object|null} config
 * @returns {ReturnType<parseOverlay>}
 */
function setPatchConfig(overlay, id, config) {
  const next = { base: overlay.base, patches: [...(overlay.patches || [])] }
  const idx = next.patches.findIndex((p) => p.id === id)
  const hasConfig = config && typeof config === 'object' && Object.keys(config).length > 0
  if (idx >= 0) {
    const cur = { ...next.patches[idx] }
    if (hasConfig) cur.config = config
    else delete cur.config
    // Drop a patch that carries nothing after the update.
    if (!cur.name && !cur.insert && typeof cur.disabled !== 'boolean' && !cur.config) {
      next.patches.splice(idx, 1)
    } else {
      next.patches[idx] = cur
    }
    return next
  }
  if (!hasConfig) return next // nothing to set
  next.patches.push({ id, config })
  return next
}

// ---------- role templates (onboarding) -------------------------------------

// Which base leaf each role points at + which patches its overlay emits.
// Kept next to the parsers because the same helpers assemble the output.
// The mapping is documented in README's onboarding table.
const ROLE_TEMPLATES = {
  coding: {
    label: 'Writing code',
    hint: 'Full toolchain: bash + fs, plus every plugin from the daemon-echo leaf.',
    base: 'daemon-echo.yml',
    // Coding keeps every entry the base leaf ships; no per-plugin toggles.
    patches: [],
  },
  research: {
    label: 'Research and analysis',
    hint: 'Read-only slant: keep bash off unless asked, keep session-query for provenance.',
    base: 'daemon-echo.yml',
    // Turn the bash entry off — research shouldn't shell out by default.
    // The overlay stays a plain patch list; user can re-enable in the tab.
    patches: [{ id: 'bash', disabled: true }],
  },
  general: {
    label: 'General assistant',
    hint: 'Chat only: mock/echo tool, no bash. Fastest to boot.',
    base: 'daemon-echo.yml',
    patches: [{ id: 'bash', disabled: true }],
  },
}

// Approval preference maps to a leaf-level patch on the base leaf's approval
// plugin id. The daemon-echo leaf has no `approval` entry (mock adapter is
// tool-less beyond echo), so the patch is captured in config.json for the
// onboarding UI to display and future overlays to consume, without emitting
// a stray patch here. Real coding-agent leaves DO have an `approval` entry
// (see profiles/im.cordis.yml) — swap ROLE_TEMPLATES to point at one once the
// desktop demo grows a real-model default.
const APPROVAL_MODES = {
  ask: { label: 'Ask each time (safer)', policy: 'ask' },
  auto: { label: 'Always approve (faster)', policy: 'never' },
}

/**
 * Build a fresh overlay from a role + approval-mode pair. Pure — the caller
 * writes it to disk. `basePathAbsolute` is the absolute filesystem path to
 * the base leaf; we render it as a POSIX-style path relative to the overlay
 * so the overlay works if the user copies the demo tree.
 *
 * @param {'coding'|'research'|'general'} role
 * @param {'ask'|'auto'} approvalMode
 * @param {string} basePathAbsolute
 * @param {string} overlayPathAbsolute
 * @returns {{overlay: ReturnType<parseOverlay>, role: string, approvalMode: string}}
 */
function applyRoleTemplate(role, approvalMode, basePathAbsolute, overlayPathAbsolute) {
  const tpl = ROLE_TEMPLATES[role]
  if (!tpl) throw new Error(`unknown role: ${role}`)
  if (!APPROVAL_MODES[approvalMode]) throw new Error(`unknown approval mode: ${approvalMode}`)
  const rel = relPathPosix(path.dirname(overlayPathAbsolute), basePathAbsolute)
  const overlay = { base: rel, patches: [...tpl.patches] }
  return { overlay, role, approvalMode }
}

// Path.relative but always POSIX slashes — the overlay is authored yaml and
// looks best with the same separator on macOS and Linux.
function relPathPosix(from, to) {
  return path.relative(from, to).split(path.sep).join('/')
}

// ---------- fs wrappers ------------------------------------------------------

/**
 * Read + parse a base leaf from a file on disk. Missing file → empty list
 * (caller decides whether to fail loud).
 */
function readBaseEntries(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8')
    return parseBaseEntries(text)
  } catch (err) {
    if (err && err.code === 'ENOENT') return []
    throw err
  }
}

function readOverlayFile(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8')
    return parseOverlay(text)
  } catch (err) {
    if (err && err.code === 'ENOENT') return { base: '', patches: [] }
    throw err
  }
}

function writeOverlayFile(filePath, overlay) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, renderOverlay(overlay), 'utf8')
}

// ---------- shell-config paths ----------------------------------------------

// The onboarding step creates ~/.dsh-desktop/; its absence == "first run".
// Making this an env-overridable helper lets tests point at a temp dir.
function shellHome() {
  return process.env.DSH_DESKTOP_HOME || path.join(os.homedir(), '.dsh-desktop')
}

function overlayPath() {
  return path.join(shellHome(), 'user-overlay.cordis.yml')
}

function configPath() {
  return path.join(shellHome(), 'config.json')
}

// A-P0-1 fix (2026-07-16): the onboarding wizard was being skipped 100% of
// the time. The root cause was that `firstRun` was derived from
// `!shellHomeExists() || !readShellConfig()` — but any code path that writes
// config.json (a runtime restart with defaults, an overlay apply) would flip
// firstRun back to false before the wizard had a chance to run. Worse, the
// `Reset onboarding` action deleted config.json and the overlay, then the
// next boot auto-materialized them before the wizard's boot check fired, so
// the reset silently did nothing. We now key firstRun off an explicit
// sentinel file that only the wizard's completion path writes; nothing else
// in the shell touches it.
function onboardedSentinelPath() {
  return path.join(shellHome(), '.onboarded')
}
function onboardedSentinelExists() {
  try { fs.accessSync(onboardedSentinelPath()); return true } catch (_) { return false }
}
function markOnboarded() {
  fs.mkdirSync(shellHome(), { recursive: true })
  fs.writeFileSync(onboardedSentinelPath(), new Date().toISOString(), 'utf8')
}
function clearOnboarded() {
  try { fs.rmSync(onboardedSentinelPath(), { force: true }) } catch (_) {}
}

function shellHomeExists() {
  try { fs.accessSync(shellHome()); return true } catch (_) { return false }
}

function readShellConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'))
  } catch (err) {
    if (err && err.code === 'ENOENT') return null
    throw err
  }
}

function writeShellConfig(cfg) {
  fs.mkdirSync(shellHome(), { recursive: true })
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n', 'utf8')
}

module.exports = {
  parseBaseEntries,
  parseOverlay,
  parseShallowConfig,
  renderOverlay,
  computeEffective,
  togglePatch,
  addPatch,
  setPatchConfig,
  applyRoleTemplate,
  ROLE_TEMPLATES,
  APPROVAL_MODES,
  readBaseEntries,
  readOverlayFile,
  writeOverlayFile,
  shellHome,
  overlayPath,
  configPath,
  shellHomeExists,
  readShellConfig,
  writeShellConfig,
  onboardedSentinelPath,
  onboardedSentinelExists,
  markOnboarded,
  clearOnboarded,
}
