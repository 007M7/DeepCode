/**
 * `@deepseek-ai/dsh-web-search-exa`: registers an Exa-backed `WebSearchProvider`
 * with `ctx.web`. A function/namespace plugin (NOT a default-export service):
 * a search provider does not own the `ctx.web` key — it registers INTO the
 * seam's provider registry, exactly as `@deepseek-ai/dsh-llm-deepseek`
 * registers an adapter into `ctx.llm`. The key is owned by `@deepseek-ai/dsh-web`.
 *
 * @module @deepseek-ai/dsh-web-search-exa
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { ExaSearchProvider, EXA_DEFAULT_BASE_URL } from './provider.ts'

export {
  EXA_DEFAULT_BASE_URL,
  EXA_PROVIDER_ID,
  ExaSearchProvider,
  mapExaResponse,
  mapExaResult,
} from './provider.ts'
export type { ExaSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-exa'

/** The web seam this provider registers into. */
export const inject = ['web']

export interface Config {
  /** Exa API key. Falls back to `$EXA_API_KEY`. Empty → provider unavailable. */
  apiKey?: string
  /** Endpoint base; `/search` is appended. Defaults to the public API. */
  baseURL?: string
}

export const Config: z<Config> = z.object({
  apiKey: z.string(),
  baseURL: z.string(),
})

/** Register the Exa search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  const apiKey = config.apiKey ?? process.env.EXA_API_KEY ?? ''
  const baseURL = config.baseURL ?? EXA_DEFAULT_BASE_URL
  ctx.web.registerSearchProvider(new ExaSearchProvider({ apiKey, baseURL }))
}
