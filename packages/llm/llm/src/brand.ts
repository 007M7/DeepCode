/**
 * dsh-llm's owned branded ids: tool-call correlation and provider request
 * diagnostics.
 *
 * The `Branded<B>` primitive itself lives in `@deepseek-ai/dsh-brand` (a
 * zero-dependency type-only package) so every owner of a cross-boundary id can
 * brand it without depending on dsh-llm; see that package's README for the
 * nominal-typing policy.
 *
 * @module @deepseek-ai/dsh-llm/brand
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Correlates a model-issued tool call with its result. Provider-issued for
 * real adapters; synthesized by mocks/assembler fallbacks.
 */
export type CallId = Branded<'CallId'>

/**
 * Brand a string as a {@link CallId}.
 * @param id - the provider-issued (or synthesized) call id.
 * @returns the same string, branded; no validation is performed.
 */
export function CallId(id: string): CallId {
  return id as CallId
}

/** Provider-issued request identifier retained for diagnostics across package boundaries. */
export type ProviderRequestId = Branded<'ProviderRequestId'>

/**
 * Brand a provider-issued request identifier.
 * @param id - the opaque provider-issued string.
 * @returns the same string, branded; no validation is performed.
 */
export function ProviderRequestId(id: string): ProviderRequestId {
  return id as ProviderRequestId
}
