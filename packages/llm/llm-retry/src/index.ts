/**
 * Provider-routed model-request retry policy on the agent loop's closed-step
 * recovery seam. Each scheduled retry is durable before its cancellable wait.
 *
 * @module @deepseek-ai/dsh-llm-retry
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import type { Agent, RequestError, RequestErrorDecision } from '@deepseek-ai/dsh-agent'
import type { LlmFailure, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { providerForClosedStep } from './history.ts'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /** Durable, non-surface record of one provider-routed retry scheduled after a closed failed step. */
    'llm/retry': {
      turn: number
      step: number
      provider: string
      mode: 'normal'
      retry: number
      maxRetries: number
      delayMs: number
      failure: LlmFailure
    } | {
      turn: number
      step: number
      provider: string
      mode: 'always'
      retry: number
      delayMs: number
      failure: LlmFailure
    }
  }
}

export const name = 'llm-retry'
export const inject = ['agents']

/** This policy executor has no config; providers own `retryPolicy`. */
export type Config = Readonly<Record<string, never>>

/** Runtime schema for {@link Config}. */
export const Config = z.object({}) as unknown as z<Config>

function validateConfig(config: Config): void {
  const [key] = Object.keys(config)
  if (key === undefined) return
  if (key === 'retryPolicy') {
    throw new Error('llm-retry: retryPolicy belongs under each provider configuration')
  }
  throw new Error(`llm-retry: unknown key "${key}"`)
}

/** Non-serializable seams used to make timing policy deterministic in tests. */
export interface RetryInternals {
  /** Random sample in the inclusive zero-to-one range used for jitter. */
  random?: () => number
}

type DownstreamOutcome =
  | { readonly type: 'decision'; readonly decision: RequestErrorDecision }
  | { readonly type: 'error'; readonly error: unknown }
  | { readonly type: 'aborted' }

function downstreamUntilAbort(
  next: () => Promise<RequestErrorDecision>,
  signal: AbortSignal,
): Promise<DownstreamOutcome> {
  if (signal.aborted) return Promise.resolve({ type: 'aborted' })
  return new Promise((resolve) => {
    const finish = (outcome: DownstreamOutcome): void => {
      signal.removeEventListener('abort', onAbort)
      resolve(outcome)
    }
    const onAbort = (): void => { finish({ type: 'aborted' }) }
    signal.addEventListener('abort', onAbort, { once: true })
    let downstream: Promise<RequestErrorDecision>
    try {
      downstream = next()
    } catch (error: unknown) {
      finish({ type: 'error', error })
      return
    }
    void downstream.then(
      (decision) => { finish({ type: 'decision', decision }) },
      (error: unknown) => { finish({ type: 'error', error }) },
    )
  })
}

function localDelay(config: ResolvedRetryPolicy, retry: number, random: () => number): number {
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
 * Install provider-routed normal or unbounded request recovery.
 * @param ctx - plugin context that owns the listener and active waits.
 * @param config - empty executor config; provider registrations own policy.
 * @param internals - non-serializable deterministic seams for tests.
 */
export function apply(ctx: Context, config: Config = {}, internals: RetryInternals = {}): void {
  validateConfig(config)
  const random = internals.random ?? Math.random
  const lifetime = new AbortController()
  const active = new Set<Promise<RequestErrorDecision>>()

  async function backoff(
    agent: Agent,
    turn: number,
    step: number,
    failure: LlmFailure,
    provider: string,
    policy: ResolvedRetryPolicy,
    retry: number,
    delayMs: number,
    signal: AbortSignal,
  ): Promise<RequestErrorDecision> {
    const fusedSignal = AbortSignal.any([signal, lifetime.signal])
    if (fusedSignal.aborted) return { action: 'fail' }
    const eventData = policy.mode === 'normal'
      ? {
        turn,
        step,
        provider,
        mode: policy.mode,
        retry,
        maxRetries: policy.maxRetries,
        delayMs,
        failure,
      }
      : {
        turn,
        step,
        provider,
        mode: policy.mode,
        retry,
        delayMs,
        failure,
      }
    agent.session.append('llm/retry', eventData)
    if (!await cancellableDelay(delayMs, fusedSignal)) return { action: 'fail' }
    return { action: 'retry' }
  }

  const disposeListener = ctx.on('agent/request-error', async (
    agent: Agent,
    turn: number,
    step: number,
    _error: RequestError,
    failure: LlmFailure,
    priorFailures: readonly LlmFailure[],
    policy: ResolvedRetryPolicy | undefined,
    signal: AbortSignal,
    next: () => Promise<RequestErrorDecision>,
  ) => {
    // A waterfall may have captured this callback before its registration was
    // removed. Lifetime cancellation must prevent that stale callback from
    // entering a downstream policy after disposal.
    if (lifetime.signal.aborted) return Promise.resolve<RequestErrorDecision>({ action: 'fail' })
    if (policy === undefined) return next()
    // The call-local policy belongs to the registration that served this
    // failure. Recover only the durable provider identity from the header;
    // downstream recovery may append later state before an always fallback.
    const provider = providerForClosedStep(agent.session.events, turn, step)
    /* v8 ignore next 3 -- agent-loop closes only steps whose request header was recorded */
    if (provider === undefined) {
      throw new Error(`llm-retry: no request provider for closed turn ${turn}/step ${step}`)
    }
    if (policy.mode === 'always') {
      const downstream = await downstreamUntilAbort(
        next,
        AbortSignal.any([signal, lifetime.signal]),
      )
      if (downstream.type === 'aborted') return { action: 'fail' }
      if (downstream.type === 'error') {
        ctx.logger.warn(
          `llm-retry: provider "${provider}" always policy ignored a downstream recovery failure: %o`,
          downstream.error,
        )
      }
      if (downstream.type === 'decision' && downstream.decision.action === 'retry') {
        return downstream.decision
      }
    } else if (!policy.retryableCodes.includes(failure.code)) {
      return next()
    }

    const firstPriorStep = step - priorFailures.length
    const priorPolicyRetry = agent.session.events.findLast((event): event is SessionEvent<'llm/retry'> =>
      event.type === 'llm/retry'
      && event.data.turn === turn
      && event.data.step >= firstPriorStep
      && event.data.step < step
      && event.data.provider === provider
      && event.data.mode === policy.mode,
    )
    const previousRetry = priorPolicyRetry?.data.retry ?? 0
    if (policy.mode === 'normal' && previousRetry >= policy.maxRetries) return next()
    const retry = previousRetry + 1
    let delayMs: number
    if (failure.providerRetryAfterMs !== undefined
      && Number.isFinite(failure.providerRetryAfterMs)
      && failure.providerRetryAfterMs > 0) {
      if (failure.providerRetryAfterMs > policy.maxDelayMs) {
        if (policy.mode === 'normal') return next()
        delayMs = localDelay(policy, retry, random)
      } else {
        delayMs = failure.providerRetryAfterMs
      }
    } else {
      delayMs = localDelay(policy, retry, random)
    }

    const tracked = backoff(agent, turn, step, failure, provider, policy, retry, delayMs, signal)
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
