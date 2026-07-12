/**
 * Session modes: named, logged, per-agent policy states, with **plan mode** as
 * the first shipped definition. A mode names which tools stay visible (the
 * soft layer, a `system-prompt/assemble` filter plus a guidance section) and
 * which may run (the hard layer, a deny-by-default `tools/pre-execute` gate);
 * a mode may also declare `access` — a cap the bash seam's per-call sandbox
 * resolution is clamped to while the mode is in force (a `bash/resolve-mode`
 * listener), composing with the session's own sandbox knob without ever
 * writing it. The mode IN FORCE for an agent is session state, folded from
 * its log (`mode/set`, last one wins), so resume and fork restore it for free.
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
 * RFC: docs/rfc/implemented/feature/2026-07-07-plan-mode.md
 *
 * @module @deepseek-ai/dsh-mode
 */

import { Context, Service } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool, renderToolsSdk, RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
// Value import (not type-only): the access-cap vocabulary IS the bash seam's
// sandbox-mode ladder, and the import also merges the `bash/resolve-mode`
// event and `ctx.bash` declarations the clamp listener and the bash-family
// gating read. The seam itself stays optional at runtime (`ctx.get('bash')`).
import { SANDBOX_MODES } from '@deepseek-ai/dsh-bash'
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
 * One mode's deployment-configured policy: the guidance section the model sees,
 * the allowlist of tool names that stay visible and executable, and an
 * optional cap on the sandbox access shell commands run under.
 */
export interface ModeDefinition {
  /** Guidance text rendered as the `mode:policy` prompt section while the mode is in force. */
  section: string
  /** Allowlist of tool NAMES; names may reference not-yet-registered tools (registration is dynamic). */
  tools: string[]
  /**
   * The widest sandbox access shell commands may run under while this mode is
   * in force — a per-call CAP on the bash seam's resolved mode (a
   * `bash/resolve-mode` clamp), not a switch: the session's own sandbox knob
   * keeps its setting and re-emerges intact when the mode ends. Omitted, the
   * mode leaves the resolution alone. A mode with `access` set exposes the
   * bash tools only while a confining executor is mounted (an unconfinable
   * shell cannot honor the cap) and denies sandbox escalation outright.
   */
  access?: (typeof SANDBOX_MODES)[number]
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
  + 'to them are denied. Where a bash tool is present it runs under a read-only '
  + 'sandbox: commands that only read work normally, while a command that writes is '
  + 'denied by the sandbox — that denial marks the edge of plan mode rather than a '
  + 'bug, and sandbox escalation is not offered here; put the step in the plan for '
  + 'after approval instead. When a decision or a missing detail blocks the plan, ask the '
  + 'user through the ask_user_question tool where it is available. A finished plan '
  + 'is delivered by calling exit_plan_mode — that call is what puts it in front of '
  + 'the user for review, so prefer it over pasting the plan as a plain reply or '
  + 'asking the user to switch modes themselves. If exit_plan_mode is unavailable or '
  + 'its review fails, ask the user to switch the session out of plan mode instead '
  + 'of retrying denied tools.'

/**
 * The three bash tools an `access` cap conditions on a confining executor:
 * `bash` runs commands under the capped sandbox; `bash_output`/`bash_kill`
 * only observe and stop tasks that ran under it.
 */
const BASH_FAMILY = ['bash', 'bash_output', 'bash_kill']

// 'structured_output' is a structured subagent child's result channel (pure
// reporting, the ask/exit class of read-only-safe): its runtime re-injects the
// schema into the FINAL assembly from an outermost per-spawn listener, so
// allowlisting is what keeps the soft filter, that re-injection, and the hard
// gate telling one consistent story when such a child runs in plan mode.
// The bash trio is allowlisted CONDITIONALLY: plan's read-only `access` cap
// can only be honored by a confining executor, so both policy layers admit
// these three only while `ctx.bash.sandboxMode` proves one is mounted.
const PLAN_TOOLS = ['read', 'todo_write', 'web_search', 'web_fetch', 'ask_user_question', 'structured_output', ...BASH_FAMILY, EXIT_PLAN_MODE]

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

/** Whether a bash call's parsed arguments carry the escalation field (`sandbox_permissions`). */
function hasEscalationArgs(args: unknown): boolean {
  return typeof args === 'object' && args !== null && (args as { sandbox_permissions?: unknown }).sandbox_permissions !== undefined
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
  definitions.set(PLAN_MODE, { section: PLAN_SECTION, tools: [...PLAN_TOOLS], access: 'read-only' })
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
    if (definition.access !== undefined && !SANDBOX_MODES.includes(definition.access)) {
      throw new Error(`ModeConfig: mode "${name}" has unknown access ${JSON.stringify(definition.access)} — one of: ${SANDBOX_MODES.join(', ')}`)
    }
    definitions.set(name, {
      section: definition.section,
      tools: [...definition.tools],
      ...definition.access !== undefined ? { access: definition.access } : {},
    })
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

  /**
   * The latest selected mode per session, awaiting its turn-boundary flush.
   * `narrate` is true for user selections (the flush appends the coalesced
   * notice when the header disagrees) and false for the exit tool's own
   * switch, which narrates through its tool result instead.
   */
  private readonly pendingIntents = new WeakMap<Session, { mode: string; narrate: boolean }>()

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

    // prepend: the filter wraps OUTSIDE every append-registered listener
    // regardless of load order, so their post-next() additions are filtered
    // too. A listener that ALSO prepends after this plugin loads (the
    // structured runtime's per-spawn wrapper) still wins the wrap — for that
    // one the allowlist carries the contract, and the hard gate covers
    // execution either way.
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const result = await next()
      const agent = context.agent
      if (agent === undefined) return result
      const active = this.activeDefinition(agent.session)
      if (active === undefined) {
        result.tools = result.tools.filter(tool => tool.name !== EXIT_PLAN_MODE)
        // The default mode hides exactly one thing on BOTH soft surfaces: the
        // exit tool (registered always, callable only in plan). Without the
        // SDK re-render a Code Mode deployment would still advertise an
        // exit_plan_mode binding that can only error — and the default-mode
        // assembly would no longer be byte-identical to a no-dsh-mode
        // deployment, whose registry never saw the tool at all.
        rerenderSdk(result, name => name !== EXIT_PLAN_MODE)
        return result
      }
      const allowed = new Set(active.definition.tools)
      // An access-capped mode exposes the bash trio only while a confining
      // executor is mounted — advertised tools stay honest about the cap.
      // Read per assembly via ctx.get (never static inject): the executor is
      // optional to this plugin and may swap at runtime.
      const bashUsable = active.definition.access === undefined || ctx.get('bash')?.sandboxMode !== undefined
      const visible = (name: string): boolean =>
        allowed.has(name)
        && (name !== EXIT_PLAN_MODE || active.name === PLAN_MODE)
        && (bashUsable || !BASH_FAMILY.includes(name))
      // run_code is a TRANSPORT, not a capability: under the registry's Code
      // Mode it is the only wire tool (filtering it would leave the model
      // with nothing, not even the exit), and every bridged sub-call
      // re-enters tools/pre-execute with the same agent, where the allowlist
      // governs each capability individually.
      result.tools = result.tools.filter(tool => visible(tool.name) || tool.name === RUN_CODE_NAME)
      // Code Mode's soft surface is the SDK section, not the wire schemas —
      // section text resolves in assemble's base, so the outermost wrapper
      // re-renders it under the same visibility rule the wire filter applies.
      // Without this the prompt would document bindings the gate denies.
      rerenderSdk(result, visible)
      return result
    }, { prepend: true })

    /**
     * Re-render the `tools:sdk` section (present only under the registry's
     * Code Mode) from the registry schemas the given rule admits — minus
     * `run_code` itself, mirroring the registry's own exclusion. A no-op when
     * the section is absent (native mode).
     */
    function rerenderSdk(result: { sections: { name: string; order: number; text: string }[] }, include: (name: string) => boolean): void {
      const sdkIndex = result.sections.findIndex(section => section.name === 'tools:sdk')
      if (sdkIndex < 0) return
      const sdkText = renderToolsSdk(ctx.tools.schemas().filter(schema =>
        include(schema.name) && schema.name !== RUN_CODE_NAME))
      result.sections = result.sections.map((section, index) =>
        index === sdkIndex ? { ...section, text: sdkText } : section)
    }

    ctx.on('tools/pre-execute', (exec, next): Promise<PreToolDecision> => {
      if (exec.agent === undefined) return next()
      const active = this.activeDefinition(exec.agent.session)
      if (active === undefined) return next()
      // Transport pass-through: a run_code program's every tool call is
      // serialized back through ToolRegistry.execute() with the same agent,
      // so each sub-call is judged here individually — gating the wrapper
      // would only remove the vehicle, not widen or narrow any capability.
      if (exec.name === RUN_CODE_NAME) return next()
      // The bash trio is conditional under an access cap: without a confining
      // executor the cap cannot be honored, so the trio reads as not
      // allowlisted — the same absence the assemble filter's hiding implies.
      const capped = active.definition.access !== undefined && BASH_FAMILY.includes(exec.name)
      const bashUsable = !capped || ctx.get('bash')?.sandboxMode !== undefined
      if (active.definition.tools.includes(exec.name) && bashUsable) {
        // A capped mode admits `bash` but no widening: escalation would pierce
        // the cap mid-mode. Denied HERE, before tool-bash's escalation path
        // would treat the clamped resolution as a legitimate baseline and
        // raise the approval prompt.
        if (capped && exec.name === 'bash' && hasEscalationArgs(exec.arguments)) {
          return Promise.resolve({
            kind: 'deny',
            reason: `sandbox escalation is not available in ${active.name} mode — the sandbox stays ${active.definition.access} while it is in force; put the wider-access step in the plan for after approval`,
          })
        }
        return next()
      }
      const reason = active.name === PLAN_MODE
        ? `tool "${exec.name}" is not available in plan mode; continue planning and present your plan with ${EXIT_PLAN_MODE} when ready`
        : `tool "${exec.name}" is not available in "${active.name}" mode`
      return Promise.resolve({ kind: 'deny', reason })
    })

    // The access cap made real: clamp the bash seam's per-call resolution to
    // the active mode's declared access. Read-time composition of two
    // independent folds — the sandbox knob's and the mode's — neither writes
    // the other, so the knob re-emerges intact when the mode ends and a crash
    // between them can strand nothing. SANDBOX_MODES is the narrowest-first
    // ladder; the clamp is an index min.
    ctx.on('bash/resolve-mode', async (session, next) => {
      const base = await next()
      if (session === undefined) return base
      const access = this.activeDefinition(session)?.definition.access
      if (access === undefined) return base
      return SANDBOX_MODES.indexOf(base) <= SANDBOX_MODES.indexOf(access) ? base : access
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
        // A boundary-applied switch, NOT a direct append: the loop may still
        // execute further tool calls from the SAME assistant response after
        // this one, and they were requested under the plan-shaped header — a
        // same-batch exit_plan_mode + write pair must not smuggle the write
        // past the gate. The flush at this step's end appends the mode/set
        // (still in-turn), so the next step's assembly widens; narrate: false —
        // this result IS the narration.
        this.pendingIntents.set(agent.session, { mode: DEFAULT_MODE, narrate: false })
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
   * One turn-boundary pass: narrate a folded mode the config dropped (once per
   * name, turn starts only), then flush the pending intent — append the
   * `mode/set` (skipped when the fold already matches: a net-zero flip
   * sequence) and the one coalesced notice when the flushed mode differs from
   * what the last logged request header told the model.
   */
  private onBoundary(session: Session, turnStart: boolean): void {
    if (turnStart) this.noticeDroppedDefinition(session)
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
