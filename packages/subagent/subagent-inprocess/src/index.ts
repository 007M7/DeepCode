/**
 * The shared in-process subagent run driver: run a child as a child
 * {@link Agent} on the SAME cordis context (`ctx.agents`) — the cheapest
 * transport, reusing the agent factory's quiescent {@link AgentHandle}
 * teardown. The concrete in-process backends are thin shells over this driver,
 * differing ONLY in the `seed` they pass (a fresh child vs. a child seeded with
 * a prefix of the parent's log); everything downstream — drive the child, read
 * its final output, map the stop reason, dispose — is identical and lives here.
 *
 * This package owns no provider and registers nothing; it is a pure library the
 * backend packages depend on, so neither backend needs to know about the other.
 *
 * @module @deepseek-ai/dsh-subagent-inprocess
 */

import { randomUUID } from 'node:crypto'
import type { Context } from 'cordis'
import { AgentId, type Agent, type AgentHandle, type AgentOptions } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { assertSupportedOutputSchema } from '@deepseek-ai/dsh-tools'
import type { SubagentResult, SubagentRun, SubagentStartRequest, SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import {
  acquireStructuredRuntime,
  STRUCTURED_OUTPUT_NUDGE,
  type StructuredAcquisition,
} from './structured.ts'

export {
  acquireStructuredRuntime,
  STRUCTURED_OUTPUT_TOOL,
  STRUCTURED_OUTPUT_INSTRUCTION,
  STRUCTURED_OUTPUT_NUDGE,
  type StructuredAcquisition,
} from './structured.ts'

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
  /**
   * How many times a structured run re-prompts a child that finished a turn
   * cleanly WITHOUT calling `structured_output` (see the structured module).
   * REQUIRED, resolved from the backend's validated Config — per the explicit-
   * defaulting rule, the driver never fills it with a hidden fallback.
   */
  readonly structuredNudgeRetries: number
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
  // Assert the schema subset BEFORE any child exists (the service has already
  // capability-gated; this rejects a schema outside the enforced subset loud).
  const schema = request.outputSchema
  if (schema !== undefined) assertSupportedOutputSchema(schema)

  const childId = AgentId(randomUUID())
  // The child's OWN events begin after the seed (fork seeds the parent's
  // completed-turn prefix; spawn seeds nothing). `readResult` scopes to this
  // boundary so a child that produces no message of its own never returns the
  // SEEDED parent's last assistant message as its result.
  const seedLength = options.seed?.length ?? 0
  const parentHeader = request.parent.session.header
  // Inherit the parent's model by default (a child with no model cannot run);
  // an explicit `request.agentOptions.model` overrides it. The persona needs
  // no inheritance: the deployment persona is a context-wide prompt section,
  // so parent and child render the same one. A structured run's
  // structured_output instruction is NOT prompt state either — the structured
  // runtime's final-request listener appends it per request (see structured.ts).
  const agentOptions: AgentOptions = {
    ...request.parent.options.model !== undefined ? { model: request.parent.options.model } : {},
    ...request.agentOptions,
    subagentDepth: childDepth,
  }

  // The structured runtime is held for the WHOLE run (acquired before the child
  // exists, released when the result settles), so a backend hot-reload mid-run
  // cannot unregister the capture tool out from under this live child.
  const structured: StructuredAcquisition | undefined = schema !== undefined ? acquireStructuredRuntime(ctx) : undefined

  const handle: AgentHandle = ctx.agents.create({
    agentId: childId,
    sessionId: SessionId(randomUUID()),
    meta: {
      ...parentHeader.cwd !== undefined ? { cwd: parentHeader.cwd } : {},
      parentSession: parentHeader.id,
      // Record the seed boundary so a reload (and a replay harness) can tell the
      // inherited prefix from the child's OWN events. 0 for a fresh spawn.
      ...seedLength > 0 ? { seedLength } : {},
    },
    ...options.seed !== undefined ? { seed: options.seed } : {},
    agentOptions,
  })
  const child = handle.agent
  if (structured && schema !== undefined) structured.attach(child, schema)

  // Bridge the request's abort signal to the child (the consumer also bridges
  // its own exec.signal, but a backend-level bridge keeps the contract local).
  // `cancelled` records that a cancel was requested at all, so the pre-turn
  // cancel window — where the child clears the queued prompt before any
  // `turn/end` is logged — settles as `aborted` (honoring the cancel contract)
  // rather than falling through to the no-turn `error` mapping.
  let cancelled = false
  const requestCancel = (reason: string): void => {
    cancelled = true
    child.cancel(reason)
  }
  const onAbort = (): void => { requestCancel('subagent cancelled') }
  request.signal?.addEventListener('abort', onAbort, { once: true })

  const result: Promise<SubagentResult> = (async () => {
    try {
      // A signal already aborted BEFORE the run starts never fires an `abort`
      // event (`addEventListener` only fires on the transition), so the listener
      // above won't catch it — settle `aborted` without running the child rather
      // than completing an already-cancelled request.
      if (request.signal?.aborted) return { output: [], stopReason: 'aborted' }
      child.send(request.prompt)
      await child.whenIdle()
      if (structured) {
        // Nudge loop: a child that finished a turn CLEANLY without calling
        // structured_output gets re-prompted, up to the backend-configured
        // retry count. An errored/aborted turn is not nudged — its failure is
        // the honest result. (This also covers a cancel: a cancelled turn ends
        // `aborted`, and a pre-turn cancel leaves no `turn/end` at all, so
        // neither reads `completed`.)
        let nudges = options.structuredNudgeRetries
        while (
          structured.captured(child) === undefined && nudges > 0
          && lastOwnTurnEnd(child, seedLength)?.data.reason.kind === 'completed'
        ) {
          nudges -= 1
          child.send([{ type: 'text', text: STRUCTURED_OUTPUT_NUDGE }])
          await child.whenIdle()
        }
      }
      return readResult(child, seedLength, cancelled, structured ? { captured: structured.captured(child) } : undefined)
    } finally {
      request.signal?.removeEventListener('abort', onAbort)
      if (structured) {
        structured.detach(child)
        structured.release()
      }
    }
  })()

  return {
    id: childId,
    result,
    cancel(reason?: string): void {
      requestCancel(reason ?? 'subagent cancelled')
    },
    async dispose(): Promise<void> {
      request.signal?.removeEventListener('abort', onAbort)
      await handle.dispose()
    },
  }
}

/** The child's OWN last `turn/end` event (events at or after `seedLength`), if any. */
function lastOwnTurnEnd(child: Agent, seedLength: number): SessionEvent<'turn/end'> | undefined {
  return child.session.events.slice(seedLength)
    .findLast((e): e is SessionEvent<'turn/end'> => e.type === 'turn/end')
}

/**
 * Read a settled child's terminal result from its session log, scoped to the
 * child's OWN events (everything at or after `seedLength` — fork seeds the
 * parent's completed-turn prefix, so a child that produced no message of its
 * own must NOT return the seeded parent's last assistant message). The output
 * is the child's last `assistant/message` content (deep-cloned — the log is
 * frozen); the stop reason is the child's last `turn/end` reason mapped to a
 * {@link SubagentStopReason}. When `cancelled` is set but no `turn/end` was
 * logged (a cancel landed in the pre-turn window, before any turn ran), the
 * run settles `aborted` per the {@link SubagentRun.cancel} contract rather than
 * the generic no-turn `error`.
 *
 * A structured run (`structured` present) additionally reports the captured
 * value on {@link SubagentResult.structured}. A structured child that finished
 * CLEANLY without ever capturing (the nudges ran out) settles `error` — a clean
 * finish without the demanded structured result is a failure, not a success
 * with a missing field; a non-`completed` reason keeps its own honest mapping.
 */
function readResult(
  child: Agent,
  seedLength: number,
  cancelled: boolean,
  structured?: { captured?: { value: unknown } | undefined },
): SubagentResult {
  const own = child.session.events.slice(seedLength)
  const lastMessage = own.findLast((e): e is SessionEvent<'assistant/message'> => e.type === 'assistant/message')
  const lastEnd = own.findLast((e): e is SessionEvent<'turn/end'> => e.type === 'turn/end')
  const output: ContentBlock[] = lastMessage ? structuredClone(lastMessage.data.content) : []
  const stopReason: SubagentStopReason = lastEnd === undefined && cancelled
    ? 'aborted'
    : toStopReason(lastEnd?.data.reason)
  if (structured) {
    if (structured.captured) return { output, structured: structured.captured.value, stopReason }
    if (stopReason === 'completed') return { output, stopReason: 'error' }
  }
  return { output, stopReason }
}
