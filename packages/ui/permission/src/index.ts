/**
 * User-facing PERMISSION PRESETS: one product-level knob over the two
 * mechanism knobs. A preset names a bundle — its sandbox mode
 * (`bash/sandbox-mode`) and its approval policy (`approval/policy`) — so a
 * user picks `workspace-write` or `danger-full-access` while the mechanism
 * tiers stay orthogonal capabilities. Switching a preset WRITES THROUGH: one `permission/preset` event
 * records the chosen bundle (the audit fact reverse-mapping cannot recover —
 * two presets may share knob values and differ only in composed policy, the
 * planned `agent` preset being the standing example), then each knob event
 * follows through its own THE-write-path setter, skipping values the session
 * already effectively has. Every existing consumer (executor stamping, the
 * approval gate, narrators, resume) keeps reading its own knob fold,
 * untouched.
 *
 * @module dsh-permission
 */

import { Context, Service } from 'cordis'
import z from 'schemastery'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { SANDBOX_MODES, effectiveSandboxMode, setSandboxMode } from '@deepseek-ai/dsh-bash'
import type { ApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { APPROVAL_POLICIES, effectiveApprovalPolicy, setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'

declare module 'cordis' {
  interface Context {
    permission: PermissionService
  }
}

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /**
     * The session's permission preset was switched — log-only (the
     * `bash/sandbox-mode` precedent): durable and replayable, never in the
     * model transcript. The LAST such event is the session's preset
     * ({@link effectivePermissionPreset}); the knob events the switch wrote
     * through follow it in the same turn, and they — not this record of the
     * user's choice — are what execution reads.
     */
    'permission/preset': { preset: string }
  }
}

/**
 * One preset's knob bundle — the sandbox mode and approval policy a session
 * runs under while the preset is active — plus its presentation.
 */
export interface PresetSpec {
  /** The `bash/sandbox-mode` value the preset writes through. */
  sandbox: SandboxMode
  /** The `approval/policy` value the preset writes through. */
  approval: ApprovalPolicy
  /** The display label a client shows for this preset; the raw table key when omitted. */
  name?: string
  /** One user-facing sentence on what the preset means; omitted when not configured. */
  description?: string
}

/** The select-option shape a presentation layer advertises for one preset (or for the derived `custom` state). */
export interface PresetOption {
  /** The machine value (`session/set_config_option` vocabulary): the table key, or `custom`. */
  value: string
  /** The display label. */
  name: string
  /** One user-facing sentence on what the value means. */
  description?: string
}

/**
 * The derived not-a-preset state: the session's effective knob values match
 * no table entry (composition defaults outside the table, or a knob moved
 * out from under the last-chosen preset). Never a switch target and never
 * an event payload — {@link PermissionService.current} derives it, and the
 * presentation layer shows it as a selectable-FROM-only current value.
 */
export const CUSTOM_PRESET = 'custom'

/**
 * The session's permission-preset override: the last `permission/preset` event in the
 * log, or undefined when the session never switched (callers apply the
 * plugin's configured default). The pure fold — resume needs no catch-up
 * machinery because replaying the log IS the state.
 * @param events - session events in log order (other event types are skipped).
 * @returns the preset of the last switch event, or undefined without one.
 */
export function effectivePermissionPreset(events: readonly SessionEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent
    if (event.type === 'permission/preset') return event.data.preset
  }
  return undefined
}

/** The {@link PermissionService} config: the deployment's preset table. */
export interface Config {
  /**
   * The preset table: name → knob bundle. Defaults to `workspace-write`
   * (workspace-write + ask) and `danger-full-access` (danger-full-access +
   * never). The name `custom` is reserved for the derived not-a-preset state.
   */
  presets?: Record<string, PresetSpec>
}

/**
 * The permission service (`ctx.permission`). Owns the deployment's preset
 * table and THE write path for preset switches; presentation layers (the ACP
 * bridge's single `Permissions` select) advertise {@link names} and call
 * {@link set}. Composing it REQUIRES both mechanism knobs — a confining
 * `ctx.bash` executor and the `ctx.approval` seam. A knob state matching no
 * table entry is not an error but the derived {@link CUSTOM_PRESET} state:
 * shown as the current value, never a switch target.
 */
export class PermissionService extends Service {
  // Inline schema call: the config catalog walks `static Config` statically.
  static Config: z<Config> = z.object({
    presets: z.dict(z.object({
      sandbox: z.union(SANDBOX_MODES as SandboxMode[]).required(),
      approval: z.union(APPROVAL_POLICIES as ApprovalPolicy[]).required(),
      name: z.string(),
      description: z.string(),
    })).default({
      // Keep the user-facing preset names explicit about filesystem reach.
      'workspace-write': {
        sandbox: 'workspace-write', approval: 'ask',
        name: 'workspace-write', description: 'Write inside the workspace; anything wider asks for your approval.',
      },
      'danger-full-access': {
        sandbox: 'danger-full-access', approval: 'never',
        name: 'danger-full-access', description: 'Full file access, no approval prompts.',
      },
    }),
  })

  static inject = ['bash', 'approval']

  private readonly presets: Record<string, PresetSpec>

  constructor(ctx: Context, config: Config) {
    super(ctx, 'permission')
    // The schema defaulted the table — the cast records that runtime fact.
    this.presets = config.presets as Record<string, PresetSpec>
    if (CUSTOM_PRESET in this.presets) {
      throw new Error(`permission: "${CUSTOM_PRESET}" is reserved for the derived not-a-preset state and cannot name a table entry`)
    }
    if (ctx.bash.sandboxMode === undefined) {
      throw new Error('permission: the mounted bash executor does not confine (no sandboxMode) — presets bundle a sandbox mode, so composing this plugin over an unconfined executor is a misconfiguration')
    }
  }

  /**
   * The advertised preset names, in the preset table's declaration order.
   * @returns every switchable preset name.
   */
  get names(): readonly string[] {
    return Object.keys(this.presets)
  }

  /**
   * The preset a session is on right now, derived from the EFFECTIVE knob
   * values (fold ?? composition default per knob): the last-chosen preset
   * when its bundle still matches (presets may share bundles — the fold
   * breaks the tie), else the first table entry that matches, else
   * {@link CUSTOM_PRESET} — a mismatch is a state, not an error.
   * @param events - the session's events in log order.
   * @returns the effective preset name, or `custom` when nothing matches.
   */
  current(events: readonly SessionEvent[]): string {
    const sandbox = effectiveSandboxMode(events) ?? this.ctx.bash.sandboxMode
    const approval = effectiveApprovalPolicy(events) ?? this.ctx.approval.config.policy ?? 'ask'
    const matches = (spec: PresetSpec): boolean => spec.sandbox === sandbox && spec.approval === approval
    const folded = effectivePermissionPreset(events)
    if (folded !== undefined) {
      const spec = this.presets[folded]
      if (spec !== undefined && matches(spec)) return folded
    }
    for (const [name, spec] of Object.entries(this.presets)) {
      if (matches(spec)) return name
    }
    return CUSTOM_PRESET
  }

  /**
   * A preset's knob bundle, for consumers presenting or validating one.
   * @param name - the preset name to resolve.
   * @returns the bundle; throws on a name outside the table (fails loud —
   *   an unvalidated caller handed the service an unknown preset).
   */
  resolve(name: string): PresetSpec {
    const spec = this.presets[name]
    if (spec === undefined) {
      throw new Error(`permission: unknown preset "${name}" (known: ${Object.keys(this.presets).join(', ')})`)
    }
    return spec
  }

  /**
   * The select-option presentation of one advertisable value: a table entry
   * (label/description from its spec, the raw key standing in for a missing
   * label) or the derived {@link CUSTOM_PRESET} with its fixed presentation.
   * @param name - a table key, or `custom`.
   * @returns the option a client renders; throws on any other name.
   */
  optionOf(name: string): PresetOption {
    if (name === CUSTOM_PRESET) {
      return { value: CUSTOM_PRESET, name: 'Custom', description: 'A hand-set knob combination outside the preset table.' }
    }
    const spec = this.resolve(name)
    return { value: name, name: spec.name ?? name, ...spec.description !== undefined ? { description: spec.description } : {} }
  }

  /**
   * THE write path for a preset switch: appends one `permission/preset` event when
   * `name` differs from the session's current preset, then writes each knob
   * through its own setter, skipping values the session already effectively
   * has — a net-zero switch appends nothing (the log records switches, not
   * select clicks).
   * @param session - the session the switch belongs to.
   * @param name - the preset to switch to (validated via {@link resolve}).
   */
  set(session: Session, name: string): void {
    const spec = this.resolve(name)
    if (this.current(session.events) !== name) {
      session.append('permission/preset', { preset: name })
    }
    const events = session.events
    if (spec.sandbox !== (effectiveSandboxMode(events) ?? this.ctx.bash.sandboxMode)) {
      setSandboxMode(session, spec.sandbox)
    }
    if (spec.approval !== (effectiveApprovalPolicy(events) ?? this.ctx.approval.config.policy ?? 'ask')) {
      setApprovalPolicy(session, spec.approval)
    }
  }
}

export default PermissionService
