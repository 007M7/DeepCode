/**
 * Public configuration and measurement vocabulary for replay token metering.
 *
 * @module @deepseek-ai/dsh-token-meter/types
 */

import type { Message, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { EpochHeader, Session } from '@deepseek-ai/dsh-session'

/** Optional pricing fields for one configured model. */
export interface ModelTokenMeterConfig {
  /** Provider context-window capacity in tokens. Required for a custom model. */
  contextWindow?: number
  /** Heuristic text density in characters per token. Defaults to `4`. */
  charsPerToken?: number
}

/** Token-meter plugin configuration. */
export interface TokenMeterConfig {
  /** Built-in field overrides and custom model profiles, keyed by routed model name. */
  models?: Record<string, ModelTokenMeterConfig>
}

/** The baseline from which a signed surface delta produces current pressure. */
export type TokenMeasurementBaseline =
  | { readonly kind: 'none'; readonly tokens: 0 }
  | { readonly kind: 'estimated'; readonly tokens: number }
  | { readonly kind: 'usage'; readonly tokens: number; readonly usage: Readonly<TokenUsage> }

/** Detached immutable scalar pressure at one consumed session-log revision. */
export interface TokenMeasurement {
  /** Model profile used for every heuristic component. */
  readonly model: string
  /** Number of durable events consumed; equal to the next unread event seq. */
  readonly logRevision: number
  /** Provider or heuristic anchor used for this measurement. */
  readonly baseline: TokenMeasurementBaseline
  /** Signed repricing of current surface content relative to the baseline anchor. */
  readonly surfaceDeltaTokens: number
  /** Non-negative current request-and-response pressure. */
  readonly totalTokens: number
}

/** One token-priced node in the current ordered session surface. */
export interface TokenSurfaceNode {
  /** Durable sequence number of the surface event. */
  readonly seq: number
  /** Heuristic tokens for the exact message projected by this node. */
  readonly tokens: number
}

/** Detached immutable priced surface at one consumed session-log revision. */
export interface TokenSurfaceMeasurement {
  /** Model profile used to price every node. */
  readonly model: string
  /** Number of durable events consumed; equal to the next unread event seq. */
  readonly logRevision: number
  /** Total heuristic tokens across the current surface. */
  readonly totalTokens: number
  /** Current surface nodes in positional head-to-tail order. */
  readonly nodes: readonly TokenSurfaceNode[]
}

/** A model-bound replay meter returned by {@link TokenMeterService.resolve}. */
export interface ModelTokenMeter {
  /** Routed model name bound to this handle. */
  readonly model: string
  /** Provider context-window capacity in tokens. */
  readonly contextWindow: number
  /** Heuristic text density in characters per token. */
  readonly charsPerToken: number

  /**
   * Measure current request pressure through the session's durable tail.
   *
   * Provider usage is reused only when its routed model and canonical request
   * envelope match `requestHeader`; otherwise the complete envelope and
   * surface are heuristically repriced for this handle's model.
   *
   * @param session - session to replay through its current durable tail.
   * @param requestHeader - optional effective request envelope replacing the latest logged header.
   * @returns a detached deeply immutable pressure measurement.
   */
  measure(session: Session, requestHeader?: EpochHeader): TokenMeasurement

  /**
   * Price the current surface for retention and replacement decisions.
   *
   * @param session - session to replay through its current durable tail.
   * @returns a detached deeply immutable positional surface measurement.
   */
  measureSurface(session: Session): TokenSurfaceMeasurement

  /**
   * Heuristically price one model-visible message.
   *
   * @param message - message to price without mutation.
   * @returns content and role-framing tokens under this model profile.
   */
  estimateMessage(message: Message): number
}
