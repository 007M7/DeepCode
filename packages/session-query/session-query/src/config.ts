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

/** Complete stable machine-routable failure taxonomy for session-query. */
export type SessionQueryErrorCode =
  | 'SESSION_QUERY_ABORTED'
  | 'SESSION_QUERY_DUPLICATE_EXTRACTOR'
  | 'SESSION_QUERY_DUPLICATE_PROVIDER'
  | 'SESSION_QUERY_EVENT_NOT_FOUND'
  | 'SESSION_QUERY_INDEX_FAILED'
  | 'SESSION_QUERY_INVALID_CONFIG'
  | 'SESSION_QUERY_INVALID_EXTRACTOR'
  | 'SESSION_QUERY_INVALID_FILTER'
  | 'SESSION_QUERY_INVALID_LIMIT'
  | 'SESSION_QUERY_INVALID_LINEAGE'
  | 'SESSION_QUERY_INVALID_QUERY'
  | 'SESSION_QUERY_INVALID_SURFACE'
  | 'SESSION_QUERY_INVALID_WINDOW'
  | 'SESSION_QUERY_PERSISTENCE_FAILED'
  | 'SESSION_QUERY_PROVIDER_AMBIGUOUS'
  | 'SESSION_QUERY_PROVIDER_CONFIGURED_MISSING'
  | 'SESSION_QUERY_PROVIDER_CONFIGURED_UNAVAILABLE'
  | 'SESSION_QUERY_PROVIDER_ERROR'
  | 'SESSION_QUERY_PROVIDER_UNAVAILABLE'
  | 'SESSION_QUERY_SESSION_NOT_FOUND'
  | 'SESSION_QUERY_SOURCE_CONFLICT'

/** Typed session-query failure whose `code` is one closed taxonomy member. */
export class SessionQueryError extends HarnessError {
  declare readonly code: SessionQueryErrorCode

  // The base stores the value; this signature narrows its open string code.
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(message: string, code: SessionQueryErrorCode, options?: ErrorOptions) {
    super(message, code, options)
  }
}
