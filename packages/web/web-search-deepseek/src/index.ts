/**
 * `@deepseek-ai/dsh-web-search-deepseek`: registers a DeepSeek-backed
 * `WebSearchProvider` with `ctx.web`. A function/namespace plugin (NOT a
 * default-export service): it registers INTO the seam's provider registry, like
 * `@deepseek-ai/dsh-llm-deepseek` registers an adapter into `ctx.llm`.
 *
 * The provider talks to DeepSeek's Anthropic-compatible Messages API with the
 * native `web_search_20250305` server tool. It reuses `$DEEPSEEK_API_KEY` (no
 * new secret) but NOT `$DEEPSEEK_BASE_URL` — the search endpoint is the
 * Anthropic-compatible base, distinct from the chat-completions base the LLM
 * adapter uses.
 *
 * @module @deepseek-ai/dsh-web-search-deepseek
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  DeepSeekSearchProvider,
  DEEPSEEK_DEFAULT_API_VERSION,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_USES,
  DEEPSEEK_DEFAULT_MODEL,
} from './provider.ts'

export {
  DeepSeekSearchProvider,
  DEEPSEEK_DEFAULT_API_VERSION,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_USES,
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_PROVIDER_ID,
  citationSnippets,
  mapAnthropicResponse,
} from './provider.ts'
export type { DeepSeekSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-deepseek'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** DeepSeek API key. Falls back to `$DEEPSEEK_API_KEY`. Empty → unavailable. */
  apiKey?: string
  /** Anthropic-compatible endpoint base; `/messages` is appended. */
  baseURL?: string
  /** Anthropic-format model name. Defaults to `deepseek-v4-flash`. */
  model?: string
  /** `anthropic-version` header value. Defaults to `2023-06-01`. */
  apiVersion?: string
  /** Upper bound on generated tokens for the Messages request. Defaults to 4096. */
  maxTokens?: number
  /** Maximum `web_search` server-tool uses per request. Defaults to 5. */
  maxUses?: number
}

export const Config: z<Config> = z.object({
  apiKey: z.string(),
  baseURL: z.string(),
  model: z.string(),
  apiVersion: z.string(),
  maxTokens: z.number().step(1).min(1),
  maxUses: z.number().step(1).min(1),
})

/** Register the DeepSeek search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  const maxTokens = config.maxTokens ?? DEEPSEEK_DEFAULT_MAX_TOKENS
  const maxUses = config.maxUses ?? DEEPSEEK_DEFAULT_MAX_USES
  ctx.web.registerSearchProvider(new DeepSeekSearchProvider({
    apiKey: config.apiKey ?? process.env.DEEPSEEK_API_KEY ?? '',
    baseURL: config.baseURL ?? DEEPSEEK_DEFAULT_BASE_URL,
    model: config.model ?? DEEPSEEK_DEFAULT_MODEL,
    apiVersion: config.apiVersion ?? DEEPSEEK_DEFAULT_API_VERSION,
    maxTokens,
    maxUses,
  }))
}
