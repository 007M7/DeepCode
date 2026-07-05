/**
 * The model-facing web tool suite (`web_search`, `web_fetch`) over the `ctx.web`
 * seam. This root plugin registers the tools the product has ENABLED, composing
 * the per-tool registration helpers (`applyWebSearchTool`, `applyWebFetchTool`).
 *
 * The package owns model-facing concerns only — tool names, JSON schemas,
 * argument validation, prompt sections, result-cap constants, result formatting,
 * HTML→markdown presentation. All web access goes through `ctx.web`; this
 * package never imports a concrete provider package.
 *
 * Tool registration follows product/app ENABLEMENT, not backend availability: a
 * tool stays visible even when its selected provider is missing/misconfigured,
 * and execution fails with a structured `WebError` (resolved by the seam at call
 * time). That keeps the model schema stable without making plugin load order,
 * credential state, or HMR timing part of the model-facing contract.
 *
 * @module @deepseek-ai/dsh-tool-web
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { applyWebSearchTool, WEB_SEARCH_MAX_RESULTS } from './search.ts'
import { applyWebFetchTool } from './fetch.ts'

export { WEB_SEARCH_MAX_RESULTS, applyWebSearchTool, formatSearchOutput, parseSearchArgs, presentSearchCall } from './search.ts'
export { applyWebFetchTool, formatFetchOutput, parseFetchArgs, presentFetchCall, renderBody } from './fetch.ts'
export { htmlToMarkdown } from './html.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-web'

/** Services required by the web tool suite. */
export const inject = ['tools', 'web', 'systemPrompt']

export interface Config {
  /** Register `web_search`. Defaults to true. */
  search?: boolean
  /** Register `web_fetch`. Defaults to true. */
  fetch?: boolean
  /** Upper bound on sources returned by one `web_search` call. */
  searchMaxResults?: number
}

export const Config: z<Config> = z.object({
  search: z.boolean().default(true),
  fetch: z.boolean().default(true),
  searchMaxResults: z.number().default(WEB_SEARCH_MAX_RESULTS),
})

/** The shape after schemastery applies its defaults to every field. */
type ResolvedConfig = Required<Config>

/** The result cap must be a positive integer (it bounds a provider's source list). */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-web: ${name} must be a positive integer`)
  }
}

/**
 * Register the enabled web tools. `search`/`fetch` default to true; a product
 * that wants only one disables the other in config. The tools' disposers are
 * fiber-scoped (the effect-based registries clean up on dispose), so no manual
 * teardown is needed.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertPositiveInteger('searchMaxResults', resolved.searchMaxResults)
  if (resolved.search) applyWebSearchTool(ctx, resolved.searchMaxResults)
  if (resolved.fetch) applyWebFetchTool(ctx)
}
