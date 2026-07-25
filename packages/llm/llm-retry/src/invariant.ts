/** Package-owned durable retry-event invariants. @module @deepseek-ai/dsh-llm-retry/invariant */

import type { Context } from 'cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { providerForClosedStep } from './history.ts'
import { parseRetryPolicyKey } from './policy-key.ts'
import type {} from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-llm-retry'

/** Cordis companion plugin name. */
export const name = 'llm-retry-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Validate one retry record against the open turn and most recently closed step. */
function validateRetry(
  history: readonly SessionEvent[],
  event: SessionEvent<'llm/retry'>,
  fail: InvariantFailure,
): void {
  const { turn, step, provider, mode, policyKey, retry, delayMs } = event.data
  if (!Number.isSafeInteger(retry) || retry < 1) {
    fail('llm/retry retry must be a positive safe integer')
  }
  if (typeof provider !== 'string' || provider.length === 0) {
    fail('llm/retry provider must be non-empty string')
  }
  const keyedPolicy = parseRetryPolicyKey(policyKey)
  if (keyedPolicy === undefined) {
    fail('llm/retry policyKey must encode a canonical resolved policy')
  }
  switch (mode) {
    case 'normal': {
      const { maxRetries } = event.data
      if (!Number.isSafeInteger(maxRetries) || maxRetries < 1 || retry > maxRetries) {
        fail(`llm/retry retry ${retry} must not exceed a positive safe maxRetries ${maxRetries}`)
      }
      if (keyedPolicy.mode !== 'normal') {
        fail(`llm/retry mode normal must match policyKey mode ${keyedPolicy.mode}`)
      }
      if (keyedPolicy.maxRetries !== maxRetries) {
        fail(`llm/retry maxRetries ${maxRetries} must match policyKey`)
      }
      if (!keyedPolicy.retryableCodes.includes(event.data.failure.code)) {
        fail(`llm/retry failure code ${event.data.failure.code} must be eligible under policyKey`)
      }
      break
    }
    case 'always':
      if (keyedPolicy.mode !== 'always') {
        fail(`llm/retry mode always must match policyKey mode ${keyedPolicy.mode}`)
      }
      if ('maxRetries' in event.data) fail('llm/retry always mode must omit maxRetries')
      break
    default:
      fail(`llm/retry mode must be normal or always, got ${String(mode)}`)
  }
  if (typeof delayMs !== 'number' || !Number.isFinite(delayMs)
    || delayMs < 0 || delayMs > keyedPolicy.maxDelayMs) {
    fail(`llm/retry delayMs must be a finite number within policyKey range 0..${keyedPolicy.maxDelayMs}`)
  }

  const turnStartIndex = history.findLastIndex(prior =>
    prior.type === 'turn/start' || prior.type === 'turn/end')
  const turnBoundary = history[turnStartIndex]
  if (turnBoundary?.type !== 'turn/start') {
    fail('llm/retry must be appended inside an open turn')
  }
  const openTurn = turnBoundary.data.turn
  if (turn !== openTurn) {
    fail(`llm/retry names turn ${turn}, but the open turn is ${openTurn}`)
  }

  const currentTurnEvents = history.slice(turnStartIndex + 1)
  let closedStep: number | undefined
  for (const prior of currentTurnEvents.slice().reverse()) {
    if (prior.type === 'step/start') {
      fail(`llm/retry must follow step/end, but step ${prior.data.step} is still open`)
    }
    if (prior.type === 'step/end') {
      closedStep = prior.data.step
      break
    }
  }
  if (closedStep === undefined || step !== closedStep) {
    fail(`llm/retry names step ${step}, but the latest closed step is ${String(closedStep)}`)
  }
  const routedProvider = providerForClosedStep(history, turn, step)
  if (routedProvider !== provider) {
    fail(`llm/retry provider ${provider} does not match the failed request provider ${String(routedProvider)}`)
  }

  const priorRetries = currentTurnEvents
    .filter((prior): prior is SessionEvent<'llm/retry'> => prior.type === 'llm/retry')
  if (priorRetries.some(prior => prior.data.step === step)) {
    fail(`llm/retry duplicates the retry record for turn ${turn}/step ${step}`)
  }
  const lastSuccessIndex = currentTurnEvents.findLastIndex(prior => prior.type === 'assistant/message')
  const priorPolicyRetry = currentTurnEvents.findLast((prior, index): prior is SessionEvent<'llm/retry'> => (
    index > lastSuccessIndex
    && prior.type === 'llm/retry'
    && prior.data.provider === provider
    && prior.data.policyKey === policyKey
  ))
  const expectedRetry = (priorPolicyRetry?.data.retry ?? 0) + 1
  if (retry !== expectedRetry) {
    fail(`llm/retry retry ${retry} must equal provider policy retry ${expectedRetry}`)
  }
}

/** Validate every retry record already present in one loaded session. */
function validateSession(session: Session, fail: InvariantFailure): void {
  for (const [index, event] of session.events.entries()) {
    if (event.type === 'llm/retry') validateRetry(session.events.slice(0, index), event, fail)
  }
}

/** Install validation for loaded and newly appended retry records. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) validateSession(session, fail)
  ctx.on('session/created', (session) => { validateSession(session, fail) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type === 'llm/retry') validateRetry(session.events, event, fail)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the LLM retry invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
