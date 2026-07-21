/**
 * Session modes: named, logged, per-agent COLLABORATION states, with **plan
 * mode** as the first shipped definition. A mode is a guidance section the
 * model sees while it is in force plus, for plan, the user-reviewed
 * `exit_plan_mode` crossing — deliberately nothing more. Modes are one axis
 * and enforcement knobs (the sandbox mode, the approval policy) are others;
 * they never read or write each other, exactly as Codex separates its
 * Plan/Default collaboration presets from its sandbox and approval settings.
 * There is likewise NO per-mode tool allow/deny list: which tools a mode
 * admits is an effects question, parked until tool definitions can declare
 * their effects (the plan-mode RFC's deferred item). The mode IN FORCE for an
 * agent is session state, folded from its log (`mode/set`, last one wins), so
 * resume and fork restore it for free.
 *
 * The default mode is the absence of policy: no section, no extra tool. An
 * agent that never sees a `mode/set` behaves byte-identically to a deployment
 * that never loads this plugin, so it is safe to compose unconditionally. The
 * exit tool's per-agent visibility rides the tool registry's scoped
 * restriction layer, so wire schemas, the Code Mode SDK section, and dispatch
 * all resolve it through the one registry view.
 *
 * User flips go through {@link ModesService.set}: every session event is
 * turn-enclosed and an idle agent has no open turn, so `set()` records a
 * pending intent and the service flushes it on the loop's interception seams
 * — `agent/prompt-submit` (inside the just-opened turn, before its first
 * assembly) and `agent/turn-continuation` (after each step closed, before the
 * next assembly) — both outside the step's tool-execution window and outside
 * any log emit (post-commit `session/event` observers are observe-only and
 * cannot append). A flush that changes what the last logged request header
 * told the model appends one coalesced `context/message` notice in the same
 * frame.
 *
 * Agent Note: .agents/notes/implemented/feature/2026-07-07-plan-mode.md
 *
 * @module @deepseek-ai/dsh-mode
 */

import { Context, Service } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-user-interaction'
// Type-only edge: resolves `ctx.commands` for the `/mode` command child below;
// the child mounts only when a commands service is composed.
import type {} from '@deepseek-ai/dsh-commands'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /**
     * The session mode in force from this point on: log-only, non-surface,
     * whole-value replace — the last `mode/set` in the log wins (see
     * {@link foldMode}). A log with none folds to {@link DEFAULT_MODE}.
     */
    'mode/set': { mode: string }
  }
}

declare module 'cordis' {
  interface Context {
    modes: ModesService
  }
}

/**
 * The mode a log with no `mode/set` folds to: the absence of policy. Reserved —
 * {@link resolveConfig} rejects it as a definition key, and {@link ModesService.set}
 * always accepts it as a target (a picker's exit-to-default is a valid write).
 */
export const DEFAULT_MODE = 'default'

/** The one shipped mode definition's name. */
export const PLAN_MODE = 'plan'

/**
 * The model-facing exit tool's name. The assemble filter shows the tool IFF the
 * folded mode is {@link PLAN_MODE}, which keeps a default-mode assembly
 * byte-identical to a deployment without this plugin even though the tool is
 * always registered.
 */
export const EXIT_PLAN_MODE = 'exit_plan_mode'

/**
 * One mode's deployment-configured policy: the guidance section the model
 * sees. Deliberately nothing else — enforcement knobs (sandbox mode, approval
 * policy) are separate axes a mode never touches, and a tool allow/deny list
 * is an effects question parked until tool definitions declare their effects.
 */
export interface ModeDefinition {
  /** Guidance text rendered as the `mode:policy` prompt section while the mode is in force. */
  section: string
}

/**
 * Plugin config: mode definitions by name. The built-in {@link PLAN_MODE}
 * definition is merged in unless overridden; {@link DEFAULT_MODE} is rejected
 * as a key ({@link resolveConfig} throws at load).
 */
export interface ModeConfig {
  /** Mode definitions by name, overriding or extending the built-in `plan`. */
  modes?: Record<string, ModeDefinition>
}

/** Validated mode definitions: the built-in `plan` merged with (or replaced by) the configured ones. */
export interface ResolvedModes {
  /** Definitions by mode name; never contains {@link DEFAULT_MODE}. */
  definitions: ReadonlyMap<string, ModeDefinition>
}

const PLAN_SECTION
  = 'You are in plan mode: a planning state. Explore, analyze, and design; reading '
  + 'files and running read-only commands is fine, but hold off on changes — edits '
  + 'and other side effects belong in the plan and run after its approval, not in '
  + 'this mode. When a decision or a missing detail blocks the plan, ask the '
  + 'user through the ask_user_question tool where it is available. A finished plan '
  + 'is delivered by calling exit_plan_mode — that call is what puts it in front of '
  + 'the user for review, so prefer it over pasting the plan as a plain reply or '
  + 'asking the user to switch modes themselves. If exit_plan_mode is unavailable or '
  + 'its review fails, ask the user to switch the session out of plan mode instead '
  + 'of pressing on.'

/** The review question's approve option label — the answer item is matched by it. */
const APPROVE_LABEL = 'Approve'

/** The review question's keep-planning option label. */
const KEEP_PLANNING_LABEL = 'Keep planning'

const EXIT_DESCRIPTION
  = 'Present your plan for the user\'s review and, on approval, leave plan mode. '
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
 * Validate the config and merge the built-in `plan` definition (explicit
 * resolve step — the `dsh-bash` request/spec template). Fail-loud: a
 * {@link DEFAULT_MODE} key or a malformed definition throws at load.
 *
 * @param config Raw plugin config.
 * @returns The validated definitions, `plan` included unless overridden.
 */
export function resolveConfig(config: ModeConfig): ResolvedModes {
  const definitions = new Map<string, ModeDefinition>()
  definitions.set(PLAN_MODE, { section: PLAN_SECTION })
  for (const [name, definition] of Object.entries(config.modes ?? {})) {
    if (name === DEFAULT_MODE) {
      throw new Error(`ModeConfig: "${DEFAULT_MODE}" is reserved (the absence of policy) and cannot be defined`)
    }
    if (typeof definition.section !== 'string') {
      throw new Error(`ModeConfig: mode "${name}" needs a string \`section\``)
    }
    // Unknown keys fail loud rather than silently shaping nothing — the
    // definition vocabulary is exactly { section }: a tool allow/deny list
    // and enforcement knobs are deliberately NOT part of it (module doc).
    const unknown = Object.keys(definition).filter(key => key !== 'section')
    if (unknown.length > 0) {
      throw new Error(`ModeConfig: mode "${name}" has unknown key(s) ${unknown.join(', ')} — a definition is { section }`)
    }
    definitions.set(name, { section: definition.section })
  }
  return { definitions }
}

/**
 * The mode in force after the first `end` events: the last `mode/set` wins,
 * a prefix with none folds to {@link DEFAULT_MODE}. Pure — exported for
 * reconstructors and tests.
 *
 * @param events The session log (or any prefix of it).
 * @param end Fold `events[0, end)`; defaults to the whole log.
 * @returns The folded mode name.
 */
export function foldMode(events: readonly SessionEvent[], end = events.length): string {
  let mode = DEFAULT_MODE
  let index = 0
  for (const event of events) {
    if (index >= end) break
    index++
    if (event.type === 'mode/set') mode = event.data.mode
  }
  return mode
}

/** The mode the last logged request header shipped under, or `undefined` before the first header. */
function modeAtLastHeader(events: readonly SessionEvent[]): string | undefined {
  let lastHeader = -1
  let index = 0
  for (const event of events) {
    if (event.type === 'request/header') lastHeader = index
    index++
  }
  if (lastHeader < 0) return undefined
  return foldMode(events, lastHeader + 1)
}

/**
 * `ctx.modes`: the session-mode service. Owns the `mode/set` vocabulary, the
 * pending-intent flush, the boundary narration, the `mode:policy` section,
 * and the exit tool's visibility rule. UIs read mode flips off
 * `session/event`; there is no live mirror.
 */
export class ModesService extends Service {
  static inject = ['tools', 'systemPrompt']

  /** Validated definitions (built-in `plan` merged unless overridden). */
  readonly resolved: ResolvedModes

  /**
   * The latest selected mode per session, awaiting its turn-boundary flush.
   * `narrate` is true for user selections (the flush appends the coalesced
   * notice when the header disagrees) and false for the exit tool's own
   * switch, which narrates through its tool result instead.
   */
  private readonly pendingIntents = new WeakMap<Session, { mode: string; narrate: boolean }>()

  /**
   * Per-agent deny-restriction disposer over the exit tool, present exactly
   * while the agent's folded mode is NOT plan. The restriction lives on
   * `agent.ctx` (the registry's scoped layer), so it fences wire schemas, the
   * Code Mode SDK section, AND dispatch through the one registry view, and it
   * unwinds with the agent. Entries die with their agents (WeakMap).
   */
  private readonly exitToolDenials = new WeakMap<Agent, () => void>()

  constructor(ctx: Context, config: ModeConfig = {}) {
    super(ctx, 'modes')
    this.resolved = resolveConfig(config)

    // Boundary flushes ride the loop's interception seams, NOT the
    // `session/event` feed: post-commit session observers are observe-only
    // (an append from one would re-enter the publishing append and be
    // contained away), while these two waterfalls fire OUTSIDE any log emit
    // and bracket exactly the boundaries the flush wants — prompt-submit
    // inside the just-opened turn before its first assembly, and
    // turn-continuation after each step closed before the next assembly (or
    // the turn's end), so a flushed mode always lands before the prompt that
    // should reflect it. Contained: a policy plugin must never block a
    // prompt or a turn; the only throw path in onBoundary is session.append
    // rejecting mid-teardown.
    ctx.on('agent/prompt-submit', (agent, _content, _source, next) => {
      try {
        this.onBoundary(agent)
      } catch (error) {
        ctx.logger.warn('dsh-mode: boundary flush failed: %o', error)
      }
      return next()
    })
    ctx.on('agent/turn-continuation', (agent, _turn, _decision, next) => {
      try {
        this.onBoundary(agent)
      } catch (error) {
        ctx.logger.warn('dsh-mode: boundary flush failed: %o', error)
      }
      return next()
    })

    // Seed the visibility restriction at creation: a fresh or resumed agent
    // outside plan must not advertise (or dispatch) the exit tool. A throw
    // here is a structural bug in this plugin, not a policy outcome, so it
    // stays loud (it vetoes the creation, matching fail-loud misconfiguration).
    ctx.on('agent/created', (agent) => {
      this.syncExitToolVisibility(agent)
    })

    ctx.systemPrompt.section({
      name: 'mode:policy',
      order: 50,
      text: context => (context.agent === undefined ? '' : this.activeDefinition(context.agent.session)?.definition.section ?? ''),
    })

    // The `/mode` command (show or switch the session mode) for interactive
    // front doors, mounted only when a commands service is composed — the
    // child plugin below activates on `ctx.commands` availability, so a
    // commands-less deployment composes dsh-mode unchanged.
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        name: 'mode',
        description: 'Show or switch the session mode',
        input: { hint: '[name]' },
        handler: ({ agent, rawInput }) => {
          const target = rawInput.trim()
          if (target === '') {
            const { current, pending } = this.get(agent)
            const pendingNote = pending === undefined ? '' : ` (pending: ${pending})`
            return { kind: 'success', text: `mode: ${current}${pendingNote} — available: ${this.list().join(', ')}` }
          }
          try {
            this.set(agent, target)
            return { kind: 'success', text: `mode → ${target} (applies from the next turn)` }
          } catch (error) {
            // ModesService.set throws only Error (its unknown-name validation).
            return { kind: 'error', text: (error as Error).message }
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
      execute: async (_args, exec) => {
        const agent = exec.agent
        if (agent === undefined) throw new Error(`${EXIT_PLAN_MODE} requires a calling agent (no session to switch)`)
        if (this.activeDefinition(agent.session)?.name !== PLAN_MODE) {
          throw new Error(`${EXIT_PLAN_MODE} is only available in plan mode`)
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
            options: [
              { label: APPROVE_LABEL, description: 'Leave plan mode; the plan is carried out from the next step.' },
              { label: KEEP_PLANNING_LABEL, description: 'Stay in plan mode; feedback goes back to the model.' },
            ],
          }],
          agent,
          ...exec.signal ? { signal: exec.signal } : {},
        })
        const item = answer.answers.find(entry => entry.id === 'plan-review')
        if (!item?.selected.includes(APPROVE_LABEL)) {
          // A custom-text-only answer is feedback, not consent — approval is
          // exactly the approve option (an unknown selection never exits).
          const feedback = item?.custom ?? ''
          throw new Error(feedback === ''
            ? 'The user chose to keep planning; revise the plan and present it again.'
            : `The user chose to keep planning; their feedback: ${feedback}`)
        }
        // A boundary-applied switch, NOT a direct append: the loop may still
        // execute further tool calls from the SAME assistant response after
        // this one, and they were requested under the plan-shaped header — so
        // the plan surface (the section, the exit tool's visibility) keeps
        // holding for that whole batch. The flush at this step's end appends
        // the mode/set (still in-turn), so the next step's assembly reflects
        // the exit; narrate: false — this result IS the narration.
        this.pendingIntents.set(agent.session, { mode: DEFAULT_MODE, narrate: false })
        const note = item.custom === undefined || item.custom === '' ? '' : ` User note: ${item.custom}`
        return [{ type: 'text', text: `Plan approved — plan mode exited; carry out the plan starting with your next step.${note}` }]
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
   * The selectable mode vocabulary: {@link DEFAULT_MODE} first, then the
   * configured definitions — the list a mode picker advertises.
   *
   * @returns Mode names, `default` first.
   */
  list(): string[] {
    return [DEFAULT_MODE, ...this.resolved.definitions.keys()]
  }

  /**
   * The agent's mode state: the folded mode in force (a folded name the config
   * no longer defines reads as {@link DEFAULT_MODE}) plus the pending
   * user-selected intent awaiting its boundary flush, when one exists.
   *
   * @param agent The agent to read.
   * @returns The current (effective) mode and the pending intent, if any.
   */
  get(agent: Agent): { current: string; pending?: string } {
    const current = this.activeDefinition(agent.session)?.name ?? DEFAULT_MODE
    const pending = this.pendingIntents.get(agent.session)
    return pending === undefined ? { current } : { current, pending: pending.mode }
  }

  /**
   * Select the agent's mode. Validates the name against {@link list} (loud on
   * unknown; `default` is always a valid target), drops a no-op (target equals
   * the pending intent, else the current fold), and otherwise records a
   * pending intent flushed as a `mode/set` at the next turn boundary.
   *
   * @param agent The agent to switch.
   * @param mode The target mode name.
   */
  set(agent: Agent, mode: string): void {
    if (mode !== DEFAULT_MODE && !this.resolved.definitions.has(mode)) {
      throw new Error(`unknown mode "${mode}" — available modes: ${this.list().join(', ')}`)
    }
    const session = agent.session
    const target = this.pendingIntents.get(session)?.mode ?? this.get(agent).current
    if (mode === target) return
    this.pendingIntents.set(session, { mode, narrate: true })
  }

  /** The folded mode's definition, or `undefined` for the default mode and for a folded name the config no longer defines. */
  private activeDefinition(session: Session): { name: string; definition: ModeDefinition } | undefined {
    const name = foldMode(session.events)
    if (name === DEFAULT_MODE) return undefined
    const definition = this.resolved.definitions.get(name)
    if (definition === undefined) return undefined
    return { name, definition }
  }

  /**
   * One boundary pass: flush the pending intent — append the `mode/set`
   * (skipped when the fold already matches: a net-zero flip sequence) and the
   * one coalesced notice when the flushed mode differs from what the last
   * logged request header told the model — then reconcile the exit tool's
   * visibility with the (possibly changed) fold. Idempotent per boundary, so
   * the per-message prompt-submit dispatches of one batch flush once.
   */
  private onBoundary(agent: Agent): void {
    const session = agent.session
    try {
      const pending = this.pendingIntents.get(session)
      if (pending === undefined) return
      const target = pending.mode
      if (target === foldMode(session.events)) {
        this.pendingIntents.delete(session)
        return
      }
      session.append('mode/set', { mode: target })
      // Clear the intent only AFTER the append landed: if a backend rejects the
      // write, the intent stays parked and the next boundary retries — the UI's
      // optimistic picker state and the log re-converge instead of diverging
      // forever on a swallowed one-shot.
      this.pendingIntents.delete(session)
      if (!pending.narrate) return
      const told = modeAtLastHeader(session.events)
      if (told === undefined || told === target) return
      const text = target === DEFAULT_MODE
        ? 'The user switched this session back to the default mode.'
        : `The user switched this session to ${target} mode.`
      session.append('context/message', {
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'mode' },
      }, { surfaceOp: 'append' })
    } finally {
      // Reconcile even when the flush threw or nothing was pending: a foreign
      // writer (a test, a future plugin) may have appended `mode/set` directly,
      // and the fold — not the intent — is what visibility must track.
      this.syncExitToolVisibility(agent)
    }
  }

  /**
   * Make the exit tool's registry visibility match the agent's folded mode:
   * outside plan a scoped deny restriction on `agent.ctx` hides it from wire
   * schemas, the Code Mode SDK section, and dispatch (an invisible tool
   * reports `UNKNOWN_TOOL`), which keeps a default-mode agent byte-identical
   * to a no-dsh-mode deployment; entering plan disposes the restriction.
   * Idempotent — boundaries that change nothing install or dispose nothing.
   */
  private syncExitToolVisibility(agent: Agent): void {
    const inPlan = this.activeDefinition(agent.session)?.name === PLAN_MODE
    const denial = this.exitToolDenials.get(agent)
    if (inPlan) {
      if (denial === undefined) return
      this.exitToolDenials.delete(agent)
      denial()
      return
    }
    if (denial !== undefined) return
    this.exitToolDenials.set(agent, agent.ctx.tools.restrict({ deny: [EXIT_PLAN_MODE] }))
  }
}

export default ModesService
