/**
 * Branded (nominal) ID types.
 *
 * A brand makes structurally-identical strings non-interchangeable at the
 * type level: an `AgentId` cannot be passed where a `CallId` is expected,
 * even though both are strings at runtime. Construction goes through the
 * per-type factory (a plain cast inside — zero runtime cost); comparison,
 * logging, and serialization all behave as ordinary strings.
 *
 * Policy: core packages brand the IDs they own — `CallId` here (tool-call
 * correlation), `SessionId` in dsh-session, `AgentId` in dsh-agent. Branding
 * is for IDs that cross package boundaries and could plausibly be confused;
 * not every string needs a brand.
 *
 * @module @deepseek-ai/dsh-llm/brand
 */

declare const BRAND: unique symbol

/** A string carrying a compile-time-only brand `B`. */
export type Branded<B extends string> = string & { readonly [BRAND]: B }

/**
 * Correlates a model-issued tool call with its result. Provider-issued for
 * real adapters; synthesized by mocks/assembler fallbacks.
 */
export type CallId = Branded<'CallId'>

/** Brand a string as a {@link CallId}. */
export function CallId(id: string): CallId {
  return id as CallId
}
