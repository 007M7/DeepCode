/**
 * Shared in-process child composition: the delegation-depth budget, the
 * durable session metadata, the resolved child `AgentOptions`, the delegated
 * policy seed, and the scoped setup a child agent needs. Both the one-shot
 * provider driver and the continuation manager compose children this way, so
 * depth accounting, lineage stamping, and delegation policy have one home.
 *
 * @module @deepseek-ai/dsh-subagent/child-agent
 */

import type { Context } from 'cordis'
import type { Agent, AgentOptions, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'
// Type-only: make `ctx.get('sandboxPolicy')` / `ctx.get('approval')` resolve
// to the policy services when composed — delegation consumes both
// opportunistically (the documented `ctx.get` pattern), never as a hard dep —
// and merge the `sandbox/mode` / `approval/policy` session-event payloads.
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'
import { delegationDepthOf } from './depth.ts'

/** Thrown when starting a child would exceed the requested depth cap. */
export class SubagentDepthError extends Error {
  constructor(public readonly attemptedDepth: number, public readonly maxDepth: number) {
    super(`subagent depth ${attemptedDepth} exceeds maxDepth ${maxDepth}`)
    this.name = 'SubagentDepthError'
  }
}

/**
 * Resolve the child's delegation depth from its parent and enforce an optional
 * cap. The persisted parent header is the monotone floor, so a resumed parent
 * cannot delegate as if it were top-level.
 * @param parent - the delegating parent agent.
 * @param maxDepth - optional absolute cap the resolved depth must not exceed.
 * @returns the child's non-negative safe-integer depth.
 * @throws {SubagentDepthError} when the resolved depth exceeds `maxDepth`.
 * @throws {RangeError} when the resolved depth leaves the safe-integer range.
 */
export function resolveChildDepth(parent: Agent, maxDepth: number | undefined): number {
  const childDepth = delegationDepthOf(parent) + 1
  if (!Number.isSafeInteger(childDepth)) {
    throw new RangeError('subagent child depth exceeds the safe-integer range')
  }
  if (maxDepth !== undefined && childDepth > maxDepth) {
    throw new SubagentDepthError(childDepth, maxDepth)
  }
  return childDepth
}

/**
 * Resolve the child's `AgentOptions`: the parent's provider/model/maxTokens
 * route unless the request overrides it, stamped with the child's own
 * delegation depth.
 * @param parent - the delegating parent whose route the child inherits.
 * @param requested - per-child overrides, if any.
 * @param childDepth - the resolved delegation depth to stamp.
 * @returns the resolved options for `ctx.agents.create()`.
 */
export function resolveChildAgentOptions(
  parent: Agent,
  requested: AgentOptions | undefined,
  childDepth: number,
): AgentOptions {
  const parentProvider = parent.options.provider
  const parentModel = parent.options.model
  const parentMaxTokens = parent.options.maxTokens
  return {
    ...parentProvider !== undefined ? { provider: parentProvider } : {},
    ...parentModel !== undefined ? { model: parentModel } : {},
    ...parentMaxTokens !== undefined ? { maxTokens: parentMaxTokens } : {},
    ...requested,
    subagentDepth: childDepth,
  }
}

/**
 * Build the child session's durable creation metadata: the parent's workspace,
 * its direct lineage, coarse product origin, the recursion budget that must
 * survive persistence, and the seed boundary that separates inherited parent
 * history from child work.
 * @param parent - the delegating parent agent.
 * @param childDepth - the resolved delegation depth to persist.
 * @param lineageSeedLength - how many leading events came from the parent's log.
 * @returns the `meta` for `ctx.agents.create()`.
 */
export function childSessionMeta(
  parent: Agent,
  childDepth: number,
  lineageSeedLength: number,
): NonNullable<CreateAgentOptions['meta']> {
  const parentHeader = parent.session.header
  return {
    ...parentHeader.cwd !== undefined ? { cwd: parentHeader.cwd } : {},
    parentSession: parentHeader.id,
    // Navigation classification only; the descriptor remains the authority
    // for mode and continuation capability.
    origin: 'subagent',
    // Durable: the recursion budget must survive persistence and resume.
    delegationDepth: childDepth,
    ...lineageSeedLength > 0 ? { seedLength: lineageSeedLength } : {},
  }
}

/** The scoped composition a child agent's creation window applies. */
export interface ChildComposition {
  /** Per-child persona shadowing the deployment persona. */
  readonly persona?: string | undefined
  /** Per-child tool scoping. */
  readonly toolFilter?: ToolRestriction | undefined
}

/**
 * Model-facing statement every in-process child receives: the permission
 * scope is fixed at delegation and approval prompts are unavailable, so the
 * child reports a scope limitation instead of retrying denied operations.
 * A runtime-context contribution (not a system-prompt section) because it is
 * a per-session fact: the deployment's system prompt stays uniform across
 * parents and children, and the statement joins the same durable snapshot
 * that carries the sandbox-policy and approval-policy sentences.
 */
export const SUBAGENT_DELEGATION_CONTEXT
  = 'You are a delegated subagent: your permission scope was fixed when you were started and cannot be '
    + 'widened from inside this session — operations that require approval are rejected automatically. '
    + 'When the task needs access beyond that scope, do not retry the denied operation; state the '
    + 'limitation in your reply so the delegating agent can handle it.'

/**
 * Apply one child's scoped composition inside its creation window: the fixed
 * delegation-scope statement, a shadowing persona section, and a tool
 * restriction, all owned by the child's scope and therefore invisible to its
 * parent and siblings. Both creation and cold resume pass through here, so a
 * resumed child keeps the same statement.
 * @param childCtx - the child agent's scoped creation context.
 * @param composition - the persona and tool filter to install.
 */
export function applyChildComposition(childCtx: Context, composition: ChildComposition): void {
  // After sandbox:policy (110) and approval:policy (115): scope, then policy,
  // then what a delegated child does about a denial.
  childCtx.systemPrompt.context({ name: 'subagent:delegation', order: 120, text: SUBAGENT_DELEGATION_CONTEXT })
  if (composition.persona !== undefined) {
    childCtx.systemPrompt.section({ name: 'deployment:persona', order: 0, text: composition.persona })
  }
  if (composition.toolFilter !== undefined) childCtx.tools.restrict(composition.toolFilter)
}

/** Policy seeded onto a child session's log at the delegation boundary. */
export interface DelegatedPolicyOverrides {
  /** The parent session's explicit sandbox-mode override, or `undefined` without one. */
  readonly sandboxMode: SandboxMode | undefined
  /**
   * The child's pinned approval policy, or `undefined` when no approval
   * capability is composed. Always `'never'` with one composed: a delegated
   * child acts only within the sandbox scope fixed at delegation, so the
   * composed `ApprovalService` rejects every child ask deterministically
   * instead of waiting on a prompt no one is watching.
   */
  readonly approvalPolicy: 'never' | undefined
}

/**
 * Capture the policy to seed into one delegation. Call synchronously before
 * the child start's first await: a later parent switch belongs to the
 * parent's future, not to this child. The sandbox scope is the parent
 * session's explicit override — deployment defaults and one-shot grants are
 * never captured, so an unswitched parent leaves the child following the
 * deployment default dynamically. The approval policy is never inherited: it
 * is pinned to `'never'` whenever the approval capability is composed,
 * regardless of the parent's own policy.
 * @param parent - the delegating parent agent.
 * @returns the sandbox override (or `undefined` without one) and the approval pin.
 */
export function captureDelegatedPolicyOverrides(parent: Agent): DelegatedPolicyOverrides {
  return {
    sandboxMode: parent.ctx.get('sandboxPolicy')?.overrideOf(parent.session),
    approvalPolicy: parent.ctx.get('approval') === undefined ? undefined : 'never',
  }
}

/**
 * Append the captured delegation policy onto the child's own log as
 * `source: 'delegation'` events inside the unpublished creation window, so the
 * child's effective policy is reconstructable from its log alone. Appends land
 * after any fork seed, so fresh policy wins stale seed state; later child
 * switches still win over these events.
 * @param childSession - the unpublished child's session.
 * @param overrides - the policy captured at delegation.
 */
export function appendDelegatedPolicyOverrides(
  childSession: Session,
  overrides: DelegatedPolicyOverrides,
): void {
  if (overrides.sandboxMode !== undefined) {
    childSession.append('sandbox/mode', { mode: overrides.sandboxMode, source: 'delegation' })
  }
  if (overrides.approvalPolicy !== undefined) {
    childSession.append('approval/policy', { policy: overrides.approvalPolicy, source: 'delegation' })
  }
}

/** Identity and lineage inputs shared by every in-process child creation. */
export interface ChildCreateInputs {
  /** The child's reserved session id. */
  readonly sessionId: SessionId
  /** The delegating parent agent. */
  readonly parent: Agent
  /** The resolved delegation depth. */
  readonly childDepth: number
  /** How many leading seed events came from the parent's log. */
  readonly lineageSeedLength: number
}
