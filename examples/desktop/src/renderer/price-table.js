// model price table for the trace-card cost chip.
//
// Prices are in USD per **1 million tokens** — the flat unit used by the
// major LLM APIs (OpenRouter, Anthropic, DeepSeek). trace-aggregator.js
// consumes this table via `costForUsage(usage, priceTable, model)`, which
// looks up `pricing[model]` by exact name and returns null (`$?`) when
// no match is found. Absent → the L1 chip still renders as `$?` per
// zero-discard rule — the researcher sees the field
// exists and is unpriced, never a blank slot.
//
// This is a **demo** table hand-curated 2026-07-16. In production it would
// be pulled from the provider's price manifest at daemon start-up; the
// hook (`window.__dshPriceTable = { pricing: {…} }`) is a stable seam so
// the demo table can be swapped for a live one without touching renderer.
//
// Coverage: currently only the models we route DeepSeek Harness against
// (deepseek-chat / -reasoner and the v4 SKUs the internal proxy exposes:
// deepseek-v4-flash / deepseek-v4-pro) plus a Claude row so LangSmith-
// heritage visitors see something recognisable. Every other model reads `$?`.
//
// NB: prices below are **input / output** where "input" is billed on the
// full billing-input pool (uncached + cache-read + cache-write) — that
// aggregation lives in trace-aggregator.costForUsage, so this file only
// carries the raw rates. Cache-read discounts (Anthropic charges 0.1×
// input, DeepSeek 0.5×) are NOT modelled yet; when they land we'll add
// a per-model `cacheReadDiscount` field and update costForUsage.

'use strict'

const DEFAULT_PRICE_TABLE = {
  pricing: {
    // DeepSeek (self-hosted / official API), 2026-07-16 rates
    'deepseek-chat':     { input: 0.14, output: 0.28 },
    'deepseek-reasoner': { input: 0.14, output: 0.55 }, // reasoning tokens billed as output
    'deepseek-coder':    { input: 0.14, output: 0.28 },
    // DeepSeek v4 SKUs (`deepseek-v4-flash` / `deepseek-v4-pro`, plus the
    // `[1m]` context variant) — internal Anthropic-compat proxy endpoints
    // vary by deployment; override via the price-table config seam if you
    // route these SKUs through your own gateway. Prices below are
    // approximate (assumed parity with the closest v3 tier — flash mirrors
    // chat, pro mirrors reasoner); update when official rates publish.
    'deepseek-v4-flash': { input: 0.14, output: 0.28 },
    'deepseek-v4-pro':   { input: 0.14, output: 0.55 },
    // Anthropic — Claude Fable 5 / Opus 4.8 / Haiku 4.5 approximate rates
    'claude-fable-5':    { input: 3.00, output: 15.00 },
    'claude-opus-4-8':   { input: 15.00, output: 75.00 },
    'claude-sonnet-5':   { input: 3.00, output: 15.00 },
    'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
  },
}

if (typeof window !== 'undefined') {
  // Non-destructive publish: if a host injects its own price table before
  // this script runs (e.g. main-process reads a manifest and pre-fills
  // window.__dshPriceTable in a preload script), respect it.
  if (!window.__dshPriceTable) window.__dshPriceTable = DEFAULT_PRICE_TABLE
  // keep a pristine snapshot so the Settings page can render
  // its default column even after demo-tier overrides have baked into
  // the effective table. The snapshot is a deep-cloned copy so a mutation
  // on window.__dshPriceTable can never leak back into the default view.
  if (!window.__dshPriceTableDefault) {
    window.__dshPriceTableDefault = JSON.parse(JSON.stringify(DEFAULT_PRICE_TABLE))
  }
  // the cost badge consults `getEffectivePricing()` whenever
  // it reads a rate, so demo-tier overrides written from the Settings
  // page take effect on the next chip render without a shell restart.
  // The lookup path in trace-aggregator.costForUsage(pricing, model)
  // wants `{ pricing: {…} }`; expose one getter that returns the merged
  // shape by consulting the settings-model helper if it has loaded.
  window.__dshEffectivePriceTable = function () {
    const M = window.__dshSettingsModel
    if (M && typeof M.getEffectivePricing === 'function') {
      return M.getEffectivePricing(window.__dshPriceTableDefault || DEFAULT_PRICE_TABLE)
    }
    return window.__dshPriceTable
  }
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DEFAULT_PRICE_TABLE }
}
