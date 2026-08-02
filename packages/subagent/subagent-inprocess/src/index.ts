/**
 * Shared driver for in-process subagent providers. The agent factory's
 * creation transaction owns unpublished setup and rollback; after publication
 * the returned AgentHandle is the one quiescent lifecycle owner held by the
 * provider's caller.
 *
 * @module @deepseek-ai/dsh-subagent-inprocess
 */

import { randomUUID } from 'node:crypto'
import type { Context } from 'cordis'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import { findLastMessageTurnEnd, SessionId, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { createUserMessage, errorChain, type ContentBlock, type MessageSource } from '@deepseek-ai/dsh-llm'
import { assertSubagentMaxDepth, delegationDepthOf, SubagentError } from '@deepseek-ai/dsh-subagent'
import type {
  SubagentDescriptorData,
  SubagentProviderResumeRequest,
  SubagentProviderStartRequest,
  SubagentResult,
  SubagentRun,
  SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
// Type-only: make `ctx.get('sandboxPolicy')` / `ctx.get('approval')` resolve
// to the policy services when composed — the driver consumes both
// opportunistically (the documented `ctx.get` pattern), never as a hard dep.
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'
import {
  attachStructuredRuntime,
  type StructuredAttachment,
} from './structured.ts'

export {
  STRUCTURED_OUTPUT_TOOL,
  STRUCTURED_OUTPUT_INSTRUCTION,
} from './structured.ts'

/** Thrown when starting a child would exceed the requested depth cap. */
class SubagentDepthError extends Error {
  constructor(public readonly attemptedDepth: number, public readonly maxDepth: number) {
    super(`subagent depth ${attemptedDepth} exceeds maxDepth ${maxDepth}`)
    this.name = 'SubagentDepthError'
  }
}

/** Map a session turn outcome to the subagent seam's terminal vocabulary. */
function toStopReason(reason: TurnEndReason | undefined): SubagentStopReason {
  switch (reason?.kind) {
    case 'completed':
      return 'completed'
    case 'max-tokens':
      return 'max-tokens'
    case 'aborted':
      return 'aborted'
    case 'error':
    case 'disposed':
    case 'interrupted':
    default:
      return 'error'
  }
}

/** Extra inputs the spawn and fork providers supply to the shared driver. */
export interface InProcessRunOptions {
  /** Completed-turn seed for fork, or undefined for a fresh spawn. */
  readonly seed?: SessionEvent[]
}

/** Whether one activation must prove its final state durable before success. */
type Durability = 'best-effort' | 'required'

/** Activation-specific inputs to the shared in-process driver. */
interface DriveTurnOptions {
  readonly durability: Durability
  /** Attribution for a resumed activation's follow-up prompt. */
  readonly source?: MessageSource
  readonly structured?: StructuredAttachment
}

/** Error used when cancellation wins before the child publication boundary. */
function prePublicationAbort(): Error {
  return new Error('subagent request was aborted before child publication')
}

/**
 * Register the one-shot child-scoped contribution that appends the durable
 * `subagent/descriptor` event. The prepended `agent/prompt-submit` wrapper
 * appends before downstream admission can block or throw. Allowed admission
 * opens the initial turn afterward; the final required checkpoint also
 * persists the descriptor when no turn opens.
 */
function attachDescriptorAppend(childCtx: Context, descriptor: SubagentDescriptorData): void {
  childCtx.once('agent/prompt-submit', (agent, _message, _signal, next) => {
    agent.session.append('subagent/descriptor', descriptor)
    return next()
  }, { prepend: true })
}

/**
 * Establish and drive one in-process child. Fulfillment means the agent is
 * already published in the registry; rejection means the agent factory's
 * creation transaction and any partially-created child have reached quiescence.
 * A `request.continuation` publishes exactly its stable child id and appends
 * its descriptor before the child's initial prompt admission.
 * @param request - the trusted typed start request, including its required signal.
 * @param options - the optional fork seed.
 * @returns a ready holder-owned run.
 */
export async function startInProcessRun(
  request: SubagentProviderStartRequest,
  options: InProcessRunOptions,
): Promise<SubagentRun> {
  assertSubagentMaxDepth(request.maxDepth)
  if (request.signal.aborted) throw prePublicationAbort()
  const parent = request.parent
  const childDepth = delegationDepthOf(parent) + 1
  if (!Number.isSafeInteger(childDepth)) {
    throw new RangeError('subagent child depth exceeds the safe-integer range')
  }
  if (request.maxDepth !== undefined && childDepth > request.maxDepth) {
    throw new SubagentDepthError(childDepth, request.maxDepth)
  }

  // A continuable delegation names the durable conversation up front; the
  // provider publishes exactly that id instead of allocating one internally.
  const childId = request.continuation?.sessionId ?? SessionId(randomUUID())
  const seedLength = options.seed?.length ?? 0
  const parentHeader = parent.session.header
  const parentProvider = parent.options.provider
  const parentModel = parent.options.model
  const parentMaxTokens = parent.options.maxTokens
  const agentOptions: AgentOptions = {
    ...parentProvider !== undefined ? { provider: parentProvider } : {},
    ...parentModel !== undefined ? { model: parentModel } : {},
    ...parentMaxTokens !== undefined ? { maxTokens: parentMaxTokens } : {},
    ...request.agentOptions,
    subagentDepth: childDepth,
  }

  // Capture before the first await: a later parent switch belongs to the
  // parent's future.
  const inheritedMode = parent.ctx.get('sandboxPolicy')?.overrideOf(parent.session)
  const inheritedPolicy = parent.ctx.get('approval')?.overrideOf(parent.session)

  let structured: StructuredAttachment | undefined
  const setup = (childCtx: Context): void => {
    const childSession = (childCtx.agent as Agent).session
    if (inheritedMode !== undefined) {
      childSession.append('sandbox/mode', { mode: inheritedMode, source: 'delegation' })
    }
    if (inheritedPolicy !== undefined) {
      childSession.append('approval/policy', { policy: inheritedPolicy, source: 'delegation' })
    }
    if (request.persona !== undefined) {
      childCtx.systemPrompt.section({ name: 'deployment:persona', order: 0, text: request.persona })
    }
    if (request.toolFilter !== undefined) childCtx.tools.restrict(request.toolFilter)
    if (request.outputSchema !== undefined) {
      structured = attachStructuredRuntime(childCtx, request.outputSchema)
    }
    if (request.continuation !== undefined) {
      attachDescriptorAppend(childCtx, request.continuation.descriptor)
    }
  }

  const handle = await parent.ctx.agents.create({
    sessionId: childId,
    meta: {
      ...parentHeader.cwd !== undefined ? { cwd: parentHeader.cwd } : {},
      parentSession: parentHeader.id,
      // Durable: the recursion budget must survive persistence and resume.
      delegationDepth: childDepth,
      ...seedLength > 0 ? { seedLength } : {},
    },
    ...options.seed === undefined ? {} : { seed: options.seed },
    agentOptions,
    signal: request.signal,
    setup,
  })
  return driveTurn(
    handle,
    request.signal,
    request.prompt,
    childId,
    seedLength,
    {
      durability: request.continuation === undefined ? 'best-effort' : 'required',
      ...structured === undefined ? {} : { structured },
    },
  )
}

/**
 * Reconstruct a persisted continuable child under the live parent's scope and
 * drive one follow-up turn. The resumed session's own transcript is the seed
 * (loaded through the parent's persistence-backed registry `resume`), so a
 * fork child never re-forks current parent history; the persisted header
 * remains authoritative for lineage and the delegation-depth floor.
 * @param request - the fully resolved resume request from the continuation manager.
 * @returns a fresh ready holder-owned run for this activation.
 */
export async function resumeInProcessRun(request: SubagentProviderResumeRequest): Promise<SubagentRun> {
  if (request.signal.aborted) throw prePublicationAbort()
  const descriptor = request.descriptor
  const agentOptions: AgentOptions = {
    ...descriptor.agentProvider !== undefined ? { provider: descriptor.agentProvider } : {},
    ...descriptor.agentModel !== undefined ? { model: descriptor.agentModel } : {},
  }
  const setup = (childCtx: Context): void => {
    if (descriptor.persona !== undefined) {
      childCtx.systemPrompt.section({ name: 'deployment:persona', order: 0, text: descriptor.persona })
    }
    if (descriptor.toolFilter !== undefined) childCtx.tools.restrict(descriptor.toolFilter)
  }

  const handle = await request.parent.ctx.agents.resume({
    resumeSessionId: request.sessionId,
    agentOptions,
    signal: request.signal,
    setup,
  })
  // The result boundary is this activation's own work: everything already in
  // the resumed transcript belongs to earlier turns.
  const resumePoint = handle.agent.session.events.length
  return driveTurn(
    handle,
    request.signal,
    request.prompt,
    request.sessionId,
    resumePoint,
    { durability: 'required', source: request.source },
  )
}

/**
 * Drive one activation turn on a published child and wrap it as a run. The
 * caller has already created or resumed the agent; this owns the
 * signal-handoff race, the live abort listener, result collection past
 * `boundary`, the continuable-run durability confirmation, confirmed
 * steering, and disposal.
 */
function driveTurn(
  handle: AgentHandle,
  signal: AbortSignal,
  prompt: ContentBlock[],
  childId: SessionId,
  boundary: number,
  options: DriveTurnOptions,
): SubagentRun | Promise<never> {
  const child = handle.agent
  const { durability, source, structured } = options
  // Agent creation detaches its creation-only abort listener before returning.
  // Close the narrow handoff race before installing the live-run listener.
  if (signal.aborted) {
    return handle.dispose().then(() => { throw prePublicationAbort() })
  }

  const flags = { cancelled: false }
  const onAbort = (): void => {
    flags.cancelled = true
    child.cancel({ kind: 'parent' })
  }
  signal.addEventListener('abort', onAbort, { once: true })

  const result: Promise<SubagentResult> = (async () => {
    try {
      child.followup(createUserMessage({ content: prompt, source: source ?? { kind: 'user' } }))
      await child.whenIdle()
      if (durability === 'required') {
        try {
          const participated = await child.ctx.sessions.flush(child.session)
          if (!participated) {
            throw new Error(`session "${child.id}" required durability checkpoint has no registered listener`)
          }
        } catch (error: unknown) {
          if (!signal.aborted) {
            throw new SubagentError(
              `subagent "${childId}" durability checkpoint failed; the latest child state was not confirmed persisted and may be unavailable or stale on resume: ${errorChain(error)}`,
              'DURABILITY_FAILED',
              { cause: error },
            )
          }
        }
      }
      return readResult(
        child,
        boundary,
        flags.cancelled,
        structured ? { captured: structured.captured() } : undefined,
        durability === 'required' && signal.aborted,
      )
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  })()

  return {
    id: childId,
    localAgent: child,
    result,
    dispose(): Promise<void> {
      signal.removeEventListener('abort', onAbort)
      flags.cancelled = true
      return handle.dispose()
    },
    async steer(content: ContentBlock[], steeringSource: MessageSource): Promise<void> {
      // The status check and submission share one synchronous frame. An idle
      // Agent.steer() would queue an untracked turn after this run's result.
      if (child.status !== 'running') {
        throw new Error(`subagent child "${childId}" is not running; the message was not delivered`)
      }
      // Avoid waiting for the structured terminal checkpoint when its outcome
      // is already authoritative and synchronously visible.
      if (structured?.captured() !== undefined) {
        throw new Error(`subagent child "${childId}" already reported its structured result; the message was not delivered`)
      }
      const receipt = child.steer(createUserMessage({ content, source: steeringSource }))
      const outcome = await receipt.outcome
      if (outcome.status === 'rejected') {
        throw new Error(`subagent child "${childId}" stopped before steering admission; the message was not delivered`)
      }
    },
  }
}

/** Read one settled child's result from events after its activation boundary. */
function readResult(
  child: Agent,
  boundary: number,
  cancelled: boolean,
  structured?: { captured?: { value: unknown } | undefined },
  cancellationOwnsCompleted = false,
): SubagentResult {
  const own = child.session.events.slice(boundary)
  const lastMessage = own.findLast((event): event is SessionEvent<'assistant/message'> => event.type === 'assistant/message')
  const lastEnd = findLastMessageTurnEnd(own)
  const output: ContentBlock[] = lastMessage?.data.message.content ?? []
  const recorded = toStopReason(lastEnd?.data.reason)
  // Disposal can tear the owner down before the loop records its ordinary
  // `aborted` end, yielding `disposed` instead. Activation cancellation during
  // its final durability checkpoint also owns a recorded completed turn because
  // the provider has not published that result yet.
  const stopReason: SubagentStopReason = cancelled
    && (recorded !== 'completed' || cancellationOwnsCompleted)
    ? 'aborted'
    : recorded
  if (structured !== undefined) {
    if (structured.captured !== undefined) {
      return { output, structured: structured.captured.value, stopReason }
    }
    if (stopReason === 'completed') return { output, stopReason: cancelled ? 'aborted' : 'error' }
  }
  return { output, stopReason }
}
