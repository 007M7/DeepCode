// Settings model — pure helpers for the localStorage-backed
// price-table override + env-key status read.
//
// Split out from settings-page.js so the merge/get/set trio can be unit-
// tested without a DOM. The renderer's cost-badge helper reads through
// getEffectivePricing(defaultTable) to pick up demo-tier edits without
// mutating the immutable DEFAULT_PRICE_TABLE from price-table.js.
//
// Storage key: `dsh.demo.priceOverrides` — a JSON object of shape
//   { [modelName]: { input?: number, output?: number } }
// Missing fields fall through to the default table entry so a partial
// edit (e.g. only `output` changed) keeps the untouched half stable.
//
// Fail-safe: any parse error clears the override silently and returns
// the default table. The intent of this hook is a demo knob, not a
// production billing surface, so a corrupt localStorage never hard-fails
// the shell.

'use strict'
;(function () {

const STORAGE_KEY = 'dsh.demo.priceOverrides'

/**
 * Read the stored override object. Returns `{}` when none exists or the
 * blob is malformed; both are safe to merge over the default table.
 *
 * @param {Storage} [storage] — optional injectable storage for tests.
 * @returns {Object}
 */
function readOverrides(storage) {
  const s = storage || (typeof localStorage !== 'undefined' ? localStorage : null)
  if (!s) return {}
  let raw = null
  try { raw = s.getItem(STORAGE_KEY) } catch (_) { return {} }
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    return {}
  } catch (_) {
    return {}
  }
}

/**
 * Persist a full override map. Callers usually merge into readOverrides()
 * first, then pass the merged map back through here — writeOverrides is
 * the atomic setter, not the incremental one.
 *
 * @param {Object} obj
 * @param {Storage} [storage]
 */
function writeOverrides(obj, storage) {
  const s = storage || (typeof localStorage !== 'undefined' ? localStorage : null)
  if (!s) return
  try { s.setItem(STORAGE_KEY, JSON.stringify(obj || {})) } catch (_) {}
}

/**
 * Set a single model's input/output rate. Missing fields on the patch are
 * left alone; `null` explicitly deletes that field from the override map.
 * Passing `null` as the whole patch drops the model entirely (reset to
 * default).
 *
 * @param {string} model
 * @param {{input?: number|null, output?: number|null}|null} patch
 * @param {Storage} [storage]
 */
function setOverride(model, patch, storage) {
  if (!model || typeof model !== 'string') return
  const cur = readOverrides(storage)
  if (patch === null) {
    delete cur[model]
    writeOverrides(cur, storage)
    return
  }
  const row = cur[model] || {}
  for (const k of ['input', 'output']) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) {
      if (patch[k] === null) delete row[k]
      else if (typeof patch[k] === 'number' && isFinite(patch[k]) && patch[k] >= 0) row[k] = patch[k]
    }
  }
  if (Object.keys(row).length === 0) delete cur[model]
  else cur[model] = row
  writeOverrides(cur, storage)
}

/**
 * Merge the demo-tier overrides over a default `{pricing: {...}}` table.
 * Returns a NEW table object; the input is not mutated. This is the seam
 * price-table.js exposes at runtime — trace-aggregator.costForUsage
 * consumes the merged object, so any override applies immediately without
 * a shell restart.
 *
 * @param {{pricing: Object}} defaultTable
 * @param {Storage} [storage]
 * @returns {{pricing: Object}}
 */
function getEffectivePricing(defaultTable, storage) {
  const base = defaultTable && defaultTable.pricing && typeof defaultTable.pricing === 'object'
    ? defaultTable.pricing : {}
  const overrides = readOverrides(storage)
  const merged = {}
  for (const [model, entry] of Object.entries(base)) {
    merged[model] = { ...entry }
  }
  for (const [model, patch] of Object.entries(overrides)) {
    const cur = merged[model] || {}
    merged[model] = { ...cur, ...patch }
  }
  return { pricing: merged }
}

/**
 * Read the current key-presence state from process.env-like values the
 * main process forwards through runtimeStatus or a dedicated seam. The
 * shell never sees actual key values — only presence bits. Callers pass
 * a `probe` object mapping env-var name → boolean (present/absent).
 *
 * This is a pure classifier: it labels each var as personal-tier
 * (typically an API key you own) vs. service-tier (a shared/service
 * credential), and attaches a fixed description + optional last-used
 * timestamp (2026-07-17 — LangSmith Settings > API Keys models
 * keys as a resource table with those columns, not free-form env-var
 * text). The Settings page renders one <tr> per row.
 *
 * `lastUsed` is optional so the row is honest when the shell doesn't
 * track a usage timestamp today — `null` renders as `—`. Callers may
 * pass an ISO-8601 string via `presence.__lastUsed[name]` once a real
 * seam lands; the classifier just forwards it.
 *
 * @param {Object<string,boolean> & {__lastUsed?: Object<string,string>}} presence
 * @returns {Array<{name: string, present: boolean, tier: 'personal'|'service', description: string, lastUsed: string|null}>}
 */
function classifyKeys(presence) {
  const known = [
    {
      name: 'DEEPSEEK_API_KEY',
      tier: 'personal',
      description: 'DeepSeek API key (deepseek-chat / deepseek-reasoner).',
    },
    {
      name: 'OPENAI_API_KEY',
      tier: 'personal',
      description: 'OpenAI API key for OpenAI-compatible profiles.',
    },
    {
      name: 'ANTHROPIC_API_KEY',
      tier: 'personal',
      description: 'Anthropic API key for Claude-family profiles.',
    },
    {
      name: 'DSH_SERVICE_TOKEN',
      tier: 'service',
      description: 'Shared service token for the team runtime (bench / eval).',
    },
  ]
  const p = presence && typeof presence === 'object' ? presence : {}
  const lu = (p.__lastUsed && typeof p.__lastUsed === 'object') ? p.__lastUsed : {}
  return known.map((row) => ({
    name: row.name,
    tier: row.tier,
    description: row.description,
    present: !!p[row.name],
    lastUsed: (typeof lu[row.name] === 'string' && lu[row.name].length > 0) ? lu[row.name] : null,
  }))
}

const api = { STORAGE_KEY, readOverrides, writeOverrides, setOverride, getEffectivePricing, classifyKeys }
if (typeof module !== 'undefined' && module.exports) module.exports = api
if (typeof window !== 'undefined') window.__dshSettingsModel = api

})();
