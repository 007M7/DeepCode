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
  routeKey: string | undefined
  generation: number
  status: 'pending' | 'ready'
  contextWindow?: number
}

type CapacityTarget = Pick<AgentLlmTarget, 'provider' | 'model'>

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

function routeKeyFor(target: CapacityTarget | undefined): string | undefined {
  return target === undefined ? undefined : `${target.provider}\u0000${target.model}`
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
   * @param targetFor - side-effect-free selected or logged route lookup for one attached agent.
   * @param onCapacityResolved - schedules a fresh live projection after exact-route metadata resolves.
   */
  constructor(
    private readonly ctx: Context,
    private readonly targetFor: (agent: Agent) => CapacityTarget | undefined,
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
    const routeKey = routeKeyFor(target)
    let state = this.capacities.get(agent)
    if (state === undefined || state.routeKey !== routeKey) {
      state = {
        routeKey,
        generation: (state?.generation ?? 0) + 1,
        status: target === undefined ? 'ready' : 'pending',
      }
      this.capacities.set(agent, state)
      if (target !== undefined) this.resolveCapacity(agent, target, state)
    }
    return state.status === 'ready' ? state.contextWindow : undefined
  }

  private resolveCapacity(
    agent: Agent,
    target: CapacityTarget,
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
          if (this.capacityResolutionIsStale(agent, pending)) return
          pending.status = 'ready'
          if (resolved.context !== undefined) pending.contextWindow = resolved.context.contextWindow
          this.onCapacityResolved(agent)
        },
        () => {
          if (!this.capacityResolutionIsStale(agent, pending)) pending.status = 'ready'
        },
      )
  }

  private capacityResolutionIsStale(agent: Agent, pending: CapacityState): boolean {
    if (this.capacities.get(agent)?.generation !== pending.generation) return true
    if (routeKeyFor(this.targetFor(agent)) === pending.routeKey) return false
    // Unknown is the neutral generation; the next observed concrete route
    // starts a fresh resolution even when it equals the route that disappeared.
    this.capacities.set(agent, {
      routeKey: undefined,
      generation: pending.generation + 1,
      status: 'ready',
    })
    return true
  }
}
