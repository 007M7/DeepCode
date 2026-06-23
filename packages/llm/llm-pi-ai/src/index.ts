/**
 * pi-ai-backed DeepSeek adapter plugin. Same Config shape as
 * `@deepseek-ai/dsh-llm-deepseek` (one-line swap in cordis.yml), different
 * implementation underneath — see `./adapter.ts` for why both exist.
 *
 * ```yaml
 * - id: llm
 *   name: '@deepseek-ai/dsh-llm-pi-ai'
 *   config:
 *     apiKey: !!js process.env.DEEPSEEK_API_KEY
 *     baseURL: !!js process.env.DEEPSEEK_BASE_URL
 *     models: [deepseek-v4-flash, deepseek-v4-pro]
 *     reasoning: high
 * ```
 *
 * @module @deepseek-ai/dsh-llm-pi-ai
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import type {} from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from './adapter.ts'
import type { PiAiReasoning } from './adapter.ts'

export { buildModel, PiAiAdapter } from './adapter.ts'
export type { PiAiAdapterOptions, PiAiReasoning } from './adapter.ts'
export { mapStopReason, mapUsage, toPiContext, toStreamChunks } from './convert.ts'

export const name = 'llm-pi-ai'
export const inject = ['llm']

export interface Config {
  /** API key; falls back to $DEEPSEEK_API_KEY. Required one way or the other. */
  apiKey?: string
  /** Endpoint base; falls back to $DEEPSEEK_BASE_URL, then the public API. */
  baseURL?: string
  /** Model names to register (sent verbatim on the wire). */
  models?: string[]
  /**
   * Thinking level for every request: 'off' disables thinking mode; 'high'
   * and 'xhigh' (wire 'max') set the effort. Omitted = provider default
   * (thinking enabled), matching llm-deepseek's omission semantics.
   */
  reasoning?: PiAiReasoning
}

export const Config: z<Config> = z.object({
  apiKey: z.string(),
  baseURL: z.string(),
  models: z.array(z.string()).default(['deepseek-v4-flash', 'deepseek-v4-pro']),
  reasoning: z.union(['off', 'high', 'xhigh']),
})

/** Public API default; the internal endpoint comes from $DEEPSEEK_BASE_URL. */
export const PUBLIC_BASE_URL = 'https://api.deepseek.com'

export function apply(ctx: Context, config: Config): void {
  const apiKey = config.apiKey ?? process.env.DEEPSEEK_API_KEY
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error('llm-pi-ai: an API key is required (Config.apiKey or $DEEPSEEK_API_KEY)')
  }
  const baseURL = config.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? PUBLIC_BASE_URL
  // schemastery's .default() guarantees models is set after validation.
  const models = config.models as string[]

  ctx.llm.registerAdapter(models, new PiAiAdapter({
    apiKey,
    baseURL,
    reasoning: config.reasoning,
  }))
}
