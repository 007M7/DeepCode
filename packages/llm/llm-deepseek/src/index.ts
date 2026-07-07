/**
 * DeepSeek LLM adapter plugin: registers a {@link DeepSeekAdapter} for the
 * configured model names on `ctx.llm`.
 *
 * Config is cordis-native (schemastery). Secrets flow per the repo policy:
 * `apiKey` from cordis.yml via the `!!js` tag (`!!js process.env.DEEPSEEK_API_KEY`)
 * or from the environment directly; never from ad-hoc files.
 *
 * ```yaml
 * - id: llm-deepseek
 *   name: '@deepseek-ai/dsh-llm-deepseek'
 *   config:
 *     apiKey: !!js process.env.DEEPSEEK_API_KEY
 *     baseURL: !!js process.env.DEEPSEEK_BASE_URL
 *     models: [deepseek-v4-flash, deepseek-v4-pro]
 * ```
 *
 * @module @deepseek-ai/dsh-llm-deepseek
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import type {} from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter } from './adapter.ts'

export { DeepSeekAdapter, httpErrorCode } from './adapter.ts'
export type { DeepSeekAdapterOptions } from './adapter.ts'
export { serializeMessages, serializeRequest } from './serialize.ts'
export type { RequestDefaults } from './serialize.ts'
export { DONE, parseSse } from './sse.ts'
export { mapFinishReason, mapUsage, translate } from './translate.ts'
export type * from './types.ts'

export const name = 'llm-deepseek'
export const inject = ['llm']

/**
 * Plugin config, validated by the same-named schemastery schema. Every field
 * is optional in yml: credentials/endpoint fall back to the environment (a
 * missing API key fails plugin load, not the first call), and omitted
 * thinking fields send nothing on the wire, so the provider default applies.
 */
export interface Config {
  /** API key; falls back to $DEEPSEEK_API_KEY. Required one way or the other. */
  apiKey?: string
  /** Endpoint base; falls back to $DEEPSEEK_BASE_URL, then the public API. */
  baseURL?: string
  /** Model names to register (sent verbatim on the wire). */
  models?: string[]
  /** Thinking-mode default for every request (provider default: enabled). */
  thinking?: 'enabled' | 'disabled'
  /** Thinking effort (only meaningful with thinking enabled). */
  reasoningEffort?: 'high' | 'max'
}

export const Config: z<Config> = z.object({
  apiKey: z.string(),
  baseURL: z.string(),
  models: z.array(z.string()).default(['deepseek-v4-flash', 'deepseek-v4-pro']),
  thinking: z.union(['enabled', 'disabled']),
  reasoningEffort: z.union(['high', 'max']),
})

/** Public API default; the internal endpoint comes from $DEEPSEEK_BASE_URL. */
export const PUBLIC_BASE_URL = 'https://api.deepseek.com'

export function apply(ctx: Context, config: Config): void {
  const apiKey = config.apiKey ?? process.env.DEEPSEEK_API_KEY
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error('llm-deepseek: an API key is required (Config.apiKey or $DEEPSEEK_API_KEY)')
  }
  const baseURL = config.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? PUBLIC_BASE_URL
  // schemastery's .default() guarantees models is set after validation.
  const models = config.models as string[]

  ctx.llm.registerAdapter(models, new DeepSeekAdapter({
    apiKey,
    baseURL,
    defaults: {
      thinking: config.thinking,
      reasoningEffort: config.reasoningEffort,
    },
  }))
}
