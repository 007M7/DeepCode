/**
 * Internal continuable-subagent manager: stable child ids, descriptor
 * persistence and lookup by known child id, Task-backed activation, and
 * steer-or-resume message routing behind `ctx.subagents`.
 *
 * Every continuable activation — initial or resumed, parent- or human-started
 * — has exactly one Task and one result. Task settlement awaits the child
 * result, disposes the run, and only then records the outcome, so a terminal
 * Task leaves the durable child session but no live child Agent. Cancellation
 * targets the whole activation: parent and human messages that joined one
 * turn share its result and its `killed` outcome.
 *
 * @module @deepseek-ai/dsh-subagent
 */

import { randomUUID } from 'node:crypto'
import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { foldSubagentDescriptor, snapshotSubagentDescriptor } from './descriptor.ts'
import type {
  SubagentProviderResumeRequest,
  SubagentProviderStartRequest,
  SubagentResult,
  SubagentRun,
  SubagentStartRequest,
} from './types.ts'
import type { TaskHooks, TaskId, TaskOutcome } from '@deepseek-ai/dsh-tasks'
import { SubagentError } from './error.ts'

/** Attribution for a model coordinator's follow-up to one of its children. */
export interface CoordinatorMessageSource {
  readonly kind: 'coordinator'
  /** Session id of the agent whose tool call produced the follow-up. */
  readonly senderSessionId: SessionId
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    coordinator: CoordinatorMessageSource
  }
}

/** What a caller asks for when starting a continuable background child. */
export interface ContinuableStartSpec {
  /** The `ctx.subagents` provider to establish the child on. */
  readonly provider: string
  /** One-line model-facing Task label (the delegation description). */
  readonly label: string
  /**
   * The delegation request. The service resolves the stable child id and the
   * durable descriptor, then supplies the Task-owned cancellation signal and
   * `continuation` itself.
   */
  readonly request: Omit<SubagentStartRequest, 'signal'>
}

/** Identities returned by a continuable start. */
export interface ContinuableStart {
  /** The durable child session id, stable across activations. */
  readonly childId: SessionId
  /** The initial activation's Task id. */
  readonly taskId: TaskId
}

/**
 * Options for following up with one continuable child.
 */
export interface SubagentFollowupOptions {
  /** Durable attribution retained on either live or resumed delivery. */
  readonly source: MessageSource
  /** Caller cancellation for a live-delivery admission wait. */
  readonly signal: AbortSignal
}

/**
 * How a continuable follow-up was routed:
 * `steered` joined the running activation's existing Task without creating a
 * Task of its own; `started` created a fresh Task that cold-resumes the
 * durable child with the content. Failure is an exception, never a result —
 * undelivered content throws.
 */
export type SubagentFollowupResult =
  | { readonly route: 'steered'; readonly taskId: TaskId }
  | { readonly route: 'started'; readonly taskId: TaskId }

type StartProvider = (name: string, request: SubagentProviderStartRequest) => Promise<SubagentRun>
type ResumeProvider = (request: SubagentProviderResumeRequest) => Promise<SubagentRun>

/**
 * One child's current process-local activation: its Task and, after provider
 * publication, its run. Installed before any provider or persistence await
 * and removed only after run disposal and Task terminal publication. This
 * exists solely so parent and human senders can find the same activation — it
 * is not a durable catalog, admission reservation, or run-state machine.
 */
interface ActiveActivation {
  /** Assigned in the same synchronous frame as the install, when the Task registers. */
  taskId: TaskId | undefined
  /** Filled when the provider publishes; `undefined` while starting or resuming. */
  run: SubagentRun | undefined
  /** The activation-owned cancellation authority, created before any await. */
  readonly controller: AbortController
  /** The producer's settlement (run disposed, outcome produced); assigned when the Task registers. */
  done: Promise<TaskOutcome> | undefined
  /** Resolved by the completion listener when the Task's terminal snapshot is recorded. */
  readonly terminal: PromiseWithResolvers<void>
}

/**
 * Map a child result to the task outcome: completed carries final text,
 * aborted is killed, and every other reason is failed without partial output.
 * @param result - child terminal result.
 * @returns outcome for the `ctx.tasks` registration.
 */
function runOutcome(result: SubagentResult): TaskOutcome {
  switch (result.stopReason) {
    case 'completed':
      return { status: 'completed', output: finalText(result.output) }
    case 'aborted':
      return { status: 'killed' }
    case 'error':
    case 'max-tokens':
    case 'refusal':
      return { status: 'failed', detail: result.stopReason }
    // Merge-extensible reasons remain failures with their raw detail.
    default:
      return { status: 'failed', detail: String(result.stopReason) }
  }
}

/** Render infrastructure failure detail without hiding a durability diagnosis. */
function runFailureDetail(error: unknown): string {
  return error instanceof HarnessError && error.code === 'DURABILITY_FAILED'
    ? error.message
    : String(error)
}

/**
 * Await the child result, dispose the run, then return its task outcome. Result
 * and disposal failures become `failed`; when both fail, both details survive.
 * @param run - live run to settle and release.
 * @returns outcome after child resources are released.
 */
export async function settleRun(run: SubagentRun): Promise<TaskOutcome> {
  let outcome: TaskOutcome
  try {
    outcome = runOutcome(await run.result)
  } catch (error: unknown) {
    outcome = { status: 'failed', detail: runFailureDetail(error) }
  }
  try {
    await run.dispose()
  } catch (error: unknown) {
    const prefix = outcome.detail === undefined ? '' : `${outcome.detail}; `
    return { status: 'failed', detail: `${prefix}dispose failed: ${String(error)}` }
  }
  return outcome
}

/** Flatten a child's final output blocks to the task's final text. */
function finalText(blocks: ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * The continuable-subagent orchestration service. Tool schema and UI adapters
 * are consumers of this one contract: parent and human messages route through
 * {@link followup} and share one activation result and cancellation
 * boundary, while foreground one-shot delegation keeps calling
 * `ctx.subagents.start()` directly.
 */
export class SubagentContinuationManager {
  /** Child session id → its current activation. Process-local, never durable. */
  private activations = new Map<SessionId, ActiveActivation>()

  constructor(
    private readonly ctx: Context,
    private readonly startProvider: StartProvider,
    private readonly resumeProvider: ResumeProvider,
  ) {
    // Terminal publication is one of the two removal conditions. The exact
    // Task id pins the resolution to this activation, never a later same-child one.
    ctx.tasks.onTaskDone((snapshot) => {
      for (const activation of this.activations.values()) {
        if (activation.taskId === snapshot.id) activation.terminal.resolve()
      }
    })
    // TaskService deliberately keeps producer Tasks alive across a
    // follow-up-tool or producer reload, so this manager's disposal must not
    // strand the activations it can no longer route to: cancel each one and
    // await producer settlement (run disposal) before releasing the map. The
    // effect-scoped onTaskDone listener above is already gone by then, so
    // terminal publication is resolved here instead of waiting forever.
    ctx.effect(() => async () => {
      const active = [...this.activations.values()]
      this.activations.clear()
      for (const activation of active) {
        activation.controller.abort('subagent continuation manager disposed')
        activation.terminal.resolve()
      }
      await Promise.allSettled(active.map((activation) => {
        /* v8 ignore next 2 -- TaskService invokes `run` synchronously before `start` returns;
         * every retained activation has `done`, while registration failure removes it. */
        if (activation.done === undefined) return Promise.resolve()
        return activation.done
      }))
    }, 'subagents.continuations()')
  }

  /**
   * Start a continuable background child: allocate its stable session id,
   * snapshot its durable descriptor, and register the initial activation's
   * Task. A synchronous validation failure (a non-JSON descriptor input,
   * missing persistence, Task preflight) throws without creating a Task; the
   * method otherwise returns both identities immediately, without waiting for
   * child publication or descriptor durability. Asynchronous startup failure
   * settles the returned Task as `failed` (or `killed` when cancelled) after
   * any published run is disposed, which can leave an unmaterialized child id
   * that later by-id operations report as unavailable.
   * @param spec - provider, Task label, and the delegation request.
   * @returns the stable child id and the initial activation's Task id.
   */
  startContinuable(spec: ContinuableStartSpec): ContinuableStart {
    this.requirePersistence()
    const childId = SessionId(randomUUID())
    const request = spec.request
    // Snapshot before Task creation: invalid descriptor JSON rejects the call
    // with no Task, and the detached value is what reaches the child log.
    const agentProvider = request.agentOptions?.provider ?? request.parent.options.provider
    const agentModel = request.agentOptions?.model ?? request.parent.options.model
    const descriptor = snapshotSubagentDescriptor({
      provider: spec.provider,
      ...agentProvider !== undefined ? { agentProvider } : {},
      ...agentModel !== undefined ? { agentModel } : {},
      ...request.persona !== undefined ? { persona: request.persona } : {},
      ...request.toolFilter !== undefined ? { toolFilter: request.toolFilter } : {},
    })
    const taskId = this.startActivation(childId, spec.label, request.parent, signal =>
      this.startProvider(spec.provider, {
        ...request,
        signal,
        continuation: { sessionId: childId, descriptor },
      }))
    return { childId, taskId }
  }

  /**
   * Follow up with a known continuable child: steer its running
   * activation, or cold-resume the durable session into a fresh Task-backed
   * activation. The two routes are reported distinctly so timing-dependent
   * routing is observable. Rejection means the message was NOT delivered — in
   * particular, losing a race with Task settlement does not fall through to
   * cold resume within the same call; a later retry after Task terminal may
   * start the next activation. The started Task owns descriptor lookup and
   * direct-parent authorization (its AbortSignal exists before that lookup),
   * so an unknown, foreign, or descriptor-less child settles the started Task
   * as `failed` with a detail reporting the id as unavailable.
   * @param parent - the live parent agent sending the message (model tool or
   *   human adapter); Task access is authorized by its session id.
   * @param childId - the stable child session id.
   * @param content - the user-role content to deliver.
   * @param options - caller attribution and cancellation. During live delivery,
   *   abort cancels the shared activation and rejects only after quiescence.
   * @returns whether the content `steered` the existing Task or `started` a new one.
   */
  async followup(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: SubagentFollowupOptions,
  ): Promise<SubagentFollowupResult> {
    this.assertOwnership(childId)
    const activation = this.activations.get(childId)
    if (activation !== undefined) {
      return {
        route: 'steered',
        taskId: await this.steerActivation(
          activation,
          parent,
          childId,
          content,
          options.source,
          options.signal,
        ),
      }
    }
    return {
      route: 'started',
      taskId: this.resumeActivation(parent, childId, content, options.source),
    }
  }

  /**
   * Synchronous ownership compare before any by-id routing: a live registry
   * Agent outside the association — or different from the associated run's
   * agent — was started by something else. Fail instead of adopting an idle
   * Agent or attaching an untracked turn.
   */
  private assertOwnership(childId: SessionId): void {
    const live = this.ctx.agents.get(childId)
    if (live === undefined) return
    const activation = this.activations.get(childId)
    if (activation === undefined) {
      throw new SubagentError(
        `subagent "${childId}" has a live agent outside continuation ownership; the message was not delivered`,
        'OWNERSHIP_CONFLICT',
      )
    }
    if (activation.run !== undefined && activation.run.localAgent !== live) {
      throw new SubagentError(
        `subagent "${childId}" registry agent is not the associated activation's agent; the message was not delivered`,
        'OWNERSHIP_CONFLICT',
      )
    }
  }

  /** Deliver to the running activation's Task through confirmed live steering. */
  private async steerActivation(
    activation: ActiveActivation,
    parent: Agent,
    childId: SessionId,
    message: ContentBlock[],
    source: MessageSource,
    signal: AbortSignal,
  ): Promise<TaskId> {
    const taskId = activation.taskId
    /* v8 ignore next 3 -- the install and Task registration share one synchronous frame, so an observed activation carries its Task id. */
    if (taskId === undefined) {
      throw new SubagentError(`subagent "${childId}" activation is starting; the message was not delivered`, 'NOT_DELIVERED')
    }
    // Owner-session authorization plus the live status for admission.
    const snapshot = this.ctx.tasks.get(taskId, parent)
    if (snapshot.status !== 'running') {
      throw new SubagentError(
        `subagent "${childId}" task ${taskId} is ${snapshot.status}; the message was not delivered `
        + '— retry after it settles to start the next activation',
        'NOT_DELIVERED',
      )
    }
    const run = activation.run
    if (run === undefined) {
      throw new SubagentError(`subagent "${childId}" activation is starting; the message was not delivered`, 'NOT_DELIVERED')
    }
    if (run.steer === undefined) {
      throw new SubagentError(
        `subagent "${childId}" provider does not accept live delivery; the message was not delivered`,
        'NOT_DELIVERED',
      )
    }
    const cancelActivation = (): void => {
      activation.controller.abort(signal.reason)
    }
    signal.addEventListener('abort', cancelActivation, { once: true })
    if (signal.aborted) {
      cancelActivation()
      signal.removeEventListener('abort', cancelActivation)
      return await this.cancelledLiveDelivery(activation, childId)
    }
    try {
      await run.steer(message, source)
    } catch (error: unknown) {
      try {
        signal.throwIfAborted()
      } catch {
        return await this.cancelledLiveDelivery(activation, childId, error)
      }
      // Confirmed steering lost the race with request admission. Deliberately no
      // cold-resume fallback here: that would attach the message to a turn the
      // caller did not observe.
      throw new SubagentError(
        `subagent "${childId}" stopped before delivery; the message was not delivered`,
        'NOT_DELIVERED',
        { cause: error },
      )
    } finally {
      signal.removeEventListener('abort', cancelActivation)
    }
    return taskId
  }

  /** Reject a cancelled live delivery only after its shared activation is quiescent. */
  private async cancelledLiveDelivery(
    activation: ActiveActivation,
    childId: SessionId,
    cause?: unknown,
  ): Promise<never> {
    /* v8 ignore if -- a published run implies the producer assigned `done` before its provider await resolved. */
    if (activation.done === undefined) {
      throw new Error('published subagent activation has no settlement promise')
    }
    await activation.done
    throw new SubagentError(
      `subagent "${childId}" live delivery was cancelled; the message was not delivered`,
      'CANCELLED',
      cause === undefined ? undefined : { cause },
    )
  }

  /**
   * Cold-resume a persisted child into a fresh Task-backed activation. The
   * Task owns its `AbortController` before descriptor lookup: the load,
   * direct-parent authorization, and descriptor fold run inside the
   * activation, with cancellation rechecked after the un-signalled
   * persistence await so an early `task_kill` prevents any later child work.
   */
  private resumeActivation(
    parent: Agent,
    childId: SessionId,
    message: ContentBlock[],
    source: MessageSource,
  ): TaskId {
    const persistence = this.requirePersistence()
    return this.startActivation(childId, resumeLabel(message), parent, async (signal) => {
      let loaded: Awaited<ReturnType<typeof persistence.load>>
      try {
        loaded = await persistence.load(childId)
      } catch (error: unknown) {
        throw new SubagentError(
          `subagent "${childId}" is unavailable`,
          'NOT_RESUMABLE',
          { cause: error },
        )
      }
      // The persistence seam takes no signal; recheck before any child work.
      if (signal.aborted) throw new SubagentError('subagent resume was cancelled during lookup', 'CANCELLED')
      // Authorize the persisted header before folding: only the direct parent
      // recorded at creation may continue this child.
      if (loaded.meta.parentSession !== parent.id) {
        throw new SubagentError(
          `subagent "${childId}" belongs to another parent session`,
          'UNAUTHORIZED',
        )
      }
      // Fold only the child's own suffix: a fork seed replays the parent's
      // log, which may carry an ANCESTOR's descriptor when the parent is
      // itself a continuable child.
      const descriptor = foldSubagentDescriptor(loaded.events.slice(loaded.meta.seedLength ?? 0))
      if (descriptor === undefined) {
        throw new SubagentError(
          `subagent "${childId}" has no supported continuation state and cannot be resumed; `
            + 'do not retry send_message with this id',
          'NOT_RESUMABLE',
        )
      }
      return this.resumeProvider({
        sessionId: childId,
        prompt: message,
        source,
        parent,
        signal,
        descriptor,
      })
    })
  }

  /**
   * Install the activation association, register its Task, and bind the two
   * removal conditions. The association is installed before any persistence
   * or provider await — the producer body runs synchronously up to its first
   * await — and removed only after run disposal (the producer settled) and
   * Task terminal publication. This synchronous install admits one activation
   * per child in this process; a competing untracked publication still loses
   * at the Agent registry collision boundary inside the provider.
   */
  private startActivation(
    childId: SessionId,
    label: string,
    owner: Agent,
    begin: (signal: AbortSignal) => Promise<SubagentRun>,
  ): TaskId {
    const activation: ActiveActivation = {
      taskId: undefined,
      run: undefined,
      controller: new AbortController(),
      done: undefined,
      terminal: Promise.withResolvers<void>(),
    }
    this.activations.set(childId, activation)
    let taskId: TaskId
    try {
      taskId = this.ctx.tasks.start({
        kind: 'subagent',
        label,
        owner,
        run: (): TaskHooks => {
          const done = (async (): Promise<TaskOutcome> => {
            try {
              const run = await begin(activation.controller.signal)
              activation.run = run
              return await settleRun(run)
            } catch (error: unknown) {
              // A pre-publication abort rejects only after the provider's
              // creation transaction rolled back to quiescence, so recording
              // `killed` here honors the settlement-after-rollback contract.
              return activation.controller.signal.aborted
                ? { status: 'killed' }
                : { status: 'failed', detail: String(error) }
            }
          })()
          activation.done = done
          void Promise.allSettled([done, activation.terminal.promise]).then(() => {
            /* v8 ignore else -- service teardown clears the map while a producer is still settling. */
            if (this.activations.get(childId) === activation) this.activations.delete(childId)
          })
          return {
            cancel: (reason?: string) => {
              // Cancellation targets the whole activation: every message that
              // joined this turn shares the `killed` outcome.
              activation.controller.abort(reason ?? 'subagent activation killed')
            },
            done,
            // No readOutput: the child session owns intermediate detail.
          }
        },
      })
    } catch (error: unknown) {
      // Task preflight failed; nothing started, so the install rolls back.
      this.activations.delete(childId)
      throw error
    }
    // Same synchronous frame as the install: an observer that can run at all
    // runs after this assignment.
    activation.taskId = taskId
    return taskId
  }

  /** Resolve the persistence service continuable children require, or fail loud. */
  private requirePersistence(): SessionPersistence {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new SubagentError(
        'continuable subagents require session persistence (load a dsh-session-persistence backend)',
        'PERSISTENCE_UNAVAILABLE',
      )
    }
    return persistence
  }
}

/** Derive a resumed activation's Task label from its message. */
function resumeLabel(message: ContentBlock[]): string {
  const text = finalText(message).trim().replace(/\s+/g, ' ')
  if (text.length === 0) return 'subagent follow-up'
  return text.length > 80 ? `${text.slice(0, 79)}…` : text
}

export default SubagentContinuationManager
