/**
 * User-facing permission presets over the independent sandbox-mode and
 * approval-policy knobs. A switch records the selected preset, then writes
 * changed knobs through their canonical setters. Execution, prompt narration,
 * and replay keep reading their knob folds. The preset event preserves user
 * intent when two presets share a bundle.
 *
 * @module dsh-permission
 */

import { Context, Service } from 'cordis'
import z from 'schemastery'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { SANDBOX_MODES, effectiveSandboxMode, setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
// Side-effect type import: declaration-merges `ctx.bash` (the capability fact
// `sandboxMode` this service reads), without a value dependency on the seam.
import type {} from '@deepseek-ai/dsh-bash'
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
     * Records the selected preset as durable, log-only user intent. The knob
     * events follow in the same turn and control execution; this event stays
     * out of the model transcript and lets {@link effectivePermissionPreset}
     * preserve a selection when bundles match.
     */
    'permission/preset': { preset: string }
  }
}

/** One preset's sandbox/approval bundle and optional client presentation. */
export interface PresetSpec {
  /** The `sandbox/mode` value the preset writes through. */
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
 * Returned when effective knob values match no table entry. Clients may show
 * it as the current value, but it is never a switch target or event payload.
 */
export const CUSTOM_PRESET = 'custom'

/**
 * Fold the last selected preset from the durable log; replay needs no catch-up
 * state.
 * @param events - session events in log order; other event types are ignored.
 * @returns the last selected preset, or undefined when none was recorded.
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
 * Owns the deployment's permission presets and their write path. Requires a
 * confining `ctx.bash` executor and `ctx.approval`; unmatched knob values are
 * reported as {@link CUSTOM_PRESET}, not an error.
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
      'workspace-write': {
        sandbox: 'workspace-write', approval: 'ask',
        name: 'workspace-write', description: 'Write inside the workspace and permitted temporary directories; wider retries require approval.',
      },
      'danger-full-access': {
        sandbox: 'danger-full-access', approval: 'never',
        name: 'danger-full-access', description: 'Full file access without approval prompts.',
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
   * Resolve the preset matching the effective knob values. A still-matching
   * last selection wins shared-bundle ties; otherwise the first table match
   * wins, or {@link CUSTOM_PRESET} when no entry matches.
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
   * Resolve a preset's knob bundle.
   * @param name - the preset name to resolve.
   * @returns the configured bundle.
   * @throws when `name` is not in the table.
   */
  resolve(name: string): PresetSpec {
    const spec = this.presets[name]
    if (spec === undefined) {
      throw new Error(`permission: unknown preset "${name}" (known: ${Object.keys(this.presets).join(', ')})`)
    }
    return spec
  }

  /**
   * Build the client option for a table entry or {@link CUSTOM_PRESET}. A
   * missing label falls back to the table key.
   * @param name - a table key, or `custom`.
   * @returns the option a client renders.
   * @throws when `name` is neither a table key nor `custom`.
   */
  optionOf(name: string): PresetOption {
    if (name === CUSTOM_PRESET) {
      return { value: CUSTOM_PRESET, name: 'Custom', description: 'Current sandbox and approval settings do not match a preset.' }
    }
    const spec = this.resolve(name)
    return { value: name, name: spec.name ?? name, ...spec.description !== undefined ? { description: spec.description } : {} }
  }

  /**
   * Record a changed preset, then update each changed knob through its own
   * setter. Selecting the effective preset again appends nothing.
   * @param session - the session the switch belongs to.
   * @param name - the preset to switch to; unknown names throw.
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
