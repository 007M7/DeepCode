/**
 * Model-facing delegation through one configured `ctx.subagents` provider.
 * Provider lifecycle controls tool registration and context-sensitive schema
 * wording. Foreground calls always dispose the run after collection; background
 * calls use an independent cancellation signal and settle a final-output task
 * only after child disposal.
 * @module @deepseek-ai/dsh-tool-subagent
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { assertSubagentMaxDepth } from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider, SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { TaskOutcome } from '@deepseek-ai/dsh-tasks'

export const name = 'tool-subagent'
export const inject = ['tools', 'subagents']

/** Config: which registered provider this tool delegates to, plus child defaults. */
export interface Config {
  /** The `ctx.subagents` provider name to start runs on (e.g. `spawn`, `acp`). */
  provider: string
  /**
   * Model-facing tool name (default `subagent`). Each loaded instance must use
   * a distinct name.
   */
  toolName?: string
  /**
   * Expose `run_in_background` (default true). Disabled instances omit the
   * parameter and reject forced background calls.
   */
  enableRunInBackground?: boolean
  /**
   * Agent options applied to every child; omitted fields use child-loop defaults.
   */
  agentOptions?: AgentOptions
  /**
   * Per-child persona that shadows `deployment:persona`. Requires the
   * provider's `persona` capability; omission preserves the deployment persona.
   */
  persona?: string
  /**
   * Tool filter applied to every child. Filtered tools disappear from its
   * prompt and reject execution. Requires the provider's `toolFilter`
   * capability; unknown names fail startup.
   */
  toolFilter?: {
    /** Global tool names the child keeps; everything else is removed. */
    allow?: string[]
    /** Global tool names removed from the child. */
    deny?: string[]
  }
  /**
   * Maximum child depth: a non-negative safe integer (default `3`; `0` forbids
   * delegation entirely), or `'provider-managed'` to send no cap. A numeric cap
   * requires the provider's `depthLimit` capability (mount fails loud
   * otherwise). The provider checks the calling agent's current depth at every
   * start; the tool remains model-visible so runtime policy owns rejection.
   * `'provider-managed'` is for an out-of-process provider (ACP) whose
   * recursion budget belongs to the child harness's own deployment.
   */
  maxDepth?: number | 'provider-managed'
}

export const Config: z<Config> = z.object({
  provider: z.string().required(),
  toolName: z.string().default('subagent'),
  enableRunInBackground: z.boolean().default(true),
  // Prevent Schemastery from materializing omitted agentOptions as `{}`.
  agentOptions: z.object({
    provider: z.string(),
    model: z.string(),
  }).default(undefined as unknown as { provider: string; model: string }),
  persona: z.string(),
  // Preserve omission; Schemastery's `{ allow: [] }` default would deny every tool.
  toolFilter: z.object({
    allow: z.array(z.string()).default(undefined as unknown as string[]),
    deny: z.array(z.string()).default(undefined as unknown as string[]),
  }).default(undefined as unknown as { allow: string[]; deny: string[] }),
  maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const('provider-managed' as const)]).default(3),
})

/**
 * Flatten a child's final output blocks to text for the tool result. The child
 * may return non-text blocks; this path returns only text. Structured results
 * use `outputSchema`.
 */
function outputText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map(b => b.text)
    .join('')
}

/** A non-`completed` stop reason means the child did not finish cleanly. */
function stopReasonError(result: SubagentResult): string | undefined {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'aborted':
      return 'subagent run was cancelled'
    case 'error':
      return 'subagent run failed'
    case 'max-tokens':
      return 'subagent run hit its token limit before finishing'
    case 'refusal':
      return 'subagent declined the task'
    // Merge-extensible union: a backend may add stop reasons. Treat an unknown
    // terminal reason as a failure rather than reporting partial output as success.
    default:
      return `subagent run ended abnormally (${String(result.stopReason)})`
  }
}

/**
 * Map a child result to the task outcome: completed carries final text,
 * aborted is killed, and every other reason is failed without partial output.
 * @param result - child terminal result.
 * @returns outcome for the `ctx.tasks` registration.
 */
export function runOutcome(result: SubagentResult): TaskOutcome {
  switch (result.stopReason) {
    case 'completed':
      return { status: 'completed', output: outputText(result.output) }
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
    outcome = { status: 'failed', detail: String(error) }
  }
  try {
    await run.dispose()
  } catch (error: unknown) {
    const prefix = outcome.detail === undefined ? '' : `${outcome.detail}; `
    return { status: 'failed', detail: `${prefix}dispose failed: ${String(error)}` }
  }
  return outcome
}

/**
 * Model-facing wording from the provider's conversation-history descriptor
 * ({@link SubagentProvider.inheritsParentContext}).
 * A fresh child needs a standalone prompt; a forked child already sees the
 * conversation's completed turns — telling the model to restate everything
 * (or, worse, that the child "does not see this conversation") would be false
 * for a fork.
 * @param inheritsConversation - whether the child's conversation is seeded
 *   with the parent's completed turns; this says nothing about tool, service,
 *   scope, or authority inheritance.
 * @returns the tool `description` and the `prompt` parameter description.
 */
function providerWording(inheritsConversation: boolean): { description: string; promptDescription: string } {
  if (inheritsConversation) {
    return {
      description:
        'Delegate a task to a subagent that inherits this conversation: a child agent seeded with all '
        + 'completed turns so far (it does not see the current in-flight turn), returning only its final '
        + 'result. Use this when the subtask builds on this conversation\'s context — a follow-up analysis, '
        + 'a review, a continuation — without consuming this conversation\'s context for the work itself. '
        + 'You receive only its final answer, not its intermediate steps.',
      promptDescription:
        'The task for the subagent. It already sees this conversation\'s completed turns, so build on them '
        + 'freely and state only what is new.',
    }
  }
  return {
    description:
      'Delegate a self-contained task to a subagent (a separate agent that works in its own context) '
      + 'and return its final result. Use this to offload focused, independent work — research, a scoped '
      + 'implementation, an analysis — so it does not consume this conversation\'s context. The subagent '
      + 'runs to completion and you receive only its final answer, not its intermediate steps. Give it a '
      + 'complete, standalone prompt: it does not see this conversation.',
    promptDescription:
      'The complete, self-contained task for the subagent. It does not share this '
      + 'conversation\'s context, so include everything it needs.',
  }
}

function startRequest(config: Config, prompt: string, parent: Agent, signal: AbortSignal): SubagentStartRequest {
  const maxDepth = typeof config.maxDepth === 'number' ? config.maxDepth : undefined
  return {
    prompt: [{ type: 'text', text: prompt }],
    parent,
    signal,
    ...config.agentOptions !== undefined ? { agentOptions: config.agentOptions } : {},
    ...config.persona !== undefined ? { persona: config.persona } : {},
    ...config.toolFilter !== undefined ? { toolFilter: config.toolFilter } : {},
    ...maxDepth !== undefined ? { maxDepth } : {},
  }
}

/** Settle pending startup without rejecting the task producer contract. */
async function settleStart(start: Promise<SubagentRun>, signal: AbortSignal): Promise<TaskOutcome> {
  try {
    return await settleRun(await start)
  } catch (error: unknown) {
    return signal.aborted
      ? { status: 'killed' }
      : { status: 'failed', detail: String(error) }
  }
}

export function apply(ctx: Context, config: Config): void {
  // Direct apply() bypasses Schemastery's numeric constraints. A direct-apply
  // omission stays capless (the schema default only runs through the loader).
  if (config.maxDepth !== 'provider-managed') assertSubagentMaxDepth(config.maxDepth)
  // Reject an empty explicit filter at load instead of failing every delegation.
  if (config.toolFilter !== undefined && config.toolFilter.allow === undefined && config.toolFilter.deny === undefined) {
    throw new Error('tool-subagent: `toolFilter` is configured but names neither `allow` nor `deny` — remove the key or fill the filter')
  }
  // Mirror provider lifecycle because sibling load order and HMR replacement
  // can change provider availability while this fiber remains active.
  let disposeTool: (() => void) | undefined
  const mount = (provider: SubagentProvider): void => {
    // A numeric cap the provider cannot enforce is a misconfiguration — fail at
    // mount (the earliest point the provider's capabilities are known), not on
    // the first delegation.
    if (typeof config.maxDepth === 'number' && !provider.capabilities.depthLimit) {
      throw new Error(
        `tool-subagent: provider "${provider.name}" cannot enforce maxDepth (no depthLimit capability) — `
        + 'set maxDepth: \'provider-managed\' to leave the recursion budget to the provider',
      )
    }
    const wording = providerWording(provider.inheritsParentContext)
    const backgroundEnabled = config.enableRunInBackground !== false
    disposeTool = ctx.tools.register(defineTool({
      name: config.toolName ?? 'subagent',
      description: wording.description + (backgroundEnabled
        ? ' Set `run_in_background: true` to return a task id; collect with `task_output` and stop with `task_kill`.'
        : ''),
      parameters: {
        description: {
          type: 'string',
          required: true,
          description: 'A short (3-5 word) description of the delegated task, for display.',
        },
        prompt: {
          type: 'string',
          required: true,
          description: wording.promptDescription,
        },
        ...backgroundEnabled ? {
          run_in_background: {
            type: 'boolean' as const,
            description: 'Run as a background task and return its id; collect with task_output or stop with task_kill.',
          },
        } : {},
      },
      async execute(args, exec): Promise<ContentBlock[]> {
        const parent = exec.agent
        if (!parent) {
          // Non-agent callers provide no parent for delegation ownership.
          throw new Error('subagent tool requires a calling agent (exec.agent was undefined)')
        }

        if (args.run_in_background === true) {
          // The validator permits undeclared keys, so schema omission also needs
          // execution-time enforcement.
          if (!backgroundEnabled) {
            throw new Error('run_in_background is disabled for this tool instance (enableRunInBackground: false)')
          }
          const tasks = ctx.get('tasks')
          if (tasks === undefined) {
            throw new Error('background tasks unavailable: load @deepseek-ai/dsh-tasks and @deepseek-ai/dsh-tool-tasks')
          }
          // Reject cancellation before spawning; after return, the task-owned
          // signal covers both pending startup and the ready child.
          if (exec.signal?.aborted) throw new Error('subagent delegation aborted')
          // Task preflight finishes before the starter can spawn a child.
          const id = tasks.start({
            kind: 'subagent',
            label: args.description,
            owner: parent,
            run: () => {
              const controller = new AbortController()
              const start = ctx.subagents.start(
                config.provider,
                startRequest(config, args.prompt, parent, controller.signal),
              )
              return {
                cancel: (reason?: string) => {
                  controller.abort(reason ?? 'background subagent task killed')
                },
                done: settleStart(start, controller.signal),
                // No readOutput: the child session owns intermediate detail.
              }
            },
          })
          return [{ type: 'text', text: `started background subagent task ${id}` }]
        }

        const request = startRequest(
          config,
          args.prompt,
          parent,
          exec.signal ?? new AbortController().signal,
        )

        const run: SubagentRun = await ctx.subagents.start(config.provider, request)

        try {
          const result = await run.result
          const error = stopReasonError(result)
          if (error !== undefined) {
            // The registry converts this throw to isError; partial output is not success.
            throw new Error(error)
          }
          return [{ type: 'text', text: outputText(result.output) }]
        } finally {
          // Dispose before returning so no child session outlives the call.
          await run.dispose()
        }
      },
    }))
  }

  // Register listeners before checking presence so no synchronous change is missed.
  // TODO(subagent-dup-toolname): two WAITING fibers configured with the same
  // toolName collide when their provider appears, and the duplicate-name throw
  // rolls back the provider registration. Add an intent registry if this occurs.
  ctx.on('subagent/provider-added', (provider) => {
    if (provider.name === config.provider && disposeTool === undefined) mount(provider)
  })
  ctx.on('subagent/provider-removed', (name) => {
    if (name !== config.provider || disposeTool === undefined) return
    disposeTool()
    disposeTool = undefined
  })
  const present = ctx.subagents.getProvider(config.provider)
  if (present !== undefined) {
    mount(present)
  } else {
    // A backend fiber may activate later; a misspelled provider remains visible in this log.
    ctx.logger.info(`subagent provider "${config.provider}" not registered yet; the "${config.toolName ?? 'subagent'}" tool will register when it appears`)
  }
}
