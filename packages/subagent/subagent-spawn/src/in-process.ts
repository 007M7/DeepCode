/**
 * The shared in-process subagent run driver. A subagent backend that runs the
 * child as a child {@link Agent} on the SAME cordis context (`ctx.agents`) —
 * the cheapest transport, reusing the agent factory's quiescent
 * {@link AgentHandle} teardown. Both in-process backends use this:
 * `@deepseek-ai/dsh-subagent-spawn` (a fresh child) and
 * `@deepseek-ai/dsh-subagent-fork` (a child seeded with a prefix of the
 * parent's log) differ ONLY in the `seed` they pass — everything downstream
 * (drive the child, read its final output, map the stop reason, dispose) is
 * identical and lives here.
 *
 * @module @deepseek-ai/dsh-subagent-spawn/in-process
 */

import { randomUUID } from 'node:crypto'
import type { Context } from 'cordis'
import { AgentId, type Agent, type AgentHandle, type AgentOptions } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentResult, SubagentRun, SubagentStartRequest, SubagentStopReason } from '@deepseek-ai/dsh-subagent'

declare module '@deepseek-ai/dsh-agent' {
  interface AgentOptions {
    /**
     * The agent's delegation depth in the subagent tree — 0 for a top-level
     * (config/ACP-created) agent, parent depth + 1 for a subagent. Set by the
     * in-process backends on every child they create so a nested spawn reads its
     * parent's depth from `parent.options.subagentDepth` and the `depthLimit`
     * capability can cap the tree. Merge-extensible field (the seam owns it; the
     * loop neither sets nor reads it).
     */
    subagentDepth?: number
  }
}

/** Read an agent's delegation depth (absent ⇒ a top-level agent, depth 0). */
export function depthOf(agent: Agent): number {
  return agent.options.subagentDepth ?? 0
}

/** Thrown when a spawn would exceed the request's `maxDepth` cap. */
export class SubagentDepthError extends Error {
  constructor(public readonly attemptedDepth: number, public readonly maxDepth: number) {
    super(`subagent depth ${attemptedDepth} exceeds maxDepth ${maxDepth}`)
    this.name = 'SubagentDepthError'
  }
}

/** Map a session `turn/end` reason to a {@link SubagentStopReason}. */
function toStopReason(reason: TurnEndReason | undefined): SubagentStopReason {
  switch (reason?.kind) {
    case 'completed':
      return 'completed'
    case 'max-tokens':
      return 'max-tokens'
    case 'aborted':
      return 'aborted'
    // `disposed` (torn down mid-turn) and `interrupted` (crash-closed) both mean
    // the turn did not finish cleanly; surface them as a generic failure rather
    // than a clean completion. A missing reason (no turn ran) is also an error.
    case 'error':
    case 'disposed':
    case 'interrupted':
    default:
      return 'error'
  }
}

/** Extra inputs the spawn/fork backends supply to {@link startInProcessRun}. */
export interface InProcessRunOptions {
  /** The provider name (`spawn`/`fork`), for error context only. */
  readonly providerName: string
  /**
   * The child session's seed: a balanced, contiguous-from-0 prefix of the
   * parent's log (FORK), or `undefined` for a fresh child (SPAWN).
   */
  readonly seed?: SessionEvent[]
}

/**
 * Start an in-process child agent for `request` and return a {@link SubagentRun}.
 *
 * Drives the child as a one-shot: `send(prompt)` then `whenIdle()` (the ordering
 * matters — `send` enqueues synchronously, so `whenIdle` observes the queued
 * work and resolves only on the child's `running → idle` transition, never
 * before the turn starts). The final `assistant/message` is the result output,
 * the matching `turn/end.reason` the stop reason. `dispose()` delegates to the
 * factory's {@link AgentHandle.dispose} (stop loop → await quiescence → remove
 * session); `cancel()` cancels the child's in-flight turn.
 */
export function startInProcessRun(
  ctx: Context,
  request: SubagentStartRequest,
  options: InProcessRunOptions,
): SubagentRun {
  const childDepth = depthOf(request.parent) + 1
  if (request.maxDepth !== undefined && childDepth > request.maxDepth) {
    throw new SubagentDepthError(childDepth, request.maxDepth)
  }

  const childId = AgentId(randomUUID())
  const parentHeader = request.parent.session.header
  // Inherit the parent's model by default (a child with no model cannot run);
  // an explicit `request.agentOptions.model` overrides it. The parent's
  // systemPrompt is NOT inherited — a fresh child is a clean specialist unless
  // the caller supplies one.
  const agentOptions: AgentOptions = {
    ...request.parent.options.model !== undefined ? { model: request.parent.options.model } : {},
    ...request.agentOptions,
    subagentDepth: childDepth,
  }

  const handle: AgentHandle = ctx.agents.create({
    agentId: childId,
    sessionId: SessionId(randomUUID()),
    meta: {
      ...parentHeader.cwd !== undefined ? { cwd: parentHeader.cwd } : {},
      parentSession: parentHeader.id,
    },
    ...options.seed !== undefined ? { seed: options.seed } : {},
    agentOptions,
  })
  const child = handle.agent

  // Bridge the request's abort signal to the child (the consumer also bridges
  // its own exec.signal, but a backend-level bridge keeps the contract local).
  const onAbort = (): void => { child.cancel('subagent cancelled') }
  request.signal?.addEventListener('abort', onAbort, { once: true })

  const result: Promise<SubagentResult> = (async () => {
    try {
      child.send(request.prompt)
      await child.whenIdle()
      return readResult(child)
    } finally {
      request.signal?.removeEventListener('abort', onAbort)
    }
  })()

  return {
    id: childId,
    result,
    cancel(reason?: string): void {
      child.cancel(reason ?? 'subagent cancelled')
    },
    async dispose(): Promise<void> {
      request.signal?.removeEventListener('abort', onAbort)
      await handle.dispose()
    },
  }
}

/**
 * Read a settled child's terminal result from its session log: the last
 * `assistant/message` content (deep-cloned — the log is frozen) and the last
 * `turn/end` reason mapped to a {@link SubagentStopReason}.
 */
function readResult(child: Agent): SubagentResult {
  const events = child.session.events
  const lastMessage = events.findLast((e): e is SessionEvent<'assistant/message'> => e.type === 'assistant/message')
  const lastEnd = events.findLast((e): e is SessionEvent<'turn/end'> => e.type === 'turn/end')
  const output: ContentBlock[] = lastMessage ? structuredClone(lastMessage.data.content) : []
  return { output, stopReason: toStopReason(lastEnd?.data.reason) }
}
