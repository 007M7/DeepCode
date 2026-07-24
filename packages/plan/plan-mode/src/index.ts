/**
 * Plan mode is logged per-agent collaboration state: while active, a
 * deployment-owned guidance section shapes each model request, and
 * `exit_plan_mode` presents the completed plan for user review, while the
 * `/plan off` command lets a user leave directly. Plan mode is independent of
 * sandbox mode and approval policy; those enforcement axes do not read or
 * write plan state.
 *
 * The state in force is folded from the session log (`plan/mode`, last one
 * wins), so resume and fork restore it without a live mirror. User selections
 * are held as pending intent until a turn boundary because every session event
 * is turn-enclosed. The service flushes before the affected request assembly
 * on prompt submission, ordinary continuation, and request-recovery retry.
 *
 * The exit tool remains registered while plan mode is inactive so crossing a
 * boundary changes only the prompt section, not the request tool catalog.
 *
 * Agent Notes:
 * - .agents/notes/implemented/feature/2026-07-07-plan-mode.md
 * - .agents/notes/implemented/simplification/2026-07-22-plan-specific-collaboration-state.md
 *
 * @module @deepseek-ai/dsh-plan-mode
 */

import { Context, Service } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-user-interaction'
// Type-only edge: resolves `ctx.commands` for the optional command child.
import type {} from '@deepseek-ai/dsh-commands'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /**
     * Whether plan mode is in force from this point on: log-only, non-surface,
     * whole-value replace. The last `plan/mode` wins; a log with none folds to
     * inactive through {@link foldPlanMode}.
     */
    'plan/mode': { active: boolean }
  }
}

declare module 'cordis' {
  interface Context {
    planMode: PlanModeService
  }
}

/**
 * The model-facing exit tool's name. It stays registered while plan mode is
 * inactive so the request tool catalog is stable across transitions.
 */
export const EXIT_PLAN_MODE = 'exit_plan_mode'

/** Deployment-owned plan guidance. */
export interface PlanModeConfig {
  /** Guidance rendered as the `plan:policy` prompt section while plan mode is active. */
  section: string
}

/** The review question's approve option label. */
const APPROVE_LABEL = 'Approve'

/** The review question's keep-planning option label. */
const KEEP_PLANNING_LABEL = 'Keep planning'

const EXIT_DESCRIPTION
  = 'Use only in plan mode. Present your plan for the user\'s review and, on approval, leave plan mode. '
  + 'Send the COMPLETE plan as markdown, starting with a # heading that names it. '
  + 'The user may approve (carry out the plan from your next step) or keep '
  + 'planning — their feedback comes back in the tool result; revise and present again.'

/** The plan's first markdown heading (any level), or `undefined` when it has none. */
function firstHeading(plan: string): string | undefined {
  for (const line of plan.split('\n')) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (match) return match[1]
  }
  return undefined
}

/**
 * Validate deployment-owned plan guidance. Missing, blank, non-string, or
 * unknown fields fail at plugin load rather than silently shaping nothing.
 *
 * @param config Raw plugin config.
 * @returns A detached validated config.
 */
export function resolveConfig(config: PlanModeConfig): PlanModeConfig {
  const section = (config as Partial<PlanModeConfig>).section
  if (typeof section !== 'string') {
    throw new Error('PlanModeConfig needs a string `section`')
  }
  if (section.trim() === '') {
    throw new Error('PlanModeConfig needs a non-empty `section`')
  }
  const unknown = Object.keys(config).filter(key => key !== 'section')
  if (unknown.length > 0) {
    throw new Error(`PlanModeConfig has unknown key(s) ${unknown.join(', ')} — config is { section }`)
  }
  return { section }
}

/**
 * Whether plan mode is active after the first `end` events. The last
 * `plan/mode` wins; a prefix with none is inactive.
 *
 * @param events The session log or any prefix of it.
 * @param end Fold `events[0, end)`; defaults to the whole log.
 * @returns Whether plan mode is active.
 */
export function foldPlanMode(events: readonly SessionEvent[], end = events.length): boolean {
  let active = false
  let index = 0
  for (const event of events) {
    if (index >= end) break
    index++
    if (event.type === 'plan/mode') active = event.data.active
  }
  return active
}

/** Plan state at the last logged request header, or `undefined` before the first header. */
function planModeAtLastHeader(events: readonly SessionEvent[]): boolean | undefined {
  let lastHeader = -1
  let index = 0
  for (const event of events) {
    if (event.type === 'request/header') lastHeader = index
    index++
  }
  if (lastHeader < 0) return undefined
  return foldPlanMode(events, lastHeader + 1)
}

/**
 * `ctx.planMode`: owns logged plan state, boundary application and narration,
 * the `plan:policy` section, the `/plan` command, and the stable exit tool.
 * UIs observe committed flips through `session/event`; there is no live mirror.
 */
export class PlanModeService extends Service {
  static inject = ['tools', 'systemPrompt']

  /** Validated deployment-owned guidance. */
  private readonly section: string

  /**
   * Latest selection per session awaiting a turn-boundary flush. `narrate` is
   * true for user selections and false for the exit tool, whose result already
   * narrates the transition.
   */
  private readonly pendingIntents = new WeakMap<Session, { active: boolean; narrate: boolean }>()

  constructor(ctx: Context, config: PlanModeConfig = { section: '' }) {
    super(ctx, 'planMode')
    this.section = resolveConfig(config).section
    let disposed = false

    // Boundary flushes use loop interception seams, not post-commit
    // `session/event` observation. Flush after next(): a selection arriving
    // while a downstream async listener awaits must still shape the request
    // this boundary precedes. Failures are contained so policy cannot block a
    // prompt or turn; a failed append remains pending for a later boundary.
    const flushAfter = async <T>(agent: Agent, next: () => Promise<T>): Promise<T> => {
      const decision = await next()
      if (!disposed) {
        try {
          this.onBoundary(agent)
        } catch (error) {
          ctx.logger.warn('dsh-plan-mode: boundary flush failed: %o', error)
        }
      }
      return decision
    }
    ctx.on('agent/prompt-submit', (agent, _content, _source, _signal, next) =>
      flushAfter(agent, next), { prepend: true })
    ctx.on('agent/turn-continuation', (agent, _turn, _decision, _signal, next) =>
      flushAfter(agent, next), { prepend: true })
    ctx.on('agent/request-error', async (
      agent,
      _turn,
      _step,
      _error,
      _failure,
      _priorFailures,
      _signal,
      next,
    ) => {
      const decision = await next()
      // A waterfall can retain this wrapper after Cordis unregisters it.
      if (disposed || decision.action !== 'retry') return decision
      try {
        this.onBoundary(agent)
      } catch (error) {
        ctx.logger.warn('dsh-plan-mode: boundary flush failed: %o', error)
      }
      return decision
    }, { prepend: true })
    ctx.effect(() => () => { disposed = true }, 'dsh-plan-mode: close boundary lifetime')

    ctx.systemPrompt.section({
      name: 'plan:policy',
      order: 50,
      text: context => context.agent !== undefined && foldPlanMode(context.agent.session.events)
        ? this.section
        : '',
    })

    // The command child activates only when a command registry is composed.
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        name: 'plan',
        description: 'Enter or leave plan mode',
        input: { hint: '[off|message]' },
        handler: ({ agent, rawInput }) => {
          const message = rawInput.trim()
          if (message === 'off') {
            const state = this.get(agent)
            this.set(agent, false)
            if (state.active) {
              return { kind: 'success', text: 'Leaving plan mode (applies from the next step).' }
            }
            if (state.pending === true) {
              return { kind: 'success', text: 'Plan mode entry cancelled.' }
            }
            return { kind: 'success', text: 'Plan mode is already inactive.' }
          }
          this.set(agent, true)
          if (message !== '') agent.steer([{ type: 'text', text: message }])
          return {
            kind: 'success',
            text: 'Entering plan mode (applies from the next step). Use /plan off to leave.',
          }
        },
      })
    })

    ctx.tools.register(defineTool({
      name: EXIT_PLAN_MODE,
      description: EXIT_DESCRIPTION,
      parameters: {
        plan: { type: 'string', required: true, description: 'The complete plan, as markdown, starting with a # heading that names it.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            approved: { type: 'boolean', const: true, required: true },
          },
        },
        render: () => [{ type: 'text', text: 'Plan approved — plan mode exited; carry out the plan starting with your next step.' }],
      },
      execute: async (args, exec) => {
        const agent = exec.agent
        if (agent === undefined) throw new Error(`${EXIT_PLAN_MODE} requires a calling agent (no session to switch)`)
        if (!foldPlanMode(agent.session.events)) {
          throw new Error(`${EXIT_PLAN_MODE} is only available in plan mode`)
        }
        if (!/^#\s+\S/.test(args.plan.trim())) {
          throw new Error(`${EXIT_PLAN_MODE} requires a non-empty markdown plan starting with a # heading`)
        }
        const interaction = ctx.get('userInteraction')
        if (interaction === undefined) {
          throw new Error('no user-interaction channel is available to review the plan; ask the user to switch the session mode instead')
        }
        const answer = await interaction.ask({
          questions: [{
            id: 'plan-review',
            header: 'Plan review',
            question: 'Approve this plan and leave plan mode?',
            detail: args.plan,
            options: [
              { label: APPROVE_LABEL, description: 'Leave plan mode; the plan is carried out from the next step.' },
              { label: KEEP_PLANNING_LABEL, description: 'Stay in plan mode; feedback goes back to the model.' },
            ],
          }],
          agent,
          signal: exec.signal,
        })
        // A review may outlive this plugin fiber. Without boundary listeners,
        // an approved result could never land, so fail and keep planning.
        if (disposed) {
          throw new Error('the plan-mode service was reloaded while the plan was under review; present the plan again')
        }
        const reviewItems = answer.answers.filter(entry => entry.id === 'plan-review')
        const item = reviewItems.length === 1 ? reviewItems[0] : undefined
        if (item?.selected.length !== 1 || item.selected[0] !== APPROVE_LABEL || item.custom !== undefined) {
          const feedback = item?.custom ?? ''
          throw new Error(feedback === ''
            ? 'The user chose to keep planning; revise the plan and present it again.'
            : `The user chose to keep planning; their feedback: ${feedback}`)
        }
        // Keep plan guidance for the rest of this assistant tool batch. The
        // silent intent flushes after the step, before the next assembly.
        this.pendingIntents.set(agent.session, { active: false, narrate: false })
        return { approved: true }
      },
      presentCall: args => ({
        card: 'generic',
        title: firstHeading(args.plan) ?? 'Plan',
        kind: 'other',
        content: [{ type: 'text', text: args.plan }],
      }),
      presentResult: (_args, result) => ({
        card: 'generic',
        title: 'Plan review',
        content: result.content,
      }),
    }))
  }

  /**
   * Read the logged plan state and any selected state awaiting a boundary.
   *
   * @param agent The agent to read.
   * @returns Current logged state plus a pending selection, when present.
   */
  get(agent: Agent): { active: boolean; pending?: boolean } {
    const active = foldPlanMode(agent.session.events)
    const pending = this.pendingIntents.get(agent.session)
    return pending === undefined ? { active } : { active, pending: pending.active }
  }

  /**
   * Select whether plan mode should be active from the next turn boundary.
   * Repeated selection of the current or already-pending state is a no-op.
   *
   * @param agent The agent to switch.
   * @param active Whether plan mode should be active.
   */
  set(agent: Agent, active: boolean): void {
    const session = agent.session
    const target = this.pendingIntents.get(session)?.active ?? foldPlanMode(session.events)
    if (active === target) return
    this.pendingIntents.set(session, { active, narrate: true })
  }

  /** Flush one pending selection before the next request assembly. */
  private onBoundary(agent: Agent): void {
    const session = agent.session
    const pending = this.pendingIntents.get(session)
    if (pending === undefined) return
    const target = pending.active
    if (target === foldPlanMode(session.events)) {
      this.pendingIntents.delete(session)
      return
    }
    session.append('plan/mode', { active: target })
    // Delete only after append succeeds so a later boundary can retry a failed
    // durable write.
    this.pendingIntents.delete(session)
    if (!pending.narrate) return
    const told = planModeAtLastHeader(session.events)
    if (told === undefined || told === target) return
    const text = target
      ? 'The user switched this session to plan mode.'
      : 'The user switched this session back to the default mode.'
    session.append('user/message', {
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'plan-mode' },
    }, { surfaceOp: 'append' })
  }
}

export default PlanModeService
