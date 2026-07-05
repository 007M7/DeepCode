/**
 * The model-facing `subagent` tool: delegate a task to a child agent and return
 * its final output. Pure schema + lifecycle shaping — every transport concern
 * lives behind the `ctx.subagents` provider registry
 * (`@deepseek-ai/dsh-subagent`), so an in-process, ACP, or future A2A backend
 * swaps in without touching what the model sees.
 *
 * Provider selection is config, not model-facing: this plugin is bound to
 * EXACTLY ONE provider name (`Config.provider`). To expose more than one
 * transport, load the plugin more than once, each bound to a different provider
 * — there is no provider/type parameter in the model-facing schema. The model
 * sees only `{ description, prompt }`.
 *
 * The tool DESCRIPTION is derived from the bound provider's context contract
 * ({@link providerWording}): a fresh-context provider (spawn, ACP) gets the
 * standalone-prompt wording, an inheriting provider (fork) tells the model the
 * child already sees the conversation's completed turns. The tool MIRRORS the
 * provider's lifecycle via `subagent/provider-added`/`-removed` — it registers
 * when the provider is (or becomes) available and unregisters when the
 * provider goes away — so no load-order requirement exists and an HMR reload
 * of the backend re-derives the wording from the fresh provider.
 *
 * Collection is SYNCHRONOUS this cut: `execute` starts a run and awaits
 * `run.result` inside a `try/finally` that always disposes the run, so the
 * owned child agent/session is torn down on every path (success, error, abort)
 * and never leaks as a live idle child. A non-`completed` stop reason maps to an
 * `isError` tool result (by throwing) rather than returning partial output as
 * success.
 *
 * @module @deepseek-ai/dsh-tool-subagent
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentProvider, SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'

export const name = 'tool-subagent'
export const inject = ['tools', 'subagents']

/** Config: which registered provider this tool delegates to, plus child defaults. */
export interface Config {
  /** The `ctx.subagents` provider name to start runs on (e.g. `spawn`, `acp`). */
  provider: string
  /**
   * The model-facing tool name to register (default `subagent`). To expose more
   * than one transport, load this plugin once per provider — each load MUST set
   * a distinct `toolName` (the tool registry rejects a duplicate name), e.g.
   * `{ provider: 'spawn', toolName: 'subagent' }` and
   * `{ provider: 'acp', toolName: 'subagent_acp' }`.
   */
  toolName?: string
  /**
   * Default per-child agent options (model) applied to every spawned child.
   * Omitted fields fall back to the child loop's own defaults. There is no
   * per-child persona: the deployment persona (the system-prompt plugin's
   * `persona` config) is a context-wide section every agent shares.
   */
  agentOptions?: AgentOptions
}

export const Config: z<Config> = z.object({
  provider: z.string().required(),
  toolName: z.string().default('subagent'),
  agentOptions: z.object({
    model: z.string(),
  }),
})

/**
 * Flatten a child's final output blocks to text for the tool result. The child
 * may return non-text blocks; this cut surfaces the text content (the common
 * case) and drops the rest, which is acceptable for a synchronous summary —
 * the structured path (`outputSchema`) is the channel for non-text results.
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
 * Model-facing wording per context contract ({@link SubagentProvider.inheritsParentContext}).
 * A fresh child needs a standalone prompt; a forked child already sees the
 * conversation's completed turns — telling the model to restate everything
 * (or, worse, that the child "does not see this conversation") would be false
 * for a fork. Exported for tests.
 * @param inherits - the bound provider's context contract.
 * @returns the tool `description` and the `prompt` parameter description.
 */
export function providerWording(inherits: boolean): { description: string; promptDescription: string } {
  if (inherits) {
    return {
      description:
        'Delegate a task to a subagent that INHERITS this conversation: a child agent seeded with all '
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

export function apply(ctx: Context, config: Config): void {
  // The tool MIRRORS its provider's lifecycle instead of assuming load order:
  // the cordis Loader starts sibling entries concurrently, so "backend listed
  // first in cordis.yml" does not guarantee "provider registered first", and
  // an HMR reload of the backend replaces the provider while this fiber stays
  // loaded. Register the tool when the bound provider is (or becomes)
  // available — deriving the wording from THAT provider — and unregister it
  // when the provider goes away, so the description can never outlive or
  // predate the provider it describes.
  let disposeTool: (() => void) | undefined
  const mount = (provider: SubagentProvider): void => {
    const wording = providerWording(provider.inheritsParentContext)
    disposeTool = ctx.tools.register(defineTool({
      name: config.toolName ?? 'subagent',
      description: wording.description,
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
      },
      async execute(args, exec): Promise<ContentBlock[]> {
        const parent = exec.agent
        if (!parent) {
          // The loop sets `exec.agent` for every model-driven call; its absence
          // means a non-agent caller invoked the tool directly, which has no
          // parent to attribute the child to. Fail loud rather than guess.
          throw new Error('subagent tool requires a calling agent (exec.agent was undefined)')
        }

        const request: SubagentStartRequest = {
          prompt: [{ type: 'text', text: args.prompt }],
          parent,
          ...exec.signal ? { signal: exec.signal } : {},
          ...config.agentOptions ? { agentOptions: config.agentOptions } : {},
        }

        const run: SubagentRun = ctx.subagents.start(config.provider, request)

        // Bridge the tool's abort signal to the run: if the parent step is
        // aborted while the child is in flight, cancel the child too.
        const onAbort = (): void => { run.cancel('parent step aborted') }
        exec.signal?.addEventListener('abort', onAbort, { once: true })
        // `addEventListener` does NOT fire for a signal already aborted before this
        // line, so a step cancelled before the tool ran would never reach the
        // child. Cancel explicitly in that case — the bridge must honor an
        // already-aborted signal, not lean on each provider re-checking it.
        if (exec.signal?.aborted) run.cancel('parent step aborted')

        try {
          const result = await run.result
          const error = stopReasonError(result)
          if (error !== undefined) {
            // Map a non-clean finish to an isError result (the registry turns a
            // throw into an isError). Report the reason, not partial output.
            throw new Error(error)
          }
          return [{ type: 'text', text: outputText(result.output) }]
        } finally {
          exec.signal?.removeEventListener('abort', onAbort)
          // Always reach child quiescence — never leak a live idle child/session.
          await run.dispose()
        }
      },
    }))
  }

  // Listeners first, then the presence check: both run synchronously, so no
  // registration can slip between them; the `disposeTool === undefined` guard
  // makes a same-tick added-event after a successful mount a no-op.
  // TODO(subagent-dup-toolname): two WAITING fibers configured with the same
  // toolName collide only when their provider finally arrives — the duplicate
  // tool-name throw then propagates through `subagent/provider-added` and
  // rolls back the PROVIDER registration, so an invalid config blasts the
  // backend's fiber instead of the misconfigured tool's. Config-time detection
  // would need a cross-fiber registry of intended tool names; revisit if a
  // real deployment ever hits it.
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
    // Not an error: the backend's fiber may simply activate after this one.
    // The tool appears the moment the provider registers; a typo'd provider
    // name shows up as this note plus a tool that never materializes.
    ctx.logger.info(`subagent provider "${config.provider}" not registered yet; the "${config.toolName ?? 'subagent'}" tool will register when it appears`)
  }
}
