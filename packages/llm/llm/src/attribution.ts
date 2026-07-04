/**
 * App-attribution vocabulary for provider requests.
 *
 * Every product LLM adapter must identify the application on every provider
 * HTTP request (see the adapter contract on {@link ../index.ts LlmAdapter}):
 * a static, non-secret product identity, sent as the standard `User-Agent`
 * baseline plus provider-specific headers only where a provider documents an
 * attribution mechanism (OpenRouter today). Adapters obtain the headers from
 * {@link attributionHeaders} instead of hand-copying constants, so the
 * identity cannot drift between implementations. The policy and its
 * rationale are pinned in
 * docs/rfc/implemented/architecture/2026-06-21-mandatory-app-attribution-headers.md.
 *
 * @module @deepseek-ai/dsh-llm/attribution
 */

import { createRequire } from 'node:module'
import { assertNever } from './never.ts'

// The package's own manifest is the single source of the version so the
// User-Agent cannot drift from what is published (`./package.json` is an
// export of this package; the relative path resolves from both `src/` and
// the bundled `lib/`).
const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

/**
 * Static public application identity sent to LLM providers.
 *
 * Every field is a public product fact, safe on every request: no secrets,
 * local paths, session ids, prompt text, or per-user identifiers belong here,
 * and nothing per-request may influence the values.
 */
export interface AppIdentity {
  /** `User-Agent` product token (lowercase, hyphenated). */
  product: string
  /** Product version; sourced from package metadata, never hand-copied. */
  version: string
  /** Public display name, for providers with app pages (OpenRouter title). */
  title: string
  /** Public home URL of the app (OpenRouter's app identifier). */
  url: string
  /** Category tags for providers with app marketplaces (OpenRouter). */
  categories: readonly string[]
}

/**
 * The harness's own identity: the default every adapter sends. Deployments
 * that need a white-label identity pass their own {@link AppIdentity} to
 * {@link attributionHeaders} — omission falls back to this default; nothing
 * can suppress attribution entirely.
 */
export const APP_IDENTITY: AppIdentity = {
  product: 'deepseek-harness',
  version,
  title: 'DeepSeek Harness',
  // FIXME: create the public deepseek-ai/deepseek-harness-sdk repository this
  // URL promises before the first release ships attribution pointing at it.
  url: 'https://github.com/deepseek-ai/deepseek-harness-sdk',
  categories: ['cli-agent'],
}

/**
 * Which provider-specific attribution mapping to apply on top of the
 * `User-Agent` baseline. A closed union: add a variant only when a provider
 * documents an attribution mechanism — never reuse another provider's
 * headers by analogy.
 *
 * - `'generic'` — the provider-neutral baseline; `User-Agent` only.
 * - `'openrouter'` — adds OpenRouter's documented app-attribution set
 *   (`HTTP-Referer`, `X-OpenRouter-Title`, `X-OpenRouter-Categories`).
 *   Selection is always explicit adapter config; adapters must not infer it
 *   from base-URL fragments or model names.
 */
export type AttributionTarget = 'generic' | 'openrouter'

/**
 * The standard `User-Agent` value: `product/version (+url)`. The
 * parenthesized `+url` comment is the conventional self-identification form
 * (RFC 9110 §10.1.5 product + comment syntax).
 */
export function userAgent(identity: AppIdentity = APP_IDENTITY): string {
  return `${identity.product}/${identity.version} (+${identity.url})`
}

/**
 * Build the attribution headers an adapter must send on every provider
 * request. Header names are lowercase (HTTP field names are case-insensitive
 * on the wire; OpenRouter documents them as `HTTP-Referer`,
 * `X-OpenRouter-Title`, and `X-OpenRouter-Categories`, the latter joined
 * from {@link AppIdentity.categories} with commas).
 *
 * `target` defaults to `'generic'` here, in the module that owns the
 * vocabulary, so every adapter shares one defaulting rule instead of each
 * implementation hiding its own.
 */
export function attributionHeaders(
  target: AttributionTarget = 'generic',
  identity: AppIdentity = APP_IDENTITY,
): Record<string, string> {
  switch (target) {
    case 'generic':
      return { 'user-agent': userAgent(identity) }
    case 'openrouter':
      return {
        'user-agent': userAgent(identity),
        'http-referer': identity.url,
        'x-openrouter-title': identity.title,
        'x-openrouter-categories': identity.categories.join(','),
      }
    default:
      return assertNever(target, 'attributionHeaders')
  }
}
