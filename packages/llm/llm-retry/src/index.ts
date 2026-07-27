/**
 * Bounded transient model-request retry policy on the agent request-recovery
 * seam. Each scheduled retry is durable before its cancellable wait.
 *
 * @module @deepseek-ai/dsh-llm-retry
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import type { Agent, RequestError, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /** Durable, non-surface record of one transient retry scheduled after a closed failed step. */
    'llm/retry': {
      turn: number
      step: number
      retry: number
      maxRetries: number
      delayMs: number
      failure: LlmFailure
    }
  }
}

export const name = 'llm-retry'
export const inject = ['agents']

const DEFAULT_MAX_TRANSIENT_RETRIES = 2
const DEFAULT_INITIAL_DELAY_MS = 500
const DEFAULT_MAX_DELAY_MS = 10_000
const DEFAULT_JITTER_RATIO = 0.1
const DEFAULT_RETRYABLE_CODES = Object.freeze(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])

/** Deployment-owned limits and classification for transient request recovery. */
export interface Config {
  /** Maximum transient retries after the first request (default 2). */
  maxTransientRetries?: number
  /** Initial local exponential-backoff delay in milliseconds (default 500). */
  initialDelayMs?: number
  /** Maximum accepted or locally scheduled delay in milliseconds (default 10000). */
  maxDelayMs?: number
  /** Symmetric random multiplier range around one (default 0.1). */
  jitterRatio?: number
  /** Stable failure codes eligible for this policy. */
  retryableCodes?: string[]
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  maxTransientRetries: z.number().step(1).min(0).default(DEFAULT_MAX_TRANSIENT_RETRIES),
  initialDelayMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_INITIAL_DELAY_MS),
  maxDelayMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_MAX_DELAY_MS),
  jitterRatio: z.number().min(0).max(1).default(DEFAULT_JITTER_RATIO),
  retryableCodes: z.array(z.string()).default([...DEFAULT_RETRYABLE_CODES]),
})

interface ResolvedConfig {
  readonly maxTransientRetries: number
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly jitterRatio: number
  readonly retryableCodes: ReadonlySet<string>
}

function resolveConfig(config: Config): ResolvedConfig {
  const maxTransientRetries = config.maxTransientRetries ?? DEFAULT_MAX_TRANSIENT_RETRIES
  const initialDelayMs = config.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
  const maxDelayMs = config.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const jitterRatio = config.jitterRatio ?? DEFAULT_JITTER_RATIO
  const codes = config.retryableCodes ?? [...DEFAULT_RETRYABLE_CODES]

  if (!Number.isInteger(maxTransientRetries) || maxTransientRetries < 0) {
    throw new Error('llm-retry: maxTransientRetries must be a non-negative integer')
  }
  if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0 || initialDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`llm-retry: initialDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0 || maxDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`llm-retry: maxDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (initialDelayMs > maxDelayMs) {
    throw new Error('llm-retry: initialDelayMs must be less than or equal to maxDelayMs')
  }
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new Error('llm-retry: jitterRatio must be between 0 and 1')
  }
  if (codes.length === 0) {
    throw new Error('llm-retry: retryableCodes must not be empty')
  }
  if (codes.some(code => code.length === 0)) {
    throw new Error('llm-retry: retryableCodes must contain only non-empty strings')
  }
  if (new Set(codes).size !== codes.length) {
    throw new Error('llm-retry: retryableCodes must not contain duplicates')
  }

  return Object.freeze({
    maxTransientRetries,
    initialDelayMs,
    maxDelayMs,
    jitterRatio,
    retryableCodes: new Set(codes),
  })
}

/** Non-serializable seams used to make timing policy deterministic in tests. */
export interface RetryInternals {
  /** Random sample in the inclusive zero-to-one range used for jitter. */
  random?: () => number
}

function localDelay(config: ResolvedConfig, retry: number, random: () => number): number {
  const exponent = Math.min(retry - 1, 1024)
  const exponential = Math.min(config.initialDelayMs * 2 ** exponent, config.maxDelayMs)
  const jitter = 1 - config.jitterRatio + 2 * config.jitterRatio * random()
  return Math.min(exponential * jitter, config.maxDelayMs)
}

function cancellableDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort(): void {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Install bounded transient request recovery.
 * @param ctx - plugin context that owns the listener and active waits.
 * @param config - retry budget, delay bounds, jitter, and eligible codes.
 * @param internals - non-serializable deterministic seams for tests.
 */
export function apply(ctx: Context, config: Config = {}, internals: RetryInternals = {}): void {
  const resolved = resolveConfig(config)
  const random = internals.random ?? Math.random
  const lifetime = new AbortController()
  const active = new Set<Promise<RequestErrorAction>>()
  const retries = new WeakMap<Agent, number>()

  async function backoff(
    agent: Agent,
    turn: number,
    step: number,
    failure: LlmFailure,
    retry: number,
    delayMs: number,
    signal: AbortSignal,
  ): Promise<RequestErrorAction> {
    const fusedSignal = AbortSignal.any([signal, lifetime.signal])
    if (fusedSignal.aborted) return
    agent.session.append('llm/retry', {
      turn,
      step,
      retry,
      maxRetries: resolved.maxTransientRetries,
      delayMs,
      failure,
    })
    retries.set(agent, retry)
    if (!await cancellableDelay(delayMs, fusedSignal)) return
    return { kind: 'retry' }
  }

  ctx.on('agent/settled', (agent) => {
    retries.delete(agent)
  })

  // A completed model response ends the consecutive-failure sequence even
  // when its tool calls keep the turn running into another request.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/message') return
    const agent = ctx.agents.get(session.id)
    if (agent?.session === session) retries.delete(agent)
  })

  const disposeListener = ctx.on('agent/request-error', (
    agent: Agent,
    turn: number,
    step: number,
    _error: RequestError,
    failure: LlmFailure,
    signal: AbortSignal,
    next: () => Promise<RequestErrorAction>,
  ) => {
    // A waterfall may have captured this callback before its registration was
    // removed. Lifetime cancellation must prevent that stale callback from
    // entering a downstream policy after disposal.
    if (lifetime.signal.aborted) return Promise.resolve<RequestErrorAction>(undefined)
    if (!resolved.retryableCodes.has(failure.code)) return next()
    const priorRetries = retries.get(agent) ?? 0
    if (priorRetries >= resolved.maxTransientRetries) return next()

    const retry = priorRetries + 1
    let delayMs: number
    if (failure.providerRetryAfterMs !== undefined
      && Number.isFinite(failure.providerRetryAfterMs)
      && failure.providerRetryAfterMs > 0) {
      if (failure.providerRetryAfterMs > resolved.maxDelayMs) return next()
      delayMs = failure.providerRetryAfterMs
    } else {
      delayMs = localDelay(resolved, retry, random)
    }

    const tracked = backoff(agent, turn, step, failure, retry, delayMs, signal)
      .finally(() => active.delete(tracked))
    active.add(tracked)
    return tracked
  })

  ctx.effect(() => async () => {
    disposeListener()
    lifetime.abort(new Error('llm-retry plugin disposed'))
    await Promise.allSettled([...active])
  }, 'llm-retry: abort and drain backoffs')
}
