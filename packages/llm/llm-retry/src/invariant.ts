/** Package-owned durable retry-event invariants. @module @deepseek-ai/dsh-llm-retry/invariant */

import type { Context } from 'cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
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
  const { turn, step, retry, maxRetries, delayMs } = event.data
  if (!Number.isSafeInteger(retry) || retry < 1) {
    fail('llm/retry retry must be a positive safe integer')
  }
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 1 || retry > maxRetries) {
    fail(`llm/retry retry ${retry} must not exceed a positive safe maxRetries ${maxRetries}`)
  }
  if (!(delayMs >= 0 && delayMs <= MAX_TIMER_DELAY_MS)) {
    fail(`llm/retry delayMs must be within 0..${MAX_TIMER_DELAY_MS}`)
  }

  const currentTurnEvents: SessionEvent[] = []
  let openTurn: number | undefined
  for (const prior of history.slice().reverse()) {
    if (prior.type === 'turn/end') fail('llm/retry must be appended inside an open turn')
    if (prior.type === 'turn/start') {
      openTurn = prior.data.turn
      break
    }
    currentTurnEvents.push(prior)
  }
  if (openTurn === undefined) fail('llm/retry must be appended inside an open turn')
  if (turn !== openTurn) {
    fail(`llm/retry names turn ${turn}, but the open turn is ${openTurn}`)
  }

  let closedStep: number | undefined
  for (const prior of currentTurnEvents) {
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

  const priorRetries = currentTurnEvents
    .filter((prior): prior is SessionEvent<'llm/retry'> => prior.type === 'llm/retry')
  if (priorRetries.some(prior => prior.data.step === step)) {
    fail(`llm/retry duplicates the retry record for turn ${turn}/step ${step}`)
  }
  const priorRetry = priorRetries[0]
  if (priorRetry !== undefined && retry <= priorRetry.data.retry) {
    fail(`llm/retry retry ${retry} must increase after retry ${priorRetry.data.retry}`)
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
