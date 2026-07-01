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
import type { SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'

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
   * Default per-child agent options (model, system prompt) applied to every
   * spawned child. Omitted fields fall back to the child loop's own defaults.
   */
  agentOptions?: AgentOptions
}

export const Config: z<Config> = z.object({
  provider: z.string().required(),
  toolName: z.string().default('subagent'),
  agentOptions: z.object({
    model: z.string(),
    systemPrompt: z.string(),
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

export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: config.toolName ?? 'subagent',
    description:
      'Delegate a self-contained task to a subagent (a separate agent that works in its own context) '
      + 'and return its final result. Use this to offload focused, independent work — research, a scoped '
      + 'implementation, an analysis — so it does not consume this conversation\'s context. The subagent '
      + 'runs to completion and you receive only its final answer, not its intermediate steps. Give it a '
      + 'complete, standalone prompt: it does not see this conversation.',
    parameters: {
      description: {
        type: 'string',
        required: true,
        description: 'A short (3-5 word) description of the delegated task, for display.',
      },
      prompt: {
        type: 'string',
        required: true,
        description: 'The complete, self-contained task for the subagent. It does not share this '
          + 'conversation\'s context, so include everything it needs.',
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
