/**
 * The shared in-process subagent run driver: run a child as a child {@link Agent} on the same
 * cordis context (`ctx.agents`) — the cheapest transport, reusing the agent factory's
 * quiescent {@link AgentHandle} teardown.
 * @module @deepseek-ai/dsh-subagent-inprocess
 */

import { randomUUID } from 'node:crypto'
import type { Context, Fiber } from 'cordis'
import { AgentId, type Agent, type AgentHandle, type AgentOptions } from '@deepseek-ai/dsh-agent'
import { SessionId, isJsonValue, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { assertSupportedOutputSchema } from '@deepseek-ai/dsh-tools'
import type { SubagentResult, SubagentRun, SubagentStartRequest, SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import {
  attachStructuredRuntime,
  type StructuredAttachment,
} from './structured.ts'

// The runtime itself (attach) is package-internal: runs attach it inside
// startInProcessRun's setup window, and no other package drives it. Only the
// model-facing vocabulary is public.
export {
  STRUCTURED_OUTPUT_TOOL,
  STRUCTURED_OUTPUT_INSTRUCTION,
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

/**
 * Read an agent's delegation depth (absent ⇒ a top-level agent, depth 0).
 * @param agent - the agent whose options may carry `subagentDepth`.
 * @returns 0 for a top-level agent, its parent's depth + 1 for a subagent.
 */
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
    // `disposed` (torn down mid-turn) and `interrupted` (crash-closed) both mean the turn did
    // not finish cleanly; surface them as a generic failure rather than a clean completion.
    case 'error':
    case 'disposed':
    case 'interrupted':
    default:
      return 'error'
  }
}

/** Extra inputs the spawn/fork backends supply to {@link startInProcessRun}. */
export interface InProcessRunOptions {
  /**
   * The child session's seed: a balanced, contiguous-from-0 prefix of the
   * parent's log (FORK), or `undefined` for a fresh child (SPAWN).
   */
  readonly seed?: SessionEvent[]
}

/** Dispose a run-owner fiber and follow an already-started unload to quiescence. */
async function quiesceFiber(fiber: Fiber): Promise<void> {
  await Promise.resolve(fiber.dispose())
  while (fiber.inertia !== undefined) await fiber.inertia
}

/**
 * Start an in-process child agent for `request` and return a {@link SubagentRun}.
 *
 * @param ctx - the provider context that owns the live run as a second
 *   structured-concurrency boundary alongside the parent agent.
 * @param request - the start request (prompt, parent, signal, per-child options).
 * @param options - the backend's optional child-session seed.
 * @returns the live run handle for the child agent.
 */
export function startInProcessRun(
  ctx: Context,
  request: SubagentStartRequest,
  options: InProcessRunOptions,
): SubagentRun {
  // Snapshot the accepted request synchronously. The parent and signal are
  // identity capabilities (kept live but never reread from the mutable request
  // record); every data field is detached before asynchronous owner setup.
  const parent = request.parent
  const signal = request.signal
  const persona = request.persona
  const toolFilter = request.toolFilter === undefined ? undefined : structuredClone(request.toolFilter)
  const seed = options.seed === undefined ? undefined : structuredClone(options.seed)
  const childDepth = depthOf(parent) + 1
  if (request.maxDepth !== undefined && childDepth > request.maxDepth) {
    throw new SubagentDepthError(childDepth, request.maxDepth)
  }
  // Assert, then snapshot, the schema subset before any child exists (the service has already
  // capability-gated; this rejects a schema outside the enforced subset loud).
  if (request.outputSchema !== undefined) assertSupportedOutputSchema(request.outputSchema)
  const schema = request.outputSchema === undefined ? undefined : structuredClone(request.outputSchema)
  // The accepted request owns a value snapshot, not the caller's mutable content array.
  if (!isJsonValue(request.prompt)) {
    throw new TypeError('subagent prompt must be losslessly JSON-serializable')
  }
  const prompt = structuredClone(request.prompt)
  if (!isJsonValue(prompt)) {
    throw new TypeError('subagent prompt must be stable losslessly JSON-serializable data')
  }

  const childId = AgentId(randomUUID())
  // The child's OWN events begin after the seed (fork seeds the parent's
  // completed-turn prefix; spawn seeds nothing). `readResult` scopes to this
  // boundary so a child that produces no message of its own never returns the
  // SEEDED parent's last assistant message as its result.
  const seedLength = options.seed?.length ?? 0
  const parentHeader = parent.session.header
  // Inherit the parent's model by default (a child with no model cannot run); an explicit
  // `request.agentOptions.model` overrides it.
  const agentOptions: AgentOptions = structuredClone({
    ...parent.options.model !== undefined ? { model: parent.options.model } : {},
    ...request.agentOptions,
    subagentDepth: childDepth,
  })

  // The child's scoped world, composed in the factory's unpublished setup window.
  let structured: StructuredAttachment | undefined
  const setup = (childCtx: Context): void => {
    if (persona !== undefined) {
      childCtx.systemPrompt.section({ name: 'deployment:persona', order: 0, text: persona })
    }
    if (toolFilter !== undefined) {
      childCtx.tools.restrict(toolFilter)
    }
    if (schema !== undefined) {
      structured = attachStructuredRuntime(childCtx, schema)
    }
  }

  // Bridge the request's abort signal to the child (the consumer also bridges its own
  // exec.signal, but a backend-level bridge keeps the contract local).
  let cancelled = false
  // An accessor, not an inline read: `cancelled` mutates from closures (the
  // abort listener, run.cancel), which control-flow narrowing cannot see — an
  // inline read at the result mapping would narrow to the initializer.
  const isCancelled = (): boolean => cancelled
  let child: Agent | undefined
  let handle: AgentHandle | undefined
  let disposeRequested = false
  const isDisposeRequested = (): boolean => disposeRequested
  const requestCancel = (reason: string): void => {
    cancelled = true
    child?.cancel(reason)
  }
  const onAbort = (): void => { requestCancel('subagent cancelled') }

  // One run-owned Cordis fiber is the common ownership node.
  let ownerCtx: Context | undefined
  function subagentRunOwner(inner: Context): void { ownerCtx = inner }
  let ownerFiber: (Fiber & PromiseLike<Fiber>) | undefined
  let ownerSetupError: unknown
  let ownerDisposing: Promise<void> | undefined
  const disposeOwner = (): Promise<void> => (ownerDisposing ??= ownerFiber === undefined
    ? Promise.resolve()
    : quiesceFiber(ownerFiber))
  let manualDisposeRequested = false
  const isManualDisposeRequested = (): boolean => manualDisposeRequested
  const unlinkProvider = ctx.effect(() => () => {
    requestCancel('subagent provider disposed')
    return disposeOwner()
  }, 'subagent-inprocess.run()')
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) requestCancel('subagent cancelled')
  try {
    ownerFiber = parent.ctx.plugin(Object.assign(subagentRunOwner, {
      inject: ['agents', 'sessions', 'llm', 'tools', 'systemPrompt'],
    }))
  } catch (error: unknown) {
    ownerSetupError = error
  }

  const creation: Promise<Agent> = (async () => {
    if (ownerSetupError !== undefined) {
      throw ownerSetupError instanceof Error
        ? ownerSetupError
        : new Error('subagent run owner setup failed with a non-Error value', { cause: ownerSetupError })
    }
    await ownerFiber
    if (ownerCtx === undefined) {
      throw new Error('subagent run owner became inactive before child creation')
    }
    // Invoke the factory THROUGH the parent scope.
    const created = await ownerCtx.agents.create({
      agentId: childId,
      sessionId: SessionId(randomUUID()),
      meta: {
        ...parentHeader.cwd !== undefined ? { cwd: parentHeader.cwd } : {},
        parentSession: parentHeader.id,
        ...seedLength > 0 ? { seedLength } : {},
      },
      ...seed !== undefined ? { seed } : {},
      agentOptions,
      setup,
    })
    handle = created
    child = created.agent

    if (isCancelled()) created.agent.cancel('subagent cancelled')
    return created.agent
  })()

  // Provider readiness is a distinct lifecycle boundary from accepting the request.
  const started: Promise<void> = creation.then(() => undefined)

  const result: Promise<SubagentResult> = (async () => {
    try {
      let liveChild: Agent
      try {
        await started
        // `creation` assigns `child` before it fulfills, and `started` is its
        // direct fulfillment projection. The cast records that local invariant
        // without manufacturing an unreachable runtime branch.
        liveChild = child as Agent
      } catch (error: unknown) {
        if (isManualDisposeRequested()) return { output: [], stopReason: 'aborted' }
        throw error instanceof Error ? error : new Error('subagent child creation failed with a non-Error value', { cause: error })
      }
      if (isCancelled() || isDisposeRequested()) return { output: [], stopReason: 'aborted' }
      liveChild.send(prompt)
      await liveChild.whenIdle()
      // Deliberately NO re-prompt when a structured child finishes cleanly
      // without calling structured_output: readResult maps that to `error` —
      // the shortfall goes to the parent instead of buying extra model turns.
      return readResult(liveChild, seedLength, isCancelled(), structured ? { captured: structured.captured() } : undefined)
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  })()

  let disposing: Promise<void> | undefined
  return {
    id: childId,
    started,
    result,
    cancel(reason?: string): void {
      requestCancel(reason ?? 'subagent cancelled')
    },
    async dispose(): Promise<void> {
      return (disposing ??= (async () => {
        signal?.removeEventListener('abort', onAbort)
        disposeRequested = true
        manualDisposeRequested = true
        requestCancel('subagent disposed during creation')
        // Removing provider ownership and disposing the common run-owner fiber
        // are the same quiescence transaction; parent disposal may already have
        // claimed it, in which case disposeOwner follows fiber inertia.
        await unlinkProvider()
        try {
          await creation
        } catch {
          // Creation rollback already reached quiescence; there is no handle
          // left to dispose, and dispose must not mask result's infrastructure
          // rejection with the same error from a finally block.
          return
        }
        await disposeOwner()
        await handle?.dispose()
      })())
    },
  }
}

/**
 * Read a settled child's terminal result from its session log, scoped to the child's own
 * events (everything at or after `seedLength` — fork seeds the parent's completed-turn prefix,
 * so a child that produced no message of its own must not return the seeded parent's last
 * assistant message).
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
    // No capture on a cleanly-completed turn: an ERROR when the run was left
    // to finish (the nudges ran out), but ABORTED when a cancel is why the
    // nudging stopped — the cancel contract outranks the schema shortfall.
    if (stopReason === 'completed') return { output, stopReason: cancelled ? 'aborted' : 'error' }
  }
  return { output, stopReason }
}
