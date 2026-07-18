// Hub page — pure data module. All shape-only logic lives here so it can be
// exercised under `node --test` without JSDOM or Electron. The DOM half is
// in hub-page.js.
//
// The Hub is the extensibility-first asset catalog. Everything is a plugin
// at DSH, but the plugin ecosystem is broader than a single manifest kind —
// prompts, skills, rubrics, profiles, datasets, and scripts are all versioned
// text assets a researcher edits, forks, and hands to a runtime. The Hub is
// the one page that shows them all at once, with plugins in the hero slot.
//
// The seven asset kinds and their default paint order (plugin-first per the
// user's rename from "Library" to "Hub"):
//   1. plugin     — hero; wire-backed via window.dsh.plugins.list
//   2. skill      — file-backed under `.dsh-demo-assets/skills/<name>.md`
//   3. prompt     — file-backed under `.dsh-demo-assets/prompts/<name>.md`
//   4. rubric     — file-backed under `.dsh-demo-assets/rubrics/<name>.yaml`
//   5. profile    — file-backed under `.dsh-demo-assets/profiles/<name>.yaml`
//   6. dataset    — file-backed JSONL under `.dsh-demo-assets/datasets/<name>.jsonl`
//   7. script     — file-backed under `.dsh-demo-assets/scripts/<name>.{py,js,sh}`
//
// The file paths are the demo tier of SDK gap G1/G11 (library/list, dataset/list);
// upstream will replace the fs walk with a wire call, but the row shape stays
// the same. See docs/design-refs/ia-design-pack-179.md § Library and
// docs/design-refs/rl-workflow-needs.md § Scripts.

'use strict'

// Canonical kind order — plugin-first per the Hub rename. Kept as a frozen
// array so callers can't accidentally reorder it in place.
const KIND_ORDER = Object.freeze([
  'plugin', 'skill', 'prompt', 'rubric', 'profile', 'dataset', 'script',
])

// Per-kind display metadata. The label is the section header the DOM
// renders; the glyph is the L0-row leading mark; the extension is what the
// "New from template" flow uses when it creates a file. Kept static because
// this is the demo file tier — the wire-backed version would ship its own
// manifest.
const KIND_META = Object.freeze({
  plugin:  { label: 'Plugins',  glyph: 'P', ext: 'yaml',
             sub: 'Runtime capability packs. Hero of the Hub — everything else is part of the plugin ecosystem.' },
  skill:   { label: 'Skills',   glyph: 'S', ext: 'md',
             sub: 'SKILL.md files a runtime can load and invoke.' },
  prompt:  { label: 'Prompts',  glyph: 'p', ext: 'md',
             sub: 'System-prompt fragments and preambles. Loadable into Playground.' },
  rubric:  { label: 'Rubrics',  glyph: 'R', ext: 'yaml',
             sub: 'Evaluators. Assertion + expected + eval binding.' },
  profile: { label: 'Profiles', glyph: 'F', ext: 'yaml',
             sub: 'Runtime configurations: transport, model, plugin set.' },
  dataset: { label: 'Datasets', glyph: 'D', ext: 'jsonl',
             sub: 'Versioned JSONL corpora — session exports, cleaned splits, benchmark inputs.' },
  script:  { label: 'Scripts',  glyph: '>', ext: 'py',
             sub: 'Local executors for the clean stage of the RL pipeline. Runs with your user permissions.' },
})

// L0 row shape produced by both the wire-backed plugin path and the fs-backed
// paths. Consumers assume every field is present so DOM code never has to
// branch on kind for the base row.
function normaliseRow(kind, raw) {
  const name = String(raw.name || raw.id || '')
  const version = raw.version || 'v1'
  const path = raw.path || ''
  // The optional fields are pass-through so the wire-backed plugin row can
  // carry its runtime state and the fs-backed rows can carry their row count
  // / duration / language without a discriminated union.
  return {
    kind,
    name,
    version,
    path,
    description: raw.description || '',
    runtimeLabel: raw.runtimeLabel || null,       // plugins only
    runtimeState: raw.runtimeState || null,       // plugins only
    source: raw.source || 'base',                 // plugins: 'base'|'user'
    rowCount: typeof raw.rowCount === 'number' ? raw.rowCount : null, // datasets
    lastRun: raw.lastRun || null,                 // scripts
    lastStatus: raw.lastStatus || null,           // scripts: 'ok'|'error'|null
    lang: raw.lang || null,                       // scripts: 'python'|'node'|'shell'
    versions: Array.isArray(raw.versions) ? raw.versions : [],
  }
}

// Sort key: sections in KIND_ORDER, then within a section by name asc so the
// L0 layout is stable across renders. Callers pass the flat row array; we
// return a new array without mutating the input.
function sortHubRows(rows) {
  const kindIndex = new Map(KIND_ORDER.map((k, i) => [k, i]))
  return [...rows].sort((a, b) => {
    const ka = kindIndex.has(a.kind) ? kindIndex.get(a.kind) : KIND_ORDER.length
    const kb = kindIndex.has(b.kind) ? kindIndex.get(b.kind) : KIND_ORDER.length
    if (ka !== kb) return ka - kb
    return String(a.name).localeCompare(String(b.name))
  })
}

// Section counts for the header chips. Includes zero-count sections so the
// UI can render the whole grammar even before the researcher has any of a
// kind — surfacing the empty slots is how they discover the feature.
function sectionCounts(rows) {
  const out = new Map(KIND_ORDER.map((k) => [k, 0]))
  for (const r of rows) {
    if (out.has(r.kind)) out.set(r.kind, out.get(r.kind) + 1)
  }
  return out
}

// Script-run summary parser. The contract is DSBench's `code_result.json`
// shape lifted to a stdout-last-line convention (see design-refs/rl-workflow-
// needs.md § Output handling): the last non-empty line of stdout is expected
// to be a JSON object `{written, dropped, notes?}`. If no summary is emitted,
// callers fall back to a row-count-delta computed from disk and set
// `notes: 'no summary emitted'`. This parser is deliberately forgiving —
// scripts may print JSON on any earlier line (progress logs) and we still
// take the last valid one.
function parseScriptSummary(stdout) {
  if (typeof stdout !== 'string' || stdout.length === 0) return null
  const lines = stdout.trimEnd().split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    if (line[0] !== '{') continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object') {
        const written = Number.isFinite(parsed.written) ? parsed.written : null
        const dropped = Number.isFinite(parsed.dropped) ? parsed.dropped : null
        const notes = typeof parsed.notes === 'string' ? parsed.notes : ''
        if (written !== null || dropped !== null) {
          return { written, dropped, notes, source: 'stdout' }
        }
      }
    } catch (_) { /* try earlier line */ }
  }
  return null
}

// Diff summary chip for the script-run output panel. Composes the row-count
// delta phrase used by the demo. The output is a single line with the
// numbers a researcher would want to see at a glance.
function formatDiffSummary({ inputRows, summary, outputRows }) {
  const written = summary && Number.isFinite(summary.written) ? summary.written : outputRows
  const dropped = summary && Number.isFinite(summary.dropped)
    ? summary.dropped
    : (Number.isFinite(inputRows) && Number.isFinite(outputRows) ? inputRows - outputRows : null)
  const bits = []
  if (Number.isFinite(inputRows) && Number.isFinite(written)) {
    bits.push(`${inputRows.toLocaleString()} → ${written.toLocaleString()} rows`)
    if (Number.isFinite(dropped) && dropped !== 0) {
      const arrow = dropped > 0 ? '−' : '+'
      bits.push(`(${arrow}${Math.abs(dropped).toLocaleString()} ${dropped > 0 ? 'dropped' : 'added'})`)
    }
  } else if (Number.isFinite(written)) {
    bits.push(`${written.toLocaleString()} rows written`)
  } else {
    bits.push('no row count')
  }
  if (summary && summary.notes) bits.push(`— ${summary.notes}`)
  return bits.join(' ')
}

// Dataset preview: parse the first N lines of a JSONL string into row objects
// so the DOM can render 3-row previews with chip-column awareness. Bad lines
// are dropped silently; the demo doesn't stop on a single malformed row
// because the researcher's Clean stage is expected to have some garbage.
function previewDatasetRows(jsonlText, limit = 3) {
  if (typeof jsonlText !== 'string' || jsonlText.length === 0) return []
  const out = []
  const lines = jsonlText.split(/\r?\n/)
  for (const line of lines) {
    if (out.length >= limit) break
    const t = line.trim()
    if (!t) continue
    try {
      const parsed = JSON.parse(t)
      if (parsed && typeof parsed === 'object') out.push(parsed)
    } catch (_) { /* skip */ }
  }
  return out
}

// Detect the special-shape columns in a dataset preview so the DOM can render
// chips for the multi-turn-SFT format the team uses. Returns the ordered
// column list the DOM should paint. The three named columns are chip-styled
// when present; everything else is JSON-stringified.
function chipColumnsFor(rows) {
  const KNOWN = ['messages', 'reasoning_content', 'tool_calls']
  const seen = new Set()
  const rest = new Set()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    for (const k of Object.keys(row)) {
      if (KNOWN.includes(k)) seen.add(k)
      else rest.add(k)
    }
  }
  const chips = KNOWN.filter((k) => seen.has(k))
  return { chips, rest: [...rest].sort() }
}

// Count rows in a JSONL string. Cheap enough to run in the renderer for the
// demo-tier fixture size (hundreds of rows). The wire tier would return the
// count from the manifest instead of counting lines.
function countJsonlRows(jsonlText) {
  if (typeof jsonlText !== 'string' || jsonlText.length === 0) return 0
  let count = 0
  for (const line of jsonlText.split(/\r?\n/)) {
    if (line.trim()) count++
  }
  return count
}

// SDK legend rows for the bottom-of-page attribution strip. This is the
// self-documenting "which actions are wire-backed today vs file-tier"
// paint. Kept in the pure module so the tests can lock the phrasing and the
// DOM stays a projection. See ia-design-pack §4 gap ledger + rl-workflow §6.
function sdkLegend() {
  return [
    { id: 'plugins/list',   status: 'wire',      note: 'Plugin runtime state comes from the daemon.' },
    { id: 'library/list',   status: 'file-tier', gap: 'G1',
      note: 'Prompts, skills, rubrics, profiles read from local files today.' },
    { id: 'dataset/list',   status: 'file-tier', gap: 'G11',
      note: 'Datasets read as JSONL files; manifests are demo-only.' },
    { id: 'script/run',     status: 'file-tier', gap: 'G12',
      note: 'Scripts spawn a jailed child locally; upstream reuses the isolated-daemon script-runner mode.' },
  ]
}

// Dual export: CommonJS for node --test and a globalThis attachment for the
// browser (renderer) where the shell loads plain <script> tags without a
// bundler. hub-page.js reads `globalThis.HubModel` first, falling back to
// `require('./hub-model.js')` under node.
const hubModelApi = {
  KIND_ORDER,
  KIND_META,
  normaliseRow,
  sortHubRows,
  sectionCounts,
  parseScriptSummary,
  formatDiffSummary,
  previewDatasetRows,
  chipColumnsFor,
  countJsonlRows,
  sdkLegend,
}
if (typeof module !== 'undefined' && module.exports) module.exports = hubModelApi
if (typeof globalThis !== 'undefined') globalThis.HubModel = hubModelApi
