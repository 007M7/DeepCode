/**
 * `@deepseek-ai/dsh-web-search-perplexity`: registers a Perplexity-backed
 * `WebSearchProvider` with `ctx.web`. A function/namespace plugin (NOT a
 * default-export service): it registers INTO the seam's provider registry, like
 * `@deepseek-ai/dsh-llm-deepseek` registers an adapter into `ctx.llm`.
 *
 * @module @deepseek-ai/dsh-web-search-perplexity
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { PerplexitySearchProvider, PERPLEXITY_DEFAULT_BASE_URL, PERPLEXITY_DEFAULT_MODEL } from './provider.ts'

export {
  PERPLEXITY_DEFAULT_BASE_URL,
  PERPLEXITY_DEFAULT_MODEL,
  PERPLEXITY_PROVIDER_ID,
  PerplexitySearchProvider,
  mapPerplexityResponse,
  mapPerplexityResult,
} from './provider.ts'
export type { PerplexitySearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-perplexity'

/** The web seam this provider registers into. */
export const inject = ['web']

export interface Config {
  /** Perplexity API key. Falls back to `$PERPLEXITY_API_KEY`. Empty → unavailable. */
  apiKey?: string
  /** Endpoint base; `/chat/completions` is appended. Defaults to the public API. */
  baseURL?: string
  /** Search model name. Defaults to `sonar`. */
  model?: string
}

export const Config: z<Config> = z.object({
  apiKey: z.string(),
  baseURL: z.string(),
  model: z.string(),
})

/** Register the Perplexity search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  const apiKey = config.apiKey ?? process.env.PERPLEXITY_API_KEY ?? ''
  const baseURL = config.baseURL ?? PERPLEXITY_DEFAULT_BASE_URL
  const model = config.model ?? PERPLEXITY_DEFAULT_MODEL
  ctx.web.registerSearchProvider(new PerplexitySearchProvider({ apiKey, baseURL, model }))
}
