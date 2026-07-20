/**
 * The sandbox-escalation surface shared by the `write` and `edit` tools: the
 * per-call mode stamp, the advertised escalation fields, and the denial-marker
 * mapping — all delegating the vocabulary and the fail-closed approval
 * sequence to `@deepseek-ai/dsh-sandbox` (the same pieces `@deepseek-ai/dsh-tool-bash`
 * uses), so bash and fs escalate identically. Built ONCE per plugin from
 * `ctx.fs.sandboxMode` (the capability fact — is a confining backend mounted?)
 * and shared by both mutating tools.
 *
 * @module @deepseek-ai/dsh-tool-fs/sandbox
 */

import type { Context } from 'cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { ESCALATION_TARGETS, approveEscalation, escalationHintMarker, sandboxDenialMarker, validateEscalationArgs } from '@deepseek-ai/dsh-sandbox'
import { effectiveSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { FsError } from '@deepseek-ai/dsh-fs'

/** The two escalation arguments a mutating tool may carry (advertised only under a confining backend). */
export interface FsEscalationArgs {
  sandbox_permissions?: string
  justification?: string
}

/** The schema fields for the escalation arguments, spread into a tool's `parameters` when a confining backend is mounted. */
export interface EscalationSchemaFields {
  sandbox_permissions: { type: 'string'; enum: string[]; description: string }
  justification: { type: 'string'; description: string }
}

/**
 * The filesystem escalation surface: advertisement gating, per-call mode
 * stamping (folding the session's `sandbox/mode` override), the one-approved
 * wider retry, and denial-marker mapping. A pure product of `ctx` at plugin
 * apply time.
 */
export class FsSandboxSurface {
  /** The escalation targets this composition advertises (`[]` when no confining backend is mounted). */
  readonly escalationModes: readonly SandboxMode[]
  /** The backend's default mode, or `undefined` when `ctx.fs` does not confine. */
  private readonly defaultMode: SandboxMode | undefined

  constructor(private readonly ctx: Context) {
    this.defaultMode = ctx.fs.sandboxMode
    this.escalationModes = this.defaultMode === undefined ? [] : ESCALATION_TARGETS
  }

  /**
   * The escalation schema fields for a mutating tool's `parameters`. Call it
   * only under a confining backend (guard on {@link escalationModes}); the
   * enum pins the closed target vocabulary, the strict-wider check happens per
   * call at execution.
   * @returns the two escalation parameter specs.
   */
  schemaFields(): EscalationSchemaFields {
    return {
      sandbox_permissions: {
        type: 'string',
        enum: [...this.escalationModes],
        description: 'The wider sandbox mode this file operation needs. Only valid as a one-shot retry '
          + 'of an operation the sandbox just denied; requires justification and user approval.',
      },
      justification: {
        type: 'string',
        description: 'Required with sandbox_permissions: one sentence for the user explaining '
          + 'why this exact file operation needs the wider access.',
      },
    }
  }

  /**
   * The session's standing mode override for an ordinary (non-escalating)
   * call — the `sandbox/mode` fold of the calling agent's log. Undefined for a
   * non-confining backend and for agent-less callers.
   */
  private sessionOverride(exec: ToolExecution): SandboxMode | undefined {
    if (this.defaultMode === undefined || exec.agent === undefined) return undefined
    return effectiveSandboxMode(exec.agent.session.events)
  }

  /**
   * The mode to STAMP onto this mutation: an approved escalation grant (a
   * strictly wider retry resolved through `ctx.approval` before anything
   * executes), else the session's standing override, else `undefined` (the
   * backend applies its own default). Validates the escalation argument
   * pairing first.
   * @param toolName - the mutating tool's name, for the approval audit trail.
   * @param args - the call's escalation arguments.
   * @param exec - the tool-execution context (agent, callId, signal).
   * @returns the mode to pass to the mutation, or undefined for the backend default.
   */
  async stampMode(toolName: string, args: FsEscalationArgs, exec: ToolExecution): Promise<SandboxMode | undefined> {
    validateEscalationArgs(args.sandbox_permissions, args.justification)
    if (args.sandbox_permissions === undefined || args.justification === undefined) {
      return this.sessionOverride(exec)
    }
    if (this.escalationModes.length === 0) {
      throw new Error('sandbox_permissions is not available in this composition (no sandboxing filesystem to escalate)')
    }
    const effectiveMode = (this.sessionOverride(exec) ?? this.defaultMode) as SandboxMode
    return approveEscalation(
      { requestedMode: args.sandbox_permissions, justification: args.justification, effectiveMode, subject: 'operation' },
      {
        approver: this.ctx.get('approval'),
        agent: exec.agent,
        callId: exec.callId,
        toolName,
        signal: exec.signal,
      },
    )
  }

  /**
   * Map a thrown provider error for the model: a `FS_SANDBOX_DENIED` becomes a
   * `FsError` whose text is the shared `[sandbox: …]` denial marker plus the
   * same-turn escalation hint, so a policy denial reads identically to bash's
   * WHILE keeping the structured `FS_SANDBOX_DENIED` code — `ToolRegistry`
   * populates `result.error` only for `HarnessError` instances, so a plain
   * `Error` would strip the code retry/observers key off. Any other error
   * passes through unchanged. A `FS_SANDBOX_DENIED` only arises under a
   * confining backend, which always advertises the escalation fields, so the
   * hint always applies here.
   * @param error - the error thrown by the mutation.
   * @param stampedMode - the mode stamped onto the call (names the mode in the marker).
   * @returns the error to throw — the marker `FsError` for a sandbox denial, else the original.
   */
  mapError(error: unknown, stampedMode: SandboxMode | undefined): unknown {
    if (!(error instanceof FsError) || error.code !== 'FS_SANDBOX_DENIED') return error
    // A FS_SANDBOX_DENIED only arises under a confining backend, so defaultMode
    // (hence the resolved mode) is defined here.
    const mode = (stampedMode ?? this.defaultMode) as SandboxMode
    return new FsError(`${sandboxDenialMarker(mode)}\n${escalationHintMarker('operation')}`, 'FS_SANDBOX_DENIED', { cause: error })
  }
}
