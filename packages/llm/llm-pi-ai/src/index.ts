/**
 * Generic pi-ai-backed LLM adapter plugin. One plugin instance registers an
 * explicit set of provider profiles; requests select a profile by provider and
 * resolve the model dynamically from pi-ai's installed catalog.
 *
 * ```yaml
 * - id: llm
 *   name: '@deepseek-ai/dsh-llm-pi-ai'
 *   config:
 *     providers:
 *       - provider: openai
 *         apiKey: !!js process.env.OPENAI_API_KEY
 *       - provider: anthropic
 *         apiKey: !!js process.env.ANTHROPIC_API_KEY
 *       - provider: openrouter
 *         apiKey: !!js process.env.OPENROUTER_API_KEY
 *         baseURL: https://proxy.example.com/v1
 * ```
 *
 * @module @deepseek-ai/dsh-llm-pi-ai
 */

import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from './adapter.ts'
import { Config, resolveProfiles } from './config.ts'

export { PiAiAdapter } from './adapter.ts'
export type { PiAiAdapterOptions } from './adapter.ts'
export { Config, resolveProfiles } from './config.ts'
export type { PiAiProviderProfile } from './config.ts'
export { toPiContext } from './context.ts'
export { toPiReplayState } from './replay.ts'
export type { PiAiReplayState } from './replay.ts'
export { mapStopReason, mapUsage, toStreamChunks } from './stream.ts'

export const name = 'llm-pi-ai'
export const inject = ['llm']

/** Register one generic pi-ai adapter for all configured provider routes. */
export function apply(ctx: Context, config: Config): void {
  const profiles = resolveProfiles(config.providers)
  const adapter = new PiAiAdapter({ profiles })
  ctx.llm.registerAdapter(profiles.map(entry => entry.provider), adapter)
}
