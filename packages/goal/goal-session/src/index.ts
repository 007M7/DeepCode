/**
 * Same-session goal-round driver over public agent, session, and goal seams.
 * @module @deepseek-ai/dsh-goal-session
 */

import { isDeepStrictEqual } from 'node:util'
import { FiberState } from 'cordis'
import type { Context } from 'cordis'
import type { Agent, PromptDecision } from '@deepseek-ai/dsh-agent'
import type { GoalMessageSource, GoalRef, GoalView } from '@deepseek-ai/dsh-goal'
import { createUserMessage, assertNever } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import { classifyGoalRound } from './outcome.ts'
import type { GoalRoundOutcome } from './outcome.ts'
import { renderGoalRoundPrompt } from './prompt.ts'

export { classifyGoalRound } from './outcome.ts'
export type { GoalRoundOutcome } from './outcome.ts'
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

/** One queued or admitted attempt, retained until its physical turn settles. */
interface RoundAttempt extends RoundIdentity {
  readonly content: ContentBlock[]
  phase: 'queued' | 'admitted'
  turn: number | undefined
  reason: TurnEndReason | undefined
  stale: boolean
}

/** Serialized process-local scheduling state for one exact Agent lifecycle. */
interface DriverState {
  readonly agent: Agent
  attempt: RoundAttempt | undefined
  openTurn: number | undefined
  competingQueued: boolean
  needsCheckpoint: boolean
  requested: boolean
  run: Promise<void> | undefined
  stopping: boolean
  readonly flushFailedTurns: Set<number>
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
      openTurn: undefined,
      competingQueued: false,
      needsCheckpoint: false,
      requested: false,
      run: undefined,
      stopping: false,
      flushFailedTurns: new Set(),
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

  /** Apply one closed-round outcome only to the exact still-current revision. */
  function applyOutcome(state: DriverState, goal: GoalView, outcome: GoalRoundOutcome): void {
    const ref = goalRef(goal)
    switch (outcome.kind) {
      case 'continue':
        return
      case 'pause':
        ctx.goals.pause(state.agent, ref)
        return
      case 'blocked':
        ctx.goals.block(state.agent, ref, { code: outcome.code, message: outcome.message })
        return
      case 'disarm':
        ctx.goals.disarm(state.agent)
        return
      /* v8 ignore next 2 -- GoalRoundOutcome is closed and every member is handled above */
      default:
        assertNever(outcome, 'goal round outcome')
    }
  }

  /** Process a settled attempt, then reserve at most one next round. */
  async function drive(state: DriverState): Promise<void> {
    const { agent } = state
    if (!readyToDrive(state)) return

    if (state.needsCheckpoint) {
      state.needsCheckpoint = false
      try {
        await ctx.sessions.flush(agent.session)
      } catch (error: unknown) {
        ctx.logger.warn(`goal-session: durability checkpoint failed for agent "${agent.id}": ${renderThrown(error)}`)
        const goal = currentGoal(state)
        if (goal !== undefined) applyOutcome(state, goal, { kind: 'disarm', reason: 'durability-failed' })
        return
      }
      // A mutation or ordinary prompt may have arrived while the checkpoint
      // was settling. Give it its own checkpoint / turn before reserving.
      if (!readyAfterCheckpoint(state)) return
    }

    const attempt = state.attempt
    if (attempt !== undefined) {
      // Still unsettled: a contained turn-close failure reaches idle with the
      // attempt's turn open in the log and no terminal reason recorded, so
      // the drive pass must yield rather than misread it as settled.
      if (attempt.reason === undefined) return
      state.attempt = undefined
      const turn = attempt.turn
      /* v8 ignore next -- a closed attempt acquired its turn at turn/start */
      if (turn === undefined) throw new Error('settled goal-round attempt lacks a turn')
      const durable = !state.flushFailedTurns.delete(turn)
      const goal = currentGoal(state)
      if (goal !== undefined && goal.id === attempt.goalId && goal.revision === attempt.revision
        && goal.phase === 'active' && goal.activation === 'armed') {
        const outcome = classifyGoalRound(attempt.reason, durable)
        if (!attempt.stale) applyOutcome(state, goal, outcome)
      }
      if (!readyToDrive(state)) return
      // The loop's persistence is eager write-behind with no turn-end flush,
      // so this driver owns the round's durability barrier: checkpoint the
      // settled round before reserving another (re-entering drive through
      // the flush path above), disarming on failure instead of queueing an
      // autonomous round on state that was never persisted.
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
    const reservation: RoundAttempt = {
      goalId: goal.id,
      revision: goal.revision,
      round,
      content,
      phase: 'queued',
      turn: undefined,
      reason: undefined,
      stale: false,
    }
    state.attempt = reservation
    try {
      agent.followup(createUserMessage({ content, source: { kind: 'goal', goalId: goal.id, revision: goal.revision, round } }))
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

  // One composite effect owns every listener and the quiescent close. Cordis
  // unloads sibling effects concurrently; nesting makes the close run first
  // and keeps the admission fence installed until its drain settles.
  ctx.effect(function* () {
    /** Mark a post-turn persistence failure before idle scheduling can run. */
    ctx.on('agent/error', (agent, turn) => {
      const state = stateFor(agent)
      const closed = agent.session.events.some(event => event.type === 'turn/end' && event.data.turn === turn)
      if (!closed) return
      if (state.attempt?.turn === turn) state.flushFailedTurns.add(turn)
      disarm(state)
    })

    ctx.on('agent/created', (agent) => { stateFor(agent) })
    ctx.on('agent/disposed', (agent) => { states.delete(agent) })
    ctx.on('agent/session-start', (agent) => {
      const state = stateFor(agent)
      state.attempt = undefined
      state.openTurn = undefined
      state.competingQueued = false
      state.needsCheckpoint = false
      state.flushFailedTurns.clear()
    })
    ctx.on('agent/status', (agent, status) => {
      const state = stateFor(agent)
      if (status === 'idle') {
        state.competingQueued = false
        requestDrive(state)
      }
    })
    ctx.on('agent/inbox/enqueue', (agent, info) => {
      const state = stateFor(agent)
      const attempt = state.attempt
      if (attempt !== undefined && sameQueued(info.content, info.source, attempt)) return
      state.competingQueued = true
      if (attempt?.phase === 'queued') attempt.stale = true
    })
    ctx.on('agent/cancel-requested', (agent, cause) => {
      const state = stateFor(agent)
      const attempt = state.attempt
      state.competingQueued = false
      const goal = currentGoal(state)
      if (goal?.phase === 'active' && goal.activation === 'armed') {
        if (attempt === undefined) {
          disarm(state)
          return
        }
        // An admitted round closes durably as aborted; retain it so the normal
        // turn outcome path appends pause after cancellation reaches idle.
        // Pausing here would stage context into the active outbox only for this
        // same cancel() call to discard it.
        if (attempt.turn !== undefined || attempt.phase === 'admitted') return
        state.attempt = undefined
        try {
          applyOutcome(state, goal, { kind: 'pause', reason: cause.kind })
        } catch (error: unknown) {
          ctx.logger.warn(`goal-session: could not pause cancelled goal for agent "${agent.id}": ${renderThrown(error)}`)
          disarm(state)
        }
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
        case 'turn/start':
          state.openTurn = event.data.turn
          switch (event.data.trigger.kind) {
            case 'message':
              if (state.attempt !== undefined && isGoalRoundSource(event.data.trigger.source)
              && sameRound(event.data.trigger.source, state.attempt)) {
                state.attempt.turn = event.data.turn
              }
              return
            case 'retry':
              // A recovery policy (llm-retry) closed the round's failed turn
              // and reopened its history: the attempt rides the retry turn,
              // and the failed turn's provisional reason no longer settles
              // the round — the retry's own outcome does.
              if (state.attempt !== undefined && state.attempt.reason !== undefined
                && state.attempt.reason.kind === 'error') {
                state.attempt.turn = event.data.turn
                state.attempt.reason = undefined
              }
              return
            default:
              // Injection and merge-extensible plugin triggers cannot admit a queued goal message.
              return
          }
        case 'user/message':
          if (state.attempt !== undefined && isGoalRoundSource(event.data.source)
          && sameRound(event.data.source, state.attempt)) {
            state.attempt.phase = 'admitted'
            /* v8 ignore next -- this driver's admitted message always follows its observed turn/start */
            if (state.openTurn !== undefined) state.attempt.turn = state.openTurn
          }
          return
        case 'turn/end':
          if (state.attempt?.turn === event.data.turn) state.attempt.reason = event.data.reason
          /* v8 ignore next -- balanced live turns close the open turn just observed by this listener */
          if (state.openTurn === event.data.turn) state.openTurn = undefined
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

    ctx.on('agent/prompt-submit', async (agent, message, _signal, next): Promise<PromptDecision> => {
      const { content, source } = message
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
        }
        requestDrive(state)
        return { kind: 'block', reason: STALE_ROUND_REASON }
      }
      let decision: PromptDecision
      try {
        decision = await next()
      } catch (error: unknown) {
        // A throwing downstream hook drops the whole admission: the loop
        // returns to idle without a turn, so a still-queued reservation would
        // starve every later drive pass. Clear it and let the driver
        // reschedule the round.
        const attempt = state.attempt
        if (attempt !== undefined && sameRound(source, attempt) && attempt.turn === undefined) {
          state.attempt = undefined
          requestDrive(state)
        }
        throw error
      }
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
        }
        requestDrive(state)
        return { kind: 'block', reason: STALE_ROUND_REASON }
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
          }
          waits.push(state.agent.whenIdle())
        }
        if (state.run !== undefined) waits.push(state.run)
      }
      await Promise.allSettled(waits)
      states.clear()
    }
  }, 'goal-session lifecycle')
}
