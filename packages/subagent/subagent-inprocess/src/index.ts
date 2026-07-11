/**
 * The shared in-process subagent run driver: run a child as a child
 * {@link Agent} on the SAME cordis context (`ctx.agents`) — the cheapest
 * transport, reusing the agent factory's quiescent {@link AgentHandle}
 * teardown. The concrete in-process backends are thin shells over this driver,
 * differing ONLY in the `seed` they pass (a fresh child vs. a child seeded with
 * a prefix of the parent's log); everything downstream — drive the child, read
 * its final output, map the stop reason, dispose — is identical and lives here.
 *
 * This package declares no provider and performs no import-time registration;
 * it is a library the backend packages depend on, so neither backend needs to
 * know about the other. Each accepted run does install one provider-owned
 * effect for structured-concurrency cleanup.
 *
 * @module @deepseek-ai/dsh-subagent-inprocess
 */

import { randomUUID } from 'node:crypto'
import type { Context, Fiber } from 'cordis'
import { AgentId, type Agent, type AgentHandle, type AgentOptions } from '@deepseek-ai/dsh-agent'
import { SessionId, snapshotJsonValue, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { assertSupportedOutputSchema, OutputSchemaError } from '@deepseek-ai/dsh-tools'
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
 * Drives the child as a one-shot: `send(prompt)` then `whenIdle()` (the ordering
 * matters — `send` enqueues synchronously, so `whenIdle` observes the queued
 * work and resolves only on the child's `running → idle` transition, never
 * before the turn starts). The final `assistant/message` is the result output,
 * the matching `turn/end.reason` the stop reason. `dispose()` delegates to the
 * factory's {@link AgentHandle.dispose} (stop loop → await quiescence → remove
 * session); `cancel()` cancels the child's in-flight turn.
 *
 * Throws {@link SubagentDepthError} before creating anything when the child's
 * depth (parent depth + 1) would exceed `request.maxDepth`.
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
  // Capture every top-level field once. Parent/signal are identity capabilities;
  // every data value is materialized below before asynchronous owner setup.
  const parent = request.parent
  const signal = request.signal
  const persona = request.persona
  const inputToolFilter = request.toolFilter
  const inputMaxDepth = request.maxDepth
  const inputSchema = request.outputSchema
  const inputPrompt = request.prompt
  const inputAgentOptions = request.agentOptions
  const inputSeed = options.seed
  const toolFilter = inputToolFilter === undefined ? undefined : snapshotJsonValue(inputToolFilter)
  if (inputToolFilter !== undefined && toolFilter === undefined) {
    throw new TypeError('subagent tool filter must be losslessly JSON-serializable')
  }
  const seed = inputSeed === undefined ? undefined : snapshotJsonValue(inputSeed)
  if (inputSeed !== undefined && seed === undefined) {
    throw new TypeError('subagent seed must be losslessly JSON-serializable')
  }
  const childDepth = depthOf(parent) + 1
  if (inputMaxDepth !== undefined && childDepth > inputMaxDepth) {
    throw new SubagentDepthError(childDepth, inputMaxDepth)
  }
  const requestedAgentOptions = inputAgentOptions === undefined
    ? {}
    : snapshotJsonValue(inputAgentOptions)
  if (requestedAgentOptions === undefined) {
    throw new TypeError('subagent agent options must be losslessly JSON-serializable')
  }
  // Materialize, then assert, the schema subset BEFORE any child exists. The
  // single traversal rejects non-JSON data without rereading accessors; the
  // detached value then pins assertion, model-visible parameters, and runtime
  // validation to one provider-owned schema. Contract failures stay typed as
  // OutputSchemaError rather than leaking a materialization detail.
  const schema = inputSchema === undefined ? undefined : snapshotJsonValue(inputSchema)
  if (inputSchema !== undefined && schema === undefined) {
    throw new OutputSchemaError(['schema annotation must be JSON data; the complete schema must be losslessly JSON-serializable'])
  }
  if (schema !== undefined) assertSupportedOutputSchema(schema)
  // The accepted request owns a value snapshot, not the caller's mutable
  // content array. Use the same one-pass boundary Session.append enforces before
  // any child exists so later mutation cannot change what is logged or sent.
  const prompt = snapshotJsonValue(inputPrompt)
  if (prompt === undefined) {
    throw new TypeError('subagent prompt must be losslessly JSON-serializable')
  }

  const childId = AgentId(randomUUID())
  // The child's OWN events begin after the seed (fork seeds the parent's
  // completed-turn prefix; spawn seeds nothing). `readResult` scopes to this
  // boundary so a child that produces no message of its own never returns the
  // SEEDED parent's last assistant message as its result.
  const seedLength = seed?.length ?? 0
  const parentHeader = parent.session.header
  // Inherit the parent's model by default (a child with no model cannot run);
  // an explicit `request.agentOptions.model` overrides it. The deployment
  // persona needs no inheritance (a context-wide section both render); a
  // per-child `request.persona` becomes a SCOPED section of the same name in
  // the setup below, shadowing the deployment's for this child alone.
  const parentModel = parent.options.model
  const agentOptions = snapshotJsonValue<AgentOptions>({
    ...parentModel !== undefined ? { model: parentModel } : {},
    ...requestedAgentOptions,
    subagentDepth: childDepth,
  })
  if (agentOptions === undefined) {
    throw new TypeError('subagent agent options must be losslessly JSON-serializable')
  }

  // The child's scoped world, composed in the factory's unpublished setup
  // window. The factory awaits it before inserting or announcing the child, so
  // a throw/rejection exposes neither id and every first assembly sees it:
  //  - persona: a scoped `deployment:persona` section shadowing the global one;
  //  - toolFilter: a scoped restrict() masking the global tool surface
  //    (loud unknown-name validation lives in the registry);
  //  - outputSchema: the structured runtime, attached as scoped registrations.
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

  // Bridge the request's abort signal to the child (the consumer also bridges
  // its own exec.signal, but a backend-level bridge keeps the contract local).
  // Install it after provider ownership succeeds but BEFORE awaiting creation,
  // so an inactive provider cannot leave an orphaned listener and abort/dispose
  // during async setup is still recorded and applied the moment a child exists.
  // `cancelled` records that a cancel was requested at all, so the pre-turn
  // cancel window — where the child clears the queued prompt before any
  // `turn/end` is logged — settles as `aborted` (honoring the cancel contract)
  // rather than falling through to the no-turn `error` mapping.
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

  // One run-owned Cordis fiber is the common ownership node. Install the
  // provider effect FIRST: a start racing an already-unloading provider fails
  // before it can mint anything under the parent. The owner fiber is then
  // nested under the parent scope, and the provider/run handle both dispose
  // this exact fiber. AgentFactory binds its lifecycle to `ownerCtx`, so any of
  // the three owners moves the fiber out of ACTIVE synchronously and setup
  // cannot publish afterward.
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
    // Invoke the factory THROUGH the parent scope. Cordis binds the factory's
    // lifecycle effect to the accessing context, so parent ownership exists
    // before persistence/setup and publication—not as a fallible link added
    // after the child is already visible. A disposed parent therefore rejects
    // before any session/agent notification, and disposal during async setup
    // wins the unpublished transaction.
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

  // Provider readiness is a distinct lifecycle boundary from accepting the
  // request. It resolves only after the factory has published the child and
  // returned its handle, so SubagentService can emit `subagent/start` while
  // `ctx.agents.get(childId)` is guaranteed to resolve. The result path awaits
  // THIS SAME promise immediately, which also observes a readiness rejection
  // when the driver is invoked directly rather than through SubagentService.
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
    // No capture on a cleanly-completed turn: an ERROR when the run was left
    // to finish (the nudges ran out), but ABORTED when a cancel is why the
    // nudging stopped — the cancel contract outranks the schema shortfall.
    if (stopReason === 'completed') return { output, stopReason: cancelled ? 'aborted' : 'error' }
  }
  return { output, stopReason }
}
