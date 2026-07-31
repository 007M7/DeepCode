/**
 * Same-session goal-round driver over public agent, session, and goal seams.
 * @module @deepseek-ai/dsh-goal-session
 */

import { isDeepStrictEqual } from 'node:util'
import { FiberState } from 'cordis'
import type { Context } from 'cordis'
import type { Agent, PromptDecision } from '@deepseek-ai/dsh-agent'
import type { GoalMessageSource, GoalRef, GoalView } from '@deepseek-ai/dsh-goal'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageId, MessageSource } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { renderGoalRoundPrompt } from './prompt.ts'

export { renderGoalRoundPrompt } from './prompt.ts'

export const name = 'goal-session'
export const inject = ['agents', 'goals', 'sessions']

const STALE_ROUND_REASON = 'stale goal-round reservation'

/** Identity reserved before a goal continuation enters the agent inbox. */
interface RoundIdentity {
  readonly goalId: GoalRef['id']
  readonly revision: number
  readonly round: number
}

/** One queued or admitted goal message retained until whole-agent quiescence. */
interface RoundAttempt extends RoundIdentity {
  readonly messageId: MessageId
  readonly content: ContentBlock[]
  phase: 'queued' | 'admitted'
  cancelled: boolean
  stale: boolean
}

/** Serialized process-local scheduling state for one exact Agent lifecycle. */
interface DriverState {
  readonly agent: Agent
  attempt: RoundAttempt | undefined
  competingQueued: boolean
  needsCheckpoint: boolean
  requested: boolean
  run: Promise<void> | undefined
  stopping: boolean
}

/** Whether a source identifies an automatic, positive-numbered goal round. */
function isGoalRoundSource(source: MessageSource): source is GoalMessageSource {
  return source.kind === 'goal' && source.round > 0
}

/** Compare a source to one reserved identity. */
function sameRound(source: GoalMessageSource, round: RoundIdentity): boolean {
  return source.goalId === round.goalId
    && source.revision === round.revision
    && source.round === round.round
}

/** Compare the complete queued record to the driver's reservation. */
function sameQueued(content: ContentBlock[], source: MessageSource, attempt: RoundAttempt): boolean {
  return isGoalRoundSource(source) && sameRound(source, attempt) && isDeepStrictEqual(content, attempt.content)
}

/** Exact current ref for a view. */
function goalRef(goal: GoalView): GoalRef {
  return { id: goal.id, revision: goal.revision }
}

/** Human-readable unexpected values for logs. */
function renderThrown(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** Install automatic same-session continuation and its race fences. */
export function apply(ctx: Context): void {
  const states = new Map<Agent, DriverState>()

  /** Create state for an exact currently live agent. */
  function stateFor(agent: Agent): DriverState {
    const existing = states.get(agent)
    if (existing !== undefined) return existing
    const state: DriverState = {
      agent,
      attempt: undefined,
      competingQueued: false,
      needsCheckpoint: false,
      requested: false,
      run: undefined,
      stopping: false,
    }
    states.set(agent, state)
    return state
  }

  /** Read only when the exact Agent remains live. */
  function currentGoal(state: DriverState): GoalView | undefined {
    if (ctx.agents.get(state.agent.id) !== state.agent) return undefined
    return ctx.goals.get(state.agent)
  }

  /** Whether this exact lifecycle is quiescent with no competing prompt. */
  function readyToDrive(state: DriverState): boolean {
    return ctx.fiber.state === FiberState.ACTIVE
      && !state.stopping
      && ctx.agents.get(state.agent.id) === state.agent
      && state.agent.status === 'idle'
      && !state.competingQueued
  }

  /** Recheck every condition that an awaited checkpoint may have changed. */
  function readyAfterCheckpoint(state: DriverState): boolean {
    return readyToDrive(state) && !state.needsCheckpoint
  }

  /** Remove automatic authority while preserving the durable phase. */
  function disarm(state: DriverState): void {
    try {
      const goal = currentGoal(state)
      if (goal?.activation === 'armed') ctx.goals.disarm(state.agent)
    } catch (error: unknown) {
      ctx.logger.warn(`goal-session: could not disarm agent "${state.agent.id}": ${renderThrown(error)}`)
    }
  }

  /** Remove only this driver's still-pending reservation. */
  function cancelReservation(agent: Agent, attempt: RoundAttempt): void {
    const index = agent.inbox.nextTurn.findIndex(message => message.id === attempt.messageId)
    if (index >= 0) agent.inbox.splice('next-turn', index, 1, [], 'canceled')
  }

  /** Process admitted work at quiescence, then reserve at most one next round. */
  async function drive(state: DriverState): Promise<void> {
    const { agent } = state
    if (!readyToDrive(state)) return

    if (state.needsCheckpoint) {
      state.needsCheckpoint = false
      try {
        await ctx.sessions.flush(agent.session)
      } catch (error: unknown) {
        ctx.logger.warn(`goal-session: durability checkpoint failed for agent "${agent.id}": ${renderThrown(error)}`)
        disarm(state)
        return
      }
      // A mutation or ordinary prompt may have arrived while the checkpoint
      // was settling. Give it its own checkpoint / turn before reserving.
      if (!readyAfterCheckpoint(state)) return
    }

    const attempt = state.attempt
    if (attempt !== undefined) {
      if (attempt.phase === 'queued') return
      state.attempt = undefined
      state.needsCheckpoint = true
      state.requested = true
      return
    }

    const goal = currentGoal(state)
    if (goal === undefined || goal.phase !== 'active' || goal.activation !== 'armed') return
    if (goal.roundsStarted >= goal.maxGoalRounds) {
      ctx.goals.block(agent, goalRef(goal), {
        code: 'round-limit',
        message: `Goal reached its configured limit of ${goal.maxGoalRounds} rounds.`,
      })
      return
    }

    const round = goal.roundsStarted + 1
    const content = renderGoalRoundPrompt(goal, round)
    const message = createUserMessage({
      content,
      source: { kind: 'goal', goalId: goal.id, revision: goal.revision, round },
    })
    const reservation: RoundAttempt = {
      goalId: goal.id,
      revision: goal.revision,
      round,
      messageId: message.id,
      content,
      phase: 'queued',
      cancelled: false,
      stale: false,
    }
    state.attempt = reservation
    try {
      agent.followup(message)
    } catch (error: unknown) {
      state.attempt = undefined
      ctx.logger.warn(`goal-session: could not queue round ${round} for agent "${agent.id}": ${renderThrown(error)}`)
      const latest = currentGoal(state)
      if (latest !== undefined && latest.id === goal.id && latest.revision === goal.revision
        && latest.phase === 'active' && latest.activation === 'armed') {
        ctx.goals.block(agent, goalRef(latest), {
          code: 'queue-failed',
          message: `Could not queue goal round ${round}: ${renderThrown(error)}`,
        })
      }
    }
  }

  /** Coalesce triggers onto one agent-local serialized driver. */
  function requestDrive(state: DriverState): void {
    /* v8 ignore next -- teardown may race a final trigger after synchronously closing admission */
    if (state.stopping) return
    state.requested = true
    if (state.run !== undefined) return
    let run: Promise<void>
    try {
      run = ctx.agents.withoutInitiator(async () => {
        while (state.requested && !state.stopping) {
          state.requested = false
          try {
            await drive(state)
          } catch (error: unknown) {
            ctx.logger.warn(`goal-session: driver failed for agent "${state.agent.id}": ${renderThrown(error)}`)
            disarm(state)
          }
        }
      })
    } catch (error: unknown) {
      ctx.logger.warn(`goal-session: could not start driver for agent "${state.agent.id}": ${renderThrown(error)}`)
      disarm(state)
      return
    }
    state.run = run
    const retire = (): void => {
      state.run = undefined
      if (state.requested && !state.stopping) requestDrive(state)
    }
    void run.then(retire, (error: unknown) => {
      ctx.logger.warn(`goal-session: driver task rejected for agent "${state.agent.id}": ${renderThrown(error)}`)
      disarm(state)
      retire()
    })
  }

  // One composite effect keeps the admission fence installed until this
  // plugin's own scheduling tasks settle.
  ctx.effect(function* () {
    ctx.on('agent/error', (agent) => {
      const state = stateFor(agent)
      disarm(state)
    })

    ctx.on('agent/created', (agent) => { stateFor(agent) })
    ctx.on('agent/disposed', (agent) => { states.delete(agent) })
    ctx.on('agent/session-start', (agent) => {
      const state = stateFor(agent)
      state.attempt = undefined
      state.competingQueued = false
      state.needsCheckpoint = false
    })
    ctx.on('agent/status', (agent, status) => {
      const state = stateFor(agent)
      if (status === 'idle') {
        state.competingQueued = false
        const attempt = state.attempt
        const goal = currentGoal(state)
        if ((attempt?.phase === 'queued' || attempt?.cancelled)
          && goal?.phase === 'active' && goal.activation === 'armed') {
          state.attempt = undefined
          try {
            ctx.goals.pause(agent, goalRef(goal))
          } catch (error: unknown) {
            ctx.logger.warn(`goal-session: could not pause cancelled goal for agent "${agent.id}": ${renderThrown(error)}`)
            disarm(state)
          }
        }
        requestDrive(state)
      }
    })
    ctx.on('goal/changed', (agent) => {
      const state = stateFor(agent)
      state.needsCheckpoint = true
      requestDrive(state)
    })

    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      const agent = ctx.agents.get(session.id)
      if (agent === undefined || agent.session !== session) return
      const state = stateFor(agent)
      switch (event.type) {
        case 'agent/inbox/spliced': {
          if (event.data.target !== 'next-turn') return
          const attempt = state.attempt
          for (const message of event.data.inserted) {
            if (attempt !== undefined && sameQueued(message.content, message.source, attempt)) continue
            state.competingQueued = true
            if (attempt?.phase === 'queued') attempt.stale = true
          }
          return
        }
        case 'user/message':
          if (state.attempt !== undefined && event.data.id === state.attempt.messageId) {
            state.attempt.phase = 'admitted'
          }
          return
        case 'turn/end':
          if (event.data.reason.kind === 'max-tokens') {
            disarm(state)
            return
          }
          if (event.data.reason.kind !== 'aborted') return
          if (state.attempt?.phase === 'admitted') state.attempt.cancelled = true
          else disarm(state)
          return
        default:
          return
      }
    })

    /** Fail closed unless the queued prompt still owns the exact live revision. */
    function validReservation(
      state: DriverState,
      content: ContentBlock[],
      source: GoalMessageSource,
    ): boolean {
      const attempt = state.attempt
      const goal = currentGoal(state)
      return ctx.fiber.state === FiberState.ACTIVE
        && !state.stopping && attempt !== undefined && attempt.phase === 'queued'
      && !attempt.stale && sameQueued(content, source, attempt)
      && goal !== undefined && goal.id === source.goalId && goal.revision === source.revision
      && goal.phase === 'active' && goal.activation === 'armed'
      && source.round === goal.roundsStarted + 1
    }

    ctx.on('agent/prompt-submit', async (agent, messages, signal, next): Promise<PromptDecision> => {
      const submitted = messages.find(message => isGoalRoundSource(message.source))
      if (submitted === undefined) return next()
      const { content, source } = submitted
      if (!isGoalRoundSource(source)) return next()
      const state = stateFor(agent)
      let valid = false
      try {
        valid = validReservation(state, content, source)
      } catch (error: unknown) {
        ctx.logger.warn(`goal-session: admission check failed for agent "${agent.id}": ${renderThrown(error)}`)
        disarm(state)
      }
      if (!valid) {
        const attempt = state.attempt
        if (attempt !== undefined && sameRound(source, attempt)) {
          attempt.stale = true
          state.attempt = undefined
          cancelReservation(agent, attempt)
        }
        requestDrive(state)
        return { kind: 'block', reason: STALE_ROUND_REASON, keepInbox: true }
      }
      let decision: PromptDecision
      try {
        decision = await next()
      } catch (error: unknown) {
        if (signal.aborted) throw error
        // A throwing downstream hook drops the whole admission: the loop
        // returns to idle without a turn, so a still-queued reservation would
        // starve every later drive pass. Clear it and let the driver
        // reschedule the round.
        const attempt = state.attempt
        if (attempt !== undefined && sameRound(source, attempt) && attempt.phase === 'queued') {
          state.attempt = undefined
          cancelReservation(agent, attempt)
          requestDrive(state)
        }
        throw error
      }
      if (signal.aborted) return decision
      if (decision.kind === 'block') {
        const attempt = state.attempt
        if (attempt !== undefined && sameRound(source, attempt)) state.attempt = undefined
        const goal = currentGoal(state)
        if (goal !== undefined && goal.id === source.goalId && goal.revision === source.revision
          && goal.phase === 'active' && goal.activation === 'armed') {
          ctx.goals.block(agent, goalRef(goal), {
            code: 'prompt-rejected',
            message: decision.reason,
          })
        }
        return decision
      }
      try {
        valid = validReservation(state, content, source)
      } catch (error: unknown) {
        ctx.logger.warn(`goal-session: post-admission check failed for agent "${agent.id}": ${renderThrown(error)}`)
        disarm(state)
        valid = false
      }
      if (!valid) {
        const attempt = state.attempt
        if (attempt !== undefined && sameRound(source, attempt)) {
          attempt.stale = true
          state.attempt = undefined
          cancelReservation(agent, attempt)
        }
        requestDrive(state)
        return { kind: 'block', reason: STALE_ROUND_REASON, keepInbox: true }
      }
      return decision
    })

    // Loading a lifecycle driver over existing agents never inherits hidden
    // automatic authority from an earlier producer instance.
    for (const agent of ctx.agents.list()) {
      const state = stateFor(agent)
      disarm(state)
    }

    // Yielded after listener registration, so this close runs first and the
    // composite effect removes listeners only after its promise settles.
    yield async () => {
      const waits: Promise<void>[] = []
      for (const state of states.values()) {
        state.stopping = true
        disarm(state)
        const attempt = state.attempt
        if (attempt !== undefined) {
          attempt.stale = true
          if (attempt.phase === 'admitted' && state.agent.status === 'running') {
            state.agent.cancel({ kind: 'parent' })
            waits.push(state.agent.whenIdle())
          }
        }
        if (state.run !== undefined) waits.push(state.run)
      }
      await Promise.allSettled(waits)
      states.clear()
    }
  }, 'goal-session lifecycle')
}
