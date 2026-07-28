/**
 * Full-log usage and current-context projection for Web clients.
 *
 * @module @deepseek-ai/dsh-host-apiproxy/session-metrics
 */

import type { Context } from 'cordis'
import type { Agent, AgentLlmTarget } from '@deepseek-ai/dsh-agent'
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

interface CapacityState {
  routeKey: string
  generation: number
  status: 'pending' | 'ready'
  contextWindow?: number
}

interface TokenMeterLike {
  measure(session: Session): { totalTokens: number }
}

interface LlmLike {
  resolveModelInfo(provider: string, model: string): Promise<{
    context?: { contextWindow: number }
  }>
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

/**
 * Projects durable cumulative usage and route-aware current context without
 * awaiting model metadata on the session append path.
 */
export class SessionMetricsProjector {
  private readonly usage = new WeakMap<Session, UsageState>()
  private readonly capacities = new WeakMap<Agent, CapacityState>()

  /**
   * @param ctx - Host context providing optional token-meter and LLM services.
   * @param targetFor - selected route owner for one attached Web agent.
   * @param onCapacityResolved - schedules a fresh live projection after exact-route metadata resolves.
   */
  constructor(
    private readonly ctx: Context,
    private readonly targetFor: (agent: Agent) => Pick<AgentLlmTarget, 'provider' | 'model'>,
    private readonly onCapacityResolved: (agent: Agent) => void,
  ) {}

  /**
   * Read a fresh detached projection through the session's durable tail.
   * @param session - authoritative durable log owner.
   * @param agent - attached route owner, when available.
   * @returns cumulative usage and any currently available pressure/capacity.
   */
  snapshot(session: Session, agent?: Agent): SessionMetrics {
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
    const contextWindow = agent === undefined ? undefined : this.capacityFor(agent)
    return {
      logRevision: state.logRevision,
      projectionRevision: state.projectionRevision++,
      uncachedInputTokens: state.uncachedInputTokens,
      outputTokens: state.outputTokens,
      cacheReadTokens: state.cacheReadTokens,
      cacheWriteTokens: state.cacheWriteTokens,
      ...contextTokens === undefined ? {} : { contextTokens },
      ...contextWindow === undefined ? {} : { contextWindow },
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

  private capacityFor(agent: Agent): number | undefined {
    const target = this.targetFor(agent)
    const routeKey = `${target.provider}\u0000${target.model}`
    let state = this.capacities.get(agent)
    if (state === undefined || state.routeKey !== routeKey) {
      state = {
        routeKey,
        generation: (state?.generation ?? 0) + 1,
        status: 'pending',
      }
      this.capacities.set(agent, state)
      this.resolveCapacity(agent, target, state)
    }
    return state.status === 'ready' ? state.contextWindow : undefined
  }

  private resolveCapacity(
    agent: Agent,
    target: Pick<AgentLlmTarget, 'provider' | 'model'>,
    pending: CapacityState,
  ): void {
    const llm = this.ctx.get('llm') as LlmLike | undefined
    if (llm === undefined) {
      pending.status = 'ready'
      return
    }
    void Promise.resolve()
      .then(() => llm.resolveModelInfo(target.provider, target.model))
      .then(
        (resolved) => {
          if (this.capacities.get(agent)?.generation !== pending.generation) return
          const current = this.targetFor(agent)
          if (`${current.provider}\u0000${current.model}` !== pending.routeKey) return
          pending.status = 'ready'
          if (resolved.context !== undefined) pending.contextWindow = resolved.context.contextWindow
          this.onCapacityResolved(agent)
        },
        () => {
          if (this.capacities.get(agent)?.generation === pending.generation) pending.status = 'ready'
        },
      )
  }
}
