/**
 * Full-log usage and current-context projection for Web clients.
 *
 * @module @deepseek-ai/dsh-host-apiproxy/session-metrics
 */

import type { Context } from 'cordis'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionMetrics } from './api/sessions.ts'

interface UsageState {
  logRevision: number
  projectionRevision: number
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  byStep: Map<string, TokenUsage>
}

interface TokenMeterLike {
  measure(session: Session): { totalTokens: number }
}

function usageFrom(event: SessionEvent): { turn: number; step: number; usage: TokenUsage } | undefined {
  if (event.type === 'assistant/chunk' && event.data.chunk.type === 'usage') {
    return { turn: event.data.turn, step: event.data.step, usage: event.data.chunk.usage }
  }
  if (event.type === 'assistant/message' && event.data.usage !== undefined) {
    return { turn: event.data.turn, step: event.data.step, usage: event.data.usage }
  }
  return undefined
}

/**
 * Whether an appended event can change cumulative usage or token-meter
 * pressure. Text/reasoning stream deltas remain outside both projections.
 * @param event - appended durable event.
 * @returns true when the Host must publish a fresh metrics snapshot.
 */
export function affectsSessionMetrics(event: SessionEvent): boolean {
  if (event.type === 'assistant/chunk') return event.data.chunk.type === 'usage'
  if (event.type === 'request/header') return true
  return 'surfaceOp' in event
}

function recordUsage(state: UsageState, turn: number, step: number, usage: TokenUsage): void {
  const key = `${turn}:${step}`
  const previous = state.byStep.get(key)
  if (previous !== undefined) {
    state.uncachedInputTokens -= previous.inputTokens
    state.outputTokens -= previous.outputTokens
    state.cacheReadTokens -= previous.cacheReadTokens ?? 0
    state.cacheWriteTokens -= previous.cacheWriteTokens ?? 0
  }
  state.byStep.set(key, usage)
  state.uncachedInputTokens += usage.inputTokens
  state.outputTokens += usage.outputTokens
  state.cacheReadTokens += usage.cacheReadTokens ?? 0
  state.cacheWriteTokens += usage.cacheWriteTokens ?? 0
}

/** Projects durable cumulative usage and synchronous current context pressure. */
export class SessionMetricsProjector {
  private readonly usage = new WeakMap<Session, UsageState>()

  /** @param ctx - Host context providing an optional token-meter service. */
  constructor(private readonly ctx: Context) {}

  /**
   * Read a fresh detached projection through the session's durable tail.
   * @param session - authoritative durable log owner.
   * @returns cumulative usage and any currently measurable pressure.
   */
  snapshot(session: Session): SessionMetrics {
    const state = this.syncUsage(session)
    const tokenMeter = this.ctx.get('tokenMeter') as TokenMeterLike | undefined
    let contextTokens: number | undefined
    if (tokenMeter !== undefined) {
      try {
        contextTokens = tokenMeter.measure(session).totalTokens
      } catch {
        // A malformed or temporarily unmeasurable replay has no honest pressure value.
      }
    }
    return {
      logRevision: state.logRevision,
      projectionRevision: state.projectionRevision++,
      uncachedInputTokens: state.uncachedInputTokens,
      outputTokens: state.outputTokens,
      cacheReadTokens: state.cacheReadTokens,
      cacheWriteTokens: state.cacheWriteTokens,
      ...contextTokens === undefined ? {} : { contextTokens },
    }
  }

  private syncUsage(session: Session): UsageState {
    let state = this.usage.get(session)
    if (state === undefined) {
      state = {
        logRevision: 0,
        projectionRevision: 0,
        uncachedInputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        byStep: new Map(),
      }
      this.usage.set(session, state)
    }
    while (state.logRevision < session.events.length) {
      const event = session.events[state.logRevision]
      /* v8 ignore next -- Session events are append-only and dense; logRevision is bounded by length. */
      if (event === undefined) break
      const usage = usageFrom(event)
      if (usage !== undefined) recordUsage(state, usage.turn, usage.step, usage.usage)
      state.logRevision++
    }
    return state
  }
}
