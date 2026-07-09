/**
 * Session modes: named, logged, per-agent policy states, with **plan mode** as
 * the first shipped definition. A mode names which tools stay visible (the
 * soft layer, a `system-prompt/assemble` filter plus a guidance section) and
 * which may run (the hard layer, a deny-by-default `tools/pre-execute` gate);
 * the mode IN FORCE for an agent is session state, folded from its log
 * (`mode/set`, last one wins), so resume and fork restore it for free.
 *
 * The default mode is the absence of policy: no section, no filtering, no
 * gate. An agent that never sees a `mode/set` behaves byte-identically to a
 * deployment that never loads this plugin, so it is safe to compose
 * unconditionally.
 *
 * User flips go through {@link ModesService.set}: every session event is
 * turn-enclosed and an idle agent has no open turn, so `set()` records a
 * pending intent and the service flushes it at the next boundary
 * (`turn/start` / `step/end` — both outside the step's tool-execution window).
 * A flush that changes what the last logged request header told the model
 * appends one coalesced `context/message` notice in the same frame.
 *
 * RFC: docs/rfc/proposed/feature/2026-07-07-plan-mode.md
 *
 * @module @deepseek-ai/dsh-mode
 */

import { Context, Service } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-user-interaction'

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

declare module '@deepseek-ai/dsh-agent' {
  interface AgentOptions {
    /**
     * Initial session mode for this agent. Applied as a pending intent flushed
     * at the first turn boundary; an explicit option beats the logged baseline
     * on create AND resume. An unknown name throws at agent creation.
     */
    mode?: string
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
 * One mode's deployment-configured policy: the guidance section the model sees
 * and the allowlist of tool names that stay visible and executable.
 */
export interface ModeDefinition {
  /** Guidance text rendered as the `mode:policy` prompt section while the mode is in force. */
  section: string
  /** Allowlist of tool NAMES; names may reference not-yet-registered tools (registration is dynamic). */
  tools: string[]
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
  = 'You are in plan mode: a read-only planning state. Explore, analyze, and design; '
  + 'do not attempt to modify anything — mutating tools are not available and calls '
  + 'to them are denied. When your plan is ready, present it with the exit_plan_mode '
  + 'tool and wait for the user\'s review. If exit_plan_mode is unavailable or its '
  + 'review fails, ask the user to switch the session out of plan mode instead of '
  + 'retrying denied tools.'

const PLAN_TOOLS = ['read', 'todo_write', 'web_search', 'web_fetch', EXIT_PLAN_MODE]

/** The review question's approve option label — the answer item is matched by it. */
const APPROVE_LABEL = 'Approve'

/** The review question's keep-planning option label. */
const KEEP_PLANNING_LABEL = 'Keep planning'

const EXIT_DESCRIPTION
  = 'Present your plan for the user\'s review and, on approval, leave plan mode. '
  + 'Send the COMPLETE plan as markdown, starting with a # heading that names it. '
  + 'The user may approve (the full toolset returns on your next step) or keep '
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
  definitions.set(PLAN_MODE, { section: PLAN_SECTION, tools: [...PLAN_TOOLS] })
  for (const [name, definition] of Object.entries(config.modes ?? {})) {
    if (name === DEFAULT_MODE) {
      throw new Error(`ModeConfig: "${DEFAULT_MODE}" is reserved (the absence of policy) and cannot be defined`)
    }
    if (typeof definition.section !== 'string') {
      throw new Error(`ModeConfig: mode "${name}" needs a string \`section\``)
    }
    if (!Array.isArray(definition.tools) || definition.tools.some(tool => typeof tool !== 'string')) {
      throw new Error(`ModeConfig: mode "${name}" needs a \`tools\` array of tool names`)
    }
    definitions.set(name, { section: definition.section, tools: [...definition.tools] })
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
    if (event.type === 'request/header' || event.type === 'request/header-delta') lastHeader = index
    index++
  }
  if (lastHeader < 0) return undefined
  return foldMode(events, lastHeader + 1)
}

/**
 * `ctx.modes`: the session-mode service. Owns the `mode/set` vocabulary, the
 * pending-intent flush, the boundary narration, and both policy layers (the
 * assemble filter + `mode:policy` section, and the `tools/pre-execute` gate).
 * UIs read mode flips off `session/event`; there is no live mirror.
 */
export class ModesService extends Service {
  static inject = ['tools', 'systemPrompt']

  /** Validated definitions (built-in `plan` merged unless overridden). */
  readonly resolved: ResolvedModes

  /** The latest user-selected mode per session, awaiting its turn-boundary flush. */
  private readonly pendingIntents = new WeakMap<Session, string>()

  /** The unknown folded-mode name already narrated per session (once per name). */
  private readonly droppedNoticed = new WeakMap<Session, string>()

  constructor(ctx: Context, config: ModeConfig = {}) {
    super(ctx, 'modes')
    this.resolved = resolveConfig(config)

    ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/start' && event.type !== 'step/end') return
      try {
        this.onBoundary(session, event.type === 'turn/start')
      } catch (error) {
        // Contained (a policy plugin must never kill the session feed): the only
        // throw path in onBoundary is session.append rejecting mid-teardown.
        ctx.logger.warn('dsh-mode: boundary flush failed: %o', error)
      }
    })

    ctx.on('agent/created', (agent) => {
      const seed = agent.options.mode
      if (seed === undefined) return
      this.set(agent, seed)
    })

    ctx.systemPrompt.section({
      name: 'mode:policy',
      order: 50,
      text: context => (context.agent === undefined ? '' : this.activeDefinition(context.agent.session)?.definition.section ?? ''),
    })

    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const result = await next()
      const agent = context.agent
      if (agent === undefined) return result
      const active = this.activeDefinition(agent.session)
      if (active === undefined) {
        result.tools = result.tools.filter(tool => tool.name !== EXIT_PLAN_MODE)
        return result
      }
      const allowed = new Set(active.definition.tools)
      result.tools = result.tools.filter(tool =>
        allowed.has(tool.name) && (tool.name !== EXIT_PLAN_MODE || active.name === PLAN_MODE))
      return result
    })

    ctx.on('tools/pre-execute', (exec, next): Promise<PreToolDecision> => {
      if (exec.agent === undefined) return next()
      const active = this.activeDefinition(exec.agent.session)
      if (active === undefined) return next()
      if (active.definition.tools.includes(exec.name)) return next()
      const reason = active.name === PLAN_MODE
        ? `tool "${exec.name}" is not available in plan mode; continue planning and present your plan with ${EXIT_PLAN_MODE} when ready`
        : `tool "${exec.name}" is not available in "${active.name}" mode`
      return Promise.resolve({ kind: 'deny', reason })
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
              { label: APPROVE_LABEL, description: 'Leave plan mode; the full toolset returns on the next step.' },
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
        agent.session.append('mode/set', { mode: DEFAULT_MODE })
        const note = item.custom === undefined || item.custom === '' ? '' : ` User note: ${item.custom}`
        return [{ type: 'text', text: `Plan approved — plan mode exited; the full toolset returns on your next step.${note}` }]
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
    return pending === undefined ? { current } : { current, pending }
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
    const target = this.pendingIntents.get(session) ?? this.get(agent).current
    if (mode === target) return
    this.pendingIntents.set(session, mode)
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
   * One turn-boundary pass: narrate a folded mode the config dropped (once per
   * name, turn starts only), then flush the pending intent — append the
   * `mode/set` (skipped when the fold already matches: a net-zero flip
   * sequence) and the one coalesced notice when the flushed mode differs from
   * what the last logged request header told the model.
   */
  private onBoundary(session: Session, turnStart: boolean): void {
    if (turnStart) this.noticeDroppedDefinition(session)
    const target = this.pendingIntents.get(session)
    if (target === undefined) return
    this.pendingIntents.delete(session)
    if (target === foldMode(session.events)) return
    session.append('mode/set', { mode: target })
    const told = modeAtLastHeader(session.events)
    if (told === undefined || told === target) return
    const text = target === DEFAULT_MODE
      ? 'The user switched this session back to the default mode.'
      : `The user switched this session to ${target} mode.`
    session.append('context/message', {
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'mode' },
    }, { surfaceOp: 'append' })
  }

  /** Narrate a folded mode name the current config no longer defines — the session reads as default plus this one notice. */
  private noticeDroppedDefinition(session: Session): void {
    const name = foldMode(session.events)
    if (name === DEFAULT_MODE || this.resolved.definitions.has(name)) return
    if (this.droppedNoticed.get(session) === name) return
    this.droppedNoticed.set(session, name)
    session.append('context/message', {
      content: [{ type: 'text', text: `Mode "${name}" is no longer defined in this deployment's configuration; the session continues in the default mode.` }],
      source: { kind: 'plugin', plugin: 'mode' },
    }, { surfaceOp: 'append' })
  }
}

export default ModesService
