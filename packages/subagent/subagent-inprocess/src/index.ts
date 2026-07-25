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
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { findLastMessageTurnEnd, SessionId, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { assertSubagentMaxDepth, delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import type { SubagentResult, SubagentRun, SubagentStartRequest, SubagentStopReason } from '@deepseek-ai/dsh-subagent'
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

/** Error used when cancellation wins before the child publication boundary. */
function prePublicationAbort(): Error {
  return new Error('subagent request was aborted before child publication')
}

/**
 * Establish and drive one in-process child. Fulfillment means the agent is
 * already published in the registry; rejection means the agent factory's
 * creation transaction and any partially-created child have reached quiescence.
 * @param request - the trusted typed start request, including its required signal.
 * @param options - the optional fork seed.
 * @returns a ready holder-owned run.
 */
export async function startInProcessRun(
  request: SubagentStartRequest,
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

  const childId = SessionId(randomUUID())
  const seedLength = options.seed?.length ?? 0
  const parentHeader = parent.session.header
  const parentProvider = parent.options.provider
  const parentModel = parent.options.model
  const agentOptions: AgentOptions = {
    ...parentProvider !== undefined ? { provider: parentProvider } : {},
    ...parentModel !== undefined ? { model: parentModel } : {},
    ...request.agentOptions,
    subagentDepth: childDepth,
  }

  // Policy inheritance, read half: capture the parent's sandbox/approval
  // OVERRIDES synchronously, before the first await — the delegation moment
  // is the semantic snapshot point, and a parent switch racing the child's
  // asynchronous creation must belong to the parent's future, not the child.
  // Both services are consumed opportunistically — without them, delegation
  // stays policy-free.
  const sandboxPolicy = parent.ctx.get('sandboxPolicy')
  const approval = parent.ctx.get('approval')
  const inheritedMode = sandboxPolicy?.overrideOf(parent.session)
  const inheritedPolicy = approval?.overrideOf(parent.session)

  let structured: StructuredAttachment | undefined
  const setup = (childCtx: Context): void => {
    if (request.persona !== undefined) {
      childCtx.systemPrompt.section({ name: 'deployment:persona', order: 0, text: request.persona })
    }
    if (request.toolFilter !== undefined) childCtx.tools.restrict(request.toolFilter)
    if (request.outputSchema !== undefined) {
      structured = attachStructuredRuntime(childCtx, request.outputSchema)
    }
    // Write half: stamp the captured overrides once, anchored inside the
    // child's FIRST turn (prompt-submit runs after turn/start, before prompt
    // assembly) — a bare between-turn append would be crash-tail garbage on
    // reload, and stamping here also orders the override after any stale
    // switch a fork seed carried, so the ordinary last-event-wins fold
    // resolves it. PREPENDED so a veto-capable listener (a denying
    // UserPromptSubmit hook) cannot close the first turn without the stamp —
    // the stamp must be durable even for a blocked first prompt. One-shot:
    // later turns must not re-stamp over a switch the child made itself.
    if (inheritedMode !== undefined || inheritedPolicy !== undefined) {
      const disposeInherit = childCtx.on('agent/prompt-submit', (childAgent, _content, _source, _signal, next) => {
        disposeInherit()
        if (inheritedMode !== undefined) sandboxPolicy?.stampOverride(childAgent.session, inheritedMode)
        if (inheritedPolicy !== undefined) approval?.stampOverride(childAgent.session, inheritedPolicy)
        return next()
      }, { prepend: true })
    }
  }

  const flags = { cancelled: false }
  const handle = await parent.ctx.agents.create({
    sessionId: childId,
    meta: {
      ...parentHeader.cwd !== undefined ? { cwd: parentHeader.cwd } : {},
      parentSession: parentHeader.id,
      // Durable: the recursion budget must survive persistence and resume.
      delegationDepth: childDepth,
      ...seedLength > 0 ? { seedLength } : {},
    },
    ...options.seed !== undefined ? { seed: options.seed } : {},
    agentOptions,
    signal: request.signal,
    setup,
  })
  const child = handle.agent
  // Agent creation detaches its creation-only abort listener before returning.
  // Close the narrow handoff race before installing the live-run listener.
  // Static analysis does not model the abort that may land between the
  // factory's listener detachment and this continuation.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (request.signal.aborted) {
    flags.cancelled = true
    await handle.dispose()
    throw prePublicationAbort()
  }

  const onAbort = (): void => {
    flags.cancelled = true
    child.cancel({ kind: 'parent' })
  }
  request.signal.addEventListener('abort', onAbort, { once: true })

  const result: Promise<SubagentResult> = (async () => {
    try {
      child.send(request.prompt)
      await child.whenIdle()
      return readResult(
        child,
        seedLength,
        flags.cancelled,
        structured ? { captured: structured.captured() } : undefined,
      )
    } finally {
      request.signal.removeEventListener('abort', onAbort)
    }
  })()

  return {
    id: childId,
    localAgent: child,
    result,
    dispose(): Promise<void> {
      request.signal.removeEventListener('abort', onAbort)
      flags.cancelled = true
      return handle.dispose()
    },
  }
}

/** Read one settled child's result from events after its optional fork seed. */
function readResult(
  child: Agent,
  seedLength: number,
  cancelled: boolean,
  structured?: { captured?: { value: unknown } | undefined },
): SubagentResult {
  const own = child.session.events.slice(seedLength)
  const lastMessage = own.findLast((event): event is SessionEvent<'assistant/message'> => event.type === 'assistant/message')
  const lastEnd = findLastMessageTurnEnd(own)
  const output: ContentBlock[] = lastMessage?.data.content ?? []
  const recorded = toStopReason(lastEnd?.data.reason)
  // Disposal can tear the owner down before the loop records its ordinary
  // `aborted` end, yielding `disposed` instead. A requested cancellation owns
  // every non-completed in-flight outcome; a turn already completed stays so.
  const stopReason: SubagentStopReason = cancelled && recorded !== 'completed'
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
