/**
 * Public configuration, defaults, and typed failures for session-query.
 *
 * @module @deepseek-ai/dsh-session-query/config
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Default page size for provider-backed search. */
export const SESSION_QUERY_DEFAULT_LIMIT = 20
/** Maximum page size accepted by provider-backed search. */
export const SESSION_QUERY_MAX_LIMIT = 100
/** Default maximum `before`/`after` raw-event window. */
export const SESSION_QUERY_READ_WINDOW_MAX = 50

/** Configuration for the provider-neutral session-query service. */
export interface Config {
  /** Explicit provider id; omitted auto-selects exactly one usable provider. */
  searchProvider?: string
  /** Default search result page size. Defaults to 20. */
  defaultLimit?: number
  /** Maximum accepted search page size. Defaults to 100. */
  maxLimit?: number
  /** Maximum accepted raw read context on either side. Defaults to 50. */
  readWindowMax?: number
}

/** Typed session-query failure with a stable machine-routable code. */
export class SessionQueryError extends HarnessError {}
